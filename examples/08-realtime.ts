/**
 * 08 — Realtime: WebSocket subscriptions with reconnect + resume
 *
 * The full realtime story in one file: a node:http server mounts Orbit's
 * WebSocket transport (`createRealtimeServer`), a client subscribes to
 * `post(status="live")`, mutations stream events over the socket, and — the
 * good part — when the client drops, the server RETAINS the subscription for
 * a window and replays the missed patches on `resume`. Zero dependencies:
 * the WebSocket protocol (RFC 6455) is hand-rolled, and the client is Node's
 * built-in `WebSocket`.
 *
 * Run:  node examples/08-realtime.ts   (after `npm run build`)
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

/** True when this module is the process entry point (not imported by run-all). */
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

export async function main(): Promise<void> {
  const orbit = createOrbit({ adapters: [postAdapter] });
  const server = createServer();
  const realtime = createRealtimeServer(orbit, { path: '/realtime', retentionMs: 10_000 });
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  console.log(`🛰  realtime endpoint  ws://localhost:${port}/realtime`);

  const messages: Array<Record<string, unknown>> = [];
  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/realtime`);
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        messages.push(message);
        if (message.id !== undefined) {
          console.log(
            `    event:      ${String(message.seq)} · ${String((message.event as SubscriptionEvent).type)} ${String((message.event as SubscriptionEvent).id)}`,
          );
        }
      };
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('websocket failed to open'));
    });

  // 1. Subscribe and stream live events.
  const ws1 = await connect();
  ws1.send(JSON.stringify({ subscribe: 'post(status="live") { id, title }', id: 'feed' }));
  await sleep(100);
  await orbit.execute({
    do: 'post.create',
    args: { payload: { id: 'p3', title: 'Delta sync', status: 'live' } },
  });
  await sleep(100);
  console.log('    subscribed: feed (shared adapter hook, seq numbers)');

  // 2. Drop the connection; the server keeps the subscription (retention).
  ws1.close();
  await sleep(150);
  await orbit.execute({
    do: 'post.create',
    args: { payload: { id: 'p4', title: 'Missed while offline', status: 'live' } },
  });
  console.log('    offline:    p4 created (nobody is connected)');

  // 3. Reconnect and resume — the missed patch replays, not the whole graph.
  const ws2 = await connect();
  ws2.send(JSON.stringify({ resume: 'feed', after: 0 }));
  await sleep(100);
  const replayed = messages.some(
    (m) => m.id === 'feed' && (m.event as SubscriptionEvent | undefined)?.id === 'p4',
  );
  console.log(`    resumed:    ${replayed ? 'p4 replayed via resume ✅' : 'nothing replayed ❌'}`);

  ws2.close();
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
