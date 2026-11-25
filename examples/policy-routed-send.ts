/**
 * Send 1 USDC through `keygate-payments` with the payer's policy enforced
 * on-chain, then read the receipt and the usage back.
 *
 * This is the policy-routed counterpart to the direct SAC path: the allowlist,
 * daily and monthly limits, approval threshold and intent deadline are all
 * enforced by the contract in the same call as the transfer. A payment the
 * policy refuses never reaches the ledger — the script proves that first with
 * an over-limit attempt that the simulation rejects.
 *
 * Setup:
 *
 *   1. Use the deployed v0.1.0 testnet contracts (see the contracts repo
 *      README for the current IDs), or deploy your own set.
 *   2. The payer needs testnet XLM (Friendbot: https://friendbot.stellar.org/)
 *      and testnet USDC with a trustline (Circle faucet:
 *      https://faucet.circle.com — Stellar Testnet, USDC), plus a spending
 *      policy set on the payments contract. The recipient needs a USDC
 *      trustline too.
 *   3. Run it:
 *
 *      KEYGATE_RPC_URL=https://soroban-testnet.stellar.org \
 *      KEYGATE_CORE_CONTRACT=C… \
 *      KEYGATE_PAYMENTS_CONTRACT=C… \
 *      KEYGATE_PAYER_SECRET=S… \
 *      KEYGATE_RECIPIENT=G… \
 *      pnpm example:policy-send
 *
 * The payer secret is read from the environment only. Never commit one, and
 * never paste a mainnet key here — this script is for testnet.
 */

/* eslint-disable no-console -- an example script's job is to print its results. */
import { Keypair } from '@stellar/stellar-sdk';

import {
  KeygateClient,
  connect,
  errorNameFor,
  keypairSigner,
  newPaymentReference,
  SimulationRejectedError,
} from '../src/index.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `set ${name} before running this example (see examples/README.md for how to get one)`,
    );
  }
  return value;
}

/** One USDC, in stroops. */
const ONE_USDC = 10_000_000n;

const rpcUrl = required('KEYGATE_RPC_URL');
const core = required('KEYGATE_CORE_CONTRACT');
const payments = required('KEYGATE_PAYMENTS_CONTRACT');
const payer = Keypair.fromSecret(required('KEYGATE_PAYER_SECRET'));
const recipient = required('KEYGATE_RECIPIENT');

const client = new KeygateClient({
  host: connect(rpcUrl),
  contracts: { core, payments },
  networkPassphrase: 'Test SDF Network ; September 2015',
  signer: keypairSigner(payer),
});

const policy = await client.paymentPolicy(payer.publicKey());
if (policy === null) {
  throw new Error(
    `no spending policy is set for ${payer.publicKey()} on ${payments} — set one first (see the contracts repo TESTNET.md)`,
  );
}
console.log(
  `policy: daily ${policy.dailyLimit} / monthly ${policy.monthlyLimit} stroops, ` +
    `approval above ${policy.approvalAbove}, threshold ${policy.approvalThreshold}, ` +
    `allowlist only: ${policy.allowlistOnly}`,
);

const allowed = await client.paymentIsAllowed(payer.publicKey(), recipient);
console.log(`recipient allowed: ${allowed}`);
if (!allowed) {
  throw new Error(`policy does not allow ${payer.publicKey()} to pay ${recipient}`);
}

const remaining = await client.paymentRemaining(payer.publicKey());
console.log(`remaining: daily ${remaining.daily} / monthly ${remaining.monthly} stroops`);

// The over-limit attempt: the simulation refuses it, so nothing reaches the
// ledger. This is the policy working — the refusal is the expected outcome.
const overLimit = remaining.daily + 1_000_000n;
try {
  await client.payPolicy({ from: payer.publicKey(), to: recipient, amount: overLimit });
  throw new Error(
    `over-limit payment of ${overLimit} stroops was accepted — the policy did not refuse it`,
  );
} catch (error) {
  if (!(error instanceof SimulationRejectedError)) {
    throw error;
  }
  const name = error.code === undefined ? 'unknown code' : errorNameFor('payments', error.code);
  console.log(`over-limit payment refused as expected: ${name} (code ${error.code})`);
}

const usageBefore = await client.paymentUsage(payer.publicKey());
const reference = newPaymentReference();
const sent = await client.payPolicy({
  from: payer.publicKey(),
  to: recipient,
  amount: ONE_USDC,
  reference,
});
console.log(`paid 1 USDC to ${recipient} in ledger ${sent.ledger} (${sent.hash})`);

const receipt = await client.paymentReceipt(payer.publicKey(), reference);
if (receipt === null) {
  throw new Error('payment landed but no receipt is stored for its reference');
}
console.log(
  `receipt: ${receipt.amount} stroops from ${receipt.from} to ${receipt.to} at ${receipt.timestamp}`,
);
if (receipt.amount !== ONE_USDC || receipt.to !== recipient) {
  throw new Error('receipt does not match the payment that was sent');
}

const usageAfter = await client.paymentUsage(payer.publicKey());
console.log(
  `usage: day ${usageBefore.dayUsed} → ${usageAfter.dayUsed}, ` +
    `month ${usageBefore.monthUsed} → ${usageAfter.monthUsed}`,
);
if (usageAfter.dayUsed - usageBefore.dayUsed !== ONE_USDC) {
  throw new Error('policy usage did not increase by the amount paid');
}
console.log('done: policy check → refusal → payment → receipt → usage all behaved as expected');
