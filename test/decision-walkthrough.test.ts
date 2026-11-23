/**
 * The offline signed-decision walkthrough from the README, executed.
 *
 * Every constant here is the one the README prints — the fake demo key, the
 * fixed timestamps — so the walkthrough cannot drift from the code it
 * describes. Nothing here touches a network: `signDecision` plays the server,
 * and the rest is what a caller does with the answer it received.
 */
import { describe, expect, it } from 'vitest';

import { decisionIsUsable, signDecision, verifyDecision } from '../src/decision.js';
import type { Decision, DecisionRequest } from '../src/types.js';

/** Deliberately fake: this key signs nothing real. Never use a production HMAC key here. */
const DEMO_KEY = 'demo-only-not-a-real-key';
/** Fixed "now" for the walkthrough, so the numbers in the README are exact. */
const NOW = 1_800_000_000;

const request: DecisionRequest = {
  holder: 'GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD',
  resource: 'vault:main',
  action: 'withdraw',
  amount: 500n,
};

const decision: Decision = {
  allowed: true,
  grantId: 7,
  expiresAt: NOW + 600,
  budget: { resource: 'vault:main', remaining: '600', requested: '500', windowSeconds: 3_600 },
  evaluatedAt: NOW,
};

describe('offline verification walkthrough (README)', () => {
  it('verifies a signature the server produced', async () => {
    const signature = await signDecision(DEMO_KEY, request, decision);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyDecision(DEMO_KEY, request, decision, signature)).resolves.toBe(true);
  });

  it('fails closed on a missing or malformed signature', async () => {
    const signature = await signDecision(DEMO_KEY, request, decision);
    await expect(verifyDecision(DEMO_KEY, request, decision, '')).resolves.toBe(false);
    await expect(verifyDecision(DEMO_KEY, request, decision, 'zz')).resolves.toBe(false);
    await expect(verifyDecision(DEMO_KEY, request, decision, 'deadbeef')).resolves.toBe(false);
    await expect(
      verifyDecision('some-other-key-entirely', request, decision, signature),
    ).resolves.toBe(false);
  });

  it('treats signature validity and usability as two separate checks', async () => {
    const signature = await signDecision(DEMO_KEY, request, decision);
    // Fresh: both checks pass.
    await expect(verifyDecision(DEMO_KEY, request, decision, signature)).resolves.toBe(true);
    expect(decisionIsUsable(decision, NOW + 30, 60)).toBe(true);

    // Stale: the signature is still genuine, but the answer is too old to act on.
    const stale: Decision = { ...decision, evaluatedAt: NOW - 3_600 };
    const staleSignature = await signDecision(DEMO_KEY, request, stale);
    await expect(verifyDecision(DEMO_KEY, request, stale, staleSignature)).resolves.toBe(true);
    expect(decisionIsUsable(stale, NOW, 60)).toBe(false);

    // Expired grant: genuine signature, dead capability.
    const expired: Decision = { ...decision, expiresAt: NOW - 1 };
    const expiredSignature = await signDecision(DEMO_KEY, request, expired);
    await expect(verifyDecision(DEMO_KEY, request, expired, expiredSignature)).resolves.toBe(true);
    expect(decisionIsUsable(expired, NOW, 3_600)).toBe(false);
  });

  it('never treats a signed denial as usable', async () => {
    const denial: Decision = {
      allowed: false,
      reason: 'policy_denied',
      grantId: null,
      evaluatedAt: NOW,
    };
    const signature = await signDecision(DEMO_KEY, request, denial);
    await expect(verifyDecision(DEMO_KEY, request, denial, signature)).resolves.toBe(true);
    expect(decisionIsUsable(denial, NOW, 3_600)).toBe(false);
  });

  it('shows that a shared key can forge: anyone with it signs anything', async () => {
    const forged: Decision = {
      allowed: true,
      grantId: 7,
      expiresAt: NOW + 86_400,
      budget: null,
      evaluatedAt: NOW,
    };
    const signature = await signDecision(DEMO_KEY, request, forged);
    await expect(verifyDecision(DEMO_KEY, request, forged, signature)).resolves.toBe(true);
  });
});
