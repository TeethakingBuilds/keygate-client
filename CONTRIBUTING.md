# Contributing to keygate-client

## Setup

Node 20+ and pnpm. `packageManager` is pinned and `preinstall` refuses any other
package manager, so:

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check          # lint + format:check + typecheck + test
corepack pnpm build          # dist/ — ESM plus .d.ts
```

There is nothing to run: this is a library. `corepack pnpm test` is the loop, and
no test needs a node, an RPC endpoint or a funded account.

## Where the code lives

```
src/types.ts     the vocabulary. No XDR, no SDK types — this file is why a test can build a Call
src/calls.ts     one pure builder per contract entry point
src/abi.ts       AbiArg → ScVal, ScVal → decoded value. The only XDR in the SDK besides client.ts
src/host.ts      LedgerHost (four methods) + the RPC mappers + connect()
src/signer.ts    Signer, keypairSigner, authorizationSigner, decorated signatures
src/client.ts    the transaction path: simulate → authorize → rebuild → submit → commit
src/errors.ts    error classes and the per-role contract error tables
src/decision.ts  canonical decision rendering and HMAC verify (WebCrypto)
```

The dependency direction is the design: `types.ts` imports nothing, `abi.ts`
imports `types.ts`, and `client.ts` is the only module that knows about both XDR
and the host. A new capability should slot into exactly one of those layers.

## How this repository relates to the other two

| In this repository                       | Mirrored in                                                                                            | As                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `CONTRACT_ERRORS` in `src/errors.ts`     | `#[contracterror]` enums in [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts) | per role; code `3` is `Paused` in the registry and `NotConfigured` in the breaker |
| builders in `src/calls.ts`               | the contracts' public functions                                                                        | name and argument order, in Rust identifier form                                  |
| `canonicalDecision` in `src/decision.ts` | `keygate-server/src/http/signing.ts`                                                                   | byte-identical, pinned by vectors in `test/golden.test.ts`                        |
| `EFFECT_DISCRIMINANT` in `src/types.ts`  | the `Effect` enum in `keygate-policy`                                                                  | `allow` is `0`, `deny` is `1` — reorder there and every rule inverts              |

A code missing from `CONTRACT_ERRORS` still reaches the caller as
`UnknownError(n)`, so forgetting one is a naming bug. A field missing from a
decoder is not that forgiving: it throws with the context string it was given,
which is why every decoder takes one.

## Code style

Prettier and type-aware ESLint decide the mechanical parts. The rules that exist
because of how this SDK got written:

- **Never `nativeToScVal` on a caller's value.** Arguments go through `AbiArg`,
  whose `kind` tag is what makes `nativeToScVal('G…')` (which produces an
  `scvString`, not an address) impossible to write by accident. If the contract
  takes a type with no tag yet, add the tag — do not add an `any`.
- **Never `scValToNative` on a whole struct.** Read map fields one at a time with
  the `as*` helpers so a missing field or an unexpected tag names itself in an
  error instead of becoming `undefined` downstream.
- **Read unions through `switch().name` and `value()`.** js-xdr defines one setter
  per switch value and one getter per arm name, and where the two differ the
  obvious accessor is the setter: `body.invokeHostFunction()` returns `undefined`,
  `body.value()` returns the operation. `SorobanCredentials.address()` is `undefined`
  on the source-account arm rather than a throw. This has cost every test file
  here a debugging cycle; see the comment in `src/abi.ts`.
- **Amounts are `bigint`, addresses are `string`.** A JS number above `2^53` is
  silently wrong for an `i128`, and a `Strkey` object in a public signature would
  drag the SDK into every caller's types.
- **Nothing may hold a key.** `signer.ts` takes a `Signer`; if a change needs the
  private key itself, that is the wrong change.
- **`decision.ts` is a copy with a duty.** `canonicalDecision` must render the same
  bytes as the server's. Change it there and here in the same release, and add the
  new vector to `test/golden.test.ts` — the file is the only thing standing between
  a quiet whitespace edit and a fleet of callers that reject every decision.

## Tests

One hundred and twenty-four tests in `test/`, all offline. Two patterns worth
copying:

- **The host is a fake, the assertions are on real XDR.** `FakeHost` implements
  `LedgerHost`, records the transactions it is handed, and tests decode the
  submitted envelope (`invoked(tx)` in `test/client.test.ts`) to assert the
  function, args, auth, footprint and fee that actually went out. That is what
  makes sequence reuse and fee composition testable without a node.
- **Cross-repo vectors.** `test/golden.test.ts` holds signatures produced by the
  server's own code. If you change the canonical rendering, those are the failures
  to fix first — and they need a matching change in `keygate-server`.

New encoders and decoders should test the boundary and the refusal: a value that
just fits, a value that does not, and the message a wrong tag produces. Coverage
thresholds (80% lines and functions, 75% branches) are enforced by
`vitest.config.ts`.

## Pull requests

- One behaviour per pull request, with a test that fails without it.
- `corepack pnpm check` green before you push; CI runs the same commands.
- If you changed a builder, an error table, a decoder, or the canonical string,
  link the matching change in `keygate-contracts` or `keygate-server`.
- Public API changes are the expensive kind: this package's exports are what an
  integrator's code compiles against. Say why in the description.
- By contributing you confirm you may license the change under Apache-2.0, and
  this project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Releasing

Publishing is a tag push, not a manual `npm publish`. `.github/workflows/release.yml`
runs on any `v*` tag and does the whole release: install from the lockfile,
`pnpm check`, `pnpm build`, a `--dry-run` look at the tarball's contents, publish
with `--provenance`, then a GitHub release with generated notes.

1. Bump `version` in `package.json` in a normal pull request and let CI go green.
2. Rehearse it if you want a log before tagging: Actions → **Release** →
   _Run workflow_, with `tag` set to the tag you intend to push. A manual run
   executes every step except the upload and the release, which are gated on
   `github.event_name == 'push'` — a branch cannot publish, and both the matching
   and mismatching tag cases can be checked this way.
3. Merge it, then tag the merge commit: `git tag v0.1.0 && git push origin v0.1.0`.
4. Watch the Release workflow. The tag **must** equal `v` + the `package.json`
   version; a mismatch fails the job before `check` and `build` run, so a typo
   costs a minute rather than a bad publish. Re-tag rather than editing a pushed
   tag in place.

Authentication is one of two setups, owned by a maintainer and never committed:

- **Token:** add a granular npm token with publish rights as the repository
  secret `NPM_TOKEN`. The workflow passes it to npm as `NODE_AUTH_TOKEN`.
- **Trusted publishing:** configure this repository and workflow in the package's
  npm settings and leave `NPM_TOKEN` unset. `id-token: write` (already in the
  workflow) lets npm mint an OIDC token instead.

Either way `--provenance` attaches a signed link between the tarball and this
commit, which is why the publish job asks for `id-token: write`. Both jobs run
with `contents: read`; only the separate release job gets `contents: write`, so
the step that uploads to npm never holds write access to the repository.

Two things that will otherwise fail at the last step:

- Node 20 bundles npm 10, and npm's OIDC publishing needs npm 11.5.1 or later. The
  workflow therefore upgrades npm before publishing; the `NPM_TOKEN` path would
  work either way.
- Provenance is rejected by the registry (E422) unless `repository.url` in
  `package.json` names the repository running the workflow. It does
  (`TeethakingBuilds/keygate-client`), so releases must run there, not from a fork;
  a fork needs its own package name and its own publish setup.

A version that has already been published cannot be reused: npm rejects the
upload, and the fix is a new version and a new tag. The package is unscoped
(`keygate-client`); if a name change is ever needed, agree on the scoped name in
an issue first, then change `name` in `package.json` and the install line in
[README.md](./README.md) together.

## What this project will not add

Account funding and friendbot, time bounds, fee bumping, transaction batching, a
general-purpose contract caller, or a wallet adapter per extension. `rawCall`
covers a keygate function the builders have not caught up with; it is not a
surface for driving arbitrary contracts through this SDK, and a pull request that
treats it as one will be declined. Browser wallet support is a documented
limitation rather than a roadmap item — see the `Signer` note in
[README.md](./README.md#signing-with-a-wallet).
