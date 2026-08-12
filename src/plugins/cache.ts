import { ErrorCode, OrbitError } from '../errors.js';
import type { OrbitContext, OrbitEngineLike, QueryNode } from '../types.js';
import { fnv1a, isRecord } from '../utils.js';
import type { OrbitPlugin } from './types.js';

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

/**
 * The storage contract for the cache plugin. Implement this to plug in Redis,
 * Memcached, Cloudflare KV, or anything else — the plugin stays identical.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  /** Optional enumeration — powers prefix invalidation. */
  keys?(): IterableIterator<string>;
}

export interface MemoryCacheStoreOptions {
  /** Cap on entries; the oldest entries are evicted beyond it. Default 10 000. */
  maxEntries?: number;
}

/**
 * Simple in-memory cache store with insertion-order eviction.
 * Perfect for demos, tests and single-instance deployments.
 */
export function createMemoryCacheStore(options: MemoryCacheStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? 10_000;
  const entries = new Map<string, CacheEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.delete(key); // refresh insertion order
      entries.set(key, entry);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    delete: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    keys: () => entries.keys(),
  };
}

/**
 * Parse a cache spec string into a `CacheSpec`.
 *
 * Supported shapes:
 * - `"ttl=300"` — hard freshness of 300 s (refetch past that)
 * - `"stale=60"` — always serve, background refresh past 60 s
 * - `"ttl=300,stale=60"` — fresh for 300 s, then serve+refresh until 360 s
 * - `'{"ttl": 300, "stale": 60}'` — JSON object
 *
 * Throws `ORBIT_INVALID_QUERY` on malformed specs.
 */
export function parseCacheSpec(raw: string): CacheSpec {
  const input = raw.trim();
  if (input === '') return {};

  const fail = () =>
    new OrbitError(ErrorCode.INVALID_QUERY, `Invalid cache spec '${raw}'`, { details: { cache: raw } });

  if (input.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw fail();
    }
    if (!isRecord(parsed)) throw fail();
    const spec: CacheSpec = {};
    for (const key of ['ttl', 'stale'] as const) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw fail();
      spec[key] = value;
    }
    return spec;
  }

  const spec: CacheSpec = {};
  for (const part of input.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw fail();
    const key = part.slice(0, eq).trim();
    if (key !== 'ttl' && key !== 'stale') throw fail();
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value <= 0) throw fail();
    spec[key] = value;
  }
  return spec;
}

/** Deterministic, structural key for a query tree (stable across runs). */
function treeKey(node: QueryNode): string {
  const relations: Record<string, string> = {};
  for (const [name, child] of Object.entries(node.relations)) {
    relations[name] = treeKey(child);
  }
  return JSON.stringify({ e: node.entity, f: node.filters, s: node.fields, r: relations });
}

function cacheKeyFor(node: QueryNode): string {
  return `orbit:${fnv1a(treeKey(node))}`;
}

export interface CachePluginOptions {
  /** Cache store. Defaults to an in-memory store. */
  store?: CacheStore;
  /** Header carrying the cache spec. Default `x-orbit-cache`. */
  headerName?: string;
  /** Default TTL (s) when a spec has neither `ttl` nor `stale`. Default 300. */
  defaultTtl?: number;
}

/** The cache plugin, with an imperative invalidation surface. */
export interface CachePlugin extends OrbitPlugin {
  readonly store: CacheStore;
  /** Invalidate one cache key (e.g. one returned in `invalidates`). */
  invalidate(key: string): void;
  /** Invalidate every key starting with a prefix. */
  invalidatePrefix(prefix: string): void;
  /** Clear the whole store. */
  clear(): void;
  /** Compute the cache key for a parsed query node. */
  keyFor(node: QueryNode): string;
}

const DEFAULT_HEADER = 'x-orbit-cache';
const SPEC_KEY = 'orbit:cache:spec';
const MISS_KEY = 'orbit:cache:miss';
const SKIP_KEY = 'orbit:cache:skip';

/**
 * Client-defined, server-supported caching.
 *
 * Reads the cache spec from the envelope's `cache` field or the
 * `x-orbit-cache` header, then:
 * - serves a fresh hit directly (short-circuit),
 * - serves a stale hit and revalidates in the background (stale-while-revalidate),
 * - stores the result of every fresh resolve for the next request.
 */
export function createCachePlugin(options: CachePluginOptions = {}): CachePlugin {
  const store = options.store ?? createMemoryCacheStore();
  const headerName = options.headerName ?? DEFAULT_HEADER;
  const defaultTtl = options.defaultTtl ?? 300;
  const revalidating = new Set<string>();

  const readSpec = (ctx: OrbitContext): CacheSpec => {
    const raw = ctx.envelope?.cache ?? ctx.headers?.get(headerName);
    if (!raw) return {};
    const spec = parseCacheSpec(raw);
    if (spec.ttl === undefined && spec.stale === undefined) spec.ttl = defaultTtl;
    return spec;
  };

  const plugin: CachePlugin = {
    name: 'orbit-cache',
    store,
    invalidate: (key) => {
      store.delete(key);
    },
    invalidatePrefix: (prefix) => {
      if (!store.keys) return;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
    clear: () => {
      store.clear();
    },
    keyFor: (node) => cacheKeyFor(node),

    hooks: {
      async onAfterParse({ ctx }) {
        if (ctx.state?.[SKIP_KEY]) return;
        const spec = readSpec(ctx);
        if (spec.ttl === undefined && spec.stale === undefined) return;
        const state = (ctx.state ??= {});
        state[SPEC_KEY] = spec;
      },

      async onBeforeResolve({ parsed, ctx }) {
        if (ctx.state?.[SKIP_KEY]) return;
        const spec = (ctx.state?.[SPEC_KEY] ?? {}) as CacheSpec;
        if (spec.ttl === undefined && spec.stale === undefined) return;

        const key = cacheKeyFor(parsed);
        const entry = store.get(key);
        if (!entry) {
          // Cache miss: remember to store the fresh value after resolution.
          const state = (ctx.state ??= {});
          state[MISS_KEY] = { key, query: ctx.rawQuery ?? '' };
          return;
        }

        const age = (Date.now() - entry.createdAt) / 1000;

        // Model: `ttl` is hard freshness; `stale` extends it as an SWR window
        // during which we keep serving while revalidating in the background.
        //   ttl=300            → fresh < 300 s, refetch ≥ 300 s
        //   stale=60           → always serve, background refresh past 60 s
        //   ttl=300,stale=60   → fresh < 300 s, serve+refresh 300–360 s, refetch ≥ 360 s
        const hardExpired = spec.ttl !== undefined && age >= spec.ttl + (spec.stale ?? 0);
        if (hardExpired) {
          store.delete(key); // fall through to a fresh resolve
          return;
        }

        const needsRevalidate =
          spec.ttl !== undefined
            ? age >= spec.ttl && age < spec.ttl + (spec.stale ?? 0)
            : spec.stale !== undefined && age >= spec.stale;
        if (needsRevalidate && !revalidating.has(key)) {
          revalidating.add(key);
          const engine = ctx.orbit as OrbitEngineLike | undefined;
          if (engine) void revalidate(engine, ctx, key, entry.query);
          else revalidating.delete(key);
        }
        return { shortCircuit: entry.value };
      },

      async onBeforeSerialize({ data, ctx }) {
        if (ctx.state?.[SKIP_KEY]) return;
        const miss = ctx.state?.[MISS_KEY] as { key: string; query: string } | undefined;
        if (!miss) return;
        store.set(miss.key, { value: data, createdAt: Date.now(), query: miss.query });
        delete ctx.state![MISS_KEY];
      },
    },
  };

  async function revalidate(
    engine: OrbitEngineLike,
    ctx: OrbitContext,
    key: string,
    query: string,
  ): Promise<void> {
    try {
      // Skip the cache entirely so revalidation always re-resolves from the
      // source, then store the fresh value ourselves.
      const result = await engine.execute(
        { query },
        {
          ...ctx,
          envelope: undefined,
          state: { ...ctx.state, [SPEC_KEY]: undefined, [SKIP_KEY]: true },
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
