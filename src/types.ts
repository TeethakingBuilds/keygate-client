/**
 * The vocabulary the SDK speaks, with no XDR and no network types in it.
 *
 * Keeping this file free of `@stellar/stellar-sdk` imports is what lets a
 * caller — or a test — build a `Call` without touching the ledger. Encoding
 * happens later, in `abi.ts`, so the shape of a request is always inspectable.
 */

/** A Stellar account (`G…`) or contract (`C…`) address, in strkey form. */
export type Address = string;

/** Seconds since the unix epoch, matching Soroban ledger timestamps. */
export type Timestamp = number;

/** The two things a policy rule can say. */
export type Effect = 'allow' | 'deny';

/** Which keygate contract a call targets. */
export type ContractRole = 'core' | 'policy' | 'breaker' | 'multisig';

export interface Triple {
  readonly resource: string;
  readonly action: string;
}

/**
 * A value that can be lifted into a Soroban argument, before encoding.
 *
 * This is deliberately a tagged union rather than "whatever `nativeToScVal`
 * accepts": `nativeToScVal('G…')` produces an `scvString`, not an address, and a
 * contract that expects `Address` rejects it at the host layer. Forcing every
 * argument through a tag is what turns that class of mistake into a type error.
 */
export type AbiArg =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'symbol'; readonly value: string }
  | { readonly kind: 'address'; readonly value: Address }
  | { readonly kind: 'u32'; readonly value: number }
  | { readonly kind: 'u64'; readonly value: bigint }
  | { readonly kind: 'i128'; readonly value: bigint }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'vec'; readonly value: readonly AbiArg[] };

/** One contract entry point plus its arguments, ready to encode and send. */
export interface Call {
  readonly role: ContractRole;
  readonly func: string;
  readonly args: readonly AbiArg[];
}

/** The question a decision service was asked. */
export interface DecisionRequest {
  readonly holder: Address;
  readonly resource: string;
  readonly action: string;
  /**
   * Present only when the caller intends to charge this amount; `undefined` and
   * absent both mean "no amount", so passing one from an optional field is fine.
   */
  readonly amount?: bigint | undefined;
}

export interface BudgetSummary {
  readonly resource: string;
  /** Headroom *before* this charge; nothing is reserved off-chain. */
  readonly remaining: string;
  /** The amount this decision approved, as a decimal string. */
  readonly requested: string;
  readonly windowSeconds: number;
}

export interface AllowedDecision {
  readonly allowed: true;
  readonly grantId: number;
  readonly expiresAt: Timestamp;
  readonly budget: BudgetSummary | null;
  readonly evaluatedAt: Timestamp;
}

export interface DeniedDecision {
  readonly allowed: false;
  readonly reason: string;
  readonly grantId: number | null;
  readonly evaluatedAt: Timestamp;
}

export type Decision = AllowedDecision | DeniedDecision;

/**
 * Mirrors the `Effect` enum in `keygate-policy`.
 *
 * A C-like `#[contracttype]` enum is encoded as its discriminant, so these
 * numbers are part of the wire format: reordering the Rust variants without
 * changing this table would silently invert every rule on-chain.
 */
export const EFFECT_DISCRIMINANT: Record<Effect, 0 | 1> = { allow: 0, deny: 1 };

export function effectFromDiscriminant(value: number): Effect {
  if (value === 0) {
    return 'allow';
  }
  if (value === 1) {
    return 'deny';
  }
  throw new TypeError(`not an Effect discriminant: ${value}`);
}

export function stringArg(value: string): AbiArg {
  return { kind: 'string', value };
}

export function symbolArg(value: string): AbiArg {
  return { kind: 'symbol', value };
}

export function addressArg(value: Address): AbiArg {
  return { kind: 'address', value };
}

export function u32Arg(value: number): AbiArg {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`not a u32: ${value}`);
  }
  return { kind: 'u32', value };
}

export function u64Arg(value: bigint): AbiArg {
  if (value < 0n || value > (1n << 64n) - 1n) {
    throw new RangeError(`not a u64: ${value}`);
  }
  return { kind: 'u64', value };
}

export function i128Arg(value: bigint): AbiArg {
  const limit = 1n << 127n;
  if (value < -limit || value > limit - 1n) {
    throw new RangeError(`not an i128: ${value}`);
  }
  return { kind: 'i128', value };
}

export function boolArg(value: boolean): AbiArg {
  return { kind: 'bool', value };
}

export function vecArg(values: readonly AbiArg[]): AbiArg {
  return { kind: 'vec', value: values };
}

export function tripleArgs(triple: Triple): readonly AbiArg[] {
  return [stringArg(triple.resource), stringArg(triple.action)];
}

export function effectArg(effect: Effect): AbiArg {
  return u32Arg(EFFECT_DISCRIMINANT[effect]);
}
