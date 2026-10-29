/**
 * Verifying a decision without trusting the transport it arrived on.
 *
 * A caller usually sits behind a TLS terminator, a CDN or a sidecar proxy, so
 * "this came from the decision service" is not a property of the connection.
 * `keygate-server` answers with an `x-keygate-signature` header: an HMAC-SHA-256
 * over a canonical rendering of the request *and* the answer together. Verifying
 * it here proves two things a proxy cannot fake — that the decision was issued
 * for this holder, and that nobody edited the amount or the expiry on the way
 * past them.
 *
 * The rendering below is a line-for-line copy of `canonicalDecision` in
 * `keygate-server/src/http/signing.ts`. `test/golden.test.ts` pins them together
 * with a vector produced by the server's own `signDecision`, so the two repos
 * cannot drift apart quietly.
 */
import { ConfigurationError } from './errors.js';
import type { Decision, DecisionRequest } from './types.js';

const VERSION = 'keygate-decision-v1';
const encoder = new TextEncoder();

function field(name: string, value: string | number | null | undefined): string {
  return `${name}=${value ?? 'null'}`;
}

/** The exact bytes that get signed. Exported so a caller can inspect them. */
export function canonicalDecision(request: DecisionRequest, decision: Decision): string {
  const amount = request.amount === undefined ? null : request.amount.toString();
  const parts = [
    VERSION,
    field('holder', request.holder),
    field('resource', request.resource),
    field('action', request.action),
    field('amount', amount),
    field('allowed', decision.allowed ? 'true' : 'false'),
    field('reason', decision.allowed ? null : decision.reason),
    field('grantId', decision.grantId),
    field('evaluatedAt', decision.evaluatedAt),
    field('expiresAt', decision.allowed ? decision.expiresAt : null),
  ];

  if (decision.allowed && decision.budget !== null) {
    parts.push(field('budgetResource', decision.budget.resource));
    parts.push(field('remaining', decision.budget.remaining));
    parts.push(field('requested', decision.budget.requested));
    parts.push(field('windowSeconds', decision.budget.windowSeconds));
  }

  // Length-prefix every field: a resource ending in "action=x" would otherwise
  // be able to imitate a different (resource, action) pair.
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function subtle(): SubtleCrypto {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.subtle === undefined) {
    throw new ConfigurationError(
      'no WebCrypto available; this runtime cannot verify decision signatures (Node >= 20 and every browser can)',
    );
  }
  return webCrypto.subtle;
}

async function hmacKey(signingKey: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return await subtle().importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[\da-f]{64}$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(32));
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Produces the header value the server would have produced. Needs the shared key. */
export async function signDecision(
  signingKey: string,
  request: DecisionRequest,
  decision: Decision,
): Promise<string> {
  const signature = await subtle().sign(
    'HMAC',
    await hmacKey(signingKey, 'sign'),
    encoder.encode(canonicalDecision(request, decision)),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Checks a signature. `false` covers every failure, including a malformed
 * signature, because a caller that treats those differently is telling an
 * attacker something about the key.
 */
export async function verifyDecision(
  signingKey: string,
  request: DecisionRequest,
  decision: Decision,
  signature: string,
): Promise<boolean> {
  const provided = hexToBytes(signature);
  if (provided === null) {
    return false;
  }
  // `verify` compares the MAC itself, so no hand-rolled constant-time check.
  return await subtle().verify(
    'HMAC',
    await hmacKey(signingKey, 'verify'),
    provided,
    encoder.encode(canonicalDecision(request, decision)),
  );
}

/**
 * A decision is only worth acting on while it is fresh.
 *
 * `evaluatedAt` is the server's clock over its mirror, so a stale answer can
 * still be correctly signed — the signature proves who said it, not that it is
 * still true.
 */
export function decisionIsUsable(decision: Decision, now: number, maxAgeSeconds: number): boolean {
  if (now - decision.evaluatedAt > maxAgeSeconds) {
    return false;
  }
  return decision.allowed ? decision.expiresAt > now : false;
}
