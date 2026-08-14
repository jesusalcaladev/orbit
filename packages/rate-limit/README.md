# @orbit/rate-limit

First-party rate limiting for [@orbit/core](../core) — a **dependency-free
token-bucket plugin** that gates queries **and** mutations in one hook.

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

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `windowMs` | — (required) | Window length in ms — the bucket's refill period. |
| `limit` | — (required) | Max requests per key within the window (bucket capacity). |
| `keyOf` | IP-derived | Bucket key from the context: the first `x-forwarded-for` entry, else `x-real-ip`, else a shared `anonymous` bucket. Provide your own (e.g. a user id stamped by an auth plugin) for per-user limits. |
| `onExceeded` | 429 | Build the rejection. Default: `ORBIT_PERMISSION_DENIED` with HTTP **429** and `details: { limit, windowMs, retryAfterMs }`. Throw an `OrbitError` for a precise client-facing code; a plain `Error` is sanitized to `ORBIT_INTERNAL` by the engine. |
| `now` | `Date.now` | Injectable clock (tests). |

## Behavior notes

- **Token bucket with lazy refill** — tokens accumulate at `limit / windowMs`
  per ms, capped at capacity; each request costs one token. No timers, no
  cleanup loops; buckets are created on demand.
- **Queries AND mutations** — the single `onBeforeParse` hook fires for both
  (spec §11 additive rule), so a mutation storm cannot bypass the limit.
- **429, not 403** — the frozen error-code set has no rate-limit code, so the
  plugin reuses `ORBIT_PERMISSION_DENIED` with a `status: 429` override: the
  wire stays honest (`Retry-After`-style info rides in `details.retryAfterMs`).
- **IP keys are a floor, not a contract** — behind a proxy, `keyOf` reads
  `x-forwarded-for`/`x-real-ip`, but real identity (user id, API key) should
  come from your auth plugin's `ctx.state`. Set `keyOf` when you can.
- **`reset()`** drops every bucket (key rotation, tests); `bucketCount`
  exposes how many buckets are tracked.

## Contract

Implements the frozen `OrbitPlugin` interface from `@orbit/core` (spec §11) —
no core changes, no new error codes, purely additive. 8 tests in
`packages/rate-limit/test/`.
