# @orbit/redis

A Redis-backed `CacheStore` for the [`@orbit/core`](../core) cache plugin.
Mount it to make Orbit's TTL / stale-while-revalidate / entity-scoped
eviction survive across instances and restarts — the in-memory store is
single-instance only.

The store implements the frozen `CacheStore` contract (re-exported by
[`@orbit/cache`](../cache)); the plugin stays identical. It injects the Redis
client, so this package has **zero runtime dependencies** beyond `@orbit/core`
— bring node-redis v4/v5 (or any client with the same four methods).

## Install

```bash
npm install @orbit/redis redis
```

## Usage

```ts
import { createClient } from 'redis';
import { createCachePlugin } from '@orbit/core';
import { createRedisCacheStore } from '@orbit/redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const cache = createCachePlugin({
  store: createRedisCacheStore({ client }),
});
```

Then mount `cache` as a plugin (register it **after** any `onBeforeSerialize`
transformer) and attach cache specs to queries as usual.

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `client` | *(required)* | A connected Redis client (node-redis v4/v5 recommended). |
| `prefix` | `'orbit:'` | Namespace prepended to every stored key. Plugin keys are already `orbit:<hash>`, so default full keys read `orbit:orbit:<hash>`; set `''` for bare keys or a per-app prefix to share one Redis. |
| `ttlSeconds` | `undefined` | Server-side `EX` applied on every `set`, capping key lifetime so stale entries can't grow the keyspace. The plugin still enforces `ttl`/`stale` via `createdAt`; pick ≥ your longest `ttl + stale` window. |

## Distributed rate limiting (`createRedisRateLimitStore`)

A Redis-backed **atomic** bucket store for
[`@orbit/rate-limit`](../rate-limit) — limits shared across every instance
pointing at the same Redis:

```ts
import { createClient } from 'redis';
import { createOrbit } from '@orbit/core';
import { createRateLimitPlugin } from '@orbit/rate-limit';
import { createRedisRateLimitStore } from '@orbit/redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const orbit = createOrbit({
  adapters,
  plugins: [
    createRateLimitPlugin({
      windowMs: 60_000,
      limit: 120,
      store: createRedisRateLimitStore({ client }),
    }),
  ],
});
```

- **Atomic by construction** — each `consume` is one Lua `EVAL` (refill +
  check + decrement inside Redis), so N instances can never double-spend a
  token. A read-modify-write in JS would be racy by design.
- **Header-ready verdicts** — `consume` returns `{ ok, remaining,
  resetAfterMs }` (and `retryAfterMs` on denial), which
  `@orbit/rate-limit` turns into the standard `RateLimit-*` / `Retry-After`
  response headers.
- **Buckets are hashes** `{ tokens, last }` under `prefix` (default
  `'orbit:rate-limit:'`); every `consume` refreshes a server-side `EXPIRE`
  (default `2 × windowMs`, override with `ttlSeconds`), so idle buckets
  expire and reset to full — exactly the lazy-refill contract.
- **Failures fail closed** — a Redis outage rejects the request (sanitized
  `ORBIT_INTERNAL` by the engine): a limiter that silently stops limiting is
  worse than a 500.
- **`reset()`** SCANs + DELs every key under the prefix (key rotation /
  tests) when the client provides `scanIterator`/`del`.

The store satisfies `@orbit/rate-limit`'s `RateLimitBucketStore` contract
structurally — `@orbit/redis` stays dependency-free beyond `@orbit/core`.

## Behavior notes

- **Storage format** — entries are JSON (`{ value, createdAt, query }`). The
  whole entry is stored so the plugin can read `createdAt` and enforce
  `stale` semantics.
- **Corrupted values are misses** — bad JSON or a wrong-shaped entry degrades
  to `undefined` and the plugin resolves fresh (never a crash).
- **Failures fail closed** — a Redis outage on `get`/`set` rejects the
  request with the engine's sanitized `ORBIT_INTERNAL`, matching the core's
  cache-store hardening. To fail open instead (serve from source when Redis
  is down), wrap your client so `get` returns `null` on transport errors.
- **Prefix invalidation** — `cache.invalidatePrefix(prefix)` enumerates keys
  with `SCAN` via `client.scanIterator`, so it needs node-redis v4+. If the
  client has no `scanIterator`, `invalidatePrefix` and `clear()` are no-ops
  (entity-scoped eviction after mutations still works — it uses the plugin's
  own index, not `SCAN`).
- **`clear()`** deletes every key under `prefix` via `SCAN`; it never issues
  `FLUSHDB`, so a shared Redis is safe.
