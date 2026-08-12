# 🔮 Orbit

> **Modular data layer for the modern fullstack.**
> A thin, blazing-fast contract layer that transports intent from client to server — with **zero runtime dependencies**.

[![CI](https://github.com/jesusalcaladev/orbit/actions/workflows/ci.yml/badge.svg)](https://github.com/jesusalcaladev/orbit/actions/workflows/ci.yml)

```ts
import { createOrbit, memoryAdapter, createCachePlugin } from '@orbit/core';

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
  plugins: [createCachePlugin()],
});

// One HTTP round-trip for the whole graph.
await fetch('/orbit', {
  method: 'POST',
  body: JSON.stringify({
    query: 'user(id="123") { name, posts(status="published") { title, views } }',
  }),
});
```

---

## Why this idea exists

Every fullstack project eventually hits the same three walls:

1. **The N+1 trap.** The UI needs a user, their posts, and each post's tags. The "smart" client library fires five, ten, twenty requests; or a magic ORM hides it behind a DSL that fights you the moment your data stops looking like a table.

2. **HTTP caching is dumb by default.** Browsers cache by URL, not by intent. Invalidating the right keys after a mutation feels like juggling glass, so most teams give up and rebuild client-side stores that drift out of sync.

3. **Schema lock-in.** Once the ORM owns your types, your database, your migrations and your opinions, swapping Postgres for Mongo is a rewrite, not a config change. The framework's "magic" only works while you stay inside its world.

The ecosystem answered each wall with *more framework*. GraphQL gave us one request — but demanded a schema you must maintain, resolvers with their own ceremony, and a runtime that owns your HTTP layer. ORMs gave us type safety — but tied us to a database. Caches gave us speed — but only if we adopted their invalidation theology.

Orbit starts from a different truth:

> **The developer knows best how to fetch and store data.**

No magic query planner. No central schema file. No vendored HTTP layer. Just a thin contract — a query language, a hook pipeline, and an adapter interface — that moves intent from client to server in one round-trip and then gets out of the way.

That's why the core has **zero runtime dependencies**: a contract layer should be pure. And it's why everything "smart" lives in things you choose to load: caching is a plugin, auth is a hook, Postgres is an adapter. Swap any of them without touching the protocol.

## Philosophy

| Principle | What it means |
| :--- | :--- |
| **You are still the developer** | Orbit is not an ORM. Filters are passed *verbatim* to your adapter. `id="123"` is never interpreted as a primary key — it's just a string. |
| **One request, if you write the resolver to batch** | The core groups sibling requests of the same entity into a single `batch()` call. The N+1 fix is a contract, not magic. |
| **The client defines the cache** | Cache specs travel with the query (`ttl=300`, `stale=60`) and a plugin enforces them. No hidden global cache to break. |
| **Runs anywhere** | The handler is a plain `(Request) => Promise<Response>`. Hono, Express, Cloudflare Workers, Bun, Deno, node:http — drop it in. |
| **Extensible by design** | Want a new data source? Write an adapter. New behavior? Write a hook. New wire format? `onBeforeSerialize`. |

## Features

- **OQS — Orbit Query Syntax.** A minimal, explicit query language: `user(id="123") { name, posts(status="published") { title } }`. Values are passed to resolvers *verbatim*.
- **Hook-based plugin system.** Seven well-defined hooks (`onBeforeParse` → `onBeforeSerialize` + `onError`) with a strict pipeline order.
- **N+1 batching.** Same-entity siblings collapse into one `batch()` call per level of the graph.
- **Declarative caching.** TTL and stale-while-revalidate via a cache spec string, enforced by the built-in zero-dependency cache plugin.
- **Mutations.** `do: "user.update"` with `filter`/`payload` args, plus an optional `return` sub-graph and `invalidates` for cache invalidation.
- **Standard errors.** One `OrbitError` type, predictable codes, correct HTTP statuses, and an `onError` hook to translate anything.
- **Wire format negotiation.** `Accept` decides the response — JSON, **MessagePack** (zero-dep codec), or **SSE streaming** (the graph arrives level by level, first byte in ~7 ms). `Accept-Encoding: gzip` compresses both JSON and msgpack. Errors speak the same format.
- **Streaming.** `orbit.stream()` yields the root as soon as its adapter answers; relations follow. Clients render before the database finishes the deep joins.
- **Realtime subscriptions.** A zero-dependency WebSocket transport (`createRealtimeServer`) streams adapter `subscribe` events to clients with per-subscription sequence numbers, retention across disconnects, and patch replay on `resume` — 100 clients share one adapter hook.
- **Frozen contracts.** The `DataAdapter` interface (resolve/batch/mutate/subscribe) and the envelope are canonicalized in [`spec.md`](./spec.md) — realtime is designed into the adapter contract, with the WebSocket transport on the roadmap.
- **Framework-agnostic handler.** Works with `Request`/`Response` runtimes, or call `orbit.execute(envelope, ctx)` directly.
- **Zero runtime dependencies.** `typescript` and `vitest` are dev-only. The whole protocol is a compact (~3 300 lines), typed ES2022 core — including the MessagePack codec and the WebSocket transport.

## Quick start

### 1. Install

```bash
npm install @orbit/core
```

### 2. Write adapters (the "source of truth")

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';

const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id }) => users.find((u) => u.id === id),
    },
    {
      entity: 'posts',
      // While resolving a relation, ctx.parent carries the resolved parent.
      resolve: ({ status }, ctx) => {
        let list = posts.filter((p) => p.authorId === ctx.parent?.data.id);
        if (status) list = list.filter((p) => p.status === status);
        return list;
      },
    },
  ]),
});
```

### 3. Mount plugins

```ts
import { createCachePlugin } from '@orbit/core';

const orbit = createOrbit({
  adapters,
  plugins: [createCachePlugin()], // TTL + stale-while-revalidate, in-memory
});
```

### 4. Mount the endpoint

```ts
app.post('/orbit', (c) => orbit.handler(c.req.raw, c.env)); // Hono
// or:  orbit.handler(req, env) // Workers / Bun / Deno
// or:  orbit.handler(req)      // node:http (see examples/)
```

### 5. Call it

```bash
curl -s localhost:3000/orbit \
  -H 'content-type: application/json' \
  -d '{"query":"user(id=\"123\") { name, posts { title } }"}'
```

```json
{ "data": { "name": "Ana", "posts": [{ "title": "Why Orbit?" }] } }
```

See [examples/standalone-server.ts](./examples/standalone-server.ts) for a complete zero-dependency server (`npm run example`), the [nine runnable examples](./docs/examples.md) for one facet each, [docs/benchmarks.md](./docs/benchmarks.md) for the B1–B9 numbers against measured graphql-js (including the real-HTTP wire path and the cache-vs-DataLoader story), [docs/security.md](./docs/security.md) for the threat model, and [docs/ecosystem.md](./docs/ecosystem.md) for the first-party `@orbit/*` package plan.

## Query syntax at a glance

| Construct | Example | Meaning |
| :--- | :--- | :--- |
| Entity root | `user(id="123")` | Resolve `user` with filter `{ id: "123" }` |
| Fields | `{ name, email }` | Project only these leaf fields |
| Relations | `{ posts(status="published") { title } }` | Resolve `posts` per parent, with its own filters |
| Bare values | `posts(id=42)` | `"42"` passed verbatim (strings stay strings) |
| Mutations | `{ "do": "user.update", "args": {...} }` | Adapter `mutate` with `filter`/`payload` |
| Re-query after mutation | `"return": "user(id=\"123\") { name }"` | Optional sub-graph in the mutation response |

## Caching

Attach a cache spec to any request — in the envelope or the `x-orbit-cache` header — and the cache plugin enforces it:

| Spec | Behavior |
| :--- | :--- |
| `ttl=300` | Serve while younger than 300 s, refetch after |
| `stale=60` | Always serve; refresh in the background past 60 s |
| `ttl=300,stale=60` | Fresh for 300 s; serve + background refresh until 360 s; refetch after |

```ts
{ query: 'user(id="1") { name }', cache: 'ttl=300' }
{ query: 'user(id="1") { name }', cache: 'stale=60' }
{ query: 'user(id="1") { name }', cache: 'ttl=300,stale=60' }
```

Register the cache plugin **after** any plugin that transforms data in `onBeforeSerialize`, so the cached value is the final payload — cache hits are served as-is, without re-running transforms.

Mutations return `invalidates` keys so the **client** knows what to clear:

```json
{ "data": { "success": true, "id": "123" }, "invalidates": ["cache:user:123"] }
```

> Server-side invalidation is manual: `cache.invalidate(key)` / `cache.invalidatePrefix('orbit:')`. See [docs/plugins.md](./docs/plugins.md#built-in-the-cache-plugin).

## Errors

Every failure is an `OrbitError` with a standard code and a correct HTTP status:

| Code | HTTP | Meaning |
| :--- | :--- | :--- |
| `ORBIT_INVALID_QUERY` | 400 | OQS syntax or envelope problem |
| `ORBIT_ENTITY_UNREGISTERED` | 404 | No adapter for the requested entity |
| `ORBIT_FILTER_INVALID` | 400 | The resolver rejected the filters |
| `ORBIT_PERMISSION_DENIED` | 403 | Fired by an auth hook |
| `ORBIT_MAX_DEPTH_EXCEEDED` | 400 | Query nests deeper than the configured maximum |
| `ORBIT_PAYLOAD_TOO_LARGE` | 413 | Envelope exceeds the configured size limit |
| `ORBIT_MUTATION_FAILED` | 500 | The mutation could not be executed |
| `ORBIT_INTERNAL` | 500 | Anything unexpected |

## Documentation

| Doc | What's inside |
| :--- | :--- |
| [OQS — Query Syntax](./docs/oqs.md) | Full grammar, examples, error cases |
| [Plugins](./docs/plugins.md) | Hook reference, the pipeline order, writing plugins, the cache plugin |
| [Ecosystem](./docs/ecosystem.md) | The `@orbit/*` package blueprint — contracts, scaffolding, build order |
| [Adapters](./docs/adapters.md) | The frozen adapter contract, batching, mutations, realtime `subscribe` |
| [Realtime](./docs/realtime.md) | WebSocket subscriptions, resume/delta sync, heartbeats — zero-dep RFC 6455 |
| [Serialization](./docs/serialization.md) | JSON, MessagePack, SSE streaming, gzip — `Accept`/`Accept-Encoding` negotiation |
| [Benchmarks](./docs/benchmarks.md) | B1–B9 vs measured graphql-js — latency, round-trips, throughput, payload, streaming, realtime, real-HTTP wire path, cache-vs-DataLoader |
| [Security](./docs/security.md) | Threat model: payload/depth limits, prototype-pollution hardening, realtime protocol defenses |
| [Examples](./docs/examples.md) | The nine runnable examples, tour and reading order |
| [Architecture](./docs/architecture.md) | How the engine executes a query, serialization, extension points |
| [Server integration](./docs/server.md) | Hono, Express, Workers, Bun, Deno, node:http |
| [Errors](./docs/errors.md) | Error reference and the `onError` hook |
| [Protocol spec](./spec.md) | The canonical, frozen contract — envelope, errors, adapters, realtime & roadmap |
| [Changelog](./CHANGELOG.md) | Version history |

## Development

Orbit is a **pnpm monorepo**: the protocol core lives in `packages/core`
(`@orbit/core`); docs, spec and examples live at the root. New packages slot
in as `packages/*`.

```bash
pnpm install         # dev dependencies only (typescript, vitest)
pnpm test            # 295 tests, Vitest (runs in packages/core)
pnpm run test:coverage # ~94% stmts / ~88% branch / ~96% lines (see packages/core)
pnpm run typecheck   # strict TypeScript (builds the core, then checks examples/bench)
pnpm run build       # ESM + .d.ts → packages/core/dist
pnpm run example     # zero-dep demo server on localhost:3000
pnpm run examples    # all nine runnable examples
pnpm run bench       # B1–B9 benchmarks + chart (docs/benchmarks.md)
```

## License

[MIT](./LICENSE)
