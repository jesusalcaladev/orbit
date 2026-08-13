import { beforeEach, describe, expect, it } from 'vitest';
import { createOrbit, memoryAdapter } from '../src/index.js';
import { ErrorCode, OrbitError } from '../src/errors.js';

const users = [{ id: '1', name: 'Ana' }];

beforeEach(() => {
  users[0]!.name = 'Ana'; // mutation tests must not leak into others
});

function makeOrbit(overrides: Partial<Parameters<typeof createOrbit>[0]> = {}) {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => users.find((u) => u.id === id),
        mutate: (action, { payload }) => {
          if (action === 'update') Object.assign(users[0]!, payload ?? {});
          return { id: users[0]!.id, invalidates: ['cache:user:1'] };
        },
      },
    ]),
    ...overrides,
  });
}

function post(envelope: unknown): Request {
  return new Request('http://localhost/orbit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

describe('handler', () => {
  it('serves a query as JSON', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ data: { name: 'Ana' } });
  });

  it('serves mutations with data and invalidates', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      post({ do: 'user.update', args: { filter: { id: '1' }, payload: { name: 'Ana P.' } } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { success: true, id: '1' },
      invalidates: ['cache:user:1'],
    });
  });

  it('serves mutations with a return graph', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      post({
        do: 'user.update',
        args: { filter: { id: '1' }, payload: { name: 'Ana R.' } },
        return: 'user(id="1") { name }',
      }),
    );
    expect(await response.json()).toEqual({
      data: { name: 'Ana R.' },
      invalidates: ['cache:user:1'],
    });
  });

  it('returns structured errors with proper status codes', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'ghost { id }' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'ORBIT_ENTITY_UNREGISTERED',
        message: expect.stringContaining('ghost'),
        details: { entity: 'ghost' },
      },
    });
  });

  it('returns 400 for a syntax error', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'user(id="1' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('returns 400 for invalid envelopes', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ nope: true }));
    expect(response.status).toBe(400);
  });

  it('returns 400 for non-JSON bodies', async () => {
    const orbit = makeOrbit();
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('returns 413 when the payload exceeds the limit', async () => {
    const orbit = makeOrbit({ maxPayloadBytes: 64 });
    const big = 'x'.repeat(200);
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `user(name="${big}")` }),
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('serves non-JSON payloads produced by plugins as-is', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: `name:${(data as { name: string }).name}`,
              contentType: 'text/csv',
            }),
          },
        },
      ],
    });
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(await response.text()).toBe('name:Ana');
  });

  it('degrades to plain responses when CompressionStream is unavailable (spec §7)', async () => {
    const orbit = makeOrbit();
    // Spec §7 conditions gzip on "when the runtime provides CompressionStream"
    // — the handler must feature-check, not trust the header alone (a runtime
    // without it would otherwise 500 inside `new CompressionStream('gzip')`).
    const key = 'CompressionStream' as keyof typeof globalThis;
    const original = globalThis[key];
    try {
      (globalThis as unknown as { CompressionStream?: unknown }).CompressionStream = undefined;
      const request = new Request('http://localhost/orbit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
        body: JSON.stringify({ query: 'user(id="1") { name }' }),
      });
      const response = await orbit.handler(request);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(await response.json()).toEqual({ data: { name: 'Ana' } });
    } finally {
      (globalThis as unknown as Record<string, unknown>)[key] = original;
    }
  });

  it('passes request headers through to plugins', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'header-check',
          hooks: {
            onBeforeResolve: ({ ctx }) => {
              if (ctx.headers?.get('x-debug') !== '1') {
                throw Object.assign(new Error('missing header'), { orbit: true });
              }
            },
          },
        },
      ],
    });
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debug': '1' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(200);
  });

  it('tags every negotiated response with vary: accept, accept-encoding', async () => {
    const orbit = makeOrbit();
    const json = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(json.headers.get('vary')).toBe('accept, accept-encoding');

    const mp = await orbit.handler(
      new Request('http://localhost/orbit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-msgpack',
        },
        body: JSON.stringify({ query: 'user(id="1") { name }' }),
      }),
    );
    expect(mp.headers.get('vary')).toBe('accept, accept-encoding');

    // Plugin-serialized bodies are negotiated too.
    const csvOrbit = makeOrbit({
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: `name:${(data as { name: string }).name}`,
              contentType: 'text/csv',
            }),
          },
        },
      ],
    });
    const csv = await csvOrbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(csv.headers.get('vary')).toBe('accept, accept-encoding');
  });

  it('marks error responses cache-control: no-store', async () => {
    const orbit = makeOrbit();
    const notFound = await orbit.handler(post({ query: 'ghost { id }' }));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('cache-control')).toBe('no-store');
    expect(notFound.headers.get('vary')).toBe('accept, accept-encoding');

    const bad = await orbit.handler(post({ nope: true }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });

  it('merges pipeline-set responseHeaders into the response (set-cookie included)', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'cookie-jar',
          hooks: {
            onBeforeResolve: ({ ctx }) => {
              ctx.responseHeaders = {
                'set-cookie': ['sid=abc; HttpOnly; Path=/; SameSite=Lax', 'theme=dark; Path=/'],
                'x-powered-by': 'orbit',
              };
            },
          },
        },
      ],
    });
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-powered-by')).toBe('orbit');
    // Multiple cookies survive as separate header lines (never ", "-joined).
    expect(response.headers.getSetCookie()).toEqual([
      'sid=abc; HttpOnly; Path=/; SameSite=Lax',
      'theme=dark; Path=/',
    ]);
  });

  it('merges responseHeaders set by an adapter during a mutation (login cookie)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'session',
          resolve: () => null,
          mutate: (_action, _args, ctx) => {
            ctx.responseHeaders = {
              'set-cookie': 'session=token123; HttpOnly; Path=/; Max-Age=3600',
            };
            return { success: true, id: 's1' };
          },
        },
      ]),
    });
    const response = await orbit.handler(post({ do: 'session.login', args: {} }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      'session=token123; HttpOnly; Path=/; Max-Age=3600',
    ]);
  });

  it('merges caller-provided responseHeaders into SSE responses', async () => {
    const orbit = makeOrbit();
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'user { id }' }),
    });
    // Pipeline-set headers arrive too late for SSE (headers are sent when the
    // stream starts) — the handler's ctx option is the supported channel.
    const response = await orbit.handler(request, {
      responseHeaders: { 'x-stream-id': 'sse-1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-stream-id')).toBe('sse-1');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('delivers responseHeaders set before a throwing pipeline step (error path)', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'cookie-then-fail',
          hooks: {
            onBeforeResolve: ({ ctx }) => {
              ctx.responseHeaders = { 'set-cookie': 'session=partial; Path=/' };
              throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'denied after cookie');
            },
          },
        },
      ],
    });
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(response.status).toBe(403);
    // The cookie still rides out with the error response.
    expect(response.headers.getSetCookie()).toEqual(['session=partial; Path=/']);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('surfaces responseHeaders through execute() for programmatic callers', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'header-jar',
          hooks: {
            onBeforeResolve: ({ ctx }) => {
              ctx.responseHeaders = { 'x-debug-echo': 'yes' };
            },
          },
        },
      ],
    });
    const ctx: { responseHeaders?: Record<string, string | string[]> } = {};
    const result = await orbit.execute({ query: 'user(id="1") { name }' }, ctx);
    expect(result.status).toBe(200);
    expect(ctx.responseHeaders).toEqual({ 'x-debug-echo': 'yes' });
  });
});
