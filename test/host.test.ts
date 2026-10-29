import {
  Account,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { mapAccount, mapCommit, mapSimulation, mapSubmit, sorobanRpcHost } from '../src/host.js';
import { CORE, PASSPHRASE, addressAuth } from './fixtures.js';

const BASE = { id: '1', latestLedger: 1234, events: [], _parsed: true };

const DATA = new SorobanDataBuilder().setResources(1000, 2000, 3000).build();
const RETVAL = xdr.ScVal.scvBool(true);
const AUTH = [addressAuth('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')];
const RESULT = xdr.TransactionResult.fromXDR(Buffer.alloc(20), 'raw');

/**
 * The XDR fields `getTransaction` always carries. `mapCommit` reads none of
 * them, so they come from a real transaction of our own building rather than
 * from a fixture that would only be a guess at what a node returns.
 */
const COMMITTED = {
  envelopeXdr: new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: CORE, function: 'issue', args: [], auth: [] }),
    )
    .setTimeout(0)
    .build()
    .toEnvelope(),
  resultXdr: RESULT,
  resultMetaXdr: xdr.TransactionMeta.fromXDR(Buffer.alloc(8), 'raw'),
};

/** A transaction the node has already applied. */
function recorded(status: rpc.Api.GetTransactionStatus): rpc.Api.GetTransactionResponse {
  return {
    status,
    txHash: 'abc',
    latestLedger: 500,
    latestLedgerCloseTime: 1,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
    ledger: 499,
    createdAt: 1_800_000_000,
    applicationOrder: 1,
    feeBump: false,
    ...COMMITTED,
  };
}

describe('mapSimulation', () => {
  it('reports a node refusal without inventing a footprint', () => {
    const outcome = mapSimulation({ ...BASE, error: 'HostError: Error(Contract, #3)' });

    expect(outcome).toEqual({
      error: 'HostError: Error(Contract, #3)',
      needsRestore: false,
      latestLedger: 1234,
      auth: [],
      retval: undefined,
      sorobanData: undefined,
      minResourceFee: '0',
    });
  });

  it('marks an expired-entry simulation as needing a restore', () => {
    const outcome = mapSimulation({
      ...BASE,
      transactionData: new SorobanDataBuilder(DATA),
      minResourceFee: '111',
      result: { auth: AUTH, retval: RETVAL },
      restorePreamble: { minResourceFee: '999', transactionData: new SorobanDataBuilder() },
    });

    expect(outcome.needsRestore).toBe(true);
    expect(outcome.error).toMatch(/restore/);
    // The preamble describes the restore transaction, not the one we would
    // submit, so its footprint must not leak into this outcome.
    expect(outcome.sorobanData).toBeUndefined();
    expect(outcome.minResourceFee).toBe('999');
    expect(outcome.retval).toBe(RETVAL);
  });

  it('carries the footprint and cost of a successful simulation', () => {
    const outcome = mapSimulation({
      ...BASE,
      transactionData: new SorobanDataBuilder(DATA),
      minResourceFee: '4567',
      result: { auth: AUTH, retval: RETVAL },
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.needsRestore).toBe(false);
    expect(outcome.sorobanData?.toXDR('hex')).toBe(DATA.toXDR('hex'));
    expect(outcome.minResourceFee).toBe('4567');
    expect(outcome.retval).toBe(RETVAL);
    expect(outcome.auth).toEqual(AUTH);
  });

  it('tolerates a simulation that ran no host function, so has no result', () => {
    const outcome = mapSimulation({
      ...BASE,
      transactionData: new SorobanDataBuilder(DATA),
      minResourceFee: '100',
    });

    expect(outcome.auth).toEqual([]);
    expect(outcome.retval).toBeUndefined();
  });
});

describe('mapSubmit', () => {
  const pending = { latestLedger: 10, latestLedgerCloseTime: 11, hash: 'abc' };

  it.each([
    ['PENDING', 'pending'],
    ['DUPLICATE', 'duplicate'],
    ['TRY_AGAIN_LATER', 'try_again_later'],
    ['ERROR', 'error'],
  ] as const)('maps the SDK status %s', (from, to) => {
    expect(mapSubmit({ ...pending, status: from }).status).toBe(to);
  });

  it('treats a status this version does not know as an error', () => {
    const response = {
      ...pending,
      status: 'BROADCASTING',
    } as unknown as rpc.Api.SendTransactionResponse;

    expect(mapSubmit(response).status).toBe('error');
  });

  it('keeps the hash and the encoded failure result', () => {
    const outcome = mapSubmit({ ...pending, status: 'ERROR', errorResult: RESULT });

    expect(outcome.hash).toBe('abc');
    expect(outcome.detail).toBe(RESULT.toXDR('base64'));
  });

  it('has no detail for a submission the network accepted', () => {
    expect(mapSubmit({ ...pending, status: 'PENDING' }).detail).toBeUndefined();
  });
});

describe('mapCommit', () => {
  it('reports a transaction the node has not seen yet', () => {
    const outcome = mapCommit(recorded(rpc.Api.GetTransactionStatus.NOT_FOUND));

    expect(outcome).toEqual({
      status: 'not_found',
      ledger: 0,
      createdAt: 0,
      returnValue: undefined,
      latestLedger: 500,
    });
  });

  it('passes the return value through on success', () => {
    const response = { ...recorded(rpc.Api.GetTransactionStatus.SUCCESS), returnValue: RETVAL };
    const outcome = mapCommit(response);

    expect(outcome.status).toBe('success');
    expect(outcome.ledger).toBe(499);
    expect(outcome.createdAt).toBe(1_800_000_000);
    expect(outcome.returnValue).toBe(RETVAL);
  });

  it('has no return value on a failed transaction, which never completed', () => {
    const outcome = mapCommit(recorded(rpc.Api.GetTransactionStatus.FAILED));

    expect(outcome.status).toBe('failed');
    expect(outcome.returnValue).toBeUndefined();
    expect(outcome.ledger).toBe(499);
  });
});

describe('mapAccount', () => {
  it('reads the two fields building a transaction needs', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    expect(mapAccount(new Account(address, '42'))).toEqual({
      accountId: address,
      sequence: '42',
    });
  });
});

describe('sorobanRpcHost', () => {
  it('calls the four RPC methods and maps each response', async () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const calls: string[] = [];
    const server = {
      getAccount: () => {
        calls.push('getAccount');
        return Promise.resolve(new Account(address, '7'));
      },
      simulateTransaction: () => {
        calls.push('simulateTransaction');
        return Promise.resolve({
          ...BASE,
          transactionData: new SorobanDataBuilder(DATA),
          minResourceFee: '50',
        });
      },
      sendTransaction: () => {
        calls.push('sendTransaction');
        return Promise.resolve({
          status: 'PENDING',
          hash: 'abc',
          latestLedger: 1,
          latestLedgerCloseTime: 1,
        });
      },
      getTransaction: () => {
        calls.push('getTransaction');
        return Promise.resolve(recorded(rpc.Api.GetTransactionStatus.SUCCESS));
      },
    } as unknown as rpc.Server;

    const host = sorobanRpcHost(server);
    const tx = {} as unknown as Transaction;

    await expect(host.getAccount(address)).resolves.toEqual({ accountId: address, sequence: '7' });
    const simulation = await host.simulate(tx);
    expect(simulation.sorobanData?.toXDR('hex')).toBe(DATA.toXDR('hex'));
    await expect(host.submit(tx)).resolves.toMatchObject({ status: 'pending', hash: 'abc' });
    await expect(host.commit('abc')).resolves.toMatchObject({ status: 'success', ledger: 499 });

    expect(calls).toEqual([
      'getAccount',
      'simulateTransaction',
      'sendTransaction',
      'getTransaction',
    ]);
  });
});
