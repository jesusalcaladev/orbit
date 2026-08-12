# Examples

Every example is a standalone script that imports the **built** package and runs with plain Node — no framework, no runtime dependencies. They double as executable documentation: each one demonstrates one facet of the protocol and prints its results.

```bash
npm run build      # once (examples import from dist/)
node examples/run-all.ts   # run all nine, back to back
```

## The nine examples

| File | Demonstrates |
| :--- | :--- |
| [`01-hello.ts`](../examples/01-hello.ts) | The smallest possible Orbit setup: one adapter, one query, projected output, and the standard error contract. |
| [`02-blog-relations.ts`](../examples/02-blog-relations.ts) | Nested relations (`user { posts { comments } }`), **batching** (counts the `resolve()` calls — the whole graph in a handful of calls), and a mutation with a `return` sub-graph + `invalidates`. |
| [`03-auth-plugin.ts`](../examples/03-auth-plugin.ts) | A real plugin: `onBeforeParse` reads an API key, `onBeforeResolve` enforces roles, `onBeforeExecute` scopes a viewer's filters to themselves. Zero adapter changes. |
| [`04-adapter-custom.ts`](../examples/04-adapter-custom.ts) | The full frozen `DataAdapter` contract written by hand (a `Map`-backed adapter): `resolve`, `batch`, `mutate` and the realtime `subscribe` hook with a zero-dependency event emitter. |
| [`05-msgpack.ts`](../examples/05-msgpack.ts) | MessagePack end-to-end: the envelope is sent as `application/x-msgpack`, the response negotiated via `Accept`, both encoded/decoded with the zero-dependency codec. |
| [`06-streaming-sse.ts`](../examples/06-streaming-sse.ts) | `Accept: text/event-stream` — the graph arrives level by level; the client sees `level: 0`, then `level: 1`, then `level: 'done'` frames. |
| [`07-serializer-custom.ts`](../examples/07-serializer-custom.ts) | A plugin whose `onBeforeSerialize` returns a `SerializedPayload` — the same query served as JSON **or** CSV depending on `Accept`. |
| [`08-realtime.ts`](../examples/08-realtime.ts) | The WebSocket realtime transport end-to-end: subscribe to a live feed, mutations stream events, and a real disconnect → reconnect → `resume` replays the missed patches. |
| [`09-speed.ts`](../examples/09-speed.ts) | **The speed showcase** — every number measured live on this machine: engine core µs/op + RPS, the full fetch handler, the 5-level deep graph (5 DB round-trips vs GraphQL's 1,111), the 20-post feed at a fraction of the JSON bytes, and a realtime fan-out to 50 live sockets. |

## The web demos — interactive HTML/CSS/JS

The interactive showcase runs one server that mounts the real engine **and** a
real graphql-js competition, then serves the demos over HTTP:

```bash
npm run web    # builds, then serves http://localhost:4321
```

Open the index and pick a demo — every one is vanilla HTML/CSS/JS in the
browser talking to the protocol:

| Demo | What it shows |
| :--- | :--- |
| [`01-chat`](../examples/web/01-chat/) | Realtime chat over Orbit's zero-dependency WebSocket: a `do: chat.send` mutation in every tab, one shared adapter `subscribe` hook, per-message round-trip latency. Open two tabs and talk. |
| [`02-file-image`](../examples/web/02-file-image/) | Native multipart uploads: one `FormData` body carries the JSON `envelope` field + the file, which lands as a real `File` in `ctx.files` inside `mutate`. Drag & drop, previews served from `/uploads/*`. |
| [`03-mini-post`](../examples/web/03-mini-post/) | A feed with **nested relations** (`posts { author { name } }`) resolved through the adapter contract and batched per level, plus like/unlike mutations. |
| [`04-mini-auth`](../examples/web/04-mini-auth/) | Register/log in (scrypt-hashed passwords), the plugin reads `x-orbit-token` into `ctx.state.caller`, and a protected query is denied with `ORBIT_PERMISSION_DENIED` without the token. |
| [`05-orbit-vs-graphql`](../examples/web/05-orbit-vs-graphql/) | **The A/B lab**: the same chat, the same message bus, two protocols on one server. Send simultaneously to both, or run batches — end-to-end round-trips (send → mutation → shared bus → subscription → your tab) measured live, p50/p95/p99/max, payload bytes, and a comparative chart. |

**How the A/B is wired** — `examples/web/server.ts` creates one shared world;
Orbit serves `/orbit` (handler) + `/realtime` (its WebSocket), graphql-js
serves `/graphql` (HTTP) + `/graphql-ws` (subscriptions via `ws` +
`graphql-ws`, devDependencies of the example harness only — `@orbit/core`
stays zero-dependency). Both sides emit onto the same in-memory bus, so the
race is honest.

## The demo server

[`standalone-server.ts`](../examples/standalone-server.ts) is a complete zero-dependency endpoint on `node:http` — the fetch-compatible `handler` dropped into a raw server:

```bash
npm run example
```

```bash
curl -s localhost:3000/orbit -H 'content-type: application/json' \
  -d '{"query":"user(id=\"1\") { name, posts(status=\"published\") { title, views } }"}'
```

It ships with the cache plugin mounted, so repeat the same request with `"cache":"ttl=300"` and the second response includes `"fromCache": true`.

## Reading order

New to Orbit? Start with `01-hello`, then `02` (the N+1 fix — the core reason to exist), then `03` (how plugins give the protocol its brains). `05–07` are about the wire: size, streaming, and custom formats. `08–09` show the realtime transport and a live speed demo.

Want to see it move before reading anything? Run `node examples/09-speed.ts` — it measures the engine on *your* machine in seconds.
