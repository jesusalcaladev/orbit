import { ErrorCode, OrbitError } from '../errors.js';
import type { OrbitContext, OrbitEngineLike, QueryNode } from '../types.js';
import { fnv1a64, isRecord } from '../utils.js';
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
 *
 * Every method may be synchronous (the in-memory store) **or** asynchronous
 * (Redis, KV — network-backed stores cannot answer synchronously). The plugin
 * `await`s each call, so both shapes work; `keys()` may be a sync or async
 * iterable and is what powers prefix invalidation.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /** Optional enumeration — powers prefix invalidation. */
  keys?(): IterableIterator<string> | AsyncIterableIterator<string>;
}

export interface MemoryCacheStoreOptions {
  /** Cap on entries; the oldest entries are evicted beyond it. Default 10 000. */
  maxEntries?: number;
}

/** The in-memory store's precise, synchronous shape (a `CacheStore` subtype). */
interface MemoryCacheStore extends CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  keys(): IterableIterator<string>;
}

/**
 * Simple in-memory cache store with insertion-order eviction.
 * Perfect for demos, tests and single-instance deployments.
 */
export function createMemoryCacheStore(options: MemoryCacheStoreOptions = {}): MemoryCacheStore {
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
 * Supported shapes (pairs are comma- **or** space-separated, per spec §8):
 * - `"ttl=300"` — hard freshness of 300 s (refetch past that)
 * - `"stale=60"` — always serve, background refresh past 60 s
 * - `"ttl=300,stale=60"` / `"ttl=300 stale=60"` — fresh for 300 s, then
 *   serve+refresh until 360 s
 * - `'{"ttl": 300, "stale": 60}'` — JSON object
 *
 * Throws `ORBIT_INVALID_QUERY` on malformed specs.
 */
export function parseCacheSpec(raw: string): CacheSpec {
  const input = raw.trim();
  if (input === '') return {};

  const fail = () =>
    new OrbitError(ErrorCode.INVALID_QUERY, `Invalid cache spec '${raw}'`, {
      details: { cache: raw },
    });

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

  // A trailing separator is an empty pair (`ttl=1,`) — malformed, reject it
  // rather than silently dropping it (a trailing comma is still an error even
  // though commas are now one of the accepted separators).
  if (/[\s,]$/.test(input)) throw fail();

  const spec: CacheSpec = {};
  // Comma- AND space-separated: the spec (§8) says "space-separated" while
  // the historical examples use commas — accept both so a client following
  // either spelling works. `"ttl=300 stale=60"` used to fail with
  // ORBIT_INVALID_QUERY (the single part `Number('300 stale=60')` is NaN).
  for (const part of input.split(/[\s,]+/).filter(Boolean)) {
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
  // 64-bit key: a 32-bit hash would collide at ~65k entries (feasible
  // intentional cache-poisoning), 64-bit raises the bound to ~4e9 (see utils).
  return `orbit:${fnv1a64(treeKey(node))}`;
}

/**
 * Every entity a query tree reads (root + relations, deduped). Powers
 * precise server-side eviction: a mutation on `user` evicts exactly the
 * cached queries that read `user` — anywhere in their tree.
 */
function collectEntities(node: QueryNode): string[] {
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
  invalidate(key: string): Promise<void>;
  /** Invalidate every key starting with a prefix. */
  invalidatePrefix(prefix: string): Promise<void>;
  /**
   * Evict every entry whose query reads this entity — root or relation
   * (precise server-side invalidation, spec §8). The engine calls this
   * automatically after every mutation on the mutated entity.
   */
  invalidateEntity(entity: string): Promise<void>;
  /** Clear the whole store. */
  clear(): Promise<void>;
  /** Compute the cache key for a parsed query node. */
  keyFor(node: QueryNode): string;
}

const DEFAULT_HEADER = 'x-orbit-cache';
const SPEC_KEY = 'orbit:cache:spec';
const MISS_KEY = 'orbit:cache:miss';
const SKIP_KEY = 'orbit:cache:skip';

/**
 * Attach the cache's HTTP observability/control headers (spec §7 response
 * headers channel, additive):
 *
 * - `x-orbit-cache: hit|miss` — which path served this request. Same name as
 *   the REQUEST header carrying the spec; the response value is a different
 *   vocabulary (`hit`/`miss`), so the two directions never collide.
 * - `cache-control` — a downstream-cache hint (CDN/proxy) mirroring the
 *   request's spec: `public, max-age=<remaining freshness>` on a fresh serve,
 *   and `max-age=0, stale-while-revalidate=<remaining window>` when serving
 *   stale. Age-aware so the hint never overstates how long the value stays
 *   fresh. Only set when the plugin actually handled the request (a spec was
 *   present); neither header is emitted otherwise, and neither clobbers a
 *   header another plugin set explicitly.
 */
function setCacheHeaders(
  ctx: OrbitContext,
  spec: CacheSpec,
  outcome: 'hit' | 'miss',
  age: number,
): void {
  const headers = (ctx.responseHeaders ??= {});
  if (headers['x-orbit-cache'] === undefined) headers['x-orbit-cache'] = outcome;
  if (headers['cache-control'] !== undefined) return;

  const { ttl, stale } = spec;
  // Defensive: the plugin only calls this when a spec (ttl and/or stale) is
  // present; with neither there is no freshness window to advertise.
  const freshFor = ttl ?? stale;
  if (freshFor === undefined) return;
  const parts = ['public'];
  if (outcome === 'miss') {
    // Freshly resolved: the response IS fresh for the full spec window.
    parts.push(`max-age=${freshFor}`);
    if (stale !== undefined) parts.push(`stale-while-revalidate=${stale}`);
  } else {
    const remainingFresh = Math.max(0, Math.ceil(freshFor - age));
    if (remainingFresh > 0) {
      parts.push(`max-age=${remainingFresh}`);
      if (stale !== undefined) parts.push(`stale-while-revalidate=${stale}`);
    } else {
      // Serving stale (SWR): the value is past its freshness — downstream
      // caches must revalidate immediately but may serve stale meanwhile.
      parts.push('max-age=0');
      // The SWR window ends at the hard expiry (ttl + stale); a stale-only
      // spec never hard-expires (Orbit keeps serving + refreshing forever),
      // so there is no bounded CDN stale window to advertise.
      const hardExpiry = ttl !== undefined ? ttl + (stale ?? 0) : undefined;
      if (hardExpiry !== undefined) {
        const remaining = Math.max(0, Math.ceil(hardExpiry - age));
        if (remaining > 0) parts.push(`stale-while-revalidate=${remaining}`);
      }
    }
  }
  headers['cache-control'] = parts.join(', ');
}

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
  // Entity → cache keys index, mirror of the store. Every entry is tagged
  // with the entities its query tree reads; `invalidateEntity` walks this
  // index so a mutation evicts exactly the queries that touch its entity.
  // Invariant: entries are indexed on store and unindexed on delete/clear.
  // A store that self-evicts by capacity (maxEntries) can drop a key the
  // index still knows — benign: `invalidateEntity` deletes already-gone
  // keys (no-ops) and then clears the whole entity bucket.
  const entityIndex = new Map<string, Set<string>>();

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

  const unindexKey = (key: string) => {
    for (const keys of entityIndex.values()) keys.delete(key);
    const empty: string[] = [];
    for (const [entity, keys] of entityIndex) if (keys.size === 0) empty.push(entity);
    for (const entity of empty) entityIndex.delete(entity);
  };

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
    invalidate: async (key) => {
      await store.delete(key);
      unindexKey(key);
    },
    invalidatePrefix: async (prefix) => {
      const keys = store.keys;
      if (!keys) return;
      // `for await` handles both a sync iterable (memory store) and an async
      // one (Redis SCAN / KV list).
      for await (const key of keys()) {
        // Store contract says keys are strings — a buggy/hostile store that
        // yields non-string keys (Buffers, numbers) must not crash the
        // mutation that triggered eviction.
        if (typeof key === 'string' && key.startsWith(prefix)) {
          await store.delete(key);
          unindexKey(key);
        }
      }
    },
    invalidateEntity: async (entity) => {
      const keys = entityIndex.get(entity);
      if (!keys) return;
      for (const key of [...keys]) await store.delete(key);
      entityIndex.delete(entity);
    },
    clear: async () => {
      await store.clear();
      entityIndex.clear();
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
        const entry = await store.get(key);
        if (!entry) {
          // Cache miss: remember to store the fresh value after resolution.
          const state = (ctx.state ??= {});
          state[MISS_KEY] = { key, query: ctx.rawQuery ?? '' };
          setCacheHeaders(ctx, spec, 'miss', 0);
          return;
        }

        const age = (Date.now() - entry.createdAt) / 1000;

        // Fail-safe: a corrupted entry (missing/non-finite `createdAt` from
        // a buggy store) must not be served as perpetually fresh — treat it
        // as expired and fall through to a fresh resolve.
        if (!Number.isFinite(age)) {
          await store.delete(key);
          return;
        }

        // Model: `ttl` is hard freshness; `stale` extends it as an SWR window
        // during which we keep serving while revalidating in the background.
        //   ttl=300            → fresh < 300 s, refetch ≥ 300 s
        //   stale=60           → always serve, background refresh past 60 s
        //   ttl=300,stale=60   → fresh < 300 s, serve+refresh 300–360 s, refetch ≥ 360 s
        const hardExpired = spec.ttl !== undefined && age >= spec.ttl + (spec.stale ?? 0);
        if (hardExpired) {
          await store.delete(key); // fall through to a fresh resolve
          return;
        }

        const needsRevalidate =
          spec.ttl !== undefined
            ? age >= spec.ttl && age < spec.ttl + (spec.stale ?? 0)
            : spec.stale !== undefined && age >= spec.stale;
        setCacheHeaders(ctx, spec, 'hit', age);
        if (needsRevalidate && !revalidating.has(key)) {
          revalidating.add(key);
          const engine = ctx.orbit as OrbitEngineLike | undefined;
          if (engine) void revalidate(engine, ctx, key, entry.query);
          else revalidating.delete(key);
        }
        return { shortCircuit: entry.value };
      },

      async onBeforeSerialize({ data, node, ctx }) {
        if (ctx.state?.[SKIP_KEY]) return;
        const miss = ctx.state?.[MISS_KEY] as { key: string; query: string } | undefined;
        if (!miss) return;
        await store.set(miss.key, { value: data, createdAt: Date.now(), query: miss.query });
        indexKey(miss.key, node);
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
        await store.set(key, { value: result.data, createdAt: Date.now(), query });
      }
    } catch {
      // Keep the stale value on failure — SWR tolerates upstream hiccups.
    } finally {
      revalidating.delete(key);
    }
  }

  return plugin;
}
