import { describe, expect, it } from 'vitest';
import { negotiateEncoding, negotiateFormat, wantsGzip } from '../src/serialize/negotiate.js';

describe('negotiateFormat', () => {
  it('defaults to json when nothing is requested', () => {
    expect(negotiateFormat(null)).toBe('json');
    expect(negotiateFormat(undefined)).toBe('json');
    expect(negotiateFormat('')).toBe('json');
  });

  it('honors explicit formats', () => {
    expect(negotiateFormat('application/json')).toBe('json');
    expect(negotiateFormat('application/x-msgpack')).toBe('msgpack');
    expect(negotiateFormat('text/event-stream')).toBe('sse');
  });

  it('treats */* as json', () => {
    expect(negotiateFormat('*/*')).toBe('json');
    expect(negotiateFormat('application/json, */*')).toBe('json');
  });

  it('matches type wildcards (application/*)', () => {
    expect(negotiateFormat('application/*')).toBe('json');
    expect(negotiateFormat('application/*, application/x-msgpack')).toBe('msgpack');
    expect(negotiateFormat('text/*')).toBe('sse');
  });

  it('respects q-values', () => {
    expect(negotiateFormat('application/json;q=0.5, application/x-msgpack;q=0.8')).toBe('msgpack');
    expect(negotiateFormat('application/x-msgpack;q=0.5, application/json;q=1')).toBe('json');
  });

  it('ignores non-q parameters on media types (q stays the default)', () => {
    expect(negotiateFormat('application/json;charset=utf-8')).toBe('json');
    expect(negotiateFormat('application/x-msgpack;profile=orbit')).toBe('msgpack');
    expect(negotiateFormat('text/event-stream;charset=utf-8')).toBe('sse');
  });

  it('ignores q=0 entries and falls back', () => {
    expect(negotiateFormat('application/x-msgpack;q=0')).toBe('json');
    expect(negotiateFormat('application/x-msgpack;q=0, text/event-stream;q=0.5')).toBe('sse');
  });

  it('prefers the most specific format on ties', () => {
    expect(negotiateFormat('application/json, application/x-msgpack')).toBe('msgpack');
    expect(negotiateFormat('text/event-stream, application/json')).toBe('sse');
    // msgpack (rank 3) beats SSE (rank 2) when both are explicit at q=1.
    expect(negotiateFormat('text/event-stream, application/x-msgpack')).toBe('msgpack');
  });

  it('an explicit format beats a wildcard at equal q', () => {
    expect(negotiateFormat('text/event-stream, */*')).toBe('sse');
    expect(negotiateFormat('application/x-msgpack, text/*')).toBe('msgpack');
    expect(negotiateFormat('application/x-msgpack, application/*')).toBe('msgpack');
  });

  it('a higher-q wildcard beats an explicit format at lower q', () => {
    expect(negotiateFormat('application/x-msgpack;q=0.5, */*;q=1')).toBe('json');
    expect(negotiateFormat('text/event-stream;q=0.2, application/json;q=0.9')).toBe('json');
  });

  it('is case- and space-insensitive', () => {
    expect(negotiateFormat(' APPLICATION/X-MSGPACK ')).toBe('msgpack');
  });

  it('fast path: non-binary Accept headers resolve to json', () => {
    expect(negotiateFormat('text/html')).toBe('json');
    expect(negotiateFormat('application/problem+json')).toBe('json');
    expect(negotiateFormat('image/png, text/html')).toBe('json');
    expect(negotiateFormat('application/vnd.api+json')).toBe('json');
  });
});

describe('wantsGzip', () => {
  it('is false without the header', () => {
    expect(wantsGzip(null)).toBe(false);
    expect(wantsGzip('')).toBe(false);
  });

  it('detects gzip among other encodings', () => {
    expect(wantsGzip('gzip')).toBe(true);
    expect(wantsGzip('br, gzip')).toBe(true);
    expect(wantsGzip('br')).toBe(false);
    expect(wantsGzip('identity')).toBe(false);
  });

  it('rejects gzip with q=0', () => {
    expect(wantsGzip('gzip;q=0')).toBe(false);
    expect(wantsGzip('br, gzip;q=0')).toBe(false);
  });

  it('accepts gzip with a positive q', () => {
    expect(wantsGzip('gzip;q=1')).toBe(true);
    expect(wantsGzip('gzip;q=0.5')).toBe(true);
  });

  it('accepts gzip through the wildcard', () => {
    // `*` means "any of the remaining codecs" — gzip qualifies.
    expect(wantsGzip('*')).toBe(true);
    expect(wantsGzip('*;q=0')).toBe(false);
  });
});

describe('negotiateEncoding', () => {
  it('is null without the header', () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
    expect(negotiateEncoding('')).toBeNull();
    expect(negotiateEncoding('identity')).toBeNull();
  });

  it('is null when no acceptable codec is supported by the runtime', () => {
    // Node without `CompressionStream('br')` must never answer `content-encoding: br`.
    expect(negotiateEncoding('br', { brotli: false })).toBeNull();
    expect(negotiateEncoding('br, gzip;q=0', { brotli: false })).toBeNull();
  });

  it('prefers brotli over gzip when both are acceptable and supported', () => {
    // Brotli compresses text ~15-20 % smaller than gzip, so it wins the tie.
    expect(negotiateEncoding('gzip, deflate, br', { brotli: true })).toBe('br');
    expect(negotiateEncoding('gzip, br', { brotli: true })).toBe('br');
  });

  it('falls back to gzip when brotli is unsupported or not offered', () => {
    expect(negotiateEncoding('br, gzip', { brotli: false })).toBe('gzip');
    expect(negotiateEncoding('gzip', { brotli: true })).toBe('gzip');
  });

  it('honours q-values, including a client-preferred gzip', () => {
    expect(negotiateEncoding('gzip;q=1, br;q=0.5', { brotli: true })).toBe('gzip');
    expect(negotiateEncoding('gzip;q=0.2, br;q=0.9', { brotli: true })).toBe('br');
  });

  it('ignores malformed q-values instead of refusing the codec', () => {
    // A hostile or buggy client sends a non-numeric q. Refusing the codec
    // entirely would let `Accept-Encoding: gzip;q=NaN` disable compression for
    // a response that CAN be compressed — a trivial amplification lever. The
    // q is ignored (treated as 1) and the codec is still honoured.
    for (const header of [
      'gzip;q=NaN',
      'gzip;q=abc',
      'gzip;q=',
      'gzip;q',
      'gzip;level=9',
      'gzip; q = 0.8',
    ]) {
      expect(negotiateEncoding(header, { brotli: false })).toBe('gzip');
    }
  });

  it('rejects a codec disabled with q=0', () => {
    expect(negotiateEncoding('br;q=0, gzip', { brotli: true })).toBe('gzip');
    expect(negotiateEncoding('gzip;q=0, br', { brotli: true })).toBe('br');
    expect(negotiateEncoding('br;q=0, gzip;q=0', { brotli: true })).toBeNull();
  });

  it('expands the wildcard to the best supported codec', () => {
    expect(negotiateEncoding('*', { brotli: true })).toBe('br');
    expect(negotiateEncoding('*', { brotli: false })).toBe('gzip');
  });
});
