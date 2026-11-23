/**
 * The packed-package consumer smoke test (issue #8).
 *
 * Packs the package, installs it into an isolated npm consumer and an
 * isolated pnpm consumer with lifecycle scripts enabled, imports it by name,
 * and type-checks a NodeNext consumer. It needs the npm registry (the tarball
 * depends on `@stellar/stellar-sdk`), so it only runs when
 * `KEYGATE_RUN_CONSUMER_SMOKE=1` is set — `pnpm test` stays offline and fast,
 * and CI runs this file separately with that variable.
 *
 * Nothing here publishes: the tarball goes to a temporary directory and the
 * consumers are temporary directories too.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = process.env.KEYGATE_RUN_CONSUMER_SMOKE === '1';

/** A fixed holder address and a fixed contract address, for the consumer scripts. */
const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CORE = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

const CONSUMER_MJS = `
import assert from 'node:assert/strict';
import {
  KeygateClient,
  KeygateError,
  breakerCalls,
  canonicalDecision,
  connect,
  coreCalls,
  decisionIsUsable,
  keypairSigner,
  multisigCalls,
  policyCalls,
  rawCall,
  signDecision,
  verifyDecision,
} from 'keygate-client';

const call = coreCalls.issue(
  { resource: 'vault:main', action: 'withdraw' },
  '${HOLDER}',
  3600,
);
assert.equal(call.role, 'core');
assert.equal(call.func, 'issue');
assert.equal(breakerCalls.configure('vault:main', 1000n, 3600).func, 'configure');
assert.equal(policyCalls.rule({ resource: 'vault:main', action: 'withdraw' }).func, 'rule');
assert.equal(multisigCalls.threshold().func, 'threshold');
assert.equal(rawCall('core', 'paused').func, 'paused');
assert.equal(typeof keypairSigner, 'function');
assert.equal(typeof connect, 'function');

const signingKey = 'demo-only-not-a-real-key';
const request = { holder: '${HOLDER}', resource: 'vault:main', action: 'withdraw' };
const decision = {
  allowed: true,
  grantId: 7,
  expiresAt: 1800003600,
  budget: null,
  evaluatedAt: 1800000000,
};
const signature = await signDecision(signingKey, request, decision);
assert.equal(await verifyDecision(signingKey, request, decision, signature), true);
assert.equal(await verifyDecision(signingKey, request, decision, '00'.repeat(32)), false);
assert.equal(decisionIsUsable(decision, 1800000000, 60), true);
assert.equal(typeof canonicalDecision(request, decision), 'string');

const client = new KeygateClient({
  host: connect('https://soroban-testnet.stellar.org'),
  contracts: { core: '${CORE}' },
  networkPassphrase: 'Test SDF Network ; September 2015',
});
assert.equal(typeof client.hasAccess, 'function');
assert.equal(typeof client.proposal, 'function');
assert.equal(typeof client.breakerRemaining, 'function');
assert.ok(new KeygateError('smoke') instanceof Error);

console.log('consumer smoke ok');
`;

const CONSUMER_TS = `
import {
  KeygateClient,
  connect,
  coreCalls,
  verifyDecision,
  type Decision,
  type DecisionRequest,
  type KeygateOptions,
} from 'keygate-client';

const options: KeygateOptions = {
  host: connect('https://soroban-testnet.stellar.org'),
  contracts: { core: '${CORE}' },
  networkPassphrase: 'Test SDF Network ; September 2015',
};
const client = new KeygateClient(options);
const request: DecisionRequest = {
  holder: '${HOLDER}',
  resource: 'vault:main',
  action: 'withdraw',
};
const decision: Decision = {
  allowed: true,
  grantId: 7,
  expiresAt: 1800003600,
  budget: null,
  evaluatedAt: 1800000000,
};
void client;
void request;
void decision;
void coreCalls;
void verifyDecision;
`;

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, timeout: 180_000, encoding: 'utf8' });
  if (result.status !== 0) {
    // Surface the command's output so a failure names the real cause instead
    // of just the command line.
    throw new Error(
      `Command failed (${command} ${args.join(' ')}):\n${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd(),
    );
  }
}

function makeConsumer(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'keygate-consumer', version: '0.0.0', type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'consumer.mjs'), CONSUMER_MJS);
  fs.writeFileSync(path.join(dir, 'consumer.ts'), CONSUMER_TS);
}

describe.skipIf(!RUN)('packed-package consumers', () => {
  it('installs into isolated npm and pnpm consumers and imports by name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keygate-consumer-'));
    try {
      run('pnpm', ['build'], REPO_ROOT);
      run('pnpm', ['pack', '--pack-destination', tmp], REPO_ROOT);
      const tarball = path.join(tmp, 'keygate-client-0.1.0.tgz');
      expect(fs.existsSync(tarball)).toBe(true);

      const npmDir = path.join(tmp, 'npm-consumer');
      makeConsumer(npmDir);
      run('npm', ['install', tarball], npmDir);
      run('node', ['consumer.mjs'], npmDir);

      const pnpmDir = path.join(tmp, 'pnpm-consumer');
      makeConsumer(pnpmDir);
      const pnpmPackage = JSON.parse(
        fs.readFileSync(path.join(pnpmDir, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      pnpmPackage.pnpm = { onlyBuiltDependencies: ['keygate-client'] };
      fs.writeFileSync(path.join(pnpmDir, 'package.json'), JSON.stringify(pnpmPackage, null, 2));
      run('pnpm', ['add', tarball], pnpmDir);
      run('node', ['consumer.mjs'], pnpmDir);

      // A NodeNext consumer compiles against the published types. The consumer
      // also needs the Node types: @stellar/stellar-base's bundled
      // declarations reference Buffer, and a bare consumer has no @types/node.
      // skipLibCheck is the standard consumer setup here: stellar-sdk 13's
      // bundled declarations reference `json-schema` and `urijs` types that a
      // bare consumer does not have installed. It does not weaken the check
      // of this package's own types, which tsc still verifies.
      run('npm', ['install', '--save-dev', '@types/node'], npmDir);
      run('pnpm', ['add', '-D', '@types/node'], pnpmDir);
      run(
        path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'es2022',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          'consumer.ts',
        ],
        npmDir,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 240_000);
});
