/**
 * Signing, without assuming where the key lives.
 *
 * A `Signer` is the smallest thing the SDK needs: an address plus "sign this
 * 32-byte digest". That keeps an HSM, a remote signing service and a `Keypair` on
 * the same path — and it means this module never imports a secret key type.
 *
 * The cost of the small interface is that a signer which refuses to sign an
 * arbitrary digest (an extension wallet that will sign only a whole transaction,
 * or only a complete auth entry) cannot be adapted here; the caller then builds
 * the transaction with `calls.ts` and `abi.ts` and signs it outside this SDK.
 *
 * Two different signatures are needed to send a Soroban call, which is easy to
 * confuse:
 *
 * 1. the **authorization entry** signature, over the SHA-256 of a
 *    `HashIdPreimageSorobanAuthorization`, proving the holder agreed to the
 *    contract call (`authorizeEntry` builds the preimage and asks for this);
 * 2. the **transaction** signature, over the transaction's `signatureBase()`,
 *    which is what the network charges the source account for.
 */
import { StrKey, hash, xdr, type SigningCallback } from '@stellar/stellar-sdk';

import { ConfigurationError } from './errors.js';
import type { Address } from './types.js';

export interface Signer {
  /** The account (`G…`) this signer acts for; also the transaction source. */
  readonly publicKey: Address;
  /** Signs a 32-byte digest and returns the raw 64-byte ed25519 signature. */
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Adapts a `Keypair` into a `Signer`.
 *
 * Convenient for a script or a server-side operator key; anything facing a user
 * should hand the key to a wallet and implement `Signer` over its API instead.
 */
export function keypairSigner(keypair: {
  publicKey: () => string;
  sign: (data: Buffer) => Uint8Array;
}): Signer {
  return {
    publicKey: keypair.publicKey(),
    // A `Keypair` signs synchronously; the interface is async because a wallet
    // round-trip is not.
    sign: (digestBytes) => Promise.resolve(keypair.sign(Buffer.from(digestBytes))),
  };
}

/**
 * The callback `authorizeEntry` expects: it builds the preimage, we sign its
 * hash, and we report which account signed so the node can verify it.
 */
export function authorizationSigner(signer: Signer): SigningCallback {
  return async (preimage) => ({
    signature: await signer.sign(hash(preimage.toXDR())),
    publicKey: signer.publicKey,
  });
}

/**
 * Wraps a signature the way the network wants it: an ed25519 signature plus the
 * low four bytes of the public key as a hint.
 *
 * `Transaction.addSignature` would do this too, but it takes a base64 string,
 * which drags a `Buffer` conversion into what should be browser-safe code.
 */
export function decoratedSignature(
  publicKey: Address,
  signature: Uint8Array,
): xdr.DecoratedSignature {
  const raw = StrKey.decodeEd25519PublicKey(publicKey);
  return new xdr.DecoratedSignature({
    hint: raw.subarray(raw.length - 4),
    // js-xdr types these fields as `Buffer`; this is the one place that
    // conversion has to happen, and it never leaves this module.
    signature: Buffer.from(signature),
  });
}

/** Fails early and clearly when a write is attempted without a key. */
export function requireSigner(signer: Signer | undefined): Signer {
  if (signer === undefined) {
    throw new ConfigurationError(
      'this call needs a signer: pass one to KeygateClient or use read(), which never submits',
    );
  }
  return signer;
}
