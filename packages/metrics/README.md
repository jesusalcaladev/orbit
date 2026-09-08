# @orbit/metrics

First-party production metrics for [@orbit/core](../core) — a
**dependency-free collector** that wraps any Orbit handler and aggregates the
numbers a deployment needs from the wire contract only (status codes, the §8
`x-orbit-cache` header, the §6 error body).

## What it measures

- **Requests** by HTTP status
- **Errors** by standard protocol code (`ORBIT_*`, spec §6); non-protocol
  bodies count as `unknown`
- **Cache hits/misses** observed on the `x-orbit-cache` header (spec §8)
- **Rate-limited requests** (the `429`s of `@orbit/rate-limit`)
- **Latency**: count, sum, max, exact p50/p99 over a bounded window, plus a
  bucketed histogram for Prometheus-style export

Everything is read off the response only, so the same wrapper works with the
core, Express, Hono and Workers handlers — and it never touches frozen
protocol shapes.

## Install

```sh
pnpm add @orbit/metrics
```

## Quick start

```ts
import { createOrbit } from '@orbit/core';
import { createMetrics } from '@orbit/metrics';

const metrics = createMetrics();
const orbit = createOrbit({ adapters });

export default {
  fetch: (request) => metrics.wrapHandler(orbit.handler)(request),
};

// …expose the snapshot anywhere you like:
// GET /metrics → JSON.stringify(metrics.snapshot())
```

One wrapper can sit in front of several handlers (per-route or global).

## `snapshot()` shape

```ts
interface MetricsSnapshot {
  requests: number;                    // total instrumented requests
  byStatus: Record<string, number>;    // { "200": 42, "429": 3, … }
  errors: Record<string, number>;      // { ORBIT_MUTATION_FAILED: 2, … } + "unknown"
  cache: { hits: number; misses: number };
  rateLimited: number;
  duration: {
    count: number;                     // requests currently in the window
    sum: number;                       // ms — tracks the SAME window as count,
                                       // so sum / count is the true windowed mean
    max: number;
    p50: number;                       // exact percentiles over the recent window
    p99: number;
    buckets: Record<string, number>;   // histogram keyed by upper bound in ms
  };
}
```

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `window` | `1000` | How many recent durations to keep for exact percentiles. Ring-buffered; `sum` rolls as entries evict. |
| `bucketsMs` | `[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]` | Histogram bucket edges (upper bounds, ms). |
| `now` | `performance.now` | Injectable clock (tests). |

## Contract

No core changes, no new error codes — all metrics come off the standard
response contract. 10 tests in `packages/metrics/test/`.