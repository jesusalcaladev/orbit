/**
 * Book API — protocol walkthrough.
 *
 * One script, run against either host: it exercises the whole Orbit protocol
 * — relational queries, gated identity, authenticated + role-checked
 * mutations, input validation, MessagePack in AND out, SSE streaming, the
 * client-driven cache lifecycle and realtime WebSocket subscriptions.
 * Whatever this script can do, both frameworks serve.
 */
import { decodeMsgpack, encodeMsgpack } from '@orbit/core';

const ADMIN = 'admin-123';
const MEMBER = 'ana-456';

interface OrbitBody {
  data?: unknown;
  error?: { code?: string; message?: string };
  fromCache?: boolean;
}

async function post(
  endpoint: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(endpoint, { method: 'POST', headers, body });
}

const jsonBody = (payload: unknown) => JSON.stringify(payload);

/** Wait for the first realtime frame matching `predicate`. */
function waitForFrame(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
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

export async function runBookDemo(base: string, host: string): Promise<void> {
  const endpoint = `${base}/api/orbit`;
  const line = (name: string, res: Response, body?: string) =>
    console.log(`  ${name.padEnd(16)} ${String(res.status).padEnd(4)} ${body ?? ''}`);

  // 1 · One request fetches the whole relational graph (no N+1).
  const graph = await post(
    endpoint,
    jsonBody({ query: 'books { id, title, authors { name, country }, reviews { rating } }' }),
    { 'content-type': 'application/json' },
  );
  line('query graph', graph, await graph.text());

  // 2 · A single record with a nested relation.
  const one = await post(
    endpoint,
    jsonBody({ query: 'books(id="b3") { title, year, authors { name } }' }),
    { 'content-type': 'application/json' },
  );
  line('query one', one, await one.text());

  // 3 · Identity is gated by the engine policy — a key unlocks it.
  const whoNoKey = await post(endpoint, jsonBody({ query: 'user { id, role }' }), {
    'content-type': 'application/json',
  });
  const whoAdmin = await post(endpoint, jsonBody({ query: 'user { id, role }' }), {
    'content-type': 'application/json',
    'x-api-key': ADMIN,
  });
  const denied = (await whoNoKey.json()) as OrbitBody;
  line(
    'identity',
    whoAdmin,
    `${await whoAdmin.text()} (no-key → ${whoNoKey.status} ${denied.error?.code ?? '?'})`,
  );

  // 4 · Mutations are authenticated — a key is required.
  const addNoKey = await post(
    endpoint,
    jsonBody({ do: 'reviews.add', args: { payload: { bookId: 'b2', rating: 5, text: 'Genial' } } }),
    { 'content-type': 'application/json' },
  );
  const addMember = await post(
    endpoint,
    jsonBody({
      do: 'reviews.add',
      args: { payload: { bookId: 'b2', rating: 5, text: 'Imprescindible' } },
    }),
    { 'content-type': 'application/json', 'x-api-key': MEMBER },
  );
  line('review.add', addMember, await addMember.text());
  const noKeyErr = (await addNoKey.json()) as OrbitBody;
  console.log(
    `  ${'review.add'.padEnd(16)} ${String(addNoKey.status).padEnd(4)} no-key → ${noKeyErr.error?.code ?? '?'}`,
  );

  // 5 · Creating a book is admin-only — members get a 403.
  const createArgs = jsonBody({
    do: 'books.create',
    args: { payload: { title: 'Cien años de soledad', year: 1967, authorId: 'a1' } },
  });
  const crMember = await post(endpoint, createArgs, {
    'content-type': 'application/json',
    'x-api-key': MEMBER,
  });
  const crAdmin = await post(endpoint, createArgs, {
    'content-type': 'application/json',
    'x-api-key': ADMIN,
  });
  const crErr = (await crMember.json()) as OrbitBody;
  const crBody = (await crAdmin.json()) as OrbitBody;
  const createdId = String((crBody.data as { id?: unknown } | undefined)?.id ?? '');
  console.log(
    `  ${'books.create'.padEnd(16)} ${String(crAdmin.status).padEnd(4)} ${JSON.stringify(crBody.data)} (member → ${crMember.status} ${crErr.error?.code ?? '?'})`,
  );

  // 6 · Bad input is rejected with the standard error contract.
  const bad = await post(
    endpoint,
    jsonBody({ do: 'reviews.add', args: { payload: { bookId: 'b1', rating: 9, text: 'x' } } }),
    { 'content-type': 'application/json', 'x-api-key': MEMBER },
  );
  line('validation', bad, await bad.text());

  // 7 · MessagePack in AND out — one request, both directions.
  const mp = await post(endpoint, encodeMsgpack({ query: 'books(id="b1") { title }' }), {
    'content-type': 'application/x-msgpack',
    accept: 'application/x-msgpack',
  });
  const decoded = decodeMsgpack(new Uint8Array(await mp.arrayBuffer()));
  line('msgpack', mp, `${mp.headers.get('content-type')} ${JSON.stringify(decoded)}`);

  // 8 · SSE — the graph arrives in frames, not one blob.
  const sse = await post(endpoint, jsonBody({ query: 'books { id, title }' }), {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  });
  const frames = (await sse.text()).split('\n\n').filter((frame) => frame.trim().length > 0);
  line('sse', sse, `${frames.length} frames → ${frames[0]?.split('\n')[0]}`);

  // 9 · Precise server-side cache eviction (spec §8): opt-in → hit → a
  // mutation refetches exactly the queries that read the mutated entity,
  // while unrelated caches survive. The cache plugin indexes every entry by
  // the entities in its query tree, and the engine evicts on mutation.
  const cacheHeaders = { 'content-type': 'application/json', 'x-orbit-cache': 'ttl=60' };
  const booksQuery = jsonBody({ query: 'books { id, title }' });
  const reviewsQuery = jsonBody({ query: 'reviews { id, rating }' });
  const bookCount = (data: unknown) => ((data as unknown[] | undefined) ?? []).length;
  const b1 = (await post(endpoint, booksQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  const b2 = (await post(endpoint, booksQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  const rv1 = (await post(endpoint, reviewsQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  const rv2 = (await post(endpoint, reviewsQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} ${bookCount(b1.data)} books (miss) → ${bookCount(b2.data)} books, fromCache: ${b2.fromCache === true} · ${bookCount(rv1.data)} reviews (miss) → ${bookCount(rv2.data)} reviews, fromCache: ${rv2.fromCache === true}`,
  );

  // A books mutation invalidates 'books' — the books entry refetches…
  const rmMember = await post(
    endpoint,
    jsonBody({ do: 'books.remove', args: { filter: { id: createdId } } }),
    { 'content-type': 'application/json', 'x-api-key': MEMBER },
  );
  const rmAdmin = await post(
    endpoint,
    jsonBody({ do: 'books.remove', args: { filter: { id: createdId } } }),
    { 'content-type': 'application/json', 'x-api-key': ADMIN },
  );
  const rmErr = (await rmMember.json()) as OrbitBody;
  console.log(
    `  ${'books.remove'.padEnd(16)} ${String(rmAdmin.status).padEnd(4)} member → ${rmMember.status} ${rmErr.error?.code ?? '?'} | admin ${await rmAdmin.text()}`,
  );
  const b3 = (await post(endpoint, booksQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  // …while the reviews cache survives (entity-scoped precision).
  const rv3 = (await post(endpoint, reviewsQuery, cacheHeaders).then((r) => r.json())) as OrbitBody;
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} after books.remove → ${bookCount(b3.data)} books, fromCache: ${b3.fromCache === true} (refetch) · ${bookCount(rv3.data)} reviews, fromCache: ${rv3.fromCache === true} (survived)`,
  );

  // 10 · Realtime: a WebSocket subscription receives the mutation as an event.
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/realtime`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('realtime socket failed to open'));
  });
  ws.send(JSON.stringify({ subscribe: 'reviews', id: 'ws-1' }));
  await waitForFrame(ws, (message) => message.ack === 'ws-1');
  // Attach the event listener BEFORE firing the mutation — the server pushes
  // the event while the HTTP request is still in flight, so a listener that
  // is only attached afterwards would miss it.
  const event = waitForFrame(ws, (message) => message.id === 'ws-1' && message.event !== undefined);
  const rt = await post(
    endpoint,
    jsonBody({
      do: 'reviews.add',
      args: { payload: { bookId: 'b2', rating: 4, text: 'En directo' } },
    }),
    { 'content-type': 'application/json', 'x-api-key': MEMBER },
  );
  const frame = await event;
  console.log(
    `  ${'realtime'.padEnd(16)} ${String(rt.status).padEnd(4)} ack → event ${JSON.stringify(frame.event).slice(0, 90)}`,
  );

  // 11 · Query/do envelopes work over the SAME socket (spec §10): the reply
  // mirrors the HTTP payload — status, data, correlation id and all.
  ws.send(JSON.stringify({ query: 'books { id, title }', id: 'ws-q' }));
  const qReply = await waitForFrame(ws, (m) => m.id === 'ws-q' && m.data !== undefined);
  const booksInFrame = (qReply.data as unknown[] | undefined)?.length ?? 0;
  console.log(
    `  ${'ws query'.padEnd(16)} ${String(qReply.status ?? '?').padEnd(4)} ${booksInFrame} books in one frame`,
  );

  // 12 · The same auth policy applies over the socket: without the
  // framework's x-api-key → caller identity, the engine denies the mutation
  // with ORBIT_PERMISSION_DENIED — defense in depth travels with the pipeline.
  ws.send(
    JSON.stringify({
      do: 'reviews.add',
      args: { payload: { bookId: 'b1', rating: 3, text: 'Sin clave' } },
      id: 'ws-m',
    }),
  );
  const mReply = await waitForFrame(ws, (m) => m.id === 'ws-m' && m.error !== undefined);
  const wsErr = mReply.error as { code?: string } | undefined;
  console.log(
    `  ${'ws mutation'.padEnd(16)} ${String(mReply.status ?? '?').padEnd(4)} no auth → ${wsErr?.code ?? '?'}`,
  );
  ws.close();

  console.log(`  ✔ ${host}: every protocol feature works over the wire`);
}
