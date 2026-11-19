import { describe, expect, it, vi } from 'vitest';
import {
  createOrbit,
  encodeMsgpack,
  MSGPACK_CONTENT_TYPE,
  readEnvelopeBytes,
} from '../src/index.js';
import type { OrbitEnvelope } from '../src/index.js';

/**
 * Compressed request bodies (spec §7, additive): the handler accepts a
 * `content-encoding: gzip` envelope, bounds the INFLATED bytes (a decompression
 * bomb must not be able to grow past `maxPayloadBytes`), and refuses an
 * encoding it cannot honour instead of parsing garbage.
 */

async function gzip(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function world(maxPayloadBytes?: number) {
  return createOrbit({
    adapters: [{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }],
    ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
  });
}

/** POST raw bytes — the body is sent as-is, so compression is untouched. */
function post(body: BodyInit, headers: Record<string, string>): Request {
  return new Request('https://x.test/', { method: 'POST', headers, body });
}

const envelopeBytes = (envelope: OrbitEnvelope) =>
  new TextEncoder().encode(JSON.stringify(envelope)) as Uint8Array<ArrayBuffer>;

describe('request content-encoding — gzip (JSON)', () => {
  it('inflates a gzipped JSON envelope and answers normally', async () => {
    const orbit = world();
    const body = await gzip(envelopeBytes({ query: 'user(id="1") { name }' }));
    const response = await orbit.handler(
      post(body, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { name: 'Ana' } });
  });

  it('inflates a gzipped MessagePack envelope', async () => {
    const orbit = world();
    const body = await gzip(
      encodeMsgpack({ query: 'user(id="1") { name }' }) as Uint8Array<ArrayBuffer>,
    );
    const response = await orbit.handler(
      post(body, { 'content-type': MSGPACK_CONTENT_TYPE, 'content-encoding': 'gzip' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { name: 'Ana' } });
  });

  it('accepts an explicit identity body', async () => {
    const orbit = world();
    const response = await orbit.handler(
      post(envelopeBytes({ query: 'user(id="1") { name }' }), {
        'content-type': 'application/json',
        'content-encoding': 'identity',
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('request content-encoding — decompression mechanics', () => {
  it('reassembles a body that inflates across several chunks', async () => {
    // Blob.stream() hands the inflater ~64 KB chunks, so a payload past that
    // size exercises the concat path (a real agent write is exactly this).
    const orbit = createOrbit({
      adapters: [
        { entity: 'user', resolve: () => ({ id: '1' }), mutate: () => ({ success: true }) },
      ],
    });
    const bio = 'y'.repeat(200 * 1024);
    const body = await gzip(
      new TextEncoder().encode(
        JSON.stringify({ do: 'user.update', args: { payload: { bio } } }),
      ) as Uint8Array<ArrayBuffer>,
    );
    const response = await orbit.handler(
      post(body, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
    );
    expect(response.status).toBe(200);
  });

  it('answers 400 when the runtime has no DecompressionStream', async () => {
    const orbit = world();
    const body = await gzip(envelopeBytes({ query: 'user { name }' }));
    vi.stubGlobal('DecompressionStream', undefined);
    try {
      const response = await orbit.handler(
        post(body, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe('ORBIT_INVALID_QUERY');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('request content-encoding — bounds and rejections', () => {
  it('rejects an unsupported encoding with ORBIT_INVALID_QUERY', async () => {
    const orbit = world();
    const response = await orbit.handler(
      post(envelopeBytes({ query: 'user { name }' }), {
        'content-type': 'application/json',
        'content-encoding': 'deflate',
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: { encoding?: string } };
    };
    expect(body.error.code).toBe('ORBIT_INVALID_QUERY');
    expect(body.error.details?.encoding).toBe('deflate');
  });

  it('answers 400 for a Brotli body it cannot decode', async () => {
    // `br` is accepted at the protocol level; whether this runtime can inflate
    // it is a capability question — either way the answer is a protocol error,
    // never a crash or a silent misparse.
    const orbit = world();
    const response = await orbit.handler(
      post(envelopeBytes({ query: 'user { name }' }), {
        'content-type': 'application/json',
        'content-encoding': 'br',
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORBIT_INVALID_QUERY');
  });

  it('rejects corrupt gzip bytes without crashing', async () => {
    const orbit = world();
    const corrupt = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
    const response = await orbit.handler(
      post(corrupt, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORBIT_INVALID_QUERY');
  });

  it('caps the INFLATED size, so a small gzip bomb is a 413', async () => {
    // 1 KiB cap; the compressed body is a few hundred bytes and inflates to
    // far more — the cap must bound the expansion, not the upload.
    const orbit = world(1024);
    const padding = 'x'.repeat(64 * 1024);
    const body = await gzip(envelopeBytes({ query: `user(id="${padding}") { name }` }));
    expect(body.byteLength).toBeLessThan(1024);

    const response = await orbit.handler(
      post(body, { 'content-type': 'application/json', 'content-encoding': 'gzip' }),
    );
    expect(response.status).toBe(413);
    const payload = (await response.json()) as {
      error: { code: string; details?: { maxBytes?: number; received?: number } };
    };
    expect(payload.error.code).toBe('ORBIT_PAYLOAD_TOO_LARGE');
    expect(payload.error.details?.maxBytes).toBe(1024);
    expect(payload.error.details?.received).toBeGreaterThan(1024);
  });

  it("keeps the bytes reader's own cap for direct callers", async () => {
    // The handler caps before parsing, so this public reader is the last line
    // of defence for code that calls it directly.
    expect(() => readEnvelopeBytes(envelopeBytes({ query: 'user { name }' }), 4)).toThrowError(
      /payload exceeds/i,
    );
  });

  it('keeps the early content-length 413 for oversized compressed uploads', async () => {
    const orbit = world(64);
    const response = await orbit.handler(
      post(envelopeBytes({ query: 'user { name }' }), {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': '4096',
      }),
    );
    expect(response.status).toBe(413);
  });
});
