import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, createOrbit, createRealtimeServer } from '@orbit/core';
import type { RealtimeServer, SubscriptionEvent } from '@orbit/core';
import { OrbitNetworkError, RealtimeClient, createClient } from '../src/index.js';
import type { RealtimeStatus } from '../src/index.js';

/**
 * A WebSocket delegate that records every socket the client opens and every
 * frame it sends — so tests can force a network drop (via `drop()`) and
 * assert the resume/fallback frames.
 */
class TestWebSocket {
  static instances: TestWebSocket[] = [];
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly OPEN = WebSocket.OPEN;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;
  readonly sent: string[] = [];
  readonly #ws: WebSocket;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.#ws = new WebSocket(url);
    TestWebSocket.instances.push(this);
    this.#ws.onopen = (event) => this.onopen?.(event);
    this.#ws.onmessage = (event) => this.onmessage?.(event);
    this.#ws.onclose = (event) => this.onclose?.(event);
    this.#ws.onerror = (event) => this.onerror?.(event);
  }

  get readyState(): number {
    return this.#ws.readyState;
  }

  send(data: Parameters<WebSocket['send']>[0]): void {
    this.sent.push(String(data));
    this.#ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.#ws.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.#ws.removeEventListener(type, listener);
  }

  dispatchEvent(event: Event): boolean {
    return this.#ws.dispatchEvent(event);
  }

  /** Every frame this socket sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  /** Simulate a network drop: the client must NOT know it was intentional. */
  drop(): void {
    this.#ws.close();
  }
}

/** All frames sent by every socket the client has opened so far. */
function allFrames(): Array<Record<string, unknown>> {
  return TestWebSocket.instances.flatMap((socket) => socket.frames());
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForStatus(
  handle: { onStatus(cb: (s: RealtimeStatus) => void): void },
  status: RealtimeStatus,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`status '${status}' not reached`)), 4000);
    handle.onStatus((current) => {
      if (current === status) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

interface ChatWorld {
  orbit: ReturnType<typeof createOrbit>;
  emit(event: SubscriptionEvent): void;
  messages: Array<{ id: string; text: string }>;
  adapterHooks: number;
}

/** A chat entity with a real `subscribe` hook and a test-controlled emit. */
function makeChatWorld(): ChatWorld {
  const messages: Array<{ id: string; text: string }> = [];
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const emit = (event: SubscriptionEvent) => {
    for (const handler of handlers) handler(event);
  };
  const orbit = createOrbit({
    adapters: [
      {
        entity: 'chat',
        resolve: () => messages,
        mutate: (action: string, args: { payload?: { text?: string } }) => {
          if (action === 'send') {
            const message = { id: String(messages.length + 1), text: args.payload?.text ?? '' };
            messages.push(message);
            emit({ type: 'created', id: message.id, data: message });
            return { id: message.id };
          }
          throw new Error(`unknown chat action '${action}'`);
        },
        subscribe: (_filters: unknown, handler: (event: SubscriptionEvent) => void) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
    ],
  });
  return {
    orbit,
    emit,
    messages,
    get adapterHooks() {
      return handlers.size;
    },
  };
}

interface RealtimeHarness {
  wsUrl: string;
  realtime: RealtimeServer;
  close(): Promise<void>;
}

async function serveRealtime(
  orbit: ReturnType<typeof createOrbit>,
  options: { retentionMs?: number } = {},
): Promise<RealtimeHarness> {
  const server = createServer();
  const realtime = createRealtimeServer(orbit, {
    retentionMs: options.retentionMs ?? 60_000,
  });
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${port}/realtime`,
    realtime,
    close: async () => {
      realtime.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('realtime — unit (fake socket frames)', () => {
  /** A scripted WebSocket: the test drives open/close and inbound frames. */
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    readonly sent: string[] = [];
    readyState = FakeWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string | URL) {
      this.url = String(url);
      FakeWebSocket.instances.push(this);
    }
    send(data: Parameters<WebSocket['send']>[0]): void {
      this.sent.push(String(data));
    }
    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.(new Event('close') as CloseEvent);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(_event: Event): boolean {
      return true;
    }
    frames(): Array<Record<string, unknown>> {
      return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    }
    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }
    receive(message: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }
    receiveRaw(data: string): void {
      this.onmessage?.({ data } as MessageEvent);
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  function unitClient(): ReturnType<typeof createClient> {
    return createClient({
      baseUrl: 'http://orbit.invalid',
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
  }

  it('routes a subscription error (with id) to onError', () => {
    const client = unitClient();
    const errors: Array<{ code: string; message: string }> = [];
    client.subscribe('chat { id }', () => {}, {
      id: 'feed',
      onError: (error) => errors.push({ code: error.code, message: error.message }),
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({
      id: 'feed',
      error: { code: ErrorCode.PERMISSION_DENIED, message: 'denied' },
    });
    expect(errors).toEqual([{ code: ErrorCode.PERMISSION_DENIED, message: 'denied' }]);
  });

  it('ignores error frames without an id (uncorrelatable noise)', () => {
    const client = unitClient();
    const errors: Error[] = [];
    const _sub = client.subscribe('chat { id }', () => {}, {
      onError: (error) => errors.push(error),
    });
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive({
      error: { code: ErrorCode.INTERNAL, message: 'noise' },
    });
    expect(errors).toHaveLength(0);
  });

  it('handles unsubscribed frames and tolerates garbage inbound data', () => {
    const client = unitClient();
    const errors: Error[] = [];
    const _sub = client.subscribe('chat { id }', () => {}, {
      id: 'feed',
      onError: (e) => errors.push(e),
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // Invalid JSON and non-object frames are dropped without crashing.
    ws.receiveRaw('{not json');
    ws.receiveRaw('42');
    // The server confirmed the unsubscribe; the client forgets delivery.
    ws.receive({ unsubscribed: 'feed' });
    ws.receive({ id: 'feed', seq: 5, event: { type: 'created', id: '1', data: null } });
    // A later ack re-attaches.
    ws.receive({ ack: 'feed' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a socket request via an error frame without a status field', async () => {
    const client = unitClient();
    // request() opens the socket (auto-connect) before waiting for a reply.
    const reply = client.socket().request({ query: 'chat { id }' });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // Wait until the request has sent its frame (and registered its pending).
    await waitFor(() => ws.frames().some((frame) => frame.id === 'req-1'));
    ws.receive({
      id: 'req-1',
      error: { code: ErrorCode.ENTITY_UNREGISTERED, message: 'nope' },
    });
    await expect(reply).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
    });
  });

  it('times out a socket request that never answers', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' }, { timeoutMs: 50 });
    FakeWebSocket.instances[0]!.open();
    await expect(reply).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('exposes the handle surface (id, onError, onAck) and RealtimeClient status', () => {
    const client = unitClient();
    const sub = client.subscribe('chat { id }', () => {}, { id: 'feed' });
    expect(sub.id).toBe('feed');
    const errors: Error[] = [];
    const acks: string[] = [];
    sub.onError((error) => errors.push(error));
    sub.onAck((id, kind) => acks.push(`${id}:${kind}`));
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive({
      id: 'feed',
      error: { code: ErrorCode.SUBSCRIPTION_FAILED, message: 'boom' },
    });
    expect(errors).toHaveLength(1);
    FakeWebSocket.instances[0]!.receive({ ack: 'feed' });
    expect(acks).toEqual(['feed:subscribe']);
    // The client is closed after the last subscription closes.
    sub.close();
  });

  it('rejects a socket request whose signal is already aborted', async () => {
    const client = unitClient();
    const controller = new AbortController();
    controller.abort();
    const reply = client.socket().request({ query: 'chat { id }' }, { signal: controller.signal });
    FakeWebSocket.instances[0]!.open();
    await expect(reply).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a socket request when its signal aborts mid-flight', async () => {
    const client = unitClient();
    const controller = new AbortController();
    const reply = client.socket().request({ query: 'chat { id }' }, { signal: controller.signal });
    FakeWebSocket.instances[0]!.open();
    await waitFor(() => FakeWebSocket.instances[0]!.frames().length >= 1);
    controller.abort();
    await expect(reply).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts with a DOMException when the signal carries no reason', async () => {
    const client = unitClient();
    const fakeSignal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const reply = client.socket().request({ query: 'chat { id }' }, { signal: fakeSignal });
    FakeWebSocket.instances[0]!.open();
    await expect(reply).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails a socket request when the socket never connects', async () => {
    vi.useFakeTimers();
    try {
      const client = unitClient();
      const reply = client.socket().request({ query: 'chat { id }' });
      // Attach the handler BEFORE the connect timeout fires (fake timers
      // advance synchronously — an unhandled rejection would surface).
      const settled = reply.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settled).toBeInstanceOf(OrbitNetworkError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes RealtimeClient.status for direct use', () => {
    const realtime = new RealtimeClient(
      'ws://orbit.invalid/realtime',
      FakeWebSocket as unknown as typeof WebSocket,
    );
    expect(realtime.status).toBe('closed');
    const sub = realtime.subscribe('chat { id }', () => {});
    expect(sub.id).toBe('sub-1');
    realtime.close();
    expect(realtime.status).toBe('closed');
  });

  it('supports onAck as a subscribe option and sends immediately on an open socket', () => {
    const client = unitClient();
    const acks: Array<{ id: string; kind: string }> = [];
    const _first = client.subscribe('chat { id }', () => {}, {
      onAck: (id, kind) => acks.push({ id, kind }),
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ ack: 'sub-1' });
    expect(acks).toEqual([{ id: 'sub-1', kind: 'subscribe' }]);

    // A subscription added while the socket is already open is sent at once.
    const _second = client.subscribe('chat { id }', () => {}, { id: 'feed-2' });
    expect(ws.frames().some((frame) => frame.id === 'feed-2')).toBe(true);
  });

  it('throws when the socket dies before the request registers', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' });
    const settled = reply.catch((error: unknown) => error);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.close(); // the socket is gone before the request continuation runs
    expect(await settled).toBeInstanceOf(OrbitNetworkError);
  });

  it('clears the request timer when a reply arrives in time', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' }, { timeoutMs: 5000 });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await waitFor(() => ws.frames().some((frame) => frame.id === 'req-1'));
    ws.receive({ id: 'req-1', status: 200, data: [] });
    await expect(reply).resolves.toMatchObject({ status: 200, data: [] });
  });

  it('close() cancels a pending reconnect', async () => {
    const client = unitClient();
    const _sub = client.subscribe('chat { id }', () => {});
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.close(); // network drop → a reconnect is scheduled
    client.close(); // cancels it — no further sockets are created
    const sockets = FakeWebSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(FakeWebSocket.instances.length).toBe(sockets);
  });

  it('schedules a reconnect when the WebSocket constructor throws', async () => {
    class ThrowingWebSocket {
      static attempts = 0;
      static readonly OPEN = 1;
      constructor() {
        ThrowingWebSocket.attempts += 1;
        throw new Error('websocket unavailable');
      }
      send(_data: Parameters<WebSocket['send']>[0]): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(_event: Event): boolean {
        return true;
      }
    }
    const client = createClient({
      baseUrl: 'http://orbit.invalid',
      WebSocket: ThrowingWebSocket as unknown as typeof WebSocket,
    });
    client.subscribe('chat { id }', () => {});
    expect(ThrowingWebSocket.attempts).toBe(1);
    await waitFor(() => ThrowingWebSocket.attempts >= 2);
    client.close();
  });

  it('does not stack multiple reconnect timers', async () => {
    class FlakyWebSocket {
      static attempts = 0;
      static readonly OPEN = 1;
      constructor() {
        FlakyWebSocket.attempts += 1;
        // The first two connect attempts fail; only the retry succeeds.
        if (FlakyWebSocket.attempts <= 2) throw new Error('websocket unavailable');
      }
      send(_data: Parameters<WebSocket['send']>[0]): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(_event: Event): boolean {
        return true;
      }
    }
    const client = createClient({
      baseUrl: 'http://orbit.invalid',
      WebSocket: FlakyWebSocket as unknown as typeof WebSocket,
    });
    client.subscribe('chat { id }', () => {});
    // A second connect attempt while the first reconnect is still pending
    // must not schedule a second timer (the guard short-circuits).
    client.subscribe('chat { id }', () => {}, { id: 'feed-2' });
    expect(FlakyWebSocket.attempts).toBe(2);
    client.close();
  });

  it('handles events without a seq and ignores stale seqs', () => {
    const client = unitClient();
    const seen: Array<{ event: SubscriptionEvent; seq: number }> = [];
    const sub = client.subscribe('chat { id }', (event, meta) =>
      seen.push({ event, seq: meta.seq }),
    );
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // No seq field → the entry's current seq (0) is used.
    ws.receive({ id: 'sub-1', event: { type: 'created', id: '1', data: null } });
    expect(seen).toEqual([{ event: { type: 'created', id: '1', data: null }, seq: 0 }]);
    // A stale (lower) seq does not roll the cursor back.
    ws.receive({ id: 'sub-1', seq: 5, event: { type: 'created', id: '2', data: null } });
    ws.receive({ id: 'sub-1', seq: 3, event: { type: 'created', id: '3', data: null } });
    expect(sub.seq).toBe(5); // the cursor ignores the stale 3
    expect(seen[2]!.seq).toBe(3); // meta.seq is the frame's value
  });

  it('ignores replies and errors for unknown ids', () => {
    const client = unitClient();
    const errors: Error[] = [];
    const _sub = client.subscribe('chat { id }', () => {}, { onError: (e) => errors.push(e) });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ id: 'req-99', status: 200, data: [] }); // stale reply, no pending
    ws.receive({ id: 'ghost-sub', error: { code: ErrorCode.SUBSCRIPTION_FAILED, message: 'x' } });
    expect(errors).toHaveLength(0);
  });

  it('makes handle.close() idempotent', () => {
    const client = unitClient();
    const sub = client.subscribe('chat { id }', () => {}, { id: 'feed' });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    sub.close();
    sub.close(); // second close is a no-op
    // A late event for the closed subscription is ignored.
    ws.receive({ id: 'feed', seq: 9, event: { type: 'created', id: '1', data: null } });
  });

  it('does not open a second socket while one is connecting', () => {
    const client = unitClient();
    client.subscribe('chat { id }', () => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    // A subscription added while the first socket is still connecting reuses
    // it instead of opening another (the reconnect guard short-circuits).
    client.subscribe('chat { id }', () => {}, { id: 'feed-2' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]!.open();
    // Both subscriptions are sent once the shared socket opens.
    expect(FakeWebSocket.instances[0]!.frames().some((frame) => frame.id === 'feed-2')).toBe(true);
    client.close();
  });

  it('ignores control frames for unknown subscriptions and unrecognized frames', () => {
    const client = unitClient();
    const errors: Error[] = [];
    client.subscribe('chat { id }', () => {}, { onError: (e) => errors.push(e) });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    // Control frames referencing a subscription this client never made.
    ws.receive({ ack: 'ghost' });
    ws.receive({ resumed: 'ghost' });
    ws.receive({ unsubscribed: 'ghost' });
    // A frame matching none of the protocol shapes is dropped.
    ws.receive({ hello: 'world' });
    expect(errors).toHaveLength(0);
    client.close();
  });

  it('maps fromCache, invalidates and contentType from a socket reply', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await waitFor(() => ws.frames().some((frame) => frame.id === 'req-1'));
    ws.receive({
      id: 'req-1',
      status: 200,
      data: 'cached payload',
      fromCache: true,
      invalidates: ['chat.send'],
      contentType: 'application/json',
    });
    await expect(reply).resolves.toMatchObject({
      status: 200,
      data: 'cached payload',
      fromCache: true,
      invalidates: ['chat.send'],
      contentType: 'application/json',
    });
    client.close();
  });

  it('falls back to defaults for a malformed error reply', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await waitFor(() => ws.frames().some((frame) => frame.id === 'req-1'));
    // A non-record error field maps to the internal-error defaults.
    ws.receive({ id: 'req-1', status: 500, error: 'not a record' });
    await expect(reply).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      message: 'Orbit request failed',
      status: 500,
    });
    client.close();
  });

  it('rejects pending requests when the client closes', async () => {
    const client = unitClient();
    const reply = client.socket().request({ query: 'chat { id }' });
    const settled = reply.catch((error: unknown) => error);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    await waitFor(() => ws.frames().some((frame) => frame.id === 'req-1'));
    client.close();
    expect(await settled).toBeInstanceOf(OrbitNetworkError);
  });
});

describe('@orbit/client — realtime (real WebSocket server)', () => {
  let harness: RealtimeHarness | undefined;
  let client: ReturnType<typeof createClient> | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await harness?.close();
    harness = undefined;
    TestWebSocket.instances = [];
  });

  function newClient(url: string): ReturnType<typeof createClient> {
    client = createClient({
      baseUrl: 'http://orbit.invalid',
      realtimeUrl: url,
      WebSocket: TestWebSocket as unknown as typeof WebSocket,
    });
    return client;
  }

  async function startWorld(options: { retentionMs?: number } = {}) {
    const world = makeChatWorld();
    harness = await serveRealtime(world.orbit, options);
    return { world, wsUrl: harness.wsUrl };
  }

  it('subscribes, acks and delivers events with seq', async () => {
    const { world, wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const seen: Array<{ event: SubscriptionEvent; seq: number }> = [];
    const statuses: RealtimeStatus[] = [];
    const acks: Array<{ id: string; kind: 'subscribe' | 'resume'; seq: number }> = [];
    const sub = clientInstance.subscribe('chat { id, text }', (event, meta) => {
      seen.push({ event, seq: meta.seq });
    });
    sub.onStatus((status) => statuses.push(status));
    sub.onAck((id, kind, seq) => acks.push({ id, kind, seq }));
    await waitForStatus(sub, 'live');
    // Emit only after the server confirmed the subscription (the adapter hook
    // is registered by the time the ack lands).
    await waitFor(() => acks.length === 1);
    expect(acks[0]).toEqual({ id: 'sub-1', kind: 'subscribe', seq: 0 });

    world.emit({ type: 'created', id: '1', data: { id: '1', text: 'hola' } });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({
      event: { type: 'created', id: '1', data: { id: '1', text: 'hola' } },
      seq: 1,
    });
    expect(sub.seq).toBe(1);
    expect(statuses).toContain('live');
  });

  it('multiplexes subscriptions on a single socket', async () => {
    const { wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const first = clientInstance.subscribe('chat { id }', () => {});
    const second = clientInstance.subscribe('chat { id }', () => {}, { id: 'feed-2' });
    await waitForStatus(first, 'live');

    expect(TestWebSocket.instances).toHaveLength(1);
    expect(allFrames()).toContainEqual({ subscribe: 'chat { id }', id: 'sub-1' });
    expect(allFrames()).toContainEqual({ subscribe: 'chat { id }', id: 'feed-2' });

    // Closing one subscription keeps the socket open…
    first.close();
    await waitFor(() => TestWebSocket.instances[0]!.readyState === WebSocket.OPEN);
    expect(TestWebSocket.instances).toHaveLength(1);

    // …closing the last one closes it.
    second.close();
    await waitFor(() => TestWebSocket.instances[0]!.readyState === WebSocket.CLOSED);
    expect(TestWebSocket.instances).toHaveLength(1);
  });

  it('rejects duplicate subscription ids', async () => {
    const { wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);
    clientInstance.subscribe('chat { id }', () => {}, { id: 'feed' });
    expect(() => clientInstance.subscribe('chat { id }', () => {}, { id: 'feed' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.SUBSCRIPTION_FAILED }),
    );
  });

  it('resumes after a network drop and replays missed events', async () => {
    const { world, wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const seen: Array<{ event: SubscriptionEvent; seq: number }> = [];
    const acks: Array<{ id: string; kind: 'subscribe' | 'resume'; seq: number }> = [];
    const sub = clientInstance.subscribe('chat { id, text }', (event, meta) => {
      seen.push({ event, seq: meta.seq });
    });
    sub.onAck((id, kind, seq) => acks.push({ id, kind, seq }));
    await waitForStatus(sub, 'live');
    await waitFor(() => acks.length === 1);
    world.emit({ type: 'created', id: '1', data: { id: '1', text: 'one' } });
    await waitFor(() => seen.length === 1);

    // Network drop: the server detaches (retention window holds the log) and
    // the client schedules a reconnect with backoff.
    TestWebSocket.instances.at(-1)!.drop();
    await waitFor(() => harness!.realtime.sessionCount === 0);
    await waitFor(() => TestWebSocket.instances.length === 2);

    // Emit while offline — only the resume replay can deliver it.
    world.emit({ type: 'created', id: '2', data: { id: '2', text: 'two' } });
    await waitFor(() => seen.length === 2);

    expect(seen[1]!.seq).toBe(2);
    expect(seen[1]!.event).toMatchObject({ id: '2', data: { id: '2', text: 'two' } });
    // The client resumed from the last applied seq.
    const resume = allFrames().find((frame) => frame.resume !== undefined);
    expect(resume).toMatchObject({ resume: 'sub-1', after: 1 });
  });

  it('falls back to a fresh subscribe when resume hits an expired retention', async () => {
    // retentionMs < the reconnect backoff: by the time the client reconnects,
    // the subscription is gone and `resume` answers ORBIT_SUBSCRIPTION_FAILED.
    const { world, wsUrl } = await startWorld({ retentionMs: 100 });
    const clientInstance = newClient(wsUrl);

    const onErrors: Error[] = [];
    const acks: Array<{ id: string; kind: 'subscribe' | 'resume'; seq: number }> = [];
    const seen: Array<{ event: SubscriptionEvent; seq: number }> = [];
    const sub = clientInstance.subscribe(
      'chat { id, text }',
      (event, meta) => {
        seen.push({ event, seq: meta.seq });
      },
      { id: 'feed', onError: (error) => onErrors.push(error) },
    );
    sub.onAck((id, kind, seq) => acks.push({ id, kind, seq }));
    await waitForStatus(sub, 'live');
    // Wait for the ack so the subscription is fully attached before the drop.
    await waitFor(() => acks.length === 1);

    TestWebSocket.instances.at(-1)!.drop();
    await waitFor(() => TestWebSocket.instances.length === 2);

    // The resume fails and the client silently re-subscribes fresh.
    await waitFor(
      () =>
        allFrames().filter((frame) => frame.subscribe !== undefined && frame.id === 'feed')
          .length >= 2,
    );
    expect(onErrors).toHaveLength(0);

    // Wait for the fresh subscribe's ack — the emit below must not race the
    // server's async adapter-hook registration, or the event is lost.
    await waitFor(() => acks.filter((ack) => ack.kind === 'subscribe').length === 2);

    // The fresh subscription is live again.
    world.emit({ type: 'created', id: '3', data: { id: '3', text: 'three' } });
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.seq).toBe(1);
  });

  it('answers envelope requests over the socket (query, mutation, error)', async () => {
    const { wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const seen: Array<{ event: SubscriptionEvent; seq: number }> = [];
    const sub = clientInstance.subscribe('chat { id, text }', (event, meta) => {
      seen.push({ event, seq: meta.seq });
    });
    await waitForStatus(sub, 'live');

    const query = await clientInstance.socket().request({ query: 'chat { id, text }' });
    expect(query.status).toBe(200);
    expect(query.data).toEqual([]);

    const mutation = await clientInstance
      .socket()
      .request({ do: 'chat.send', args: { payload: { text: 'via socket' } } });
    expect(mutation.status).toBe(200);
    expect(mutation.data).toEqual({ success: true, id: '1' });

    // The mutation ran through the full pipeline — the event reached the sub.
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.event).toMatchObject({
      type: 'created',
      data: { id: '1', text: 'via socket' },
    });

    // The error contract is the same as HTTP.
    await expect(clientInstance.socket().request({ query: 'ghost { id }' })).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
      status: 404,
    });
  });

  it('connects automatically for a bare socket request', async () => {
    const { wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);
    const reply = await clientInstance.socket().request({ query: 'chat { id }' });
    expect(reply.status).toBe(200);
    expect(TestWebSocket.instances).toHaveLength(1);
  });

  it('close() terminates the socket and refuses further realtime use', async () => {
    const { wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const sub = clientInstance.subscribe('chat { id }', () => {});
    await waitForStatus(sub, 'live');
    clientInstance.close();
    await waitFor(() => TestWebSocket.instances.at(-1)!.readyState === WebSocket.CLOSED);

    expect(() => clientInstance.subscribe('chat { id }', () => {})).toThrow();
    await expect(clientInstance.socket().request({ query: 'chat { id }' })).rejects.toBeInstanceOf(
      OrbitNetworkError,
    );
  });

  it('delivers a realtime event for a socket mutation (round-trip)', async () => {
    const { world, wsUrl } = await startWorld();
    const clientInstance = newClient(wsUrl);

    const seen: Array<SubscriptionEvent> = [];
    const sub = clientInstance.subscribe('chat { id, text }', (event) => seen.push(event));
    await waitForStatus(sub, 'live');

    await clientInstance.socket().request({ do: 'chat.send', args: { payload: { text: 'hi' } } });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ type: 'created', data: { text: 'hi' } });

    // Also an HTTP mutation reaches the same subscription (shared adapter hook).
    expect(world.messages).toHaveLength(1);
  });
});
