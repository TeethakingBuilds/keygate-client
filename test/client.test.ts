import {
  Address,
  Keypair,
  SorobanDataBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { asBool, toScVal } from '../src/abi.js';
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
import { addressArg, boolArg, stringArg } from '../src/types.js';
import {
  BREAKER,
  CORE,
  MULTISIG,
  PASSPHRASE,
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
  const body = tx.toEnvelope().v1().tx().operations()[0]?.body();
  // Not `body.invokeHostFunction()`: for `OperationBody` that name is js-xdr's
  // switch-based setter, and it returns `undefined`. See `abi.ts`.
  const operation = body?.value() as xdr.InvokeHostFunctionOp | undefined;
  if (operation === undefined) throw new Error('no invokeHostFunction operation');
  const contract = operation.hostFunction().invokeContract();
  return {
    contract: contract.contractAddress().toXDR('hex'),
    functionName: String(contract.functionName()),
    args: contract.args(),
    auth: operation.auth(),
    footprint: tx.toEnvelope().v1().tx().ext().sorobanData(),
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
    expect(call.args[2]?.switch().name).toBe('scvAddress');
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
    expect(Buffer.from(signatures[0]?.hint() as Uint8Array).toString('hex')).toBe(
      Buffer.from(raw.subarray(28)).toString('hex'),
    );
  });

  it('attaches the authorisation the contract asked for, signed and time-boxed', async () => {
    const host = new FakeHost();
    host.simulation = { auth: [addressAuth(HOLDER.publicKey())], latestLedger: 1_000 };

    await clientFor(host).send({ role: 'core', func: 'issue', args: [] });

    const entry = invoked(host.submitted[0] as Transaction).auth[0];
    const credentials = entry?.credentials().address();
    expect(credentials?.signatureExpirationLedger()).toBe(1_010);
    expect(credentials?.signature().vec()).toHaveLength(1);
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

    expect(
      invoked(host.submitted[0] as Transaction)
        .auth[0]?.credentials()
        .address()
        ?.signatureExpirationLedger(),
    ).toBe(1_003);
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

    expect(result.returnValue?.u32()).toBe(7);
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
