/**
 * The network surface: four calls, in keygate's own vocabulary.
 *
 * `LedgerHost` is deliberately not `rpc.Server`. The SDK's response types are
 * unions of parsed XDR, half-optional fields and a `_parsed` marker, which is
 * fine to talk to a node but a terrible thing to make a test construct. So the
 * RPC shapes are converted once, in `sorobanRpcHost` below, and everything above
 * it sees plain objects: an error string, an authorization list, a footprint, a
 * commit status.
 *
 * That also means anyone whose node is a private indexer, a state-sync service,
 * or a fixture in a test suite implements these four methods and the rest of the
 * SDK is unchanged.
 */
import { rpc, type Account, type Transaction, type xdr } from '@stellar/stellar-sdk';

/** The source account state needed to build one transaction. */
export interface AccountSnapshot {
  readonly accountId: string;
  readonly sequence: string;
}

export interface SimulationOutcome {
  /** Non-empty when the node refused to run the call; `error` is its own text. */
  readonly error: string | undefined;
  /** True when archived ledger entries must be restored before submitting. */
  readonly needsRestore: boolean;
  readonly latestLedger: number;
  /** Authorisations the contract asked for, unsigned. */
  readonly auth: readonly xdr.SorobanAuthorizationEntry[];
  readonly retval: xdr.ScVal | undefined;
  /** The footprint the call will touch, and what it costs to run it. */
  readonly sorobanData: xdr.SorobanTransactionData | undefined;
  readonly minResourceFee: string;
}

export interface SubmitOutcome {
  readonly status: 'pending' | 'duplicate' | 'try_again_later' | 'error';
  readonly hash: string;
  readonly detail: string | undefined;
}

export interface CommitOutcome {
  readonly status: 'success' | 'failed' | 'not_found';
  /** Ledger the transaction was applied in; `0` while it is missing. */
  readonly ledger: number;
  /** Close time of that ledger, in seconds. */
  readonly createdAt: number;
  readonly returnValue: xdr.ScVal | undefined;
  readonly latestLedger: number;
}

export interface LedgerHost {
  getAccount(address: string): Promise<AccountSnapshot>;
  simulate(transaction: Transaction): Promise<SimulationOutcome>;
  submit(transaction: Transaction): Promise<SubmitOutcome>;
  commit(hash: string): Promise<CommitOutcome>;
}

export function mapSimulation(simulation: rpc.Api.SimulateTransactionResponse): SimulationOutcome {
  if (rpc.Api.isSimulationError(simulation)) {
    return {
      error: simulation.error,
      needsRestore: false,
      latestLedger: simulation.latestLedger,
      auth: [],
      retval: undefined,
      sorobanData: undefined,
      minResourceFee: '0',
    };
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      error: 'ledger entries expired; restore them before submitting',
      needsRestore: true,
      latestLedger: simulation.latestLedger,
      auth: simulation.result.auth,
      retval: simulation.result.retval,
      sorobanData: undefined,
      minResourceFee: simulation.restorePreamble.minResourceFee,
    };
  }
  return {
    error: undefined,
    needsRestore: false,
    latestLedger: simulation.latestLedger,
    auth: simulation.result?.auth ?? [],
    retval: simulation.result?.retval,
    sorobanData: simulation.transactionData.build(),
    minResourceFee: simulation.minResourceFee,
  };
}

/**
 * `sendTransaction` status → keygate's status. A status this map does not know
 * becomes `error` rather than being quietly filed under something safer.
 */
const SUBMIT_STATUS: Record<string, SubmitOutcome['status']> = {
  PENDING: 'pending',
  DUPLICATE: 'duplicate',
  TRY_AGAIN_LATER: 'try_again_later',
  ERROR: 'error',
};

export function mapSubmit(response: rpc.Api.SendTransactionResponse): SubmitOutcome {
  return {
    status: SUBMIT_STATUS[response.status] ?? 'error',
    hash: response.hash,
    detail: response.errorResult?.toXDR('base64'),
  };
}

export function mapCommit(response: rpc.Api.GetTransactionResponse): CommitOutcome {
  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return {
      status: 'not_found',
      ledger: 0,
      createdAt: 0,
      returnValue: undefined,
      latestLedger: response.latestLedger,
    };
  }
  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      status: 'success',
      ledger: response.ledger,
      createdAt: response.createdAt,
      returnValue: response.returnValue,
      latestLedger: response.latestLedger,
    };
  }
  return {
    status: 'failed',
    ledger: response.ledger,
    createdAt: response.createdAt,
    returnValue: undefined,
    latestLedger: response.latestLedger,
  };
}

export function mapAccount(account: Account): AccountSnapshot {
  return { accountId: account.accountId(), sequence: account.sequenceNumber() };
}

/** Wraps a Soroban RPC server so it can be used as a `LedgerHost`. */
export function sorobanRpcHost(server: rpc.Server): LedgerHost {
  return {
    getAccount: async (address) => mapAccount(await server.getAccount(address)),
    simulate: async (transaction) => mapSimulation(await server.simulateTransaction(transaction)),
    submit: async (transaction) => mapSubmit(await server.sendTransaction(transaction)),
    commit: async (hash) => mapCommit(await server.getTransaction(hash)),
  };
}

export interface ConnectOptions {
  /** Only for a local RPC node without TLS. Refused by default. */
  readonly allowHttp?: boolean;
}

/** Opens a Soroban RPC connection and adapts it to `LedgerHost`. */
export function connect(url: string, options: ConnectOptions = {}): LedgerHost {
  const server = new rpc.Server(url, { allowHttp: options.allowHttp ?? false });
  return sorobanRpcHost(server);
}
