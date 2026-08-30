/**
 * @orbit/kv-cache — KV-cache plugin for @orbit/core.
 *
 * This plugin provides the exact same caching behavior as the built-in
 * `createCachePlugin()`, but its `CacheStore` backend is designed for
 * external key-value stores (Redis, Cloudflare KV, Memcached, etc.).
 * The plugin logic, hook order, and state management are identical to
 * the core cache plugin — only the store implementation differs.
 *
 * ```ts
 * import { createKvCachePlugin } from '@orbit/cache';
 * import { createRedisStore } from '@orbit/redis';
 *
 * const kvCache = createKvCachePlugin({ store: createRedisStore() });
 * ```
 *
 * The `CacheStore` contract (defined in `@orbit/core`) implements
 * `get`, `set`, `delete`, `clear` — plus optional `keys()` for prefix
 * invalidation. Keys are opaque `orbit:<hash>` strings (`fnv1a64`).
 */
import { fnv1a64 } from '@orbit/core';
import { parseCacheSpec } from '@orbit/core';
import type { OrbitPlugin, OrbitContext, QueryNode } from '@orbit/core';

/** Parsed cache spec: seconds of hard freshness (`ttl`) and/or SWR window (`stale`). */
export interface CacheSpec {
  ttl?: number;
  stale?: number;
}

/** A stored cache entry. */
export interface CacheEntry {
  value: unknown;
  /** Epoch ms at which the value was stored. */
  createdAt: number;
  /** The raw query (post `onBeforeParse`) used to revalidate in the background. */
  query: string;
}

/** The storage contract for the KV-cache plugin. */
export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  /** Optional enumeration — powers prefix invalidation. */
  keys?(): IterableIterator<string>;
}

/** Options for the KV-cache plugin. */
export interface KvCachePluginOptions {
  /** Cache store. Required — must implement the `CacheStore` interface. */
  store: CacheStore;
  /** Header carrying the cache spec. Default `x-orbit-cache`. */
  headerName?: string;
  /** Default TTL (s) when a spec has neither `ttl` nor `stale`. Default 300. */
  defaultTtl?: number;
}

/**
 * Creates a KV-cache plugin for Orbit.
 *
 * The plugin follows Orbit's exact caching pipeline:
 *   `onAfterParse` → reads cache spec from envelope or header
 *   `onBeforeResolve` → serves cache hit (`{ shortCircuit: value }`) or miss
 *   `onBeforeSerialize` → stores fresh resolves for next request
 *
 * The cache store backend (Redis, Cloudflare KV, Memcached, etc.) is
 * plugged in via the `store` option. The plugin logic, hook signatures,
 * and state management are identical to the built-in `createCachePlugin()`.
 *
 * ```ts
 * import { createKvCachePlugin } from '@orbit/cache';
 * import { createCloudflareKvStore } from '@orbit/cloudflare-kv';
 *
 * const kvCache = createKvCachePlugin({
 *   store: createCloudflareKvStore({ kv }),
 *   headerName: 'x-orbit-cache',
 *   defaultTtl: 300,
 * });
 * ```
 */
export function createKvCachePlugin(options: KvCachePluginOptions): OrbitPlugin {
  const store = options.store;
  const headerName = options.headerName ?? 'x-orbit-cache';
  const defaultTtl = options.defaultTtl ?? 300;

  const revalidating = new Set<string>();
  // Entity → cache keys index, mirror of the store. Every entry is tagged
  // with the entities its query tree reads; `invalidateEntity` walks this
  // index so a mutation evicts exactly the queries that touch its entity.
  const entityIndex = new Map<string, Set<string>>();

  /** Parse cache spec from envelope or header. */
  const readSpec = (ctx: OrbitContext): CacheSpec => {
    const raw = ctx.envelope?.cache ?? ctx.headers?.get(headerName);
    if (!raw) return {};
    const spec = parseCacheSpec(raw);
    if (spec.ttl === undefined && spec.stale === undefined) spec.ttl = defaultTtl;
    return spec;
  };

  /** Deterministic, structural key for a query tree (stable across runs). */
  const treeKey = (node: QueryNode): string => {
    const relations: Record<string, string> = {};
    for (const [name, child] of Object.entries(node.relations)) {
      relations[name] = treeKey(child);
    }
    return JSON.stringify({ e: node.entity, f: node.filters, s: node.fields, r: relations });
  };

  /** Deterministic cache key for a query tree. */
  const cacheKeyFor = (node: QueryNode): string => `orbit:${fnv1a64(treeKey(node))}`;

  /** Collect every entity a query tree reads (root + relations, deduped). */
  const collectEntities = (node: QueryNode): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (n: QueryNode) => {
      if (!seen.has(n.entity)) {
        seen.add(n.entity);
        out.push(n.entity);
      }
      for (const child of Object.values(n.relations)) walk(child);
    };
    walk(node);
    return out;
  };

  /** Index a cache key by the entities its query reads. */
  const indexKey = (key: string, node: QueryNode) => {
    for (const entity of collectEntities(node)) {
      let keys = entityIndex.get(entity);
      if (!keys) {
        keys = new Set();
        entityIndex.set(entity, keys);
      }
      keys.add(key);
    }
  };

  /** Unindex a cache key from the entity index. */
  const unindexKey = (key: string) => {
    for (const keys of entityIndex.values()) keys.delete(key);
    const empty: string[] = [];
    for (const [entity, keys] of entityIndex) if (keys.size === 0) empty.push(entity);
    for (const entity of empty) entityIndex.delete(entity);
  };

  const plugin: OrbitPlugin = {
    name: 'orbit-kv-cache',

    invalidate: (key: string) => {
      store.delete(key);
      unindexKey(key);
    },

    invalidatePrefix: (prefix: string) => {
      if (!store.keys) return;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          unindexKey(key);
        }
      }
    },

    invalidateEntity: (entity: string) => {
      const keys = entityIndex.get(entity);
      if (!keys) return;
      for (const key of [...keys]) store.delete(key);
      entityIndex.delete(entity);
    },

    clear: () => {
      store.clear();
      entityIndex.clear();
    },

    keyFor: (node: QueryNode) => cacheKeyFor(node),

    hooks: {
      async onAfterParse({ ctx }: { ctx: OrbitContext }) {
        if (ctx.state?.['orbit:kv:skip']) return;
        const spec = readSpec(ctx);
        if (spec.ttl === undefined && spec.stale === undefined) return;
        const state = (ctx.state ??= {});
        state['orbit:kv:spec'] = spec;
      },

      async onBeforeResolve({ parsed, ctx }: { parsed: QueryNode; ctx: OrbitContext }) {
        if (ctx.state?.['orbit:kv:skip']) return;
        const spec = (ctx.state?.['orbit:kv:spec'] ?? {}) as CacheSpec;
        if (spec.ttl === undefined && spec.stale === undefined) return;

        const key = cacheKeyFor(parsed);
        const entry = store.get(key);
        if (!entry) {
          // Cache miss: remember to store the fresh value after resolution.
          const state = (ctx.state ??= {});
          state['orbit:kv:miss'] = { key, query: ctx.rawQuery ?? '' };
          return;
        }

        const age = (Date.now() - entry.createdAt) / 1000;

        const hardExpired = spec.ttl !== undefined && age >= spec.ttl + (spec.stale ?? 0);
        if (hardExpired) {
          store.delete(key);
          return;
        }

        const needsRevalidate =
          spec.ttl !== undefined
            ? age >= spec.ttl && age < spec.ttl + (spec.stale ?? 0)
            : spec.stale !== undefined && age >= spec.stale;
        if (needsRevalidate && !revalidating.has(key)) {
          revalidating.add(key);
          const engine = ctx.orbit as import('@orbit/core').OrbitEngineLike | undefined;
          if (engine) void revalidate(engine, ctx, key, entry.query);
          else revalidating.delete(key);
        }
        return { shortCircuit: entry.value };
      },

      async onBeforeSerialize({
        data,
        node,
        ctx,
      }: {
        data: unknown;
        node: QueryNode;
        ctx: OrbitContext;
      }) {
        if (ctx.state?.['orbit:kv:skip']) return;
        const miss = ctx.state?.['orbit:kv:miss'] as { key: string; query: string } | undefined;
        if (!miss) return;
        store.set(miss.key, { value: data, createdAt: Date.now(), query: miss.query });
        indexKey(miss.key, node);
        delete ctx.state!['orbit:kv:miss'];
      },
    },
  } as OrbitPlugin;

  /** Internal: revalidate a cache entry in the background. */
  async function revalidate(
    engine: import('@orbit/core').OrbitEngineLike,
    ctx: OrbitContext,
    key: string,
    query: string,
  ): Promise<void> {
    try {
      const result = await engine.execute(
        { query },
        {
          ...ctx,
          envelope: undefined,
          /* biome-ignore lint/complexity/useLiteralKeys: keys contain ':' so dot notation is impossible. */
          state: { ...ctx.state, ['orbit:kv:spec']: undefined, ['orbit:kv:skip']: true },
        },
      );
      if (result.body === undefined) {
        store.set(key, { value: result.data, createdAt: Date.now(), query });
      }
    } catch {
      // Keep the stale value on failure — SWR tolerates upstream hiccups.
    } finally {
      revalidating.delete(key);
    }
  }

  return plugin;
}
