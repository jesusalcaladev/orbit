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

  it('encodes unicode strings by byte length', () => {
    const value = '🔮orbit';
    const bytes = encodeMsgpack(value);
    expect(bytes[0]).toBe(0xa0 | (4 + 5)); // 4-byte emoji + 5 ascii
    expect(decodeMsgpack(bytes)).toBe(value);
  });
});

describe('encodeMsgpack — scaling budgets', () => {
  // TDD regression budgets for the codec's algorithmic shape. The original
  // codec spread byte payloads one number per array slot
  // (`out.push([...bytes])`), making a 70k-item encode cost O(N) pushes plus
  // an O(N) element-wise flatten on top of the per-item work — measured
  // ~175 ms for a 70k numeric array and slow enough to flake the suite's
  // 5 s timeout under full parallel load. The growable-writer codec encodes
  // the same value in ~5-10 ms.
  //
  // Budgets are RELATIVE (time(BIG) vs time(SMALL) of the same shape) instead
  // of absolute wall-clock: instrumentation (`vitest --coverage`) and slow CI
  // hardware multiply both sides, so the ratio cancels most environment
  // overhead.
  //
  // The size gap is deliberately WIDE (40×) because the ratio's tolerance
  // under CPU contention is roughly multiplicative noise: on a loaded machine a
  // narrow gap (70k vs 5k = 14×) leaves only ~3× of headroom above the linear
  // result and the budget fails for a perfectly linear codec. At 40× the
  // signatures are far apart — linear ≈ 40×, quadratic ≈ 1600× — so a 200×
  // budget sits 5× above linear and ~8× below quadratic, and survives
  // contention while still failing loudly on the regression it guards.
  const BIG = 80_000;
  const SMALL = 2_000;
  const RATIO_BUDGET = 200;

  /**
   * Best (fastest) per-iteration encode time, measured over enough iterations
   * that the measurement itself spans a meaningful window.
   *
   * `min` of N runs alone is not enough on a loaded machine: the SMALL input
   * encodes in well under a millisecond, so a single scheduler preemption
   * (vitest runs test files in parallel) inflates the DENOMINATOR of the ratio
   * by an order of magnitude and the budget fails for a codec that is perfectly
   * linear. Repeating each measurement until it covers `MIN_WINDOW_MS` makes
   * the noise a small fraction of the sample, and `min` then discards the rest.
   */
  const MIN_WINDOW_MS = 100;

  function bestOf(value: unknown, runs: number = 3): number {
    // Calibrate the per-iteration cost, then batch enough iterations to fill
    // the measurement window (capped so a slow iteration cannot explode the
    // test into a minute-long loop).
    const calibrate = performance.now();
    encodeMsgpack(value);
    const single = Math.max(performance.now() - calibrate, 0.001);
    const reps = Math.max(1, Math.min(200, Math.ceil(MIN_WINDOW_MS / single)));

    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      for (let k = 0; k < reps; k += 1) encodeMsgpack(value);
      best = Math.min(best, (performance.now() - t0) / reps);
    }
    return best;
  }

  it(`encodes numeric arrays linearly (${BIG} vs ${SMALL} ratio budget)`, () => {
    const big = Array.from({ length: BIG }, (_, i) => i % 256);
    const small = Array.from({ length: SMALL }, (_, i) => i % 256);
    expect(bestOf(big) / bestOf(small)).toBeLessThan(RATIO_BUDGET);
  });

  it(`encodes binary payloads linearly (${BIG} vs ${SMALL} ratio budget)`, () => {
    expect(
      bestOf(new Uint8Array(BIG).fill(7) as Uint8Array<ArrayBuffer>) /
        bestOf(new Uint8Array(SMALL).fill(7) as Uint8Array<ArrayBuffer>),
    ).toBeLessThan(RATIO_BUDGET);
  });

  it(`encodes long strings linearly (${BIG} vs ${SMALL} ratio budget)`, () => {
    expect(bestOf('x'.repeat(BIG)) / bestOf('x'.repeat(SMALL))).toBeLessThan(RATIO_BUDGET);
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

  it('encodes negative and out-of-fixint values in arrays and maps', () => {
    // The inline per-item fast path only claims -32..127; everything else
    // (the negative boundary, uint8 range, non-integers) routes through the
    // general value writer — bytes below assert the exact encodings, which
    // still use the SMALLEST representation (see the primitive-bytes suite:
    // -33 is int8 `0xd0 0xdf`, not int16 `0xd1`).
    expect([...encodeMsgpack([-33, 128, 1.5])]).toEqual([
      0x93, 0xd0, 0xdf, 0xcc, 128, 0xcb, 63, 248, 0, 0, 0, 0, 0, 0,
    ]);
    expect([...encodeMsgpack({ n: -33 })]).toEqual([0x81, 0xa1, 0x6e, 0xd0, 0xdf]);
  });

  it('omits undefined values like JSON does', () => {
    expect(decodeMsgpack(encodeMsgpack({ a: 1, b: undefined }))).toEqual({ a: 1 });
    expect(decodeMsgpack(encodeMsgpack({ a: 1, b: null }))).toEqual({ a: 1, b: null });
  });

  it('encodes negative fixints through the inline per-item fast path', () => {
    // The fast path claims -32..127 and maps negatives into 0..255 — this
    // pins the negative arm for both collections (arrays and map values).
    expect([...encodeMsgpack([-1, -5])]).toEqual([0x92, 0xff, 0xfb]);
    expect([...encodeMsgpack({ a: -1 })]).toEqual([0x81, 0xa1, 0x61, 0xff]);
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

  it('round-trips multibyte strings in every str family', () => {
    // Multi-byte path through fixstr, str8, str16 and str32 — the ASCII fast
    // path must never mangle non-ASCII payloads (byte length ≠ char length).
    const emoji = '🔮'; // 4 UTF-8 bytes, 2 UTF-16 code units
    expect(roundTrip(emoji)).toBe(emoji);
    expect(roundTrip(`${emoji}orbit-${'✓'.repeat(30)}`)).toBe(`${emoji}orbit-${'✓'.repeat(30)}`);
    expect(roundTrip(`${emoji}${'✓'.repeat(300)}`)).toBe(`${emoji}${'✓'.repeat(300)}`);
    expect(roundTrip(`${emoji}${'✓'.repeat(70_000)}`)).toBe(`${emoji}${'✓'.repeat(70_000)}`);
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

describe('decodeMsgpack — prototype-pollution safety', () => {
  it('keeps a __proto__ map key as an own property', () => {
    // fixmap(1): key "__proto__" (str 9), value "x" (str 1)
    const bytes = new Uint8Array([
      0x81,
      0xa9,
      ...new TextEncoder().encode('__proto__'),
      0xa1,
      0x78,
    ]);
    const decoded = decodeMsgpack(bytes) as Record<string, unknown>;
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe('x');
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
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
