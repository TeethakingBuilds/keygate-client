import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  asBool,
  asMap,
  asOption,
  asString,
  asU32,
  asU64,
  contractErrorCode,
  decodeAddresses,
  decodeBreakerConfig,
  decodeBreakerState,
  decodeGrant,
  decodeProposal,
  decodeRule,
  decodeStringVec,
  decodeTriples,
  decodeU64Vec,
  encodeArgs,
  isNone,
  toScVal,
} from '../src/abi.js';
import {
  addressArg,
  boolArg,
  i128Arg,
  stringArg,
  symbolArg,
  u32Arg,
  u64Arg,
  vecArg,
  type AbiArg,
} from '../src/types.js';

const CONTRACT = Keypair.random().publicKey();
const ACCOUNT = Keypair.random().publicKey();

/** Builds a value the way a contract would return it, so tests read like the ABI. */
const str = (value: string): xdr.ScVal => toScVal(stringArg(value));
const addr = (value: string): xdr.ScVal => toScVal(addressArg(value));
const u = (value: bigint | number): xdr.ScVal => toScVal(u64Arg(BigInt(value)));
const sml = (value: number): xdr.ScVal => toScVal(u32Arg(value));
const big = (value: bigint): xdr.ScVal => toScVal(i128Arg(value));
const flag = (value: boolean): xdr.ScVal => toScVal(boolArg(value));
const vec = (...items: (xdr.ScVal | AbiArg)[]): xdr.ScVal =>
  xdr.ScVal.scvVec(items.map((item) => ('switch' in item ? item : toScVal(item))));
const symbolValue = (value: string): xdr.ScVal => toScVal(symbolArg(value));

function entry(key: string, value: xdr.ScVal): xdr.ScMapEntry {
  // `ScMapEntry` fields are accessor methods in this SDK, so a plain object
  // literal type-checks but fails to encode.
  return new xdr.ScMapEntry({ key: symbolValue(key), val: value });
}

function mapOf(...entries: xdr.ScMapEntry[]): xdr.ScVal {
  return xdr.ScVal.scvMap(entries);
}

/** Pushes a value through its own XDR so decoders see what the node will send. */
function overTheWire(value: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.fromXDR(value.toXDR('base64'), 'base64');
}

describe('toScVal', () => {
  it('lifts every argument kind to the Soroban type the contract declares', () => {
    expect(toScVal(stringArg('vault:main')).switch().name).toBe('scvString');
    expect(toScVal(symbolArg('withdraw')).switch().name).toBe('scvSymbol');
    expect(toScVal(boolArg(true)).switch().name).toBe('scvBool');
    expect(toScVal(u32Arg(1)).switch().name).toBe('scvU32');
    expect(toScVal(u64Arg(1_000n)).switch().name).toBe('scvU64');
    expect(toScVal(i128Arg(1_000n)).switch().name).toBe('scvI128');
    expect(toScVal(vecArg([stringArg('a')])).switch().name).toBe('scvVec');
  });

  it('turns a strkey into an address rather than a string', () => {
    // `nativeToScVal('G…')` yields an `scvString`, which a contract expecting
    // `Address` rejects at the host layer — the trap this module exists to remove.
    expect(toScVal(addressArg(ACCOUNT)).switch().name).toBe('scvAddress');
    expect(nativeToScVal(ACCOUNT).switch().name).toBe('scvString');
  });

  it('refuses an address that is not a strkey', () => {
    expect(() => toScVal(addressArg('not-an-address'))).toThrow();
  });

  it('encodes nested vectors', () => {
    const encoded = toScVal(vecArg([addressArg(ACCOUNT), addressArg(CONTRACT)]));
    expect(overTheWire(encoded).value()).toHaveLength(2);
    expect(decodeAddresses(overTheWire(encoded))).toEqual([ACCOUNT, CONTRACT]);
  });

  it('encodes the argument list of a call in order', () => {
    const args = encodeArgs([stringArg('vault:main'), u64Arg(60n), boolArg(false)]);
    expect(args.map((arg) => arg.switch().name)).toEqual(['scvString', 'scvU64', 'scvBool']);
  });

  it('bounds every integer tag by the type it names', () => {
    expect(() => u32Arg(-1)).toThrow(RangeError);
    expect(() => u32Arg(1.5)).toThrow(RangeError);
    expect(() => u32Arg(2 ** 32)).toThrow(RangeError);
    expect(() => u64Arg(-1n)).toThrow(RangeError);
    expect(() => u64Arg(2n ** 64n)).toThrow(RangeError);
    expect(() => i128Arg(-(2n ** 127n) - 1n)).toThrow(RangeError);
    expect(() => i128Arg(2n ** 127n)).toThrow(RangeError);
  });
});

describe('scalar decoders', () => {
  it('reads scalars that came over the wire', () => {
    expect(asString(overTheWire(str('vault:main')), 'x')).toBe('vault:main');
    expect(asBool(overTheWire(flag(false)), 'x')).toBe(false);
    expect(asU32(overTheWire(sml(7)), 'x')).toBe(7);
    expect(asU64(overTheWire(u(123_456_789_012n)), 'x')).toBe(123_456_789_012n);
    expect(asString(str(''), 'x')).toBe('');
  });

  it('reads the whole u128 range, which js-xdr hands back as two halves', () => {
    const max = overTheWire(nativeToScVal(2n ** 128n - 1n, { type: 'u128' }));
    expect(decodeBreakerConfig(mapOf(entry('limit', max), entry('window', u(1)))).limit).toBe(
      2n ** 128n - 1n,
    );
  });

  it('reads a negative i128', () => {
    const negative = overTheWire(nativeToScVal(-1_100n, { type: 'i128' }));
    const state = mapOf(
      entry('used', negative),
      entry('window_start', u(0)),
      entry('tripped', flag(false)),
    );
    expect(decodeBreakerState(overTheWire(state)).used).toBe(-1_100n);
  });

  it('says what it wanted when it gets something else', () => {
    expect(() => asString(sml(1), 'grant.resource')).toThrow(
      'grant.resource: expected string, got scvU32',
    );
    expect(() => asU64(str('1'), 'ttl')).toThrow('ttl: expected u64, got scvString');
    expect(() => asBool(str('1'), 'paused')).toThrow('paused: expected bool, got scvString');
    expect(() => addr('nope')).toThrow();
  });
});

describe('struct decoders', () => {
  const grantMap = mapOf(
    entry('id', u(7)),
    entry('resource', str('vault:main')),
    entry('action', str('withdraw')),
    entry('holder', addr(ACCOUNT)),
    entry('issuer', addr(CONTRACT)),
    entry('expires_at', u(1_800_000_600)),
  );

  it('decodes a Grant', () => {
    expect(decodeGrant(overTheWire(grantMap))).toEqual({
      id: 7,
      resource: 'vault:main',
      action: 'withdraw',
      holder: ACCOUNT,
      issuer: CONTRACT,
      expiresAt: 1_800_000_600,
    });
  });

  it('names the missing field instead of returning undefined', () => {
    const incomplete = mapOf(
      entry('id', u(1)),
      entry('resource', str('vault:main')),
      entry('action', str('withdraw')),
      entry('holder', addr(ACCOUNT)),
      entry('issuer', addr(CONTRACT)),
    );
    expect(() => decodeGrant(incomplete)).toThrow("grant: missing field 'expires_at'");
  });

  it('names the field whose type moved', () => {
    const wrong = mapOf(
      entry('id', u(1)),
      entry('resource', sml(1)),
      entry('action', str('withdraw')),
      entry('holder', addr(ACCOUNT)),
      entry('issuer', addr(CONTRACT)),
      entry('expires_at', u(1)),
    );
    expect(() => decodeGrant(wrong, 'grant')).toThrow('grant.resource: expected string');
  });

  it('rejects a struct where a scalar was expected', () => {
    expect(() => asMap(str('x'), 'rule')).toThrow('rule: expected map, got scvString');
  });

  it('decodes a Rule through the Effect discriminant table', () => {
    const rule = (effect: number) =>
      mapOf(
        entry('id', u(3)),
        entry('resource', str('vault:main')),
        entry('action', str('withdraw')),
        entry('effect', sml(effect)),
      );
    expect(decodeRule(rule(0)).effect).toBe('allow');
    expect(decodeRule(rule(1)).effect).toBe('deny');
    expect(() => decodeRule(rule(2))).toThrow('not an Effect discriminant: 2');
  });

  it('decodes a breaker state', () => {
    const state = mapOf(
      entry('window_start', u(1_800_000_000)),
      entry('used', big(400n)),
      entry('tripped', flag(true)),
    );
    expect(decodeBreakerState(overTheWire(state))).toEqual({
      windowStart: 1_800_000_000,
      used: 400n,
      tripped: true,
    });
  });

  it('keeps a proposal’s relayed arguments raw, because only the caller can type them', () => {
    const proposal = mapOf(
      entry('id', u(2)),
      entry('target', addr(CONTRACT)),
      entry('func', symbolValue('pause')),
      entry('args', vec()),
      entry('approvals', vec(addr(ACCOUNT))),
      entry('executed', flag(false)),
      entry('proposed_at', u(1_800_000_000)),
    );
    const decoded = decodeProposal(overTheWire(proposal));
    expect(decoded.approvals).toEqual([ACCOUNT]);
    expect(decoded.func).toBe('pause');
    expect(decoded.executed).toBe(false);
    // Raw, so the caller can decode a relayed `pause()` with no arguments as-is.
    expect(decoded.args.map((arg) => arg.switch().name)).toEqual([]);
  });

  it('decodes the list-shaped reads', () => {
    expect(decodeU64Vec(overTheWire(vec(u(1), u(2))))).toEqual([1, 2]);
    expect(decodeStringVec(vec(str('vault:main')))).toEqual(['vault:main']);
    expect(
      decodeTriples(
        vec(mapOf(entry('resource', str('vault:main')), entry('action', str('withdraw')))),
      ),
    ).toEqual([{ resource: 'vault:main', action: 'withdraw' }]);
  });
});

describe('Option results', () => {
  const grantMap = mapOf(
    entry('id', u(1)),
    entry('resource', str('vault:main')),
    entry('action', str('withdraw')),
    entry('holder', addr(ACCOUNT)),
    entry('issuer', addr(CONTRACT)),
    entry('expires_at', u(2)),
  );

  it('reads Soroban’s None marker as absent', () => {
    const none = xdr.ScVal.scvLedgerKeyContractInstance();
    expect(isNone(none)).toBe(true);
    expect(asOption(none, 'core.grant', decodeGrant)).toBeNull();
  });

  it('reads a present option', () => {
    expect(isNone(grantMap)).toBe(false);
    expect(asOption(grantMap, 'core.grant', decodeGrant)?.id).toBe(1);
  });
});

describe('contractErrorCode', () => {
  it('reads the u32 a #[contracterror] variant became', () => {
    const error = overTheWire(xdr.ScVal.scvError(xdr.ScError.sceContract(4)));
    expect(contractErrorCode(error)).toBe(4);
  });

  it('is undefined for a value that is not a contract error', () => {
    expect(contractErrorCode(flag(true))).toBeUndefined();
    expect(
      contractErrorCode(
        xdr.ScVal.scvError(xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInternalError())),
      ),
    ).toBeUndefined();
  });
});
