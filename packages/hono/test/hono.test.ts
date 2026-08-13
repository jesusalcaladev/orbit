import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  createOrbit,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
  type SubscriptionEvent,
} from '@orbit/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime, createHonoApp, honoHandler } from '../src/index.js';

/** In-memory store shared by the test adapters. */
const records = new Map<string, { id: string; name: string }>([
  ['1', { id: '1', name: 'Alice' }],
  ['2', { id: '2', name: 'Bob' }],
]);

/** Files observed by the upload adapter (mutations only echo `{ success }`). */
const receivedFiles: Array<{ field: string; name: string; size: number }> = [];

function buildOrbit() {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => (id ? (records.get(String(id)) ?? null) : [...records.values()]),
        mutate: async (action, args) => {
          if (action === 'create') {
            const { id, name } = args as { id: string; name: string };
            records.set(String(id), { id: String(id), name: String(name) });
            return { id: String(id) };
          }
          throw new Error(`user.${action} is not supported`);
        },
      },
      {
        entity: 'upload',
        resolve: () => null,
        mutate: async (_action, _args, ctx) => {
          for (const [field, file] of Object.entries(ctx.files ?? {})) {
            receivedFiles.push({
              field,
              name: (file as File).name,
              size: (file as File).size,
            });
          }
          return { success: true };
        },
      },
    ]),
  });
}

beforeEach(() => {
  records.clear();
  records.set('1', { id: '1', name: 'Alice' });
  records.set('2', { id: '2', name: 'Bob' });
  receivedFiles.length = 0;
});

const app = createHonoApp(buildOrbit());

/** Resolve once the WebSocket is open (reject on handshake failure). */
function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
}

/** Wait for the first realtime frame matching `predicate`. */
function waitForFrame(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for realtime frame'));
    }, timeoutMs);
    ws.addEventListener('message', onMessage);
  });
}

describe('honoHandler', () => {
  it('answers JSON queries', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ data: { name: 'Alice' } });
  });

  it('runs mutations through the engine', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'user.create', args: { id: '3', name: 'Cara' } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, id: '3' } });

    const check = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="3") { name }' }),
    });
    expect(await check.json()).toEqual({ data: { name: 'Cara' } });
  });

  it('returns the standard error contract for unknown entities', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ghost(id="1") { id }' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORBIT_ENTITY_UNREGISTERED');
  });

  it('accepts MessagePack envelopes (protocol input negotiation)', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-msgpack' },
      body: encodeMsgpack({ query: 'user(id="1") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { name: 'Alice' } });
  });

  it('serves MessagePack responses when the client asks for them', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-msgpack',
      },
      body: JSON.stringify({ query: 'user(id="2") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-msgpack');
    const payload = decodeMsgpack(new Uint8Array(await res.arrayBuffer()));
    expect(payload).toEqual({ data: { name: 'Bob' } });
  });

  it('streams SSE frames for progressive graph delivery', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'user { id }' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toContain('"level":"done"');
  });

  it('passes multipart uploads to ctx.files (protocol file uploads)', async () => {
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'upload.save', args: {} }));
    form.set('avatar', new File(['hello orbit'], 'me.png', { type: 'image/png' }));

    const res = await app.request('/orbit', { method: 'POST', body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(receivedFiles).toContainEqual({ field: 'avatar', name: 'me.png', size: 11 });
  });

  it('negotiates gzip transparently', async () => {
    const res = await app.request('/orbit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ query: 'user { id, name }' }),
    });

    expect(res.headers.get('content-encoding')).toBe('gzip');
    // Hono's request harness does not decompress — do it by hand.
    const stream = new Blob([new Uint8Array(await res.arrayBuffer())])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    expect(JSON.parse(await new Response(stream).text())).toEqual({
      data: [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ],
    });
  });

  it('serves realtime subscriptions on the same http server', async () => {
    const listeners = new Set<(event: SubscriptionEvent) => void>();
    const engine = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'item',
          resolve: () => [],
          subscribe: (_filters, handler) => {
            listeners.add(handler);
            return () => listeners.delete(handler);
          },
        },
      ]),
    });
    const host = createHonoApp(engine);
    const server = serve({ fetch: host.fetch, port: 0 }) as unknown as Server;
    const { port } = server.address() as AddressInfo;
    const realtime = attachRealtime(server, engine);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    await onceOpen(ws);
    ws.send(JSON.stringify({ subscribe: 'item { id }', id: 's1' }));
    expect((await waitForFrame(ws, (m) => m.ack === 's1')).ack).toBe('s1');

    // A change pushed through the adapter hook reaches the subscribed client.
    for (const handler of listeners) handler({ type: 'created', id: '1', data: { id: '1' } });
    const frame = await waitForFrame(ws, (m) => m.id === 's1' && m.event !== undefined);
    expect(frame.seq).toBe(1);
    expect(frame.event).toMatchObject({ type: 'created', id: '1' });

    ws.close();
    realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a second attachRealtime on the same http server', async () => {
    const engine = createOrbit({
      adapters: memoryAdapter([{ entity: 'item', resolve: () => [] }]),
    });
    const server = serve({ fetch: new Hono().fetch, port: 0 }) as unknown as Server;

    attachRealtime(server, engine);
    // A second upgrade listener on the same socket would corrupt the
    // WebSocket handshake — the wrapper must refuse, not silently no-op.
    expect(() => attachRealtime(server, engine)).toThrow(/already called/);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('mounts at a custom path and passes ctx through', async () => {
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
    const custom = createHonoApp(orbit, {
      path: '/api/orbit',
      ctx: () => ({ state: { viewer: 'ana' } }),
    });

    const res = await custom.request('/api/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ping { ok }' }),
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ viewer: 'ana' }]);
  });

  it('routes infrastructure errors through the custom onError', async () => {
    const broken = new Hono();
    broken.use(
      '/orbit',
      honoHandler({
        orbit: async () => {
          throw new Error('kaboom');
        },
        onError: (_err, c) => c.json({ error: 'custom teapot' }, 418),
      }),
    );

    const res = await broken.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user { id }' }),
    });

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'custom teapot' });
  });

  it('rethrows to the app-level onError by default', async () => {
    const broken = new Hono();
    broken.use(
      '/orbit',
      honoHandler({
        orbit: async () => {
          throw new Error('kaboom');
        },
      }),
    );
    broken.onError((err, c) => c.json({ error: err instanceof Error ? err.message : '?' }, 500));

    const res = await broken.request('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user { id }' }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'kaboom' });
  });
});
