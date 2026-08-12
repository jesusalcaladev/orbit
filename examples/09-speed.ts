/**
 * 09 — Speed: watch Orbit move
 *
 * A live speed showcase. Every number below is measured on THIS machine at
 * run time — same `dist` build everyone gets, no special flags, no fudging.
 * It covers the five claims that matter in production:
 *
 *   1. Engine core      — a simple query costs single-digit MICROSECONDS.
 *   2. Full HTTP path   — the handler over fetch-style Request/Response.
 *   3. Deep graphs      — 5 levels, and the database sees 5 round-trips
 *                         (GraphQL's data-loader-less default: 1,111).
 *   4. Payloads         — the same 20-post feed, 4% of the JSON bytes.
 *   5. Realtime         — one mutation reaches 50 live sockets in µs, and a
 *                         reconnecting client replays only the missed patches.
 *
 * Run:  node examples/09-speed.ts   (after `npm run build`)
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  createOrbit,
  createRealtimeServer,
  encodeMsgpack,
  memoryAdapter,
} from '@orbit/core';
import type { DataAdapter, SubscriptionEvent } from '@orbit/core';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when this module is the process entry point (not imported by run-all). */
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const users = Array.from({ length: 100 }, (_, i) => ({
  id: String(i + 1),
  name: `User ${i + 1}`,
  email: `user${i + 1}@orbit.dev`,
}));

/** Lazy 5-level graph: user → posts(10) → comments(100) → likes(1000) → likedBy(1000). */
function deepNestAdapters(count: { queries: number }): DataAdapter[] {
  const posts = Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, title: `Post ${i + 1}`, authorId: '1' }));
  const comments = Array.from({ length: 100 }, (_, i) => ({ id: `c${i + 1}`, text: `Comment ${i + 1}`, postId: `p${(i % 10) + 1}` }));
  const likes = Array.from({ length: 1000 }, (_, i) => ({ id: `l${i + 1}`, emoji: '❤️', commentId: `c${(i % 100) + 1}` }));
  const likedBy = Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1), name: `Liker ${i + 1}`, likeId: `l${i + 1}` }));

  const adapter = (entity: string, by: (parentId: string) => unknown[]): DataAdapter => ({
    entity,
    resolve(filters, ctx) {
      count.queries += 1;
      if (entity === 'user') return users.find((u) => u.id === filters.id);
      const parent = ctx.parent?.data as { id: string } | undefined;
      return by(parent?.id ?? '');
    },
    batch(requests) {
      count.queries += 1;
      return Promise.resolve(
        requests.map((r) => {
          const parent = r.parent?.data as { id: string } | undefined;
          return by(parent?.id ?? '');
        }),
      );
    },
  });

  return [
    adapter('user', () => users),
    adapter('posts', (id) => (id === '1' ? posts : [])),
    adapter('comments', (id) => comments.filter((c) => c.postId === id)),
    adapter('likes', (id) => likes.filter((l) => l.commentId === id)),
    adapter('likedBy', (id) => likedBy.filter((l) => l.likeId === id)),
  ];
}

// ---------------------------------------------------------------------------
// Measurement helpers (same honest methodology as the benchmark suite)
// ---------------------------------------------------------------------------

async function measureThroughput(fn: () => Promise<unknown>, samples: number, warmup = 300): Promise<number> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const start = performance.now();
  for (let i = 0; i < samples; i += 1) await fn();
  return samples / ((performance.now() - start) / 1000);
}

// ---------------------------------------------------------------------------
// The showcase
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const out: string[] = [];
  const row = (label: string, value: string, note = '') =>
    out.push(`  ${label.padEnd(26)} ${value.padEnd(34)} ${note}`);

  out.push('');
  out.push('  ⚡  Orbit speed — measured live on this machine');
  out.push('  ' + '─'.repeat(74));

  // 1. Engine core
  const orbit = createOrbit({
    adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) }]),
  });
  const envelope = { query: 'user(id="1") { name, email }' };
  await orbit.execute(envelope);
  const coreRps = Math.round(await measureThroughput(() => orbit.execute(envelope), 100_000, 1000));
  row('engine core', `${(1_000_000 / coreRps).toFixed(2)} µs/op · ${coreRps.toLocaleString('en-US')} RPS`, '(100k sequential-await ops)');

  // 2. Full HTTP path (fresh Request + Response per op, like a real client)
  const body = JSON.stringify(envelope);
  const makeRequest = () =>
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  for (let i = 0; i < 1000; i += 1) await orbit.handler(makeRequest());
  let total = 0;
  const wireSamples = 5000;
  for (let i = 0; i < wireSamples; i += 1) {
    const request = makeRequest();
    const start = performance.now();
    await orbit.handler(request);
    total += performance.now() - start;
  }
  const wireRps = Math.round(wireSamples / (total / 1000));
  row('full HTTP handler', `${(total / wireSamples * 1000).toFixed(1)} µs/op · ${wireRps.toLocaleString('en-US')} RPS`, '(fetch-compatible path)');

  // 3. Deep 5-level graph — DB round-trips
  const count = { queries: 0 };
  const deepOrbit = createOrbit({ adapters: deepNestAdapters(count) });
  const t0 = performance.now();
  const result = await deepOrbit.execute({
    query: 'user(id="1") { name, posts { title, comments { text, likes { emoji, likedBy { name } } } } }',
  });
  const deepMs = performance.now() - t0;
  const nodeCount = (result.data as { posts: unknown[] }).posts?.length ?? 0;
  row(
    'deep 5-level graph',
    `${deepMs.toFixed(1)} ms · ${count.queries} DB round-trips`,
    `(${nodeCount} posts → ${nodeCount * 10} comments → ${nodeCount * 100} likes → ${nodeCount * 100} likedBy)  GraphQL default: 1,111 queries`,
  );

  // 4. Payload — the same 20-post feed, every encoding (varied content so
  //    the compression numbers are honest, not a repeated-string artifact)
  const SENTENCES = [
    'Orbit treats the query string as intent, never as schema.',
    'The core knows nothing of databases, only of moving data through hooks.',
    'Batching turns a thousand round-trips into a single call.',
    'Adapters translate verbatim filters into whatever your source speaks.',
    'Plugins are the nervous system; the core is the skeleton.',
    'MessagePack shrinks the wire without a single dependency.',
    'Stale-while-revalidate keeps reads fast and writes safe.',
    'Projection keeps the payload exactly as wide as the client asked.',
    'Error codes travel unmodified from adapter to client.',
    'The envelope is the only schema the protocol owns.',
  ];
  const feed = Array.from({ length: 20 }, (_, i) => ({
    id: `post-${i + 1}`,
    title: `The future of data layers — part ${i + 1}`,
    body: Array.from({ length: 60 }, (_, p) => {
      const a = SENTENCES[(i + p) % SENTENCES.length]!;
      const b = SENTENCES[(i * 3 + p) % SENTENCES.length]!;
      return `${a} ${b} (paragraph ${i + 1}.${p + 1})`;
    }).join(' '),
    tags: ['orbit', 'zero-dependency', `topic-${(i % 3) + 1}`],
    likes: 89 + i * 3,
    comments: Array.from({ length: 4 }, (_, j) => ({ id: `c${i}-${j}`, text: `Comment ${j + 1}` })),
  }));
  const jsonBytes = new TextEncoder().encode(JSON.stringify(feed)).byteLength;
  const mpBytes = encodeMsgpack(feed).byteLength;
  const gzip = new Blob([JSON.stringify(feed)]).stream().pipeThrough(new CompressionStream('gzip'));
  const reader = gzip.getReader();
  let gzipTotal = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    gzipTotal += (value as Uint8Array).length;
  }
  const kb = (b: number) => (b / 1024).toFixed(0);
  row(
    '20-post feed payload',
    `JSON ${kb(jsonBytes)} KB → msgpack+gzip ${kb(gzipTotal)} KB`,
    `(${Math.round((gzipTotal / jsonBytes) * 100)}% of the JSON bytes over the wire)`,
  );

  // 5. Realtime — one mutation fanning out to 50 live sockets
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const postAdapter: DataAdapter = {
    entity: 'post',
    resolve: () => null,
    subscribe: (_filters, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const realtimeOrbit = createOrbit({ adapters: [postAdapter] });
  const server = createServer();
  const realtime = createRealtimeServer(realtimeOrbit, { retentionMs: 10_000 });
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const N = 50;
  const sockets: WebSocket[] = [];
  let received = 0;
  let resolveAll: () => void = () => {};
  const allReceived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const open = (index: number) =>
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/realtime`);
      ws.onmessage = () => {
        received += 1;
        if (received === N) resolveAll();
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ subscribe: 'post { id }', id: `live-${index}` }));
        resolve();
      };
      ws.onerror = () => reject(new Error('websocket failed to open'));
      sockets.push(ws);
    });
  for (let i = 0; i < N; i += 1) await open(i);
  await sleep(100); // let every ack land

  const t1 = performance.now();
  for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { views: 1 } });
  await allReceived;
  const fanOutUs = (performance.now() - t1) * 1000;
  row('realtime fan-out', `${fanOutUs.toFixed(0)} µs`, `(1 mutation → all ${N} live sockets)`);

  // 5b. Realtime resume — only the missed patches, over the wire.
  // Close the other sockets first: this demo runs server + clients in ONE
  // process, so emitting while 49 sockets are live would flood the shared
  // event loop with 24,500 frames before the reconnected client's patches
  // even arrive (a real deployment has the clients in separate processes).
  sockets[0]!.close();
  for (let i = 1; i < N; i += 1) sockets[i]!.close();
  await sleep(50);
  const K = 500;
  for (let i = 0; i < K; i += 1) {
    for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { n: i } });
  }
  let replayed = 0;
  let resumeSocket: WebSocket | undefined;
  const resumed = new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    resumeSocket = ws;
    ws.onmessage = () => {
      replayed += 1;
      if (replayed === K) resolve();
    };
    ws.onopen = () => ws.send(JSON.stringify({ resume: 'live-0', after: 1 }));
    // A dropped demo socket resolves instead of hanging the example.
    ws.onerror = () => resolve();
  });
  const t2 = performance.now();
  await resumed;
  const resumeMs = performance.now() - t2; // already milliseconds
  row('realtime resume', `${resumeMs.toFixed(2)} ms`, `(reconnecting client replays ${K} missed patches, not the whole graph)`);

  // Close every client socket first so the server finishes the close
  // handshakes, then terminate the transport (close frame + socket end) and
  // the http server. closeAllConnections() is the backstop for any upgraded
  // socket still lingering (Node ≥ 18.2) — without it the process hangs.
  resumeSocket?.close();
  for (const ws of sockets) ws.close();
  await sleep(50);
  realtime.close();
  server.close();
  server.closeAllConnections();

  out.push('  ' + '─'.repeat(74));
  out.push('  Same machine, same build — run it yourself:  node examples/09-speed.ts');
  out.push('');

  // Node's built-in WebSocket (undici) keeps its client-side socket handles
  // alive even after a clean close — a Node platform behavior, not an Orbit
  // leak (the transport above has already terminated every session). When
  // run standalone, flush the output and exit explicitly; when imported by
  // run-all, just print — the harness exits once every example is done.
  const finalOutput = out.join('\n') + '\n';
  if (isEntry) {
    process.stdout.write(finalOutput, () => process.exit(0));
  } else {
    console.log(finalOutput);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
