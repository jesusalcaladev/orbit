import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  createOrbit,
  decodeMsgpack,
  encodeMsgpack,
  isOrbitError,
  memoryAdapter,
  negotiateFormat,
  parseCacheSpec,
  parseOQS,
  validateEnvelope,
} from '../src/index.js';
import { OrbitError } from '../src/errors.js';
import type { OrbitErrorCode } from '../src/errors.js';
import type { QueryNode } from '../src/types.js';

// ---------------------------------------------------------------------------
// Deterministic fuzz suite (P0.2)
//
// Same seed, same inputs, same results on every machine — CI-stable. The
// invariant under test is SECURITY, not correctness: hostile input must only
// ever produce the protocol's own error types (OrbitError for the parse
// paths, a plain codec Error for msgpack), never a crash (RangeError stack
// overflow, TypeError), never a hang, and never a leaked internal message.
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adversarial charset for OQS-ish strings: syntax chars, control bytes,
 * unicode, null bytes, prototype-pollution keys. */
const OQS_CHARSET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.',
  ...'(){}="\', \\t\\n\\r\\x00\\u0001\\uffff\\u2028\\u2029',
  ...'__proto__constructor.prototype.toStringvalueOf__defineGetter__',
];

function randomString(rand: () => number, maxLen = 80): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += OQS_CHARSET[Math.floor(rand() * OQS_CHARSET.length)];
  }
  return out;
}

function randomBytes(rand: () => number, maxLen = 64): Uint8Array {
  const len = Math.floor(rand() * maxLen);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = Math.floor(rand() * 256);
  return out;
}

function treeDepth(node: QueryNode): number {
  let max = 0;
  for (const child of Object.values(node.relations)) {
    max = Math.max(max, treeDepth(child));
  }
  return max + 1;
}

function randomJsonValue(rand: () => number, depth = 0): unknown {
  const pick = Math.floor(rand() * 8);
  if (depth > 4) return null;
  switch (pick) {
    case 0:
      return Math.floor(rand() * 1_000_000) - 500_000;
    case 1:
      return rand() < 0.5;
    case 2:
      return null;
    case 3:
      return randomString(rand, 40);
    case 4: {
      const arr: unknown[] = [];
      const n = Math.floor(rand() * 6);
      for (let i = 0; i < n; i += 1) arr.push(randomJsonValue(rand, depth + 1));
      return arr;
    }
    default: {
      const obj: Record<string, unknown> = {};
      const n = Math.floor(rand() * 6);
      const keys = ['query', 'do', 'args', 'return', 'cache', '__proto__', 'constructor', ''];
      for (let i = 0; i < n; i += 1) {
        obj[keys[Math.floor(rand() * keys.length)]!] = randomJsonValue(rand, depth + 1);
      }
      return obj;
    }
  }
}

const ALLOWED_PARSE_CODES: Set<OrbitErrorCode> = new Set([
  ErrorCode.INVALID_QUERY,
  ErrorCode.MAX_DEPTH_EXCEEDED,
]);

describe('fuzz — parseOQS (no crash, only protocol errors)', () => {
  it('2000 adversarial strings never throw a non-OrbitError', () => {
    const rand = mulberry32(0x0ab17);
    for (let i = 0; i < 2000; i += 1) {
      const input = randomString(rand);
      try {
        const node = parseOQS(input);
        // When it parses, every identifier respects the caps and the depth
        // never exceeds the configured maximum.
        expect(treeDepth(node)).toBeLessThanOrEqual(10);
        expect(node.entity.length).toBeLessThanOrEqual(128);
        for (const key of Object.keys(node.filters)) {
          expect(key.length).toBeLessThanOrEqual(128);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OrbitError);
        expect(ALLOWED_PARSE_CODES.has((error as OrbitError).code)).toBe(true);
      }
    }
  });

  it('handcrafted adversarial seeds stay protocol errors', () => {
    const seeds = [
      'user(',
      'user()',
      'user(="x")',
      'user(id="a\\',
      'user(__proto__="x") { name }',
      'constructor.prototype.polluted="1" { name }',
      `user(id="${'a'.repeat(2000)}") { name }`,
      `${'a'.repeat(300)} { name }`,
      'user { ' + 'a, '.repeat(500) + 'b }',
      'user(id="1") { posts { author { posts { author { name } } } } }',
      'user(id="\\u0000\\uffff") { name }',
      'user(id="1"){name}user(id="2"){name}',
      'user(id="1") { name } trailing',
      '\u2028\u2029user{name}',
    ];
    for (const input of seeds) {
      try {
        parseOQS(input);
      } catch (error) {
        expect(error).toBeInstanceOf(OrbitError);
        expect(ALLOWED_PARSE_CODES.has((error as OrbitError).code)).toBe(true);
      }
    }
  });

  it('deeply nested queries fail with MAX_DEPTH_EXCEEDED, not a stack overflow', () => {
    const deep = 'user { ' + 'posts { '.repeat(200) + 'name' + ' }'.repeat(200) + ' }';
    expect(() => parseOQS(deep)).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_DEPTH_EXCEEDED }),
    );
  });
});

describe('fuzz — decodeMsgpack (no crash, no hang, fast fail)', () => {
  it('2000 random byte payloads either decode or throw a plain codec Error', () => {
    const rand = mulberry32(0x0f57c);
    for (let i = 0; i < 2000; i += 1) {
      const bytes = randomBytes(rand);
      try {
        const value = decodeMsgpack(bytes);
        // Successful decodes must be JSON-compatible values (never undefined
        // — undefined would break JSON serialization downstream).
        expect(value).not.toBeUndefined();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(RangeError);
        expect(String((error as Error).message)).toMatch(
          /Invalid MessagePack|Unsupported|Trailing/,
        );
      }
    }
  });

  it('a nesting bomb (100k fixarrays) throws a codec error, not a stack overflow', () => {
    const bomb = new Uint8Array(100_000).fill(0x91); // 0x91 = fixarray, 1 element
    expect(() => decodeMsgpack(bomb)).toThrowError(/Invalid MessagePack/);
  });

  it('declared-huge array32 with a truncated body fails fast (no allocation bomb)', () => {
    // array32 length = 0xffffffff, then EOF — must fail on the first element
    // read, not attempt 4 billion iterations.
    const truncated = new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeMsgpack(truncated)).toThrowError(/Invalid MessagePack/);
  });

  it('property: encode∘decode round-trips JSON values exactly', () => {
    const rand = mulberry32(0x0add5);
    for (let i = 0; i < 500; i += 1) {
      const value = randomJsonValue(rand);
      const decoded = decodeMsgpack(encodeMsgpack(value));
      expect(decoded).toEqual(value);
    }
  });
});

describe('fuzz — validateEnvelope (no crash, only protocol errors)', () => {
  it('1500 adversarial values never throw a non-OrbitError', () => {
    const rand = mulberry32(0x0e6e1);
    for (let i = 0; i < 1500; i += 1) {
      try {
        validateEnvelope(randomJsonValue(rand));
      } catch (error) {
        expect(error).toBeInstanceOf(OrbitError);
        expect((error as OrbitError).code).toBe(ErrorCode.INVALID_QUERY);
      }
    }
  });
});

describe('fuzz — parseCacheSpec (no crash, only protocol errors)', () => {
  it('1000 adversarial strings never throw a non-OrbitError', () => {
    const rand = mulberry32(0x0ca5e);
    for (let i = 0; i < 1000; i += 1) {
      try {
        const spec = parseCacheSpec(randomString(rand, 40));
        expect(spec.ttl === undefined || spec.ttl > 0).toBe(true);
        expect(spec.stale === undefined || spec.stale > 0).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(OrbitError);
        expect((error as OrbitError).code).toBe(ErrorCode.INVALID_QUERY);
      }
    }
  });
});

describe('fuzz — negotiateFormat (never throws, always a valid format)', () => {
  it('1000 adversarial Accept headers resolve deterministically', () => {
    const rand = mulberry32(0x0b3a7);
    for (let i = 0; i < 1000; i += 1) {
      const header = randomString(rand, 60);
      const format = negotiateFormat(header);
      expect(['json', 'msgpack', 'sse']).toContain(format);
    }
    // Adversarial q-value shapes never throw either.
    for (const header of [
      'application/x-msgpack;q=999',
      'text/event-stream;q=-1',
      'application/x-msgpack;q=NaN',
      'application/x-msgpack;q=, text/event-stream',
      ';q=1',
      'q=1',
      '*/*;q=0',
    ]) {
      expect(['json', 'msgpack', 'sse']).toContain(negotiateFormat(header));
    }
  });
});

describe('fuzz — engine.execute (always settles, only OrbitError rejects)', () => {
  const orbit = createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => ({ id: id ?? '1', name: 'Ana' }),
        mutate: () => ({ success: true }),
      },
    ]),
  });

  it('500 random envelopes reject only with OrbitError, never hang', async () => {
    const rand = mulberry32(0x0e9e6);
    for (let i = 0; i < 500; i += 1) {
      const value = randomJsonValue(rand);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const result = await orbit.execute(value as never).catch((error: unknown) => error);
      if (result instanceof Error) {
        expect(isOrbitError(result)).toBe(true);
        expect(result.message).not.toContain('stack');
      }
    }
  });

  it('engine-level msgpack envelopes: decode(validate) path is crash-free', async () => {
    const rand = mulberry32(0x0b0d7);
    for (let i = 0; i < 300; i += 1) {
      const bytes = randomBytes(rand, 80);
      let value: unknown;
      try {
        value = decodeMsgpack(bytes);
      } catch {
        continue; // codec rejected — the wire path sanitizes these
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const result = await orbit.execute(value as never).catch((error: unknown) => error);
      if (result instanceof Error) expect(isOrbitError(result)).toBe(true);
    }
  });
});
