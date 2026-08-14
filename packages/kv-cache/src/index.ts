/**
 * @orbit/kv-cache — a Cloudflare Workers KV-backed `CacheStore` for
 * @orbit/core's cache plugin.
 *
 * The store implements the frozen `CacheStore` contract over a Workers KV
 * namespace binding (injected, so it stays dependency-free and testable):
 *
 * ```ts
 * import { createCachePlugin } from '@orbit/core';
 * import { createKvCacheStore } from '@orbit/kv-cache';
 *
 * export default {
 *   async fetch(request, env) {
 *     const cache = createCachePlugin({
 *       store: createKvCacheStore({ namespace: env.ORBIT_CACHE }),
 *     });
 *     // …mount `cache` on an orbit and handle the request
 *   },
 * };
 * ```
 *
 * Entries are stored as JSON (`{ value, createdAt, query }`); an optional
 * `expirationTtl` caps key lifetime server-side. Prefix invalidation and
 * `clear()` page through `list()` (KV has no flush). Corrupted values are
 * silent misses; transport errors fail requests closed, matching the core's
 * cache-store hardening.
 */
import type { CacheEntry, CacheStore } from '@orbit/core';

/** The subset of a Workers `KVNamespace` binding the store needs. */
export interface KvNamespaceLike {
  get(key: string, options: { type: 'text' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface KvCacheStoreOptions {
  /** A Workers KV namespace binding (or any object with the same methods). */
  namespace: KvNamespaceLike;
  /**
   * Namespace prepended to every stored key. Default `'orbit:'` (plugin keys
   * are already `orbit:<hash>`); set `''` or a per-app prefix as needed.
   */
  prefix?: string;
  /**
   * Optional server-side TTL (seconds) applied on every `put`. The plugin
   * still enforces its `ttl`/`stale` semantics via `createdAt`; pick a value
   * at least as long as your longest `ttl + stale` window.
   */
  expirationTtl?: number;
}

/** Parse a JSON-serialized cache entry; corrupted entries are a miss. */
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

/** Build a Cloudflare Workers KV-backed `CacheStore` for `createCachePlugin`. */
export function createKvCacheStore(options: KvCacheStoreOptions): CacheStore {
  const { namespace, prefix = 'orbit:', expirationTtl } = options;
  const fullKey = (key: string) => prefix + key;

  const store: CacheStore = {
    async get(key) {
      // Transport errors propagate (fail closed); a miss or corrupt value
      // degrades to `undefined` (the plugin resolves fresh).
      const raw = await namespace.get(fullKey(key), { type: 'text' });
      if (raw === null) return undefined;
      return parseEntry(raw);
    },

    async set(key, entry) {
      await namespace.put(
        fullKey(key),
        JSON.stringify(entry),
        expirationTtl ? { expirationTtl } : undefined,
      );
    },

    async delete(key) {
      await namespace.delete(fullKey(key));
    },

    async clear() {
      // KV has no flush: page through list() and delete under the prefix.
      let cursor: string | undefined;
      do {
        const page = await namespace.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const item of page.keys) await namespace.delete(item.name);
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor !== undefined);
    },

    async *keys() {
      let cursor: string | undefined;
      do {
        const page = await namespace.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const item of page.keys) {
          // Yield the bare plugin key (prefix stripped) so the plugin's
          // `invalidatePrefix` compares against the keys it generated.
          yield item.name.slice(prefix.length);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor !== undefined);
    },
  };

  return store;
}
