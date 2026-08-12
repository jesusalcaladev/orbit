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
  adapters/  @orbit/postgres        ⬜ DataAdapter over `pg`
             @orbit/mongo           ⬜ DataAdapter over `mongodb`
             @orbit/sqlite          ⬜ DataAdapter over `node:sqlite` (optional)
             @orbit/rest            ⬜ fetch-based DataAdapter (old fetchAdapter)
  caches/    @orbit/redis           ⬜ CacheStore over Redis
             @orbit/kv-cache        ⬜ CacheStore over Cloudflare KV
             @orbit/memcached       ⬜ CacheStore over Memcached (optional)
  plugins/   @orbit/auth            ⬜ OrbitPlugin — authn/authz hooks
             @orbit/logging         ⬜ OrbitPlugin — span timing / observability
             @orbit/cache           🟡 split the core cache plugin out
  servers/   @orbit/hono            ⬜ handler wrapper for Hono
             @orbit/express         ⬜ handler wrapper for Express
             @orbit/cloudflare-workers ⬜ handler wrapper for Workers
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
3. **Zero-dependency unless the job requires it.** `@orbit/redis` needs the
   redis client; `@orbit/postgres` needs `pg`. A *plugin* like `@orbit/auth`
   should need nothing beyond `@orbit/core`.
4. **Tests** in `packages/<name>/test/`, Vitest, exercising the real frozen
   contract against a fake/embedded dependency (an in-process Redis, a stub
   `pg` pool) — no network in CI.
5. **Docs + CHANGELOG** at the root: one row in `docs/ecosystem.md`, a
   section in `docs/plugins.md` or `docs/adapters.md`, ROADMAP status flip
   ⬜ → ✅, and a CHANGELOG entry.

## Contracts each package implements

### `CacheStore` (frozen — `@orbit/core` `src/plugins/cache.ts`)

Five methods (four required, `keys()` optional). This is the ONLY contract a
cache backend implements:

```ts
export interface CacheStore {
  get(key: string): CacheEntry | undefined;      // CacheEntry = { value, createdAt, query }
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  keys?(): IterableIterator<string>;             // optional — powers prefix invalidation
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
  after every miss; a store that blocks (slow network) directly adds latency.
  Use pipelined/multi commands for the hot path.

Status: **`@orbit/redis`** and **`@orbit/kv-cache`** are the first two
implementations on the roadmap. `memoryAdapter`'s sibling,
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

Database packages (`@orbit/postgres`, `@orbit/mongo`, `@orbit/sqlite`,
`@orbit/rest`) translate **verbatim string filters** into their query
language and implement `batch` (the N+1 fix: one query per level via
`WHERE … IN` / `$in`). See [docs/adapters.md](./adapters.md) for the full
contract.

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

Server wrappers (`@orbit/hono`, `@orbit/express`,
`@orbit/cloudflare-workers`) are ~20-line adapters that drop
`orbit.handler` into the framework's request/response cycle. See
[docs/server.md](./server.md) for each host.

## Build order (from ROADMAP §9)

1. **`@orbit/rest`** — the simplest adapter (fetch-based; the old
   `fetchAdapter` was removed from core). Validates the scaffolding pattern
   end to end.
2. **`@orbit/cache` split** — move the core cache plugin into its own
   package, keep a thin re-export in core for backwards compatibility
   (additive, non-breaking).
3. **`@orbit/auth`** — hooks already exist; an easy, dependency-free win.
4. **`@orbit/redis`**, then **`@orbit/kv-cache`** — the two `CacheStore`
   backends that make the B6/B9 cache story production-ready.
5. **`@orbit/postgres` + `@orbit/mongo`** — the flagship DB adapters.
6. **Server wrappers** and — once the protocol is proven stable — the
   **clients**.

Each step is a separate conventional commit (`feat: add @orbit/redis`), its
own `packages/<name>` workspace, tests, docs row, ROADMAP flip and CHANGELOG
entry.
