/**
 * The in-memory query cache: TTL + stale-while-revalidate entries, a per-key
 * version counter (the hook re-render signal), one subscribe channel, an LRU
 * cap and serializable snapshots for `dehydrate`/`hydrate`.
 *
 * Transport-free by design — this module never touches the network; the react
 * client decides WHEN to fetch and hands the results in.
 */
import type { OrbitError } from '@orbit/client';
import type { CacheEntry, DehydratedCache, KeyActivity, KeyState, QueryKey } from './types.js';

export interface QueryCacheOptions {
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;

/** Every per-key state in the cache (used by the devtools). */
export interface CacheSlot<T = unknown> {
  cacheKey: string;
  state: KeyState<T>;
}

export class QueryCache {
  readonly #states = new Map<string, KeyState>();
  readonly #listeners = new Set<() => void>();
  #maxEntries: number;

  constructor(options: QueryCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Derive the cache key from the user key AND the query string. */
  static keyOf(key: QueryKey, query: string): string {
    return `${JSON.stringify(key)}\u0000${query}`;
  }

  /** Get or lazily create the state for a cache key. */
  stateOf(cacheKey: string): KeyState {
    let state = this.#states.get(cacheKey);
    if (state === undefined) {
      state = {
        key: undefined,
        query: undefined,
        entry: undefined,
        error: undefined,
        activity: 'idle',
        version: 0,
      };
      this.#states.set(cacheKey, state);
    }
    return state;
  }

  /** Stamp key/query metadata on a state (devtools display; no version bump). */
  describe(cacheKey: string, key: QueryKey, query: string): void {
    const state = this.stateOf(cacheKey);
    state.key = key;
    state.query = query;
  }

  /** The current version of a cache key — 0 when the key was never touched. */
  getVersion(cacheKey: string): number {
    return this.#states.get(cacheKey)?.version ?? 0;
  }

  /** Every slot with a cached entry (drives invalidation, dehydrate, stats). */
  entries(): CacheSlot[] {
    const out: CacheSlot[] = [];
    for (const [cacheKey, state] of this.#states) {
      if (state.entry !== undefined) out.push({ cacheKey, state });
    }
    return out;
  }

  /** Every slot, including error-only and metadata-only ones (devtools). */
  allStates(): CacheSlot[] {
    const out: CacheSlot[] = [];
    for (const [cacheKey, state] of this.#states) out.push({ cacheKey, state });
    return out;
  }

  /** Store a successful entry — clears any error and the fetching activity. */
  set(cacheKey: string, entry: CacheEntry): void {
    const state = this.stateOf(cacheKey);
    state.entry = entry;
    state.error = undefined;
    state.activity = 'idle';
    this.#bump(state);
    this.#evict();
  }

  /** Record a fetch failure. The previous entry (if any) is left intact. */
  setError(cacheKey: string, error: OrbitError | Error): void {
    const state = this.stateOf(cacheKey);
    state.error = { error, at: Date.now() };
    state.activity = 'idle';
    this.#bump(state);
  }

  /** Change what the cache is doing for a key (fetching/streaming/…). */
  setActivity(cacheKey: string, activity: KeyActivity): void {
    const state = this.stateOf(cacheKey);
    if (state.activity === activity) return;
    state.activity = activity;
    this.#bump(state);
  }

  /** Remove a key entirely. */
  remove(cacheKey: string): void {
    if (!this.#states.has(cacheKey)) return;
    this.#states.delete(cacheKey);
    this.#emit();
  }

  /** Evict every key. */
  clear(): void {
    if (this.#states.size === 0) return;
    this.#states.clear();
    this.#emit();
  }

  /** Notify listeners without touching any key (devtools metadata). */
  touch(): void {
    this.#emit();
  }

  /** Subscribe to every cache change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A serializable snapshot of every cached entry. */
  dehydrate(): DehydratedCache {
    return {
      v: 1,
      entries: this.entries().map(({ state }) => {
        const entry = state.entry;
        /* v8 ignore next 1 — entries() only returns slots with an entry. */
        if (entry === undefined)
          return {
            key: '',
            query: '',
            data: undefined,
            createdAt: 0,
            expiresAt: 0,
            staleAt: 0,
            fromCache: false,
            entities: [],
          };
        return {
          key: entry.key,
          query: entry.query,
          data: entry.data,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          staleAt: entry.staleAt,
          fromCache: entry.fromCache,
          entities: entry.entities,
        };
      }),
    };
  }

  /** Restore a dehydrated snapshot; malformed entries are skipped. */
  hydrate(snapshot: DehydratedCache): void {
    if (snapshot.v !== 1 || !Array.isArray(snapshot.entries)) return;
    for (const raw of snapshot.entries) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Partial<DehydratedCache['entries'][number]>;
      if (
        typeof entry.query !== 'string' ||
        typeof entry.createdAt !== 'number' ||
        typeof entry.expiresAt !== 'number' ||
        typeof entry.staleAt !== 'number'
      ) {
        continue;
      }
      const cacheKey = QueryCache.keyOf(entry.key ?? [], entry.query);
      const state = this.stateOf(cacheKey);
      state.entry = {
        key: entry.key ?? [],
        query: entry.query,
        data: entry.data,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        staleAt: entry.staleAt,
        fromCache: entry.fromCache === true,
        entities: Array.isArray(entry.entities) ? entry.entities : [],
      };
      state.error = undefined;
      state.activity = 'idle';
      state.version += 1;
    }
    this.#emit();
  }

  #bump(state: KeyState): void {
    state.version += 1;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  /** LRU-ish eviction: drop the entry with the oldest `createdAt`. */
  #evict(): void {
    if (this.#states.size <= this.#maxEntries) return;
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [cacheKey, state] of this.#states) {
      const entry = state.entry;
      if (entry !== undefined && entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt;
        oldestKey = cacheKey;
      }
    }
    /* v8 ignore next 2 — with an entry stored there is always an oldest. */
    if (oldestKey === undefined) return;
    this.remove(oldestKey);
  }
}
