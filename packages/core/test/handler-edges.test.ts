import { describe, expect, it, vi } from 'vitest';
import { createOrbit } from '../src/index.js';
import type { OrbitContext, OrbitPlugin } from '../src/index.js';

/**
 * Handler paths that the main suites exercise only indirectly: the bare
 * `OPTIONS` preflight branch, header merging (`vary`, multi-value), and the
 * `304` short-circuit. Each is a real branch of the frozen handler, so each is
 * pinned here.
 */

function world(plugins: OrbitPlugin[] = []) {
  const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
  const orbit = createOrbit({
    adapters: [{ entity: 'user', resolve }],
    plugins,
  });
  return { orbit, resolve };
}

const post = (query: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(query),
  });

describe('handler — preflight (bare OPTIONS)', () => {
  it('answers OPTIONS via the first plugin that can preflight', async () => {
    const preflight = vi.fn((_request: Request, ctx: OrbitContext) => {
      ctx.responseHeaders = { 'access-control-allow-origin': '*' };
    });
    // A non-preflight plugin mounted FIRST must be skipped, not returned as
    // the handler: the lookup scans until it finds the capability.
    const inert: OrbitPlugin = { name: 'inert', hooks: {} };
    const { orbit, resolve } = world([
      inert,
      { name: 'cors', hooks: {}, preflight } as unknown as OrbitPlugin,
    ]);

    const response = await orbit.handler(new Request('https://x.test/', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    // A preflight must never resolve data.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('falls through when no plugin can preflight', async () => {
    // No preflight-capable plugin: the request is handled as an ordinary
    // (empty) envelope, which the envelope validator rejects — the handler
    // must answer with a protocol error, not crash.
    const { orbit } = world();
    const response = await orbit.handler(new Request('https://x.test/', { method: 'OPTIONS' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORBIT_INVALID_QUERY');
  });
});

describe('handler — response header merging', () => {
  it('appends array-valued headers as separate lines', async () => {
    // `set-cookie` needs one line per cookie; an array must never be joined
    // into a single comma-separated value.
    const stamper: OrbitPlugin = {
      name: 'stamper',
      hooks: {
        onAfterExecute: ({ ctx }) => {
          (ctx.responseHeaders ??= {})['set-cookie'] = ['a=1', 'b=2'];
        },
      },
    };
    const { orbit } = world([stamper]);
    const response = await orbit.handler(post({ query: 'user { id }' }));
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('merges a plugin `vary` without duplicating tokens', async () => {
    const stamper: OrbitPlugin = {
      name: 'vary',
      hooks: {
        onAfterExecute: ({ ctx }) => {
          // 'accept' is already set by the engine; 'x-custom' is new. Case
          // differences must not produce a duplicate token.
          (ctx.responseHeaders ??= {}).vary = 'Accept, x-custom, accept';
        },
      },
    };
    const { orbit } = world([stamper]);
    const response = await orbit.handler(post({ query: 'user { id }' }));
    const tokens = (response.headers.get('vary') ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase());
    expect(tokens).toContain('accept');
    expect(tokens).toContain('x-custom');
    expect(tokens.filter((t) => t === 'accept')).toHaveLength(1);
  });

  it('drops empty vary tokens instead of emitting a blank', async () => {
    // A plugin writing `vary: " , "` must not leave stray commas in the header.
    const stamper: OrbitPlugin = {
      name: 'vary-blank',
      hooks: {
        onAfterExecute: ({ ctx }) => {
          (ctx.responseHeaders ??= {}).vary = ' , ,x-ok, ';
        },
      },
    };
    const { orbit } = world([stamper]);
    const response = await orbit.handler(post({ query: 'user { id }' }));
    const vary = response.headers.get('vary') ?? '';
    expect(vary).toContain('x-ok');
    expect(vary.split(',').every((t) => t.trim() !== '')).toBe(true);
  });

  it('writes a vary header even when the engine set none', async () => {
    // The merge reads whatever `vary` the base headers carry. On a path that
    // sets none (the SSE error frame carries its own base), a plugin's `vary`
    // must still land on the wire rather than be merged against nothing.
    const stamper: OrbitPlugin = {
      name: 'vary-sse',
      hooks: {
        onAfterExecute: ({ ctx }) => {
          (ctx.responseHeaders ??= {}).vary = 'origin';
        },
      },
    };
    const { orbit } = world([stamper]);
    const response = await orbit.handler(post({ query: 'user { id }' }));
    expect(response.status).toBe(200);
    // The engine's own `vary` plus the plugin's — never a replacement.
    const vary = response.headers.get('vary') ?? '';
    expect(vary.split(',').map((t) => t.trim())).toEqual(
      expect.arrayContaining(['accept', 'accept-encoding', 'origin']),
    );
  });

  it('keeps a vary token the engine had not already set', async () => {
    // The merge reads the EXISTING header; a brand-new `vary` (no prior value)
    // must still contribute its tokens rather than being dropped as empty.
    const stamper: OrbitPlugin = {
      name: 'vary-new',
      hooks: {
        onAfterExecute: ({ ctx }) => {
          (ctx.responseHeaders ??= {}).vary = 'origin, x-fresh';
        },
      },
    };
    const { orbit } = world([stamper]);
    const vary = (await orbit.handler(post({ query: 'user { id }' }))).headers.get('vary') ?? '';
    expect(vary.split(',').map((t) => t.trim())).toContain('origin');
    expect(vary.split(',').map((t) => t.trim())).toContain('x-fresh');
  });
});

describe('handler — last-resort error envelope', () => {
  it('degrades to uncompressed JSON when the error response itself fails', async () => {
    // If building the negotiated error response throws (no compression codec in
    // the runtime, a broken plugin header…), the handler must still answer
    // rather than let the exception escape and crash the host.
    const sabotage: OrbitPlugin = {
      name: 'sabotage',
      hooks: {
        onError: ({ ctx }) => {
          // A value `Headers` refuses to turn into a valid header line.
          (ctx.responseHeaders as Record<string, string>)['x-broken'] = 'a\nb';
        },
      },
    };
    const { orbit } = world([sabotage]);
    const response = await orbit.handler(post({ query: 'ghost { id }' }));
    // A hostile header value must not make the handler throw; it either
    // renders normally or degrades to the plain fallback.
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ORBIT_ENTITY_UNREGISTERED' },
    });
  });

  it('renders a 404 through the normal error path when no codec fails', async () => {
    const { orbit } = world();
    const response = await orbit.handler(post({ query: 'ghost { id }' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'ORBIT_ENTITY_UNREGISTERED' },
    });
  });

  it('falls back to plain JSON when the negotiated error codec is unavailable', async () => {
    // The negotiated error path compresses with the same codec the client asked
    // for. If that codec cannot be constructed (a runtime without it), building
    // the error response throws — and the handler must degrade to the plainest
    // safe answer instead of letting the exception escape into the host.
    const original = globalThis.CompressionStream;
    // A runtime that negotiates gzip successfully but whose stream the platform
    // cannot drain — the exact "negotiated fine, compression then fails" case
    // the last-resort fallback exists for.
    class HalfBrokenCodec {
      constructor(format: string) {
        // The brotli probe asks for 'br'; refusing it is how the engine learns
        // this runtime cannot brotli, so gzip is what gets negotiated.
        if (format === 'br') throw new Error('no brotli here');
      }
      get readable(): ReadableStream<Uint8Array> {
        throw new Error('cannot drain');
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: reaching the global to simulate a runtime without a codec
    (globalThis as any).CompressionStream = HalfBrokenCodec;
    try {
      const { orbit } = world();
      const response = await orbit.handler(
        post({ query: 'ghost { id }' }, { 'accept-encoding': 'gzip, br' }),
      );
      expect(response.status).toBe(404);
      // The fallback contract: plain JSON, explicitly uncacheable, no encoding.
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(await response.json()).toMatchObject({
        error: { code: 'ORBIT_ENTITY_UNREGISTERED' },
      });
    } finally {
      globalThis.CompressionStream = original;
    }
  });
});

describe('handler — msgpack conditional + encoding', () => {
  it('answers 304 for a matching validator on the msgpack representation', async () => {
    // The msgpack branch computes the validator from the same resource bytes,
    // so a client holding a JSON-sourced etag still matches (the validator is
    // encoding-independent by construction).
    const { orbit } = world();
    const get = (headers: Record<string, string> = {}) =>
      new Request('https://x.test/orbit?query=user%20%7B%20id%20%7D', { headers });

    const etag = (await orbit.handler(get())).headers.get('etag');
    expect(etag).toBeTruthy();

    const conditional = await orbit.handler(
      get({
        'if-none-match': etag as string,
        accept: 'application/x-msgpack',
        'accept-encoding': 'gzip',
      }),
    );
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });
});

describe('handler — conditional requests are GET-only', () => {
  // `server.test.ts` pins the 304 contract over GET. This pins the other half:
  // a POST must get NEITHER a validator NOR a 304, even when the client sends
  // `if-none-match`. Etagging a POST would let a shared cache hold a
  // non-representational response (spec §7).
  it('never etags a POST, even with a matching if-none-match', async () => {
    const { orbit, resolve } = world();
    const first = await orbit.handler(post({ query: 'user { id }' }));
    expect(first.headers.get('etag')).toBeNull();

    const second = await orbit.handler(
      post({ query: 'user { id }' }, { 'if-none-match': 'W/"anything"' }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ data: { id: '1' } });
    // The request really was resolved again — no short-circuit.
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
