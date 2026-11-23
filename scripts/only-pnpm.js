import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lockstep: this repo is pnpm-only because the lockfile is what makes CI and a
 * contributor's machine resolve the same transitive versions. npm/yarn would
 * silently ignore `pnpm-lock.yaml`.
 *
 * This hook ships in the published package (see `files` in package.json), so
 * it must stay silent when the package is installed as somebody else's
 * dependency: the guard is for developing *this* repository, not for using the
 * SDK. A dependency install runs the hook from inside a `node_modules` tree;
 * a checkout runs it from the repository root.
 */
const here = dirname(fileURLToPath(import.meta.url));
if (here.includes('node_modules')) {
  process.exit(0);
}

const userAgent = process.env.npm_config_user_agent ?? '';

if (!userAgent.includes('pnpm')) {
  console.error(
    [
      'keygate-client uses pnpm.',
      '',
      '  corepack enable',
      '  pnpm install',
      '',
      'If corepack is unavailable: npm install -g pnpm',
    ].join('\n'),
  );
  process.exit(1);
}
