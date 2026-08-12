import { describe, expect, it } from 'vitest';
import { byteLength, fnv1a, fnv1a64, isRecord, isSerializedPayload } from '../src/utils.js';

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
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      const key = fnv1a64(`cache:user:${i}:${i * 2654435761}`);
      if (seen.has(key)) throw new Error(`fnv1a64 collision at input ${i}`);
      seen.add(key);
    }
    expect(seen.size).toBe(100_000);
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
