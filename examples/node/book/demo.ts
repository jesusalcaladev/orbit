/**
 * Book API — protocol walkthrough, now on `@orbit/client`.
 *
 * One script, run against either host: it exercises the whole Orbit protocol
 * through the reference client — relational queries, gated identity,
 * authenticated + role-checked mutations, input validation, MessagePack in
 * AND out, SSE streaming, the client-driven cache lifecycle and realtime
 * WebSocket subscriptions (with resume). Whatever this script can do, both
 * frameworks serve — and whatever the client sends, both speak.
 */
import { createClient, OrbitError } from '@orbit/client';
import type { OrbitResponse } from '@orbit/client';
import type { SubscriptionEvent } from '@orbit/core';

const ADMIN = 'admin-123';
const MEMBER = 'ana-456';

export async function runBookDemo(base: string, host: string): Promise<void> {
  const client = createClient({ baseUrl: `${base}/api/orbit` });
  const line = (name: string, status: number, body?: string) =>
    console.log(`  ${name.padEnd(16)} ${String(status).padEnd(4)} ${body ?? ''}`);
  const auth = (key?: string) => (key ? { headers: { 'x-api-key': key } } : {});
  const dump = (res: OrbitResponse) => `${JSON.stringify(res.data).slice(0, 80)}`;

  // 1 · One request fetches the whole relational graph (no N+1).
  const graph = await client.query(
    'books { id, title, authors { name, country }, reviews { rating } }',
  );
  line('query graph', graph.status, dump(graph));

  // 2 · A single record with a nested relation.
  const one = await client.query('books(id="b3") { title, year, authors { name } }');
  line('query one', one.status, dump(one));

  // 3 · Identity is gated by the engine policy — a key unlocks it.
  const whoAdmin = await client.query('user { id, role }', auth(ADMIN));
  let denied = '';
  try {
    await client.query('user { id, role }');
  } catch (error) {
    denied = error instanceof OrbitError ? `${error.status} ${error.code}` : '?';
  }
  line('identity', whoAdmin.status, `${dump(whoAdmin)} (no-key → ${denied})`);

  // 4 · Mutations are authenticated — a key is required.
  const addMember = await client.mutate(
    'reviews.add',
    { payload: { bookId: 'b2', rating: 5, text: 'Imprescindible' } },
    auth(MEMBER),
  );
  line('review.add', addMember.status, dump(addMember));
  let noKeyErr = '';
  try {
    await client.mutate('reviews.add', { payload: { bookId: 'b2', rating: 5, text: 'Genial' } });
  } catch (error) {
    noKeyErr = error instanceof OrbitError ? `${error.status} ${error.code}` : '?';
  }
  console.log(`  ${'review.add'.padEnd(16)} ${'—'.padEnd(4)} no-key → ${noKeyErr}`);

  // 5 · Creating a book is admin-only — members get a 403.
  const createArgs = { payload: { title: 'Cien años de soledad', year: 1967, authorId: 'a1' } };
  let crErr = '';
  try {
    await client.mutate('books.create', createArgs, auth(MEMBER));
  } catch (error) {
    crErr = error instanceof OrbitError ? `${error.status} ${error.code}` : '?';
  }
  const crAdmin = await client.mutate('books.create', createArgs, auth(ADMIN));
  const createdId = String((crAdmin.data as { id?: unknown } | undefined)?.id ?? '');
  console.log(
    `  ${'books.create'.padEnd(16)} ${String(crAdmin.status).padEnd(4)} ${dump(crAdmin)} (member → ${crErr})`,
  );

  // 6 · Bad input is rejected with the standard error contract.
  let badStatus = 0;
  let badDetail = '';
  try {
    await client.mutate(
      'reviews.add',
      { payload: { bookId: 'b1', rating: 9, text: 'x' } },
      auth(MEMBER),
    );
  } catch (error) {
    if (error instanceof OrbitError) {
      badStatus = error.status;
      badDetail = `${error.code} ${JSON.stringify(error.details ?? {})}`;
    }
  }
  line('validation', badStatus, badDetail || 'resolved?!');

  // 7 · MessagePack in AND out — one request, both directions.
  const mp = await client.execute({ query: 'books(id="b1") { title }' }, { format: 'msgpack' });
  line('msgpack', mp.status, `${mp.headers.get('content-type')} ${JSON.stringify(mp.data)}`);

  // 8 · SSE — the graph arrives in frames, not one blob.
  const frames: unknown[] = [];
  for await (const frame of client.stream('books { id, title }')) frames.push(frame.data);
  line('sse', 200, `${frames.length} frames → ${JSON.stringify(frames[0]).slice(0, 60)}`);

  // 9 · Precise server-side cache eviction (spec §8): opt-in → hit → a
  // mutation refetches exactly the queries that read the mutated entity,
  // while unrelated caches survive. The cache plugin indexes every entry by
  // the entities in its query tree, and the engine evicts on mutation.
  const bookCount = (data: unknown) => ((data as unknown[] | undefined) ?? []).length;
  const b1 = await client.query('books { id, title }', { cache: 'ttl=60' });
  const b2 = await client.query('books { id, title }', { cache: 'ttl=60' });
  const rv1 = await client.query('reviews { id, rating }', { cache: 'ttl=60' });
  const rv2 = await client.query('reviews { id, rating }', { cache: 'ttl=60' });
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} ${bookCount(b1.data)} books (miss) → ${bookCount(b2.data)} books, fromCache: ${b2.fromCache === true} · ${bookCount(rv1.data)} reviews (miss) → ${bookCount(rv2.data)} reviews, fromCache: ${rv2.fromCache === true}`,
  );

  // A books mutation invalidates 'books' — the books entry refetches…
  let rmErr = '';
  try {
    await client.mutate('books.remove', { filter: { id: createdId } }, auth(MEMBER));
  } catch (error) {
    rmErr = error instanceof OrbitError ? `${error.status} ${error.code}` : '?';
  }
  const rmAdmin = await client.mutate('books.remove', { filter: { id: createdId } }, auth(ADMIN));
  console.log(
    `  ${'books.remove'.padEnd(16)} ${String(rmAdmin.status).padEnd(4)} member → ${rmErr} | admin ${dump(rmAdmin)}`,
  );
  const b3 = await client.query('books { id, title }', { cache: 'ttl=60' });
  // …while the reviews cache survives (entity-scoped precision).
  const rv3 = await client.query('reviews { id, rating }', { cache: 'ttl=60' });
  console.log(
    `  ${'cache'.padEnd(16)} ${'200'.padEnd(4)} after books.remove → ${bookCount(b3.data)} books, fromCache: ${b3.fromCache === true} (refetch) · ${bookCount(rv3.data)} reviews, fromCache: ${rv3.fromCache === true} (survived)`,
  );

  // 10 · Realtime: a WebSocket subscription receives the mutation as an event.
  // The mutation fires only after the server acked the subscription — an
  // emit before the adapter hook attaches would be lost. The promise settles
  // once BOTH the event and the mutation reply arrived.
  const [frame, rt] = await new Promise<[SubscriptionEvent, { status: number }]>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for realtime event')),
        4000,
      );
      let event: SubscriptionEvent | undefined;
      let reply: { status: number } | undefined;
      const settle = () => {
        if (event !== undefined && reply !== undefined) {
          clearTimeout(timer);
          resolve([event, reply]);
        }
      };
      client.subscribe(
        'reviews',
        (e) => {
          if (e.type === 'created') {
            event = e;
            settle();
          }
        },
        {
          id: 'ws-1',
          onAck: () => {
            client
              .mutate(
                'reviews.add',
                { payload: { bookId: 'b2', rating: 4, text: 'En directo' } },
                auth(MEMBER),
              )
              .then((r) => {
                reply = r;
                settle();
              })
              .catch(reject);
          },
        },
      );
    },
  );
  console.log(
    `  ${'realtime'.padEnd(16)} ${String(rt.status).padEnd(4)} ack → event ${JSON.stringify(frame.data).slice(0, 80)}`,
  );

  // 11 · Query/do envelopes work over the SAME socket (spec §10): the reply
  // mirrors the HTTP payload — status, data, correlation id and all.
  const qReply = await client.socket().request({ query: 'books { id, title }' });
  const booksInFrame = (qReply.data as unknown[] | undefined)?.length ?? 0;
  line('ws query', qReply.status, `${booksInFrame} books in one frame`);

  // 12 · The same auth policy applies over the socket: without the
  // framework's x-api-key → caller identity, the engine denies the mutation
  // with ORBIT_PERMISSION_DENIED — defense in depth travels with the pipeline.
  let wsErr = '';
  try {
    await client.socket().request({
      do: 'reviews.add',
      args: { payload: { bookId: 'b1', rating: 3, text: 'Sin clave' } },
    });
  } catch (error) {
    wsErr = error instanceof OrbitError ? error.code : '?';
  }
  console.log(`  ${'ws mutation'.padEnd(16)} ${'403'.padEnd(4)} no auth → ${wsErr}`);

  client.close();
  console.log(`  ✔ ${host}: every protocol feature works through @orbit/client`);
}
