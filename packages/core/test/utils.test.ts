import { describe, expect, it } from 'vitest';
import { byteLength, fnv1a, isRecord, isSerializedPayload } from '../src/utils.js';

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

describe('isSerializedPayload', () => {
  it('detects string and Uint8Array bodies', () => {
    expect(isSerializedPayload({ body: 'x', contentType: 'text/plain' })).toBe(true);
    expect(isSerializedPayload({ body: new Uint8Array([1]), contentType: 'application/octet-stream' })).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSerializedPayload({ body: 42, contentType: 'text/plain' })).toBe(false);
    expect(isSerializedPayload({ body: 'x' })).toBe(false);
    expect(isSerializedPayload('x')).toBe(false);
    expect(isSerializedPayload(null)).toBe(false);
  });
});
