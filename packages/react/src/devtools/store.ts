/**
 * The devtools store — platform-agnostic (pure JS, zero UI). It observes the
 * react client's cache and turns it into a stable snapshot for
 * `useSyncExternalStore`, so the SAME store drives the web panel and a React
 * Native panel.
 */
import type { OrbitReactClient } from '../client.js';
import type { ActivityEvent, QueryKey } from '../types.js';

export interface DevtoolsQueryRow {
  cacheKey: string;
  key: QueryKey;
  query: string;
  status: 'fresh' | 'stale' | 'loading' | 'error';
  dataPreview: string;
  hasData: boolean;
  errorMessage: string | undefined;
  fromCache: boolean;
  ttlLeftMs: number;
  staleLeftMs: number;
  fetchedAt: number;
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
          dataPreview: '',
          hasData: false,
          errorMessage: state.error.error.message,
          fromCache: false,
          ttlLeftMs: 0,
          staleLeftMs: 0,
          fetchedAt: state.error.at,
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
            dataPreview: '',
            hasData: false,
            errorMessage: undefined,
            fromCache: false,
            ttlLeftMs: 0,
            staleLeftMs: 0,
            fetchedAt: Date.now(),
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
        dataPreview: preview(entry.data),
        hasData: true,
        errorMessage: undefined,
        fromCache: entry.fromCache,
        ttlLeftMs: Math.max(0, entry.expiresAt - now),
        staleLeftMs: Math.max(0, entry.staleAt - now),
        fetchedAt: entry.createdAt,
      });
    }
    return {
      queries,
      subscriptions: [...this.#client.getSubscriptions()],
      events: [...this.#client.getEvents()].reverse(),
      stats: this.#client.getStats(),
    };
  }
}
