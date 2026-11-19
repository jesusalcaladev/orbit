import { describe, expect, it } from 'vitest';
import { OrbitClient } from '../src/index.js';
import { jsonRes, mockFetch } from './helpers.js';

/**
 * Request compression (spec §7, additive): with `compressRequests` the client
 * gzips the envelope — but only when it pays off, and never at the cost of a
 * working request on a runtime without a gzip codec.
 */

const decoder = new TextDecoder();

function decodeGzip(body: Uint8Array<ArrayBufferLike>): Promise<unknown> {
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text().then((text) => JSON.parse(text));
}

/** Bodies travel as bytes once compression is opted in, as a string otherwise. */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === 'string') return JSON.parse(body);
  return JSON.parse(decoder.decode(body as Uint8Array));
}

/** A query long enough to clear the 512-byte compression threshold. */
const bigQuery = `user(id="1") { ${Array.from(
  { length: 60 },
  (_, i) => `selectedFieldNumber${i}`,
).join(', ')} }`;
const bigBody = () => ({ query: bigQuery });

describe('request compression — option wiring', () => {
  it('sends the envelope uncompressed by default', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.query(bigQuery);
    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual(bigBody());
  });

  it('gzips a large envelope when compressRequests is on', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl, compressRequests: true });
    await client.query(bigQuery);

    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('content-encoding')).toBe('gzip');
    expect(headers.get('content-type')).toBe('application/json');
    const body = capture[0]!.init.body as Uint8Array<ArrayBuffer>;
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    expect(await decodeGzip(body)).toEqual(bigBody());
  });

  it('gzips a MessagePack envelope too', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      compressRequests: true,
      format: 'msgpack',
    });
    await client.query(bigQuery);
    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('content-encoding')).toBe('gzip');
    expect(headers.get('content-type')).toBe('application/x-msgpack');
    expect(capture[0]!.init.body).toBeInstanceOf(Uint8Array);
  });

  it('leaves a small envelope uncompressed (the frame overhead would grow it)', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl, compressRequests: true });
    await client.query('user { id }');
    expect(new Headers(capture[0]!.init.headers).get('content-encoding')).toBeNull();
    expect(parseBody(capture[0]!.init.body)).toEqual({ query: 'user { id }' });
  });

  it('falls back to an uncompressed body when the codec is unavailable', async () => {
    // React Native/Hermes: no CompressionStream. The request must still work.
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      compressRequests: true,
      compress: async () => {
        throw new Error('no gzip on this runtime');
      },
    });
    await client.query(bigQuery);
    expect(new Headers(capture[0]!.init.headers).get('content-encoding')).toBeNull();
    expect(parseBody(capture[0]!.init.body)).toEqual(bigBody());
  });

  it('keeps the raw body when gzip makes it bigger', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      compressRequests: true,
      compress: async (body) => new Uint8Array(body.byteLength + 8),
    });
    await client.query(bigQuery);
    expect(new Headers(capture[0]!.init.headers).get('content-encoding')).toBeNull();
    expect(parseBody(capture[0]!.init.body)).toEqual(bigBody());
  });

  it('compresses SSE request bodies the same way', async () => {
    const { fetchImpl, capture } = mockFetch(
      () =>
        new Response('data: {"level":"done","data":{}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl, compressRequests: true });
    for await (const _frame of client.stream(bigQuery)) {
      // drain
    }
    const headers = new Headers(capture[0]!.init.headers);
    expect(headers.get('content-encoding')).toBe('gzip');
    expect(await decodeGzip(capture[0]!.init.body as Uint8Array<ArrayBuffer>)).toEqual(bigBody());
  });
});
