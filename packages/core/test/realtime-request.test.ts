/**
 * Envelope request/response over the WebSocket transport (spec §10).
 *
 * The realtime socket multiplexes subscription control frames AND `{ query }` /
 * `{ do }` envelopes. Envelope replies mirror the HTTP JSON payload:
 * `{ id?, status, data, fromCache?, invalidates? }` or `{ id?, status, error }`.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataAdapter } from '../src/adapters/types.js';
import { ErrorCode, OrbitError } from '../src/errors.js';
import {
  createCachePlugin,
  createOrbit,
  createRealtimeServer,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
} from '../src/index.js';
import type { RealtimeServer, RealtimeServerOptions } from '../src/index.js';
import type { Filters, MutationArgs, SubscriptionEvent } from '../src/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(10);
  }
}

/** A tiny post world: resolve/mutate/subscribe wired to one in-memory store. */
function createWorld(options: { cache?: boolean } = {}) {
  const posts = new Map<string, { id: string; title: string }>();
  const handlers = new Set<(event: SubscriptionEvent) => void>();

  const adapter: DataAdapter = {
    entity: 'post',
    resolve: (filters: Filters) => (filters.id ? posts.get(filters.id) : [...posts.values()]),
    mutate: (_action: string, args: MutationArgs) => {
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
    subscribe: (_filters: Filters, handler: (event: SubscriptionEvent) => void) => {
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

  return { orbit, create, adapter };
}

describe('RealtimeServer — envelope request/response (spec §10)', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  async function connect() {
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) =>
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    return { ws, messages };
  }

  it('answers a query with the standard payload and the echoed id', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id, title }', id: 'q1' }));
    await waitFor(() => messages.some((m) => m.id === 'q1'), 'query reply');
    expect(messages.find((m) => m.id === 'q1')).toMatchObject({ status: 200, data: [] });
    ws.close();
  });

  it('executes mutations with args over the socket', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(
      JSON.stringify({
        do: 'post.create',
        args: { payload: { id: 'p1', title: 'Hola' } },
        id: 'm1',
      }),
    );
    await waitFor(() => messages.some((m) => m.id === 'm1'), 'mutation reply');
    expect(messages.find((m) => m.id === 'm1')).toMatchObject({
      status: 200,
      data: { success: true, id: 'p1' },
    });

    // The change is really there: a follow-up query over the same socket sees it.
    ws.send(JSON.stringify({ query: 'post { id, title }', id: 'q2' }));
    await waitFor(
      () => messages.some((m) => m.id === 'q2' && Array.isArray(m.data) && m.data.length > 0),
      'mutated query',
    );
    expect(messages.find((m) => m.id === 'q2')).toMatchObject({
      status: 200,
      data: [{ id: 'p1', title: 'Hola' }],
    });
    ws.close();
  });

  it('supports the return re-query like HTTP', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(
      JSON.stringify({
        do: 'post.create',
        args: { payload: { id: 'p9', title: 'Return' } },
        return: 'post { id, title }',
        id: 'r1',
      }),
    );
    await waitFor(() => messages.some((m) => m.id === 'r1'), 'return reply');
    expect(messages.find((m) => m.id === 'r1')).toMatchObject({
      status: 200,
      data: [{ id: 'p9', title: 'Return' }],
    });
    ws.close();
  });

  it('replies with the standard error contract and its status', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'ghost { id }', id: 'e1' }));
    await waitFor(() => messages.some((m) => m.id === 'e1'), 'error reply');
    expect(messages.find((m) => m.id === 'e1')).toMatchObject({
      status: 404,
      error: { code: ErrorCode.ENTITY_UNREGISTERED },
    });
    ws.close();
  });

  it('rejects envelopes carrying both query and do (spec §3)', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id }', do: 'post.create', id: 'b1' }));
    await waitFor(() => messages.some((m) => m.id === 'b1'), 'both-reply');
    expect(messages.find((m) => m.id === 'b1')).toMatchObject({
      status: 400,
      error: { code: ErrorCode.INVALID_QUERY },
    });
    ws.close();
  });

  it('runs the plugin pipeline over the socket (auth gates apply)', async () => {
    const world = createWorld();
    const orbit = createOrbit({
      adapters: [world.adapter],
      plugins: [
        {
          name: 'gate',
          hooks: {
            onBeforeResolve: ({ parsed }) => {
              if (parsed.entity === 'post') {
                throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'gated');
              }
            },
          },
        },
      ],
    });
    server = createServer();
    realtime = createRealtimeServer(orbit);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id }', id: 'g1' }));
    await waitFor(() => messages.some((m) => m.id === 'g1'), 'gated reply');
    expect(messages.find((m) => m.id === 'g1')).toMatchObject({
      status: 403,
      error: { code: ErrorCode.PERMISSION_DENIED },
    });
    ws.close();
  });

  it('honors the envelope cache spec (fromCache on the second hit)', async () => {
    const world = createWorld({ cache: true });
    server = createServer();
    realtime = createRealtimeServer(world.orbit);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    const { ws, messages } = await connect();
    const envelope = () => JSON.stringify({ query: 'post { id }', cache: 'ttl=60', id: 'c' });
    ws.send(envelope());
    await waitFor(
      () => messages.some((m) => m.id === 'c' && m.data !== undefined),
      'first cache reply',
    );
    ws.send(envelope());
    await waitFor(() => messages.filter((m) => m.id === 'c').length > 1, 'second cache reply');
    const second = messages.filter((m) => m.id === 'c')[1]!;
    expect(second).toMatchObject({ status: 200, data: [], fromCache: true });
    ws.close();
  });

  it('replies without an id when the client sent none', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id }' }));
    await waitFor(() => messages.length > 0, 'reply');
    expect(messages[0]).toMatchObject({ status: 200, data: [] });
    expect(messages[0]!.id).toBeUndefined();
    ws.close();
  });

  it('answers envelope requests on a MessagePack connection', async () => {
    await start({ serialize: 'msgpack' });
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    ws.binaryType = 'arraybuffer';
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      messages.push(decodeMsgpack(new Uint8Array(data)) as Record<string, unknown>);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    ws.send(encodeMsgpack({ query: 'post { id }', id: 'mp1' }));
    await waitFor(() => messages.some((m) => m.id === 'mp1'), 'msgpack reply');
    expect(messages.find((m) => m.id === 'mp1')).toMatchObject({ status: 200, data: [] });
    ws.close();
  });

  it('rides plugin-serialized string payloads with their contentType', async () => {
    const world = createWorld();
    const orbit = createOrbit({
      adapters: [world.adapter],
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => {
              const rows = (data as Array<{ id: string }> | undefined) ?? [];
              const ids = rows.map((row) => row.id).join(',');
              return { body: `id\n${ids}`, contentType: 'text/csv' };
            },
          },
        },
      ],
    });
    server = createServer();
    realtime = createRealtimeServer(orbit);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id }', id: 'csv1' }));
    await waitFor(() => messages.some((m) => m.id === 'csv1'), 'csv reply');
    expect(messages.find((m) => m.id === 'csv1')).toMatchObject({
      status: 200,
      data: 'id\n',
      contentType: 'text/csv',
    });
    ws.close();
  });

  it('drops binary plugin payloads to null (HTTP-only bodies do not round-trip)', async () => {
    const world = createWorld();
    const orbit = createOrbit({
      adapters: [world.adapter],
      plugins: [
        {
          name: 'bin',
          hooks: {
            onBeforeSerialize: () => ({
              body: new Uint8Array([1, 2, 3]),
              contentType: 'application/octet-stream',
            }),
          },
        },
      ],
    });
    server = createServer();
    realtime = createRealtimeServer(orbit);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;

    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ query: 'post { id }', id: 'bin1' }));
    await waitFor(() => messages.some((m) => m.id === 'bin1'), 'binary reply');
    const reply = messages.find((m) => m.id === 'bin1')!;
    expect(reply).toMatchObject({ status: 200, data: null });
    expect(reply.contentType).toBeUndefined();
    ws.close();
  });

  it('mixes subscription frames and envelope requests on one connection', async () => {
    const world = await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => messages.some((m) => m.ack === 'sub-1'), 'ack');

    ws.send(JSON.stringify({ query: 'post { id }', id: 'q1' }));
    await waitFor(() => messages.some((m) => m.id === 'q1'), 'query reply');

    await world.create({ id: 'p1', title: 'Mix' });
    await waitFor(() => messages.some((m) => m.id === 'sub-1'), 'subscription event');
    expect(messages.find((m) => m.id === 'sub-1')).toMatchObject({
      event: { type: 'created', id: 'p1' },
    });
    ws.close();
  });
});

describe('RealtimeServer — authorize context (P0.1b)', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(orbit: import('../src/engine.js').Orbit, options?: RealtimeServerOptions) {
    server = createServer();
    realtime = createRealtimeServer(orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  }

  async function connect() {
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) =>
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    return { ws, messages };
  }

  it('threads the authorize context into socket mutations (identity reaches mutate)', async () => {
    let seenCaller: unknown;
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'post',
          resolve: () => [],
          mutate: (_action, _args, ctx) => {
            seenCaller = ctx.state?.caller;
            return { id: 'p1' };
          },
        },
      ]),
    });
    await start(orbit, { authorize: () => ({ state: { caller: 'admin' } }) });
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ do: 'post.create', args: {}, id: 'm1' }));
    await waitFor(() => messages.some((m) => m.id === 'm1'), 'mutation reply');
    expect(messages.find((m) => m.id === 'm1')).toMatchObject({ status: 200 });
    expect(seenCaller).toBe('admin');
    ws.close();
  });

  it('denies subscriptions the auth pipeline rejects (gate runs with the session ctx)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'post', resolve: () => [], subscribe: () => () => {} }]),
      plugins: [
        {
          name: 'auth',
          hooks: {
            onBeforeResolve({ ctx }) {
              if (ctx.state?.caller !== 'admin') {
                throw new OrbitError(
                  ErrorCode.PERMISSION_DENIED,
                  'Only admins may subscribe to posts',
                );
              }
            },
          },
        },
      ],
    });
    await start(orbit, { authorize: () => ({ state: { caller: 'viewer' } }) });
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-x' }));
    await waitFor(
      () =>
        messages.some(
          (m) =>
            (m.error as { code?: unknown } | undefined)?.code === ErrorCode.PERMISSION_DENIED &&
            m.id === 'sub-x',
        ),
      'denied subscription',
    );
    // No ack — the subscription never attached.
    expect(messages.some((m) => m.ack === 'sub-x')).toBe(false);
    ws.close();
  });

  it('an authorize returning true yields an empty context (no state leak)', async () => {
    let seenState: unknown;
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'post',
          resolve: () => [],
          mutate: (_action, _args, ctx) => {
            seenState = ctx.state;
            return { id: 'p1' };
          },
        },
      ]),
    });
    await start(orbit, { authorize: () => true });
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ do: 'post.create', args: {}, id: 'm2' }));
    await waitFor(() => messages.some((m) => m.id === 'm2'), 'mutation reply');
    expect(seenState).toBeUndefined();
    ws.close();
  });
});
