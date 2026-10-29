import { Keypair, authorizeEntry, hash, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../src/errors.js';
import {
  authorizationSigner,
  decoratedSignature,
  keypairSigner,
  requireSigner,
} from '../src/signer.js';
import { PASSPHRASE, addressAuth, sourceAccountAuth } from './fixtures.js';

const holder = Keypair.random();
const digestOf = (bytes: Uint8Array) => Buffer.from(bytes);

describe('keypairSigner', () => {
  it('reports the public key it signs for', () => {
    expect(keypairSigner(holder).publicKey).toBe(holder.publicKey());
  });

  it('signs a digest the keypair verifies', async () => {
    const signer = keypairSigner(holder);
    const payload = hash(Buffer.from('a decision'));
    const signature = await signer.sign(payload);

    expect(signature).toHaveLength(64);
    expect(holder.verify(payload, digestOf(signature))).toBe(true);
  });

  it('works for a signer that is not a Keypair', async () => {
    // The interface is the whole contract: anything with an address and a
    // `sign` can be used, which is what lets a wallet stand in here.
    const signer = keypairSigner({
      publicKey: () => holder.publicKey(),
      sign: (data: Buffer) => Buffer.alloc(data.length + 1),
    });

    expect(await signer.sign(Buffer.alloc(32))).toHaveLength(33);
  });
});

describe('authorizationSigner', () => {
  it('produces a signature the SDK accepts for an address credential', async () => {
    const entry = addressAuth(holder.publicKey());
    const signed = await authorizeEntry(
      entry,
      authorizationSigner(keypairSigner(holder)),
      10_099,
      PASSPHRASE,
    );

    const credentials = signed.credentials().address();
    expect(credentials).toBeDefined();
    expect(credentials?.signatureExpirationLedger()).toBe(10_099);
    expect(credentials?.nonce()).toBeDefined();

    const sig = credentials?.signature().vec()?.[0];
    expect(sig?.switch().name).toBe('scvMap');
    const map = sig?.map();
    const keys = map?.map((entryItem) => entryItem.key().sym().toString());
    expect(keys).toEqual(['public_key', 'signature']);
  });

  it('leaves a source-account credential exactly as it was', async () => {
    const entry = sourceAccountAuth();
    const signed = await authorizeEntry(
      entry,
      authorizationSigner(keypairSigner(holder)),
      1,
      PASSPHRASE,
    );

    expect(signed.toXDR('base64')).toBe(entry.toXDR('base64'));
    expect(signed.credentials().switch().name).toBe('sorobanCredentialsSourceAccount');
  });

  it('signs whatever key it is given, which is why the client checks first', async () => {
    // The node will reject this, but only after submission costs a fee:
    // `authorizeEntry` verifies the signature against the *reported* key, not
    // against the address in the entry. `KeygateClient.signAuthorizations`
    // refuses it before building anything.
    const someoneElse = Keypair.random();
    const entry = addressAuth(holder.publicKey());

    await expect(
      authorizeEntry(entry, authorizationSigner(keypairSigner(someoneElse)), 1, PASSPHRASE),
    ).resolves.toBeDefined();
  });

  it('refuses to sign when the signature does not match the reported key', async () => {
    const broken = {
      publicKey: holder.publicKey(),
      sign: () => Promise.resolve(new Uint8Array(64)),
    };

    await expect(
      authorizeEntry(addressAuth(holder.publicKey()), authorizationSigner(broken), 1, PASSPHRASE),
    ).rejects.toThrow(/signature doesn.t match payload/);
  });
});

describe('decoratedSignature', () => {
  it('hints with the last four bytes of the public key', () => {
    const signature = new Uint8Array(64).fill(7);
    const decorated = decoratedSignature(holder.publicKey(), signature);
    const raw = Keypair.fromPublicKey(holder.publicKey()).rawPublicKey();

    expect(Buffer.from(decorated.hint()).toString('hex')).toBe(
      Buffer.from(raw.subarray(raw.length - 4)).toString('hex'),
    );
    expect(Buffer.from(decorated.signature()).toString('hex')).toBe(
      Buffer.from(signature).toString('hex'),
    );
  });

  it('survives an XDR round trip, which is what the network sees', () => {
    const signature = holder.sign(hash(Buffer.from('an envelope')));
    const bytes = decoratedSignature(holder.publicKey(), signature).toXDR('base64');
    const parsed = xdr.DecoratedSignature.fromXDR(bytes, 'base64');

    expect(Buffer.from(parsed.signature()).toString('hex')).toBe(
      Buffer.from(signature).toString('hex'),
    );
    expect(Buffer.from(parsed.hint()).toString('hex')).toBe(
      Buffer.from(decoratedSignature(holder.publicKey(), signature).hint()).toString('hex'),
    );
  });
});

describe('requireSigner', () => {
  it('returns the signer it was given', () => {
    const signer = keypairSigner(holder);

    expect(requireSigner(signer)).toBe(signer);
  });

  it('explains how to avoid the error', () => {
    expect(() => requireSigner(undefined)).toThrow(ConfigurationError);
    expect(() => requireSigner(undefined)).toThrow(/read\(\)/);
  });
});
