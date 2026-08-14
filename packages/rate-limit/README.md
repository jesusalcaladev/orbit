# @orbit/rate-limit

First-party rate limiting for [@orbit/core](../core) — a **dependency-free
token-bucket plugin** that gates queries **and** mutations in one hook, with a
**pluggable bucket store**: the default in-memory store limits per instance,
and [`@orbit/redis`](../redis)'s `createRedisRateLimitStore` shares the SAME
limits across every instance (one atomic `consume` per request — no races).

## Why this package exists

The protocol core defends per-request (payload size, query depth, multipart
field count) — not per-IP. `docs/security.md` used to delegate rate limiting
entirely to the deployer. This package closes that gap with a zero-dependency,
one-line mount: a token bucket per client, refilling lazily over a window.

Because the plugin gates in `onBeforeParse` — and the engine runs
`onBeforeParse` once before every mutation (spec §5/§11 additive rule) — a
single hook covers reads **and** writes. No schema, no middleware, no external
services.

## Install

```sh
pnpm add @orbit/rate-limit
# distributed limits (optional):
pnpm add @orbit/redis redis
```

## Quick start

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createRateLimitPlugin } from '@orbit/rate-limit';

const orbit = createOrbit({
  adapters,
  plugins: [
    createRateLimitPlugin({ windowMs: 60_000, limit: 120 }),
  ],
});
```

## Distributed limits (shared across instances)

Mount the same plugin on every instance with a Redis-backed store:

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
      store: createRedisRateLimitStore({ client }), // ONE shared bucket space
    }),
  ],
});
```

The store contract is **atomic by construction**: `consume` does refill +
check + decrement in a single step inside the store (the Redis store is a Lua
`EVAL`), so concurrent instances can never double-spend a token — a
read-modify-write store would be racy by design.

## The limiter on `ctx.providers` (🧪 provides channel)

By default the plugin exposes the limiter on
`ctx.providers?.rateLimiter` — the SAME shared buckets, consumable from
anywhere in the pipeline (adapters included):

```ts
// inside an adapter's resolve/mutate — rate-limit a heavy operation with
// the same shared bucket space as the request gate:
const limiter = ctx.providers?.rateLimiter;
const { ok, retryAfterMs } = (await limiter?.consume('heavy-op')) ?? { ok: true };
```

Rename the provider with `provideAs: 'limits'`, or disable it with
`provideAs: false` (mounting several rate-limit plugins: the registry already
rejects duplicate plugin names, and duplicate provider names fail at boot too).

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `windowMs` | — (required) | Window length in ms — the bucket's refill period. |
| `limit` | — (required) | Max requests per key within the window (bucket capacity). |
| `store` | in-memory | `RateLimitBucketStore` — the atomic bucket store. `createMemoryRateLimitStore()` (default, per-instance) or `@orbit/redis`'s `createRedisRateLimitStore` (shared). |
| `provideAs` | `'rateLimiter'` | Expose the limiter on `ctx.providers` (🧪). Custom name, or `false` to disable. |
| `keyOf` | IP-derived | Bucket key from the context: the first `x-forwarded-for` entry, else `x-real-ip`, else a shared `anonymous` bucket. Provide your own (e.g. a user id stamped by an auth plugin) for per-user limits. |
| `onExceeded` | 429 | Build the rejection. Default: `ORBIT_PERMISSION_DENIED` with HTTP **429** and `details: { limit, windowMs, retryAfterMs }`. Throw an `OrbitError` for a precise client-facing code; a plain `Error` is sanitized to `ORBIT_INTERNAL` by the engine. |
| `now` | `Date.now` | Injectable clock (tests). |

## The `RateLimitBucketStore` contract

```ts
export type ConsumeResult = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateLimitBucketStore {
  consume(key: string, params: { limit: number; rate: number; windowMs: number }, now: number):
    ConsumeResult | Promise<ConsumeResult>;
  readonly bucketCount?: number;   // optional introspection (tests/monitoring)
  reset?(): void | Promise<void>;  // optional: drop every bucket
}
```

- **`consume` is the ONLY method and it is ATOMIC** — refill, check and
  decrement happen in one step, so multi-instance limits are real.
- Sync **or** async — the plugin `await`s each call; `createMemoryRateLimitStore`
  is the synchronous reference implementation (and the default).
- **Failures fail closed** — a store that throws rejects the request
  (sanitized by the engine): a limiter that silently stops limiting is worse
  than a 500.

## Behavior notes

- **Token bucket with lazy refill** — tokens accumulate at `limit / windowMs`
  per ms, capped at capacity; each request costs one token. No timers, no
  cleanup loops; buckets are created on demand (Redis keys get a server-side
  `EXPIRE` so dead buckets can't grow the keyspace).
- **Queries AND mutations** — the single `onBeforeParse` hook fires for both
  (spec §11 additive rule), so a mutation storm cannot bypass the limit.
- **429, not 403** — the frozen error-code set has no rate-limit code, so the
  plugin reuses `ORBIT_PERMISSION_DENIED` with a `status: 429` override: the
  wire stays honest (`Retry-After`-style info rides in `details.retryAfterMs`).
- **IP keys are a floor, not a contract** — behind a proxy, `keyOf` reads
  `x-forwarded-for`/`x-real-ip`, but real identity (user id, API key) should
  come from your auth plugin's `ctx.state`. Set `keyOf` when you can.
- **`reset()`** drops every bucket (key rotation, tests); `bucketCount`
  exposes how many buckets are tracked. With the Redis store, `reset()`
  SCANs + DELs the prefixed keys when the client supports it.

## Contract

Implements the frozen `OrbitPlugin` interface from `@orbit/core` (spec §11) —
no core changes, no new error codes, purely additive. 15 tests in
`packages/rate-limit/test/`.
