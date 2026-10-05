import { describe, expect, it } from 'vitest';
import {
  byteLength,
  fnv1a,
  fnv1a64,
  isRecord,
  isSerializedPayload,
  stableStringify,
  traceId,
} from '../src/utils.js';

describe('isRecord', () => {
  it('narrows plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('rejects arrays, null and primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('byteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(byteLength('hello')).toBe(5);
    expect(byteLength('héllo')).toBe(6);
    expect(byteLength('🔮')).toBe(4);
  });
});

describe('fnv1a', () => {
  it('is deterministic', () => {
    expect(fnv1a('user')).toBe(fnv1a('user'));
  });

  it('produces short stable strings', () => {
    expect(fnv1a('orbit')).toMatch(/^[0-9a-z]+$/);
    expect(fnv1a('orbit').length).toBeLessThanOrEqual(7);
  });

  it('differs for distinct inputs', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });
});

describe('fnv1a64', () => {
  it('is deterministic and longer than the 32-bit variant', () => {
    expect(fnv1a64('user')).toBe(fnv1a64('user'));
    expect(fnv1a64('orbit')).toMatch(/^[0-9a-z]+$/);
    expect(fnv1a64('orbit').length).toBeGreaterThan(fnv1a('orbit').length);
  });

  it('differs for distinct inputs', () => {
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
  });

  it('keeps the 32-bit collision bound out of reach for cache keys', () => {
    // 100k distinct inputs — a single 32-bit hash has a ~1/3 chance of at
    // least one collision at this scale; 64-bit must have zero.
    //
    // ~100k hashes is genuinely CPU-bound and exceeds vitest's default 5 s
    // timeout on a loaded machine (the whole suite runs files in parallel), so
    // the budget is stated explicitly: this asserts a property of the hash,
    // not a speed.
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      const key = fnv1a64(`cache:user:${i}:${i * 2654435761}`);
      if (seen.has(key)) throw new Error(`fnv1a64 collision at input ${i}`);
      seen.add(key);
    }
    expect(seen.size).toBe(100_000);
  }, 60_000);
});

describe('stableStringify', () => {
  it('is order-independent for objects', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('canonicalizes arrays and nested structures', () => {
    // Arrays keep their order (it is data), but their ELEMENTS are canonical,
    // so an array of objects keys off content rather than insertion order.
    expect(stableStringify([{ a: 1, b: 2 }])).toBe(stableStringify([{ b: 2, a: 1 }]));
    expect(stableStringify([1, 'two', true, null])).toBe('[1,"two",true,null]');
    expect(stableStringify({ list: [{ x: 1 }, 2] })).toBe('{"list":[{"x":1},2]}');
    // Order within an array IS significant and must not be normalized away.
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('refuses anything not losslessly representable', () => {
    // `undefined` is the signal to fall back to a safe path — a lossy key
    // would let two different values collide on one cache entry.
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      () => {},
      Symbol('s'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Set(),
      new (class Thing {})(),
      cyclic,
      [1, () => {}],
    ]) {
      expect(stableStringify(value)).toBeUndefined();
    }
  });

  it('keeps primitives, nulls and plain objects', () => {
    // A FINITE number must round-trip through the canonical form; the
    // non-finite half of the guard is pinned by the refusal test above.
    expect(stableStringify(1.5)).toBe('1.5');
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('a')).toBe('"a"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
    expect(stableStringify(10n)).toBe('"10"');
    expect(stableStringify({})).toBe('{}');
    expect(stableStringify([])).toBe('[]');
  });
});

describe('isSerializedPayload', () => {
  it('detects string and Uint8Array bodies', () => {
    expect(isSerializedPayload({ body: 'x', contentType: 'text/plain' })).toBe(true);
    expect(
      isSerializedPayload({ body: new Uint8Array([1]), contentType: 'application/octet-stream' }),
    ).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSerializedPayload({ body: 42, contentType: 'text/plain' })).toBe(false);
    expect(isSerializedPayload({ body: 'x' })).toBe(false);
    expect(isSerializedPayload('x')).toBe(false);
    expect(isSerializedPayload(null)).toBe(false);
  });
});

describe('traceId', () => {
  it('returns unique, well-formed ids', () => {
    const a = traceId();
    const b = traceId();
    expect(a).not.toBe(b);
    // UUID form when Web Crypto is available (Node ≥ 19 — the test runtimes);
    // the time-random fallback otherwise.
    expect(a).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  });

  it('falls back to time-random ids without Web Crypto', () => {
    // `globalThis.crypto` is a getter-only own property on modern Node —
    // assignment throws. Redefine it (configurable in Node/Bun) so the
    // fallback branch is exercised without depending on setter support.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const id = traceId();
      // Base36 time bucket + base36 random tail — unique across calls.
      expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
      expect(id).not.toBe(traceId());
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else Reflect.deleteProperty(globalThis as unknown as object, 'crypto');
    }
  });
});
