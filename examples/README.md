# Examples

## issue-and-check.ts — issue a capability on testnet, read it back, revoke it

The fastest way to learn the SDK against a real ledger. It issues a
`vault:main` / `withdraw` capability to a freshly generated holder, reads it
back with `hasAccess` and `grant`, revokes it, and shows `hasAccess` is now
`false`.

### Setup

1. **Deploy `keygate-core` to testnet** and initialize it with an admin key.
   Follow the deploy section of the contracts repository:
   https://github.com/TeethakingBuilds/keygate-contracts#deploying
2. **Fund the admin account once**, with Friendbot:
   https://friendbot.stellar.org/
   Paste the admin's `G…` address there. The holder in this example is
   generated fresh on every run and needs no funding — it never submits
   anything.
3. **Run it** (from the repository root):

   ```bash
   KEYGATE_RPC_URL=https://soroban-testnet.stellar.org \
   KEYGATE_CORE_CONTRACT=C… \
   KEYGATE_ADMIN_SECRET=S… \
   pnpm example:testnet
   ```

   Or, without the script: `npx tsx examples/issue-and-check.ts` with the same
   variables set.

### Environment variables

| Variable                | What it is                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| `KEYGATE_RPC_URL`       | A Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`         |
| `KEYGATE_CORE_CONTRACT` | The `C…` address of a deployed, initialized `keygate-core` on that network |
| `KEYGATE_ADMIN_SECRET`  | The `S…` secret of the account the core was initialized with               |

All three are required; the script fails with a clear message when one is
missing. Funding accounts and deploying contracts are out of scope for the
SDK — see the links above instead of reimplementing them here.

**Never commit a secret key.** The admin secret comes from the environment
only, and this script is for testnet. Never paste a mainnet key here.

## policy-routed-send.ts — send 1 USDC through the policy contract on testnet

The policy-routed counterpart to the direct SAC path. It reads the payer's
spending policy, checks the recipient is allowed and the headroom is enough,
proves the policy refuses an over-limit payment (the simulation rejects it, so
nothing reaches the ledger), then sends 1 USDC and reads the on-chain receipt
and usage back.

### Setup

1. **Use the deployed v0.1.0 testnet contracts** (IDs in the contracts
   repository README), or deploy your own set and set a spending policy on the
   payments contract.
2. **Fund the payer** with testnet XLM (Friendbot:
   https://friendbot.stellar.org/) and testnet USDC with a trustline (Circle
   faucet: https://faucet.circle.com — Stellar Testnet, USDC). The recipient
   needs a USDC trustline too.
3. **Run it** (from the repository root):

   ```bash
   KEYGATE_RPC_URL=https://soroban-testnet.stellar.org \
   KEYGATE_CORE_CONTRACT=C… \
   KEYGATE_PAYMENTS_CONTRACT=C… \
   KEYGATE_PAYER_SECRET=S… \
   KEYGATE_RECIPIENT=G… \
   pnpm example:policy-send
   ```

   Or, without the script: `npx tsx examples/policy-routed-send.ts` with the
   same variables set.

### Environment variables

| Variable                    | What it is                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| `KEYGATE_RPC_URL`           | A Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`                |
| `KEYGATE_CORE_CONTRACT`     | The `C…` address of a deployed, initialized `keygate-core` on that network        |
| `KEYGATE_PAYMENTS_CONTRACT` | The `C…` address of a deployed `keygate-payments` with a policy set for the payer |
| `KEYGATE_PAYER_SECRET`      | The `S…` secret of the paying account                                             |
| `KEYGATE_RECIPIENT`         | The `G…` address receiving the payment                                            |

All five are required; the script fails with a clear message when one is
missing. The payer must have a policy set and enough daily/monthly headroom
for 1 USDC, or the script stops before sending.

**Never commit a secret key.** The payer secret comes from the environment
only, and this script is for testnet. Never paste a mainnet key here.

One honest limit: an above-threshold payment needs its approvers' signatures,
and this client signs only for its own signer — see `payPolicy` in the main
README.
