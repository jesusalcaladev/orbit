/**
 * Public types for @orbit/react. Type-only module — zero runtime statements.
 */
import type {
  ClientFormat,
  OrbitError,
  OrbitStreamEvent,
  RealtimeStatus,
  SubscriptionEvent,
} from '@orbit/client';
import type { MutationArgs } from '@orbit/core';

/**
 * A cache key: a string or an array of stable, serializable values
 * (`JSON.stringify`-safe). The full cache key derives from BOTH the key and
 * the query string, so two queries of the same entity with different shapes
 * never collide.
 */
export type QueryKey = string | readonly unknown[];

export type QueryStatus = 'pending' | 'success' | 'error';

/** What the cache layer is currently doing for a key. */
export type KeyActivity = 'idle' | 'fetching' | 'mutating' | 'streaming' | 'subscribed';

/** A cached query result, with the client-side TTL/SWR timestamps. */
export interface CacheEntry<T = unknown> {
  key: QueryKey;
  query: string;
  data: T;
  createdAt: number;
  /** `createdAt + ttl` — before this the entry is served without touching the network. */
  expiresAt: number;
  /** `expiresAt + stale` — in this window the entry is served and refetched in the background. */
  staleAt: number;
  /** Whether the server answered from ITS cache (the `fromCache` flag). */
  fromCache: boolean;
  /** Entity names the query touches (derived from the OQS) — drives protocol eviction. */
  entities: string[];
}

export interface CacheError {
  error: OrbitError | Error;
  at: number;
}

/** The full per-key state the cache keeps (entry + activity + error). */
export interface KeyState<T = unknown> {
  /** Metadata (devtools display), set on the first fetch. */
  key: QueryKey | undefined;
  query: string | undefined;
  entry: CacheEntry<T> | undefined;
  error: CacheError | undefined;
  activity: KeyActivity;
  /** Bumped on every change to this key — the hook re-render signal. */
  version: number;
}

/** Options for `client.ensureQuery` / `useOrbitQuery`. */
export interface QueryOptions {
  /** Client-side cache TTL in ms (default: the client's `defaultTtl`). */
  ttl?: number;
  /** Stale-while-revalidate window in ms after `ttl` (default: `defaultStale`). */
  stale?: number;
  /** Server cache spec string, e.g. `'ttl=60'` — rides the envelope (spec §8). */
  cache?: string;
  /** Hooks only: when `false` the query is not fetched (until enabled). */
  enabled?: boolean;
  /** Bypass the cache entirely — always hit the network (refetch). */
  refresh?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  format?: ClientFormat;
  headers?: Record<string, string>;
}

/** A synchronous snapshot of the cache for a query — the hook render value. */
export interface QueryState<T = unknown> {
  data: T | undefined;
  error: OrbitError | Error | undefined;
  status: QueryStatus;
  /** A fetch is running for this key (or a stale entry is being refreshed). */
  isFetching: boolean;
  /** The entry exists but is past its TTL (served while refreshing). */
  isStale: boolean;
  /** The server answered from its cache (`fromCache`). */
  fromCache: boolean;
  /** When the current entry was fetched. */
  fetchedAt: number | undefined;
  /** No data yet AND a fetch is running. */
  isLoading: boolean;
}

/** What `useOrbitQuery` returns. */
export interface QueryResult<T = unknown> extends QueryState<T> {
  refetch: (options?: QueryOptions) => Promise<QueryState<T>>;
  invalidate: () => void;
}

/** A mutation as declared at hook mount: `{ do, args?, return? }`. */
export interface MutationSpec {
  do: string;
  args?: MutationArgs;
  return?: string;
}

export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

export interface MutationState<TData = unknown> {
  data: TData | undefined;
  error: OrbitError | Error | undefined;
  status: MutationStatus;
}

export interface UseMutationOptions<TData = unknown, TVars extends MutationArgs = MutationArgs> {
  onSuccess?: (data: TData, variables: TVars) => void;
  onError?: (error: OrbitError | Error) => void;
  /** Invalidate a key after success — or return one from the data. */
  invalidate?: QueryKey | ((data: TData | undefined) => QueryKey | undefined | void);
}

export interface MutationResult<TData = unknown, TVars extends MutationArgs = MutationArgs>
  extends MutationState<TData> {
  isIdle: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  mutate: (variables?: TVars, options?: UseMutationOptions<TData, TVars>) => void;
  mutateAsync: (variables?: TVars, options?: UseMutationOptions<TData, TVars>) => Promise<TData>;
  reset: () => void;
}

export interface SubscriptionOptions {
  enabled?: boolean;
  /** The subscription id on the server (defaults to a per-instance unique id). */
  id?: string;
  onEvent?: (event: SubscriptionEvent, meta: { seq: number }) => void;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (error: OrbitError) => void;
}

export interface SubscriptionState<T = unknown> {
  /** The latest event's data. */
  data: T | undefined;
  event: SubscriptionEvent | undefined;
  /** The latest server `seq` — the resume cursor. */
  seq: number;
  /** How many events arrived since mount. */
  count: number;
  status: RealtimeStatus | 'idle' | 'error';
  error: OrbitError | undefined;
}

export interface StreamOptions {
  enabled?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  format?: ClientFormat;
  headers?: Record<string, string>;
}

export interface StreamState {
  frames: OrbitStreamEvent[];
  level: number;
  isDone: boolean;
  error: Error | undefined;
}

/** Imperative mutation options for `client.mutate`. */
export interface MutateOptions {
  /** Re-query a sub-graph after the mutation (spec §5). */
  return?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  format?: ClientFormat;
  headers?: Record<string, string>;
  /** Invalidate a key after success — or return one from the data. */
  invalidate?: QueryKey | ((data: unknown, error?: unknown) => QueryKey | undefined | void);
}

export type ActivityType =
  | 'query'
  | 'mutation'
  | 'subscription'
  | 'stream'
  | 'invalidate'
  | 'setData'
  | 'clear'
  | 'hydrate';

/** One entry in the devtools activity feed. */
export interface ActivityEvent {
  id: number;
  type: ActivityType;
  at: number;
  ok?: boolean;
  ms?: number;
  key?: QueryKey;
  query?: string;
  action?: string;
  detail?: string;
}

export interface DehydratedEntry {
  key: QueryKey;
  query: string;
  data: unknown;
  createdAt: number;
  expiresAt: number;
  staleAt: number;
  fromCache: boolean;
  entities: string[];
}

/** The serializable cache snapshot (`client.dehydrate()` / `client.hydrate()`). */
export interface DehydratedCache {
  v: 1;
  entries: DehydratedEntry[];
}

export interface OrbitReactClientOptions {
  /** The vanilla transport client to wrap. */
  client: import('@orbit/client').OrbitClient;
  /** Default client-side TTL in ms. Default 30_000. */
  defaultTtl?: number;
  /** Default stale-while-revalidate window in ms. Default 60_000. */
  defaultStale?: number;
  /** LRU cap on cached entries. Default 200. */
  maxEntries?: number;
}

/** `createReactClient` — the vanilla transport options plus cache defaults. */
export type CreateReactClientOptions = import('@orbit/client').OrbitClientOptions & {
  /** Wrap an existing vanilla client instead of building one from the transport options. */
  client?: import('@orbit/client').OrbitClient;
  defaultTtl?: number;
  defaultStale?: number;
  maxEntries?: number;
};
