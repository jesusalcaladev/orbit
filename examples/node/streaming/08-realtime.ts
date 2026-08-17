/**
 * 08 — Realtime: WebSocket subscriptions with reconnect + resume, via @orbit/client
 *
 * The full realtime story in one file: a node:http server mounts Orbit's
 * WebSocket transport (`createRealtimeServer`), the client subscribes to
 * `post(status="live")`, mutations stream events over the socket, and — the
 * good part — when the network drops, the server RETAINS the subscription for
 * a window and the client RECONNECTS + RESUMES automatically, replaying the
 * missed patches from its last `seq`. Zero dependencies on the server: the
 * WebSocket protocol (RFC 6455) is hand-rolled. The client is `@orbit/client`
 * with an injectable WebSocket so the demo can simulate the drop.
 *
 * Run:  node examples/node/streaming/08-realtime.ts   (after `npm run build`)
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createOrbit, createRealtimeServer } from '@orbit/core';
import type {
  DataAdapter,
  Filters,
  MutationArgs,
  MutationResult,
  OrbitContext,
  SubscriptionEvent,
} from '@orbit/core';
import { createClient } from '@orbit/client';
import type { RealtimeStatus } from '@orbit/client';

interface Post {
  id: string;
  title: string;
  status: 'live' | 'draft';
}

// A tiny emitter so mutations and subscriptions share one event bus.
const handlers = new Set<(event: SubscriptionEvent) => void>();
const emit = (event: SubscriptionEvent) => {
  for (const handler of handlers) handler(event);
};

const posts = new Map<string, Post>([
  ['p1', { id: 'p1', title: 'Orbit goes realtime', status: 'live' }],
  ['p2', { id: 'p2', title: 'RFC 6455 by hand', status: 'draft' }],
]);

// The full DataAdapter contract — subscribe wired to the same bus as mutate.
const postAdapter: DataAdapter = {
  entity: 'post',
  resolve: (filters: Filters, _ctx: OrbitContext) => {
    let list = [...posts.values()];
    if (filters.status) list = list.filter((p) => p.status === filters.status);
    if (filters.id) return posts.get(filters.id);
    return list;
  },
  mutate: (action: string, args: MutationArgs): MutationResult => {
    const payload = args.payload as Post | undefined;
    if (action === 'create' && payload) {
      posts.set(payload.id, payload);
      emit({ type: 'created', id: payload.id, data: payload, patch: { ...payload } });
      return { id: payload.id };
    }
    if (action === 'update' && args.filter?.id && payload) {
      const post = posts.get(args.filter.id);
      if (post) {
        Object.assign(post, payload);
        emit({ type: 'updated', id: post.id, data: post, patch: { ...payload } });
      }
      return { id: args.filter.id };
    }
    throw new Error(`unknown action '${action}'`);
  },
  subscribe: (_filters: Filters, handler: (event: SubscriptionEvent) => void) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A controllable WebSocket: delegates to Node's built-in WebSocket but records
 * every instance, so the demo can force a network `drop()` mid-session — the
 * client cannot tell it apart from a real outage, and its reconnect + resume
 * machinery takes over (the same injection point documented for RN/Workers).
 */
class ControllableWebSocket {
  static instances: ControllableWebSocket[] = [];
  static readonly OPEN = WebSocket.OPEN;
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;
  readonly #ws: WebSocket;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.#ws = new WebSocket(url);
    ControllableWebSocket.instances.push(this);
    this.#ws.onopen = (event) => this.onopen?.(event);
    this.#ws.onmessage = (event) => this.onmessage?.(event);
    this.#ws.onclose = (event) => this.onclose?.(event);
    this.#ws.onerror = (event) => this.onerror?.(event);
  }

  get readyState(): number {
    return this.#ws.readyState;
  }

  send(data: Parameters<WebSocket['send']>[0]): void {
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

  /** Simulate a network drop — the client must NOT know it was intentional. */
  drop(): void {
    this.#ws.close();
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** True when this module is the process entry point (not imported by run-all). */
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

export async function main(): Promise<void> {
  const orbit = createOrbit({ adapters: [postAdapter] });

  // One http server hosts BOTH the Orbit handler (for client.mutate) and the
  // realtime transport (the client derives ws://…/realtime from its baseUrl).
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/orbit') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await orbit.handler(
        new Request('http://localhost/orbit', {
          method: 'POST',
          headers: {
            'content-type': req.headers['content-type'] ?? 'application/json',
            accept: req.headers.accept ?? 'application/json',
            ...(req.headers['accept-encoding']
              ? { 'accept-encoding': String(req.headers['accept-encoding']) }
              : {}),
          },
          body: Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        ...(response.headers.get('content-encoding')
          ? { 'content-encoding': response.headers.get('content-encoding')! }
          : {}),
      });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('POST /orbit (HTTP) or a WebSocket upgrade to /realtime');
  });
  const realtime = createRealtimeServer(orbit, { path: '/realtime', retentionMs: 10_000 });
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  console.log(`🛰  realtime endpoint  ws://localhost:${port}/realtime`);

  const client = createClient({
    baseUrl: `http://localhost:${port}/orbit`,
    WebSocket: ControllableWebSocket as unknown as typeof WebSocket,
  });

  // 1. Subscribe — one shared socket, seq-numbered events.
  const seen: Array<{ seq: number; event: SubscriptionEvent }> = [];
  const acks: Array<{ kind: 'subscribe' | 'resume'; seq: number }> = [];
  const sub = client.subscribe(
    'post(status="live") { id, title }',
    (event, meta) => {
      seen.push({ seq: meta.seq, event });
      console.log(`    event:      ${meta.seq} · ${event.type} ${event.id}`);
    },
    { id: 'feed', onAck: (_id, kind, seq) => acks.push({ kind, seq }) },
  );
  sub.onStatus((status: RealtimeStatus) => console.log(`    status:     ${status}`));

  // Fire the mutation only after the server acked the subscription — an emit
  // before the adapter hook attaches would be lost.
  await waitFor(() => acks.some((ack) => ack.kind === 'subscribe'), 'subscribe ack');
  console.log('    subscribed: feed (shared adapter hook, seq numbers)');

  // 2. A mutation streams over the socket as an event.
  await client.mutate('post.create', {
    payload: { id: 'p3', title: 'Delta sync', status: 'live' },
  });
  await waitFor(() => seen.some((entry) => entry.event.id === 'p3'), 'p3 event');

  // 3. The network drops: the server detaches (retention window) and the
  // client schedules a reconnect with backoff — it does not know it was
  // intentional.
  ControllableWebSocket.instances.at(-1)!.drop();
  await waitFor(() => realtime.sessionCount === 0, 'session detached');
  console.log('    offline:    p3 seen, socket dropped (server retains)');

  // 4. A mutation while nobody is connected — the event is logged, not lost.
  await client.mutate('post.create', {
    payload: { id: 'p4', title: 'Missed while offline', status: 'live' },
  });
  console.log('    offline:    p4 created (nobody is connected)');

  // 5. The client reconnects and resumes from its last seq — p4 replays.
  // The server sends the replayed events BEFORE the `resumed` ack, so wait
  // for both before declaring victory.
  await waitFor(
    () =>
      seen.some((entry) => entry.event.id === 'p4') && acks.some((ack) => ack.kind === 'resume'),
    'p4 replayed via resume',
  );
  const replayed = seen.find((entry) => entry.event.id === 'p4');
  console.log(`    resumed:    ${replayed ? 'p4 replayed via resume ✅' : 'nothing replayed ❌'}`);

  client.close();
  realtime.close(); // terminates every session: close frame + socket destroy
  server.close();
  server.closeAllConnections(); // backstop for any lingering connection

  // Node's built-in WebSocket (undici) keeps its client-side socket handle
  // alive even after a clean close — a Node platform behavior, not an Orbit
  // leak (the server has already terminated every session). When run
  // standalone, flush the output and exit explicitly. When imported by
  // run-all, just print — the harness exits once every example is done.
  if (isEntry) {
    process.stdout.write('    done (realtime transport: zero-dependency RFC 6455)\n', () =>
      process.exit(0),
    );
  } else {
    console.log('    done (realtime transport: zero-dependency RFC 6455)');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
