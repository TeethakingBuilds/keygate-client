/**
 * keygate-client — the TypeScript side of keygate.
 *
 * Three jobs, and deliberately only three:
 *
 * - build and send transactions to the keygate contracts (`calls.ts`, `abi.ts`,
 *   `client.ts`), with the authorisation signing that Soroban requires;
 * - decode what comes back (`abi.ts`, `errors.ts`), so a refusal is a named error
 *   rather than a hex string;
 * - verify a decision from `keygate-server` (`decision.ts`) without trusting the
 *   proxy it passed through.
 *
 * Nothing here holds a key: signing goes through the `Signer` interface — an
 * address and a digest — which an HSM, a remote signing service and a `Keypair`
 * can all implement. A wallet that will only sign a whole transaction or a whole
 * authorisation entry does not fit; `README.md` covers what to do instead.
 *
 * Also note that `read()` and the state helpers simulate against the null account
 * with no authorisations, so they answer reads, not write probes.
 *
 * ```ts
 * import { breakerCalls, connect, coreCalls, KeygateClient, keypairSigner } from 'keygate-client';
 *
 * const client = new KeygateClient({
 *   host: connect('https://soroban-testnet.stellar.org'),
 *   contracts: { core: 'C…', policy: 'C…', breaker: 'C…' },
 *   networkPassphrase: 'Test SDF Network ; September 2015',
 *   signer: keypairSigner(admin),
 * });
 *
 * await client.send(breakerCalls.configure('vault:main', 1_000n, 3_600));
 * const allowed = await client.hasAccess({ resource: 'vault:main', action: 'withdraw' }, holder);
 * ```
 */
export * from './types.js';
export * from './abi.js';
export * from './calls.js';
export * from './errors.js';
export * from './signer.js';
export * from './host.js';
export * from './client.js';
export * from './decision.js';
