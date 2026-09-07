/**
 * @orbit/cache — KV-cache plugin for @orbit/core.
 *
 * This is a thin, behavior-identical alias over the core's frozen
 * `createCachePlugin()`, kept for the `@orbit/cache` import path that has
 * accumulated (`createKvCachePlugin`). The core plugin already implements the
 * full `CacheStore` contract — sync **or** async stores (Redis, Cloudflare
 * KV, Memcached) — with the corruption fail-safe, precise entity-level
 * invalidation and the imperative surface:
 *
 * ```ts
 * import { createKvCachePlugin } from '@orbit/cache';
 * import { createRedisCacheStore } from '@orbit/redis';
 *
 * const kvCache = createKvCachePlugin({ store: createRedisCacheStore({ client }) });
 * ```
 *
 * One source of truth for cache behavior = one implementation to test. The
 * plugin logic (hook order, SWR, state management) lives in `@orbit/core` and
 * both entry points share it unchanged.
 */
import { createCachePlugin } from '@orbit/core';
import type { CachePlugin, CacheStore } from '@orbit/core';

// Re-export the frozen cache types so consumers importing the KV entry point
// get the real `@orbit/core` contract (sync-or-async stores).
export type { CacheEntry, CacheSpec, CacheStore } from '@orbit/core';

/** Options for the KV-cache plugin — identical to the core's cache options. */
export interface KvCachePluginOptions {
  /**
   * Cache store. Defaults to an in-memory store. The frozen `CacheStore`
   * contract is sync-or-async, so `createRedisCacheStore`, `createKvCacheStore`
   * and the bundled memory store all plug in unchanged.
   */
  store?: CacheStore;
  /** Header carrying the cache spec. Default `x-orbit-cache`. */
  headerName?: string;
  /** Default TTL (s) when a spec has neither `ttl` nor `stale`. Default 300. */
  defaultTtl?: number;
}

/**
 * Creates a KV-cache plugin for Orbit — the exact caching pipeline of the
 * core's `createCachePlugin`: read spec in `onAfterParse`, serve hit in
 * `onBeforeResolve` (SWR included), store fresh resolves in
 * `onBeforeSerialize`.
 *
 * Backends (Redis, Cloudflare KV, Memcached, …) plug in via the `store`
 * option. The returned plugin is a full `CachePlugin`: imperative
 * `invalidate` / `invalidatePrefix` / `invalidateEntity` / `clear`, the
 * backing `store` and `keyFor`.
 *
 * ```ts
 * import { createKvCachePlugin } from '@orbit/cache';
 * import { createKvCacheStore } from '@orbit/kv-cache';
 *
 * const kvCache = createKvCachePlugin({
 *   store: createKvCacheStore({ namespace }),
 *   headerName: 'x-orbit-cache',
 *   defaultTtl: 300,
 * });
 * ```
 */
export function createKvCachePlugin(options: KvCachePluginOptions = {}): CachePlugin {
  return createCachePlugin(options);
}
