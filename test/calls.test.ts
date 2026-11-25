import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { toScVal } from '../src/abi.js';
import {
  breakerCalls,
  coreCalls,
  multisigCalls,
  paymentsCalls,
  policyCalls,
  rawCall,
} from '../src/calls.js';
import { u32Arg, type AbiArg } from '../src/types.js';

const ACCOUNT = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const CONTRACT = Keypair.random().publicKey();
const VAULT = { resource: 'vault:main', action: 'withdraw' } as const;

function kinds(args: readonly AbiArg[]): string[] {
  return args.map((arg) => arg.kind);
}

describe('coreCalls', () => {
  it('names the registry functions with their Rust identifiers', () => {
    expect(coreCalls.issue(VAULT, ACCOUNT, 3_600)).toEqual({
      role: 'core',
      func: 'issue',
      args: [
        { kind: 'string', value: 'vault:main' },
        { kind: 'string', value: 'withdraw' },
        { kind: 'address', value: ACCOUNT },
        { kind: 'u64', value: 3_600n },
      ],
    });
    expect(coreCalls.requireAccess(ACCOUNT, VAULT).func).toBe('require_access');
    expect(coreCalls.grantsOf(ACCOUNT).func).toBe('grants_of');
    expect(coreCalls.proposeAdmin(ACCOUNT).func).toBe('propose_admin');
    expect(coreCalls.acceptAdmin().func).toBe('accept_admin');
    expect(coreCalls.cancelAdmin().func).toBe('cancel_admin');
    expect(coreCalls.liveIds().func).toBe('live_ids');
  });

  it('keeps the triple before the holder, which is the order the contract reads', () => {
    expect(kinds(coreCalls.revoke(VAULT, ACCOUNT).args)).toEqual(['string', 'string', 'address']);
    expect(kinds(coreCalls.check(VAULT, ACCOUNT).args)).toEqual(['string', 'string', 'address']);
  });

  it('has no arguments for the zero-argument entry points', () => {
    for (const call of [
      coreCalls.paused(),
      coreCalls.pause(),
      coreCalls.unpause(),
      coreCalls.admin(),
      coreCalls.liveIds(),
    ]) {
      expect(call.args).toEqual([]);
    }
  });
});

describe('policyCalls', () => {
  it('sends an Effect as its discriminant, not its name', () => {
    expect(policyCalls.setRule(VAULT, 'allow').args).toEqual([
      { kind: 'string', value: 'vault:main' },
      { kind: 'string', value: 'withdraw' },
      u32Arg(0),
    ]);
    expect(policyCalls.setRule(VAULT, 'deny').args.at(-1)).toEqual({ kind: 'u32', value: 1 });
    expect(policyCalls.setDefaultEffect('deny').args).toEqual([{ kind: 'u32', value: 1 }]);
  });

  it('takes the registry address it is meant to read from', () => {
    expect(policyCalls.initialize(ACCOUNT, CONTRACT)).toEqual({
      role: 'policy',
      func: 'initialize',
      args: [
        { kind: 'address', value: ACCOUNT },
        { kind: 'address', value: CONTRACT },
      ],
    });
    expect(policyCalls.setRegistry(CONTRACT).args).toEqual([{ kind: 'address', value: CONTRACT }]);
  });
});

describe('breakerCalls', () => {
  it('uses i128 for amounts, because the on-chain limit is signed', () => {
    expect(kinds(breakerCalls.configure('vault:main', -5n, 60).args)).toEqual([
      'string',
      'i128',
      'u64',
    ]);
    expect(breakerCalls.enforce('vault:main', 500n).args).toEqual([
      { kind: 'string', value: 'vault:main' },
      { kind: 'i128', value: 500n },
    ]);
  });

  it('rejects an amount that cannot fit the on-chain type', () => {
    expect(() => breakerCalls.configure('vault', 2n ** 127n, 60)).toThrow(RangeError);
  });

  it('names the read-only entry points', () => {
    expect(breakerCalls.isTripped('vault:main').func).toBe('is_tripped');
    expect(breakerCalls.remaining('vault:main').func).toBe('remaining');
    expect(breakerCalls.resources().args).toEqual([]);
  });
});

describe('multisigCalls', () => {
  it('encodes owners as a vector of addresses plus a u32 threshold', () => {
    const call = multisigCalls.initialize([ACCOUNT, OTHER], 2);
    expect(call.func).toBe('initialize');
    expect(call.args).toEqual([
      {
        kind: 'vec',
        value: [
          { kind: 'address', value: ACCOUNT },
          { kind: 'address', value: OTHER },
        ],
      },
      { kind: 'u32', value: 2 },
    ]);
    expect(multisigCalls.setOwners([ACCOUNT], 1).func).toBe('set_owners');
  });

  it('proposes exactly the call a direct send would have made', () => {
    const direct = coreCalls.pause();
    const proposal = multisigCalls.submit(ACCOUNT, CONTRACT, direct);
    expect(proposal.args).toEqual([
      { kind: 'address', value: ACCOUNT },
      { kind: 'address', value: CONTRACT },
      { kind: 'symbol', value: 'pause' },
      { kind: 'vec', value: [] },
    ]);

    // The relayed arguments are the direct ones, so a proposal cannot quietly
    // mean something other than what `send(direct)` would do.
    const issue = coreCalls.issue(VAULT, OTHER, 60);
    const relayed = multisigCalls.submit(ACCOUNT, CONTRACT, issue);
    expect((relayed.args[3] as { value: readonly AbiArg[] }).value.map(toScVal)).toEqual(
      issue.args.map(toScVal),
    );
  });

  it('names the proposal lifecycle', () => {
    expect(multisigCalls.approve(ACCOUNT, 3).func).toBe('approve');
    expect(multisigCalls.unapprove(ACCOUNT, 3).func).toBe('unapprove');
    expect(multisigCalls.execute(ACCOUNT, 3).func).toBe('execute');
    expect(multisigCalls.proposal(3).args).toEqual([{ kind: 'u64', value: 3n }]);
    expect(multisigCalls.isOwner(ACCOUNT).func).toBe('is_owner');
    expect(multisigCalls.approvals(1).func).toBe('approvals');
    expect(multisigCalls.threshold().args).toEqual([]);
  });
});

describe('rawCall', () => {
  it('wraps a function this module does not know yet', () => {
    expect(rawCall('core', 'upgrade', [{ kind: 'u32', value: 2 }])).toEqual({
      role: 'core',
      func: 'upgrade',
      args: [{ kind: 'u32', value: 2 }],
    });
  });
});

describe('paymentsCalls', () => {
  const reference = new Uint8Array(32).fill(9);

  it('builds pay in the order the contract reads it', () => {
    const call = paymentsCalls.pay(ACCOUNT, OTHER, 10_000_000n, reference, 1_800_000_000);
    expect(call.role).toBe('payments');
    expect(call.func).toBe('pay');
    expect(kinds(call.args)).toEqual(['address', 'address', 'i128', 'bytes', 'u64', 'vec']);
    expect(call.args).toEqual([
      { kind: 'address', value: ACCOUNT },
      { kind: 'address', value: OTHER },
      { kind: 'i128', value: 10_000_000n },
      { kind: 'bytes', value: reference },
      { kind: 'u64', value: 1_800_000_000n },
      { kind: 'vec', value: [] },
    ]);
  });

  it('carries co-signers in the approvals vec', () => {
    const call = paymentsCalls.pay(ACCOUNT, OTHER, 10_000_000n, reference, 1_800_000_000, [
      ACCOUNT,
      OTHER,
    ]);
    expect(call.args[5]).toEqual({
      kind: 'vec',
      value: [
        { kind: 'address', value: ACCOUNT },
        { kind: 'address', value: OTHER },
      ],
    });
  });

  it('refuses a reference that is not exactly 32 bytes', () => {
    expect(() => paymentsCalls.pay(ACCOUNT, OTHER, 1n, new Uint8Array(31), 1_800_000_000)).toThrow(
      /exactly 32 bytes/,
    );
    expect(() => paymentsCalls.paymentReceipt(ACCOUNT, new Uint8Array(33))).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('names the payment read entry points', () => {
    expect(paymentsCalls.usage(ACCOUNT)).toEqual({
      role: 'payments',
      func: 'usage',
      args: [{ kind: 'address', value: ACCOUNT }],
    });
    expect(paymentsCalls.paymentReceipt(ACCOUNT, reference).func).toBe('payment_receipt');
    expect(paymentsCalls.remaining(ACCOUNT).func).toBe('remaining');
    expect(paymentsCalls.isAllowed(ACCOUNT, OTHER).func).toBe('is_allowed');
    expect(paymentsCalls.policy(ACCOUNT).func).toBe('policy');
  });
});
