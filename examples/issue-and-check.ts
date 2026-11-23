/**
 * Issue a capability on Stellar testnet, read it back, then revoke it.
 *
 * This is the fastest way to learn the SDK against a real ledger. It imports
 * the source directly because it lives in this repository; an installed
 * consumer imports the same names from `'keygate-client'` instead (see the
 * quick start in the main README).
 *
 * Setup:
 *
 *   1. Deploy `keygate-core` to testnet and initialize it with an admin key:
 *      https://github.com/TeethakingBuilds/keygate-contracts#deploying
 *   2. Fund that admin account once, with Friendbot:
 *      https://friendbot.stellar.org/
 *   3. Run it:
 *
 *      KEYGATE_RPC_URL=https://soroban-testnet.stellar.org \
 *      KEYGATE_CORE_CONTRACT=C… \
 *      KEYGATE_ADMIN_SECRET=S… \
 *      pnpm example:testnet
 *
 * The admin secret is read from the environment only. Never commit one, and
 * never paste a mainnet key here — this script is for testnet.
 */

/* eslint-disable no-console -- an example script's job is to print its results. */
import { Keypair } from '@stellar/stellar-sdk';

import { KeygateClient, connect, coreCalls, keypairSigner } from '../src/index.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `set ${name} before running this example (see examples/README.md for how to get one)`,
    );
  }
  return value;
}

const rpcUrl = required('KEYGATE_RPC_URL');
const core = required('KEYGATE_CORE_CONTRACT');
const admin = Keypair.fromSecret(required('KEYGATE_ADMIN_SECRET'));
// A fresh holder every run, so the example never depends on earlier state.
const holder = Keypair.random();

const client = new KeygateClient({
  host: connect(rpcUrl),
  contracts: { core },
  networkPassphrase: 'Test SDF Network ; September 2015',
  signer: keypairSigner(admin),
});

const triple = { resource: 'vault:main', action: 'withdraw' };

const issued = await client.send(coreCalls.issue(triple, holder.publicKey(), 3_600));
console.log(`issued grant to ${holder.publicKey()} in ledger ${issued.ledger} (${issued.hash})`);

const allowed = await client.hasAccess(triple, holder.publicKey());
console.log(`hasAccess: ${allowed}`);
const grant = await client.grant(triple, holder.publicKey());
console.log('grant:', grant);

const revoked = await client.send(coreCalls.revoke(triple, holder.publicKey()));
console.log(`revoked in ledger ${revoked.ledger} (${revoked.hash})`);

const allowedAfter = await client.hasAccess(triple, holder.publicKey());
console.log(`hasAccess after revoke: ${allowedAfter}`);
if (allowedAfter) {
  throw new Error('revoke did not take effect: hasAccess is still true');
}
console.log('done: issue → check → revoke all behaved as expected');
