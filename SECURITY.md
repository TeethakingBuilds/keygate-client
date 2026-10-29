# Security policy

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository. The advisory is
private: it is visible only to the reporter and the maintainer. Do not open a
public issue, and do not file a pull request that shows the exploit.

Expect an acknowledgement within a week. If a fix is possible, one ships before
the advisory becomes public, and the release notes credit the reporter unless
they ask not to be.

## Supported versions

| Version        | Supported                |
| -------------- | ------------------------ |
| 0.1.x          | yes                      |
| anything older | no — update, and rebuild |

This SDK is unaudited, and so are the
[contracts](https://github.com/TeethakingBuilds/keygate-contracts) it drives and
the [decision service](https://github.com/TeethakingBuilds/keygate-server) it
verifies. A bug in either of those is a bug in whatever this library concludes
from them; read their security pages too.

## What this library is trusted with

`send()` builds a transaction, signs it, and signs whatever authorisations the
node asks for. So the questions are: what can a caller of this SDK be tricked
into, and what can the infrastructure around it be tricked into?

1. **You are handing it a signer.** The SDK never stores a key and takes one only
   as a `Signer`, but it does call `sign()` on digests chosen during the send
   path — the transaction's `signatureBase()`, and the preimage hash of each
   authorisation entry. This is ordinary for an SDK and it is still the sharpest
   edge here: give a `keypairSigner` for an admin key to a process that also
   fetches and runs other people's code, and that code can spend the admin.
2. **The authorisation entries come from the node, and only partially checked.**
   `signAuthorizations` verifies that an entry asks the _right address_ to
   authorise — it refuses to sign for anyone other than its own signer, which is
   the check the underlying `authorizeEntry` does not perform. It does not verify
   that the entry's `rootInvocation` is the call you built. A hostile or
   compromised RPC can therefore obtain a signature authorising a different
   contract call, valid for `authLedgerWindow` ledgers (default 10) and bound to
   the network passphrase. If you cannot trust the endpoint, run your own;
   `connect(url)` accepting `allowHttp` is for a local node, and the default is
   refusal.
3. **The simulation result shapes the transaction.** Footprint, required auth and
   `minResourceFee` all come back from `simulateTransaction`. An RPC can inflate
   the fee, return a footprint that makes the call fail, or answer `not_found` to
   `getTransaction` forever. None of that mints an unauthorised grant, which is
   why the design accepts it — but it does mean "the client is honest" is not the
   same as "the pipeline is".
4. **A decision signature is a shared secret, and verification is optional.**
   `verifyDecision` proves a decision came from a holder of `KEYGATE_SIGNING_KEY`
   and was not edited in transit. Anyone with that key can forge decisions for any
   holder, and there is no rotation here. Equally: a caller that skips verification
   — or calls `decisionIsUsable` without verifying — is trusting whatever its proxy
   returned. Treat a missing `x-keygate-signature` header as a refusal, because an
   unsigned body is what a downgrade attack looks like.
5. **Decoders fail loudly, but they can be wrong quietly in one place.** Every
   `as*` helper throws on an unexpected tag, which is the safe direction. The
   exception is a contract upgrade that changes what a _valid-looking_ tag means:
   `EFFECT_DISCRIMINANT` says `allow` is `0`, and if `keygate-policy` ever reorders
   its `Effect` enum, `effectFromDiscriminant` inverts every rule with no type
   error and no thrown exception. That table is a wire format.
6. **`codeFromHostError` parses someone else's error string.** It looks for
   `Error(Contract, #n)` in prose the Soroban host emits. If that format changes,
   the result is `code: undefined` and the raw text in `detail` — a lost matching
   convenience, not a wrong allow. It is listed here because string-parsing a
   dependency is a coupling that should be visible.

## What is in scope

- This SDK signing an authorisation for an address other than its signer's.
- `verifyDecision` accepting a signature for a request other than the one passed
  in, in either direction (wrong amount, wrong holder, wrong reason).
- A decoder returning an allow-shaped value for a ScVal the contract did not
  return — `asBool` on a map, `asOption` reading a present value as absent.
- A builder producing arguments that encode to the wrong Soroban type in a way
  that lets a call succeed where the contract meant to refuse it.
- Key material written to a log, an error message, or a returned structure.
- Anything that lets a transaction be submitted twice for one `send()` call
  without the caller knowing (see `CommitTimeoutError`, which exists precisely to
  _not_ guess).

## What is out of scope

- A hostile RPC doing hostile RPC things: fee inflation, withheld transactions,
  fabricated simulation errors. Item 3 above; the mitigation is an endpoint you run.
- A compromised or careless holder of `KEYGATE_SIGNING_KEY`.
- Bugs in `@stellar/stellar-sdk`, in Soroban, or in the keygate contracts.
- Wallet UX: this library cannot stop a caller from signing a digest it should not
  have been asked to sign, any more than `stellar-sdk` can.
- Versions older than the table.

## Threat model in one paragraph

This SDK is the layer where on-chain intent is turned into signatures, and the
assumption it makes is that the contracts are the authority and the node is a
messenger. Everything a caller learns about capability state comes back through
simulation, so a lying node can mislead but cannot authorise: the contract checks
`require_access` against its own storage when the transaction executes, and the
off-chain mirror in `keygate-server` is reconstructible from public events. What
the SDK _can_ cause is a signature that should not exist — hence the holder check
before any authorisation is signed, the refusal to guess on a timed-out commit,
and a decision verification path that returns `false` for every failure mode
rather than distinguishing them for an attacker's benefit.
