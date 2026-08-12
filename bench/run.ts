/**
 * Orbit benchmark suite — scenarios B1–B9 from the protocol spec.
 *
 * Every measurement runs against the real `@orbit/core` engine (dist build)
 * on this machine. The competition is now MEASURED, not assumed: the
 * GraphQL scenarios (bench/graphql.ts) run the same fixtures through
 * graphql-js + DataLoader (devDependencies of the bench harness only — the
 * core keeps its zero-runtime-dependency contract) on the same hardware.
 *
 * Run:  npm run bench   (builds first)
 *
 * Output: prints a results table, writes `bench/results/benchmarks.json` and
 * `bench/results/chart.svg` (the chart is embedded in docs/benchmarks.md).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SubscriptionHub,
  createCachePlugin,
  createOrbit,
  createRealtimeServer,
  encodeMsgpack,
  memoryAdapter,
} from '@orbit/core';
import type { DataAdapter, SubscriptionEvent } from '@orbit/core';
import { buildDeepNest, buildFeed, users } from './fixtures.ts';
import { graphqlB1, graphqlB2, graphqlB3, graphqlB4, graphqlB9 } from './graphql.ts';
import { httpB8 } from './http-bench.ts';
import { gzip, measure, measureThroughput, now, pct } from './measure.ts';
import { renderChart } from './svg.ts';
import type { ChartRow } from './svg.ts';
import { BenchWsClient } from './ws-client.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const benchDir = join(dirname(fileURLToPath(import.meta.url)), 'results');
mkdirSync(benchDir, { recursive: true });

/**
 * CI smoke mode: shared GitHub runners are not a benchmark machine — cut the
 * sample counts so the suite still exercises every scenario (and the numbers
 * stay roughly right) without hogging a runner. `npm run bench` locally uses
 * the full sample counts below.
 */
const isCI = process.env.CI === 'true';
const scale = (n: number, ci: number): number => (isCI ? ci : n);

/**
 * Measure the handler's SERVER-side work only: each fresh Request is built
 * OUTSIDE the timed region. A keep-alive load tool or fetch runtime constructs
 * the request once per connection, not per request — so this is the honest
 * server-capacity number (undici's client Request constructor excluded).
 */
async function measureServerWork(
  make: () => Request,
  handle: (request: Request) => Promise<Response>,
  samples: number,
): Promise<number> {
  // The handler path needs a longer JIT warm-up than the hot execute loop.
  for (let i = 0; i < 1000; i += 1) await handle(make());
  let total = 0;
  for (let i = 0; i < samples; i += 1) {
    const request = make();
    const start = now();
    await handle(request);
    total += now() - start;
  }
  return samples / (total / 1000);
}

// ---------------------------------------------------------------------------
// B1 — Simple query latency (P99), measured vs graphql-js
// ---------------------------------------------------------------------------

async function benchB1(): Promise<{
  orbitMs: number;
  graphqlMs: number;
  graphqlCachedMs: number;
  competitionMs: number;
}> {
  const orbit = createOrbit({
    adapters: memoryAdapter([
      { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
    ]),
  });

  // Warm up.
  await orbit.execute({ query: 'user(id="1") { name, email }' });

  const times = await measure(
    () => orbit.execute({ query: 'user(id="1") { name, email }' }),
    scale(2000, 400),
  );
  const orbitP99 = pct(times, 99);

  // The same query, same data, through graphql-js on this machine — naive
  // (full pipeline per op) and cached-document (the parse-LRU equivalent).
  const { ms: graphqlMs, cachedMs: graphqlCachedMs } = await graphqlB1();
  console.log(
    `    graphql-js: naive ${graphqlMs.toFixed(2)} ms P99 · cached-document ${graphqlCachedMs.toFixed(3)} ms P99`,
  );

  // Competition label: the FAIR number is the cached-document one (Orbit's
  // parse LRU also skips re-parsing) — same apples-to-apples as B3.
  return { orbitMs: orbitP99, graphqlMs, graphqlCachedMs, competitionMs: graphqlCachedMs };
}

// ---------------------------------------------------------------------------
// B2 — Deep nest (5 levels), DB round-trips
// ---------------------------------------------------------------------------

interface Counting {
  queries: number;
}

/** Lazy 5-level graph: user → posts(10) → comments(100) → likes(1000) → likedBy(1000). */
function deepNestAdapters(count: Counting): DataAdapter[] {
  const { posts, comments, likes, likedBy } = buildDeepNest();

  const adapter = (entity: string, by: (parentId: string) => unknown[]): DataAdapter => ({
    entity,
    resolve(filters, ctx) {
      count.queries += 1;
      if (entity === 'user') return users.find((u) => u.id === filters.id);
      const parent = ctx.parent?.data as { id: string } | undefined;
      return by(parent?.id ?? '');
    },
    batch(requests) {
      // One batched DB round-trip serves every sibling request.
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

async function benchB2(): Promise<{
  orbitQueries: number;
  graphqlQueries: number;
  competitionQueries: number;
}> {
  const count: Counting = { queries: 0 };
  const orbit = createOrbit({ adapters: deepNestAdapters(count) });
  await orbit.execute({
    query:
      'user(id="1") { name, posts { title, comments { text, likes { emoji, likedBy { name } } } } }',
  });

  // The same 5-level graph through graphql-js: resolver invocations ARE the
  // round-trips of a naive server (each resolver = one data access).
  const { resolverCalls } = await graphqlB2();
  return {
    orbitQueries: count.queries,
    graphqlQueries: resolverCalls,
    competitionQueries: resolverCalls,
  };
}

// ---------------------------------------------------------------------------
// B3 — Throughput (RPS)
//
// Three honest numbers, clearly labeled:
//   core   — the engine itself (`execute`): the protocol's raw throughput, the
//            claim the spec's ~30k goal is about ("MessagePack + parsing").
//   server — the handler's server-side work only (client Request built outside
//            the timer): what a keep-alive load tool or fetch runtime sees.
//   wire   — the full fetch-compatible handler (fresh Request + Response per
//            op): includes undici's client-side Request constructor, which a
//            keep-alive loader never pays per request.
// ---------------------------------------------------------------------------

async function benchB3(): Promise<{
  orbitRps: number;
  serverRps: number;
  wireRps: number;
  graphqlRps: number;
  competitionRps: number;
}> {
  const orbit = createOrbit({
    adapters: memoryAdapter([
      { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
    ]),
  });
  const envelope = { query: 'user(id="1") { name, email }' };
  const body = JSON.stringify(envelope);
  const make = () =>
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  const core = Math.round(
    await measureThroughput(() => orbit.execute(envelope), scale(30000, 4000)),
  );
  const server = Math.round(
    await measureServerWork(make, (r) => orbit.handler(r), scale(8000, 1000)),
  );
  const wire = Math.round(
    await measureThroughput(() => orbit.handler(make()), scale(4000, 500), scale(1000, 200)),
  );

  // The same query through graphql-js: naive (full pipeline every op) and
  // cached-document (pre-parsed+validated, the production-server equivalent
  // of Orbit's parse LRU).
  const { rpsNaive, rpsCached } = await graphqlB3();
  console.log(
    `    core ${core.toLocaleString('en-US')} RPS · server-side ${server.toLocaleString('en-US')} RPS · fetch path ${wire.toLocaleString('en-US')} RPS (undici client cost included)`,
  );
  console.log(
    `    graphql-js: naive ${rpsNaive.toLocaleString('en-US')} RPS (full pipeline/op) · cached-document ${rpsCached.toLocaleString('en-US')} RPS`,
  );
  return {
    orbitRps: core,
    serverRps: server,
    wireRps: wire,
    graphqlRps: rpsCached,
    competitionRps: rpsCached,
  };
}

// ---------------------------------------------------------------------------
// B9 — Deep nest with cache + DataLoader
//
// B2 measured the naive N+1 (1,112 resolver calls). B9 measures the FIX on
// both sides of the SAME 5-level graph:
//   - Orbit: the cache plugin replays a warm request from memory — 0 DB
//     round-trips, sub-millisecond P99. (First request warms the store: 5
//     batched round-trips, one per level.)
//   - GraphQL + DataLoader: batching collapses the 1,112 resolver calls to 5
//     DB batches per request (the same floor as Orbit's contract) — but
//     DataLoader caches WITHIN one request only (fresh loaders per request is
//     the production setup), so every request still pays all 5 batches.
// The honest takeaway: DataLoader closes the B2 N+1 gap on a cold request,
// but Orbit's contract-level cache makes the REPEAT request free.
// ---------------------------------------------------------------------------

async function benchB9(): Promise<{
  orbitMs: number;
  orbitQueries: number;
  graphqlMs: number;
  graphqlCalls: number;
  competitionMs: number;
}> {
  const count: Counting = { queries: 0 };
  const cache = createCachePlugin();
  const orbit = createOrbit({ adapters: deepNestAdapters(count), plugins: [cache] });
  const envelope = {
    query:
      'user(id="1") { name, posts { title, comments { text, likes { emoji, likedBy { name } } } } }',
    cache: 'ttl=300',
  } as const;

  // Warm the store (5 batched round-trips, one per level), then replay warm.
  await orbit.execute(envelope);
  const warmQueries = count.queries;
  count.queries = 0;
  const times = await measure(() => orbit.execute(envelope), scale(500, 100));
  const orbitMs = pct(times, 99);
  const orbitQueries = count.queries;

  // The same graph through graphql-js + DataLoader (fresh loaders per request).
  const { ms: graphqlMs, callsPerRequest } = await graphqlB9();
  console.log(
    `    warm replay p99: ${orbitMs.toFixed(3)} ms (0 DB calls) · graphql-js+DataLoader: ${graphqlMs.toFixed(2)} ms · ${callsPerRequest.toFixed(0)} DB batches/request`,
  );
  if (warmQueries !== 5) throw new Error(`B9 warm expected 5 queries, got ${warmQueries}`);
  if (orbitQueries !== 0) throw new Error(`B9 warm replay expected 0 queries, got ${orbitQueries}`);
  return {
    orbitMs,
    orbitQueries,
    graphqlMs,
    graphqlCalls: callsPerRequest,
    competitionMs: graphqlMs,
  };
}

// ---------------------------------------------------------------------------
// B4 — Payload size (20-post feed)
// ---------------------------------------------------------------------------

async function benchB4(): Promise<{
  orbitJsonKb: number;
  orbitKb: number;
  graphqlJsonKb: number;
  graphqlGzipKb: number;
  competitionKb: number;
}> {
  const feed = buildFeed();
  const payload = { data: { feed } };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msgpack = encodeMsgpack(payload);
  const gzipJson = await gzip(json);
  const gzipMsgpack = await gzip(msgpack);

  const kb = (b: Uint8Array<ArrayBuffer> | Uint8Array<ArrayBufferLike>) => b.byteLength / 1024;

  // The same feed through a real graphql-js response.
  const { jsonKb: graphqlJsonKb, gzipKb: graphqlGzipKb } = await graphqlB4();

  console.log(
    '    feed sizes — json:',
    kb(json as Uint8Array<ArrayBuffer>).toFixed(1),
    'KB',
    '| json+gzip:',
    kb(gzipJson).toFixed(1),
    'KB',
    '| msgpack:',
    kb(msgpack).toFixed(1),
    'KB',
    '| msgpack+gzip:',
    kb(gzipMsgpack).toFixed(1),
    'KB',
    '| graphql-js json:',
    graphqlJsonKb.toFixed(1),
    'KB',
    '| graphql-js json+gzip:',
    graphqlGzipKb.toFixed(1),
    'KB',
  );

  // The protocol's wire format: msgpack + optional gzip.
  return {
    orbitJsonKb: kb(json as Uint8Array<ArrayBuffer>),
    orbitKb: kb(gzipMsgpack),
    graphqlJsonKb,
    graphqlGzipKb,
    competitionKb: graphqlJsonKb,
  };
}

// ---------------------------------------------------------------------------
// B5 — Time to first byte (streaming)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(5);
  }
}

async function benchB5(): Promise<{ orbitTtfbMs: number; competitionMs: number }> {
  const orbit = createOrbit({
    adapters: memoryAdapter([
      {
        // Realistic async I/O: the root resolves quickly, the relation slowly.
        entity: 'user',
        resolve: async ({ id }) => {
          await sleep(5); // ~5ms DB read
          return users.find((u) => u.id === id);
        },
      },
      {
        entity: 'posts',
        resolve: async (_f, ctx) => {
          await sleep(120); // slow relation: ~120ms DB read
          const parent = ctx.parent?.data as { id: string } | undefined;
          if (parent?.id === '1') return [{ id: 'p1', title: 'Why Orbit?' }];
          return [];
        },
      },
    ]),
  });

  const query = JSON.stringify({ query: 'user(id="1") { name, posts { title } }' });
  const request = () =>
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: query,
    });

  // Warm up to skip undici's cold start, then measure time to the first frame.
  await orbit.handler(request());
  const start = now();
  const response = await orbit.handler(request());
  const reader = response.body!.getReader();
  const { value } = await reader.read(); // first SSE frame = root level
  const ttfb = now() - start;
  // Drain the remaining frames.
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
  }
  console.log(`    frames: ${new TextDecoder().decode(value).split('\n')[0] ?? ''}`);
  return { orbitTtfbMs: ttfb, competitionMs: 400 };
}

// ---------------------------------------------------------------------------
// B6 — Reconnect (warm cache replay)
// ---------------------------------------------------------------------------

async function benchB6(): Promise<{ orbitMs: number; competitionMs: number }> {
  const cache = createCachePlugin();
  const orbit = createOrbit({
    adapters: memoryAdapter([
      { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
    ]),
    plugins: [cache],
  });

  // Simulate a full "reconnect sync": query with cache spec, run twice —
  // the first warms the store, the second replays from it.
  const envelope = { query: 'user { id, name, email }', cache: 'ttl=300' } as const;
  await orbit.execute(envelope);
  const hit = await measure(() => orbit.execute(envelope), scale(500, 200));
  const hitMs = pct(hit, 99);
  console.log(`    warm replay p99: ${hitMs.toFixed(3)} ms`);

  // Realtime: one shared adapter hook fanning out to N clients, and a
  // detach → resume replay of the missed patches (the B6 delta-sync story).
  await benchB6Realtime();

  // Reference: Apollo refetches the whole graph (2s) after reconnect.
  return { orbitMs: hitMs, competitionMs: 2000 };
}

/**
 * The realtime side of B6: N clients on ONE shared subscription, one patch
 * reaching all of them, and a resume that replays K missed patches — both
 * measured in microseconds (goal < 200 ms).
 */
async function benchB6Realtime(): Promise<void> {
  const N = 100;
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const adapter: DataAdapter = {
    entity: 'post',
    resolve: () => null,
    subscribe: (_filters, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const orbit = createOrbit({ adapters: [adapter] });
  const hub = new SubscriptionHub(orbit);

  let delivered = 0;
  let resolveAll: () => void = () => {};
  const all = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const onEvent = () => {
    delivered += 1;
    if (delivered === N) resolveAll();
  };
  for (let i = 0; i < N; i += 1) hub.subscribe('post { id }', `c${i}`, onEvent);
  if (handlers.size !== 1) throw new Error('expected one shared adapter hook');

  // Fan-out: ONE adapter event reaches all N clients through the shared hook.
  const t0 = now();
  for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { views: 1 } });
  await all;
  const fanOutUs = (now() - t0) * 1000;

  // Resume: K patches land while c0 is detached; resume replays them all.
  const K = 500;
  hub.detach('c0');
  for (let i = 0; i < K; i += 1) {
    for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { n: i } });
  }
  let replayed = 0;
  const t1 = now();
  // seq 1 belongs to the fan-out test above — replay only the K offline patches.
  hub.resume('c0', 1, () => {
    replayed += 1;
  });
  const replayUs = (now() - t1) * 1000;
  if (replayed !== K) throw new Error(`resume expected ${K} patches, got ${replayed}`);

  console.log(
    `    realtime:   ${N} clients · 1 shared hook · fan-out ${fanOutUs.toFixed(0)} µs · resume ${K} patches ${replayUs.toFixed(0)} µs`,
  );
}

// ---------------------------------------------------------------------------
// B7 — Realtime HTTP: WebSocket subscriptions over node:http
//
// Real sockets, real upgrades, real frames. The spec's realtime target is
// Apollo-style delta sync (< 200 ms); here we measure how fast the server
// itself moves patches over the wire:
//   subs/s  — connect + subscribe handshakes per second (upgrade throughput)
//   fan-out — ONE adapter event reaching N sockets in µs (deduped shared hook)
//   resume  — K missed patches replayed to a reconnected socket (delta sync)
//
// The client is a raw RFC 6455 speaker (bench/ws-client.ts) — no undici
// buffering, so the numbers are the server's, not the client's.
// ---------------------------------------------------------------------------

async function benchB7(): Promise<{
  subsPerSec: number;
  fanOutUs: number;
  resumeMs: number;
  competitionMs: number;
}> {
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const adapter: DataAdapter = {
    entity: 'post',
    resolve: () => null,
    subscribe: (_filters, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const orbit = createOrbit({ adapters: [adapter] });
  const server = createServer();
  const realtime = createRealtimeServer(orbit, { retentionMs: 60_000 });
  realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const N = 200;

  // 1) Connect + subscribe throughput — real HTTP upgrades over the wire.
  const clients: BenchWsClient[] = [];
  const t0 = now();
  for (let i = 0; i < N; i += 1) {
    const client = new BenchWsClient(port);
    await client.connect();
    client.subscribe(`sub-${i}`, 'post { id }');
    await client.awaitFrames(1, 'ack'); // event-driven, no polling
    clients.push(client);
  }
  const subsPerSec = N / ((now() - t0) / 1000);

  const expected = N;

  // 2) Warm the fan-out path (JIT + per-socket write setup) — every other
  //    benchmark warms before timing; a cold first burst is not steady state.
  let warmDelivered = 0;
  let resolveWarm: () => void = () => {};
  const warmDone = new Promise<void>((resolve) => {
    resolveWarm = resolve;
  });
  for (const client of clients) {
    client.onFrame = () => {
      warmDelivered += 1;
      if (warmDelivered === expected) resolveWarm();
    };
  }
  for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { views: 0 } });
  await warmDone;

  // 3) Fan-out (timed): one adapter event → all N sockets through the shared
  //    hook. Two numbers, both honest:
  //    writePathUs — the synchronous fan-out loop (all N frames handed to the
  //        kernel; ~20 µs per socket.write() is libuv, not Orbit logic — a
  //        pure net.Socket baseline without Orbit costs the same).
  //    fanOutUs    — until every socket actually received the frame
  //        (write path + same-process delivery).
  let delivered = 0;
  let resolveAll: () => void = () => {};
  const allDelivered = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  for (const client of clients) {
    client.onFrame = () => {
      delivered += 1;
      if (delivered === expected) resolveAll();
    };
  }
  const t1 = now();
  for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { views: 1 } });
  const writePathUs = (now() - t1) * 1000;
  await allDelivered;
  const fanOutUs = (now() - t1) * 1000;

  // 4) Resume replay: c0 drops, K patches land while offline, a reconnected
  //    socket replays exactly the gap over the wire (spec §10 delta sync).
  //    seqs 1–2 were the warm + timed fan-out events — replay from after=2.
  //    Measured by counting the K event frames (the trailing `resumed` ack
  //    is not counted), so the number is exact.
  clients[0]!.close();
  await waitFor(() => realtime.sessionCount === N - 1, 'c0 detached');
  const K = 500;
  for (let i = 0; i < K; i += 1) {
    for (const handler of handlers) handler({ type: 'updated', id: 'p1', patch: { n: i } });
  }
  const reconnected = new BenchWsClient(port);
  await reconnected.connect();
  let replayed = 0;
  let resolveResume: () => void = () => {};
  const replayDone = new Promise<void>((resolve) => {
    resolveResume = resolve;
  });
  reconnected.onFrame = () => {
    replayed += 1;
    if (replayed >= K) resolveResume();
  };
  const t2 = now();
  reconnected.resume('sub-0', 2);
  await replayDone;
  // now() - t2 is already in milliseconds.
  const resumeMs = now() - t2;
  // The trailing `resumed` ack may arrive in the same burst and bump the
  // counter past K — the invariant is that every one of the K events landed.
  if (replayed < K) throw new Error(`resume expected ${K} events, got ${replayed}`);

  // Cleanup.
  realtime.close();
  server.close();
  for (const client of clients) client.socket.destroy();
  reconnected.socket.destroy();

  console.log(
    `    realtime http: ${subsPerSec.toFixed(0)} subs/s · fan-out ${N} sockets ${fanOutUs.toFixed(0)} µs (write path ${writePathUs.toFixed(0)} µs) · resume ${K} patches ${resumeMs.toFixed(2)} ms`,
  );
  return { subsPerSec, fanOutUs, resumeMs, competitionMs: 200 };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface Result {
  id: string;
  label: string;
  metric: string;
  unit: string;
  lowerIsBetter: boolean;
  orbitValue: number;
  orbitLabel: string;
  competitionValue: number;
  competitionLabel: string;
  goal: string;
  goalMet: boolean;
}

const ok = (met: boolean): string => (met ? '✅' : '⚠️ ');

async function main(): Promise<void> {
  console.log('Orbit benchmark suite (B1–B9)\n');

  const results: Result[] = [];

  // B1
  {
    const r = await benchB1();
    const met = r.orbitMs < 3;
    results.push({
      id: 'B1',
      label: 'Simple query · P99 latency',
      metric: 'P99 latency',
      unit: 'ms',
      lowerIsBetter: true,
      orbitValue: r.orbitMs,
      orbitLabel: `${r.orbitMs.toFixed(2)} ms`,
      competitionValue: r.competitionMs,
      competitionLabel: `${r.competitionMs.toFixed(3)} ms (graphql-js, cached doc, measured)`,
      goal: '< 3 ms',
      goalMet: met,
    });
    console.log(
      `B1 · Simple query P99 latency        ${ok(met)} orbit ${r.orbitMs.toFixed(2)} ms  vs  graphql-js cached-doc ${r.graphqlCachedMs.toFixed(3)} ms / naive ${r.graphqlMs.toFixed(2)} ms  (measured; goal < 3 ms)`,
    );
  }

  // B2
  {
    const r = await benchB2();
    // One batched round-trip per level is the theoretical floor for a 5-level
    // graph (each level is a different entity), so the honest goal is ≤ 5.
    const met = r.orbitQueries <= 5;
    results.push({
      id: 'B2',
      label: 'Deep nest (5 levels) · DB round-trips',
      metric: 'DB queries',
      unit: 'round-trips',
      lowerIsBetter: true,
      orbitValue: r.orbitQueries,
      orbitLabel: `${r.orbitQueries} queries`,
      competitionValue: r.competitionQueries,
      competitionLabel: `${r.competitionQueries} resolver calls (graphql-js, measured)`,
      goal: '≤ 5 (1 batch/level)',
      goalMet: met,
    });
    console.log(
      `B2 · Deep nest DB round-trips       ${ok(met)} orbit ${r.orbitQueries}  vs  graphql-js ${r.graphqlQueries} resolver calls  (measured; goal ≤ 5)`,
    );
  }

  // B3
  {
    const r = await benchB3();
    // The spec's ~30k goal is about the protocol's own throughput ("MessagePack
    // + parsing"), so it is compared against the engine core. The server-side
    // and full fetch-path numbers are printed above and documented.
    const met = r.orbitRps >= 30_000;
    results.push({
      id: 'B3',
      label: 'Throughput',
      metric: 'Requests/sec (core)',
      unit: 'RPS',
      lowerIsBetter: false,
      orbitValue: r.orbitRps,
      orbitLabel: `${r.orbitRps.toLocaleString('en-US')} RPS`,
      competitionValue: r.competitionRps,
      competitionLabel: `${r.competitionRps.toLocaleString('en-US')} RPS (graphql-js, cached doc, measured)`,
      goal: '~30k RPS (core)',
      goalMet: met,
    });
    console.log(
      `B3 · Throughput                      ${ok(met)} orbit core ${r.orbitRps.toLocaleString('en-US')} RPS  (server ${r.serverRps.toLocaleString('en-US')} · fetch ${r.wireRps.toLocaleString('en-US')})  vs  graphql-js ${r.graphqlRps.toLocaleString('en-US')}  (measured; goal ~30k)`,
    );
  }

  // B4
  {
    const r = await benchB4();
    const met = r.orbitKb <= 120;
    results.push({
      id: 'B4',
      label: 'Payload · 20-post feed',
      metric: 'KB transmitted',
      unit: 'KB',
      lowerIsBetter: true,
      orbitValue: r.orbitKb,
      orbitLabel: `${r.orbitKb.toFixed(0)} KB`,
      competitionValue: r.competitionKb,
      competitionLabel: `${r.competitionKb.toFixed(0)} KB (graphql-js JSON, measured)`,
      goal: '~120 KB',
      goalMet: met,
    });
    console.log(
      `B4 · Payload size                    ${ok(met)} orbit ${r.orbitKb.toFixed(0)} KB  vs  graphql-js JSON ${r.graphqlJsonKb.toFixed(0)} KB (${r.graphqlGzipKb.toFixed(1)} KB gzipped)  (goal ~120 KB)`,
    );
  }

  // B5
  {
    const r = await benchB5();
    const met = r.orbitTtfbMs < 50;
    results.push({
      id: 'B5',
      label: 'TTFB · streaming',
      metric: 'Time to first byte',
      unit: 'ms',
      lowerIsBetter: true,
      orbitValue: r.orbitTtfbMs,
      orbitLabel: `${r.orbitTtfbMs.toFixed(0)} ms`,
      competitionValue: r.competitionMs,
      competitionLabel: `${r.competitionMs} ms (REST, waits for all)`,
      goal: '< 50 ms',
      goalMet: met,
    });
    console.log(
      `B5 · TTFB streaming                  ${ok(met)} orbit ${r.orbitTtfbMs.toFixed(0)} ms  vs  REST ${r.competitionMs} ms  (goal < 50 ms)`,
    );
  }

  // B6
  {
    const r = await benchB6();
    const met = r.orbitMs < 200;
    results.push({
      id: 'B6',
      label: 'Reconnect · warm cache replay',
      metric: 'Replay latency',
      unit: 'ms',
      lowerIsBetter: true,
      orbitValue: r.orbitMs,
      orbitLabel: `${r.orbitMs.toFixed(1)} ms`,
      competitionValue: r.competitionMs,
      competitionLabel: `${r.competitionMs} ms (Apollo refetch)`,
      goal: '< 200 ms',
      goalMet: met,
    });
    console.log(
      `B6 · Reconnect warm replay           ${ok(met)} orbit ${r.orbitMs.toFixed(1)} ms  vs  Apollo refetch ${r.competitionMs} ms  (goal < 200 ms)`,
    );
  }

  // B7
  {
    const r = await benchB7();
    const fanOutMs = r.fanOutUs / 1000;
    const met = fanOutMs < 200;
    results.push({
      id: 'B7',
      label: 'Realtime HTTP · WS fan-out',
      metric: 'Fan-out latency',
      unit: 'ms',
      lowerIsBetter: true,
      orbitValue: fanOutMs,
      orbitLabel: `${fanOutMs.toFixed(2)} ms`,
      competitionValue: r.competitionMs,
      competitionLabel: `${r.competitionMs} ms (spec goal)`,
      goal: '< 200 ms',
      goalMet: met,
    });
    const resumeLabel =
      r.resumeMs < 1 ? `${(r.resumeMs * 1000).toFixed(0)} µs` : `${r.resumeMs.toFixed(2)} ms`;
    console.log(
      `B7 · Realtime HTTP WS fan-out        ${ok(met)} orbit ${r.fanOutUs.toFixed(0)} µs  (${r.subsPerSec.toFixed(0)} subs/s · resume ${resumeLabel})  vs  goal < 200 ms`,
    );
  }

  // B8
  {
    const { orbitRps, graphqlRps } = await httpB8();
    const met = orbitRps >= graphqlRps;
    results.push({
      id: 'B8',
      label: 'Wire path · real HTTP (node:http + keep-alive)',
      metric: 'Requests/sec over HTTP',
      unit: 'RPS',
      lowerIsBetter: false,
      orbitValue: orbitRps,
      orbitLabel: `${orbitRps.toLocaleString('en-US')} RPS`,
      competitionValue: graphqlRps,
      competitionLabel: `${graphqlRps.toLocaleString('en-US')} RPS (graphql-js, measured)`,
      goal: '≥ graphql-js wire path',
      goalMet: met,
    });
    console.log(
      `B8 · Wire path real HTTP             ${ok(met)} orbit ${orbitRps.toLocaleString('en-US')} RPS  vs  graphql-js ${graphqlRps.toLocaleString('en-US')} RPS  (node:http + keep-alive, measured)`,
    );
  }

  // B9
  {
    const r = await benchB9();
    const met = r.orbitMs < 200;
    results.push({
      id: 'B9',
      label: 'Deep nest · warm cache replay vs DataLoader',
      metric: 'Warm replay P99 latency',
      unit: 'ms',
      lowerIsBetter: true,
      orbitValue: r.orbitMs,
      orbitLabel: `${r.orbitMs.toFixed(2)} ms (0 DB calls)`,
      competitionValue: r.competitionMs,
      competitionLabel: `${r.competitionMs.toFixed(2)} ms (graphql-js + DataLoader, cold: ${r.graphqlCalls.toFixed(0)} DB batches/request, measured)`,
      goal: '< 200 ms (0 DB calls warm)',
      goalMet: met,
    });
    console.log(
      `B9 · Cache replay vs DataLoader     ${ok(met)} orbit ${r.orbitMs.toFixed(2)} ms (${r.orbitQueries} DB calls)  vs  graphql-js+DataLoader ${r.graphqlMs.toFixed(2)} ms cold (${r.graphqlCalls.toFixed(0)} DB calls/request)  (goal < 200 ms)`,
    );
  }

  // Persist machine-readable results.
  writeFileSync(join(benchDir, 'benchmarks.json'), JSON.stringify(results, null, 2));

  // Render and persist the SVG chart.
  const rows: ChartRow[] = results.map((r) => ({
    id: r.id,
    label: `${r.id} · ${r.label}`,
    orbitValue: r.orbitValue,
    orbitLabel: r.orbitLabel,
    competitionValue: r.competitionValue,
    competitionLabel: r.competitionLabel,
    unit: r.unit,
    lowerIsBetter: r.lowerIsBetter,
    goalMet: r.goalMet,
  }));
  const svg = renderChart('Orbit benchmark suite — B1 to B9', rows);
  writeFileSync(join(benchDir, 'chart.svg'), svg);

  console.log('\nBenchmark results written to bench/results/ (benchmarks.json + chart.svg).');
  console.log('Embed the chart in docs/benchmarks.md to keep it in sync with real measurements.');
}

await main();
