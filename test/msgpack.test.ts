import { describe, expect, it } from 'vitest';
import { readMsgpackEnvelope } from '../src/envelope.js';
import { ErrorCode } from '../src/errors.js';
import { decodeMsgpack, encodeMsgpack } from '../src/serialize/msgpack.js';

function roundTrip(value: unknown): unknown {
  return decodeMsgpack(encodeMsgpack(value));
}

describe('encodeMsgpack — primitive bytes', () => {
  it('encodes nil and booleans', () => {
    expect([...encodeMsgpack(null)]).toEqual([0xc0]);
    expect([...encodeMsgpack(undefined)]).toEqual([0xc0]);
    expect([...encodeMsgpack(true)]).toEqual([0xc3]);
    expect([...encodeMsgpack(false)]).toEqual([0xc2]);
  });

  it('encodes integers with the smallest representation', () => {
    expect([...encodeMsgpack(5)]).toEqual([5]);
    expect([...encodeMsgpack(127)]).toEqual([127]);
    expect([...encodeMsgpack(-1)]).toEqual([0xff]);
    expect([...encodeMsgpack(-32)]).toEqual([0xe0]);
    expect([...encodeMsgpack(128)]).toEqual([0xcc, 128]);
    expect([...encodeMsgpack(300)]).toEqual([0xcd, 0x01, 0x2c]);
    expect([...encodeMsgpack(-33)]).toEqual([0xd0, 0xdf]);
    expect([...encodeMsgpack(70_000)]).toEqual([0xce, 0x00, 0x01, 0x11, 0x70]); // 0x11170 needs uint32
    expect([...encodeMsgpack(2 ** 32 + 5)]).toEqual([0xcf, 0, 0, 0, 1, 0, 0, 0, 5]);
  });

  it('encodes floats as float64', () => {
    const bytes = encodeMsgpack(1.5);
    expect(bytes[0]).toBe(0xcb);
    expect(bytes.byteLength).toBe(9);
  });

  it('encodes strings with fixstr/str8/str16/str32', () => {
    expect([...encodeMsgpack('hi')]).toEqual([0xa2, 0x68, 0x69]);
    const long = 'x'.repeat(40);
    const bytes = encodeMsgpack(long);
    expect(bytes[0]).toBe(0xd9);
    expect(bytes[1]).toBe(40);
    expect(decodeMsgpack(bytes)).toBe(long);
  });

  it('encodes unicode strings by byte length', () => {
    const value = '🔮orbit';
    const bytes = encodeMsgpack(value);
    expect(bytes[0]).toBe(0xa0 | 4 + 5); // 4-byte emoji + 5 ascii
    expect(decodeMsgpack(bytes)).toBe(value);
  });
});

describe('encodeMsgpack — collections', () => {
  it('encodes arrays with fixarray/array16', () => {
    expect([...encodeMsgpack([1, 2])]).toEqual([0x92, 1, 2]);
    const big = Array.from({ length: 20 }, (_, i) => i);
    const bytes = encodeMsgpack(big);
    expect(bytes[0]).toBe(0xdc);
    expect(decodeMsgpack(bytes)).toEqual(big);
  });

  it('encodes maps with fixmap/map16', () => {
    expect([...encodeMsgpack({ a: 1 })]).toEqual([0x81, 0xa1, 0x61, 1]);
    const big: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) big[`k${i}`] = i;
    const bytes = encodeMsgpack(big);
    expect(bytes[0]).toBe(0xde);
    expect(decodeMsgpack(bytes)).toEqual(big);
  });

  it('omits undefined values like JSON does', () => {
    expect(decodeMsgpack(encodeMsgpack({ a: 1, b: undefined }))).toEqual({ a: 1 });
    expect(decodeMsgpack(encodeMsgpack({ a: 1, b: null }))).toEqual({ a: 1, b: null });
  });

  it('encodes binary as bin types', () => {
    const value = new Uint8Array([1, 2, 3]);
    const bytes = encodeMsgpack(value);
    expect(bytes[0]).toBe(0xc4);
    const decoded = decodeMsgpack(bytes) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect([...decoded]).toEqual([1, 2, 3]);
  });
});

describe('round-trips', () => {
  it('round-trips nested structures', () => {
    const value = {
      user: { id: '1', name: 'Ana', active: true, score: 98.5 },
      tags: ['a', 'b'],
      meta: null,
      counts: [0, 127, 128, 300, -1, -33, -70_000, 2 ** 32 + 5],
      nested: { deep: { deeper: '🔮' } },
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it('round-trips empty structures', () => {
    expect(roundTrip({})).toEqual({});
    expect(roundTrip([])).toEqual([]);
    expect(roundTrip('')).toBe('');
  });

  it('round-trips large integers (64-bit range, within 2^53)', () => {
    expect(roundTrip(2 ** 53 - 1)).toBe(2 ** 53 - 1);
    expect(roundTrip(-(2 ** 53 - 1))).toBe(-(2 ** 53 - 1));
  });
});

describe('decodeMsgpack — envelope payloads', () => {
  it('decodes a full envelope', () => {
    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    expect(decodeMsgpack(encodeMsgpack(envelope))).toEqual(envelope);
  });

  it('decodes mutation envelopes', () => {
    const envelope = {
      do: 'user.update',
      args: { filter: { id: '1' }, payload: { name: 'Ana' } },
    };
    expect(decodeMsgpack(encodeMsgpack(envelope))).toEqual(envelope);
  });

  it('rejects extension types', () => {
    // 0xd4 = fixext1, then 0x01 type, then 1 payload byte
    const bytes = new Uint8Array([0xd4, 0x05, 0x2a]);
    expect(() => decodeMsgpack(bytes)).toThrow(/Unsupported MessagePack/);
  });

  it('rejects truncated payloads', () => {
    expect(() => decodeMsgpack(new Uint8Array([0x81, 0xa1]))).toThrow();
  });

  it('rejects trailing bytes', () => {
    expect(() => decodeMsgpack(new Uint8Array([0xc0, 0xc0]))).toThrow(/Trailing bytes/);
  });
});

describe('readMsgpackEnvelope', () => {
  it('reads and validates msgpack envelopes with size limits', () => {
    const envelope = readMsgpackEnvelope(encodeMsgpack({ query: 'user(id="1") { name }' }), 10_000);
    expect(envelope.query).toBe('user(id="1") { name }');
  });

  it('enforces the payload limit on msgpack bodies', () => {
    expect(() => readMsgpackEnvelope(encodeMsgpack({ query: 'x' }), 2)).toThrowError(
      expect.objectContaining({ code: ErrorCode.PAYLOAD_TOO_LARGE }),
    );
  });

  it('rejects invalid msgpack with ORBIT_INVALID_QUERY', () => {
    expect(() => readMsgpackEnvelope(new Uint8Array([0xd4, 0x01, 0x00]), 10_000)).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });
});
