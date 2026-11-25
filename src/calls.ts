/**
 * One builder per contract entry point.
 *
 * These are pure and synchronous: they produce a `Call` describing what would
 * go on-chain, which can be asserted in a test, handed to `KeygateClient`, or
 * — for the multisig path — nested inside a proposal. Function names are the
 * Rust identifiers (`require_access`, not `requireAccess`), because that is what
 * Soroban exports.
 */
import {
  addressArg,
  bytesArg,
  effectArg,
  i128Arg,
  stringArg,
  symbolArg,
  tripleArgs,
  u32Arg,
  u64Arg,
  vecArg,
  type AbiArg,
  type Address,
  type Call,
  type Effect,
  type Triple,
} from './types.js';

function core(func: string, args: readonly AbiArg[] = []): Call {
  return { role: 'core', func, args };
}

function policy(func: string, args: readonly AbiArg[] = []): Call {
  return { role: 'policy', func, args };
}

function breaker(func: string, args: readonly AbiArg[] = []): Call {
  return { role: 'breaker', func, args };
}

function multisig(func: string, args: readonly AbiArg[] = []): Call {
  return { role: 'multisig', func, args };
}

function payments(func: string, args: readonly AbiArg[] = []): Call {
  return { role: 'payments', func, args };
}

/** `keygate-core`: the capability registry. */
export const coreCalls = {
  initialize: (admin: Address): Call => core('initialize', [addressArg(admin)]),

  /** Grants `(resource, action)` to `holder` for `ttlSeconds`; also the renewal path. */
  issue: (triple: Triple, holder: Address, ttlSeconds: number | bigint): Call =>
    core('issue', [...tripleArgs(triple), addressArg(holder), u64Arg(BigInt(ttlSeconds))]),

  revoke: (triple: Triple, holder: Address): Call =>
    core('revoke', [...tripleArgs(triple), addressArg(holder)]),

  check: (triple: Triple, holder: Address): Call =>
    core('check', [...tripleArgs(triple), addressArg(holder)]),

  /** The entry point other contracts use: authenticates `caller`, fails closed. */
  requireAccess: (caller: Address, triple: Triple): Call =>
    core('require_access', [addressArg(caller), ...tripleArgs(triple)]),

  grant: (triple: Triple, holder: Address): Call =>
    core('grant', [...tripleArgs(triple), addressArg(holder)]),

  liveIds: (): Call => core('live_ids'),

  grantsOf: (holder: Address): Call => core('grants_of', [addressArg(holder)]),

  admin: (): Call => core('admin'),

  /** Admin handover is two-step so a typo cannot strand the registry. */
  proposeAdmin: (next: Address): Call => core('propose_admin', [addressArg(next)]),
  acceptAdmin: (): Call => core('accept_admin'),
  cancelAdmin: (): Call => core('cancel_admin'),

  pause: (): Call => core('pause'),
  unpause: (): Call => core('unpause'),
  paused: (): Call => core('paused'),
};

/** `keygate-policy`: rules and the default effect. */
export const policyCalls = {
  initialize: (admin: Address, registry: Address): Call =>
    policy('initialize', [addressArg(admin), addressArg(registry)]),

  setRule: (triple: Triple, effect: Effect): Call =>
    policy('set_rule', [...tripleArgs(triple), effectArg(effect)]),

  removeRule: (triple: Triple): Call => policy('remove_rule', tripleArgs(triple)),

  rule: (triple: Triple): Call => policy('rule', tripleArgs(triple)),
  rules: (): Call => policy('rules'),

  defaultEffect: (): Call => policy('default_effect'),
  setDefaultEffect: (effect: Effect): Call => policy('set_default_effect', [effectArg(effect)]),

  registry: (): Call => policy('registry'),
  setRegistry: (registry: Address): Call => policy('set_registry', [addressArg(registry)]),

  /** Registry membership and the rule set, combined. */
  evaluate: (triple: Triple, holder: Address): Call =>
    policy('evaluate', [...tripleArgs(triple), addressArg(holder)]),

  admin: (): Call => policy('admin'),
  transferAdmin: (next: Address): Call => policy('transfer_admin', [addressArg(next)]),
};

/** `keygate-circuit-breaker`: rate limits that latch. */
export const breakerCalls = {
  initialize: (admin: Address): Call => breaker('initialize', [addressArg(admin)]),

  configure: (resource: string, limit: bigint, windowSeconds: number | bigint): Call =>
    breaker('configure', [stringArg(resource), i128Arg(limit), u64Arg(BigInt(windowSeconds))]),

  /**
   * The only path that moves a counter, which is why it can trip. A breach is
   * reported as the call's return value, not as an error, so that the latch the
   * breach records survives the call — check it before moving value.
   */
  enforce: (resource: string, amount: bigint): Call =>
    breaker('enforce', [stringArg(resource), i128Arg(amount)]),

  remaining: (resource: string): Call => breaker('remaining', [stringArg(resource)]),
  config: (resource: string): Call => breaker('config', [stringArg(resource)]),
  state: (resource: string): Call => breaker('state', [stringArg(resource)]),
  isTripped: (resource: string): Call => breaker('is_tripped', [stringArg(resource)]),

  trip: (resource: string): Call => breaker('trip', [stringArg(resource)]),
  reset: (resource: string): Call => breaker('reset', [stringArg(resource)]),

  resources: (): Call => breaker('resources'),
  admin: (): Call => breaker('admin'),
};

/** `keygate-multisig`: quorum-gated administration of the other contracts. */
export const multisigCalls = {
  initialize: (owners: readonly Address[], threshold: number): Call =>
    multisig('initialize', [vecArg(owners.map(addressArg)), u32Arg(threshold)]),

  /**
   * Records a call to run once quorum approves.
   *
   * `inner` is built by the same module, so a proposal's target function and
   * argument encoding are the ones a direct call would have used — there is no
   * second, hand-maintained copy of the ABI to drift from the first.
   */
  submit: (caller: Address, target: Address, inner: Call): Call =>
    multisig('submit', [
      addressArg(caller),
      addressArg(target),
      symbolArg(inner.func),
      vecArg(inner.args),
    ]),

  approve: (caller: Address, id: number): Call =>
    multisig('approve', [addressArg(caller), u64Arg(BigInt(id))]),
  unapprove: (caller: Address, id: number): Call =>
    multisig('unapprove', [addressArg(caller), u64Arg(BigInt(id))]),
  cancel: (caller: Address, id: number): Call =>
    multisig('cancel', [addressArg(caller), u64Arg(BigInt(id))]),
  execute: (caller: Address, id: number): Call =>
    multisig('execute', [addressArg(caller), u64Arg(BigInt(id))]),

  /**
   * The payload of a proposal that targets the multisig itself. Soroban will
   * not re-enter a contract, so `execute` applies this rotation inline instead
   * of relaying it — sending it straight to the multisig is not a transaction
   * that can succeed.
   */
  setOwners: (owners: readonly Address[], threshold: number): Call =>
    multisig('set_owners', [vecArg(owners.map(addressArg)), u32Arg(threshold)]),

  proposal: (id: number): Call => multisig('proposal', [u64Arg(BigInt(id))]),
  liveIds: (): Call => multisig('live_ids'),
  approvals: (id: number): Call => multisig('approvals', [u64Arg(BigInt(id))]),
  owners: (): Call => multisig('owners'),
  threshold: (): Call => multisig('threshold'),
  isOwner: (address: Address): Call => multisig('is_owner', [addressArg(address)]),
};

/** `keygate-payments`: policy-routed USDC transfers. */
export const paymentsCalls = {
  /**
   * Builds the `pay` invocation: the transfer and the policy check happen in
   * the same call, so a refusal is atomic — no value moves.
   *
   * `reference` must be exactly 32 bytes and unique per payer: the contract
   * stores the receipt under it and refuses a repeat (`DuplicateReference`).
   * `deadline` is unix seconds; the contract allows at most 7 days out.
   * `approvals` lists co-signers and is only accepted when the amount is above
   * the policy's approval threshold — and every listed approver must authorise
   * the call (see `KeygateClient.payPolicy`).
   */
  pay: (
    from: Address,
    to: Address,
    amount: bigint,
    reference: Uint8Array,
    deadline: number | bigint,
    approvals: readonly Address[] = [],
  ): Call => {
    if (reference.length !== 32) {
      throw new RangeError(`payment reference must be exactly 32 bytes, got ${reference.length}`);
    }
    return payments('pay', [
      addressArg(from),
      addressArg(to),
      i128Arg(amount),
      bytesArg(reference),
      u64Arg(BigInt(deadline)),
      vecArg(approvals.map(addressArg)),
    ]);
  },

  /** What one account has spent in its current daily and monthly buckets. */
  usage: (account: Address): Call => payments('usage', [addressArg(account)]),

  /** The on-chain receipt for one payment, or `null` when it never landed. */
  paymentReceipt: (account: Address, reference: Uint8Array): Call => {
    if (reference.length !== 32) {
      throw new RangeError(`payment reference must be exactly 32 bytes, got ${reference.length}`);
    }
    return payments('payment_receipt', [addressArg(account), bytesArg(reference)]);
  },

  /** How much one account can still spend: `(daily, monthly)` headroom. */
  remaining: (account: Address): Call => payments('remaining', [addressArg(account)]),

  /** Whether the policy lets `account` pay `recipient` (the allowlist check). */
  isAllowed: (account: Address, recipient: Address): Call =>
    payments('is_allowed', [addressArg(account), addressArg(recipient)]),

  /** The spending policy for one account, or `null` when none is set. */
  policy: (account: Address): Call => payments('policy', [addressArg(account)]),
};

/** Escape hatch for a contract function this module does not wrap yet. */
export function rawCall(role: Call['role'], func: string, args: readonly AbiArg[] = []): Call {
  return { role, func, args };
}
