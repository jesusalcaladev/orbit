/**
 * `OrbitReactClient` — the cache-aware wrapper over the vanilla `OrbitClient`.
 *
 * **Zero transport by design**: every byte to the wire rides `client.transport`
 * (the `@orbit/client` instance). This class only decides WHEN to fetch, WHAT
 * to cache and WHAT to evict. The wire contract — envelope, negotiation, gzip,
 * errors, abort, SSE, WebSocket — stays entirely in `@orbit/client`.
 *
 * Cache semantics (per query key, derived from `[key, queryString]`):
 * - fresh (now < ttl): served from the client cache, no network;
 * - stale (now < ttl + stale): served immediately AND refreshed in the
 *   background (stale-while-revalidate);
 * - expired: fetched.
 *
 * Invalidation is protocol-driven: a mutation's `invalidates` (entity names,
 * spec §8) evicts every cached query whose OQS touches those entities, and
 * `client.invalidate(key | predicate)` covers the manual cases.
 */
import { OrbitClient } from '@orbit/client';
import type {
  OrbitError,
  OrbitResponse,
  OrbitStreamEvent,
  RequestOptions,
  SubscriptionEvent,
  SubscriptionHandle,
} from '@orbit/client';
import { parseOQS } from '@orbit/core';
import type { MutationArgs } from '@orbit/core';
import { QueryCache } from './cache.js';
import type {
  ActivityEvent,
  CacheEntry,
  CreateReactClientOptions,
  DehydratedCache,
  MutateOptions,
  OrbitReactClientOptions,
  QueryKey,
  QueryOptions,
  QueryState,
} from './types.js';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_STALE_MS = 60_000;
const MAX_EVENTS = 200;
const MAX_PARSE_DEPTH = 8;

/** Deep-equality for QueryKeys — both are `JSON.stringify`-stable by contract. */
function keyEqual(a: QueryKey, b: QueryKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every entity name a query touches (root + relations) — drives eviction. */
function extractEntities(query: string): string[] {
  try {
    const node = parseOQS(query, {
      maxDepth: MAX_PARSE_DEPTH,
      maxKeyLength: 128,
      maxValueLength: 1024,
    });
    const entities = new Set<string>();
    const walk = (n: { entity: string; relations: Record<string, unknown> }): void => {
      entities.add(n.entity);
      for (const relation of Object.values(n.relations)) {
        walk(relation as { entity: string; relations: Record<string, unknown> });
      }
    };
    walk(node);
    return [...entities];
  } catch {
    // A malformed query never reaches the wire (the client validates it
    // fail-fast) — but if it somehow does, eviction falls back to key-only.
    return [];
  }
}

function errorMessage(error: OrbitError | Error): string {
  return error instanceof Error ? error.message : String(error);
}

export class OrbitReactClient {
  /** The vanilla transport client — the ONLY network access in this package. */
  readonly transport: OrbitClient;
  /** The in-memory query cache. */
  readonly cache: QueryCache;

  readonly #defaultTtl: number;
  readonly #defaultStale: number;
  readonly #events: ActivityEvent[] = [];
  readonly #subscriptions = new Map<
    string,
    { key: QueryKey; query: string; seq: number; status: string }
  >();
  readonly #inflight = new Map<string, Promise<QueryState>>();
  /** How many mounted hooks are observing each cache key (drives F2 refetch-on-invalidate). */
  readonly #active = new Map<string, number>();
  #eventId = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: OrbitReactClientOptions) {
    this.transport = options.client;
    this.cache = new QueryCache({ maxEntries: options.maxEntries });
    this.#defaultTtl = options.defaultTtl ?? DEFAULT_TTL_MS;
    this.#defaultStale = options.defaultStale ?? DEFAULT_STALE_MS;
  }

  /** Derive the full cache key from a user key and a query string. */
  cacheKeyOf(key: QueryKey, query: string): string {
    return QueryCache.keyOf(key, query);
  }

  /** Subscribe to every cache change (hooks + devtools). */
  subscribeCache(listener: () => void): () => void {
    return this.cache.subscribe(listener);
  }

  /** The version of a cache key — changes whenever that key's state changes. */
  cacheVersion(cacheKey: string): number {
    return this.cache.getVersion(cacheKey);
  }

  /**
   * A synchronous snapshot of the cache for a query — no side effects.
   * Hooks call this every render; `ensureQuery` does the actual fetching.
   */
  readQuery<T = unknown>(key: QueryKey, query: string): QueryState<T> {
    const state = this.cache.stateOf(this.cacheKeyOf(key, query));
    const now = Date.now();
    const entry = state.entry;
    if (entry !== undefined && now < entry.expiresAt) {
      return {
        data: entry.data as T,
        error: undefined,
        status: 'success',
        isFetching: state.activity === 'fetching',
        isStale: false,
        fromCache: entry.fromCache,
        fetchedAt: entry.createdAt,
        isLoading: false,
      };
    }
    if (entry !== undefined) {
      const isStale = now < entry.staleAt;
      return {
        data: entry.data as T,
        error: undefined,
        status: 'success',
        isFetching: state.activity === 'fetching' || isStale,
        isStale,
        fromCache: entry.fromCache,
        fetchedAt: entry.createdAt,
        isLoading: false,
      };
    }
    const error = state.error?.error;
    return {
      data: undefined,
      error,
      status: error !== undefined ? 'error' : 'pending',
      isFetching: state.activity === 'fetching',
      isStale: false,
      fromCache: false,
      fetchedAt: undefined,
      isLoading: state.activity === 'fetching',
    };
  }

  /**
   * The fetch-or-cache decision: fresh → serve (hit); stale → serve + refresh
   * in the background (hit); missing → fetch (miss). Concurrent calls for the
   * same key share one in-flight promise.
   */
  async ensureQuery<T = unknown>(
    key: QueryKey,
    query: string,
    options: QueryOptions = {},
  ): Promise<QueryState<T>> {
    const cacheKey = this.cacheKeyOf(key, query);
    if (options.refresh !== true) {
      const now = Date.now();
      const state = this.cache.stateOf(cacheKey);
      const entry = state.entry;
      if (entry !== undefined && now < entry.expiresAt) {
        this.#hits += 1;
        return this.readQuery<T>(key, query);
      }
      if (entry !== undefined && now < entry.staleAt) {
        this.#hits += 1;
        void this.#fetch<T>(key, query, options);
        return this.readQuery<T>(key, query);
      }
    }
    this.#misses += 1;
    return this.#fetch<T>(key, query, options);
  }

  /**
   * Run a mutation through the transport, then apply protocol-driven
   * invalidation: the response's `invalidates` entities (spec §8) evict every
   * cached query touching them, and an explicit `invalidate` option covers
   * the manual cases.
   */
  async mutate(
    action: string,
    args: MutationArgs,
    options: MutateOptions = {},
  ): Promise<OrbitResponse> {
    const started = Date.now();
    const { invalidate, return: returnQuery, signal, timeoutMs, format, headers } = options;
    this.#log({ type: 'mutation', action, at: started });
    try {
      const res = await this.transport.mutate(action, args, {
        ...(returnQuery !== undefined ? { return: returnQuery } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(format !== undefined ? { format } : {}),
        ...(headers !== undefined ? { headers } : {}),
      });
      const ms = Date.now() - started;
      const entities = Array.isArray(res.invalidates) ? res.invalidates.map(String) : [];
      if (entities.length > 0) this.#invalidateByEntities(entities);
      const target =
        typeof invalidate === 'function' ? invalidate(res.data, undefined) : invalidate;
      if (target !== undefined) {
        this.invalidate(target);
        this.#log({ type: 'invalidate', key: target, at: Date.now(), detail: 'after mutation' });
      }
      this.#log({
        type: 'mutation',
        action,
        ok: true,
        ms,
        at: Date.now(),
        detail:
          entities.length > 0
            ? `${res.status} · invalidates: ${entities.join(', ')}`
            : `${res.status}`,
      });
      return res;
    } catch (error) {
      const err = error as OrbitError | Error;
      if (typeof invalidate === 'function') invalidate(undefined, err);
      this.#log({
        type: 'mutation',
        action,
        ok: false,
        ms: Date.now() - started,
        at: Date.now(),
        detail: errorMessage(err),
      });
      throw error;
    }
  }

  /** Fetch and cache a query in the background — no hook needed. */
  prefetch(key: QueryKey, query: string, options: QueryOptions = {}): Promise<QueryState> {
    return this.ensureQuery(key, query, options);
  }

  /**
   * Evict cached queries by exact key, or by a predicate over their entries.
   */
  invalidate(target: QueryKey | ((entry: CacheEntry) => boolean)): void {
    let removed = 0;
    const refetch: { key: QueryKey; query: string }[] = [];
    // allStates() so entry-less (error-only / describe-only) slots are skipped
    // explicitly — invalidating never touches keys with no cached data.
    for (const { cacheKey, state } of this.cache.allStates()) {
      const entry = state.entry;
      if (entry === undefined) continue;
      const match = typeof target === 'function' ? target(entry) : keyEqual(entry.key, target);
      if (match) {
        this.cache.remove(cacheKey);
        // F2: a query that is currently mounted and was just invalidated must
        // refetch — otherwise the UI would show pending/empty until a manual
        // `refetch()`. Collect it now; the refetch happens after the loop so the
        // in-flight dedupe (`#inflight`) can coalesce concurrent invalidations.
        if (this.isActive(cacheKey)) refetch.push({ key: entry.key, query: entry.query });
        removed += 1;
      }
    }
    if (removed > 0) {
      this.#log({
        type: 'invalidate',
        at: Date.now(),
        key: typeof target === 'function' ? undefined : target,
        detail: `${removed} entr${removed === 1 ? 'y' : 'ies'}`,
      });
      for (const { key, query } of refetch) void this.ensureQuery(key, query, { refresh: true });
    }
  }

  /** Overwrite the cached data for a key without a network round-trip. */
  setQueryData(key: QueryKey, data: unknown, options: QueryOptions = {}): void {
    const now = Date.now();
    const ttl = options.ttl ?? this.#defaultTtl;
    const stale = options.stale ?? this.#defaultStale;
    let updated = 0;
    for (const { cacheKey, state } of this.cache.entries()) {
      const entry = state.entry;
      if (entry === undefined || !keyEqual(entry.key, key)) continue;
      this.cache.set(cacheKey, {
        ...entry,
        data,
        createdAt: now,
        expiresAt: now + ttl,
        staleAt: now + ttl + stale,
      });
      updated += 1;
    }
    if (updated > 0) {
      this.#log({
        type: 'setData',
        key,
        at: now,
        detail: `${updated} entr${updated === 1 ? 'y' : 'ies'}`,
      });
    }
  }

  /** The cached data for a key (any freshness), or `undefined`. */
  getQueryData<T = unknown>(key: QueryKey): T | undefined {
    for (const { state } of this.cache.entries()) {
      const entry = state.entry;
      if (entry !== undefined && keyEqual(entry.key, key)) return entry.data as T;
    }
    return undefined;
  }

  /** Record a mounted observer for a cache key (hooks call this on mount). */
  markActive(cacheKey: string): void {
    this.#active.set(cacheKey, (this.#active.get(cacheKey) ?? 0) + 1);
  }

  /** Release an observer for a cache key (hooks call this on unmount). */
  unmarkActive(cacheKey: string): void {
    const next = (this.#active.get(cacheKey) ?? 0) - 1;
    if (next <= 0) this.#active.delete(cacheKey);
    else this.#active.set(cacheKey, next);
  }

  /** Is at least one mounted hook observing this cache key? */
  isActive(cacheKey: string): boolean {
    return (this.#active.get(cacheKey) ?? 0) > 0;
  }

  /**
   * Stage an optimistic cache write for a key: snapshot the existing entries,
   * write `data` via `setQueryData`, and return a `rollback()` that restores the
   * snapshot exactly (used by `useOrbitMutation` optimistic updates, spec F1).
   * On rollback, entries that existed before are restored with their original
   * TTL/SWR timestamps; a key that had no entry is removed.
   */
  optimisticWrite<T = unknown>(key: QueryKey, data: T, options: QueryOptions = {}): () => void {
    const snapshot: { cacheKey: string; entry?: CacheEntry }[] = [];
    for (const { cacheKey, state } of this.cache.allStates()) {
      if (state.entry !== undefined && keyEqual(state.entry.key, key)) {
        snapshot.push({ cacheKey, entry: state.entry });
      }
    }
    this.setQueryData(key, data, options);
    return () => {
      for (const { cacheKey, entry } of snapshot) {
        if (entry !== undefined) this.cache.set(cacheKey, entry);
        else this.cache.remove(cacheKey);
      }
    };
  }

  /** A serializable snapshot of the cache (SSR: server → client). */
  dehydrate(): DehydratedCache {
    return this.cache.dehydrate();
  }

  /** Restore a dehydrated snapshot (SSR: client-side hydration). */
  hydrate(snapshot: DehydratedCache): void {
    this.cache.hydrate(snapshot);
    this.#log({
      type: 'hydrate',
      at: Date.now(),
      detail: `${Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0} entries`,
    });
  }

  /** Evict every cached query. */
  clear(): void {
    this.cache.clear();
    this.#log({ type: 'clear', at: Date.now() });
  }

  // -------------------------------------------------------------------------
  // Realtime + streaming — passthrough to the vanilla transport
  // -------------------------------------------------------------------------

  subscribe(
    query: string,
    handler: (event: SubscriptionEvent, meta: { seq: number }) => void,
    options: import('@orbit/client').SubscribeOptions = {},
  ): SubscriptionHandle {
    return this.transport.subscribe(query, handler, options);
  }

  stream(query: string, options: RequestOptions = {}): AsyncIterable<OrbitStreamEvent> {
    return this.transport.stream(query, options);
  }

  socket() {
    return this.transport.socket();
  }

  /** Close the transport (subscriptions + socket) and drop the cache. */
  close(): void {
    this.transport.close();
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Devtools support
  // -------------------------------------------------------------------------

  /** Register a live subscription (hooks + devtools). */
  trackSubscription(key: QueryKey, query: string, seq: number, status: string): void {
    this.#subscriptions.set(this.cacheKeyOf(key, query), { key, query, seq, status });
    this.cache.touch();
  }

  /** Unregister a subscription (devtools). */
  untrackSubscription(key: QueryKey, query: string): void {
    if (this.#subscriptions.delete(this.cacheKeyOf(key, query))) this.cache.touch();
  }

  /** The currently tracked subscriptions (devtools). */
  getSubscriptions(): ReadonlyArray<{ key: QueryKey; query: string; seq: number; status: string }> {
    return [...this.#subscriptions.values()];
  }

  /** Append a devtools activity event. */
  logEvent(event: Omit<ActivityEvent, 'id' | 'at'> & { at?: number }): void {
    this.#log(event);
  }

  /** The activity feed (newest last). */
  getEvents(): readonly ActivityEvent[] {
    return this.#events;
  }

  /** Clear the activity feed (devtools). Keeps the cache untouched. */
  clearEvents(): void {
    if (this.#events.length === 0) return;
    this.#events.length = 0;
    this.cache.touch();
  }

  /** Cache statistics for the devtools header. */
  getStats(): { entries: number; hits: number; misses: number; events: number } {
    return {
      entries: this.cache.entries().length,
      hits: this.#hits,
      misses: this.#misses,
      events: this.#events.length,
    };
  }

  async #fetch<T>(key: QueryKey, query: string, options: QueryOptions): Promise<QueryState<T>> {
    const cacheKey = this.cacheKeyOf(key, query);
    const inflight = this.#inflight.get(cacheKey);
    if (inflight !== undefined) return inflight as Promise<QueryState<T>>;
    const promise = this.#doFetch<T>(key, query, options, cacheKey);
    this.#inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.#inflight.delete(cacheKey);
    }
  }

  async #doFetch<T>(
    key: QueryKey,
    query: string,
    options: QueryOptions,
    cacheKey: string,
  ): Promise<QueryState<T>> {
    const started = Date.now();
    this.cache.describe(cacheKey, key, query);
    this.cache.setActivity(cacheKey, 'fetching');
    this.#log({ type: 'query', key, query, at: started });
    try {
      const res = await this.transport.query(query, {
        ...(options.cache !== undefined ? { cache: options.cache } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.format !== undefined ? { format: options.format } : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      });
      const now = Date.now();
      const ttl = options.ttl ?? this.#defaultTtl;
      const stale = options.stale ?? this.#defaultStale;
      const entry: CacheEntry<T> = {
        key,
        query,
        data: res.data as T,
        createdAt: now,
        expiresAt: now + ttl,
        staleAt: now + ttl + stale,
        fromCache: res.fromCache === true,
        entities: extractEntities(query),
      };
      this.cache.set(cacheKey, entry);
      this.#log({
        type: 'query',
        key,
        query,
        ok: true,
        ms: Date.now() - started,
        at: Date.now(),
        detail: `${res.status}${res.fromCache === true ? ' · server-cached' : ''}`,
      });
      return this.readQuery<T>(key, query);
    } catch (error) {
      const err = error as OrbitError | Error;
      this.cache.setError(cacheKey, err);
      this.#log({
        type: 'query',
        key,
        query,
        ok: false,
        ms: Date.now() - started,
        at: Date.now(),
        detail: errorMessage(err),
      });
      return this.readQuery<T>(key, query);
    }
  }

  #invalidateByEntities(entities: string[]): void {
    let removed = 0;
    for (const { cacheKey, state } of this.cache.allStates()) {
      const entry = state.entry;
      if (entry === undefined) continue;
      if (entry.entities.some((entity) => entities.includes(entity))) {
        this.cache.remove(cacheKey);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.#log({
        type: 'invalidate',
        at: Date.now(),
        detail: `${removed} entr${removed === 1 ? 'y' : 'ies'} by entity ${entities.join(', ')}`,
      });
    }
  }

  #log(event: Omit<ActivityEvent, 'id' | 'at'> & { at?: number }): void {
    const entry: ActivityEvent = { ...event, id: ++this.#eventId, at: event.at ?? Date.now() };
    this.#events.push(entry);
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }
}

/** Create a react client, optionally building the vanilla transport itself. */
export function createReactClient(options: CreateReactClientOptions): OrbitReactClient {
  const { client, defaultTtl, defaultStale, maxEntries, ...transportOptions } = options;
  return new OrbitReactClient({
    client: client ?? new OrbitClient(transportOptions),
    ...(defaultTtl !== undefined ? { defaultTtl } : {}),
    ...(defaultStale !== undefined ? { defaultStale } : {}),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  });
}
