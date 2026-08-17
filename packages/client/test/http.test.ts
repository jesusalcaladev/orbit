import { describe, expect, it } from 'vitest';
import { ErrorCode, decodeMsgpack, encodeMsgpack } from '@orbit/core';
import { OrbitClient, OrbitError, OrbitNetworkError } from '../src/index.js';
import { gzipBytes, hangingFetch, jsonRes, mockFetch } from './helpers.js';

const textEncoder = new TextEncoder();

describe('headers & wire format', () => {
  it('sends a JSON envelope with content-type/accept by default', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { ok: true } }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const res = await client.query('user(id="1") { name }');

    expect(res.data).toEqual({ ok: true });
    const { url, init } = capture[0]!;
    expect(url).toBe('/orbit');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('accept-encoding')).toBe('gzip');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'user(id="1") { name }' });
  });

  it('omits accept-encoding when gzip is disabled', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl, gzip: false });
    await client.query('user { id }');
    expect(new Headers(capture[0]!.init.headers).get('accept-encoding')).toBeNull();
  });

  it('merges client headers and per-request headers (request wins)', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      headers: { 'x-orbit-token': 'abc', 'x-default': 'yes' },
    });
    await client.query('user { id }', { headers: { 'x-request': '1', 'x-orbit-token': 'new' } });
    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('x-orbit-token')).toBe('new');
    expect(headers.get('x-default')).toBe('yes');
    expect(headers.get('x-request')).toBe('1');
  });

  it('sends a MessagePack envelope and decodes a MessagePack response', async () => {
    const { fetchImpl, capture } = mockFetch(
      () =>
        new Response(
          encodeMsgpack({
            data: { n: 1 },
            fromCache: true,
            invalidates: ['cache:user:1'],
          }),
          { status: 200, headers: { 'content-type': 'application/x-msgpack' } },
        ),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl, format: 'msgpack' });
    const res = await client.query('user(id="1") { name }');

    expect(res.data).toEqual({ n: 1 });
    expect(res.fromCache).toBe(true);
    expect(res.invalidates).toEqual(['cache:user:1']);

    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('content-type')).toBe('application/x-msgpack');
    expect(headers.get('accept')).toBe('application/x-msgpack');
    expect(decodeMsgpack(capture[0]!.init.body as unknown as Uint8Array)).toEqual({
      query: 'user(id="1") { name }',
    });
  });

  it('decodes a gzipped response via DecompressionStream', async () => {
    const compressed = await gzipBytes(textEncoder.encode('{"data":{"ok":true}}'));
    const { fetchImpl } = mockFetch(
      () =>
        new Response(compressed, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const res = await client.query('user { ok }');
    expect(res.data).toEqual({ ok: true });
  });
});

describe('success parsing (spec §6)', () => {
  it('returns data, status and headers', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(JSON.stringify({ data: { name: 'Ana' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-orbit-cache': 'miss' },
        }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const res = await client.query('user(id="1") { name }');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ name: 'Ana' });
    expect(res.headers.get('x-orbit-cache')).toBe('miss');
    expect(res.raw).toBeInstanceOf(Response);
  });

  it('treats fromCache:false and non-array invalidates as absent', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonRes({ data: { n: 1 }, fromCache: false, invalidates: 'x' }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const res = await client.query('user { n }');
    expect(res.fromCache).toBeUndefined();
    expect(res.invalidates).toBeUndefined();
  });

  it('does not map a 2xx body containing an error-shaped field to an error', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ data: { error: 'just-data' } }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const res = await client.query('user { error }');
    expect(res.data).toEqual({ error: 'just-data' });
  });

  it('throws OrbitNetworkError for a 2xx non-record payload', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes([1, 2, 3]));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('throws OrbitNetworkError for an empty 2xx body', async () => {
    const { fetchImpl } = mockFetch(() => new Response(null, { status: 200 }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Invalid response payload',
    });
  });
});

describe('error mapping (spec §6)', () => {
  it('throws OrbitError with code/status/message/details', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonRes(
        {
          error: {
            code: ErrorCode.ENTITY_UNREGISTERED,
            message: "No adapter is registered for entity 'ghost'",
            details: { entity: 'ghost' },
          },
        },
        404,
      ),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await client.query('ghost { id }');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      const err = error as OrbitError;
      expect(err.code).toBe(ErrorCode.ENTITY_UNREGISTERED);
      expect(err.status).toBe(404);
      expect(err.message).toContain('ghost');
      expect(err.details).toEqual({ entity: 'ghost' });
    }
  });

  it('throws OrbitError with a default message when message is not a string', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonRes({ error: { code: ErrorCode.INTERNAL, message: 42 } }, 500),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await client.query('user { id }');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      expect((error as OrbitError).message).toBe('Orbit request failed');
      expect((error as OrbitError).status).toBe(500);
    }
  });

  it('throws OrbitNetworkError when error.code is not a string', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ error: { code: 5 } }, 404));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('throws OrbitNetworkError when the error field is not an object', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ error: 'oops' }, 500));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('throws OrbitNetworkError for a body that does not speak the error contract', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ oops: true }, 500));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Orbit request failed with HTTP 500',
    });
  });

  it('throws OrbitNetworkError with the status for an empty error body', async () => {
    const { fetchImpl } = mockFetch(() => new Response(null, { status: 404 }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      name: 'OrbitNetworkError',
      status: 404,
    });
  });
});

describe('transport failures', () => {
  it('wraps a network rejection in OrbitNetworkError with cause', async () => {
    const boom = new Error('ECONNREFUSED');
    const { fetchImpl } = mockFetch(() => {
      throw boom;
    });
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await client.query('user { id }');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitNetworkError);
      expect((error as OrbitNetworkError).message).toBe('Network request failed');
      expect((error as OrbitNetworkError).cause).toBe(boom);
    }
  });

  it('wraps a non-Error rejection too (fetch can throw anything)', async () => {
    const { fetchImpl } = mockFetch(() => {
      throw 'connection dropped'; // a string, not an Error
    });
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      name: 'OrbitNetworkError',
      message: 'Network request failed',
    });
  });

  it('propagates an abort as-is (not wrapped)', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    const promise = client.query('user { id }', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts after timeoutMs', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }', { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('combines an external signal with a timeout', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    const promise = client.query('user { id }', { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('honors an already-aborted signal', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(client.query('user { id }', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('cancels immediately when a pre-aborted signal is combined with a timeout', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.query('user { id }', { signal: controller.signal, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws OrbitNetworkError when decompression fails', async () => {
    const gzipped = await gzipBytes(textEncoder.encode('{"data":{}}'));
    const { fetchImpl } = mockFetch(
      () =>
        new Response(gzipped, {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        }),
    );
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      decompress: async () => {
        throw new Error('no gunzip here');
      },
    });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Failed to decompress response',
    });
  });

  it('handles a gzip body with no body stream as an empty payload', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Invalid response payload',
    });
  });

  it('throws OrbitNetworkError when reading the body fails', async () => {
    const fakeRes = {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => {
        throw new Error('stream closed');
      },
    } as unknown as Response;
    const { fetchImpl } = mockFetch(() => fakeRes);
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Failed to read response body',
    });
  });

  it('throws OrbitNetworkError for an invalid MessagePack response body', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(new Uint8Array([0xc1, 0xff]), {
          status: 200,
          headers: { 'content-type': 'application/x-msgpack' },
        }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Failed to decode MessagePack response',
    });
  });

  it('throws OrbitNetworkError for an invalid JSON response body', async () => {
    // A byte body carries no auto content-type (undici sets one only for
    // string/Blob/FormData bodies) — exercises the missing-content-type path.
    const { fetchImpl } = mockFetch(
      () => new Response(textEncoder.encode('not json'), { status: 200 }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(client.query('user { id }')).rejects.toMatchObject({
      message: 'Failed to parse JSON response',
    });
  });
});
