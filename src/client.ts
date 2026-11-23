/**
 * The transaction path.
 *
 * A Soroban call is not "send a request": the node has to be asked what the call
 * will touch before it can be submitted, and the answer — footprint, resource
 * cost, required authorisations — has to be part of the transaction that finally
 * goes out. So:
 *
 * ```text
 * getAccount   the source's sequence number
 * simulate     run the call for free; learn what it touches and who must sign
 * authorize    sign each authorisation the contract asked for
 * rebuild      same sequence number, plus footprint, resource fee and signatures
 * submit       hand it to the network
 * commit       poll until a ledger says success or failed
 * ```
 *
 * Reads stop after `simulate`, which is why they need no signer and cost
 * nothing: simulation runs the host function locally and returns its value.
 */
import {
  Account,
  Address as StellarAddress,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash as digest,
  type xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

import {
  asBool,
  asI128,
  asOption,
  asU32,
  decodeAddresses,
  decodeBreakerConfig,
  decodeBreakerState,
  decodeGrant,
  decodeProposal,
  decodeRule,
  decodeStringVec,
  decodeU64Vec,
  encodeArgs,
  type BreakerConfigInfo,
  type BreakerStateInfo,
  type GrantInfo,
  type ProposalInfo,
  type RuleInfo,
} from './abi.js';
import { breakerCalls, multisigCalls } from './calls.js';
import {
  addressArg,
  effectFromDiscriminant,
  stringArg,
  type AbiArg,
  type Address,
  type Call,
  type ContractRole,
  type Effect,
  type Timestamp,
  type Triple,
} from './types.js';
import {
  CommitTimeoutError,
  ConfigurationError,
  KeygateError,
  SimulationRejectedError,
  SubmitFailedError,
  TransactionFailedError,
  codeFromHostError,
} from './errors.js';
import type { CommitOutcome, LedgerHost, SimulationOutcome } from './host.js';
import { authorizationSigner, decoratedSignature, requireSigner, type Signer } from './signer.js';

/** Where the keygate contracts live. `core` is required; the rest are optional. */
export interface ContractAddresses {
  readonly core: Address;
  /**
   * Only the contracts a caller actually uses need an address: `addressFor`
   * throws a clear `ConfigurationError` for a missing one, so a core-only
   * caller is not forced to invent addresses for the rest.
   */
  readonly policy?: Address;
  readonly breaker?: Address;
  readonly multisig?: Address;
}

export interface KeygateOptions {
  readonly host: LedgerHost;
  readonly contracts: ContractAddresses;
  readonly networkPassphrase: string;
  /** Only needed to submit; reads work without one. */
  readonly signer?: Signer;
  /**
   * Ledgers an authorisation signature stays valid for.
   *
   * Short enough that an authorisation cannot sit around and be replayed, long
   * enough that a slow submission is not instantly invalid.
   */
  readonly authLedgerWindow?: number;
  /** Classic (non-resource) fee in stroops. The resource fee is added on top. */
  readonly baseFee?: string;
  readonly pollIntervalMs?: number;
  readonly commitTimeoutMs?: number;
}

export interface SendResult {
  readonly hash: string;
  readonly ledger: number;
  readonly appliedAt: Timestamp;
  /**
   * What the call returned.
   *
   * The node only gives this back when it is configured to keep return values;
   * otherwise the value from the pre-submission simulation is used, which ran the
   * same code against the same prior state.
   */
  readonly returnValue: xdr.ScVal | undefined;
}

/** The account a free simulation is charged to — which is to say, nobody. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const DEFAULTS = {
  authLedgerWindow: 10,
  baseFee: '100',
  pollIntervalMs: 1_000,
  commitTimeoutMs: 30_000,
} as const;

type Decoder<T> = (value: xdr.ScVal, context: string) => T;

export class KeygateClient {
  private readonly host: LedgerHost;
  private readonly contracts: ContractAddresses;
  private readonly passphrase: string;
  private readonly signer: Signer | undefined;
  private readonly authWindow: number;
  private readonly baseFee: string;
  private readonly pollIntervalMs: number;
  private readonly commitTimeoutMs: number;

  constructor(options: KeygateOptions) {
    if (options.networkPassphrase.trim() === '') {
      throw new ConfigurationError('networkPassphrase is required');
    }
    this.host = options.host;
    this.contracts = options.contracts;
    this.passphrase = options.networkPassphrase;
    this.signer = options.signer;
    this.authWindow = options.authLedgerWindow ?? DEFAULTS.authLedgerWindow;
    this.baseFee = options.baseFee ?? DEFAULTS.baseFee;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.commitTimeoutMs = options.commitTimeoutMs ?? DEFAULTS.commitTimeoutMs;
  }

  addressFor(role: ContractRole): Address {
    const address = this.contracts[role];
    if (address === undefined) {
      throw new ConfigurationError(
        `no ${role} contract configured; pass its address when constructing the client`,
      );
    }
    return address;
  }

  /**
   * Runs a call without submitting anything.
   *
   * Simulation executes the contract, so this is also the cheapest way to check
   * whether a write *would* be accepted: a refusal surfaces as
   * `SimulationRejectedError` and never reaches the ledger.
   */
  async read<T>(call: Call, decode: Decoder<T>): Promise<T> {
    const value = await this.evaluate(call);
    return decode(value, `${call.role}.${call.func}`);
  }

  async hasAccess(triple: Triple, holder: Address): Promise<boolean> {
    return await this.read(
      { role: 'core', func: 'check', args: tripleArgs(triple, holder) },
      asBool,
    );
  }

  async grant(triple: Triple, holder: Address): Promise<GrantInfo | null> {
    const value = await this.evaluate({
      role: 'core',
      func: 'grant',
      args: tripleArgs(triple, holder),
    });
    return asOption(value, 'core.grant', decodeGrant);
  }

  async paused(): Promise<boolean> {
    return await this.read({ role: 'core', func: 'paused', args: [] }, asBool);
  }

  async rule(triple: Triple): Promise<RuleInfo | null> {
    const value = await this.evaluate({ role: 'policy', func: 'rule', args: pairArgs(triple) });
    return asOption(value, 'policy.rule', decodeRule);
  }

  async defaultEffect(): Promise<Effect> {
    const value = await this.evaluate({ role: 'policy', func: 'default_effect', args: [] });
    return effectFromDiscriminant(asU32(value, 'policy.default_effect'));
  }

  async breakerState(resource: string): Promise<BreakerStateInfo | null> {
    const value = await this.evaluate({
      role: 'breaker',
      func: 'state',
      args: [stringArg(resource)],
    });
    return asOption(value, 'breaker.state', decodeBreakerState);
  }

  /**
   * The configuration for one resource, or `null` when it was never
   * configured. A missing configuration is an ordinary answer, not an error —
   * compare `breakerRemaining`, which refuses an unconfigured resource.
   */
  async breakerConfig(resource: string): Promise<BreakerConfigInfo | null> {
    const value = await this.evaluate(breakerCalls.config(resource));
    return asOption(value, 'breaker.config', decodeBreakerConfig);
  }

  /**
   * How much of the window is still available.
   *
   * This is the effective headroom, not the persisted state: the contract
   * rolls the window forward the way `enforce` does without persisting it, so
   * a window that has already expired reads as the full limit again, and a
   * tripped resource reads as `0`. `breakerState` is the persisted state
   * instead — the window start and the amount used as last recorded.
   *
   * An unconfigured resource is refused on-chain (`NotConfigured`), which
   * surfaces as `SimulationRejectedError` rather than `null` or `0`.
   */
  async breakerRemaining(resource: string): Promise<bigint> {
    return await this.read(breakerCalls.remaining(resource), asI128);
  }

  /** Whether the latch for one resource is currently tripped. */
  async breakerIsTripped(resource: string): Promise<boolean> {
    return await this.read(breakerCalls.isTripped(resource), asBool);
  }

  /** Every resource that has a configuration, in the order the contract lists them. */
  async breakerResources(): Promise<string[]> {
    return await this.read(breakerCalls.resources(), decodeStringVec);
  }

  /**
   * One proposal, or `null` when the id is unknown. The contract returns an
   * `Option<Proposal>`, so an absent proposal is an ordinary answer.
   */
  async proposal(id: number): Promise<ProposalInfo | null> {
    const value = await this.evaluate(multisigCalls.proposal(id));
    return asOption(value, 'multisig.proposal', decodeProposal);
  }

  /** The ids of proposals that are still live (neither executed nor cancelled). */
  async pendingProposals(): Promise<number[]> {
    return await this.read(multisigCalls.liveIds(), decodeU64Vec);
  }

  /** Who has approved one proposal so far, in the order they approved. */
  async approvals(id: number): Promise<Address[]> {
    return await this.read(multisigCalls.approvals(id), decodeAddresses);
  }

  /** The current owner set of the multisig. */
  async owners(): Promise<Address[]> {
    return await this.read(multisigCalls.owners(), decodeAddresses);
  }

  /** How many approvals a proposal needs before it can execute. */
  async threshold(): Promise<number> {
    return await this.read(multisigCalls.threshold(), asU32);
  }

  /** Whether an address is one of the multisig's current owners. */
  async isOwner(address: Address): Promise<boolean> {
    return await this.read(multisigCalls.isOwner(address), asBool);
  }

  /** Builds, signs, submits and waits for one call. */
  async send(call: Call): Promise<SendResult> {
    const signer = requireSigner(this.signer);
    const account = await this.host.getAccount(signer.publicKey);
    // Snapshot the sequence once: the probe and the real transaction must carry
    // the same one, and `TransactionBuilder` increments whatever it is handed.
    const sequence = account.sequence;

    const simulation = await this.simulate(
      call,
      this.transaction(call, signer.publicKey, sequence),
    );
    const signed = await this.signAuthorizations(
      call,
      signer,
      simulation.auth,
      simulation.latestLedger,
    );
    const ready = this.transaction(call, signer.publicKey, sequence, signed, simulation);

    // The envelope signature is a separate thing from the authorisations above:
    // it is what makes this account pay for the transaction.
    ready.addDecoratedSignature(
      decoratedSignature(signer.publicKey, await signer.sign(digest(ready.signatureBase()))),
    );

    const submitted = await this.host.submit(ready);
    if (submitted.status !== 'pending' && submitted.status !== 'duplicate') {
      throw new SubmitFailedError(submitted.status, submitted.hash, submitted.detail);
    }

    const outcome = await this.commit(submitted.hash);
    return {
      hash: submitted.hash,
      ledger: outcome.ledger,
      appliedAt: outcome.createdAt,
      returnValue: outcome.returnValue ?? simulation.retval,
    };
  }

  /** Waits for a submitted transaction to be reported one way or the other. */
  private async commit(transactionHash: string): Promise<CommitOutcome> {
    const deadline = Date.now() + this.commitTimeoutMs;
    for (;;) {
      const outcome = await this.host.commit(transactionHash);
      if (outcome.status === 'success') {
        return outcome;
      }
      if (outcome.status === 'failed') {
        throw new TransactionFailedError(transactionHash);
      }
      if (Date.now() >= deadline) {
        // Genuinely unknown: the node may still apply it. The hash is in the
        // error, so the caller can look again later instead of blindly re-sending.
        throw new CommitTimeoutError(transactionHash);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async evaluate(call: Call): Promise<xdr.ScVal> {
    const simulation = await this.simulate(call, this.transaction(call, NULL_ACCOUNT, '0'));
    const value = simulation.retval;
    if (value === undefined) {
      throw new KeygateError(
        `${call.role}.${call.func} returned no value; is the contract deployed at ${this.addressFor(call.role)}?`,
      );
    }
    return value;
  }

  private async simulate(call: Call, transaction: Transaction): Promise<SimulationOutcome> {
    const simulation = await this.host.simulate(transaction);
    if (simulation.needsRestore) {
      throw new KeygateError(
        `${call.role}.${call.func} needs archived ledger entries restored before it can run`,
      );
    }
    if (simulation.error !== undefined) {
      throw new SimulationRejectedError(
        call.role,
        call.func,
        simulation.error,
        codeFromHostError(simulation.error),
      );
    }
    return simulation;
  }

  private async signAuthorizations(
    call: Call,
    signer: Signer,
    entries: readonly xdr.SorobanAuthorizationEntry[],
    latestLedger: number,
  ): Promise<xdr.SorobanAuthorizationEntry[]> {
    const expiration = latestLedger + this.authWindow;
    const signed: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of entries) {
      const credentials = entry.credentials;
      if (credentials.type === 'sorobanCredentialsSourceAccount') {
        // Source-account credentials are covered by the transaction signature.
        signed.push(entry);
        continue;
      }
      if (credentials.type !== 'sorobanCredentialsAddress') {
        // V2 and delegated credentials are a newer authorisation shape this
        // client does not sign; say so rather than misreading the entry.
        throw new ConfigurationError(
          `${call.role}.${call.func} returned an authorisation this client cannot sign (${credentials.type})`,
        );
      }
      const holder = StellarAddress.fromScAddress(credentials.address.address).toString();
      if (holder !== signer.publicKey) {
        throw new ConfigurationError(
          `${call.role}.${call.func} asks ${holder} to authorise, but this client signs for ${signer.publicKey}`,
        );
      }
      signed.push(
        await authorizeEntry(entry, authorizationSigner(signer), expiration, this.passphrase),
      );
    }
    return signed;
  }

  private transaction(
    call: Call,
    source: Address,
    sequence: string,
    auth: readonly xdr.SorobanAuthorizationEntry[] = [],
    simulation?: SimulationOutcome,
  ): Transaction {
    const sorobanData = simulation?.sorobanData;
    const builder = new TransactionBuilder(new Account(source, sequence), {
      fee: (BigInt(this.baseFee) + BigInt(simulation?.minResourceFee ?? '0')).toString(),
      networkPassphrase: this.passphrase,
      ...(sorobanData === undefined ? {} : { sorobanData }),
    });
    // `setTimeout(0)` means "no time bounds", which is what Soroban transactions
    // use: the authorisation expiry above is the deadline that actually applies.
    return builder
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.addressFor(call.role),
          function: call.func,
          args: encodeArgs(call.args),
          auth: [...auth],
        }),
      )
      .setTimeout(0)
      .build();
  }
}

function pairArgs(triple: Triple): readonly AbiArg[] {
  return [stringArg(triple.resource), stringArg(triple.action)];
}

function tripleArgs(triple: Triple, holder: Address): readonly AbiArg[] {
  return [...pairArgs(triple), addressArg(holder)];
}
