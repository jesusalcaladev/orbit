/**
 * @orbit/react — hooks & cache for React and React Native over @orbit/client.
 *
 * Zero transport: every byte to the wire rides the vanilla `@orbit/client`
 * instance you wrap. This package adds the missing layer — declarative cache
 * (TTL + stale-while-revalidate, protocol-driven invalidation), hooks, SSR
 * dehydrate/hydrate, optional persistence and a cross-platform devtools.
 *
 * ```tsx
 * import { OrbitProvider, createReactClient, useOrbitQuery } from '@orbit/react';
 *
 * const client = createReactClient({ baseUrl: '/orbit' });
 *
 * function Feed() {
 *   const { data, isLoading } = useOrbitQuery(['posts'], 'posts { id, title }', { ttl: 30_000 });
 *   return isLoading ? <Spinner /> : <PostList posts={data} />;
 * }
 *
 * <OrbitProvider client={client}><Feed /></OrbitProvider>
 * ```
 */
// The vanilla transport, re-exported so a React consumer needs one import.
export { OrbitClient, createClient } from '@orbit/client';
export { ErrorCode, OrbitError, isOrbitError } from '@orbit/client';
export type { OrbitStreamEvent, SubscriptionEvent } from '@orbit/client';

export { OrbitProvider, useOrbitClient } from './provider.js';
export { OrbitReactClient, createReactClient } from './client.js';
export { QueryCache } from './cache.js';
export { useOrbitMutation, useOrbitQuery, useOrbitStream, useOrbitSubscription } from './hooks.js';
export {
  createLocalStorageAdapter,
  hydrateClient,
  persistClient,
} from './persistence.js';
export type { StorageAdapter } from './persistence.js';
export type {
  ActivityEvent,
  ActivityType,
  CacheEntry,
  CacheError,
  CreateReactClientOptions,
  DehydratedCache,
  DehydratedEntry,
  KeyActivity,
  KeyState,
  MutationResult,
  MutationSpec,
  MutationState,
  MutationStatus,
  MutateOptions,
  OrbitReactClientOptions,
  QueryKey,
  QueryOptions,
  QueryResult,
  QueryState,
  QueryStatus,
  StreamOptions,
  StreamState,
  SubscriptionOptions,
  SubscriptionState,
  UseMutationOptions,
} from './types.js';
