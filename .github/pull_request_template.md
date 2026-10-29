## What this changes

One behaviour. Describe the outcome, not the diff.

## Signing

Anything that touches `signer.ts` or the send path gets read twice, because the
blast radius is a key signing something it should not have:

- [ ] No new digest is signed that the caller did not ask for
- [ ] The check that an authorisation names this client's own signer still runs
- [ ] No key material reaches a log, an error message, or a returned value

## Does it move the wire format?

Check every box that applies, and link the matching change in the other repository:

- [ ] No `CONTRACT_ERRORS` entry added, removed, or renumbered → the `#[contracterror]` enum in [keygate-contracts](https://github.com/TeethakingBuilds/keygate-contracts)
- [ ] No builder changed (function name, argument order, argument type) → the contract's public function
- [ ] `canonicalDecision` untouched → if it moved, [keygate-server/src/http/signing.ts](https://github.com/TeethakingBuilds/keygate-server/blob/main/src/http/signing.ts) changed with it and `test/golden.test.ts` has a vector from the server's own code
- [ ] `EFFECT_DISCRIMINANT` untouched (`allow` is `0`, `deny` is `1`, matching `keygate-policy`)
- [ ] Any new export appears in the built package (CI imports `dist/index.js` and checks)

## Tests

- [ ] There is a test that fails without this change
- [ ] A new or changed decoder is tested on the wrong tag as well as the right one
- [ ] A new host interaction is asserted on the submitted envelope, not on a mock's call count
- [ ] No test touches the network

`corepack pnpm check` runs lint, format, typecheck and the suite — the same things
CI does, plus the build and export-surface check.

## Notes for the reviewer

Anything the diff does not show: a design you chose over the alternative that
looks simpler, a case you deliberately did not handle, or a place where this SDK
and the server's copy of the signing code now differ on purpose.
