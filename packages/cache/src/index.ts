/**
 * @orbit/cache — the official distribution home of client-defined server-side
 * caching for @orbit/core.
 *
 * The cache plugin itself ships inside the frozen `@orbit/core` contract (its
 * import surface is pinned by `api-surface.test.ts`); this package is the
 * stable, dedicated import path for it — and the home of the `CacheStore`
 * backends that live outside the core: Redis, Cloudflare KV, Memcached, …
 *
 * ```ts
 * import { createCachePlugin, createMemoryCacheStore } from '@orbit/cache';
 *
 * const cache = createCachePlugin({ store: createMemoryCacheStore() });
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
