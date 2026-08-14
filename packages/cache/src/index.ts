/**
 * @orbit/cache — the official distribution home of client-defined server-side
 * caching for @orbit/core.
 *
 * The cache plugin itself ships inside the frozen `@orbit/core` contract (its
 * import surface is pinned by `api-surface.test.ts`); this package is the
 * stable, dedicated import path for it — and the home of the `CacheStore`
 * backends that live outside the core: Redis, Cloudflare KV, Memcached, …
 * and the new `createKvCachePlugin` KV-cache plugin.
 *
 * ```ts
 * import { createCachePlugin, createMemoryCacheStore, parseCacheSpec } from '@orbit/cache';
 *
 * const cache = createCachePlugin({ store: createMemoryCacheStore() });
 * ```
 *
 * ```ts
 * import { createKvCachePlugin } from '@orbit/cache';
 * import { createRedisStore } from '@orbit/redis';
 *
 * const kvCache = createKvCachePlugin({ store: createRedisStore() });
 * ```
 *
 * The `CacheStore` contract this package (and the core) implements:
 * `get`, `set`, `delete`, `clear` — plus the optional `keys()` that powers
 * prefix invalidation. Keys are opaque `orbit:<hash>` strings (`fnv1a64`).
 */
export { createCachePlugin, createMemoryCacheStore, parseCacheSpec } from '@orbit/core';
export type {
  CachePlugin,
  CachePluginOptions,
  CacheSpec,
  CacheStore,
  CacheEntry,
  MemoryCacheStoreOptions,
} from '@orbit/core';

/** KV-cache plugin for external key-value stores (Redis, Cloudflare KV, Memcached, …). */
export { createKvCachePlugin } from './kvCachePlugin.js';
export type {
  KvCachePluginOptions,
  CacheSpec as KvCacheCacheSpec,
  CacheEntry as KvCacheCacheEntry,
  CacheStore as KvCacheCacheStore,
} from './kvCachePlugin.js';
