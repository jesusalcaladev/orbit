/**
 * End-to-end tests for @orbit/cloudflare-workers.
 *
 * The whole package is tested in plain Node: `worker.fetch` is a standard
 * fetch handler, and the realtime session is driven over a fake `WsSocket`
 * (the Workers WebSocket surface is a stable, documented subset). The only
 * workerd-only path — the `WebSocketPair` upgrade — is exercised by stubbing
 * the global with the fake socket.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCachePlugin,
  createOrbit,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
  type DataAdapter,
  type SubscriptionEvent,
} from '@orbit/core';
import { createRealtimeSession, createWorker, handleWebSocket } from '../src/index.js';
import type { WsEvent } from '../src/websocket.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(10);
  }
}

/** A fake Workers WebSocket satisfying the structural WsSocket surface. */
class FakeWs {
  accepted = false;
  sent: Array<string | ArrayBuffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  #listeners = new Map<string, Set<(event: WsEvent) => void>>();

  accept(): void {
    this.accepted = true;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.dispatch('close', { code, reason });
  }

  addEventListener(type: 'message' | 'close', listener: (event: WsEvent) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  /** Test helper — simulate an incoming client frame. */
  dispatch(type: 'message' | 'close', event: WsEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  sendJson(message: unknown): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  sendMsgpack(message: unknown): void {
    this.dispatch('message', { data: encodeMsgpack(message).slice().buffer });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) =>
      typeof frame === 'string'
        ? (JSON.parse(frame) as Record<string, unknown>)
        : (decodeMsgpack(new Uint8Array(frame)) as Record<string, unknown>),
    );
  }

  lastFrame(): Record<string, unknown> {
    const frames = this.frames();
    const last = frames[frames.length - 1];
    if (!last) throw new Error('no frames sent');
    return last;
  }
}

/** A tiny post world: resolve/mutate/subscribe wired to one in-memory store. */
function createWorld(options: { cache?: boolean } = {}) {
  const posts = new Map<string, { id: string; title: string }>();
  const handlers = new Set<(event: SubscriptionEvent) => void>();

  const adapter: DataAdapter = {
    entity: 'post',
    resolve: (filters) => (filters.id ? posts.get(filters.id) : [...posts.values()]),
    mutate: (_action, args) => {
      const payload = args.payload as { id: string; title: string };
      if (!payload) return { id: undefined };
      posts.set(payload.id, payload);
      const event: SubscriptionEvent = {
        type: 'created',
        id: payload.id,
        data: payload,
        patch: { id: payload.id, title: payload.title },
      };
      for (const handler of handlers) handler(event);
      return { id: payload.id };
    },
    subscribe: (_filters, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const orbit = createOrbit({
    adapters: [adapter],
    ...(options.cache ? { plugins: [createCachePlugin()] } : {}),
  });
  const create = (payload: { id: string; title: string }) =>
    orbit.execute({ do: 'post.create', args: { payload: { ...payload } } });

  return { orbit, create, handlers };
}

const jsonPost = (request: Request, body: unknown): Request =>
  new Request(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('createWorker — the fetch handler', () => {
  it('answers JSON queries on the default mount path', async () => {
    const { orbit } = createWorld();
    const worker = createWorker({ orbit });
    await orbit.execute({ do: 'post.create', args: { payload: { id: 'p1', title: 'Hola' } } });

    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), {
        query: 'post { id, title }',
      }),
      {},
      {},
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ data: [{ id: 'p1', title: 'Hola' }] });
  });

  it('mounts at a custom path', async () => {
    const { orbit } = createWorld();
    const worker = createWorker({ orbit, path: '/orbit' });

    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/orbit'), {
        query: 'post { id }',
      }),
      {},
      {},
    );

    expect(res.status).toBe(200);
  });

  it('falls back for paths outside the mount (and passes env through)', async () => {
    const { orbit } = createWorld();
    const fallback = vi.fn((_request: Request, env: { region: string }) =>
      Response.json({ region: env.region }),
    );
    const worker = createWorker<{ region: string }, unknown>({ orbit, fallback });

    const res = await worker.fetch(
      new Request('https://example.com/health'),
      { region: 'test' },
      {},
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ region: 'test' });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unknown paths when there is no fallback', async () => {
    const { orbit } = createWorld();
    const worker = createWorker({ orbit });

    const res = await worker.fetch(new Request('https://example.com/other'), {}, {});
    expect(res.status).toBe(404);
  });

  it('answers a clear 500 in the standard error shape on the realtime path for a handler-function orbit', async () => {
    const worker = createWorker({ orbit: async () => new Response('ok') });
    const res = await worker.fetch(
      new Request('https://example.com/realtime', { headers: { upgrade: 'websocket' } }),
      {},
      {},
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ORBIT_INTERNAL');
    expect(body.error.message).toContain('createOrbit()');
  });

  it('does not mount the realtime route when realtime is false', async () => {
    const { orbit } = createWorld();
    const worker = createWorker({ orbit, realtime: false });
    const res = await worker.fetch(
      new Request('https://example.com/realtime', { headers: { upgrade: 'websocket' } }),
      {},
      {},
    );
    expect(res.status).toBe(404);
  });

  it('routes the upgrade at a custom realtime path (default stays free)', async () => {
    const { orbit } = createWorld();
    const worker = createWorker({ orbit, realtime: { path: '/ws' } });
    const upgrade = new Request('https://example.com/ws', {
      headers: { upgrade: 'websocket' },
    });
    // Outside workerd there is no WebSocketPair → 501 proves the route matched.
    expect((await worker.fetch(upgrade, {}, {})).status).toBe(501);
    // The default /realtime path is now free (404, not a hijacked upgrade).
    const free = await worker.fetch(
      new Request('https://example.com/realtime', { headers: { upgrade: 'websocket' } }),
      {},
      {},
    );
    expect(free.status).toBe(404);
  });

  it('routes a throwing custom ctx through onError (infrastructure error)', async () => {
    const worker = createWorker({
      orbit: async () => new Response('ok'),
      ctx: () => {
        throw new Error('ctx kaboom');
      },
      onError: (error) => Response.json({ error: (error as Error).message }, { status: 418 }),
    });
    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), { query: 'x { id }' }),
      {},
      {},
    );
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'ctx kaboom' });
  });

  it('flows bindings + execution context into the OrbitContext', async () => {
    const seen: Array<{ env: unknown; hasWaitUntil: boolean }> = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'ping',
          resolve: (_filters, ctx) => {
            seen.push({
              env: ctx.env,
              hasWaitUntil: typeof ctx.waitUntil === 'function',
            });
            return { ok: true };
          },
        },
      ]),
    });
    const worker = createWorker({ orbit });
    const waitUntil = vi.fn();

    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), { query: 'ping { ok }' }),
      { DB: 'd1-binding' },
      { waitUntil },
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ env: { DB: 'd1-binding' }, hasWaitUntil: true }]);
  });

  it('passes a custom ctx function the request, env and execution ctx', async () => {
    const seen: unknown[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'ping',
          resolve: (_filters, ctx) => {
            seen.push(ctx.state);
            return { ok: true };
          },
        },
      ]),
    });
    const worker = createWorker({
      orbit,
      ctx: (request, env: { token: string }, ctx: { waitUntil: () => void }) => {
        expect(request.url).toContain('api/orbit');
        expect(env.token).toBe('secret');
        expect(typeof ctx.waitUntil).toBe('function');
        return { state: { viewer: 'ana' } };
      },
    });

    await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), { query: 'ping { ok }' }),
      { token: 'secret' },
      { waitUntil: () => {} },
    );

    expect(seen).toEqual([{ viewer: 'ana' }]);
  });

  it('routes infrastructure errors through onError (protocol errors stay responses)', async () => {
    const worker = createWorker({
      orbit: async () => {
        throw new Error('kaboom');
      },
      onError: (error) => Response.json({ error: (error as Error).message }, { status: 418 }),
    });

    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), { query: 'x { id }' }),
      {},
      {},
    );

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'kaboom' });
  });

  it('merges pipeline-set responseHeaders into the worker response (set-cookie)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'session',
          resolve: () => null,
          mutate: (_action, _args, ctx) => {
            ctx.responseHeaders = {
              'set-cookie': 'session=token123; HttpOnly; Path=/; Max-Age=3600',
            };
            return { success: true };
          },
        },
      ]),
    });
    const worker = createWorker({ orbit });
    const res = await worker.fetch(
      jsonPost(new Request('https://example.com/api/orbit'), { do: 'session.login', args: {} }),
      {},
      {},
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      'session=token123; HttpOnly; Path=/; Max-Age=3600',
    ]);
    // Negotiated responses carry vary so CDN caches key on both dimensions.
    expect(res.headers.get('vary')).toBe('accept, accept-encoding');
  });

  it('keeps the full wire protocol intact (msgpack, SSE, gzip, uploads, errors, cache)', async () => {
    const { orbit } = createWorld({ cache: true });
    await orbit.execute({ do: 'post.create', args: { payload: { id: 'p1', title: 'Hola' } } });
    const worker = createWorker({ orbit });
    const base = 'https://example.com/api/orbit';

    // MessagePack in AND out.
    const mp = await worker.fetch(
      new Request(base, {
        method: 'POST',
        headers: { 'content-type': 'application/x-msgpack', accept: 'application/x-msgpack' },
        body: encodeMsgpack({ query: 'post(id="p1") { title }' }),
      }),
      {},
      {},
    );
    expect(mp.headers.get('content-type')).toBe('application/x-msgpack');
    expect(decodeMsgpack(new Uint8Array(await mp.arrayBuffer()))).toEqual({
      data: { title: 'Hola' },
    });

    // SSE streaming.
    const sse = await worker.fetch(
      new Request(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ query: 'post { id }' }),
      }),
      {},
      {},
    );
    const sseText = await sse.text();
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(sseText).toContain('"level":"done"');

    // gzip.
    const gz = await worker.fetch(
      new Request(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
        body: JSON.stringify({ query: 'post { id }' }),
      }),
      {},
      {},
    );
    expect(gz.headers.get('content-encoding')).toBe('gzip');

    // Multipart uploads → ctx.files.
    const received: Array<{ name: string; size: number }> = [];
    const uploadOrbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'upload',
          resolve: () => null,
          mutate: async (_action, _args, ctx) => {
            const file = ctx.files?.avatar;
            if (file) received.push({ name: file.name, size: file.size });
            return { success: true };
          },
        },
      ]),
    });
    const uploadWorker = createWorker({ orbit: uploadOrbit });
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'upload.save', args: {} }));
    form.set('avatar', new File(['orbit'], 'me.png', { type: 'image/png' }));
    const up = await uploadWorker.fetch(new Request(base, { method: 'POST', body: form }), {}, {});
    expect(up.status).toBe(200);
    expect(received).toEqual([{ name: 'me.png', size: 5 }]);

    // Standard error contract.
    const err = await worker.fetch(jsonPost(new Request(base), { query: 'ghost { id }' }), {}, {});
    expect(err.status).toBe(404);
    expect(((await err.json()) as { error: { code: string } }).error.code).toBe(
      'ORBIT_ENTITY_UNREGISTERED',
    );

    // Cache lifecycle through the header.
    const cacheQuery = jsonPost(new Request(base), { query: 'post { id }' });
    const withCache = (request: Request) =>
      new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orbit-cache': 'ttl=60' },
        body: JSON.stringify({ query: 'post { id }' }),
      });
    const c1 = (await (await worker.fetch(withCache(cacheQuery), {}, {})).json()) as {
      fromCache?: boolean;
    };
    const c2 = (await (await worker.fetch(withCache(cacheQuery), {}, {})).json()) as {
      fromCache?: boolean;
    };
    expect(c1.fromCache).toBeUndefined();
    expect(c2.fromCache).toBe(true);
  });
});

describe('handleWebSocket — the Workers upgrade', () => {
  it('404s for a wrong path and 400s for non-upgrade requests', async () => {
    const { orbit } = createWorld();
    expect((await handleWebSocket(new Request('https://x/nope'), orbit)).status).toBe(404);
    expect(
      (await handleWebSocket(new Request('https://x/realtime', { method: 'POST' }), orbit)).status,
    ).toBe(400);
  });

  it('403s when the authorize gate denies', async () => {
    const { orbit } = createWorld();
    const res = await handleWebSocket(
      new Request('https://x/realtime', { headers: { upgrade: 'websocket' } }),
      orbit,
      { authorize: () => false },
    );
    expect(res.status).toBe(403);
  });

  it('answers 501 outside workerd (no WebSocketPair global)', async () => {
    const { orbit } = createWorld();
    const res = await handleWebSocket(
      new Request('https://x/realtime', { headers: { upgrade: 'websocket' } }),
      orbit,
    );
    expect(res.status).toBe(501);
  });

  it('upgrades to a 101 and runs a live session (stubbed WebSocketPair)', async () => {
    const { orbit, handlers } = createWorld();
    const server = new FakeWs();
    const stubbed = vi.fn(function WebSocketPair(this: { 0: unknown; 1: FakeWs }) {
      this[0] = {};
      this[1] = server;
    });
    const original = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = stubbed;
    // workerd accepts status 101 + webSocket; Node's undici does not (200–599
    // only). Stub Response so the upgrade path itself is exercised in Node.
    const originalResponse = globalThis.Response;
    class FakeResponse {
      status: number;
      constructor(_body: unknown, init: { status?: number } = {}) {
        this.status = init.status ?? 200;
      }
    }
    (globalThis as unknown as { Response: unknown }).Response = FakeResponse;
    try {
      const res = await handleWebSocket(
        new Request('https://x/realtime', { headers: { upgrade: 'websocket' } }),
        orbit,
      );
      expect(res.status).toBe(101);
      expect(server.accepted).toBe(true);

      // The session is live: subscribe → ack → adapter event.
      server.sendJson({ subscribe: 'post { id }', id: 's1' });
      await waitFor(() => server.frames().some((f) => f.ack === 's1'), 'ack');
      for (const handler of handlers) handler({ type: 'created', id: 'p1', data: { id: 'p1' } });
      await waitFor(
        () => server.frames().some((f) => f.id === 's1' && f.event !== undefined),
        'event',
      );
      expect(server.lastFrame()).toMatchObject({ id: 's1', seq: 1, event: { type: 'created' } });
    } finally {
      (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = original;
      (globalThis as unknown as { Response: unknown }).Response = originalResponse;
    }
  });
});

describe('createRealtimeSession — subscriptions + envelope requests', () => {
  it('acks subscriptions and delivers adapter events with seq numbers', async () => {
    const { orbit, handlers } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ subscribe: 'post { id }', id: 's1' });
    await waitFor(() => ws.frames().some((f) => f.ack === 's1'), 'ack');

    for (const handler of handlers) handler({ type: 'created', id: 'p1', data: { id: 'p1' } });
    await waitFor(() => ws.frames().some((f) => f.id === 's1' && f.event !== undefined), 'event');
    expect(ws.lastFrame()).toMatchObject({
      id: 's1',
      seq: 1,
      event: { type: 'created', id: 'p1' },
    });
  });

  it('answers query envelopes with the echoed correlation id', async () => {
    const { orbit } = createWorld();
    await orbit.execute({ do: 'post.create', args: { payload: { id: 'p1', title: 'Hola' } } });
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ query: 'post { id, title }', id: 'q1' });
    await waitFor(() => ws.frames().some((f) => f.id === 'q1'), 'query reply');
    expect(ws.lastFrame()).toMatchObject({
      id: 'q1',
      status: 200,
      data: [{ id: 'p1', title: 'Hola' }],
    });
  });

  it('executes mutations over the socket', async () => {
    const { orbit } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ do: 'post.create', args: { payload: { id: 'p9', title: 'Nuevo' } }, id: 'm1' });
    await waitFor(() => ws.frames().some((f) => f.id === 'm1'), 'mutation reply');
    expect(ws.lastFrame()).toMatchObject({
      id: 'm1',
      status: 200,
      data: { success: true, id: 'p9' },
    });

    ws.sendJson({ query: 'post(id="p9") { title }', id: 'q2' });
    await waitFor(
      () => ws.frames().some((f) => f.id === 'q2' && f.data !== undefined),
      'follow-up',
    );
    expect(ws.lastFrame()).toMatchObject({ data: { title: 'Nuevo' } });
  });

  it('echoes the id on validation failures (both query and do)', async () => {
    const { orbit } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ query: 'post { id }', do: 'post.create', id: 'b1' });
    await waitFor(() => ws.frames().some((f) => f.id === 'b1'), 'both-reply');
    expect(ws.lastFrame()).toMatchObject({
      id: 'b1',
      status: 400,
      error: { code: 'ORBIT_INVALID_QUERY' },
    });
  });

  it('replays the gap on resume within the session', async () => {
    const { orbit, handlers } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ subscribe: 'post { id }', id: 's1' });
    await waitFor(() => ws.frames().some((f) => f.ack === 's1'), 'ack');
    for (const handler of handlers) handler({ type: 'created', id: 'p1', data: { id: 'p1' } });
    for (const handler of handlers) handler({ type: 'created', id: 'p2', data: { id: 'p2' } });
    await waitFor(() => ws.frames().some((f) => f.id === 's1' && f.seq === 2), 'seq 2');

    ws.sendJson({ resume: 's1', after: 1 });
    await waitFor(() => ws.frames().some((f) => f.resumed === 's1'), 'resumed');
    expect(ws.lastFrame()).toMatchObject({ resumed: 's1', after: 1 });
    // The replay (seq > 1) was delivered as an event frame.
    const replayed = ws.frames().filter((f) => f.id === 's1' && f.event !== undefined);
    expect(replayed[replayed.length - 1]).toMatchObject({ seq: 2, event: { id: 'p2' } });
  });

  it('unsubscribes and releases the adapter hook on close', async () => {
    const { orbit, handlers } = createWorld();
    const ws = new FakeWs();
    const session = createRealtimeSession(ws, orbit);

    ws.sendJson({ subscribe: 'post { id }', id: 's1' });
    await waitFor(() => ws.frames().some((f) => f.ack === 's1'), 'ack');
    expect(handlers.size).toBe(1);

    session.close();
    expect(handlers.size).toBe(0);
    expect(ws.closed).toBeNull(); // close() is transport-side cleanup, not a socket close
  });

  it('rejects unknown control frames with the standard error frame', async () => {
    const { orbit } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit);

    ws.sendJson({ teleport: 'nowhere' });
    await waitFor(() => ws.frames().length > 0, 'error frame');
    expect(ws.lastFrame()).toMatchObject({ error: { code: 'ORBIT_INVALID_QUERY' } });
  });

  it('speaks MessagePack when serialize is msgpack', async () => {
    const { orbit } = createWorld();
    await orbit.execute({ do: 'post.create', args: { payload: { id: 'p1', title: 'Hola' } } });
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit, { serialize: 'msgpack' });

    ws.sendMsgpack({ query: 'post { id }', id: 'mp1' });
    await waitFor(() => ws.frames().some((f) => f.id === 'mp1'), 'msgpack reply');
    expect(ws.lastFrame()).toMatchObject({ id: 'mp1', status: 200, data: [{ id: 'p1' }] });
    // Every outgoing frame was binary.
    expect(ws.sent.every((frame) => typeof frame !== 'string')).toBe(true);
  });

  it('enforces the max message size', async () => {
    const { orbit } = createWorld();
    const ws = new FakeWs();
    createRealtimeSession(ws, orbit, { maxMessageBytes: 8 });

    ws.sendJson({ subscribe: 'post { id }', id: 's1' });
    await waitFor(() => ws.frames().length > 0, 'size error');
    expect(ws.lastFrame()).toMatchObject({ error: { code: 'ORBIT_INVALID_QUERY' } });
  });
});
