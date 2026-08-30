/**
 * The hooks: `useOrbitQuery`, `useOrbitMutation`, `useOrbitSubscription` and
 * `useOrbitStream`. Each one talks ONLY to the react client (which talks only
 * to the vanilla transport) — there is no transport code in this file.
 *
 * Effects depend on the derived `cacheKey` STRING, never on the raw
 * `key`/`query` values: a caller re-creating `['posts']` on every render
 * must not re-subscribe or restart a stream (the cacheKey string is equal,
 * so the effect stays put; the current values ride through a ref).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrbitError } from '@orbit/client';
import type { MutationArgs } from '@orbit/core';
import { useOrbitClient } from './provider.js';
import type {
  MutationResult,
  MutationSpec,
  MutationState,
  QueryKey,
  QueryOptions,
  QueryResult,
  StreamOptions,
  StreamState,
  SubscriptionOptions,
  SubscriptionState,
  UseMutationOptions,
} from './types.js';

/**
 * Read a query with the cache: fresh → instant, stale → instant + background
 * refresh, missing → fetch. Re-renders whenever the key's cache version
 * changes (the TTL/SWR timestamps are baked into the cached entry).
 */
export function useOrbitQuery<T = unknown>(
  key: QueryKey,
  query: string,
  options: QueryOptions = {},
): QueryResult<T> {
  const client = useOrbitClient();
  const cacheKey = useMemo(() => client.cacheKeyOf(key, query), [client, key, query]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Re-render only when THIS key's cache version changes.
  const [version, setVersion] = useState(() => client.cacheVersion(cacheKey));
  useEffect(() => {
    let last = client.cacheVersion(cacheKey);
    const unsubscribe = client.subscribeCache(() => {
      const next = client.cacheVersion(cacheKey);
      if (next !== last) {
        last = next;
        setVersion(next);
      }
    });
    return unsubscribe;
  }, [client, cacheKey]);

  const enabled = options.enabled !== false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key/query ride through the cacheKey string dep — content equality, not identity.
  useEffect(() => {
    if (!enabled) return;
    void client.ensureQuery<T>(key, query, optionsRef.current);
    // `options` rides through a ref: ensureQuery is idempotent (fresh → no-op,
    // fetching → shared in-flight promise), so re-running on object identity
    // changes is harmless and never refetches a fresh entry. `key`/`query` are
    // read from the closure — the cacheKey dep keeps this effect in sync with
    // their CONTENT, so a caller re-creating `['posts']` each render does not
    // refetch.
  }, [client, cacheKey, enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key/query content is encoded in cacheKey; version is the cache-change signal.
  const state = useMemo(() => client.readQuery<T>(key, query), [client, cacheKey, version]);

  const refetch = useCallback(
    (refetchOptions?: QueryOptions) =>
      client.ensureQuery<T>(key, query, {
        ...optionsRef.current,
        ...refetchOptions,
        refresh: true,
      }),
    [client, key, query],
  );
  const invalidate = useCallback(() => client.invalidate(key), [client, key]);

  // On the very first paint nothing has been fetched yet — a pending, enabled
  // query IS loading (it will fetch the moment the effect runs).
  const isLoading = state.status === 'pending' && enabled;
  return useMemo(
    () => ({ ...state, isLoading, refetch, invalidate }),
    [state, isLoading, refetch, invalidate],
  );
}

/**
 * Run a mutation. `spec` is `{ do, args?, return? }`; `mutate(variables)`
 * merges `variables` over `spec.args`. Protocol `invalidates` entities evict
 * the cache automatically; the `invalidate` option covers manual targets.
 */
export function useOrbitMutation<TData = unknown, TVars extends MutationArgs = MutationArgs>(
  spec: MutationSpec,
  options: UseMutationOptions<TData, TVars> = {},
): MutationResult<TData, TVars> {
  const client = useOrbitClient();
  const specRef = useRef(spec);
  specRef.current = spec;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<MutationState<TData>>({
    data: undefined,
    error: undefined,
    status: 'idle',
  });

  const mutateAsync = useCallback(
    async (variables?: TVars, mutateOptions?: UseMutationOptions<TData, TVars>): Promise<TData> => {
      const spec = specRef.current;
      const opts = optionsRef.current;
      const merged = { ...(spec.args ?? {}), ...(variables ?? {}) } as MutationArgs;
      setState({ data: undefined, error: undefined, status: 'pending' });
      try {
        const res = await client.mutate(spec.do, merged, {
          ...(spec.return !== undefined ? { return: spec.return } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        const data = res.data as TData;
        setState({ data, error: undefined, status: 'success' });
        opts.onSuccess?.(data, (variables ?? {}) as TVars);
        mutateOptions?.onSuccess?.(data, (variables ?? {}) as TVars);
        const mutateTarget =
          typeof mutateOptions?.invalidate === 'function'
            ? (mutateOptions.invalidate as (d: TData | undefined) => QueryKey | undefined | void)(
                data,
              )
            : mutateOptions?.invalidate;
        const target =
          mutateTarget !== undefined ? mutateTarget : resolveInvalidate(opts.invalidate, data);
        if (target !== undefined) client.invalidate(target);
        return data;
      } catch (error) {
        const err = error as OrbitError | Error;
        setState({ data: undefined, error: err, status: 'error' });
        opts.onError?.(err);
        mutateOptions?.onError?.(err);
        throw error;
      }
    },
    [client],
  );

  const mutate = useCallback(
    (variables?: TVars, mutateOptions?: UseMutationOptions<TData, TVars>) => {
      void mutateAsync(variables, mutateOptions);
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    setState({ data: undefined, error: undefined, status: 'idle' });
  }, []);

  return useMemo(
    () => ({
      ...state,
      isIdle: state.status === 'idle',
      isLoading: state.status === 'pending',
      isSuccess: state.status === 'success',
      isError: state.status === 'error',
      mutate,
      mutateAsync,
      reset,
    }),
    [state, mutate, mutateAsync, reset],
  );
}

function resolveInvalidate<TData>(
  invalidate: UseMutationOptions<TData>['invalidate'],
  data: TData | undefined,
): QueryKey | undefined {
  if (typeof invalidate === 'function') return invalidate(data) ?? undefined;
  return invalidate;
}

/**
 * Subscribe to a realtime query. The connection reconnects and `resume`s from
 * the last `seq` automatically (that is `@orbit/client`'s job); the hook only
 * listens and re-renders on events. The server's raw `SubscriptionEvent`
 * arrives as `event`, its data as `data`, and `seq` is the resume cursor.
 */
export function useOrbitSubscription<T = unknown>(
  key: QueryKey,
  query: string,
  options: SubscriptionOptions = {},
): SubscriptionState<T> {
  const client = useOrbitClient();
  const cacheKey = useMemo(() => client.cacheKeyOf(key, query), [client, key, query]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<SubscriptionState<T>>({
    data: undefined,
    event: undefined,
    seq: 0,
    count: 0,
    status: 'idle',
    error: undefined,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-subscribing on key/query identity would loop; cacheKey tracks their content.
  useEffect(() => {
    if (optionsRef.current.enabled === false) return;
    let active = true;
    const opts = optionsRef.current;
    const handle = client.transport.subscribe(
      query,
      (event, meta) => {
        if (!active) return;
        opts.onEvent?.(event, meta);
        setState((s) => ({
          ...s,
          data: event.data as T,
          event,
          seq: meta.seq,
          count: s.count + 1,
          status: 'live' as const,
        }));
        client.trackSubscription(key, query, meta.seq, 'live');
      },
      {
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        onError: (error) => {
          if (!active) return;
          opts.onError?.(error);
          setState((s) => ({ ...s, error, status: 'error' as const }));
        },
      },
    );
    handle.onStatus((status) => {
      if (!active) return;
      opts.onStatus?.(status);
      setState((s) => ({ ...s, status }));
      client.trackSubscription(key, query, handle.seq, status);
    });
    client.trackSubscription(key, query, 0, 'attaching');
    return () => {
      active = false;
      handle.close();
      client.untrackSubscription(key, query);
    };
    // Depend ONLY on the stable cacheKey string (plus client): a caller that
    // re-creates the key array on every render must not re-subscribe. When the
    // key CONTENT changes the cacheKey changes and this effect re-runs with the
    // current closure.
  }, [client, cacheKey]);

  return state;
}

/**
 * Stream a query's graph level by level over SSE (spec §7): `frames` grows as
 * levels arrive, `isDone` flips when the `{ level: 'done' }` frame lands, and
 * the stream aborts on unmount.
 */
export function useOrbitStream(
  key: QueryKey,
  query: string,
  options: StreamOptions = {},
): StreamState {
  const client = useOrbitClient();
  const cacheKey = useMemo(() => client.cacheKeyOf(key, query), [client, key, query]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, setState] = useState<StreamState>({
    frames: [],
    level: 0,
    isDone: false,
    error: undefined,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: restarting the stream on key/query identity would loop; cacheKey tracks their content.
  useEffect(() => {
    if (optionsRef.current.enabled === false) return;
    const controller = new AbortController();
    const external = optionsRef.current.signal;
    const onExternalAbort = () => controller.abort();
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    let active = true;
    client.cache.setActivity(cacheKey, 'streaming');
    client.logEvent({ type: 'stream', key, query, at: Date.now() });
    const run = async (): Promise<void> => {
      const { timeoutMs, format, headers } = optionsRef.current;
      const streamOptions = {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(format !== undefined ? { format } : {}),
        ...(headers !== undefined ? { headers } : {}),
      };
      for await (const frame of client.transport.stream(query, {
        ...streamOptions,
        signal: controller.signal,
      })) {
        if (!active) break;
        setState((s) => ({
          ...s,
          frames: [...s.frames, frame],
          level: typeof frame.level === 'number' ? frame.level : s.level,
        }));
        client.logEvent({
          type: 'stream',
          key,
          query,
          at: Date.now(),
          detail: `level ${String(frame.level)}`,
        });
      }
      if (active) {
        setState((s) => ({ ...s, isDone: true }));
        client.logEvent({ type: 'stream', key, query, ok: true, at: Date.now(), detail: 'done' });
      }
    };
    void run().catch((error: unknown) => {
      const err = error as Error;
      if (!active || err?.name === 'AbortError') return;
      setState((s) => ({ ...s, error: err }));
      client.logEvent({
        type: 'stream',
        key,
        query,
        ok: false,
        at: Date.now(),
        detail: err.message,
      });
    });
    return () => {
      active = false;
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort);
      controller.abort();
      client.cache.setActivity(cacheKey, 'idle');
    };
    // Same stability rule as the subscription hook: depend on the cacheKey
    // string, not the raw key/query identity.
  }, [client, cacheKey]);

  return state;
}
