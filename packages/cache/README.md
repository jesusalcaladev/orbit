# @orbit/cache

The official distribution home of client-defined server-side caching for
[@orbit/core](../core) — TTL and stale-while-revalidate, enforced by the
protocol's zero-dependency cache plugin.

## Why this package exists

The cache plugin itself ships **inside the frozen `@orbit/core` contract** —
its import surface is pinned by `api-surface.test.ts`, and moving the code
out would invert the dependency direction into a `core → cache → core`
cycle. This package is the **stable, dedicated import path** for that same
plugin, and the home of the `CacheStore` backends that live *outside* the
core: Redis, Cloudflare KV, Memcached, …

Importing from `@orbit/cache` and importing from `@orbit/core` gives you the
exact same code — one way dependency, no duplication.

## Install

```sh
pnpm add @orbit/cache
```

## Quick start

```ts
import { createCachePlugin, createMemoryCacheStore } from '@orbit/cache';
import { createOrbit, memoryAdapter } from '@orbit/core';

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
  plugins: [createCachePlugin({ store: createMemoryCacheStore() })],
});
```

Clients opt a request in with the `cache` envelope field (or the
`x-orbit-cache` header):

```sh
curl -s localhost:3000/orbit \
  -H 'content-type: application/json' \
  -d '{ "query": "user(id=\"1\") { name }", "cache": "ttl=300" }'
```

The second identical request answers `{ "data": …, "fromCache": true }` —
no resolver call, no database hit.

## Cache specs

| Spec | Behavior |
| :--- | :--- |
| `ttl=300` | Fresh for 300 s, refetch after |
| `stale=60` | Always serve; refresh in the background past 60 s |
| `ttl=300,stale=60` | Fresh for 300 s; serve + background refresh until 360 s; refetch after |

## Server-side eviction

Eviction is **automatic and entity-scoped** (spec §8): the plugin indexes
every stored entry by the entities its query tree reads (root **and**
relations), and a mutation evicts exactly the entries that touch its entity
— a `books.create` refetches cached `books` queries while `reviews` queries
survive. Adapters may additionally name entities (`['user']`) or exact store
keys via `invalidates`, echoed to the client so it can evict its own cache
too.

## The `CacheStore` contract

The only contract a cache backend implements:

```ts
interface CacheStore {
  get(key: string): CacheEntry | undefined;   // CacheEntry = { value, createdAt, query }
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  keys?(): IterableIterator<string>;          // optional — powers prefix invalidation
}
```

Key facts for implementers:

- **Keys are opaque `orbit:<hash>` strings** (`fnv1a64`) — treat them as
  blobs, never parse them.
- **Values are JSON-able** — a Redis store can `JSON.stringify`, a KV store
  can store the string.
- **TTL is the store's job AND the plugin's** — the plugin enforces
  `ttl`/`stale` semantics by reading `createdAt`; the store may additionally
  expire keys server-side, but must never remove the plugin's ability to
  read `createdAt` (store the whole entry).
- **`keys()` is optional but recommended** — it powers `invalidatePrefix`.
- **Reentrancy matters** — `get` runs on every request and `set` after every
  miss; a blocking store adds latency directly.

`createMemoryCacheStore` (from this package or `@orbit/core`) is the
reference implementation. `@orbit/redis` and `@orbit/kv-cache` are the first
two backends on the roadmap (see `docs/ecosystem.md`).

## Exports

Re-exported from `@orbit/core`:

```ts
import { createCachePlugin, createMemoryCacheStore, parseCacheSpec } from '@orbit/cache';
import type { CachePlugin, CacheStore, CacheEntry, CacheSpec, CachePluginOptions, MemoryCacheStoreOptions } from '@orbit/cache';
```

## Test

```sh
pnpm test
```
