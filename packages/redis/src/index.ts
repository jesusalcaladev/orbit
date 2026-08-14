/**
 * @orbit/redis — a Redis-backed `CacheStore` for @orbit/core's cache plugin.
 *
 * The store implements the frozen `CacheStore` contract (re-exported by
 * `@orbit/cache`) over a Redis client you inject, so the package has no
 * runtime dependency on a specific client — use node-redis v4/v5:
 *
 * ```ts
 * import { createClient } from 'redis';
 * import { createOrbit, createCachePlugin } from '@orbit/core';
 * import { createRedisCacheStore } from '@orbit/redis';
 *
 * const client = createClient({ url: process.env.REDIS_URL });
 * await client.connect();
 *
 * const cache = createCachePlugin({
 *   store: createRedisCacheStore({ client }),
 * });
 * ```
 *
 * Entries are stored as JSON (`{ value, createdAt, query }`); a server-side
 * `ttlSeconds` optionally caps key lifetime so stale entries can't grow the
 * keyspace forever. Prefix invalidation (`cache.invalidatePrefix`) enumerates
 * keys with `SCAN` (`scanIterator`). A Redis outage fails requests **closed**
 * (sanitized `ORBIT_INTERNAL`) — the same policy as the core's cache-store
 * hardening — while a corrupted value is a silent miss.
 */
import type { CacheEntry, CacheStore } from '@orbit/core';

/**
 * The minimal Redis client surface the store needs. node-redis v4/v5 satisfies
 * it out of the box; pass any client with these methods.
 */
export interface RedisStoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<unknown>;
  /**
   * Enumerate keys matching a glob. Powers `clear()` and prefix invalidation;
   * without it those operations degrade to no-ops.
   */
  scanIterator?(options: { MATCH: string; COUNT?: number }): AsyncIterableIterator<string>;
}

export interface RedisCacheStoreOptions {
  /** A connected Redis client (node-redis v4/v5 recommended). */
  client: RedisStoreClient;
  /**
   * Namespace prepended to every stored key. Default `'orbit:'` (plugin keys
   * are already `orbit:<hash>`, so default full keys read `orbit:orbit:<hash>`);
   * set `''` to store bare plugin keys, or a per-app prefix to share a Redis.
   */
  prefix?: string;
  /**
   * Optional server-side TTL (seconds) applied on every `set`. The plugin
   * still enforces its `ttl`/`stale` semantics via `createdAt`; pick a value
   * at least as long as your longest `ttl + stale` window.
   */
  ttlSeconds?: number;
}

/**
 * Parse a JSON-serialized cache entry. Corrupted entries (bad JSON, wrong
 * shape, missing timestamp) are a miss, never a crash — mirroring the core's
 * cache-store hardening.
 */
function parseEntry(raw: string): CacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = parsed as Partial<CacheEntry>;
  if (typeof entry.createdAt !== 'number') return undefined;
  if (!('value' in entry)) return undefined;
  if (typeof entry.query !== 'string') return undefined;
  return entry as CacheEntry;
}

/** Build a Redis-backed `CacheStore` for `createCachePlugin({ store })`. */
export function createRedisCacheStore(options: RedisCacheStoreOptions): CacheStore {
  const { client, prefix = 'orbit:', ttlSeconds } = options;
  const fullKey = (key: string) => prefix + key;

  const store: CacheStore = {
    async get(key) {
      // Transport errors propagate (fail closed); a miss or corrupt value
      // degrades to `undefined` (the plugin resolves fresh).
      const raw = await client.get(fullKey(key));
      if (raw === null) return undefined;
      return parseEntry(raw);
    },

    async set(key, entry) {
      await client.set(
        fullKey(key),
        JSON.stringify(entry),
        ttlSeconds ? { EX: ttlSeconds } : undefined,
      );
    },

    async delete(key) {
      await client.del(fullKey(key));
    },

    async clear() {
      if (!client.scanIterator) return; // no enumeration → nothing to clear
      // Call the method on `client` so its `this` binding is preserved.
      // Multi-key `DEL` (chunked) beats one round-trip per key on a large
      // keyspace — node-redis v4/v5 accepts an array natively.
      let batch: string[] = [];
      for await (const full of client.scanIterator({ MATCH: prefix + '*', COUNT: 100 })) {
        batch.push(full);
        if (batch.length >= 100) {
          await client.del(batch);
          batch = [];
        }
      }
      if (batch.length > 0) await client.del(batch);
    },

    async *keys() {
      if (!client.scanIterator) return;
      for await (const full of client.scanIterator({ MATCH: prefix + '*', COUNT: 100 })) {
        // Yield the bare plugin key (prefix stripped) so the plugin's
        // `invalidatePrefix` compares against the keys it generated.
        yield full.slice(prefix.length);
      }
    },
  };

  return store;
}

/* --------------------------------------------------------------------------
 * Distributed rate-limit buckets (shared across instances)
 * -------------------------------------------------------------------------- */

/**
 * Atomic token-bucket consume as a single Redis script.
 *
 * One `EVAL` = one decision: refill, check and decrement happen inside Redis,
 * so N instances sharing a key can never double-spend a token (a
 * read-modify-write in JS would be racy by design). The bucket is a hash
 * `{ tokens, last }`; `EXPIRE` bounds dead keys (a bucket idle for longer
 * than its TTL resets to full on the next touch, which is exactly the lazy
 * refill contract).
 *
 * KEYS[1] = bucket key · ARGV[1] = now (ms) · ARGV[2] = limit ·
 * ARGV[3] = rate (tokens/ms) · ARGV[4] = ttlSeconds.
 * Returns `{allowed, retryAfterMs, resetAfterMs, remaining}` — the last two
 * feed the standard `RateLimit-Reset` / `RateLimit-Remaining` headers
 * (reset = ms until the bucket refills to capacity).
 */
const RATE_LIMIT_LUA = `
local tokens = tonumber(ARGV[2])
local last = tonumber(ARGV[1])
local raw = redis.call('HMGET', KEYS[1], 'tokens', 'last')
if raw[1] then
  tokens = tonumber(raw[1])
  last = tonumber(raw[2])
end
local elapsed = tonumber(ARGV[1]) - last
if elapsed > 0 then
  tokens = math.min(tonumber(ARGV[2]), tokens + elapsed * tonumber(ARGV[3]))
  last = tonumber(ARGV[1])
end
local limit = tonumber(ARGV[2])
if tokens < 1 then
  local retryAfterMs = math.ceil((1 - tokens) / tonumber(ARGV[3]))
  local resetAfterMs = math.ceil((limit - tokens) / tonumber(ARGV[3]))
  redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'last', tostring(last))
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return {0, retryAfterMs, resetAfterMs, 0}
end
tokens = tokens - 1
local remaining = math.floor(tokens)
local resetAfterMs = math.ceil((limit - tokens) / tonumber(ARGV[3]))
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'last', tostring(last))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {1, 0, resetAfterMs, remaining}
`.trim();

/**
 * The minimal Redis client surface the rate-limit store needs — node-redis
 * v4/v5 satisfies it out of the box (`eval`, plus optional `del`/
 * `scanIterator` for `reset()`).
 */
export interface RedisRateLimitClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: Array<string | number> },
  ): Promise<unknown>;
  /** Optional — powers `reset()` (SCAN + multi-key DEL). */
  del?(keys: string | string[]): Promise<unknown>;
  /** Optional — powers `reset()`. */
  scanIterator?(options: { MATCH: string; COUNT?: number }): AsyncIterableIterator<string>;
}

export interface RedisRateLimitStoreOptions {
  /** A connected Redis client (node-redis v4/v5 recommended). */
  client: RedisRateLimitClient;
  /**
   * Namespace prepended to every bucket key. Default `'orbit:rate-limit:'`;
   * set `''` or a per-app prefix to share a Redis.
   */
  prefix?: string;
  /**
   * Server-side key TTL (seconds). Defaults to `2 × windowMs` (so an idle
   * bucket survives at least a full refill window, then resets to full — the
   * lazy refill contract). `EXPIRE` refreshes on every consume.
   */
  ttlSeconds?: number;
}

/**
 * A Redis-backed atomic rate-limit bucket store for
 * `@orbit/rate-limit`'s `createRateLimitPlugin({ store })` — limits shared
 * across every instance pointing at the same Redis. The store satisfies the
 * frozen `RateLimitBucketStore` contract structurally (same `consume`
 * shape), so no dependency on `@orbit/rate-limit` is needed.
 *
 * ```ts
 * import { createRateLimitPlugin } from '@orbit/rate-limit';
 * import { createRedisRateLimitStore } from '@orbit/redis';
 *
 * createRateLimitPlugin({
 *   windowMs: 60_000,
 *   limit: 120,
 *   store: createRedisRateLimitStore({ client }),
 * });
 * ```
 *
 * Failures fail closed: a Redis outage rejects the request (sanitized by the
 * engine) — a limiter that silently stops limiting is worse than a 500.
 */
export function createRedisRateLimitStore(options: RedisRateLimitStoreOptions): {
  consume(
    key: string,
    params: { limit: number; rate: number; windowMs: number },
    now: number,
  ): Promise<
    | { ok: true; remaining?: number; resetAfterMs?: number }
    | { ok: false; retryAfterMs: number; remaining?: number; resetAfterMs?: number }
  >;
  /** SCAN + DEL every key under the prefix (key rotation / tests). */
  reset(): Promise<void>;
} {
  const { client, prefix = 'orbit:rate-limit:', ttlSeconds } = options;
  const fullKey = (key: string) => prefix + key;

  const finite = (value: unknown, fallback: number): number => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    async consume(key, { limit, rate, windowMs }, now) {
      // The bucket's server-side TTL: keep an idle bucket around for at least
      // one full refill window, then let it reset to full on the next touch.
      const ttl = ttlSeconds ?? Math.max(60, Math.ceil(windowMs / 1000) * 2);
      const result = await client.eval(RATE_LIMIT_LUA, {
        keys: [fullKey(key)],
        arguments: [now, limit, rate, ttl],
      });
      // Shape: {allowed, retryAfterMs, resetAfterMs, remaining}. Tolerant of
      // a bare truthy return (clients that flatten single-value tables).
      if (Array.isArray(result) && Number(result[0]) === 1) {
        return {
          ok: true,
          remaining: finite(result[3], 0),
          resetAfterMs: finite(result[2], 0),
        };
      }
      if (Array.isArray(result)) {
        return {
          ok: false,
          retryAfterMs: finite(result[1], 0),
          remaining: finite(result[3], 0),
          resetAfterMs: finite(result[2], 0),
        };
      }
      return { ok: true };
    },

    async reset() {
      if (!client.scanIterator || !client.del) return; // no enumeration → no-op
      let batch: string[] = [];
      for await (const full of client.scanIterator({ MATCH: prefix + '*', COUNT: 100 })) {
        batch.push(full);
        if (batch.length >= 100) {
          await client.del(batch);
          batch = [];
        }
      }
      if (batch.length > 0) await client.del(batch);
    },
  };
}
