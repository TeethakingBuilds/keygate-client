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
