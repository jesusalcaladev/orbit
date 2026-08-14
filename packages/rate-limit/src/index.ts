/**
 * @orbit/rate-limit — first-party rate limiting for @orbit/core.
 *
 * A dependency-free token-bucket plugin that gates requests in
 * `onBeforeParse`, so it covers **queries AND mutations** (the engine runs
 * `onBeforeParse` once before every mutation — spec §11). One bucket per
 * key (default: the first `x-forwarded-for` entry, else `x-real-ip`, else a
 * shared `anonymous` key); buckets refill lazily at `limit / windowMs`.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { createRateLimitPlugin } from '@orbit/rate-limit';
 *
 * const orbit = createOrbit({
 *   adapters,
 *   plugins: [createRateLimitPlugin({ windowMs: 60_000, limit: 120 })],
 * });
 * ```
 *
 * Buckets live in a **pluggable store** (`RateLimitBucketStore`) with one
 * ATOMIC method, `consume`: check-and-decrement happens in one step, so the
 * same limits can be shared across instances. The default is an in-memory
 * store; `@orbit/redis` ships `createRedisRateLimitStore` (Lua `EVAL`), and
 * the plugin exposes the limiter on `ctx.providers.rateLimiter` (the 🧪
 * provides channel) so adapters and other plugins enforce the SAME shared
 * limits imperatively:
 *
 * ```ts
 * import { createClient } from 'redis';
 * import { createOrbit } from '@orbit/core';
 * import { createRateLimitPlugin } from '@orbit/rate-limit';
 * import { createRedisRateLimitStore } from '@orbit/redis';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 *
 * const orbit = createOrbit({
 *   adapters,
 *   plugins: [
 *     createRateLimitPlugin({
 *       windowMs: 60_000,
 *       limit: 120,
 *       store: createRedisRateLimitStore({ client }), // shared across instances
 *     }),
 *   ],
 * });
 *
 * // …and anywhere in the pipeline (e.g. inside an adapter):
 * // const limiter = ctx.providers?.rateLimiter;
 * // const { ok, retryAfterMs } = await limiter?.consume('heavy-op');
 * ```
 *
 * Exceeding the limit rejects with `ORBIT_PERMISSION_DENIED` and HTTP
 * **429** (the frozen code set has no rate-limit code; the status override
 * keeps the wire honest) plus `details.retryAfterMs`. Customize with
 * `keyOf` (e.g. a user id stamped by an auth plugin), `onExceeded`, or a
 * custom store.
 */
import { ErrorCode, OrbitError } from '@orbit/core';
import type { OrbitContext, OrbitPlugin } from '@orbit/core';

/** The verdict of one atomic `consume` on a bucket. */
export type ConsumeResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Refill math params every store needs to run the token bucket. */
export interface BucketParams {
  /** Bucket capacity — max tokens, and the refill ceiling. */
  limit: number;
  /** Refill rate in tokens per millisecond (`limit / windowMs`). */
  rate: number;
  /** The window in ms — the store may use it to size server-side TTLs. */
  windowMs: number;
}

/**
 * The storage contract for rate-limit buckets — implement it over Redis,
 * Memcached, a shared Map, or anything else. `consume` is the ONLY method
 * and it is ATOMIC: the check-and-decrement must happen in one step in the
 * store, so concurrent instances never double-spend a token (this is what
 * makes multi-instance limits real — a read-modify-write store would be
 * racy by design).
 *
 * Every method may be sync (the in-memory store) or async (Redis). The
 * plugin `await`s each call. Failures fail **open or closed**? Fail CLOSED
 * by default: a store that throws rejects the request (sanitized by the
 * engine) — a limiter that silently stops limiting is worse than one that
 * fails loudly.
 *
 * `bucketCount` / `reset()` are optional introspection for tests and key
 * rotation; the plugin's `bucketCount` / `reset()` surface delegates to
 * them when present.
 */
export interface RateLimitBucketStore {
  /**
   * Atomically refill, check and decrement one bucket.
   * - `{ ok: true }` — the request may pass (a token was consumed).
   * - `{ ok: false, retryAfterMs }` — the bucket is empty; how long until
   *   one token refills.
   */
  consume(key: string, params: BucketParams, now: number): ConsumeResult | Promise<ConsumeResult>;
  /** Number of buckets currently tracked (monitoring/tests). Optional. */
  readonly bucketCount?: number;
  /** Drop every bucket (tests / key rotation). Optional. */
  reset?(): void | Promise<void>;
}

/**
 * The imperative limiter the plugin exposes on `ctx.providers.rateLimiter`
 * (🧪 provides channel): consume against the SAME shared store the request
 * gate uses, from anywhere in the pipeline — an adapter can rate-limit a
 * heavy operation, a plugin can gate its own work, with limits shared
 * across instances.
 */
export interface RateLimiter {
  /**
   * Atomically consume one token for a key. `now` is optional and only
   * useful in tests (the plugin's injected clock is the default).
   */
  consume(key: string, now?: number): ConsumeResult | Promise<ConsumeResult>;
}

/**
 * The in-memory rate-limit store — the reference implementation of
 * `RateLimitBucketStore`, and the default store of `createRateLimitPlugin`.
 * Synchronous, exact token-bucket math, `bucketCount` + `reset()` for tests.
 */
export function createMemoryRateLimitStore(): RateLimitBucketStore {
  interface Bucket {
    tokens: number;
    last: number;
  }
  const buckets = new Map<string, Bucket>();
  const store: RateLimitBucketStore = {
    consume(key, { limit, rate }, now) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: limit, last: now };
        buckets.set(key, bucket);
      }
      // Lazy refill: tokens accumulate at `rate` per ms, capped at capacity.
      const elapsed = Math.max(0, now - bucket.last);
      bucket.last = now;
      bucket.tokens = Math.min(limit, bucket.tokens + elapsed * rate);
      if (bucket.tokens < 1) {
        return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / rate) };
      }
      bucket.tokens -= 1;
      return { ok: true };
    },
    get bucketCount() {
      return buckets.size;
    },
    reset: () => {
      buckets.clear();
    },
  };
  return store;
}

export interface RateLimitOptions {
  /** Window length in ms — the bucket's refill period. */
  windowMs: number;
  /** Max requests per key within the window (bucket capacity). */
  limit: number;
  /**
   * Bucket store. Default: `createMemoryRateLimitStore()` (per-instance
   * limits). Pass `createRedisRateLimitStore` from `@orbit/redis` for
   * limits shared across instances.
   */
  store?: RateLimitBucketStore;
  /**
   * Expose the limiter on `ctx.providers` (🧪 provides channel) so adapters
   * and plugins can consume the SAME shared buckets imperatively. Default
   * `'rateLimiter'` (so `ctx.providers?.rateLimiter`); set a custom name, or
   * `false` to disable (mounting several rate-limit plugins, the extras
   * must disable or rename — duplicate provider names throw at boot).
   */
  provideAs?: string | false;
  /**
   * Extract the bucket key from the request context. Default: the first
   * `x-forwarded-for` entry, else `x-real-ip`, else `'anonymous'` (all
   * key-less clients then share one bucket — set `keyOf` for per-user
   * limits, e.g. from an auth plugin's `ctx.state`).
   */
  keyOf?: (ctx: OrbitContext) => string;
  /**
   * Build the error for an exceeded bucket. Default: `ORBIT_PERMISSION_DENIED`
   * with status 429 and `details: { limit, windowMs, retryAfterMs }`. Throw
   * an `OrbitError` for a precise client-facing code; a plain `Error` is
   * also accepted — the engine sanitizes it to `ORBIT_INTERNAL` (never leak
   * internals from here).
   */
  onExceeded?: (ctx: OrbitContext, key: string, retryAfterMs: number) => Error;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface RateLimitPlugin extends OrbitPlugin {
  /** The bucket store (introspection/tests). */
  readonly store: RateLimitBucketStore;
  /** Number of buckets currently tracked (monitoring/tests). */
  readonly bucketCount: number;
  /** Drop every bucket (tests / key rotation). */
  reset(): void;
}

const PROVIDE_DEFAULT = 'rateLimiter';

/**
 * Default identity key: the client's IP as seen by a proxy, else a shared
 * bucket. Deployment note: set `keyOf` when you can resolve a real identity
 * (user id, API key) — IP-based buckets are a floor, not a contract.
 */
function defaultKeyOf(ctx: OrbitContext): string {
  const forwarded = ctx.headers?.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = ctx.headers?.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  return 'anonymous';
}

/** Build a token-bucket rate limit plugin (spec §11: `onBeforeParse` runs
 * for queries and mutations, so one hook gates both). The bucket store is
 * pluggable — the in-memory store is the default; a Redis-backed store
 * (`@orbit/redis` `createRedisRateLimitStore`) shares limits across
 * instances via one atomic `consume` per request. */
export function createRateLimitPlugin(options: RateLimitOptions): RateLimitPlugin {
  const { windowMs, limit, keyOf = defaultKeyOf, now = () => Date.now() } = options;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimitPlugin: windowMs must be a positive number');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('createRateLimitPlugin: limit must be a positive number');
  }
  const rate = limit / windowMs; // tokens per ms
  const store = options.store ?? createMemoryRateLimitStore();
  const params = { limit, rate, windowMs };

  // The imperative limiter: same store, same params, same clock as the
  // request gate — adapters/plugins consume the SAME shared buckets.
  const rateLimiter: RateLimiter = {
    consume: (key, at) => store.consume(key, params, at ?? now()),
  };

  const provideAs = options.provideAs === undefined ? PROVIDE_DEFAULT : options.provideAs;
  const provides =
    provideAs === false ? undefined : ({ [provideAs]: rateLimiter } as Record<string, unknown>);

  const plugin: RateLimitPlugin = {
    name: 'orbit-rate-limit',
    ...(provides !== undefined ? { provides } : {}),

    get store() {
      return store;
    },

    get bucketCount() {
      return store.bucketCount ?? 0;
    },

    reset: () => {
      void store.reset?.();
    },

    hooks: {
      async onBeforeParse({ ctx }) {
        const key = keyOf(ctx);
        const result = await store.consume(key, params, now());
        if (result.ok) return;
        if (options.onExceeded) throw options.onExceeded(ctx, key, result.retryAfterMs);
        throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Rate limit exceeded', {
          status: 429,
          details: { limit, windowMs, retryAfterMs: result.retryAfterMs },
        });
      },
    },
  };

  return plugin;
}
