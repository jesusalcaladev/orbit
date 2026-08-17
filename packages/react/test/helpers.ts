/**
 * Test helpers: a fake `OrbitClient` transport (typed as the real class) and
 * response builders. The react client only ever calls
 * `query`/`mutate`/`subscribe`/`stream`/`socket`/`close` on the transport,
 * so a structural fake exercises every code path without the network.
 */
import { vi } from 'vitest';
import type {
  OrbitClient,
  OrbitResponse,
  RealtimeStatus,
  SubscribeOptions,
  SubscriptionEvent,
  SubscriptionHandle,
} from '@orbit/client';
import type { OrbitError } from '@orbit/core';
import { OrbitReactClient } from '../src/client.js';

/** A minimal successful Orbit response (spec §6 shape). */
export function okResponse<T>(
  data: T,
  options: { status?: number; fromCache?: boolean; invalidates?: string[] } = {},
): OrbitResponse<T> {
  return {
    data,
    status: options.status ?? 200,
    ...(options.fromCache !== undefined ? { fromCache: options.fromCache } : {}),
    ...(options.invalidates !== undefined ? { invalidates: options.invalidates } : {}),
    headers: new Headers(),
    raw: new Response(),
  };
}

/** A captured fake subscription, so tests can emit events/status/errors. */
export interface FakeSub {
  query: string;
  handler: (event: SubscriptionEvent, meta: { seq: number }) => void;
  options: SubscribeOptions;
  handle: SubscriptionHandle;
  emit: (event: SubscriptionEvent, seq?: number) => void;
  emitStatus: (status: RealtimeStatus) => void;
  emitError: (error: OrbitError) => void;
}

export interface FakeTransport {
  query: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  socket: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  subs: FakeSub[];
}

/** Build a fake transport; cast to `OrbitClient` for the react client. */
export function fakeTransport(): { transport: FakeTransport; client: OrbitClient } {
  const subs: FakeSub[] = [];
  const transport: FakeTransport = {
    query: vi.fn(),
    mutate: vi.fn(),
    subscribe: vi.fn(),
    stream: vi.fn(),
    socket: vi.fn(),
    close: vi.fn(),
    subs,
  };

  transport.subscribe.mockImplementation(
    (
      query: string,
      handler: (event: SubscriptionEvent, meta: { seq: number }) => void,
      options: SubscribeOptions = {},
    ) => {
      let seq = 0;
      const statusCbs = new Set<(status: RealtimeStatus) => void>();
      const errorCbs = new Set<(error: OrbitError) => void>();
      const ackCbs = new Set<(id: string, kind: 'subscribe' | 'resume', seq: number) => void>();
      const sub: FakeSub = {
        query,
        handler,
        options,
        handle: undefined as unknown as SubscriptionHandle,
        emit: (event, nextSeq) => {
          if (nextSeq !== undefined) seq = nextSeq;
          else seq += 1;
          handler(event, { seq });
        },
        emitStatus: (status) => {
          for (const cb of statusCbs) cb(status);
        },
        emitError: (error) => {
          for (const cb of errorCbs) cb(error);
        },
      };
      const handle: SubscriptionHandle = {
        id: `sub-${subs.length + 1}`,
        get seq() {
          return seq;
        },
        close: vi.fn(),
        onStatus: (cb) => {
          statusCbs.add(cb);
        },
        onError: (cb) => {
          errorCbs.add(cb);
        },
        onAck: (cb) => {
          ackCbs.add(cb);
        },
      };
      sub.handle = handle;
      subs.push(sub);
      // Mirror the real RealtimeClient: `options.onError` joins the same
      // callbacks `handle.onError` registers.
      if (options.onError !== undefined) errorCbs.add(options.onError);
      return handle;
    },
  );

  return { transport, client: transport as unknown as OrbitClient };
}

/** Build a react client over a fake transport. */
export function reactClientOf(
  transport: FakeTransport,
  overrides: { defaultTtl?: number; defaultStale?: number; maxEntries?: number } = {},
): OrbitReactClient {
  return new OrbitReactClient({
    client: transport as unknown as OrbitClient,
    ...overrides,
  });
}

/** An async-iterable stream of SSE frames for `transport.stream` mocks. */
export function frames(
  framesList: Array<{ level: number | 'done'; data: unknown }>,
): AsyncIterable<{
  level: number | 'done';
  data: unknown;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of framesList) yield frame;
    },
  };
}
