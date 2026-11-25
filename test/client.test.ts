import {
  Address,
  Keypair,
  SorobanDataBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asBool, asU32, asVec, toScVal } from '../src/abi.js';
import { KeygateClient, type ContractAddresses } from '../src/client.js';
import {
  ConfigurationError,
  SubmitFailedError,
  TransactionFailedError,
  CommitTimeoutError,
  SimulationRejectedError,
} from '../src/errors.js';
import type { CommitOutcome, LedgerHost, SimulationOutcome, SubmitOutcome } from '../src/host.js';
import { keypairSigner } from '../src/signer.js';
import {
  addressArg,
  boolArg,
  bytesArg,
  i128Arg,
  stringArg,
  symbolArg,
  u64Arg,
} from '../src/types.js';
import {
  BREAKER,
  CORE,
  MULTISIG,
  PASSPHRASE,
  PAYMENTS,
  POLICY,
  addressAuth,
  sourceAccountAuth,
} from './fixtures.js';

const HOLDER = Keypair.random();
const OTHER = Keypair.random();
const CONTRACT_ADDRESSES: ContractAddresses = {
  core: CORE,
  policy: POLICY,
  breaker: BREAKER,
  multisig: MULTISIG,
  payments: PAYMENTS,
};
const FOOTPRINT = new SorobanDataBuilder().setResources(1000, 2000, 3000).build();
const TX_HASH = 'a'.repeat(64);

const SUCCESS_COMMIT: CommitOutcome = {
  status: 'success',
  ledger: 4_999,
  createdAt: 1_800_000_600,
  returnValue: xdr.ScVal.scvBool(true),
  latestLedger: 5_000,
};

/**
 * A node that answers whatever the test asked it to and records what it was
 * asked to do.
 *
 * Only the four `LedgerHost` methods exist, so a test cannot accidentally
 * depend on RPC behaviour this client does not use.
 */
class FakeHost implements LedgerHost {
  readonly accountCalls: string[] = [];
  readonly simulated: Transaction[] = [];
  readonly submitted: Transaction[] = [];
  readonly commitCalls: string[] = [];

  sequence = '5';
  simulation: Partial<SimulationOutcome> = {};
  submitOutcome: SubmitOutcome = { status: 'pending', hash: TX_HASH, detail: undefined };
  commitQueue: CommitOutcome[] = [];
  commitDefault: CommitOutcome = SUCCESS_COMMIT;

  // Nothing is awaited: every answer comes from state the test already set, so
  // these resolve synchronously rather than pretending to make a round trip.
  getAccount(address: string) {
    this.accountCalls.push(address);
    return Promise.resolve({ accountId: address, sequence: this.sequence });
  }

  simulate(transaction: Transaction) {
    this.simulated.push(transaction);
    return Promise.resolve({ ...DEFAULT_SIMULATION, ...this.simulation });
  }

  submit(transaction: Transaction) {
    this.submitted.push(transaction);
    return Promise.resolve(this.submitOutcome);
  }

  commit(hash: string) {
    this.commitCalls.push(hash);
    return Promise.resolve(this.commitQueue.shift() ?? this.commitDefault);
  }
}

const DEFAULT_SIMULATION: SimulationOutcome = {
  error: undefined,
  needsRestore: false,
  latestLedger: 1_000,
  auth: [],
  retval: xdr.ScVal.scvBool(true),
  sorobanData: FOOTPRINT,
  minResourceFee: '1200',
};

function clientFor(host: FakeHost): KeygateClient {
  return new KeygateClient({
    host,
    contracts: CONTRACT_ADDRESSES,
    networkPassphrase: PASSPHRASE,
    signer: keypairSigner(HOLDER),
    pollIntervalMs: 0,
  });
}

/** The host function the transaction actually carries, decoded from its envelope. */
function invoked(tx: Transaction) {
  const envelope = tx.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    throw new Error(`unexpected envelope type ${envelope.type}`);
  }
  const body = envelope.v1.tx.operations[0]?.body;
  if (body?.type !== 'invokeHostFunction') {
    throw new Error('no invokeHostFunction operation');
  }
  const operation = body.invokeHostFunctionOp;
  if (operation.hostFunction.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error('no invokeContract host function');
  }
  const contract = operation.hostFunction.invokeContract;
  const ext = envelope.v1.tx.ext;
  return {
    contract: contract.contractAddress.toXDR('hex'),
    functionName: String(contract.functionName),
    args: contract.args,
    auth: operation.auth ?? [],
    footprint: ext.type === 'sorobanData' ? ext.sorobanData : undefined,
  };
}

describe('read', () => {
  it('simulates against an account that pays nothing and submits nothing', async () => {
    const host = new FakeHost();

    await expect(
      clientFor(host).hasAccess({ resource: 'vault', action: 'withdraw' }, HOLDER.publicKey()),
    ).resolves.toBe(true);

    const probe = host.simulated[0];
    expect(probe).toBeDefined();
    expect(probe?.source).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(host.submitted).toEqual([]);
    expect(host.accountCalls).toEqual([]);
  });

  it('builds the call the contract expects', async () => {
    const host = new FakeHost();
    await clientFor(host).hasAccess(
      { resource: 'vault:main', action: 'withdraw' },
      HOLDER.publicKey(),
    );

    const call = invoked(host.simulated[0] as Transaction);
    expect(call.functionName).toBe('check');
    expect(scValToNative(call.args[0] as xdr.ScVal)).toBe('vault:main');
    expect(scValToNative(call.args[1] as xdr.ScVal)).toBe('withdraw');
    expect(call.args[2]?.type).toBe('scvAddress');
  });

  it('turns a node refusal into the contract error it names', async () => {
    const host = new FakeHost();
    host.simulation = {
      error: 'Error(Host, Error(Contract, #4))',
      retval: undefined,
      sorobanData: undefined,
    };

    const error = await clientFor(host)
      .grant({ resource: 'vault', action: 'withdraw' }, HOLDER.publicKey())
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SimulationRejectedError);
    expect((error as SimulationRejectedError).code).toBe(4);
    expect((error as SimulationRejectedError).role).toBe('core');
    expect((error as SimulationRejectedError).func).toBe('grant');
    expect((error as Error).message).toContain('GrantNotFound');
  });

  it('refuses to read through expired ledger entries', async () => {
    const host = new FakeHost();
    host.simulation = {
      needsRestore: true,
      error: 'ledger entries expired; restore them before submitting',
    };

    await expect(clientFor(host).paused()).rejects.toThrow(/restore/i);
  });

  it('says so when the contract returns no value', async () => {
    const host = new FakeHost();
    host.simulation = { retval: undefined };

    await expect(clientFor(host).paused()).rejects.toThrow(
      new RegExp(`core\\.paused returned no value; is the contract deployed at ${CORE}`),
    );
  });

  it('maps the policy default effect to the word the contract means', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvU32(1) };

    await expect(clientFor(host).defaultEffect()).resolves.toBe('deny');
    expect(invoked(host.simulated[0] as Transaction).contract).toBe(
      new Address(POLICY).toScAddress().toXDR('hex'),
    );
  });

  it('reads the breaker state for one resource', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvLedgerKeyContractInstance() };

    await expect(clientFor(host).breakerState('vault:main')).resolves.toBeNull();
    const call = invoked(host.simulated[0] as Transaction);
    expect(call.functionName).toBe('state');
    expect(call.args).toHaveLength(1);
  });
});

describe('multisig reads', () => {
  /** A proposal the way the multisig contract returns one. */
  function proposalValue(): xdr.ScVal {
    const entry = (key: string, value: xdr.ScVal): xdr.ScMapEntry =>
      new xdr.ScMapEntry({ key: toScVal(symbolArg(key)), val: value });
    return xdr.ScVal.scvMap([
      entry('id', toScVal(u64Arg(7n))),
      entry('target', toScVal(addressArg(CORE))),
      entry('func', toScVal(symbolArg('pause'))),
      entry('args', xdr.ScVal.scvVec([])),
      entry('approvals', xdr.ScVal.scvVec([toScVal(addressArg(HOLDER.publicKey()))])),
      entry('executed', toScVal(boolArg(false))),
      entry('proposed_at', toScVal(u64Arg(1_800_000_000n))),
    ]);
  }

  it('decodes a proposal and calls the multisig contract for it', async () => {
    const host = new FakeHost();
    host.simulation = { retval: proposalValue() };

    const proposal = await clientFor(host).proposal(7);

    expect(proposal).toEqual({
      id: 7,
      target: CORE,
      func: 'pause',
      args: [],
      approvals: [HOLDER.publicKey()],
      executed: false,
      proposedAt: 1_800_000_000,
    });
    const call = invoked(host.simulated[0] as Transaction);
    expect(call.functionName).toBe('proposal');
    expect(call.contract).toBe(new Address(MULTISIG).toScAddress().toXDR('hex'));
    expect(scValToNative(call.args[0] as xdr.ScVal)).toBe(7n);
  });

  it('returns null for an unknown proposal id', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvLedgerKeyContractInstance() };

    await expect(clientFor(host).proposal(99)).resolves.toBeNull();
  });

  it('names the missing field when a proposal is malformed', async () => {
    const host = new FakeHost();
    const malformed = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: toScVal(symbolArg('id')),
        val: toScVal(u64Arg(7n)),
      }),
    ]);
    host.simulation = { retval: malformed };

    await expect(clientFor(host).proposal(7)).rejects.toThrow(
      /multisig\.proposal: missing field 'target'/,
    );
  });

  it('lists the live proposal ids', async () => {
    const host = new FakeHost();
    host.simulation = {
      retval: xdr.ScVal.scvVec([1n, 2n, 3n].map((id) => toScVal(u64Arg(id)))),
    };

    await expect(clientFor(host).pendingProposals()).resolves.toEqual([1, 2, 3]);
    expect(invoked(host.simulated[0] as Transaction).functionName).toBe('live_ids');
  });

  it('returns an empty list when nothing is pending', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvVec([]) };

    await expect(clientFor(host).pendingProposals()).resolves.toEqual([]);
  });

  it('reads who approved a proposal', async () => {
    const host = new FakeHost();
    host.simulation = {
      retval: xdr.ScVal.scvVec([
        toScVal(addressArg(HOLDER.publicKey())),
        toScVal(addressArg(OTHER.publicKey())),
      ]),
    };

    await expect(clientFor(host).approvals(7)).resolves.toEqual([
      HOLDER.publicKey(),
      OTHER.publicKey(),
    ]);
    expect(invoked(host.simulated[0] as Transaction).functionName).toBe('approvals');
  });

  it('reads the owner set, the threshold and one owner check', async () => {
    const host = new FakeHost();
    host.simulation = {
      retval: xdr.ScVal.scvVec([toScVal(addressArg(HOLDER.publicKey()))]),
    };
    await expect(clientFor(host).owners()).resolves.toEqual([HOLDER.publicKey()]);

    host.simulation = { retval: xdr.ScVal.scvU32(2) };
    await expect(clientFor(host).threshold()).resolves.toBe(2);

    host.simulation = { retval: xdr.ScVal.scvBool(true) };
    await expect(clientFor(host).isOwner(HOLDER.publicKey())).resolves.toBe(true);
    expect(invoked(host.simulated[2] as Transaction).functionName).toBe('is_owner');
  });

  it('needs no signer: reads work on a client built without one', async () => {
    const host = new FakeHost();
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
    });
    host.simulation = { retval: xdr.ScVal.scvVec([]) };

    await expect(client.pendingProposals()).resolves.toEqual([]);
    expect(host.submitted).toEqual([]);
    expect(host.accountCalls).toEqual([]);
  });
});

describe('breaker monitoring reads', () => {
  /** A breaker configuration the way the contract returns one. */
  function configValue(limit: bigint, windowSeconds: bigint): xdr.ScVal {
    const entry = (key: string, value: xdr.ScVal): xdr.ScMapEntry =>
      new xdr.ScMapEntry({ key: toScVal(symbolArg(key)), val: value });
    return xdr.ScVal.scvMap([
      entry('limit', toScVal(i128Arg(limit))),
      entry('window', toScVal(u64Arg(windowSeconds))),
    ]);
  }

  it('decodes a configuration for a configured resource', async () => {
    const host = new FakeHost();
    host.simulation = { retval: configValue(1_000n, 3_600n) };

    await expect(clientFor(host).breakerConfig('vault:main')).resolves.toEqual({
      limit: 1_000n,
      windowSeconds: 3_600,
    });
    const call = invoked(host.simulated[0] as Transaction);
    expect(call.functionName).toBe('config');
    expect(call.contract).toBe(new Address(BREAKER).toScAddress().toXDR('hex'));
  });

  it('returns null for a resource that was never configured', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvLedgerKeyContractInstance() };

    await expect(clientFor(host).breakerConfig('vault:main')).resolves.toBeNull();
  });

  it('names the missing field when a configuration is malformed', async () => {
    const host = new FakeHost();
    const malformed = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: toScVal(symbolArg('limit')),
        val: toScVal(i128Arg(1_000n)),
      }),
    ]);
    host.simulation = { retval: malformed };

    await expect(clientFor(host).breakerConfig('vault:main')).rejects.toThrow(
      /breaker\.config: missing field 'window'/,
    );
  });

  it('reads the remaining headroom, including very large values', async () => {
    const host = new FakeHost();
    host.simulation = { retval: toScVal(i128Arg(2n ** 100n)) };

    await expect(clientFor(host).breakerRemaining('vault:main')).resolves.toBe(2n ** 100n);
    const call = invoked(host.simulated[0] as Transaction);
    expect(call.functionName).toBe('remaining');
    expect(scValToNative(call.args[0] as xdr.ScVal)).toBe('vault:main');
  });

  it('keeps an unconfigured remaining a refusal, not a zero', async () => {
    const host = new FakeHost();
    host.simulation = {
      error: 'Error(Host, Error(Contract, #3))',
      retval: undefined,
      sorobanData: undefined,
    };

    const error = await clientFor(host)
      .breakerRemaining('vault:main')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SimulationRejectedError);
    expect((error as SimulationRejectedError).code).toBe(3);
    expect((error as SimulationRejectedError).role).toBe('breaker');
    expect((error as SimulationRejectedError).func).toBe('remaining');
    expect((error as Error).message).toContain('NotConfigured');
    expect(host.submitted).toEqual([]);
  });

  it('reads whether the latch is tripped and which resources exist', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvBool(true) };
    await expect(clientFor(host).breakerIsTripped('vault:main')).resolves.toBe(true);

    host.simulation = {
      retval: xdr.ScVal.scvVec(['vault:main', 'vault:ops'].map((name) => toScVal(stringArg(name)))),
    };
    await expect(clientFor(host).breakerResources()).resolves.toEqual(['vault:main', 'vault:ops']);
    expect(invoked(host.simulated[1] as Transaction).functionName).toBe('resources');
  });

  it('returns an empty list when no resource is configured', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvVec([]) };

    await expect(clientFor(host).breakerResources()).resolves.toEqual([]);
  });
});

describe('send', () => {
  it('runs the whole path and reports what landed', async () => {
    const host = new FakeHost();
    host.simulation = { auth: [sourceAccountAuth()] };

    const result = await clientFor(host).send({
      role: 'core',
      func: 'issue',
      args: [
        stringArg('vault'),
        stringArg('withdraw'),
        addressArg(HOLDER.publicKey()),
        boolArg(true),
      ],
    });

    expect(result).toEqual({
      hash: TX_HASH,
      ledger: 4_999,
      appliedAt: 1_800_000_600,
      returnValue: xdr.ScVal.scvBool(true),
    });
    expect(host.accountCalls).toEqual([HOLDER.publicKey()]);
    expect(host.simulated).toHaveLength(1);
    expect(host.submitted).toHaveLength(1);
    expect(host.commitCalls).toEqual([TX_HASH]);
  });

  it('probes and submits under the same sequence number', async () => {
    const host = new FakeHost();
    await clientFor(host).send({ role: 'core', func: 'pause', args: [] });

    const probe = host.simulated[0] as Transaction;
    const submitted = host.submitted[0] as Transaction;
    expect(probe.sequence).toBe('6');
    expect(submitted.sequence).toBe(probe.sequence);
    expect(submitted.source).toBe(HOLDER.publicKey());
  });

  it('pays the base fee plus what the simulation said the call costs', async () => {
    const host = new FakeHost();
    await clientFor(host).send({ role: 'core', func: 'pause', args: [] });

    expect((host.submitted[0] as Transaction).fee).toBe('1300');
  });

  it('honours a configured base fee', async () => {
    const host = new FakeHost();
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
      baseFee: '200',
    });
    await client.send({ role: 'core', func: 'pause', args: [] });

    expect((host.submitted[0] as Transaction).fee).toBe('1400');
  });

  it('carries the simulated footprint into the submitted transaction', async () => {
    const host = new FakeHost();
    await clientFor(host).send({ role: 'core', func: 'pause', args: [] });

    const probe = invoked(host.simulated[0] as Transaction);
    const submitted = invoked(host.submitted[0] as Transaction);
    expect(probe.footprint).toBeUndefined();
    expect(submitted.footprint?.toXDR('hex')).toBe(FOOTPRINT.toXDR('hex'));
  });

  it('signs the envelope, which is what makes the source account pay', async () => {
    const host = new FakeHost();
    await clientFor(host).send({ role: 'core', func: 'pause', args: [] });

    const signatures = (host.submitted[0] as Transaction).signatures;
    expect(signatures).toHaveLength(1);
    const raw = HOLDER.rawPublicKey();
    expect(Buffer.from(signatures[0]?.hint.value ?? new Uint8Array()).toString('hex')).toBe(
      Buffer.from(raw.subarray(28)).toString('hex'),
    );
  });

  it('attaches the authorisation the contract asked for, signed and time-boxed', async () => {
    const host = new FakeHost();
    host.simulation = { auth: [addressAuth(HOLDER.publicKey())], latestLedger: 1_000 };

    await clientFor(host).send({ role: 'core', func: 'issue', args: [] });

    const entry = invoked(host.submitted[0] as Transaction).auth[0];
    const credentials = entry?.credentials;
    if (credentials?.type !== 'sorobanCredentialsAddress') {
      throw new Error('expected address credentials');
    }
    expect(credentials.address.signatureExpirationLedger).toBe(1_010);
    expect(asVec(credentials.address.signature, 'signature')).toHaveLength(1);
  });

  it('uses the configured authorisation window', async () => {
    const host = new FakeHost();
    host.simulation = { auth: [addressAuth(HOLDER.publicKey())], latestLedger: 1_000 };
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
      authLedgerWindow: 3,
    });

    await client.send({ role: 'core', func: 'issue', args: [] });

    const credentials = invoked(host.submitted[0] as Transaction).auth[0]?.credentials;
    if (credentials?.type !== 'sorobanCredentialsAddress') {
      throw new Error('expected address credentials');
    }
    expect(credentials.address.signatureExpirationLedger).toBe(1_003);
  });

  it('leaves a source-account authorisation exactly as the node returned it', async () => {
    const host = new FakeHost();
    const entry = sourceAccountAuth();
    host.simulation = { auth: [entry] };

    await clientFor(host).send({ role: 'core', func: 'issue', args: [] });

    expect(invoked(host.submitted[0] as Transaction).auth[0]?.toXDR('base64')).toBe(
      entry.toXDR('base64'),
    );
  });

  it('refuses to authorise somebody else, before spending anything', async () => {
    const host = new FakeHost();
    host.simulation = { auth: [addressAuth(OTHER.publicKey())] };

    await expect(clientFor(host).send({ role: 'core', func: 'issue', args: [] })).rejects.toThrow(
      ConfigurationError,
    );
    expect(host.submitted).toEqual([]);
    expect(host.simulated).toHaveLength(1);
  });

  it('needs a signer to write and says how to avoid needing one', async () => {
    const host = new FakeHost();
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
    });

    await expect(client.send({ role: 'core', func: 'pause', args: [] })).rejects.toThrow(
      /read\(\)/,
    );
    expect(host.accountCalls).toEqual([]);
  });

  it('does not submit a call the node refused to run', async () => {
    const host = new FakeHost();
    host.simulation = { error: 'Error(Host, Error(Contract, #3))' };

    await expect(clientFor(host).send({ role: 'core', func: 'issue', args: [] })).rejects.toThrow(
      SimulationRejectedError,
    );
    expect(host.submitted).toEqual([]);
  });

  it('accepts a transaction the network had already seen', async () => {
    const host = new FakeHost();
    host.submitOutcome = { status: 'duplicate', hash: TX_HASH, detail: undefined };

    await expect(
      clientFor(host).send({ role: 'core', func: 'pause', args: [] }),
    ).resolves.toMatchObject({
      hash: TX_HASH,
    });
  });

  it('reports a submission the network refused, with the hash to look it up by', async () => {
    const host = new FakeHost();
    host.submitOutcome = { status: 'try_again_later', hash: TX_HASH, detail: 'txTooLate' };

    const error = await clientFor(host)
      .send({ role: 'core', func: 'pause', args: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SubmitFailedError);
    expect((error as SubmitFailedError).detail).toBe('txTooLate');
    expect(host.commitCalls).toEqual([]);
  });

  it('polls until a ledger reports the transaction', async () => {
    const host = new FakeHost();
    const missing: CommitOutcome = {
      status: 'not_found',
      ledger: 0,
      createdAt: 0,
      returnValue: undefined,
      latestLedger: 1_001,
    };
    host.commitQueue = [missing, missing, SUCCESS_COMMIT];

    const result = await clientFor(host).send({ role: 'core', func: 'pause', args: [] });

    expect(result.ledger).toBe(4_999);
    expect(host.commitCalls).toHaveLength(3);
  });

  it('falls back to the simulated return value when the node keeps none', async () => {
    const host = new FakeHost();
    host.commitDefault = { ...SUCCESS_COMMIT, returnValue: undefined };
    host.simulation = { retval: xdr.ScVal.scvU32(7) };

    const result = await clientFor(host).send({ role: 'core', func: 'issue', args: [] });

    expect(asU32(result.returnValue as xdr.ScVal, 'returnValue')).toBe(7);
  });

  it('treats a committed failure as a race, not as a refusal', async () => {
    const host = new FakeHost();
    host.commitQueue = [{ ...SUCCESS_COMMIT, status: 'failed', returnValue: undefined }];

    const error = await clientFor(host)
      .send({ role: 'core', func: 'pause', args: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).hash).toBe(TX_HASH);
    expect((error as Error).message).toContain('race');
  });

  it('gives up on an outcome the node never reports, and hands back the hash', async () => {
    const host = new FakeHost();
    host.commitDefault = {
      status: 'not_found',
      ledger: 0,
      createdAt: 0,
      returnValue: undefined,
      latestLedger: 1_001,
    };
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
      pollIntervalMs: 0,
      commitTimeoutMs: 0,
    });

    const error = await client
      .send({ role: 'core', func: 'pause', args: [] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CommitTimeoutError);
    expect((error as CommitTimeoutError).hash).toBe(TX_HASH);
  });

  it('keeps the ledger facts of a write for the caller to log', async () => {
    const host = new FakeHost();
    const call = {
      role: 'core' as const,
      func: 'issue',
      args: [stringArg('vault'), stringArg('withdraw')],
    };
    const result = await clientFor(host).send(call);

    expect(result.appliedAt).toBe(1_800_000_600);
    expect(invoked(host.submitted[0] as Transaction).functionName).toBe(call.func);
  });
});

describe('commit polling', () => {
  const start = 1_800_000_000_000;
  const interval = 100;
  const call = { role: 'core' as const, func: 'pause', args: [] };
  const missing: CommitOutcome = {
    status: 'not_found',
    ledger: 0,
    createdAt: 0,
    returnValue: undefined,
    latestLedger: 1_001,
  };

  function pollingClient(host: FakeHost, commitTimeoutMs = 1_000): KeygateClient {
    return new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
      pollIntervalMs: interval,
      commitTimeoutMs,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });

  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([0, 1_000])('looks up immediately even with a %i ms timeout', async (timeout) => {
    const host = new FakeHost();
    const pending = pollingClient(host, timeout).send(call);

    await vi.advanceTimersByTimeAsync(0);

    expect(Date.now()).toBe(start);
    expect(host.commitCalls).toEqual([TX_HASH]);
    expect(host.submitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(pending).resolves.toMatchObject({ hash: TX_HASH, ledger: 4_999 });
  });

  it('waits a positive interval between lookups and never resubmits while polling', async () => {
    const host = new FakeHost();
    host.commitQueue = [missing, missing, SUCCESS_COMMIT];
    const pending = pollingClient(host).send(call);

    await vi.advanceTimersByTimeAsync(0);
    expect(host.commitCalls).toEqual([TX_HASH]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(host.commitCalls).toEqual([TX_HASH]);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.commitCalls).toEqual([TX_HASH, TX_HASH]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(host.commitCalls).toEqual([TX_HASH, TX_HASH]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ hash: TX_HASH, ledger: 4_999 });
    expect(host.commitCalls).toEqual([TX_HASH, TX_HASH, TX_HASH]);
    expect(host.accountCalls).toEqual([HOLDER.publicKey()]);
    expect(host.simulated).toHaveLength(1);
    expect(host.submitted).toHaveLength(1);
  });

  it.each([
    { timeout: 200, elapsed: 200, lookups: 3, boundary: 'on' },
    { timeout: 250, elapsed: 300, lookups: 4, boundary: 'after' },
  ])(
    'times out $boundary the deadline after repeated not_found replies, preserving the hash',
    async ({ timeout, elapsed, lookups }) => {
      const host = new FakeHost();
      host.commitDefault = missing;
      // Attach the rejection handler before advancing the clock.
      const pending = pollingClient(host, timeout)
        .send(call)
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(host.commitCalls).toEqual([TX_HASH]);
      await vi.advanceTimersByTimeAsync(elapsed - 1);
      expect(host.commitCalls).toEqual(Array.from({ length: lookups - 1 }, () => TX_HASH));
      expect(vi.getTimerCount()).toBe(1);
      // Only the next lookup's not_found reply triggers timeout.
      await vi.advanceTimersByTimeAsync(1);

      const error = await pending;
      expect(error).toBeInstanceOf(CommitTimeoutError);
      expect(error).toMatchObject({ hash: TX_HASH });
      expect((error as Error).message).toContain('may still land');
      expect(Date.now()).toBe(start + elapsed);
      expect(host.commitCalls).toEqual(Array.from({ length: lookups }, () => TX_HASH));
      expect(host.accountCalls).toEqual([HOLDER.publicKey()]);
      expect(host.simulated).toHaveLength(1);
      expect(host.submitted).toHaveLength(1);
    },
  );

  it.each([
    { status: 'success' as const, timeout: 100, boundary: 'on' },
    { status: 'success' as const, timeout: 75, boundary: 'after' },
    { status: 'failed' as const, timeout: 100, boundary: 'on' },
    { status: 'failed' as const, timeout: 75, boundary: 'after' },
  ])(
    'honours $status $boundary the deadline instead of timing out',
    async ({ status, timeout }) => {
      const host = new FakeHost();
      host.commitQueue = [missing, { ...SUCCESS_COMMIT, status }];
      const pending = pollingClient(host, timeout)
        .send(call)
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(host.commitCalls).toEqual([TX_HASH]);
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(host.commitCalls).toEqual([TX_HASH]);
      await vi.advanceTimersByTimeAsync(1);

      const outcome = await pending;
      if (status === 'success') {
        expect(outcome).toEqual({
          hash: TX_HASH,
          ledger: SUCCESS_COMMIT.ledger,
          appliedAt: SUCCESS_COMMIT.createdAt,
          returnValue: SUCCESS_COMMIT.returnValue,
        });
      } else {
        expect(outcome).toBeInstanceOf(TransactionFailedError);
        expect(outcome).toMatchObject({ hash: TX_HASH });
      }
      expect(Date.now()).toBe(start + interval);
      expect(host.commitCalls).toEqual([TX_HASH, TX_HASH]);
      expect(host.submitted).toHaveLength(1);
    },
  );
});

describe('configuration', () => {
  it('refuses an empty network passphrase', () => {
    expect(
      () =>
        new KeygateClient({
          host: new FakeHost(),
          contracts: CONTRACT_ADDRESSES,
          networkPassphrase: '  ',
        }),
    ).toThrow(/networkPassphrase/);
  });

  it('names the contract it is missing rather than calling a blank address', async () => {
    const host = new FakeHost();
    const client = new KeygateClient({
      host,
      contracts: { core: CORE, policy: POLICY, breaker: BREAKER },
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
    });

    await expect(client.send({ role: 'multisig', func: 'execute', args: [] })).rejects.toThrow(
      /no multisig contract configured/,
    );
    expect(host.simulated).toEqual([]);
  });

  it('relays through multisig once it is configured', async () => {
    const host = new FakeHost();
    const client = new KeygateClient({
      host,
      contracts: CONTRACT_ADDRESSES,
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
    });

    await client.send({ role: 'multisig', func: 'execute', args: [] });

    expect(invoked(host.submitted[0] as Transaction).contract).toBe(
      new Address(MULTISIG).toScAddress().toXDR('hex'),
    );
  });

  it('encodes arguments through the same builders a direct call uses', async () => {
    const host = new FakeHost();
    const args = [stringArg('vault'), boolArg(false)];

    await clientFor(host).send({ role: 'core', func: 'set_rule', args });

    expect(
      invoked(host.submitted[0] as Transaction).args.map((value) => value?.toXDR('hex')),
    ).toEqual(args.map((arg) => toScVal(arg).toXDR('hex')));
  });
});

describe('the client and its own decoders', () => {
  it('rejects a value that is not what the call promised', async () => {
    const host = new FakeHost();
    host.simulation = { retval: xdr.ScVal.scvU32(1) };

    await expect(
      clientFor(host).read({ role: 'core', func: 'paused', args: [] }, asBool),
    ).rejects.toThrow(/core\.paused: expected bool, got scvU32/);
  });
});

describe('payPolicy', () => {
  const reference = new Uint8Array(32).fill(11);
  const deadline = 1_800_000_000;

  /** Builds a struct the way the payments contract returns it. */
  function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
    return xdr.ScVal.scvMap(
      entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
    );
  }

  function receiptMap(): xdr.ScVal {
    return scMap([
      ['reference', toScVal(bytesArg(reference))],
      ['from', toScVal(addressArg(HOLDER.publicKey()))],
      ['to', toScVal(addressArg(OTHER.publicKey()))],
      ['amount', toScVal(i128Arg(10_000_000n))],
      ['timestamp', toScVal(u64Arg(1_795_630_238n))],
    ]);
  }

  it('submits a pay invocation to the payments contract', async () => {
    const host = new FakeHost();
    host.simulation = { retval: receiptMap() };

    const result = await clientFor(host).payPolicy({
      from: HOLDER.publicKey(),
      to: OTHER.publicKey(),
      amount: 10_000_000n,
      reference,
      deadline,
    });

    expect(result.hash).toBe(TX_HASH);
    expect(result.ledger).toBe(4_999);
    const call = invoked(host.submitted[0] as Transaction);
    expect(call.functionName).toBe('pay');
    expect(call.contract).toBe(new Address(PAYMENTS).toScAddress().toXDR('hex'));
    expect(call.args[0]?.type).toBe('scvAddress');
    expect(scValToNative(call.args[0] as xdr.ScVal)).toBe(HOLDER.publicKey());
    expect(scValToNative(call.args[1] as xdr.ScVal)).toBe(OTHER.publicKey());
    expect(scValToNative(call.args[2] as xdr.ScVal)).toBe(10_000_000n);
    expect(call.args[3]?.type).toBe('scvBytes');
    expect(scValToNative(call.args[3] as xdr.ScVal)).toEqual(reference);
    expect(scValToNative(call.args[4] as xdr.ScVal)).toBe(BigInt(deadline));
    expect(call.args[5]?.type).toBe('scvVec');
    expect(scValToNative(call.args[5] as xdr.ScVal)).toEqual([]);
  });

  it('generates a fresh 32-byte reference and an hour-out deadline by default', async () => {
    const host = new FakeHost();
    const before = Math.floor(Date.now() / 1000);

    await clientFor(host).payPolicy({
      from: HOLDER.publicKey(),
      to: OTHER.publicKey(),
      amount: 1_000_000n,
    });

    const call = invoked(host.submitted[0] as Transaction);
    const generated = scValToNative(call.args[3] as xdr.ScVal) as Uint8Array;
    expect(generated).toBeInstanceOf(Uint8Array);
    expect(generated.length).toBe(32);
    expect(generated).not.toEqual(reference);
    const generatedDeadline = scValToNative(call.args[4] as xdr.ScVal) as bigint;
    expect(generatedDeadline).toBeGreaterThanOrEqual(BigInt(before + 3_600));
    expect(generatedDeadline).toBeLessThanOrEqual(BigInt(Math.floor(Date.now() / 1000) + 3_600));
  });

  it('refuses a payment that cannot be valid before it reaches the node', async () => {
    const host = new FakeHost();
    await expect(
      clientFor(host).payPolicy({ from: HOLDER.publicKey(), to: OTHER.publicKey(), amount: 0n }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      clientFor(host).payPolicy({
        from: HOLDER.publicKey(),
        to: HOLDER.publicKey(),
        amount: 1n,
      }),
    ).rejects.toThrow(/sender and recipient must be different/);
    expect(host.submitted).toEqual([]);
  });

  it('says so when no payments contract is configured', async () => {
    const host = new FakeHost();
    const coreOnly = new KeygateClient({
      host,
      contracts: { core: CORE },
      networkPassphrase: PASSPHRASE,
      signer: keypairSigner(HOLDER),
      pollIntervalMs: 0,
    });
    await expect(
      coreOnly.payPolicy({ from: HOLDER.publicKey(), to: OTHER.publicKey(), amount: 1n }),
    ).rejects.toThrow(/no payments contract configured/);
  });

  it('turns a policy refusal into the named contract error', async () => {
    const host = new FakeHost();
    host.simulation = {
      error: 'HostError: Error(Contract, #8)',
      retval: undefined,
      sorobanData: undefined,
    };

    const error = await clientFor(host)
      .payPolicy({ from: HOLDER.publicKey(), to: OTHER.publicKey(), amount: 10_000_000n })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SimulationRejectedError);
    expect((error as SimulationRejectedError).code).toBe(8);
    expect((error as SimulationRejectedError).role).toBe('payments');
    expect((error as SimulationRejectedError).func).toBe('pay');
    expect((error as Error).message).toContain('DailyLimitExceeded');
    expect(host.submitted).toEqual([]);
  });

  it('reads usage, receipt, remaining, allowlist and policy back', async () => {
    const host = new FakeHost();
    host.simulation = {
      retval: scMap([
        ['day_bucket', toScVal(u64Arg(12n))],
        ['day_used', toScVal(i128Arg(10_000_000n))],
        ['month_bucket', toScVal(u64Arg(2n))],
        ['month_used', toScVal(i128Arg(20_000_000n))],
      ]),
    };
    await expect(clientFor(host).paymentUsage(HOLDER.publicKey())).resolves.toEqual({
      dayBucket: 12,
      dayUsed: 10_000_000n,
      monthBucket: 2,
      monthUsed: 20_000_000n,
    });

    host.simulation = { retval: receiptMap() };
    await expect(clientFor(host).paymentReceipt(HOLDER.publicKey(), reference)).resolves.toEqual({
      reference,
      from: HOLDER.publicKey(),
      to: OTHER.publicKey(),
      amount: 10_000_000n,
      timestamp: 1_795_630_238,
    });
    host.simulation = { retval: xdr.ScVal.scvLedgerKeyContractInstance() };
    await expect(clientFor(host).paymentReceipt(HOLDER.publicKey(), reference)).resolves.toBeNull();

    host.simulation = {
      retval: xdr.ScVal.scvVec([toScVal(i128Arg(90_000_000n)), toScVal(i128Arg(980_000_000n))]),
    };
    await expect(clientFor(host).paymentRemaining(HOLDER.publicKey())).resolves.toEqual({
      daily: 90_000_000n,
      monthly: 980_000_000n,
    });

    host.simulation = { retval: xdr.ScVal.scvBool(true) };
    await expect(
      clientFor(host).paymentIsAllowed(HOLDER.publicKey(), OTHER.publicKey()),
    ).resolves.toBe(true);

    host.simulation = {
      retval: scMap([
        ['daily_limit', toScVal(i128Arg(100_000_000n))],
        ['monthly_limit', toScVal(i128Arg(1_000_000_000n))],
        ['approval_above', toScVal(i128Arg(100_000_000n))],
        ['approvers', xdr.ScVal.scvVec([toScVal(addressArg(HOLDER.publicKey()))])],
        ['approval_threshold', toScVal({ kind: 'u32', value: 0 })],
        ['allowlist_only', toScVal(boolArg(false))],
      ]),
    };
    await expect(clientFor(host).paymentPolicy(HOLDER.publicKey())).resolves.toEqual({
      dailyLimit: 100_000_000n,
      monthlyLimit: 1_000_000_000n,
      approvalAbove: 100_000_000n,
      approvers: [HOLDER.publicKey()],
      approvalThreshold: 0,
      allowlistOnly: false,
    });
  });
});
