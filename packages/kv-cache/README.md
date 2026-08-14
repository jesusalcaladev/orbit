# @orbit/kv-cache

A Cloudflare Workers KV-backed `CacheStore` for the [`@orbit/core`](../core)
cache plugin — Orbit's TTL / stale-while-revalidate / entity-scoped eviction
on the edge, shared across all of a Worker's requests and isolates.

The store implements the frozen `CacheStore` contract (re-exported by
[`@orbit/cache`](../cache)) over a KV namespace binding; the plugin stays
identical. The binding is injected, so this package has **zero runtime
dependencies** beyond `@orbit/core`.

## Install

```bash
npm install @orbit/kv-cache
```

## Usage

```ts
import { createCachePlugin } from '@orbit/core';
import { createKvCacheStore } from '@orbit/kv-cache';

const cache = createCachePlugin({
  store: createKvCacheStore({ namespace: env.ORBIT_CACHE }),
});
```

Then mount `cache` as a plugin (register it **after** any `onBeforeSerialize`
transformer) and attach cache specs to queries as usual. Pass the KV binding
from your Worker's `env`.

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `namespace` | *(required)* | A Workers KV namespace binding (or any object with the same methods). |
| `prefix` | `'orbit:'` | Namespace prepended to every stored key. Plugin keys are already `orbit:<hash>`, so default full keys read `orbit:orbit:<hash>`; set `''` for bare keys or a per-app prefix. |
| `expirationTtl` | `undefined` | Server-side `expirationTtl` (seconds) applied on every `put`, capping key lifetime. The plugin still enforces `ttl`/`stale` via `createdAt`; pick ≥ your longest `ttl + stale` window. |

## Behavior notes

- **Storage format** — entries are JSON (`{ value, createdAt, query }`). The
  whole entry is stored so the plugin can read `createdAt` and enforce
  `stale` semantics.
- **Corrupted values are misses** — bad JSON or a wrong-shaped entry degrades
  to `undefined` and the plugin resolves fresh (never a crash).
- **Failures fail closed** — a KV error on `get`/`put` rejects the request
  with the engine's sanitized `ORBIT_INTERNAL`, matching the core's
  cache-store hardening.
- **Prefix invalidation & `clear()`** — KV has no flush, so both page through
  `list()` (1000 keys per page) and `delete` each key under `prefix`.
- **Pair with `@orbit/cloudflare-workers`** — the Workers server wrapper
  ships the Orbit handler and Workers-native realtime; add this store to put
  its cache on KV.
