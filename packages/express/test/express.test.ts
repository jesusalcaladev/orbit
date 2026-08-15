import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createOrbit,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
  type SubscriptionEvent,
} from '@orbit/core';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachRealtime, createExpressApp, expressHandler } from '../src/index.js';

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

/** Boot an Express app on an ephemeral port; also exposes the http server. */
function listen(
  app: express.Express,
): Promise<{ url: string; server: import('node:http').Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise((done) => {
            // Kill any stray upgraded (WebSocket) sockets so close() resolves.
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

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

const openServers: Array<() => Promise<void>> = [];
beforeEach(() => {
  // Tests share the in-memory store — reset to the initial seed.
  records.clear();
  records.set('1', { id: '1', name: 'Alice' });
  records.set('2', { id: '2', name: 'Bob' });
  receivedFiles.length = 0;
});
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()));
});

describe('expressHandler', () => {
  it('answers JSON queries with no body-parser middleware registered', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ data: { name: 'Alice' } });
  });

  it('also works when express.json() ran first', async () => {
    const app = express();
    app.use(express.json());
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="2") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { name: 'Bob' } });
  });

  it('runs mutations through the engine', async () => {
    const app = createExpressApp(buildOrbit(), { path: '/api/orbit' });
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/api/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'user.create', args: { id: '3', name: 'Cara' } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, id: '3' } });

    // The record is really there now.
    const check = await fetch(`${url}/api/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="3") { name }' }),
    });
    expect(await check.json()).toEqual({ data: { name: 'Cara' } });
  });

  it('returns the standard error contract for unknown entities', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ghost(id="1") { id }' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ORBIT_ENTITY_UNREGISTERED');
  });

  it('accepts MessagePack envelopes (protocol input negotiation)', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-msgpack' },
      body: encodeMsgpack({ query: 'user(id="1") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { name: 'Alice' } });
  });

  it('serves MessagePack responses when the client asks for them', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
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
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
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
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'upload.save', args: {} }));
    form.set('avatar', new File(['hello orbit'], 'me.png', { type: 'image/png' }));

    const res = await fetch(`${url}/orbit`, { method: 'POST', body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(receivedFiles).toContainEqual({ field: 'avatar', name: 'me.png', size: 11 });
  });

  it('negotiates gzip transparently', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ query: 'user { id, name }' }),
    });

    expect(res.headers.get('content-encoding')).toBe('gzip');
    // Node's fetch transparently decompresses — the payload must still parse.
    expect(await res.json()).toEqual({
      data: [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ],
    });
  });

  it('passes ctx through to adapters', async () => {
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
    const app = express();
    app.use('/orbit', expressHandler({ orbit, ctx: () => ({ state: { viewer: 'ana' } }) }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ping { ok }' }),
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ viewer: 'ana' }]);
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
    const app = express();
    app.use('/orbit', expressHandler({ orbit: engine }));
    const { url, server, close } = await listen(app);
    openServers.push(close);
    const realtime = attachRealtime(server, engine);

    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime`);
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
  });

  it('rejects a second attachRealtime on the same http server', async () => {
    const engine = createOrbit({
      adapters: memoryAdapter([{ entity: 'item', resolve: () => [] }]),
    });
    const app = express();
    app.use('/orbit', expressHandler({ orbit: engine }));
    const { server, close } = await listen(app);
    openServers.push(close);

    attachRealtime(server, engine);
    // A second upgrade listener on the same socket would corrupt the
    // WebSocket handshake — the wrapper must refuse, not silently no-op.
    expect(() => attachRealtime(server, engine)).toThrow(/already called/);
  });

  it('preserves multiple set-cookie headers from responseHeaders', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'session',
          resolve: () => null,
          mutate: (_action, _args, ctx) => {
            ctx.responseHeaders = {
              'set-cookie': ['sid=abc; HttpOnly; Path=/', 'theme=dark; Path=/'],
            };
            return { success: true };
          },
        },
      ]),
    });
    const app = express();
    app.use('/orbit', expressHandler({ orbit }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'session.login', args: {} }),
    });

    expect(res.status).toBe(200);
    // getSetCookie() on the client side sees each cookie as its own line —
    // the wrapper must not have ", "-joined them (which would corrupt
    // attributes like SameSite/HttpOnly boundaries).
    expect(res.headers.getSetCookie()).toEqual(['sid=abc; HttpOnly; Path=/', 'theme=dark; Path=/']);
  });

  it('routes infrastructure errors through the custom onError', async () => {
    const app = express();
    app.use(
      '/orbit',
      expressHandler({
        orbit: async () => {
          throw new Error('kaboom');
        },
        onError: (_err, _req, res) => {
          res.status(418).json({ error: 'custom teapot' });
        },
      }),
    );
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user { id }' }),
    });

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'custom teapot' });
  });

  it('answers a generic 500 when no onError is provided (no internals leak)', async () => {
    const app = express();
    app.use(
      '/orbit',
      expressHandler({
        orbit: async () => {
          throw new Error('kaboom-with-secrets');
        },
      }),
    );
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user { id }' }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('passes a Buffer body from express.raw() untouched to the engine', async () => {
    const app = express();
    app.use(express.raw({ type: '*/*' }));
    app.use('/orbit', expressHandler({ orbit: buildOrbit() }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { name: 'Alice' } });
  });

  it('passes a bodyless response through (status only)', async () => {
    const app = express();
    app.use('/orbit', expressHandler({ orbit: async () => new Response(null, { status: 204 }) }));
    const { url, close } = await listen(app);
    openServers.push(close);

    const res = await fetch(`${url}/orbit`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('destroys the response when the engine stream errors mid-flight', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = express();
      app.use(
        '/orbit',
        expressHandler({
          orbit: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1, 2, 3]));
                  controller.error(new Error('stream broke'));
                },
              }),
              { status: 200 },
            ),
        }),
      );
      const { url, close } = await listen(app);
      openServers.push(close);

      // The client either sees a reset or an incomplete response — the server
      // must log the stream error and destroy the socket instead of crashing.
      await fetch(`${url}/orbit`, { method: 'POST' }).catch(() => {});
      expect(errorSpy).toHaveBeenCalledWith(
        '[orbit:express] response stream error:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
