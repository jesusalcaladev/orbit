import { describe, expect, it } from 'vitest';
import { negotiateFormat, wantsGzip } from '../src/serialize/negotiate.js';

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
});
