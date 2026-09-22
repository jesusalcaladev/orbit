import { describe, expect, it } from 'vitest';
import { etagFor, etagMatches } from '../src/serialize/etag.js';

const encoder = new TextEncoder();

describe('etagFor', () => {
  it('produces a weak, quoted validator', () => {
    expect(etagFor(encoder.encode('{"data":1}'))).toMatch(/^W\/"[0-9a-z]+"$/);
  });

  it('is deterministic and content-sensitive', () => {
    const a = etagFor(encoder.encode('a'));
    expect(etagFor(encoder.encode('a'))).toBe(a);
    expect(etagFor(encoder.encode('b'))).not.toBe(a);
  });

  it('hashes raw bytes, not a string decoding of them', () => {
    // 0xFF is not valid UTF-8: a decoder-based hash would collapse it to the
    // replacement character and collide with a different payload.
    const raw = etagFor(new Uint8Array([0xff]));
    expect(raw).not.toBe(etagFor(new Uint8Array([0xfe])));
  });
});

describe('etagMatches', () => {
  const etag = 'W/"abc123"';

  it('matches the same tag, with or without the weak prefix', () => {
    expect(etagMatches('W/"abc123"', etag)).toBe(true);
    expect(etagMatches('"abc123"', etag)).toBe(true);
    expect(etagMatches('  W/"abc123"  ', etag)).toBe(true);
  });

  it('matches within a comma-separated list', () => {
    expect(etagMatches('"stale", W/"abc123"', etag)).toBe(true);
    expect(etagMatches('"stale", "other"', etag)).toBe(false);
  });

  it('matches the wildcard', () => {
    expect(etagMatches('*', etag)).toBe(true);
  });

  it('rejects a different tag', () => {
    expect(etagMatches('"abc124"', etag)).toBe(false);
    expect(etagMatches('', etag)).toBe(false);
  });

  it('compares a strong client tag against a weak server tag', () => {
    expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
    expect(etagMatches('W/"abc123"', '"abc123"')).toBe(true);
  });
});
