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
      for await (const full of client.scanIterator({ MATCH: prefix + '*', COUNT: 100 })) {
        await client.del(full);
      }
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
