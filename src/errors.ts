/**
 * Contract failure codes, lifted out of the Rust `#[contracterror]` enums.
 *
 * Soroban hands a contract error back as a bare u32, and the same number means
 * different things in every contract — `3` is `Paused` in the registry but
 * `NotConfigured` in the breaker. So a code is only interpretable together with
 * the role it came from, which is why every error here carries both.
 *
 * These tables are the mirror image of the enums in `keygate-contracts`; adding
 * a variant there without a line here leaves the number to be reported as
 * `unknown` rather than silently mislabelled.
 */
import type { ContractRole } from './types.js';

export const CONTRACT_ERRORS: Record<ContractRole, Readonly<Record<number, string>>> = {
  core: {
    1: 'AlreadyInitialized',
    2: 'NotInitialized',
    3: 'Paused',
    4: 'GrantNotFound',
    5: 'ZeroTtl',
    6: 'NoPendingAdmin',
  },
  policy: {
    1: 'AlreadyInitialized',
    2: 'NotInitialized',
    3: 'RuleNotFound',
    4: 'EmptyName',
  },
  breaker: {
    1: 'AlreadyInitialized',
    2: 'NotInitialized',
    3: 'NotConfigured',
    4: 'Tripped',
    5: 'Breached',
    6: 'InvalidLimit',
    7: 'InvalidWindow',
    8: 'InvalidAmount',
  },
  multisig: {
    1: 'AlreadyInitialized',
    2: 'EmptyOwners',
    3: 'DuplicateOwner',
    4: 'InvalidThreshold',
    5: 'NotAnOwner',
    6: 'ProposalNotFound',
    7: 'AlreadyExecuted',
    8: 'DuplicateApproval',
    9: 'QuorumNotMet',
  },
};

export function errorNameFor(role: ContractRole, code: number): string {
  return CONTRACT_ERRORS[role][code] ?? `UnknownError(${code})`;
}

/** Base class, so a caller can catch everything keygate raises in one `catch`. */
export class KeygateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeygateError';
  }
}

/**
 * A contract function refused the call.
 *
 * `code` is the raw discriminant: matching on it survives a rename of the Rust
 * variant, matching on `errorName` survives nothing.
 */
export class ContractRejectedError extends KeygateError {
  readonly role: ContractRole;
  readonly func: string;
  readonly code: number;

  constructor(role: ContractRole, func: string, code: number) {
    const errorName = errorNameFor(role, code);
    super(`${role}.${func} was rejected on-chain: ${errorName} (code ${code})`);
    this.name = errorName;
    this.role = role;
    this.func = func;
    this.code = code;
  }
}

/**
 * The node refused the transaction before it could be submitted.
 *
 * Soroban RPC reports simulation failures as a prose string, which is the only
 * thing to show a user; when it also contains a contract code we surface it so
 * the failure can be matched programmatically.
 */
export class SimulationRejectedError extends KeygateError {
  readonly role: ContractRole;
  readonly func: string;
  readonly detail: string;
  readonly code: number | undefined;

  constructor(role: ContractRole, func: string, detail: string, code?: number) {
    const reason = code === undefined ? detail : errorNameFor(role, code);
    super(`${role}.${func} did not simulate: ${reason}`);
    this.name = 'SimulationRejected';
    this.role = role;
    this.func = func;
    this.detail = detail;
    this.code = code;
  }
}

/** The network rejected the submission. */
export class SubmitFailedError extends KeygateError {
  readonly status: string;
  readonly hash: string;
  readonly detail: string | undefined;

  constructor(status: string, hash: string, detail?: string) {
    super(`submission failed (${status}): ${detail ?? 'no diagnostics returned'}`);
    this.name = 'SubmitFailed';
    this.status = status;
    this.hash = hash;
    this.detail = detail;
  }
}

/**
 * The transaction was committed and then failed, so nothing changed.
 *
 * The simulation passed, which means this is a race rather than a refusal:
 * another transaction took the footprint, or the account sequence moved.
 */
export class TransactionFailedError extends KeygateError {
  readonly hash: string;

  constructor(hash: string) {
    super(
      `transaction ${hash} failed on-chain; the simulation passed, so this is a race (re-send it)`,
    );
    this.name = 'TransactionFailed';
    this.hash = hash;
  }
}

/** No commit status within the caller's deadline — the outcome is genuinely unknown. */
export class CommitTimeoutError extends KeygateError {
  readonly hash: string;

  constructor(hash: string) {
    super(`no commit result for ${hash} before the deadline; the transaction may still land`);
    this.name = 'CommitTimeout';
    this.hash = hash;
  }
}

/** The client was configured in a way that cannot work. */
export class ConfigurationError extends KeygateError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Extracts a contract code from a simulation error string.
 *
 * `simulateTransaction` executes the host function, so a contract that refuses a
 * call — a paused registry, an owner without quorum — reports it here rather than
 * after submission. soroban-env-host renders that refusal as `Error(Contract, #4)
 *` in the prose the RPC returns, and older hosts say `ContractError(Contract,
 * #4)`; both are matched. If the format changes, this returns `undefined` and the
 * caller still has the raw string, which is the right failure mode for parsing
 * someone else's error message.
 */
export function codeFromHostError(detail: string): number | undefined {
  const match = /(?:Error|ContractError)\(Contract, #(\d+)\)/.exec(detail);
  return match === null ? undefined : Number(match[1]);
}
