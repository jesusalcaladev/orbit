# Ecosystem — the `@orbit/*` packages

Orbit ships as a **pnpm monorepo of small, single-purpose packages**. The core
(`@orbit/core`) is a frozen, zero-dependency contract layer; everything
"smart" lives in an ecosystem package that plugs into that contract. This
page is the blueprint for building them: what each package is, which frozen
contract it implements, what it depends on, and the scaffolding conventions
every package follows.

> **Rule of the ecosystem:** a package never modifies the core. It implements
> a frozen contract (`DataAdapter`, `CacheStore`, `OrbitPlugin`, the handler
> shape) or wraps the handler for a server — and it is a **separate published
> package** with its own dependencies. `@orbit/core` stays zero-dependency
> forever.

## The distribution model

```
packages/
  core/      @orbit/core            ✅ shipped — engine, hooks, OQS, envelope,
                                    memory adapter, cache plugin, realtime WS
  adapters/             @orbit/postgres        ✅ DataAdapter over an injected `pg` client
                                    (parameterized WHERE, IN batching, CRUD)
             @orbit/mongo           ✅ DataAdapter over an injected `mongodb`
                                    client (filters→$match, $in batching,
                                    CRUD, ObjectId via toId/fromId)
             @orbit/sqlite          ⬜ DataAdapter over `node:sqlite` (optional)
             @orbit/rest            ✅ shipped — fetch-based DataAdapter
  caches/    @orbit/redis           ✅ shipped — CacheStore over Redis
             @orbit/kv-cache        ✅ shipped — CacheStore over Cloudflare KV
             @orbit/memcached       ⬜ CacheStore over Memcached (optional)
  plugins/   @orbit/auth            ✅ shipped — authn/authz hooks (authenticate/authorize/scope)
             @orbit/logging         ✅ shipped — request-timing / observability
             @orbit/rate-limit      ✅ shipped — token-bucket OrbitPlugin (queries + mutations)
             @orbit/cache           ✅ shipped — distribution home (impl stays in frozen core)
  servers/   @orbit/hono            ✅ shipped — thin handler wrapper for Hono
             @orbit/express         ✅ shipped — thin handler wrapper for Express
             @orbit/cloudflare-workers ✅ shipped — fetch handler + Workers-native realtime
  clients/   @orbit/client          ⬜ core frontend client (deferred)
             @orbit/client-react    ⬜ cache-aware React bindings (deferred)
```

## Package lifecycle

1. **Contract first.** Every package implements a frozen contract from
   `@orbit/core` (or wraps the handler). If the contract can't express the
   package's job, that's a spec conversation — never a core hack.
2. **Scaffold** under `packages/<name>` following `packages/core`'s layout:
   `src/`, `test/`, `package.json` with `"type": "module"`, ESM build to
   `dist/`, `.d.ts` alongside, `sideEffects: false`, `engines.node >= 20`.
   Peer-depend on `@orbit/core` (`"@orbit/core": "0.x"`); never vendor core
   code.
3. **Zero-dependency unless the job requires it.** `@orbit/redis` and
   `@orbit/kv-cache` inject the client/namespace, so they need nothing beyond
   `@orbit/core`; `@orbit/postgres` and `@orbit/mongo` inject the driver too
   (the user installs `pg` / `mongodb`; the packages depend only on
   `@orbit/core` and typecheck against the real driver via devDependencies).
   A *plugin* like `@orbit/auth` should need nothing beyond `@orbit/core`.
4. **Tests** in `packages/<name>/test/`, Vitest, exercising the real frozen
   contract against a fake/embedded dependency (an in-process Redis, a stub
   `pg` pool) — no network in CI.
5. **Docs + CHANGELOG** at the root: one row in `docs/ecosystem.md`, a
   section in `docs/plugins.md` or `docs/adapters.md`, ROADMAP status flip
   ⬜ → ✅, and a CHANGELOG entry.

## Contracts each package implements

### `CacheStore` (frozen — `@orbit/core` `src/plugins/cache.ts`)

Five methods (four required, `keys()` optional). This is the ONLY contract a
cache backend implements. Every method may be **sync or async**
(`Promise`-returning) — the in-memory store is sync, Redis/KV stores are
async, and the plugin `await`s each call:

```ts
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  keys?(): IterableIterator<string> | AsyncIterableIterator<string>; // optional — powers prefix invalidation
}
```

Key facts for implementers:

- **Keys are opaque `orbit:<hash>` strings** (`cache.keyFor(node)`, 64-bit
  `fnv1a64`) — treat them as blobs, never parse them.
- **Values are JSON-able.** The plugin stores `{ value, createdAt, query }`.
  A Redis store can `JSON.stringify`; a KV store can store the string.
- **TTL is the store's job AND the plugin's.** The plugin enforces
  `ttl`/`stale` semantics by reading `createdAt`; the store may additionally
  expire keys server-side, but must never *remove* the plugin's ability to
  read `createdAt` (store the whole entry).
- **`keys()` is optional** but recommended: it powers
  `invalidatePrefix` — the main cache-busting tool after a mutation.
- **Reentrancy matters.** The plugin calls `get` on every request and `set`
  after every miss, and `await`s both — an async store's latency lands on the
  hot path, so keep round-trips tight.
- **Failures fail closed, corruption fails open.** A store that throws on
  `get`/`set` rejects the request (sanitized `ORBIT_INTERNAL`); a *corrupted
  value* is a miss. The shipped stores implement exactly that split.

Status: **`@orbit/redis`** and **`@orbit/kv-cache`** are **shipped** — the
first two production backends. `memoryAdapter`'s sibling,
`createMemoryCacheStore`, is the reference implementation in core.

### `DataAdapter` (frozen — spec §9)

```ts
export interface DataAdapter {
  entity: string;
  resolve(filters: Filters, ctx: OrbitContext): unknown;
  batch?(requests: BatchRequest[], ctx: OrbitContext): unknown[];
  mutate?(action: string, args: MutationArgs, ctx: OrbitContext): MutationResult;
  subscribe?(filters: Filters, handler: (event: SubscriptionEvent) => void): () => void;
}
```

Database packages translate **verbatim string filters** into their query
language and implement `batch` (the N+1 fix: one query per level via
`WHERE … IN` / `$in`). **`@orbit/postgres` and `@orbit/mongo` are shipped**
— parameterized SQL (quoted identifiers, no injection) and match documents
(charset-validated field names + recursively-safe payload values, so `$`-keyed
client objects can never become query operators; `toId`/`fromId` handle
ObjectId ids), each with `create`/`update`/`delete` mutations and
`parentKey` relation scoping. **`@orbit/sqlite`** stays ⬜ (optional).
`@orbit/rest` is shipped too: queries become `GET` calls (filters as query
params, `/:id` when an `id` filter is present), mutations become
`POST`/`PATCH`/`DELETE` — see [docs/adapters.md](./adapters.md).

### `OrbitPlugin` (frozen — spec §11)

```ts
export interface OrbitPlugin {
  name: string;                       // unique
  hooks: Partial<Record<HookName, (input: never) => unknown>>;
}
```

`@orbit/auth` and `@orbit/logging` are hooks-only packages. See
[docs/plugins.md](./plugins.md) for the hook reference, order, and the
cache-plugin ordering rule.

### The handler (frozen — `(Request, ctx?) => Promise<Response>`)

Server wrappers wrap the handler for a specific framework. **`@orbit/hono`
and `@orbit/express` are shipped** as *thin raw bridges*: the framework's
original request (raw body + headers) goes straight to the engine's handler,
and the engine's response — status, every header, and the body including SSE
streams — comes back untouched. That keeps the full protocol intact
(JSON/msgpack input, JSON/msgpack/SSE output, gzip, multipart uploads, the
standard error contract) with no re-serialization in the wrapper. Both also
export `attachRealtime(server, orbit, options)`, which mounts the core
WebSocket transport on the same http server (one call — the engine's
subscription feed stays the single source of truth).
`@orbit/cloudflare-workers` **is shipped** as a `fetch` handler
(`createWorker` / `handleOrbit`): the original request goes straight to the
engine, bindings ride the OrbitContext as `ctx.env`, and realtime uses the
Workers-native `WebSocketPair` upgrade over the same runtime-agnostic
`SubscriptionHub` — the frame contract matches the Node transport exactly
(`docs/realtime.md`). See [docs/server.md](./server.md) for each host.

## Build order (from ROADMAP §9)

1. **`@orbit/rest`** ✅ — the simplest adapter (fetch-based; the old
   `fetchAdapter` was removed from core). Validated the scaffolding pattern
   end to end. `packages/rest` ships with its own tests (14) exercising the
   real `DataAdapter` contract against a mocked fetch.
2. **`@orbit/cache`** ✅ — the plugin's dedicated distribution package. The
   implementation deliberately STAYS in the frozen core: the import surface
   of `@orbit/core` is pinned by `api-surface.test.ts`, and moving the code
   out would invert the dependency direction (`core → cache → core` cycle)
   plus break the contract. `@orbit/cache` depends on the core one way and
   re-exports the plugin + `CacheStore` contract — and is the home of the
   Redis/KV/Memcached stores next. The code-level split is a deliberate
   breaking change reserved for a future major.
3. **`@orbit/auth`** ✅ + **`@orbit/logging`** ✅ — the two hooks-only plugin
   packages: authn/authz (`authenticate`/`authorize`/`scope` + bearer/api-key
   presets, 12 tests) and request timing/observability (5 tests). Both are
   dependency-free — nothing beyond `@orbit/core`.
4. **`@orbit/redis`** ✅ + **`@orbit/kv-cache`** ✅ — the two `CacheStore`
   backends that make the B6/B9 cache story production-ready. They implement
   the (now sync-or-async) `CacheStore` contract re-exported by `@orbit/cache`
   and inject the client/namespace, so both stay dependency-free beyond
   `@orbit/core` (8 tests each against in-memory fakes — no network in CI).
5. **`@orbit/postgres`** ✅ + **`@orbit/mongo`** ✅ — the two flagship
   database adapters, both over injected clients (no driver dependency in
   the package). Postgres turns verbatim string filters into
   **parameterized** `WHERE` clauses (operator overrides, `limit`
   validation, `parentKey` relation scoping), batches siblings into one
   `IN (...)` query and maps mutations to `INSERT`/`UPDATE`/`DELETE …
   RETURNING`; identifiers are validated and quoted, so neither a filter
   value nor a filter key can inject SQL (30 tests). Mongo translates the
   same filters into **match documents** (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/
   `regex`), batches into `$in`, maps mutations to `insertOne`/`updateOne`/
   `deleteOne`, converts ids through `toId`/`fromId` (ObjectId support),
   and guarantees no operator injection — field names are
   charset-validated and payload values are walked recursively, so a `$`-keyed
   object value can never become a query operator. 38 tests against an
   in-memory fake plus a compile-time assertion that the real `mongodb`
   driver satisfies the injected-client contract — no network in CI.
6. **Server wrappers** ✅ (`@orbit/hono`, `@orbit/express` — thin raw
   bridges, shipped with real end-to-end tests; `@orbit/cloudflare-workers`
   — fetch handler + Workers-native realtime, also shipped with end-to-end
   tests) and — once the protocol is proven stable — the **clients**.

Each step is a separate conventional commit (`feat: add @orbit/redis`), its
own `packages/<name>` workspace, tests, docs row, ROADMAP flip and CHANGELOG
entry.
