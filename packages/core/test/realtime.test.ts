import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataAdapter } from '../src/adapters/types.js';
import { ErrorCode } from '../src/errors.js';
import {
  createOrbit,
  createRealtimeServer,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
  parseOQS,
} from '../src/index.js';
import type { RealtimeServer, RealtimeServerOptions } from '../src/index.js';
import { SubscriptionHub } from '../src/realtime/hub.js';
import type { Filters, MutationArgs, SubscriptionEvent } from '../src/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(10);
  }
}

interface PostPayload {
  id: string;
  title: string;
  status: string;
}

/** A tiny post world whose adapter wires subscribe + mutate to one emitter. */
function createPostWorld() {
  const posts = new Map<string, PostPayload>();
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const counters: {
    subscribeCount: number;
    unsubscribeCount: number;
    lastHandler?: (event: SubscriptionEvent) => void;
  } = { subscribeCount: 0, unsubscribeCount: 0 };

  const adapter: DataAdapter = {
    entity: 'post',
    resolve: (filters: Filters) => (filters.id ? posts.get(filters.id) : [...posts.values()]),
    mutate: (_action: string, args: MutationArgs) => {
      const payload = args.payload as PostPayload | undefined;
      if (!payload) return { id: undefined };
      posts.set(payload.id, payload);
      const event: SubscriptionEvent = {
        type: 'created',
        id: payload.id,
        data: payload,
        patch: { id: payload.id, title: payload.title, status: payload.status },
      };
      for (const handler of handlers) handler(event);
      return { id: payload.id };
    },
    subscribe: (_filters: Filters, handler: (event: SubscriptionEvent) => void) => {
      handlers.add(handler);
      counters.subscribeCount += 1;
      counters.lastHandler = handler;
      return () => {
        handlers.delete(handler);
        counters.unsubscribeCount += 1;
      };
    },
  };

  const orbit = createOrbit({ adapters: [adapter] });
  const create = (payload: PostPayload) =>
    orbit.execute({ do: 'post.create', args: { payload: { ...payload } } });

  return { orbit, create, counters, adapter };
}

// ---------------------------------------------------------------------------
// SubscriptionHub (runtime-agnostic core)
// ---------------------------------------------------------------------------

describe('SubscriptionHub', () => {
  it('fans out events with per-subscription sequence numbers', async () => {
    const { orbit, create } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    const received: Array<{ seq: number; event: SubscriptionEvent }> = [];
    hub.subscribe('post { id }', 'a', (seq, event) => received.push({ seq, event }));

    await create({ id: 'p1', title: 'One', status: 'live' });
    await create({ id: 'p2', title: 'Two', status: 'live' });

    expect(received.map((r) => r.seq)).toEqual([1, 2]);
    expect(received[0]!.event.id).toBe('p1');
    expect(received[1]!.event.data).toMatchObject({ title: 'Two' });
  });

  it('dedupes: N clients on the same (entity, filters) share ONE adapter hook', () => {
    const { orbit, counters } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 'a', () => {});
    hub.subscribe('post { id }', 'b', () => {});
    hub.subscribe('post { id }', 'c', () => {});
    expect(counters.subscribeCount).toBe(1);

    hub.unsubscribe('a');
    hub.unsubscribe('b');
    expect(counters.unsubscribeCount).toBe(0); // others still attached
    hub.unsubscribe('c');
    expect(counters.unsubscribeCount).toBe(1);
  });

  it('separate filter sets get separate adapter hooks', () => {
    const { orbit, counters } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post(status="live") { id }', 'a', () => {});
    hub.subscribe('post(status="draft") { id }', 'b', () => {});
    expect(counters.subscribeCount).toBe(2);
  });

  it('detach keeps the log growing; resume replays the gap', async () => {
    const { orbit, create } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    const delivered: number[] = [];
    hub.subscribe('post { id }', 's', (seq) => delivered.push(seq));

    await create({ id: 'p1', title: 'One', status: 'live' }); // seq 1
    hub.detach('s');
    await create({ id: 'p2', title: 'Two', status: 'live' }); // seq 2 — logged, not delivered
    await create({ id: 'p3', title: 'Three', status: 'live' }); // seq 3 — logged, not delivered
    expect(delivered).toEqual([1]);

    const replayed: number[] = [];
    const sub = hub.resume('s', 1, (seq) => replayed.push(seq));
    expect(sub).not.toBeNull();
    expect(replayed).toEqual([2, 3]);
    // The resumed handle unsubscribes exactly its own subscription.
    sub!.unsubscribe();
    expect(hub.activeCount).toBe(0);
  });

  it('resume returns null for unknown subscriptions', () => {
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    expect(hub.resume('nope', 0, () => {})).toBeNull();
  });

  it('refuses to re-attach a detached id under a different query', () => {
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 's', () => {});
    hub.detach('s');
    expect(() => hub.subscribe('post(status="live") { id }', 's', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.SUBSCRIPTION_FAILED }),
    );
    // Same query re-attaches cleanly.
    const sub = hub.subscribe('post { id }', 's', () => {});
    expect(sub.id).toBe('s');
    // The re-attached handle is a working unsubscribe.
    sub.unsubscribe();
    expect(hub.activeCount).toBe(0);
  });

  it('bounds a gated subscribe with the same cost limits as a query', async () => {
    // `authorizedSubscribe` parses on its own (it must honour an `onAfterParse`
    // rewrite), so it needs the limits applied explicitly — otherwise the gate
    // path would accept queries the query path rejects.
    const wide = 'post { a, b }';
    const bounded = createOrbit({
      adapters: memoryAdapter([{ entity: 'post', resolve: () => ({ id: 'p' }) }]),
      maxQueryBreadth: 1,
    });
    await expect(
      new SubscriptionHub(bounded).authorizedSubscribe(wide, 'w1', () => {}, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MAX_BREADTH_EXCEEDED });
  });

  it('returns a working unsubscribe handle from a gated subscribe', async () => {
    // The handle returned by the gate path is the same object the transports
    // hold; its `unsubscribe` must release the subscription it names.
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    const sub = await hub.authorizedSubscribe('post { id }', 'h1', () => {}, {});
    expect(sub.id).toBe('h1');
    expect(hub.activeCount).toBe(1);
    sub.unsubscribe();
    expect(hub.activeCount).toBe(0);
  });

  it('rejects a gated subscribe on an adapter with no subscription hook', async () => {
    // `authorizedSubscribe` — the gate both transports use — takes a different
    // path than `subscribe`, so the "does not support subscriptions" guard has
    // to hold there too, not just on the public method.
    const plain = createOrbit({ adapters: [{ entity: 'user', resolve: () => null }] });
    const plainHub = new SubscriptionHub(plain);
    await expect(
      plainHub.authorizedSubscribe('user { id }', 'g1', () => {}, {}),
    ).rejects.toMatchObject({
      code: ErrorCode.SUBSCRIPTION_FAILED,
      details: { entity: 'user' },
    });
    // The failed gate must not leave a subscription behind.
    expect(plainHub.activeCount).toBe(0);
  });

  it('rejects duplicate ids, unknown entities and unsupported adapters', () => {
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 'a', () => {});
    expect(() => hub.subscribe('post { id }', 'a', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.SUBSCRIPTION_FAILED }),
    );
    expect(() => hub.subscribe('ghost { id }', 'b', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.ENTITY_UNREGISTERED }),
    );

    const plainOrbit = createOrbit({ adapters: [{ entity: 'x', resolve: () => null }] });
    const plainHub = new SubscriptionHub(plainOrbit);
    expect(() => plainHub.subscribe('x { id }', 'c', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.SUBSCRIPTION_FAILED }),
    );
  });

  it('canonicalizes multi-filter subscriptions (order-independent matching)', () => {
    const { orbit, counters } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    // Two different key ORDERINGS of the same filter set must share ONE
    // adapter hook (canonical sort) — and multi-key sorting also pins the
    // comparator's deterministic order.
    hub.subscribe('post(status="live",author="1") { id }', 'a', () => {});
    hub.subscribe('post(author="1",status="live") { id }', 'b', () => {});
    expect(counters.subscribeCount).toBe(1);
  });

  it('the returned handle unsubscribes exactly its own subscription', () => {
    const { orbit, counters } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    const sub = hub.subscribe('post { id }', 'a', () => {});
    hub.subscribe('post { id }', 'b', () => {});
    expect(counters.subscribeCount).toBe(1);

    sub.unsubscribe();
    expect(counters.unsubscribeCount).toBe(0); // 'b' still attached
    hub.unsubscribe('b');
    expect(counters.unsubscribeCount).toBe(1);
  });

  it('activeCount tracks live subscriptions (monitoring surface)', () => {
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    expect(hub.activeCount).toBe(0);
    hub.subscribe('post { id }', 'a', () => {});
    hub.subscribe('post { id }', 'b', () => {});
    expect(hub.activeCount).toBe(2);
    hub.unsubscribe('a');
    expect(hub.activeCount).toBe(1);
  });

  it('detach and unsubscribe of unknown ids are no-ops', () => {
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.detach('nope');
    hub.unsubscribe('nope');
    expect(hub.activeCount).toBe(0);
  });

  it('drops adapter events after the shared hook was released (fan-out guard)', () => {
    const { orbit, counters } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 'a', () => {});
    hub.unsubscribe('a');
    // A leaky adapter may still call the handler it was given — the hub must
    // ignore events whose shared bucket is already gone.
    expect(counters.lastHandler).toBeDefined();
    counters.lastHandler!({ type: 'created', id: 'p1', data: { id: 'p1' } });
    expect(hub.activeCount).toBe(0);
  });

  it('refuses to resume once the retention window dropped the requested events', async () => {
    const { orbit, create } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 's', () => {});
    for (let i = 0; i < 520; i += 1) {
      await create({ id: `p${i}`, title: 'T', status: 'live' });
    }
    // 520 events were produced; the ring kept only the newest 512 (seq 9..520).
    // Resuming from 0 can no longer be served completely, so it must be
    // REFUSED rather than replaying a silently incomplete window (the client
    // re-subscribes from scratch instead).
    expect(hub.resume('s', 0, () => {})).toBeNull();
    // The newest event is still retained, so a recent cursor resumes fine.
    const replayed: number[] = [];
    const sub = hub.resume('s', 519, (seq) => replayed.push(seq));
    expect(sub).not.toBeNull();
    expect(replayed).toEqual([520]);
    sub!.unsubscribe();
    expect(hub.activeCount).toBe(0);
  });

  it('refuses to resume when the retention window is exactly one event short', async () => {
    const { orbit, create } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 's', () => {});
    for (let i = 0; i < 513; i += 1) {
      await create({ id: `p${i}`, title: 'T', status: 'live' });
    }
    // Retained: seq 2..513. A client at seq 1 needs 2..513 — served exactly.
    const exact: number[] = [];
    const ok = hub.resume('s', 1, (seq) => exact.push(seq));
    expect(ok).not.toBeNull();
    expect(exact).toHaveLength(512);
    ok!.unsubscribe();

    // Off-by-one boundary: a client at 0 needs 1..513, and seq 1 is gone.
    expect(hub.resume('s', 0, () => {})).toBeNull();
  });

  it('rejects an over-wide selection with MAX_BREADTH_EXCEEDED', () => {
    // One node, many fields: depth 1, so `maxQueryDepth` never sees it. This is
    // the shape a depth-only limit cannot bound.
    const wide = `user { ${Array.from({ length: 6 }, (_, i) => `f${i}`).join(', ')} }`;
    expect(() => parseOQS(wide, { maxBreadth: 5 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_BREADTH_EXCEEDED }),
    );
    // Exactly at the limit is fine.
    expect(() => parseOQS(wide, { maxBreadth: 6 })).not.toThrow();
  });

  it('rejects an over-large tree with MAX_COMPLEXITY_EXCEEDED', () => {
    // Each node is within its breadth budget, but the tree total is not: the
    // shape a per-node limit alone would admit.
    const tree = `user { ${Array.from({ length: 3 }, (_, i) => `p${i} { a, b }`).join(', ')} }`;
    expect(() => parseOQS(tree, { maxComplexity: 8 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_COMPLEXITY_EXCEEDED }),
    );
    expect(() => parseOQS(tree, { maxComplexity: 9 })).not.toThrow();
  });

  it('bounds subscriptions with the same limits as queries', () => {
    // A subscription query runs the pipeline too, so it must not be a way
    // around the engine's cost limits.
    const { orbit } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    const bounded = createOrbit({
      adapters: [{ entity: 'post', resolve: () => ({ id: 'p' }) }],
      maxQueryBreadth: 1,
    });
    const wide = 'post { a, b }';
    expect(() => new SubscriptionHub(orbit).subscribe(wide, 'ok', () => {})).not.toThrow();
    expect(() => new SubscriptionHub(bounded).subscribe(wide, 'too-wide', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_BREADTH_EXCEEDED }),
    );
    hub.subscribe('post { a }', 'ok', () => {});
    expect(hub.activeCount).toBe(1);
    hub.unsubscribe('ok');
  });

  it('refuses to resume a cursor ahead of the server', () => {
    const { orbit, create } = createPostWorld();
    const hub = new SubscriptionHub(orbit);
    hub.subscribe('post { id }', 's', () => {});
    // A cursor the server never issued (stale client state after a re-subscribe)
    // cannot be confirmed — nothing could be replayed for it.
    expect(hub.resume('s', 99, () => {})).toBeNull();
    // The matching cursor resumes.
    expect(hub.resume('s', 0, () => {})).not.toBeNull();
    void create;
  });
});

// ---------------------------------------------------------------------------
// RealtimeServer over real WebSockets (global WebSocket client)
// ---------------------------------------------------------------------------

describe('RealtimeServer (websocket)', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createPostWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  async function connect(path = '/realtime') {
    const ws = new WebSocket(`ws://localhost:${port}${path}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.onmessage = (event) =>
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    return { ws, messages };
  }

  it('subscribes, acks, and streams mutation events', async () => {
    const { create } = await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => messages.some((m) => m.ack === 'sub-1'), 'ack');

    await create({ id: 'p1', title: 'Live!', status: 'live' });
    await waitFor(() => messages.some((m) => m.id === 'sub-1'), 'event');

    const event = messages.find((m) => m.id === 'sub-1')!;
    expect(event.seq).toBe(1);
    expect(event.event).toMatchObject({ type: 'created', id: 'p1' });
    ws.close();
  });

  it('releases a subscription whose socket closed mid-subscribe (race)', async () => {
    const world = await start({ retentionMs: 100 });
    const first = await connect();
    // Close IMMEDIATELY after sending subscribe — the socket is gone before
    // the server finishes the async subscription gate. The subscription must
    // still be tracked (detach + retention) so the adapter hook is released
    // instead of leaking attached forever.
    first.ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    first.ws.close();
    await waitFor(() => realtime.sessionCount === 0, 'session closed');
    await waitFor(
      () => world.counters.unsubscribeCount === world.counters.subscribeCount,
      'adapter hook released after retention',
    );

    // A fresh connection can take the id again — no 'already exists'.
    const second = await connect();
    second.ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => second.messages.some((m) => m.ack === 'sub-1'), 'ack on resubscribe');
    second.ws.close();
  });

  it('reconnects and resumes events missed while offline (retention)', async () => {
    const { create } = await start({ retentionMs: 5000 });
    const first = await connect();
    first.ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => first.messages.some((m) => m.ack === 'sub-1'), 'ack');
    first.ws.close();

    await waitFor(() => realtime.sessionCount === 0, 'session closed');
    await create({ id: 'offline', title: 'Missed me', status: 'live' }); // seq 1 while offline

    const second = await connect();
    second.ws.send(JSON.stringify({ resume: 'sub-1', after: 0 }));
    await waitFor(() => second.messages.some((m) => m.id === 'sub-1'), 'replayed event');

    const event = second.messages.find((m) => m.id === 'sub-1')!;
    expect(event.seq).toBe(1);
    expect(event.event).toMatchObject({ id: 'offline' });
    second.ws.close();
  });

  it('stops delivery after unsubscribe', async () => {
    const { create } = await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => messages.some((m) => m.ack === 'sub-1'), 'ack');
    ws.send(JSON.stringify({ unsubscribe: 'sub-1' }));
    await waitFor(() => messages.some((m) => m.unsubscribed === 'sub-1'), 'unsubscribed');

    await create({ id: 'p1', title: 'No one sees me', status: 'live' });
    await sleep(50);
    expect(messages.some((m) => m.id === 'sub-1')).toBe(false);
    ws.close();
  });

  it('replies with an error frame for unknown entities', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'ghost { id }', id: 'bad' }));
    await waitFor(() => messages.some((m) => m.error), 'error frame');
    expect(messages.find((m) => m.error)).toMatchObject({
      error: { code: ErrorCode.ENTITY_UNREGISTERED },
    });
    ws.close();
  });

  it('rejects duplicate subscription ids', async () => {
    await start();
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'dup' }));
    await waitFor(() => messages.some((m) => m.ack === 'dup'), 'ack');
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'dup' }));
    await waitFor(() => messages.filter((m) => m.error).length > 0, 'duplicate error');
    expect(messages.find((m) => m.error)).toMatchObject({
      error: { code: ErrorCode.SUBSCRIPTION_FAILED },
    });
    ws.close();
  });

  it('supports MessagePack frames end-to-end', async () => {
    const { create } = await start({ serialize: 'msgpack' });
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    const messages: Array<Record<string, unknown>> = [];
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      messages.push(decodeMsgpack(new Uint8Array(data)) as Record<string, unknown>);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    ws.send(encodeMsgpack({ subscribe: 'post { id }', id: 'mp' }));
    await waitFor(() => messages.some((m) => m.ack === 'mp'), 'msgpack ack');

    await create({ id: 'p9', title: 'Binary', status: 'live' });
    await waitFor(() => messages.some((m) => m.id === 'mp'), 'msgpack event');
    expect(messages.find((m) => m.id === 'mp')!.event).toMatchObject({ id: 'p9' });
    ws.close();
  });

  it('rejects wrong paths and bad handshakes', async () => {
    await start();
    // Wrong path → the upgrade is refused with 404.
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/nope`);
        ws.onerror = () => resolve();
        ws.onopen = () => reject(new Error('should not open'));
      }),
    ).resolves.toBeUndefined();
  });

  it('closes oversized messages with a 1009 close', async () => {
    await start({ maxMessageBytes: 1024 });
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    let closed = false;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });
    ws.onclose = () => {
      closed = true;
    };
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'big', padding: 'x'.repeat(4096) }));
    await waitFor(() => closed, 'close after oversized message');
  });

  it('close() terminates sessions and their sockets (process can exit)', async () => {
    await start();
    const { ws } = await connect();
    ws.send(JSON.stringify({ subscribe: 'post { id }', id: 'sub-1' }));
    await waitFor(() => realtime.sessionCount === 1, 'session up');

    // The client must receive the server's close frame and fully close,
    // otherwise http.Server.close() (and the process) never finishes.
    const clientClosed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    realtime.close();
    await clientClosed;
    expect(realtime.sessionCount).toBe(0);
  });
});
