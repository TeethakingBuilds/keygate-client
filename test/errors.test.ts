import { describe, expect, it } from 'vitest';

import {
  CONTRACT_ERRORS,
  ConfigurationError,
  CommitTimeoutError,
  ContractRejectedError,
  KeygateError,
  SimulationRejectedError,
  SubmitFailedError,
  TransactionFailedError,
  codeFromHostError,
  errorNameFor,
} from '../src/errors.js';

describe('the error tables', () => {
  it('match the discriminants in the Rust enums', () => {
    expect(CONTRACT_ERRORS.core).toEqual({
      1: 'AlreadyInitialized',
      2: 'NotInitialized',
      3: 'Paused',
      4: 'GrantNotFound',
      5: 'ZeroTtl',
      6: 'NoPendingAdmin',
    });
    expect(CONTRACT_ERRORS.policy).toEqual({
      1: 'AlreadyInitialized',
      2: 'NotInitialized',
      3: 'RuleNotFound',
      4: 'EmptyName',
    });
    expect(CONTRACT_ERRORS.breaker).toEqual({
      1: 'AlreadyInitialized',
      2: 'NotInitialized',
      3: 'NotConfigured',
      4: 'Tripped',
      5: 'Breached',
      6: 'InvalidLimit',
      7: 'InvalidWindow',
      8: 'InvalidAmount',
    });
    expect(CONTRACT_ERRORS.multisig).toEqual({
      1: 'AlreadyInitialized',
      2: 'EmptyOwners',
      3: 'DuplicateOwner',
      4: 'InvalidThreshold',
      5: 'NotAnOwner',
      6: 'ProposalNotFound',
      7: 'AlreadyExecuted',
      8: 'DuplicateApproval',
      9: 'QuorumNotMet',
    });
  });

  it('are the reason a code needs a role: the same number says different things', () => {
    expect(errorNameFor('core', 3)).toBe('Paused');
    expect(errorNameFor('breaker', 3)).toBe('NotConfigured');
    expect(errorNameFor('multisig', 3)).toBe('DuplicateOwner');
  });

  it('reports an unknown number as unknown instead of guessing', () => {
    expect(errorNameFor('core', 99)).toBe('UnknownError(99)');
  });
});

describe('codeFromHostError', () => {
  it('reads the code out of the host’s rendering', () => {
    expect(codeFromHostError('Error(HostError(Error(Contract, #4)))')).toBe(4);
    expect(codeFromHostError('[ContractError(Contract, #9)]')).toBe(9);
  });

  it('returns undefined when the prose carries no contract code', () => {
    expect(codeFromHostError('Could not find source account')).toBeUndefined();
    expect(codeFromHostError('')).toBeUndefined();
    // A bare `#3` in unrelated text is not evidence of a contract error.
    expect(codeFromHostError('ledger 12029 #3 missing')).toBeUndefined();
  });
});

describe('the error objects', () => {
  it('all share one base class', () => {
    for (const error of [
      new ContractRejectedError('core', 'issue', 3),
      new SimulationRejectedError('core', 'issue', 'nope'),
      new SubmitFailedError('error', 'abc123'),
      new TransactionFailedError('abc123'),
      new CommitTimeoutError('abc123'),
      new ConfigurationError('nope'),
    ]) {
      expect(error).toBeInstanceOf(KeygateError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('carries the role, function and code of an on-chain refusal', () => {
    const error = new ContractRejectedError('multisig', 'execute', 9);
    expect(error.name).toBe('QuorumNotMet');
    expect(error.code).toBe(9);
    expect(error.role).toBe('multisig');
    expect(error.func).toBe('execute');
    expect(error.message).toContain(
      'multisig.execute was rejected on-chain: QuorumNotMet (code 9)',
    );
  });

  it('keeps the node’s prose when it cannot find a code', () => {
    const error = new SimulationRejectedError('core', 'issue', 'missing ledger entry');
    expect(error.code).toBeUndefined();
    expect(error.detail).toBe('missing ledger entry');
    expect(error.message).toContain('missing ledger entry');
  });

  it('prefers the decoded code when the host gave one', () => {
    const detail = 'Error(HostError(Error(Contract, #5)))';
    const error = new SimulationRejectedError('core', 'issue', detail, codeFromHostError(detail));
    expect(error.code).toBe(5);
    expect(error.message).toContain('ZeroTtl');
    expect(error.detail).toBe(detail);
  });

  it('names the hash when the outcome is unknown', () => {
    expect(new CommitTimeoutError('deadbeef').hash).toBe('deadbeef');
    expect(new TransactionFailedError('deadbeef').message).toContain('deadbeef');
    const submit = new SubmitFailedError('try_again_later', 'deadbeef', 'sensitive');
    expect(submit.status).toBe('try_again_later');
    expect(submit.detail).toBe('sensitive');
  });
});
