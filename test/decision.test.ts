import { describe, expect, it } from 'vitest';

import {
  canonicalDecision,
  decisionIsUsable,
  signDecision,
  verifyDecision,
} from '../src/decision.js';
import type { BudgetSummary, Decision, DecisionRequest } from '../src/types.js';

const KEY = 'a-key-shared-between-the-client-and-the-decision-service';
const NOW = 1_800_000_000;

const BUDGET: BudgetSummary = {
  resource: 'vault:main',
  remaining: '600',
  requested: '500',
  windowSeconds: 3_600,
};

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    holder: 'GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD',
    resource: 'vault:main',
    action: 'withdraw',
    amount: 500n,
    ...overrides,
  };
}

function allowed(overrides: Partial<Extract<Decision, { allowed: true }>> = {}): Decision {
  return {
    allowed: true,
    grantId: 7,
    expiresAt: NOW + 600,
    budget: BUDGET,
    evaluatedAt: NOW,
    ...overrides,
  };
}

function denied(overrides: Partial<Extract<Decision, { allowed: false }>> = {}): Decision {
  return { allowed: false, reason: 'policy_denied', grantId: null, evaluatedAt: NOW, ...overrides };
}

describe('canonicalDecision', () => {
  it('is a pure function of the request and the decision', () => {
    expect(canonicalDecision(request(), allowed())).toBe(canonicalDecision(request(), allowed()));
  });

  it('starts with the version so a future format cannot be mistaken for this one', () => {
    expect(canonicalDecision(request(), allowed()).startsWith('19:keygate-decision-v1|')).toBe(
      true,
    );
  });

  it('cannot be confused by a resource that ends in the next field name', () => {
    // Without the length prefixes these two render identically — `resource=x`
    // followed by `action=y|action=z` is the same text as `resource=x|action=y`
    // followed by `action=z` — which would let a holder with a grant on one pair
    // present a signature made for the other.
    const sneaky = request({ resource: 'x|action=y', action: 'z' });
    const innocent = request({ resource: 'x', action: 'y|action=z' });
    expect(canonicalDecision(sneaky, allowed())).not.toBe(canonicalDecision(innocent, allowed()));
  });

  it('keeps an absent amount distinct from a zero amount', () => {
    expect(canonicalDecision(request({ amount: undefined }), allowed())).not.toContain('amount=0|');
    expect(canonicalDecision(request({ amount: 0n }), allowed())).toContain('8:amount=0');
    expect(canonicalDecision(request({ amount: undefined }), allowed())).toContain(
      '11:amount=null',
    );
  });

  it('states the budget only for an allowed decision that had one', () => {
    expect(canonicalDecision(request(), allowed())).toContain('requested=500');
    expect(canonicalDecision(request(), allowed({ budget: null }))).not.toContain('remaining');
    expect(canonicalDecision(request(), denied())).not.toContain('budgetResource');
  });

  it('renders a denial with its reason and no expiry', () => {
    const text = canonicalDecision(request({ amount: undefined }), denied());
    expect(text).toContain('reason=policy_denied');
    expect(text).toContain('expiresAt=null');
    expect(text).toContain('grantId=null');
  });

  it('distinguishes a denial reason from a holder editing one', () => {
    expect(canonicalDecision(request(), denied({ reason: 'budget_tripped' }))).not.toBe(
      canonicalDecision(request(), denied({ reason: 'policy_denied' })),
    );
  });
});

describe('signDecision and verifyDecision', () => {
  it('round-trips an allowed decision', async () => {
    const signature = await signDecision(KEY, request(), allowed());
    await expect(verifyDecision(KEY, request(), allowed(), signature)).resolves.toBe(true);
  });

  it('round-trips a denial, which also needs signing to be replay-proof', async () => {
    const signature = await signDecision(KEY, request(), denied());
    await expect(verifyDecision(KEY, request(), denied(), signature)).resolves.toBe(true);
  });

  it('rejects a decision edited after signing', async () => {
    const signature = await signDecision(KEY, request(), allowed());
    const tampered = allowed({ expiresAt: NOW + 86_400 });
    await expect(verifyDecision(KEY, request(), tampered, signature)).resolves.toBe(false);
  });

  it('rejects another key', async () => {
    const signature = await signDecision(KEY, request(), allowed());
    await expect(
      verifyDecision('some-other-key-entirely', request(), allowed(), signature),
    ).resolves.toBe(false);
  });

  it('rejects a signature that is not 32 bytes of hex', async () => {
    for (const junk of ['', 'zz', 'deadbeef', 'A'.repeat(63), 'B'.repeat(65)]) {
      await expect(verifyDecision(KEY, request(), allowed(), junk)).resolves.toBe(false);
    }
  });

  it('produces lowercase hex of exactly 64 characters', async () => {
    const signature = await signDecision(KEY, request(), allowed());
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('decisionIsUsable', () => {
  it('accepts a fresh allowed decision', () => {
    expect(decisionIsUsable(allowed(), NOW + 1, 60)).toBe(true);
  });

  it('refuses once the evaluation is older than the caller allows', () => {
    expect(decisionIsUsable(allowed(), NOW + 61, 60)).toBe(false);
  });

  it('refuses after the capability itself expires', () => {
    expect(decisionIsUsable(allowed({ expiresAt: NOW + 10 }), NOW + 11, 3_600)).toBe(false);
  });

  it('never treats a denial as usable', () => {
    expect(decisionIsUsable(denied(), NOW, 3_600)).toBe(false);
  });
});
