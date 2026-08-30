# Orbit Protocol Spec

**Modular Data Layer for the Modern Fullstack**

> **Snapshot status:** this document is the **canonical, frozen contract** of
> the Orbit protocol. The current implementation is **v0.1.0** (see
> `CHANGELOG.md`). Every section carries an explicit status badge — ✅
> *implemented* or 🔜 *planned*. The 🔮 v2.0 vision is the long-term target;
> nothing in this spec is lost between versions.

---

## 0. Why Orbit exists

Every modern fullstack app repeats the same choreography: the client asks for
a shape of data, the server walks its database to answer it, and the wire
carries the result. We glued together REST endpoints, then GraphQL layers, and
each one shipped its own cost:

- **N+1 queries** — resolving `User → Posts → Comments` meant a round-trip
  per child (1 + 10 + 100 = 1111 queries for a 5-level graph).
- **Fat payloads** — clients received wide JSON they had to filter on the
  other side of a slow mobile connection.
- **Slow first bytes** — the client waited for the *whole* graph before seeing
  *any* of it, even when the root record was ready in 5 ms.
- **Locked-in client stacks** — every server framework dragged its own client,
  its own cache, its own transport.
- **Reconnects that refetch everything** — mobile apps re-downloaded entire
  graphs for a change they could have received as a patch.

Orbit is the answer to that repeated choreography: a **zero-dependency
contract layer** that transports *intent* from client to server — not a
schema, not an ORM, not a runtime. The envelope is the only schema the
protocol owns. Databases, resolvers, auth, caching, serializers and realtime
transports are all just *adapters* and *plugins* you mount.

---

## 1. Status legend

| Badge | Meaning |
| --- | --- |
| ✅ | Implemented and frozen in v0.0.1 |
| 🔜 | Planned — design is fixed here so it is never lost |
| 🧪 | Experimental — shape may change before v1.0 |

---

## 2. Core principles

1. **Intent, not schema.** The client says *what* it wants (`user(id="1") { name, posts { title } }`); the server figures out *how*.
2. **The envelope is the only schema the protocol owns.** Every request is one tiny JSON (or MessagePack) object. ✅
3. **The core knows no databases.** Data sources implement the `DataAdapter` contract; nothing else leaks in. ✅
4. **Everything else is a plugin.** Auth, cache, logging, custom serializers — hooks, in order, no magic. ✅
5. **Zero dependencies.** The entire core ships with `npm install`-free. ✅
6. **Best-in-class wire.** Binary serialization, compression, and streaming are part of the protocol, not an afterthought. ✅ (msgpack/gzip/SSE + zero-dependency WebSocket realtime)
7. **Realtime is a first-class citizen.** Subscriptions and delta sync are designed into the adapter contract now, not bolted on later. ✅ (zero-dependency WebSocket transport, §10)

---

## 3. The request envelope — FROZEN ✅

Every request is a single object posted to the Orbit endpoint. **Exactly one**
of `query`, `do`, or `ops` must be present.

```jsonc
{
  "query": "user(id=\"1\") { name, posts { title } }", // or…
  "do": "user.update",                                // …a mutation action
  "args": { "filter": { "id": "1" }, "payload": { "name": "Ana" } },
  "return": "user(id=\"1\") { id, name, posts { id } }", // optional re-query
  "cache": "ttl=300",                                   // optional cache spec
  "ops": [                                              // …or batch mutations
    { "do": "user.update", "args": { "filter": { "id": "1" }, "payload": { "name": "Ana" } } },
    { "do": "post.create", "args": { "payload": { "title": "Hello" } }, "return": "post { id }" }
  ]
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `query` | `string` | OQS (below). Mutually exclusive with `do` and `ops`. |
| `do` | `string` | Mutation action, form `entity.action` (e.g. `user.update`). Mutually exclusive with `query` and `ops`. |
| `ops` | `array` | Batch mutations: array of `{ do, args?, return? }` objects. Mutually exclusive with `query` and `do`. Executes sequentially; stops on first error. Response `data` is a per-op array; `invalidates` is the deduplicated union. |
| `args` | `object` | Passed verbatim to the adapter's `mutate`. Used with `do` or within `ops` entries. |
| `return` | `string` | OQS re-query of the affected sub-graph, returned after a successful mutation. Used with `do` or within `ops` entries. |
| `cache` | `string` | Cache spec, e.g. `ttl=300`, `stale=60`. Used with `query`. |

Limits: envelope size defaults to **10 MiB** (`maxPayloadBytes`, configurable);
query depth defaults to **10 levels** (`maxQueryDepth`, configurable).

**Frozen in v0.0.1.** Any future extension must be additive — new optional
fields only.

### Envelope validation

| Condition | Error |
| --- | --- |
| Not a JSON object | `ORBIT_INVALID_QUERY` (400) |
| Neither `query` nor `do` | `ORBIT_INVALID_QUERY` (400) |
| Both `query` and `do` | `ORBIT_INVALID_QUERY` (400) |
| `args` not an object | `ORBIT_INVALID_QUERY` (400) |
| `return` / `cache` not strings | `ORBIT_INVALID_QUERY` (400) |
| Body larger than `maxPayloadBytes` | `ORBIT_PAYLOAD_TOO_LARGE` (413) |
| Body not valid JSON / MessagePack | `ORBIT_INVALID_QUERY` (400) |

---

## 4. Orbit Query Syntax (OQS) ✅

A compact, GraphQL-inspired syntax that is *intent*, not schema.

```text
query        := node
node         := entity [ '(' filters ')' ] [ '{' selection '}' ]
selection    := ( field | relation ) ( ',' ( field | relation ) )*
relation     := entity [ '(' filters ')' ] [ '{' selection '}' ]
filters      := filter ( ',' filter )*
filter       := key '=' value
value        := '"' string '"' | number | true | false
```

Examples:

```text
user(id="1") { name, email }
posts(status="published", limit="10") { title, author { name } }
```

- **Entity names** must match registered adapter entities and relation names.
- **Filters** are passed verbatim to adapters as `Record<string, string>` — the adapter interprets them.
- **Fields** are projected server-side: only requested leaf fields leave the server.
- **Relations** become nested queries; their resolvers receive `ctx.parent` with the resolved parent data.
- Keys are validated for characters (identifier charset) **and length** —
  entity/field/filter-key names are capped at **128 chars** (`maxKeyLength`,
  configurable). Values are validated for their quote/escape structure **and
  length** — capped at **1024 chars** (`maxValueLength`, configurable). The
  whole envelope is size-capped by `maxPayloadBytes`. Malformed syntax or an
  over-long key/value raises `ORBIT_INVALID_QUERY` (400).
- **Duplicates are rejected, never silently merged**: a repeated filter key
  (`user(id="1", id="2")`), a repeated leaf field (`user { name, name }`) or
  a repeated relation (`user { posts { a }, posts { b } }`) raises
  `ORBIT_INVALID_QUERY` with the offending name in `details` — the previous
  last-write-wins behavior silently dropped data and hid client bugs.

---

## 5. Mutations ✅

```jsonc
{
  "do": "user.update",
  "args": { "filter": { "id": "1" }, "payload": { "name": "Ana" } },
  "return": "user(id=\"1\") { id, name }"
}
```

- `do` must be `entity.action`. The engine looks up the adapter and calls `mutate(action, args, ctx)` with the verb after the dot.
- The adapter returns `{ id?, invalidates?, ... }`. `invalidates` names
  entities or exact cache keys for server-side eviction (§8) and is echoed to
  the client so it can evict its own cache too.
- With `return`, the engine re-queries the sub-graph through the same pipeline (hooks included) and returns it as `data`.
- Without `return`, the response is `{ data: { success: true, id? } }`.
- Mutations run the pipeline's `onBeforeParse` hooks **once** before the
  adapter (§11 additive rule) — an auth plugin that stamps
  `ctx.state.caller` from the request headers here sees mutations too, so
  identity always reaches `mutate`. The hook's return value is ignored: a
  mutation has no query to rewrite.
- Mutations are **not** streamable.

Error codes: `ORBIT_MUTATION_FAILED` (500) when the adapter rejects; `ORBIT_ENTITY_UNREGISTERED` (404) for unknown entities.

---

## 6. Response & error shapes — FROZEN ✅

Success (JSON serialization):

```jsonc
{ "data": { "name": "Ana" } }                       // queries
{ "data": { "success": true, "id": "1" } }          // mutations
{ "data": { … }, "fromCache": true }                // cache hits
{ "data": { … }, "invalidates": ["cache:user:1"] }  // after mutations
```

Error — always the same machine-readable shape:

```jsonc
{
  "error": {
    "code": "ORBIT_ENTITY_UNREGISTERED",
    "message": "No adapter is registered for entity 'user'",
    "details": { "entity": "user" }   // optional, adapter-defined
  }
}
```

### Standard error codes (frozen)

| Code | HTTP | Meaning |
| --- | --- | --- |
| `ORBIT_INVALID_QUERY` | 400 | Malformed OQS or envelope. |
| `ORBIT_ENTITY_UNREGISTERED` | 404 | No adapter for the entity. |
| `ORBIT_FILTER_INVALID` | 400 | Resolver rejected the filters (e.g. bad UUID). |
| `ORBIT_PERMISSION_DENIED` | 403 | Auth/authorization failure (usually thrown by a plugin). |
| `ORBIT_MAX_DEPTH_EXCEEDED` | 400 | Query nests deeper than `maxQueryDepth`. |
| `ORBIT_PAYLOAD_TOO_LARGE` | 413 | Envelope exceeds `maxPayloadBytes`. |
| `ORBIT_MUTATION_FAILED` | 500 | Adapter mutation rejected. |
| `ORBIT_SUBSCRIPTION_FAILED` | 500 | A realtime subscription could not be established or serviced. *(added with the realtime transport — additive)* |
| `ORBIT_INTERNAL` | 500 | Anything unexpected — normalized from plain `Error`s. |

Plugins may translate errors via the `onError` hook; a failing error handler
never masks the original error.

---

## 7. Serialization & content negotiation ✅

### Request body

Clients may POST the envelope as `application/json` (default) or
`application/x-msgpack` (smaller, faster to parse). Selected via
`Content-Type`.

### File uploads (multipart/form-data) ✅

For mutations with binary data, the client posts `multipart/form-data`
with an `envelope` field (the JSON envelope, validated exactly like any
other) plus one field per file. Files are delivered to the adapter's
`mutate(action, args, ctx)` via `ctx.files` (keyed by field name) — the
envelope contract is untouched. `maxPayloadBytes` caps the whole multipart
body (early 413 via `content-length`, then again on the buffered bytes);
non-file fields other than `envelope` are rejected. A field-count cap
(`maxMultipartFields`, default **64**) rejects a thousands-of-tiny-fields
DoS outright — the byte cap bounds the body, the count cap bounds the parse
(`ORBIT_INVALID_QUERY` with `details.maxFields`). See
[docs/server.md](./docs/server.md#file-uploads-multipartform-data).

### Response — negotiated from `Accept`

| `Accept` | Response |
| --- | --- |
| (anything) | JSON — `application/json; charset=utf-8` (default). |
| `application/x-msgpack` | MessagePack — binary, ~20–40% smaller than JSON. |
| `text/event-stream` | SSE — the graph streams level by level as it resolves. |
| `application/*`, `*/*` | JSON (safe default — the client may not have a binary decoder). |
| `text/*` | SSE (a client narrowing to text formats wants streaming). |

Explicit types always beat wildcards; highest `q`-value wins. At equal
`q`-values, ties resolve in favor of the most specific format:
**MessagePack > SSE > JSON** (pinned by `test/negotiate.test.ts`).

### Compression

`Accept-Encoding: gzip` → response is gzip-compressed
(`content-encoding: gzip`), for JSON, MessagePack, SSE and plugin payloads,
when the runtime provides `CompressionStream`.

### Response headers (additive)

Plugins and adapters may attach response headers by setting
`ctx.responseHeaders` (a `Record<string, string | string[]>`) anywhere in
the pipeline; the handler merges them into every response format (JSON,
MessagePack, plugin bodies, errors). Array values append one header line per
item — `set-cookie` needs one line per cookie. This is the protocol's channel
for session cookies, CORS headers and custom cache-control. `execute()`
copies the pipeline's value back onto the context it received. For SSE
streaming, headers are sent before the pipeline runs, so a pipeline-set
`responseHeaders` cannot reach the stream — pass them via the handler's `ctx`
option instead. The engine also emits negotiation metadata automatically:
`vary: accept, accept-encoding` on every response, `cache-control: no-store`
on errors, and `cache-control: no-cache` on SSE. The built-in cache plugin
additionally emits `x-orbit-cache: hit|miss` and an age-aware
`cache-control` (spec §8) on responses it handled — but the error contract's
`no-store` always wins, even when a plugin stamped cache headers before a
resolution failure.

### Streaming semantics (SSE) ✅

The handler emits one SSE frame per resolved breadth-first level, then a final
`done` frame:

```text
data: {"level":0,"data":{…user…}}

data: {"level":1,"data":{…user+posts…}}

data: {"level":"done","data":{…complete graph…}}
```

- The first frame arrives as soon as the root adapter answers (TTFB goal: < 50 ms while relations still load).
- Backpressure: a slow client pauses resolution instead of buffering the whole graph.
- Parse errors fail fast as a non-200 status; mid-stream resolution errors become SSE frames.
- `orbit.stream()` exposes the same generator programmatically for custom transports.

---

## 8. Caching ✅

The client opts in per request with the `cache` field (or the `x-orbit-cache`
header) — a comma- or space-separated spec:

| Spec | Meaning |
| --- | --- |
| `ttl=300` | Fresh for 300 s. |
| `stale=60` | Serve stale up to 60 s while revalidating in the background (stale-while-revalidate). |

Cache hits are marked `fromCache: true`. **Server-side eviction is automatic
and precise at the entity level**: the cache plugin indexes every stored entry
by the entities its query tree reads (root **and** relations), and the engine
evicts exactly the entries that touch the mutated entity — a `books.create`
refetches cached `books` queries while `reviews` queries survive. The
adapter's `invalidates` may additionally name entities (`['user']`) or exact
store keys (`cache.keyFor(node)`); it is **echoed to the client** so
client-side caches can evict too. Eviction stops at entity granularity on
purpose: per-record precision would require data semantics, and the core
knows no databases (principle 3). The store is pluggable: a zero-dep memory
store ships, and production Redis / Cloudflare KV stores ship as
`@orbit/redis` and `@orbit/kv-cache` (the `CacheStore` contract is
sync-or-async, so network-backed stores plug in unchanged).

When a spec is applied, the plugin also speaks HTTP to downstream caches via
the §7 `responseHeaders` channel: `x-orbit-cache: hit|miss` tells you which
path served, and `cache-control` mirrors the spec with **age-aware** values
(`public, max-age=<remaining freshness>` on a fresh serve; `public,
max-age=0, stale-while-revalidate=<remaining window>` when serving stale) so
a CDN/proxy caches Orbit's answers for exactly as long as Orbit itself would
— and revalidates in the background the same way.

---

## 9. The DataAdapter contract — FROZEN ✅

Every data source — database, REST API, queue, file, cache — implements this.
**This interface is frozen in v0.0.1.** Nothing else is required of a data
source.

```ts
interface DataAdapter {
  entity: string;

  resolve(filters: Record<string, string>, ctx: OrbitContext): unknown | Promise<unknown>;
  batch?(requests: { filters: Filters; parent?: ParentContext }[], ctx: OrbitContext): Promise<unknown[]>;
  mutate?(action: string, args: MutationArgs, ctx: OrbitContext): MutationResult | Promise<MutationResult>;
  subscribe?(filters: Filters, handler: (event: SubscriptionEvent) => void): () => void;
}
```

| Method | Required | Role |
| --- | --- | --- |
| `resolve` | ✅ | Answer a filter set: one record (object) or many (array). Relations scope via `ctx.parent`. |
| `batch` | optional | The N+1 fix: the engine groups sibling requests of one entity into a single call; results align by index. |
| `mutate` | optional | Writes via the `do` envelope. Returns `{ id?, invalidates? }`. |
| `subscribe` | optional | Realtime: register a change listener; returns an unsubscribe function. |

### Design decisions (frozen)

| Proposal | Decision | Why |
| --- | --- | --- |
| `delete` method | **No** | The envelope's `do: 'entity.delete'` + `mutate('delete', …)` already covers deletion. A separate method would duplicate the mutation path. |
| `subscribeToEntity` | **No** | Redundant — an adapter is already entity-scoped (`adapter.entity`); `subscribe({}, handler)` means "every record of this entity". |
| `subscribe(filters, handler)` | **Yes** | One realtime primitive for the whole protocol; the transport layer feeds it. |

### Events

```ts
interface SubscriptionEvent {
  type: 'created' | 'updated' | 'deleted';
  id?: string | number;
  data?: unknown;              // full record after the change
  patch?: Record<string, unknown>; // minimal delta, for cheap sync
}
```

Bundled: `memoryAdapter(definitions)` wires `resolve`, a default `batch`, and
forwards `mutate`/`subscribe` when provided.

---

## 10. Realtime & subscriptions ✅

> Implemented in v0.0.1: the **zero-dependency WebSocket transport**
> (`createRealtimeServer`, RFC 6455 hand-rolled — no `ws` dependency) with
> subscription deduplication (N clients share one adapter hook),
> per-subscription sequence numbers, retention + resume across disconnects,
> heartbeats, **and `{ query }` / `{ do }` envelope requests** answered with
> the same payload as HTTP. See `docs/realtime.md`.

### Transport

- A WebSocket endpoint multiplexes all traffic for a connection: subscription
  control frames **and** envelope requests. ✅
- Clients send `subscribe` / `unsubscribe` / `resume` control messages **and**
  `{ query }` / `{ do }` envelopes as JSON (or MessagePack) frames. ✅

### Envelope request/response over the socket

```jsonc
// client →
{ "query": "user(id=\"1\") { name }", "id": "req-1" }
{ "do": "user.update", "args": { "filter": { "id": "1" }, "payload": { "name": "Ana" } }, "id": "req-2" }
// server →
{ "id": "req-1", "status": 200, "data": { "name": "Ana" } }
{ "id": "req-2", "status": 200, "data": { "success": true, "id": "1" }, "invalidates": ["cache:user:1"] }
{ "id": "req-3", "status": 404, "error": { "code": "ORBIT_ENTITY_UNREGISTERED", "message": "…" } }
```

- Envelopes are validated **exactly like HTTP** (`query` XOR `do`, `args` /
  `return` / `cache` rules, depth limits) and run the **full plugin
  pipeline** — auth gates, caching and error translation apply, so a policy
  that denies on HTTP denies on the socket too.
- The optional top-level `id` is a **correlation id, not an envelope field**:
  the frozen envelope (§3) drops unknown fields, so the transport reads `id`
  itself and echoes it back verbatim. Omit it for fire-and-forget.
- Success replies mirror the HTTP JSON payload: `{ id?, status, data,
  contentType?, fromCache?, invalidates? }` — `contentType` appears when a
  plugin serialized the payload to a string (binary plugin bodies and SSE
  streaming stay HTTP-only, `data: null`); failures use the standard
  `{ id?, status, error: { code, message, details? } }` contract.
- Message size is capped by `maxMessageBytes` (default 1 MiB); file uploads
  (multipart) and SSE streaming remain HTTP-only.

### Subscription protocol (wire frames)

```jsonc
{ "subscribe": "user(id=\"1\") { name, posts { title } }", "id": "sub-1" }
{ "unsubscribe": "sub-1" }
// server →
{ "id": "sub-1", "event": { "type": "updated", "id": "1", "patch": { "name": "Ana" } } }
```

- `subscribe` accepts the same OQS as queries — filters select the record set.
- The server parses the subscription once, then streams `SubscriptionEvent`s
  from the adapter's `subscribe` hook.
- `unsubscribe` stops delivery; the adapter's unsubscribe function is invoked.

### Delta sync & reconnect (benchmark B6)

- Clients keep a **resume cursor** (the last applied `seq` of the
  per-subscription sequence numbers).
- On reconnect, the client sends `{ "resume": "sub-1", "after": 42 }`.
- The server replays **only the patches with `seq > after`** (target: < 200 ms)
  instead of refetching the whole graph (Apollo baseline: 2 s).
- Deliveries are ordered per subscription; the sequence number lets the client
  detect gaps.

### Heartbeats & lifecycle

- Server pings every 30 s (`ping` frame); a missed ping closes the connection.
- Subscriptions are tied to the connection; reconnection + resume re-establishes them.
- The transport's `authorize` option gates upgrades (token/header checks) and
  may **return an `OrbitContext`** to seed the session (additive opt-in): it
  rides into every `{ query }`/`{ do }` envelope executed over the socket
  (so `ctx.state.caller` reaches `mutate` and the auth pipeline) and into
  the subscription gates — a subscription whose OQS the pipeline denies is
  rejected with the plugin's error (e.g. `ORBIT_PERMISSION_DENIED`) and the
  client's correlation `id` is echoed on the error frame. The adapter
  `subscribe` hook itself stays stateless (frozen contract §9);
  authorization happens at subscribe time.

---

## 11. The plugin pipeline — FROZEN ✅

Plugins run in registration order at each stage:

```text
parse → onBeforeParse → onAfterParse → onBeforeResolve → (per node, per level)
       onBeforeExecute → resolve/batch → onAfterResolve → project →
       onBeforeSerialize → serialize
```

| Hook | Role |
| --- | --- |
| `onBeforeParse` | Rewrite the raw query string (e.g. alias expansion). |
| `onAfterParse` | Enrich or replace the parsed tree (e.g. inject filters). |
| `onBeforeResolve` | Short-circuit (`{ shortCircuit }`) — cache hits, mocks, auth gates. |
| `onBeforeExecute` | Per-node/per-level adjustment of filters and context (tenant scoping). |
| `onAfterResolve` | Transform a resolved value before projection (field masking). |
| `onBeforeSerialize` | Replace the payload with a `SerializedPayload { body, contentType }` (msgpack, SSE, protobuf…). |
| `onError` | Translate/annotate errors. |

Short-circuited data is served as-is: the cache plugin stores the *final*
serialized value, so register cache plugins **after** transformers.

### The parsed query tree (QueryNode) — FROZEN

Every plugin that receives `parsed` (or a `node`) gets this exact shape:

```ts
interface QueryNode {
  entity: string;                       // entity name as written, e.g. "user"
  filters: Record<string, string>;      // verbatim, adapter-interpreted
  fields: string[];                     // requested leaf fields
  relations: Record<string, QueryNode>; // nested relations, keyed by relation name
  origin: 'client' | 'mutate';          // client query vs a mutation's `return` re-query
}
```

Decisions (frozen):

| Proposal | Decision | Why |
| --- | --- | --- |
| `_origin` (underscore prefix) | **No** — the field is `origin` | It is a public plugin-facing field, not an internal detail. |
| `_cacheSpec` on the node | **No** — cache specs never live on the node | The node is pure query structure; caching is request context (`ctx.envelope.cache` or the `x-orbit-cache` header), read by the cache plugin. |
| Mutation `return` nodes | stamped `origin: 'mutate'` | The re-query runs the full pipeline (§5) but is semantically server-initiated — plugins can distinguish it. |

### Injecting services into the pipeline (`provides`) — 🧪 ADDITIVE

Plugins may declare **boot-time services** on the plugin object itself:

```ts
const redisPlugin: OrbitPlugin = {
  name: 'redis',
  provides: { cacheStore: createRedisCacheStore({ client }) },
  hooks: { … },
};
// …and every hook AND adapter reads it off the context:
resolve(filters, ctx) { const store = ctx.providers?.cacheStore; … }
```

- The engine collects `provides` from every mounted plugin **in registration
  order** at `createOrbit` time and injects the merged, **read-only**
  container onto every request's `ctx.providers` **before any hook runs** —
  so a hook or adapter sees the service regardless of registration order, and
  a provider plugin never has to be listed first.
- **Duplicate provider names throw at boot**, naming both plugins — same
  fail-loudly philosophy as the registry's duplicate plugin-name rejection.
  Reserved prototype names (`__proto__`, `constructor`, `prototype`) are
  rejected too.
- `providers` is **boot-time singletons, shared across requests** (the
  container is frozen). Per-request values — a caller identity, a tenant id —
  belong in `ctx.state`, which is per-request scratch and mutable. This is
  the protocol's first-class channel for "inject things into ctx": a Redis
  client, a config object, a service instance.
- The container reaches queries, mutations (via `onBeforeParse` and
  `mutate`), `stream()`, the mutation `return` re-query and the realtime
  subscription gates (`authorizedSubscribe`) — every path that runs the
  pipeline.

Additive: an optional plugin field + an optional context field. No hook
signature, envelope shape or frozen interface changed. 🧪 Experimental — the
shape may evolve before 1.0. Pinned by `test/providers.test.ts`.

### Hook signatures — FROZEN

```ts
interface OrbitHooks {
  onBeforeParse(input: { query: string; ctx: OrbitContext }): string | void;
  onAfterParse(input: { parsed: QueryNode; ctx: OrbitContext }): QueryNode | void;
  onBeforeResolve(input: { parsed: QueryNode; ctx: OrbitContext }): { shortCircuit: unknown } | void;
  onBeforeExecute(input: { entity: string; filters: Filters; node: QueryNode; ctx: OrbitContext }):
    { filters?: Filters; ctx?: OrbitContext } | void;
  onAfterResolve(input: { result: unknown; node: QueryNode; ctx: OrbitContext }): unknown | void;
  onBeforeSerialize(input: { data: unknown; node: QueryNode; ctx: OrbitContext }):
    unknown | { body: string | Uint8Array; contentType: string } | void;
  onError(input: { error: OrbitError; ctx: OrbitContext }): OrbitError | void;
}
```

Every hook may also return a `Promise` of its return type. Rules (frozen):

- Returning `undefined` (or nothing) always keeps the current value.
- A short-circuit is *any* object carrying a `shortCircuit` key — plugins must
  not return data objects with that key unless they intend to short-circuit.
- A failing `onError` handler never masks the original error.
- `onBeforeParse`, `onAfterParse` and `onBeforeResolve` run once per query (on
  the root node); `onBeforeExecute` / `onAfterResolve` run per node, per level.
- A mutation's `return` re-query runs the full pipeline — hooks included (§5).
- Mutations run `onBeforeParse` once before the adapter (additive rule — see
  §5) so identity-stamping and rate-limit gates cover writes too.
- `ctx.signal` (an `AbortSignal`) is set by the engine from the caller's
  `ctx.signal` plus the optional `requestTimeoutMs` — adapters/plugins may
  cancel their own work when a request times out or is aborted.

Pinned by `test/contract.test.ts` in the core package.

---

## 12. Benchmarks — protocol goals

Measured on real hardware by `npm run bench` (see `docs/benchmarks.md`).

| ID | Scenario | Key metric | Competition | Orbit goal |
| --- | --- | --- | --- | --- |
| B1 | Simple query (user by id) | P99 latency | REST 5 ms (ref), graphql-js 0.118 ms cached-doc / 1.83 ms naive (measured) | < 3 ms — ✅ 0.11 ms |
| B2 | Deep nest (5 levels) | DB round-trips | graphql-js: 1112 resolver calls (measured) | ≤ 5 (1 batch/level) — ✅ 5 |
| B3 | Throughput | RPS (engine core) | graphql-js 20,528 cached-doc / ~1.6k naive (measured) | ~30k — ✅ 74,843 core; full wire path is undici-bound (~10k) |
| B4 | 20-post feed payload | KB transmitted | graphql-js JSON: 446 KB (measured; 19.1 KB gzipped) | ~120 KB (msgpack + compression) — ✅ 19 KB |
| B5 | TTFB in streaming | Time to first byte | REST 400 ms (ref, waits for all) | < 50 ms (user first, posts later) — ✅ 5 ms |
| B6 | Mobile reconnect | Sync time | Apollo refetch: 2 s (ref) | < 200 ms (patch replay) — ✅ 0.2 ms warm · ~587 µs resume |
| B7 | Realtime HTTP (WebSocket fan-out) | Fan-out latency (200 sockets) | spec goal 200 ms | < 200 ms — ✅ 11.1 ms (write path ~7.6 ms) · resume 500 patches ~3.3 ms |
| B8 | Wire path · real HTTP (node:http + keep-alive) | Requests/sec over HTTP | graphql-js measured on the same server | ✅ ~1.5× graphql-js (1,571 vs 1,029 RPS) — same client, same machine |
| B9 | Deep nest · warm cache replay vs DataLoader | Warm replay P99 latency | graphql-js + DataLoader: 5 DB batches/request (measured) | < 200 ms — ✅ 0.17 ms · 0 DB calls warm (DataLoader still pays all 5 per request) |
| B10 | Client overhead · real HTTP round-trip | P99 round-trip latency | raw fetch 1.993 ms (measured) | ≤ 15% added — ✅ 1.886 ms (≈0% overhead) |
| B11 | React layer (hooks + cache) · warm hit vs raw fetch | P99 latency (warm cache hit) | raw fetch 1.821 ms (measured) | < 0.5 ms warm — ✅ 0.003 ms (0 HTTP); miss overhead vs bare client +7.7% |

> Competition column note: graphql-js and dataloader numbers are MEASURED on
> the benchmark machine (both are devDependencies of the bench harness only —
> the core stays zero-dependency). REST and Apollo figures are labeled `(ref)`
> because no zero-dependency equivalent exists to install.

---

## 13. Versioning & roadmap

| Version | Contents | Status |
| --- | --- | --- |
| **0.0.1** | Core engine, OQS, envelope, errors, JSON/msgpack/SSE, gzip, caching, plugin pipeline, frozen `DataAdapter` + envelope, memoryAdapter, WebSocket realtime transport + security suite, prototype-pollution hardening, 12 node examples + 5 interactive web demos + the layered book API, benchmark suite (B1–B11) incl. real-HTTP wire path + cache-vs-DataLoader head-to-heads + client/react-layer overhead head-to-heads, CI (GitHub Actions matrix), frozen public API surface (spec §13), spec. | ✅ shipped |
| **0.1.x** | First real adapters (Postgres, Redis cache store), federation-friendly relation semantics. | 🔜 |
| **1.0** | Envelope & error codes locked for backwards compatibility; audit of every section in this spec. | 🔜 |
| **2.0 🔮** | Federated Orbit servers, native (WASM/C++) parsers to close the B3 wire-path gap (engine core already exceeds the goal), first-party client SDKs. | 🔜 |

**Compat rule:** nothing marked ✅ may change shape in a breaking way without
a major version bump; additive extensions are always allowed.

**Contract freeze:** the envelope (§3), error codes & response shapes (§6),
the `DataAdapter` interface (§9) and the parsed tree + hook signatures (§11)
are frozen as of v0.0.1 and pinned by `test/contract.test.ts` in the core
package. The **entire public API surface** of `@orbit/core` — every export of
`src/index.ts` (runtime values and type names alike) — is additionally pinned
exact-set by `test/api-surface.test.ts` in the core package: renaming,
removing or silently adding an export fails CI. Anything that moves a frozen
shape or renames a frozen export is a breaking change.

---


## 14. Non-goals

- No ORM, no schema DSL, no query planner — resolvers are plain functions.
- No bundled clients yet — the envelope is small enough to hand-roll (the client suite is a separate track, now including `@orbit/client` and `@orbit/react` with 132 e2e tests that exercise HTTP, SSE, multipart and realtime).
- No database coupling — adapters, always adapters.
