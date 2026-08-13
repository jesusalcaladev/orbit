/**
 * 12 — Book API on Cloudflare Workers
 *
 * The edge host for the shared book API — the exact same engine as the
 * Express and Hono hosts, served from a single `fetch` handler:
 *
 *   examples/node/book/data.ts    → domain: entities + in-memory repository
 *   examples/node/book/engine.ts  → application: Orbit engine, adapters, auth
 *                              policy, timing, caching (framework-agnostic)
 *   examples/node/12-cloudflare-workers.ts → interface: the worker itself
 *
 * The framework layer only does transport + authentication (mapping
 * `x-api-key` to a caller identity); authorization stays in the engine. In
 * production this file IS the worker (`export default`), with `env` bindings
 * flowing into every request context as `ctx.env`. Here in Node there is no
 * workerd — so the demo drives `worker.fetch` directly (a standard fetch
 * handler) and runs the realtime session over a fake socket (the same
 * `createRealtimeSession` the WebSocketPair 101 upgrade starts in workerd).
 *
 * Run:  node examples/node/12-cloudflare-workers.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createWorker, createRealtimeSession } from '@orbit/cloudflare-workers';
import { decodeMsgpack, encodeMsgpack } from '@orbit/core';
import type { WsEvent } from '@orbit/cloudflare-workers';
import { buildBookOrbit, identifyApiKey } from './book/engine.ts';

const ADMIN = 'admin-123';
const MEMBER = 'ana-456';

/** A fake Workers WebSocket — the same structural surface `createRealtimeSession` drives in workerd. */
class FakeWs {
  sent: Array<string | ArrayBuffer> = [];
  #listeners = new Map<string, Set<(event: WsEvent) => void>>();

  accept(): void {}
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.dispatch('close', {});
  }
  addEventListener(type: 'message' | 'close', listener: (event: WsEvent) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }
  dispatch(type: 'message' | 'close', event: WsEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  sendJson(message: unknown): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) =>
      typeof frame === 'string'
        ? (JSON.parse(frame) as Record<string, unknown>)
        : (decodeMsgpack(new Uint8Array(frame)) as Record<string, unknown>),
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFrame(
  ws: FakeWs,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (!ws.frames().some(predicate)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(10);
  }
  return ws.frames().find(predicate)!;
}

const jsonRequest = (url: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export async function main(): Promise<void> {
  // The application layer — one engine, three hosts.
  const orbit = buildBookOrbit();

  // The interface layer: a single fetch handler. `ctx` maps the API key to a
  // caller identity (authentication); authorization stays in the engine.
  const worker = createWorker({
    orbit,
    path: '/api/orbit',
    realtime: { path: '/realtime' },
    ctx: (request) => ({ state: { caller: identifyApiKey(request.headers.get('x-api-key')) } }),
  });

  // Minimal workerd stand-ins: bindings + execution context (waitUntil).
  const env = { API_KEY: ADMIN };
  const ctx = { waitUntil: () => {} };
  const endpoint = 'https://orbit-book.example.com/api/orbit';
  const line = (name: string, res: Response, body?: string) =>
    console.log(`  ${name.padEnd(16)} ${String(res.status).padEnd(4)} ${body ?? ''}`);

  // 1 · One request fetches the whole relational graph (no N+1).
  const graph = await worker.fetch(
    jsonRequest(endpoint, { query: 'books { id, title, authors { name }, reviews { rating } }' }),
    env,
    ctx,
  );
  line('query graph', graph, await graph.text());

  // 2 · Identity is gated by the engine policy — a key unlocks it.
  const whoNoKey = await worker.fetch(
    jsonRequest(endpoint, { query: 'user { id, role }' }),
    env,
    ctx,
  );
  const whoAdmin = await worker.fetch(
    jsonRequest(endpoint, { query: 'user { id, role }' }, { 'x-api-key': ADMIN }),
    env,
    ctx,
  );
  const denied = (await whoNoKey.json()) as { error?: { code?: string } };
  line(
    'identity',
    whoAdmin,
    `${await whoAdmin.text()} (no-key → ${whoNoKey.status} ${denied.error?.code ?? '?'})`,
  );

  // 3 · Mutations are authenticated — a key is required.
  const addMember = await worker.fetch(
    jsonRequest(
      endpoint,
      { do: 'reviews.add', args: { payload: { bookId: 'b2', rating: 5, text: 'Imprescindible' } } },
      { 'x-api-key': MEMBER },
    ),
    env,
    ctx,
  );
  line('review.add', addMember, await addMember.text());
  const addNoKey = await worker.fetch(
    jsonRequest(endpoint, {
      do: 'reviews.add',
      args: { payload: { bookId: 'b2', rating: 5, text: 'X' } },
    }),
    env,
    ctx,
  );
  const noKeyErr = (await addNoKey.json()) as { error?: { code?: string } };
  console.log(
    `  ${'review.add'.padEnd(16)} ${String(addNoKey.status).padEnd(4)} no-key → ${noKeyErr.error?.code ?? '?'}`,
  );

  // 4 · Creating a book is admin-only — members get a 403.
  const createArgs = {
    do: 'books.create',
    args: { payload: { title: 'Cien años de soledad', year: 1967, authorId: 'a1' } },
  };
  const crMember = await worker.fetch(
    jsonRequest(endpoint, createArgs, { 'x-api-key': MEMBER }),
    env,
    ctx,
  );
  const crAdmin = await worker.fetch(
    jsonRequest(endpoint, createArgs, { 'x-api-key': ADMIN }),
    env,
    ctx,
  );
  const crErr = (await crMember.json()) as { error?: { code?: string } };
  const crBody = (await crAdmin.json()) as { data?: unknown };
  const createdId = String((crBody.data as { id?: unknown } | undefined)?.id ?? '');
  console.log(
    `  ${'books.create'.padEnd(16)} ${String(crAdmin.status).padEnd(4)} ${JSON.stringify(crBody.data)} (member → ${crMember.status} ${crErr.error?.code ?? '?'})`,
  );

  // 5 · Bad input is rejected with the standard error contract.
  const bad = await worker.fetch(
    jsonRequest(
      endpoint,
      { do: 'reviews.add', args: { payload: { bookId: 'b1', rating: 9, text: 'x' } } },
      { 'x-api-key': MEMBER },
    ),
    env,
    ctx,
  );
  line('validation', bad, await bad.text());

  // 6 · MessagePack in AND out — one request, both directions.
  const mp = await worker.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-msgpack', accept: 'application/x-msgpack' },
      body: encodeMsgpack({ query: 'books(id="b1") { title }' }),
    }),
    env,
    ctx,
  );
  const decoded = decodeMsgpack(new Uint8Array(await mp.arrayBuffer()));
  line('msgpack', mp, `${mp.headers.get('content-type')} ${JSON.stringify(decoded)}`);

  // 7 · SSE — the graph arrives in frames, not one blob.
  const sse = await worker.fetch(
    jsonRequest(endpoint, { query: 'books { id, title }' }, { accept: 'text/event-stream' }),
    env,
    ctx,
  );
  const frames = (await sse.text()).split('\n\n').filter((frame) => frame.trim().length > 0);
  line('sse', sse, `${frames.length} frames → ${frames[0]?.split('\n')[0]}`);

  // 8 · Server-side cache eviction at entity precision (spec §8).
  const cacheHeaders = { 'x-orbit-cache': 'ttl=60' };
  const booksQuery = { query: 'books { id, title }' };
  const reviewsQuery = { query: 'reviews { id, rating }' };
  const count = (data: unknown) => ((data as unknown[] | undefined) ?? []).length;
  const cached = async (body: unknown, headers: Record<string, string>) => {
    const res = await worker.fetch(jsonRequest(endpoint, body, headers), env, ctx);
    return (await res.json()) as { data?: unknown; fromCache?: boolean };
  };
  const b1 = await cached(booksQuery, cacheHeaders);
  const b2 = await cached(booksQuery, cacheHeaders);
  const rv1 = await cached(reviewsQuery, cacheHeaders);
  const rv2 = await cached(reviewsQuery, cacheHeaders);
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} ${count(b1.data)} books (miss) → ${count(b2.data)} books, fromCache: ${b2.fromCache === true} · ${count(rv1.data)} reviews (miss) → ${count(rv2.data)} reviews, fromCache: ${rv2.fromCache === true}`,
  );
  const rmAdmin = await worker.fetch(
    jsonRequest(
      endpoint,
      { do: 'books.remove', args: { filter: { id: createdId } } },
      { 'x-api-key': ADMIN },
    ),
    env,
    ctx,
  );
  line('books.remove', rmAdmin, await rmAdmin.text());
  const b3 = await cached(booksQuery, cacheHeaders);
  const rv3 = await cached(reviewsQuery, cacheHeaders);
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} after books.remove → ${count(b3.data)} books, fromCache: ${b3.fromCache === true} (refetch) · ${count(rv3.data)} reviews, fromCache: ${rv3.fromCache === true} (survived)`,
  );

  // 9 · Realtime over the session the 101 upgrade starts in workerd:
  // subscribe → ack → a mutation through the worker → event on the socket.
  const ws = new FakeWs();
  createRealtimeSession(ws, orbit);
  ws.sendJson({ subscribe: 'reviews', id: 'ws-1' });
  await waitForFrame(ws, (m) => m.ack === 'ws-1', 'ack');
  const rt = await worker.fetch(
    jsonRequest(
      endpoint,
      { do: 'reviews.add', args: { payload: { bookId: 'b2', rating: 4, text: 'En directo' } } },
      { 'x-api-key': MEMBER },
    ),
    env,
    ctx,
  );
  const event = await waitForFrame(ws, (m) => m.id === 'ws-1' && m.event !== undefined, 'event');
  console.log(
    `  ${'realtime'.padEnd(16)} ${String(rt.status).padEnd(4)} ack → event ${JSON.stringify(event.event).slice(0, 90)}`,
  );

  // 10 · Query/do envelopes over the SAME socket (spec §10).
  ws.sendJson({ query: 'books { id, title }', id: 'ws-q' });
  const qReply = await waitForFrame(ws, (m) => m.id === 'ws-q' && m.data !== undefined, 'query');
  const booksInFrame = (qReply.data as unknown[] | undefined)?.length ?? 0;
  console.log(
    `  ${'ws query'.padEnd(16)} ${String(qReply.status ?? '?').padEnd(4)} ${booksInFrame} books in one frame`,
  );

  // 11 · The same auth policy applies over the socket (defense in depth).
  ws.sendJson({
    do: 'reviews.add',
    args: { payload: { bookId: 'b1', rating: 3, text: 'Sin clave' } },
    id: 'ws-m',
  });
  const mReply = await waitForFrame(
    ws,
    (m) => m.id === 'ws-m' && m.error !== undefined,
    'mutation',
  );
  const wsErr = mReply.error as { code?: string } | undefined;
  console.log(
    `  ${'ws mutation'.padEnd(16)} ${String(mReply.status ?? '?').padEnd(4)} no auth → ${wsErr?.code ?? '?'}`,
  );
  ws.close();

  console.log('  ✔ cloudflare-workers: every protocol feature works through the worker');
  console.log('\n  In production, `export default createWorker({ orbit, path: "/api/orbit" })`');
  console.log('  is your whole worker — `env` bindings flow into every request as ctx.env.');
}

// Run directly when this file is the entry point (so `run-all.ts` can import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
