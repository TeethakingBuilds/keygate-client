# keygate-client

[![CI](https://github.com/TeethakingBuilds/keygate-client/actions/workflows/node.yml/badge.svg)](https://github.com/TeethakingBuilds/keygate-client/actions/workflows/node.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![status: unaudited 0.1](https://img.shields.io/badge/status-unaudited%200.1-orange)](./SECURITY.md)

The TypeScript SDK for [keygate](https://github.com/TeethakingBuilds/keygate-contracts): build and submit the transactions that manage on-chain capabilities, read the state those contracts hold, and verify a decision from [keygate-server](https://github.com/TeethakingBuilds/keygate-server) without trusting the proxy it came through.

It is a client, not a service. There is no daemon, no storage, and no key of its
own — signing goes through a one-method interface, so an HSM, a remote signing
service and a `Keypair` can each sit behind it (see
[Signing with a wallet](#signing-with-a-wallet) for what does not fit).

```
calls.ts ──▶ KeygateClient ──▶ LedgerHost ──▶ Soroban RPC
(what to    (simulate, sign    (four methods:      (or your own
 call)       authorize,         getAccount,         implementation,
             submit, wait)      simulate, submit,    including a test
                               commit)                fake)
```

## Install

The package is not on npm yet. Build it and point at the output, or vendor `src/`:

```bash
git clone https://github.com/TeethakingBuilds/keygate-client
cd keygate-client && corepack pnpm install && corepack pnpm build   # → dist/
```

Requires Node 20+ and `@stellar/stellar-sdk` ^13, which this package declares as
a dependency. The decision verification in `decision.ts` uses WebCrypto, so it
also runs in a browser; `signer.ts` touches `Buffer` in one place because js-xdr
types a signature field that way, and a bundler has to provide it.

## Quick start

```ts
import { KeygateClient, breakerCalls, connect, coreCalls, keypairSigner } from 'keygate-client';

const client = new KeygateClient({
  host: connect('https://soroban-testnet.stellar.org'),
  contracts: {
    core: 'C…',
    policy: 'C…',
    breaker: 'C…',
    multisig: 'C…', // optional: only needed for the proposal builders
  },
  networkPassphrase: 'Test SDF Network ; September 2015',
  signer: keypairSigner(admin),
});

// A read: free, no signer, no submission. Simulation runs the contract.
const allowed = await client.hasAccess({ resource: 'vault:main', action: 'withdraw' }, holder);

// A write: configure a breaker, then check what it says now.
await client.send(breakerCalls.configure('vault:main', 1_000n, 3_600));
const state = await client.breakerState('vault:main');
```

`send()` is the whole Soroban dance — sequence number, simulation, authorisation
signing, footprint and resource fee, submit, poll for commit — and returns the
hash, the ledger it landed in, and the call's return value. Reads stop after
simulation, which is why `hasAccess` costs no transaction fee and needs no key.

Decode a breaker's `enforce` result only when `SendResult.returnValue` is defined:

```ts
import { breakerCalls, decodeBreakerOutcome } from 'keygate-client';

const result = await client.send(breakerCalls.enforce('vault:main', 500n));
if (result.returnValue === undefined) {
  throw new Error(`No breaker outcome available for ${result.hash}`);
}
const outcome = decodeBreakerOutcome(result.returnValue);
if (outcome === 'breached') {
  // A normal return value, not a contract-call error: do not move value.
  console.warn(`Breaker breached: ${result.hash}`);
} else {
  console.log(`Breaker reported ${outcome}: ${result.hash}`);
}
```

The decoder returns `'charged'` or `'breached'` from Soroban's singleton vector
containing the symbol `Charged` or `Breached`, not a numeric discriminant. A
breach returns normally so the contract's latch can persist; it is not a
`ContractRejectedError`. Malformed outcomes throw contextual `TypeError`s.
`returnValue` may be the pre-submission simulation fallback when the node omits
its committed return value. Decoding `'charged'` therefore is **not proof of a
committed charge**, nor is it a budget reservation for a later transfer. Couple
enforcement and moving value atomically on-chain when that guarantee is needed.

Every read is a simulation, so it also runs the contract's own checks —
`SimulationRejectedError` means the call was refused, and nothing reached the
ledger. Note that a simulation is charged to the null account with no
authorisations: it answers the questions a contract can answer by reading
(`check`, `grant`, `state`), and a write that needs an admin signature reports a
missing-authorisation error rather than the policy answer you were probing for.

## Signing with a wallet

`keypairSigner` is for scripts and server-side operator keys. Anything else
implements `Signer`, which is an address and a digest:

```ts
import type { Signer } from 'keygate-client';

const signer: Signer = {
  publicKey: 'G…',
  // Any remote ceremony that ends in a 64-byte ed25519 signature over these
  // exact bytes fits: an HSM, a KMS asymmetric key, a signing service, a wallet
  // that exposes raw signing.
  sign: async (digest) => await remote.sign('key-1', digest),
};
```

The interface is digest-based on purpose — the alternative is the SDK shipping a
different adapter per wallet, each of which decays. A wallet that refuses to sign
an arbitrary digest (extension wallets that will sign only a whole transaction, or
only a complete Soroban auth entry, cannot be made to) does not fit here. In that
case build and sign outside this SDK: use `calls.ts` and `abi.ts` to produce the
arguments, hand the envelope to the wallet, and submit the result yourself. The
read helpers and `verifyDecision` work with no signer at all, so the half of the
SDK that is about _knowing_ stays usable either way.

Nothing in this SDK stores a key or takes one in a constructor, so there is no
path by which a key you did not hand it ends up in a transaction.

## Verifying a decision

`keygate-server` answers `POST /v1/decide` with an `x-keygate-signature` header
when `KEYGATE_SIGNING_KEY` is set. `verifyDecision` recomputes the canonical
rendering of the request and the answer together and checks the HMAC. The
walkthrough below is offline and self-contained — the "server" here is
`signDecision` with a fake key — and it is executed, with these exact
constants, by [test/decision-walkthrough.test.ts](./test/decision-walkthrough.test.ts),
so the documentation cannot drift from the code.

```ts
import {
  decisionIsUsable,
  signDecision,
  verifyDecision,
  type Decision,
  type DecisionRequest,
} from 'keygate-client';

// Deliberately fake: this key signs nothing real.
const demoKey = 'demo-only-not-a-real-key';
// Fixed "now", so the numbers below are exact.
const now = 1_800_000_000;

const request: DecisionRequest = {
  holder: 'GBRPYH7SP7VJUA6TSXYUJT4PTG7XVJ5IGGVEFTJLNTJNYHIQBABAHNGD',
  resource: 'vault:main',
  action: 'withdraw',
  amount: 500n,
};
const decision: Decision = {
  allowed: true,
  grantId: 7,
  expiresAt: now + 600,
  budget: { resource: 'vault:main', remaining: '600', requested: '500', windowSeconds: 3_600 },
  evaluatedAt: now,
};

// What the server does when it answers:
const signature = await signDecision(demoKey, request, decision); // 64 lowercase hex chars

// What the caller does with the answer it received:
const genuine = await verifyDecision(demoKey, request, decision, signature); // true
```

### Fail closed

A missing or malformed signature is a refusal, not an error to retry around:
`verifyDecision` returns `false` for an empty header, for `'zz'`, for a
truncated hex string, and for a signature made with a different key. Treat a
missing `x-keygate-signature` header as a refusal, because an unsigned body is
what a downgrade attack looks like:

```ts
const header = response.headers.get('x-keygate-signature');
if (!(await verifyDecision(signingKey, request, decision, header ?? ''))) {
  throw new Error('decision did not come from the keygate service');
}
```

### Validity and usability are two separate checks

The signature proves _who said it and about whom_ — that it cannot be
replayed for another holder or edited in transit — while `decisionIsUsable`
asks whether it is still true. A decision can pass one and fail the other:

```ts
decisionIsUsable(decision, now + 30, 60); // true: fresh, and the grant is live

const stale = { ...decision, evaluatedAt: now - 3_600 };
// verifyDecision is still true for `stale` — the signature is genuine —
decisionIsUsable(stale, now, 60); // false: the evaluation is too old to act on

const expired = { ...decision, expiresAt: now - 1 };
decisionIsUsable(expired, now, 3_600); // false: the capability itself has expired

const denial: Decision = {
  allowed: false,
  reason: 'policy_denied',
  grantId: null,
  evaluatedAt: now,
};
// A denial also carries a signature (so it cannot be forged into an approval),
decisionIsUsable(denial, now, 3_600); // false: a denial is never usable
```

Two limits freshness cannot cover: a correctly signed `true` about a grant
that was revoked after the decision was evaluated is still a revoked grant —
re-check with the chain or the server before moving value — and the `remaining`
figure is headroom _before_ the charge, not a reservation of it.

### Whoever holds the key can forge

The signature is an HMAC with a shared key, so anyone holding
`KEYGATE_SIGNING_KEY` can sign any decision for any holder. That is why the
key must never be embedded in a browser or shipped in a client: verification
belongs server-side, or in a trusted client that received the key out of band.
Keep the key out of logs and error messages as well.

The canonical rendering is a line-for-line copy of the server's, pinned by fixed
vectors in [test/golden.test.ts](./test/golden.test.ts) that were produced by the
server's own signing code.

## What is in the package

| Module        | Job                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`    | the vocabulary — `Triple`, `Call`, `AbiArg`, `Decision` — with no XDR and no SDK types in it                                                       |
| `calls.ts`    | `coreCalls` / `policyCalls` / `breakerCalls` / `multisigCalls`: one pure builder per contract entry point, plus `rawCall` for anything not wrapped |
| `abi.ts`      | `AbiArg` → `xdr.ScVal` and back; the only module that touches XDR                                                                                  |
| `client.ts`   | `KeygateClient`: simulate → authorize → rebuild → submit → commit, plus typed reads (below)                                                        |
| `host.ts`     | `LedgerHost`, the four-method network surface, and `sorobanRpcHost` / `connect`                                                                    |
| `signer.ts`   | `Signer`, `keypairSigner`, `authorizationSigner`, decorated signatures                                                                             |
| `errors.ts`   | the error classes and the contract's `#[contracterror]` codes, per role                                                                            |
| `decision.ts` | canonical decision rendering, HMAC sign/verify, freshness                                                                                          |

Reads — all simulations, so they need no signer and cost nothing:

| Method                                          | Reads                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `hasAccess(triple, holder)`                     | `core.check` — whether the holder may act now                           |
| `grant(triple, holder)`                         | `core.grant` — the grant, or `null` when there is none                  |
| `paused()`                                      | `core.paused`                                                           |
| `rule(triple)`                                  | `policy.rule` — the rule, or `null` when there is none                  |
| `defaultEffect()`                               | `policy.default_effect`                                                 |
| `breakerState(resource)`                        | `breaker.state` — the persisted state: window start, amount used, latch |
| `breakerConfig(resource)`                       | `breaker.config` — the limit and window, or `null` when unconfigured    |
| `breakerRemaining(resource)`                    | `breaker.remaining` — the effective headroom in the current window      |
| `breakerIsTripped(resource)`                    | `breaker.is_tripped`                                                    |
| `breakerResources()`                            | `breaker.resources` — every configured resource                         |
| `proposal(id)`                                  | `multisig.proposal` — the proposal, or `null` when the id is unknown    |
| `pendingProposals()`                            | `multisig.live_ids`                                                     |
| `approvals(id)`                                 | `multisig.approvals`                                                    |
| `owners()` / `threshold()` / `isOwner(address)` | the multisig's owner set, quorum, and one membership check              |

`breakerRemaining` and `breakerState` answer different questions: `remaining`
rolls the window forward the way `enforce` does without persisting it, so a
window that has already expired reads as the full limit again and a tripped
resource reads as `0`; `breakerState` is the persisted state as last recorded.
An unconfigured resource is refused on-chain (`NotConfigured`), which surfaces
as `SimulationRejectedError` from `breakerRemaining` rather than `null` or `0`.

Function names are the Rust identifiers (`require_access`, `set_rule`,
`default_effect`), because that is what Soroban exports — the builders are thin on
purpose. `grant()` returns `null` for an absent capability, `breakerState()`
likewise, and `paused()` returns a boolean: the decoders say what the contract
said rather than guessing on its behalf.

## Errors

Every failure is a `KeygateError`, so one `catch` covers the SDK:

| class                     | when                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SimulationRejectedError` | the node refused to run the call — the contract said no, or the args do not typecheck on-chain. Carries `code` when the host reported one. |
| `SubmitFailedError`       | the network rejected the submission (`try_again_later`, `error`), with the raw `errorResult` as base64 in `detail`.                        |
| `TransactionFailedError`  | it committed and then failed. The simulation passed, so this is a race: re-send.                                                           |
| `CommitTimeoutError`      | no commit status before the deadline. Genuinely unknown — `hash` is in the error so you can look again instead of double-spending.         |
| `ConfigurationError`      | the client cannot work as constructed: no signer for a write, a missing `multisig` address, a contract asking someone else to authorise.   |
| `ContractRejectedError`   | exported for a caller holding a raw code from somewhere else; the SDK itself reports refusals through `SimulationRejectedError`.           |

`errorNameFor(role, code)` names a discriminant (`core` code `3` is `Paused`,
`breaker` code `3` is `NotConfigured` — the same number means different things in
different contracts, which is why every error carries its role). A code missing
from the table comes back as `UnknownError(n)` rather than a wrong name.

## Design notes

- **`LedgerHost` is not `rpc.Server`.** The SDK's response shapes are unions of
  parsed XDR and half-optional fields — right for a node, terrible for a test to
  construct. The conversion happens once, in `sorobanRpcHost`; above it everything
  sees plain objects. A private indexer, a state-sync service, or a fixture
  implements four methods and reuses the rest.
- **Arguments are a tagged union, not `nativeToScVal` passthrough.**
  `nativeToScVal('G…')` produces an `scvString`, not an address, and the contract
  rejects it at the host layer. Forcing every argument through a `kind` tag turns
  that class of mistake into a type error instead of a simulation failure.
- **Return values are decoded field by field.** `scValToNative` is convenient but
  throws on a `Vec<Val>` it cannot type and turns a missing field into
  `undefined`; the decoders here name the context and the type they expected.
- **Unions are read through `switch().name` and `value()`.** js-xdr defines one
  setter per switch value and one getter per arm, and where the names differ the
  obvious accessor is the setter: `body.invokeHostFunction()` silently returns
  `undefined`. This is a trap worth knowing before you add a decoder.
- **Authorisation expiry is short** (`authLedgerWindow`, default 10 ledgers) and
  the client refuses to sign an authorisation addressed to someone other than its
  own signer. The SDK's `authorizeEntry` will happily sign any entry with whatever
  key you give it; checking first is this layer's job.
- **No time bounds.** Transactions use `setTimeout(0)`; the authorisation expiry is
  the deadline that actually applies to a Soroban call.

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint          # eslint, type-aware
corepack pnpm format:check  # prettier
corepack pnpm typecheck     # tsc --noEmit, strict
corepack pnpm test          # vitest
corepack pnpm check         # all four
corepack pnpm build         # dist/ (ESM + .d.ts)
```

One hundred and twenty-four tests, none of which touch a network: the transaction
path runs against a `FakeHost` that records the submitted envelope and decodes it,
so sequence reuse, fee composition, footprint attachment, auth signing and every
failure branch are asserted on real XDR rather than mocks of it. Coverage
thresholds (80% lines and functions, 75% branches) are enforced by
`vitest.config.ts`.

## How this repository relates to the other two

| In this repository                          | Mirrors                                                                                                | Notes                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `CONTRACT_ERRORS` in `errors.ts`            | `#[contracterror]` enums in [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts) | keyed by role; change both together                                    |
| builders in `calls.ts`                      | the contracts' public functions                                                                        | one builder per entry point                                            |
| `canonicalDecision` in `decision.ts`        | `keygate-server/src/http/signing.ts`                                                                   | byte-identical, pinned by `test/golden.test.ts`                        |
| `Decision`, `DecisionRequest` in `types.ts` | `/v1/decide`'s body, and `DenialReason`                                                                | `reason` is `string` here so an older client still parses a new reason |

## Status and scope

Version 0.1.0, **unaudited**, and deliberately narrow: it drives the four keygate
contracts and verifies decisions. It does not do account funding, friendbot,
time-bound transactions, fee bumping, multicall batching, or reading contracts
other than keygate's — `rawCall` exists so you can reach a keygate function this
module has not wrapped yet, not as a general-purpose contract caller.

Read [SECURITY.md](./SECURITY.md) for what the client assumes about the node you
point it at, and [CONTRIBUTING.md](./CONTRIBUTING.md) before changing an encoder.

## Documentation

- [examples/README.md](./examples/README.md) — issue a capability on Stellar testnet, read it back, revoke it
- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, style, the cross-repo tables
- [SECURITY.md](./SECURITY.md) — reporting and the trust boundaries of an SDK
- [SUPPORT.md](./SUPPORT.md) — where to ask questions
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
