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
 * Exceeding the limit rejects with `ORBIT_PERMISSION_DENIED` and HTTP
 * **429** (the frozen code set has no rate-limit code; the status override
 * keeps the wire honest) plus `details.retryAfterMs`. Customize with
 * `keyOf` (e.g. a user id stamped by an auth plugin) or `onExceeded`.
 */
import { ErrorCode, OrbitError } from '@orbit/core';
import type { OrbitContext, OrbitPlugin } from '@orbit/core';

export interface RateLimitOptions {
  /** Window length in ms — the bucket's refill period. */
  windowMs: number;
  /** Max requests per key within the window (bucket capacity). */
  limit: number;
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
  /** Number of buckets currently tracked (monitoring/tests). */
  readonly bucketCount: number;
  /** Drop every bucket (tests / key rotation). */
  reset(): void;
}

interface Bucket {
  tokens: number;
  last: number;
}

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
 * for queries and mutations, so one hook gates both). */
export function createRateLimitPlugin(options: RateLimitOptions): RateLimitPlugin {
  const { windowMs, limit, keyOf = defaultKeyOf, now = () => Date.now() } = options;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('createRateLimitPlugin: windowMs must be a positive number');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('createRateLimitPlugin: limit must be a positive number');
  }
  const rate = limit / windowMs; // tokens per ms
  const buckets = new Map<string, Bucket>();

  const plugin: RateLimitPlugin = {
    name: 'orbit-rate-limit',

    get bucketCount() {
      return buckets.size;
    },

    reset: () => {
      buckets.clear();
    },

    hooks: {
      onBeforeParse({ ctx }) {
        const key = keyOf(ctx);
        const time = now();
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { tokens: limit, last: time };
          buckets.set(key, bucket);
        }
        // Lazy refill: tokens accumulate at `rate` per ms, capped at capacity.
        const elapsed = Math.max(0, time - bucket.last);
        bucket.last = time;
        bucket.tokens = Math.min(limit, bucket.tokens + elapsed * rate);

        if (bucket.tokens < 1) {
          const retryAfterMs = Math.ceil((1 - bucket.tokens) / rate);
          if (options.onExceeded) throw options.onExceeded(ctx, key, retryAfterMs);
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Rate limit exceeded', {
            status: 429,
            details: { limit, windowMs, retryAfterMs },
          });
        }
        bucket.tokens -= 1;
      },
    },
  };

  return plugin;
}
