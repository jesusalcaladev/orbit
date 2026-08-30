/**
 * The devtools store — platform-agnostic (pure JS, zero UI). It observes the
 * react client's cache and turns it into a stable snapshot for
 * `useSyncExternalStore`, so the SAME store drives the web panel and a React
 * Native panel.
 */
import type { OrbitError } from '@orbit/client';
import type { OrbitReactClient } from '../client.js';
import type { ActivityEvent, QueryKey } from '../types.js';

export interface DevtoolsQueryRow {
  cacheKey: string;
  key: QueryKey;
  query: string;
  status: 'fresh' | 'stale' | 'loading' | 'error';
  /** The full cached data — for the expandable inspector. */
  data: unknown;
  dataPreview: string;
  hasData: boolean;
  errorMessage: string | undefined;
  errorCode: string | undefined;
  fromCache: boolean;
  ttlLeftMs: number;
  staleLeftMs: number;
  fetchedAt: number;
  /** When the current entry expires (0 for error-only rows). */
  expiresAt: number;
  /** When the current entry stops being stale-refreshable (0 for error-only rows). */
  staleAt: number;
  /** Entity names the query touches — the protocol eviction scope. */
  entities: string[];
}

export interface DevtoolsSubscriptionRow {
  key: QueryKey;
  query: string;
  seq: number;
  status: string;
}

export interface DevtoolsStats {
  entries: number;
  hits: number;
  misses: number;
  events: number;
  /** Average latency of successful queries, from the activity feed. */
  avgQueryMs: number | undefined;
}

export interface DevtoolsSnapshot {
  queries: DevtoolsQueryRow[];
  subscriptions: DevtoolsSubscriptionRow[];
  events: ActivityEvent[];
  stats: DevtoolsStats;
}

const PREVIEW_LENGTH = 160;

function preview(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, PREVIEW_LENGTH);
  } catch {
    return String(data);
  }
}

export class DevtoolsStore {
  readonly #client: OrbitReactClient;
  readonly #listeners = new Set<() => void>();
  #snapshot: DevtoolsSnapshot;

  constructor(client: OrbitReactClient) {
    this.#client = client;
    this.#snapshot = this.#build();
    this.#client.subscribeCache(() => {
      this.#snapshot = this.#build();
      for (const listener of this.#listeners) listener();
    });
  }

  /** `useSyncExternalStore` subscription — stable snapshot references. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The current snapshot (a stable reference until the next cache change). */
  getSnapshot(): DevtoolsSnapshot {
    return this.#snapshot;
  }

  /** Refetch a query through the cache, bypassing freshness. */
  refetch(key: QueryKey, query: string): void {
    void this.#client.ensureQuery(key, query, { refresh: true });
  }

  /** Evict a key from the cache. */
  invalidate(key: QueryKey): void {
    this.#client.invalidate(key);
  }

  /** Evict everything. */
  clear(): void {
    this.#client.clear();
  }

  /** Clear the activity feed (the cache is untouched). */
  clearEvents(): void {
    this.#client.clearEvents();
  }

  /** Release the store's listeners (called on panel unmount). */
  close(): void {
    this.#listeners.clear();
  }

  #build(): DevtoolsSnapshot {
    const now = Date.now();
    const queries: DevtoolsQueryRow[] = [];
    for (const { cacheKey, state } of this.#client.cache.allStates()) {
      const entry = state.entry;
      const key = state.key;
      const query = state.query;
      if (key === undefined || query === undefined) continue;
      if (state.error !== undefined && entry === undefined) {
        queries.push({
          cacheKey,
          key,
          query,
          status: 'error',
          data: undefined,
          dataPreview: '',
          hasData: false,
          errorMessage: state.error.error.message,
          errorCode: errorCodeOf(state.error.error),
          fromCache: false,
          ttlLeftMs: 0,
          staleLeftMs: 0,
          fetchedAt: state.error.at,
          expiresAt: 0,
          staleAt: 0,
          entities: [],
        });
        continue;
      }
      if (entry === undefined) {
        // An in-flight fetch with no data yet is still worth showing.
        if (state.activity === 'fetching') {
          queries.push({
            cacheKey,
            key,
            query,
            status: 'loading',
            data: undefined,
            dataPreview: '',
            hasData: false,
            errorMessage: undefined,
            errorCode: undefined,
            fromCache: false,
            ttlLeftMs: 0,
            staleLeftMs: 0,
            fetchedAt: Date.now(),
            expiresAt: 0,
            staleAt: 0,
            entities: [],
          });
        }
        continue;
      }
      queries.push({
        cacheKey,
        key,
        query,
        status:
          state.activity === 'fetching' ? 'loading' : now < entry.expiresAt ? 'fresh' : 'stale',
        data: entry.data,
        dataPreview: preview(entry.data),
        hasData: true,
        errorMessage: undefined,
        errorCode: undefined,
        fromCache: entry.fromCache,
        ttlLeftMs: Math.max(0, entry.expiresAt - now),
        staleLeftMs: Math.max(0, entry.staleAt - now),
        fetchedAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        staleAt: entry.staleAt,
        entities: entry.entities,
      });
    }
    const events = [...this.#client.getEvents()].reverse();
    return {
      queries,
      subscriptions: [...this.#client.getSubscriptions()],
      events,
      stats: {
        ...this.#client.getStats(),
        avgQueryMs: averageQueryMs(events),
      },
    };
  }
}

/** The `OrbitError.code` when the row's error is a protocol error. */
function errorCodeOf(error: OrbitError | Error): string | undefined {
  return typeof (error as OrbitError).code === 'string'
    ? ((error as OrbitError).code as string)
    : undefined;
}

/** Average latency of successful queries in the feed, or `undefined` when none. */
function averageQueryMs(events: readonly ActivityEvent[]): number | undefined {
  let total = 0;
  let count = 0;
  for (const event of events) {
    if (event.type !== 'query' || event.ok !== true || event.ms === undefined) continue;
    total += event.ms;
    count += 1;
  }
  if (count === 0) return undefined;
  return Math.round(total / count);
}
