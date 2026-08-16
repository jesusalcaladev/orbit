# Examples

The examples live in `examples/` and are organized in two folders:

```
examples/
  node/   headless console scripts — run with plain Node, one facet per file
  web/    interactive HTML/CSS/JS demos — one server, real engine + graphql-js A/B
```

Every node example imports the **built** package and runs with plain Node — no
framework, no runtime dependencies. They double as executable documentation:
each one demonstrates one facet of the protocol and prints its results.

```bash
npm run build                   # once (examples import from dist/)
node examples/node/run-all.ts   # run all thirteen, back to back
```

## The node examples (`examples/node/`)

| File | Demonstrates |
| :--- | :--- |
| [`01-hello.ts`](../examples/node/fundamentals/01-hello.ts) | The smallest possible Orbit setup: one adapter, one query, projected output, and the standard error contract. |
| [`02-blog-relations.ts`](../examples/node/relations/02-blog-relations.ts) | Nested relations (`user { posts { comments } }`), **batching** (counts the `resolve()` calls — the whole graph in a handful of calls), and a mutation with a `return` sub-graph + `invalidates`. |
| [`03-auth-plugin.ts`](../examples/node/authentication/03-auth-plugin.ts) | A real plugin: `onBeforeParse` reads an API key, `onBeforeResolve` enforces roles, `onBeforeExecute` scopes a viewer's filters to themselves. Zero adapter changes. |
| [`04-adapter-custom.ts`](../examples/node/adapters/04-adapter-custom.ts) | The full frozen `DataAdapter` contract written by hand (a `Map`-backed adapter): `resolve`, `batch`, `mutate` and the realtime `subscribe` hook with a zero-dependency event emitter. |
| [`05-msgpack.ts`](../examples/node/serialization/05-msgpack.ts) | MessagePack end-to-end: the envelope is sent as `application/x-msgpack`, the response negotiated via `Accept`, both encoded/decoded with the zero-dependency codec. |
| [`06-streaming-sse.ts`](../examples/node/streaming/06-streaming-sse.ts) | `Accept: text/event-stream` — the graph arrives level by level; the client sees `level: 0`, then `level: 1`, then `level: 'done'` frames. |
| [`07-serializer-custom.ts`](../examples/node/serialization/07-serializer-custom.ts) | A plugin whose `onBeforeSerialize` returns a `SerializedPayload` — the same query served as JSON **or** CSV depending on `Accept`. |
| [`08-realtime.ts`](../examples/node/streaming/08-realtime.ts) | The WebSocket realtime transport end-to-end: subscribe to a live feed, mutations stream events, and a real disconnect → reconnect → `resume` replays the missed patches. |
| [`09-speed.ts`](../examples/node/performance/09-speed.ts) | **The speed showcase** — every number measured live on this machine: engine core µs/op + RPS, the full fetch handler, the 5-level deep graph (5 DB round-trips vs GraphQL's 1,111), the 20-post feed at a fraction of the JSON bytes, and a realtime fan-out to 50 live sockets. |
| [`10-express.ts`](../examples/node/frameworks/10-express.ts) | **The book API on Express** — a layered, best-practice app: domain (`book/data.ts`) → application (`book/engine.ts`) → interface (this file). Relations, authn in the framework + authz in the engine, client-driven caching, realtime via `attachRealtime`. |
| [`11-hono.ts`](../examples/node/frameworks/11-hono.ts) | **The same book API on Hono** — identical engine, identical walkthrough, proving the engine is framework-agnostic. |
| [`12-cloudflare-workers.ts`](../examples/node/frameworks/12-cloudflare-workers.ts) | **The same book API on Cloudflare Workers** — the engine behind one `fetch` handler, driven through `worker.fetch` with bindings in every context, plus the Workers-native realtime session. |
| [`13-fullstack-mongo.ts`](../examples/node/stack/13-fullstack-mongo.ts) | **The full first-party stack on one engine** — `@orbit/mongo` adapters (relations + `$in` batching), a Redis `CacheStore` with entity-precise eviction, Redis-backed distributed rate-limit buckets with standard headers, `@orbit/auth` read gates + row scoping, and per-request logging. Runs against an in-memory Mongo/Redis stand-in, or the real drivers via `MONGODB_URI`. |

The book API is the reference architecture example: `examples/node/book/`
holds the shared, framework-agnostic layers that all three hosts serve (see
`examples/node/book/README.md`).

## The web demos — interactive HTML/CSS/JS (`examples/web/`)

The interactive showcase runs one server that mounts the real engine **and** a
real graphql-js competition, then serves the demos over HTTP:

```bash
npm run web    # builds, then serves http://localhost:4321
```

Open the index and pick a demo — every one is vanilla HTML/CSS/JS in the
browser talking to the protocol:

| Demo | What it shows |
| :--- | :--- |
| [`chat-realtime`](../examples/web/chat-realtime/) | Realtime chat over Orbit's zero-dependency WebSocket: a `do: chat.send` mutation in every tab, one shared adapter `subscribe` hook, per-message round-trip latency. Open two tabs and talk. |
| [`twitter-post`](../examples/web/twitter-post/) | Native multipart uploads: one `FormData` body carries the JSON `envelope` field + the file, which lands as a real `File` in `ctx.files` inside `mutate`. Compose a post, attach an image, preview it. |
| [`03-mini-post`](../examples/web/03-mini-post/) | A feed with **nested relations** (`posts { author { name } }`) resolved through the adapter contract and batched per level, plus like/unlike mutations. |
| [`04-mini-auth`](../examples/web/04-mini-auth/) | Register/log in (scrypt-hashed passwords), the plugin reads `x-orbit-token` into `ctx.state.caller`, and a protected query is denied with `ORBIT_PERMISSION_DENIED` without the token. |
| [`05-orbit-vs-graphql`](../examples/web/05-orbit-vs-graphql/) | **The A/B lab**: the same chat, the same message bus, two protocols on one server. Send simultaneously to both, or run batches — end-to-end round-trips (send → mutation → shared bus → subscription → your tab) measured live, p50/p95/p99/max, payload bytes, and a comparative chart. |

The node examples live in concept folders under `examples/node/`:
`fundamentals/`, `relations/`, `authentication/`, `adapters/`, `serialization/`,
`streaming/`, `performance/` and `frameworks/`. The web demos live under
`examples/web/` (`chat-realtime/`, `twitter-post/`, `03-mini-post/`,
`04-mini-auth/`, `05-orbit-vs-graphql/`).

**How the A/B is wired** — `examples/web/server.ts` creates one shared world;
Orbit serves `/orbit` (handler) + `/realtime` (its WebSocket), graphql-js
serves `/graphql` (HTTP) + `/graphql-ws` (subscriptions via `ws` +
`graphql-ws`, devDependencies of the example harness only — `@orbit/core`
stays zero-dependency). Both sides emit onto the same in-memory bus, so the
race is honest.

## The demo server

[`examples/node/standalone-server.ts`](../examples/node/standalone-server.ts)
is a complete zero-dependency endpoint on `node:http` — the fetch-compatible
`handler` dropped into a raw server:

```bash
npm run example
```

```bash
curl -s localhost:3000/orbit -H 'content-type: application/json' \
  -d '{"query":"user(id=\"1\") { name, posts(status=\"published\") { title, views } }"}'
```

It ships with the cache plugin mounted, so repeat the same request with
`"cache":"ttl=300"` and the second response includes `"fromCache": true`.

## Reading order

New to Orbit? Start with `01-hello`, then `02` (the N+1 fix — the core reason
to exist), then `03` (how plugins give the protocol its brains). `05–07` are
about the wire: size, streaming, and custom formats. `08–09` show the realtime
transport and a live speed demo. `10–12` are the reference architecture — the
same layered book API served by Express, Hono and Cloudflare Workers.

Want to see it move before reading anything? Run
`node examples/node/performance/09-speed.ts` — it measures the engine on *your* machine in
seconds.
