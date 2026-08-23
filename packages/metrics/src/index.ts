/**
 * @orbit/metrics — first-party production metrics for @orbit/core.
 *
 * A dependency-free collector that instruments any Orbit handler (the same
 * `Request → Response` function the core, Express, Hono and Workers adapters
 * expose) and aggregates the numbers a production deployment needs:
 *
 * - request counts by HTTP status
 * - error counts by standard protocol code (spec §6)
 * - cache hits/misses (the §8 `x-orbit-cache` header)
 * - rate-limited requests (the 429s of `@orbit/rate-limit`)
 * - latency: count, sum, max, exact p50/p99 over a bounded window, plus a
 *   bucketed histogram for Prometheus-style export
 *
 * Everything is read off the wire contract only — status codes, response
 * headers and the §6 error shape — so it works with every adapter and never
 * touches frozen protocol shapes. `snapshot()` returns a plain JSON-able
 * object; push it to your observability stack or scrape it from an endpoint.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { createMetrics } from '@orbit/metrics';
 *
 * const metrics = createMetrics();
 * const orbit = createOrbit({ adapters });
 *
 * export default {
 *   fetch: (request) => metrics.wrapHandler(orbit.handler)(request),
 * };
 *
 * // …and expose the snapshot anywhere:
 * // GET /metrics → JSON.stringify(metrics.snapshot())
 * ```
 */

/** Percentile window: the last N latencies give exact percentiles without
 * growing memory forever. */
const DEFAULT_WINDOW = 1000;

const DEFAULT_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface MetricsOptions {
  /** How many recent durations to keep for exact percentiles. Default 1000. */
  window?: number;
  /** Histogram bucket edges in ms (upper bounds). Defaults to 1–5000. */
  bucketsMs?: number[];
  /** Injectable clock (tests). Default `performance.now`. */
  now?: () => number;
}

export interface DurationStats {
  /** Completed requests timed. */
  count: number;
  /** Total ms across timed requests. */
  sum: number;
  /** Slowest request in ms. */
  max: number;
  /** Exact p50 over the recent window (ms). */
  p50: number;
  /** Exact p99 over the recent window (ms). */
  p99: number;
  /** Bucketed histogram keyed by upper bound (ms), for histogram export. */
  buckets: Record<string, number>;
}

export interface MetricsSnapshot {
  /** Total instrumented requests. */
  requests: number;
  /** Requests per HTTP status (`{ "200": 42, "429": 3, … }`). */
  byStatus: Record<string, number>;
  /** Errors per standard protocol code; non-protocol bodies count as `unknown`. */
  errors: Record<string, number>;
  /** Cache hits/misses observed on the `x-orbit-cache` header (spec §8). */
  cache: { hits: number; misses: number };
  /** Requests rejected with HTTP 429 (rate limit exceeded). */
  rateLimited: number;
  duration: DurationStats;
}

/** Fixed-capacity ring of recent values — O(1) insert, sorted on demand. */
class Ring {
  readonly #values: number[] = [];
  readonly #capacity: number;
  #head = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(value: number): void {
    if (this.#values.length < this.#capacity) this.#values.push(value);
    else {
      this.#values[this.#head] = value;
      this.#head = (this.#head + 1) % this.#capacity;
    }
  }

  sorted(): number[] {
    return [...this.#values].sort((a, b) => a - b);
  }

  clear(): void {
    this.#values.length = 0;
    this.#head = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  /* v8 ignore next — index is clamped above, so the slot always exists. */
  return sorted[index] ?? 0;
}

export interface Metrics {
  /** Wrap any Orbit handler (`Request → Promise<Response>`); the wrapper
   * keeps the original handler type. */
  // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary by host (core/Express/Hono/Workers); the generic preserves them verbatim.
  wrapHandler<H extends (...args: any[]) => Promise<Response>>(handler: H): H;
  /** A plain, JSON-able snapshot of everything collected so far. */
  snapshot(): MetricsSnapshot;
  /** Zero every counter and clear the latency window. */
  reset(): void;
}

/**
 * Build a metrics collector. Instrument handlers with `wrapHandler` — one
 * wrapper can sit in front of several handlers (per-route or global).
 */
export function createMetrics(options: MetricsOptions = {}): Metrics {
  const now = options.now ?? (() => performance.now());
  const durations = new Ring(options.window ?? DEFAULT_WINDOW);
  const bucketEdges = options.bucketsMs ?? DEFAULT_BUCKETS_MS;

  let requests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let rateLimited = 0;
  let sum = 0;
  let max = 0;
  const byStatus: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const buckets: Record<string, number> = {};
  for (const edge of bucketEdges) buckets[String(edge)] = 0;

  const record = (status: number, durationMs: number): void => {
    requests += 1;
    byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1;
    if (durationMs > max) max = durationMs;
    sum += durationMs;
    durations.push(durationMs);
    for (const edge of bucketEdges) {
      if (durationMs <= edge) {
        const key = String(edge);
        /* v8 ignore next — every edge is pre-initialized in the constructor. */
        buckets[key] = (buckets[key] ?? 0) + 1;
      }
    }
    if (status === 429) rateLimited += 1;
  };

  /** Extract the standard error code from a cloned body — never throws,
   * never disturbs the caller's copy of the response. */
  const recordErrorFromClone = async (response: Response): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await response.clone().text());
      const code =
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { error?: { code?: unknown } }).error === 'object'
          ? (parsed as { error: { code?: unknown } }).error.code
          : undefined;
      const key = typeof code === 'string' && code.startsWith('ORBIT_') ? code : 'unknown';
      errors[key] = (errors[key] ?? 0) + 1;
    } catch {
      errors.unknown = (errors.unknown ?? 0) + 1;
    }
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary by host; the generic preserves them verbatim.
    wrapHandler<H extends (...args: any[]) => Promise<Response>>(handler: H): H {
      const wrapped = async (...args: unknown[]): Promise<Response> => {
        const start = now();
        const response = await handler(...(args as unknown as Parameters<H>));
        record(response.status, now() - start);

        // Cache path visibility rides the §8 header channel (spec §8).
        const cacheHeader = response.headers.get('x-orbit-cache');
        if (cacheHeader === 'hit') cacheHits += 1;
        else if (cacheHeader === 'miss') cacheMisses += 1;

        if (!response.ok) await recordErrorFromClone(response);
        return response;
      };
      // The wrapper forwards every argument verbatim, so it keeps the
      // original handler's type.
      return wrapped as unknown as H;
    },

    snapshot(): MetricsSnapshot {
      const sorted = durations.sorted();
      return {
        requests,
        byStatus: { ...byStatus },
        errors: { ...errors },
        cache: { hits: cacheHits, misses: cacheMisses },
        rateLimited,
        duration: {
          count: sorted.length,
          sum,
          max,
          p50: percentile(sorted, 50),
          p99: percentile(sorted, 99),
          buckets: { ...buckets },
        },
      };
    },

    reset(): void {
      requests = 0;
      cacheHits = 0;
      cacheMisses = 0;
      rateLimited = 0;
      sum = 0;
      max = 0;
      for (const key of Object.keys(byStatus)) delete byStatus[key];
      for (const key of Object.keys(errors)) delete errors[key];
      for (const key of Object.keys(buckets)) buckets[key] = 0;
      durations.clear();
    },
  };
}
