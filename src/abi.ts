/**
 * The ABI layer: `AbiArg` in, `xdr.ScVal` out, and the reverse for return
 * values.
 *
 * Everything that knows about XDR lives here, which is the only reason the rest
 * of the SDK can be tested without a ledger. The encoders refuse values that
 * cannot fit the Soroban type (see `types.ts`), and the decoders read map fields
 * one at a time instead of calling `scValToNative` on a whole struct: that
 * helper is convenient but throws on a `Vec<Val>` we cannot type, and it turns a
 * missing field into `undefined` rather than an error.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  effectFromDiscriminant,
  type AbiArg,
  type Address as Strkey,
  type Effect,
  type Timestamp,
  type Triple,
} from './types.js';

/**
 * Soroban encodes `Option<T>::None` as an `scvLedgerKeyContractInstance` — a
 * value no contract would ever return deliberately — because `scvVoid` is not a
 * stable `Val` type. Treat that tag as "absent" everywhere.
 */
const NONE_TAG = 'scvLedgerKeyContractInstance';

const TWO_POW_64 = 1n << 64n;

export function toScVal(arg: AbiArg): xdr.ScVal {
  switch (arg.kind) {
    case 'string':
      return nativeToScVal(arg.value, { type: 'string' });
    case 'symbol':
      return xdr.ScVal.scvSymbol(arg.value);
    case 'address':
      // `new Address(…)` validates the strkey, so a typo cannot reach the node.
      return new Address(arg.value).toScVal();
    case 'u32':
      return nativeToScVal(arg.value, { type: 'u32' });
    case 'u64':
      return nativeToScVal(arg.value, { type: 'u64' });
    case 'i128':
      return nativeToScVal(arg.value, { type: 'i128' });
    case 'bool':
      return nativeToScVal(arg.value, { type: 'boolean' });
    case 'vec':
      return xdr.ScVal.scvVec(arg.value.map(toScVal));
  }
}

export function encodeArgs(args: readonly AbiArg[]): xdr.ScVal[] {
  return args.map(toScVal);
}

export function isNone(scval: xdr.ScVal): boolean {
  return scval.switch().name === NONE_TAG;
}

/**
 * Unions are read through `switch().name` and `value()` rather than the helper
 * named after the arm. js-xdr defines one setter per switch value and one getter
 * per arm, and where the two names differ the obvious accessor is the setter:
 * `body.invokeHostFunction()` silently returns `undefined` instead of the
 * operation. `switch()`/`value()` are correct for every union, so nothing here
 * depends on which of the two names a given arm happens to use.
 */
function tag(scval: xdr.ScVal): string {
  return scval.switch().name;
}

function raw(scval: xdr.ScVal): unknown {
  return scval.value();
}

/**
 * js-xdr hands `UInt128`/`Int128` back as a struct of two 64-bit halves.
 *
 * `hi` is signed for `i128` and unsigned for `u128`, while `lo` is always
 * unsigned, so `hi * 2^64 + lo` is exact for both — a negative `i128` arrives
 * already split as `-1 * 2^64 + (2^64 - n)`.
 */
function combine128(value: unknown): bigint {
  const halves = value as { hi(): unknown; lo(): unknown };
  return BigInt(String(halves.hi())) * TWO_POW_64 + BigInt(String(halves.lo()));
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new TypeError(message);
  }
}

export function asBool(scval: xdr.ScVal, context: string): boolean {
  expect(tag(scval) === 'scvBool', `${context}: expected bool, got ${tag(scval)}`);
  return Boolean(raw(scval));
}

export function asU32(scval: xdr.ScVal, context: string): number {
  expect(
    tag(scval) === 'scvU32' || tag(scval) === 'scvI32',
    `${context}: expected u32, got ${tag(scval)}`,
  );
  return Number(raw(scval));
}

export function asU64(scval: xdr.ScVal, context: string): bigint {
  expect(tag(scval) === 'scvU64', `${context}: expected u64, got ${tag(scval)}`);
  return BigInt(String(raw(scval)));
}

export function asI128(scval: xdr.ScVal, context: string): bigint {
  expect(
    tag(scval) === 'scvI128' || tag(scval) === 'scvU128' || tag(scval) === 'scvI64',
    `${context}: expected i128, got ${tag(scval)}`,
  );
  if (tag(scval) === 'scvI64') {
    return BigInt(String(raw(scval)));
  }
  return combine128(raw(scval));
}

export function asString(scval: xdr.ScVal, context: string): string {
  expect(tag(scval) === 'scvString', `${context}: expected string, got ${tag(scval)}`);
  const value = raw(scval);
  // A value read from the wire is bytes; one a caller just built with
  // `nativeToScVal` is still a JS string. Both decode to the same text.
  if (typeof value === 'string') {
    return value;
  }
  expect(
    value instanceof Uint8Array,
    `${context}: expected bytes for a string value, received ${typeof value}`,
  );
  return new TextDecoder().decode(value);
}

export function asSymbol(scval: xdr.ScVal, context: string): string {
  expect(
    tag(scval) === 'scvSymbol' || tag(scval) === 'scvSymbolSmall',
    `${context}: expected symbol, got ${tag(scval)}`,
  );
  return String(raw(scval));
}

export function asAddress(scval: xdr.ScVal, context: string): Strkey {
  expect(tag(scval) === 'scvAddress', `${context}: expected address, got ${tag(scval)}`);
  return Address.fromScAddress(raw(scval) as xdr.ScAddress).toString();
}

export function asVec(scval: xdr.ScVal, context: string): xdr.ScVal[] {
  expect(tag(scval) === 'scvVec', `${context}: expected vec, got ${tag(scval)}`);
  return raw(scval) as xdr.ScVal[];
}

/** Reads a contract struct as a name → field map, rejecting anything else. */
export function asMap(scval: xdr.ScVal, context: string): Map<string, xdr.ScVal> {
  expect(tag(scval) === 'scvMap', `${context}: expected map, got ${tag(scval)}`);
  const entries = raw(scval) as { key(): xdr.ScVal; val(): xdr.ScVal }[];
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    fields.set(asSymbol(entry.key(), `${context}: map key`), entry.val());
  }
  return fields;
}

function field(fields: Map<string, xdr.ScVal>, name: string, context: string): xdr.ScVal {
  const value = fields.get(name);
  if (value === undefined) {
    throw new TypeError(`${context}: missing field '${name}'`);
  }
  return value;
}

export function asOption<T>(
  scval: xdr.ScVal,
  context: string,
  decode: (value: xdr.ScVal, where: string) => T,
): T | null {
  return isNone(scval) ? null : decode(scval, context);
}

/** `Grant` in `keygate-core`. */
export interface GrantInfo {
  readonly id: number;
  readonly resource: string;
  readonly action: string;
  readonly holder: Strkey;
  readonly issuer: Strkey;
  readonly expiresAt: Timestamp;
}

/** `Rule` in `keygate-policy`. */
export interface RuleInfo {
  readonly id: number;
  readonly resource: string;
  readonly action: string;
  readonly effect: Effect;
}

/** `Config` in `keygate-circuit-breaker`. */
export interface BreakerConfigInfo {
  readonly limit: bigint;
  readonly windowSeconds: number;
}

/** `State` in `keygate-circuit-breaker`. */
export interface BreakerStateInfo {
  readonly windowStart: Timestamp;
  readonly used: bigint;
  readonly tripped: boolean;
}

/**
 * `Proposal` in `keygate-multisig`.
 *
 * `args` stays as raw `ScVal`s because the contract stores a `Vec<Val>` — the
 * relayed call's parameters, which only the caller knows how to read.
 */
export interface ProposalInfo {
  readonly id: number;
  readonly target: Strkey;
  readonly func: string;
  readonly args: xdr.ScVal[];
  readonly approvals: Strkey[];
  readonly executed: boolean;
  readonly proposedAt: Timestamp;
}

export function decodeGrant(scval: xdr.ScVal, context = 'grant'): GrantInfo {
  const fields = asMap(scval, context);
  return {
    id: Number(asU64(field(fields, 'id', context), `${context}.id`)),
    resource: asString(field(fields, 'resource', context), `${context}.resource`),
    action: asString(field(fields, 'action', context), `${context}.action`),
    holder: asAddress(field(fields, 'holder', context), `${context}.holder`),
    issuer: asAddress(field(fields, 'issuer', context), `${context}.issuer`),
    expiresAt: Number(asU64(field(fields, 'expires_at', context), `${context}.expires_at`)),
  };
}

export function decodeRule(scval: xdr.ScVal, context = 'rule'): RuleInfo {
  const fields = asMap(scval, context);
  return {
    id: Number(asU64(field(fields, 'id', context), `${context}.id`)),
    resource: asString(field(fields, 'resource', context), `${context}.resource`),
    action: asString(field(fields, 'action', context), `${context}.action`),
    effect: effectFromDiscriminant(asU32(field(fields, 'effect', context), `${context}.effect`)),
  };
}

export function decodeBreakerConfig(scval: xdr.ScVal, context = 'config'): BreakerConfigInfo {
  const fields = asMap(scval, context);
  return {
    limit: asI128(field(fields, 'limit', context), `${context}.limit`),
    windowSeconds: Number(asU64(field(fields, 'window', context), `${context}.window`)),
  };
}

export function decodeBreakerState(scval: xdr.ScVal, context = 'state'): BreakerStateInfo {
  const fields = asMap(scval, context);
  return {
    windowStart: Number(asU64(field(fields, 'window_start', context), `${context}.window_start`)),
    used: asI128(field(fields, 'used', context), `${context}.used`),
    tripped: asBool(field(fields, 'tripped', context), `${context}.tripped`),
  };
}

export function decodeProposal(scval: xdr.ScVal, context = 'proposal'): ProposalInfo {
  const fields = asMap(scval, context);
  return {
    id: Number(asU64(field(fields, 'id', context), `${context}.id`)),
    target: asAddress(field(fields, 'target', context), `${context}.target`),
    func: asSymbol(field(fields, 'func', context), `${context}.func`),
    args: asVec(field(fields, 'args', context), `${context}.args`),
    approvals: asVec(field(fields, 'approvals', context), `${context}.approvals`).map((value) =>
      asAddress(value, `${context}.approvals[]`),
    ),
    executed: asBool(field(fields, 'executed', context), `${context}.executed`),
    proposedAt: Number(asU64(field(fields, 'proposed_at', context), `${context}.proposed_at`)),
  };
}

export function decodeTriples(values: xdr.ScVal, context = 'triples'): Triple[] {
  return asVec(values, context).map((value) => {
    const fields = asMap(value, `${context}[]`);
    return {
      resource: asString(field(fields, 'resource', `${context}[]`), 'resource'),
      action: asString(field(fields, 'action', `${context}[]`), 'action'),
    };
  });
}

export function decodeAddresses(values: xdr.ScVal, context = 'addresses'): Strkey[] {
  return asVec(values, context).map((value) => asAddress(value, `${context}[]`));
}

export function decodeU64Vec(values: xdr.ScVal, context = 'ids'): number[] {
  return asVec(values, context).map((value) => Number(asU64(value, `${context}[]`)));
}

export function decodeStringVec(values: xdr.ScVal, context = 'strings'): string[] {
  return asVec(values, context).map((value) => asString(value, `${context}[]`));
}

/**
 * The contract error code carried by a return value, if this is one.
 *
 * A failed Soroban host call surfaces as `scvError`, whose contract arm is a
 * plain u32 matching the `#[contracterror]` discriminant.
 */
export function contractErrorCode(scval: xdr.ScVal): number | undefined {
  if (tag(scval) !== 'scvError') {
    return undefined;
  }
  const error = scval.value() as { switch(): { name: string }; value(): unknown };
  if (error.switch().name !== 'sceContract') {
    return undefined;
  }
  return Number(error.value());
}
