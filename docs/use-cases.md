# Use cases — where Orbit fits (and where it doesn't)

Orbit is a **data layer for products whose data is a relational graph**, whose
users expect **live updates**, and whose hot paths deserve a **server cache** —
all over one frozen wire contract instead of N bespoke endpoints. This page
walks the cases where that combination wins, with code that actually runs in
this repo (every snippet is real: demos, examples or shipped packages — paths
included), and ends with the cases where a simpler tool is the right answer.

The short version:

| Case | Why Orbit | Real proof in this repo |
| --- | --- | --- |
| Social / feeds | one round-trip for the whole graph + realtime + cache | `examples/web/06-tiktok-feed`, `examples/web/chat-realtime` |
| E-commerce | product = `product { variants, stock, reviews }` in one query; stock live | `packages/mongo`, `packages/client` (contract shown below) |
| Dashboards / SaaS | 15 fetches per render → one; KPIs push over WS | `examples/node/stack/13-fullstack-mongo`, `packages/auth` |
| IoT / telemetry | subscribe + `resume` replay for flaky field connections; commands over the same socket | `packages/core` realtime hub, `packages/client` realtime |

---

## Social — TikTok / Instagram-style feeds

This is Orbit's home turf. A feed item is not "a post": it is
`clip { creator, comments, likes }` — a small graph. With REST/GraphQL you pay
one request per node (the classic N+1); Orbit resolves the **whole level per
round-trip**, batched. The measured baseline is in [docs/benchmarks.md](./benchmarks.md):
the same 5-level feed that costs graphql-js **1,112 resolver calls** costs
Orbit **5 batched queries** (B2), and the wire payload drops from 446 KB to
19 KB (B4).

The live reference is the **TikTok-style feed** demo
(`examples/web/06-tiktok-feed/`). The server exposes the graph through three
adapters — the clips themselves plus role-shaped `creator` and `comments`
adapters that resolve from `ctx.parent`:

```ts
// examples/web/server.ts — the clips world (excerpt)
const clipsAdapter: DataAdapter = {
  entity: 'clips',
  resolve: (filters) => {
    if (filters.id) return clips.find((c) => c.id === filters.id) ?? null;
    return [...clips].reverse(); // a feed, not an archive
  },
  mutate: (action, args, ctx) => {
    if (action === 'like') {
      const clip = clips.find((c) => c.id === args.filter?.id);
      const liked = clip.likedBy.includes(voter);
      // … toggle like, then broadcast the updated record to every subscriber:
      emitClip({
        type: 'updated',
        id: clip.id,
        data: clip,
        patch: { id: clip.id, likes: clip.likes, likedBy: clip.likedBy },
      });
      return { id: clip.id, likes: clip.likes, liked: !liked };
    }
  },
  subscribe: (_filters, handler) => {
    clipHandlers.add(handler);
    return () => clipHandlers.delete(handler);
  },
};

// Resolves the `creator { … }` relation of a clip — a role-shaped adapter.
const creatorAdapter: DataAdapter = {
  entity: 'creator',
  resolve: (_filters, ctx) => {
    const clip = ctx.parent?.data;
    return clip ? { id: clip.creatorId, name: clip.creatorName, handle: clip.handle } : null;
  },
};
```

The client then pulls the **entire feed in one round-trip** — creators and
comments included — and the like is a single mutation whose result comes back
over the WebSocket to every tab (`examples/web/06-tiktok-feed/app.js`):

```ts
import { createClient } from '@orbit/client';

const client = createClient({ baseUrl: '/orbit' });

// The whole relational feed in ONE request:
// clips → creator, comments — resolved per level, batched server-side.
const FEED_QUERY =
  'clips { id, caption, emoji, likes, likedBy, ts, creator { name, handle }, comments { id, author, text, ts } }';

const { data, fromCache } = await client.query(FEED_QUERY, { cache: 'ttl=15' });

// Likes/comments/create broadcast to every tab as WS events — the card
// re-renders from the event payload, no refetch, no optimistic guess.
client.subscribe(FEED_QUERY, (event) => {
  if (event.data?.id) upsert(viewOf(event.data), { prepend: event.type === 'created' });
});
```

The cache is **evicted by entity, not flushed globally**: a `clips.like`
invalidates queries that touch `clips`, while an unrelated entity (say
`user`) keeps its warm entries — see the entity-precise eviction checks in
`examples/node/stack/13-fullstack-mongo.ts`. The demo proves the whole loop in
a real browser: the Playwright suite (`examples/web/e2e/demos.spec.ts`) clicks
a like and asserts the count re-renders in a **second, independent tab**.

> Also in the repo: `examples/web/chat-realtime/` — the messaging variant,
> including `resume`: drop the connection and the client replays the events
> you missed from its `seq` cursor instead of refetching history.

---

## E-commerce — catalog, stock and reviews

A product page is the same shape as a feed item: `product { variants, stock,
reviews, seller }`. Orbit renders the whole page in one round-trip, keeps hot
catalog reads in a Redis-backed cache, and streams stock changes to open carts
over the WebSocket.

The adapter contract is the shipped one — this wiring is exactly
`createMongoAdapter` from `@orbit/mongo` (see `examples/node/stack/13-fullstack-mongo.ts`
for the full mount), with a `parentKey` declaring the relation so sibling
variants batch into a single `$in` query:

```ts
import { createOrbit, createCachePlugin } from '@orbit/core';
import { createMongoAdapter } from '@orbit/mongo';
import { createRedisCacheStore } from '@orbit/redis';

const orbit = createOrbit({
  adapters: [
    createMongoAdapter({ entity: 'product', client, collection: 'products' }),
    createMongoAdapter({
      entity: 'variant',
      client,
      collection: 'variants',
      parentKey: 'product_id',   // N+1 fix: one $in batch per level
    }),
    createMongoAdapter({ entity: 'review', client, collection: 'reviews', parentKey: 'product_id' }),
  ],
  plugins: [createCachePlugin({ store: createRedisCacheStore({ client: redis }), defaultTtl: 60 })],
});
```

The client reads the page in one request and subscribes to inventory deltas:

```ts
// One round-trip for the whole PDP — no waterfall of fetches.
const { data } = await client.query(
  'product(slug="orbit-hoodie") { name, price, variants { size, color }, reviews { rating, text } }',
  { cache: 'ttl=60' }, // hot product → Redis-backed warm replays (B9: 0.17 ms, 0 DB calls)
);

// Live stock: carts update the instant someone buys.
client.subscribe('variant(id="v-42") { stock }', (event) => {
  updateStock(event.data.id, event.data.stock);
});
```

Stock mutations flow through the same contract — `do: 'variant.update'` with a
`filter` and `payload` — and the cache plugin auto-evicts the affected
queries server-side, so the *next* product read is cold and truthful, no
client coordination.

---

## Dashboards / SaaS — one query instead of fifteen

The classic dashboard render fires N fetches (metrics, series, alerts, quota,
activity) and then polls. With Orbit it is one envelope — and the live part
stops being polling, it becomes a subscription. Streaming (SSE) additionally
lets the first frame arrive at ~5 ms (B5) while the rest of the graph loads,
so the page paints before the query finishes.

The production stack is the full first-party plugin set, mounted once
(`examples/node/stack/13-fullstack-mongo.ts`, verbatim):

```ts
const orbit = createOrbit({
  adapters: [
    createMongoAdapter({ entity: 'user', client: counted, collection: 'users' }),
    createMongoAdapter({ entity: 'posts', client: counted, collection: 'posts', parentKey: 'author_id' }),
  ],
  plugins: [
    createLoggingPlugin({ logger: (entry) => collected.push(entry) }),
    createAuthPlugin({
      authenticate: apiKeyAuth(API_KEYS),
      // Read gate: runs BEFORE any adapter query touches Mongo.
      authorize: ({ parsed, caller }) => {
        if (parsed.entity === 'user' && caller.role !== 'admin') {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, `Role '${caller.role}' cannot query users`);
        }
      },
      // Row-level scope: members only ever see their own rows.
      scope: ({ entity, filters, caller }) => {
        if (entity === 'posts' && caller.role !== 'admin') return { ...filters, author_id: String(caller.id) };
      },
    }),
    createRateLimitPlugin({
      windowMs: 60_000,
      limit: 14,
      store: createRedisRateLimitStore({ client: redis }),
    }),
    createCachePlugin({ store: createRedisCacheStore({ client: redis }), defaultTtl: 60 }),
  ],
});
```

Served by any host — Express, Hono or Workers — with one line of transport
(`examples/node/frameworks/10-express.ts`):

```ts
import { attachRealtime, createExpressApp } from '@orbit/express';

const app = createExpressApp(orbit, {
  path: '/api/orbit',
  ctx: (req) => ({ state: { caller: identifyApiKey(req.get('x-api-key')) } }),
});
const server = app.listen(3100);
attachRealtime(server, orbit); // WS subscriptions on the SAME http server
```

The dashboard client then does one `query` for the initial render, one
`subscribe` for the live KPIs, and `stream` for progressive payloads — auth,
rate limits and caching are already enforced by the same pipeline that serves
them:

```ts
const { data } = await client.query(
  'dashboard(id="d-1") { kpis { revenue, activeUsers }, alerts { severity, message }, quota }',
);

client.subscribe('kpi { revenue, activeUsers }', (event) => animateKpis(event.data));

for await (const frame of client.stream('analytics(last="24h") { series { t, value } }')) {
  if (frame.level !== 'done') renderSeries(frame.data); // paints progressively
}
```

---

## IoT / telemetry — flaky connections, live state, remote commands

Field devices are the worst-case network: intermittent, bandwidth-starved,
often behind NAT. Two Orbit properties matter here:

1. **`resume` with a `seq` cursor** — subscriptions keep a ring buffer of
   recent events server-side (`RESUME_LOG_MAX = 512` in
   `packages/core/src/realtime/hub.ts`). When a device reconnects, the client
   replays only the events it missed from its last applied `seq` — measured at
   **500 patches in ~3.3 ms** (B7) — instead of refetching the whole state.
   This is automatic in `@orbit/client`: reconnect with backoff, resume from
   the cursor, and a transparent fallback to a fresh subscribe if the
   retention window expired (no error surfaces to your handler).
2. **Commands over the same socket** — the envelope `{ do }` round-trips over
   the WebSocket (`socket().request`), so a device uses one connection for
   telemetry in and commands out.

```ts
const client = createClient({ baseUrl: 'https://api.example.com/orbit' });

// Telemetry: the handle's `seq` is the resume cursor — a drop in the field
// reconnects and replays the missed samples automatically.
const sub = client.subscribe(
  'telemetry(device="pump-7") { ts, temperature, pressure }',
  (event, meta) => ingest(event.data, meta.seq), // seq = the resume cursor
);
sub.onStatus((state) => log(state)); // connecting → live → reconnecting…

// Command path: envelope request/response over the SAME socket.
await client.socket().request({
  do: 'device.setValve',
  args: { filter: { id: 'pump-7' }, payload: { open: 35 } },
});
```

Batch-friendly too: siblings collapse into one DB round-trip per level (the
same B2 mechanism), so a "status of my 200 devices" screen is one query with
one `IN (...)` batch, not 200 lookups.

---

## When **not** to use Orbit

The sweet spot is graphs + realtime + cache over a small-to-moderate cardinality
world. Skip it for:

- **Pure key-value or document-blob workloads** — a config store, session
  store, or "get me this one row by id" API. REST or gRPC is less machinery.
- **CRUD admin screens** with no relations and no live updates — Orbit's
  envelope adds ceremony without benefit.
- **Schema-first teams** — Orbit is *intent-first*: the contract is the
  envelope + OQS, not a declared SDL with shared client/server types. If your
  organization's whole workflow is schema-driven codegen, GraphQL fits that
  process better.
- **OLAP / massive scans** — Orbit batches per *level* of the graph, not
  across billion-row aggregations; push those to a warehouse query engine.

## Decision rule

> Use Orbit when your product asks **"what is X, along with its related Y and
> Z, right now, and what changed since my last view?"** — that single sentence
> covers social feeds, product pages, dashboards and device telemetry, and it
> is precisely the contract `@orbit/client` + `@orbit/core` implement.
