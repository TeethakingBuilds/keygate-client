/**
 * The cross-repo contract.
 *
 * These vectors were produced by `signDecision` in keygate-server
 * (`src/http/signing.ts`) and pasted here verbatim. If either side changes how a
 * decision is rendered — field order, the length prefixes, when budget fields are
 * included — this file fails, which is the only reason the two repositories can
 * be deployed against each other with confidence.
 */
import { describe, expect, it } from 'vitest';

import { canonicalDecision, verifyDecision } from '../src/decision.js';
import type { Decision, DecisionRequest } from '../src/types.js';

const KEY = 'keygate-cross-repo-golden-key';
const HOLDER = 'GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD';

const withAmount: DecisionRequest = {
  holder: HOLDER,
  resource: 'vault:main',
  action: 'withdraw',
  amount: 500n,
};

const withoutAmount: DecisionRequest = {
  holder: HOLDER,
  resource: 'vault:main',
  action: 'withdraw',
};

const allowed: Decision = {
  allowed: true,
  grantId: 7,
  expiresAt: 1_800_000_600,
  budget: {
    resource: 'vault:main',
    remaining: '600',
    requested: '500',
    windowSeconds: 3_600,
  },
  evaluatedAt: 1_800_000_000,
};

const denied: Decision = {
  allowed: false,
  reason: 'budget_exhausted',
  grantId: null,
  evaluatedAt: 1_800_000_000,
};

describe('the server’s canonical rendering', () => {
  it('reproduces an allowed decision byte for byte', () => {
    expect(canonicalDecision(withAmount, allowed)).toBe(
      '19:keygate-decision-v1|63:holder=GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD|19:resource=vault:main|15:action=withdraw|10:amount=500|12:allowed=true|11:reason=null|9:grantId=7|22:evaluatedAt=1800000000|20:expiresAt=1800000600|25:budgetResource=vault:main|13:remaining=600|13:requested=500|18:windowSeconds=3600',
    );
  });

  it('reproduces a denied decision, which carries no budget fields', () => {
    expect(canonicalDecision(withoutAmount, denied)).toBe(
      '19:keygate-decision-v1|63:holder=GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD|19:resource=vault:main|15:action=withdraw|11:amount=null|13:allowed=false|23:reason=budget_exhausted|12:grantId=null|22:evaluatedAt=1800000000|14:expiresAt=null',
    );
  });

  it('accepts the signature the server produced', async () => {
    await expect(
      verifyDecision(
        KEY,
        withAmount,
        allowed,
        '586574152618cd2dc172846c26cbb5a9ee2df9c60310f348550ff7b36585841f',
      ),
    ).resolves.toBe(true);

    await expect(
      verifyDecision(
        KEY,
        withoutAmount,
        denied,
        'a40ddf36e966cf574ca681d11ab214e684f251867d1b91a949eadfc3277cad43',
      ),
    ).resolves.toBe(true);
  });

  it('refuses the allowed signature when the amount was edited in transit', async () => {
    await expect(
      verifyDecision(
        KEY,
        { ...withAmount, amount: 5_000n },
        allowed,
        '586574152618cd2dc172846c26cbb5a9ee2df9c60310f348550ff7b36585841f',
      ),
    ).resolves.toBe(false);
  });

  it('refuses the allowed signature replayed for a different holder', async () => {
    await expect(
      verifyDecision(
        KEY,
        { ...withAmount, holder: 'GA7LEPH6WE75ATHZKBKK4LO4DXC3EDY3L7BSR2CQ6AKJPWNIYXLLKFEO' },
        allowed,
        '586574152618cd2dc172846c26cbb5a9ee2df9c60310f348550ff7b36585841f',
      ),
    ).resolves.toBe(false);
  });
});
