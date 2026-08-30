import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ErrorCode, OrbitError } from '@orbit/core';
import { OrbitProvider } from '../src/provider.js';
import {
  useOrbitMutation,
  useOrbitQuery,
  useOrbitStream,
  useOrbitSubscription,
} from '../src/hooks.js';
import type { OrbitReactClient } from '../src/client.js';
import { fakeTransport, frames, okResponse, reactClientOf } from './helpers.js';

function wrap(client: OrbitReactClient) {
  return ({ children }: { children: ReactNode }) => (
    <OrbitProvider client={client}>{children}</OrbitProvider>
  );
}

describe('useOrbitQuery', () => {
  it('fetches on mount and exposes data/status', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitQuery(['u'], 'user { name }'), { wrapper: wrap(client) });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Ana' }));
    expect(result.current.status).toBe('success');
    expect(result.current.isFetching).toBe(false);
    expect(result.current.fromCache).toBe(false);
    expect(transport.query).toHaveBeenCalledWith('user { name }', expect.anything());
  });

  it('serves a warm cache hit without refetching', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    await client.prefetch(['u'], 'user { name }', { ttl: 60_000 });
    const { result } = renderHook(() => useOrbitQuery(['u'], 'user { name }'), { wrapper: wrap(client) });
    expect(result.current.data).toEqual({ name: 'Ana' });
    expect(transport.query).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale entry in the background', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    await client.prefetch(['u'], 'user { name }', { ttl: 60_000 });
    const entry = client.cache.stateOf(client.cacheKeyOf(['u'], 'user { name }')).entry;
    entry!.expiresAt = Date.now() - 1; // force stale
    const { result } = renderHook(() => useOrbitQuery(['u'], 'user { name }'), { wrapper: wrap(client) });
    expect(result.current.isStale).toBe(true);
    await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(2));
  });

  it('respects enabled: false and starts fetching when enabled flips', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useOrbitQuery(['u'], 'user { name }', { enabled }),
      { wrapper: wrap(client), initialProps: { enabled: false } },
    );
    expect(result.current.isLoading).toBe(false);
    expect(transport.query).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Ana' }));
    expect(transport.query).toHaveBeenCalledTimes(1);
  });

  it('surfaces server errors', async () => {
    const { transport } = fakeTransport();
    transport.query.mockRejectedValue(new OrbitError(ErrorCode.PERMISSION_DENIED, 'denied'));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitQuery(['u'], 'user { name }'), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(OrbitError);
    expect((result.current.error as OrbitError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('refetch() forces a network round-trip and invalidate() evicts', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitQuery(['u'], 'user { name }'), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Ana' }));
    act(() => {
      void result.current.refetch({ cache: 'ttl=60' });
    });
    await waitFor(() => expect(transport.query).toHaveBeenCalledTimes(2));
    act(() => result.current.invalidate());
    expect(client.getQueryData(['u'])).toBeUndefined();
  });

  it('refetches when the key changes', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    const { rerender, result } = renderHook(
      ({ id }: { id: string }) => useOrbitQuery(['u', id], 'user { name }'),
      { wrapper: wrap(client), initialProps: { id: '1' } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Ana' }));
    rerender({ id: '2' });
    await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(2));
  });

  it('ignores cache events for other keys (no version bump)', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitQuery(['a'], 'a { x }'), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.data).toEqual({ name: 'Ana' }));
    const keyA = client.cacheKeyOf(['a'], 'a { x }');
    const before = client.cacheVersion(keyA);
    // An unrelated cache write emits globally — A's listener must skip it.
    act(() => {
      client.cache.set(client.cacheKeyOf(['b'], 'b { x }'), {
        key: ['b'], query: 'b { x }', data: { b: 2 }, createdAt: 1, expiresAt: 2, staleAt: 3, fromCache: false, entities: [],
      });
    });
    expect(client.cacheVersion(keyA)).toBe(before);
    expect(result.current.data).toEqual({ name: 'Ana' });
  });
});

describe('useOrbitMutation', () => {
  it('runs the mutation, merges variables over spec args and reports success', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1', success: true }));
    const client = reactClientOf(transport);
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useOrbitMutation(
          { do: 'user.update', args: { filter: { id: '1' } } },
          { onSuccess },
        ),
      { wrapper: wrap(client) },
    );
    expect(result.current.isIdle).toBe(true);
    act(() => {
      void result.current.mutateAsync({ payload: { name: 'Ana' } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: '1', success: true });
    expect(transport.mutate).toHaveBeenCalledWith(
      'user.update',
      { filter: { id: '1' }, payload: { name: 'Ana' } },
      {},
    );
    expect(onSuccess).toHaveBeenCalledWith({ id: '1', success: true }, { payload: { name: 'Ana' } });
  });

  it('passes the return spec through and invalidates a target', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    await client.prefetch(['u'], 'user { name }', { ttl: 60_000 });
    transport.query.mockClear();
    const { result } = renderHook(
      () => useOrbitMutation({ do: 'user.update', return: 'user { name }' }, { invalidate: ['u'] }),
      { wrapper: wrap(client) },
    );
    act(() => {
      void result.current.mutateAsync();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.mutate).toHaveBeenCalledWith('user.update', {}, { return: 'user { name }' });
    expect(client.getQueryData(['u'])).toBeUndefined();
  });

  it('supports function invalidate and mutate() without awaiting', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const invalidate = vi.fn(() => ['u'] as const);
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }, { invalidate }), {
      wrapper: wrap(client),
    });
    act(() => {
      result.current.mutate({ payload: { a: 1 } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ id: '1' });
  });

  it('per-call options without onSuccess still succeed (no hook-level callbacks)', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const invalidate = vi.fn(() => ['u'] as const);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }, { onSuccess }), {
      wrapper: wrap(client),
    });
    act(() => {
      void result.current.mutateAsync(undefined, { invalidate });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledWith({ id: '1' }, {});
    expect(invalidate).toHaveBeenCalledWith({ id: '1' });
  });

  it('a function invalidate returning undefined skips invalidation', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const invalidate = vi.fn(() => undefined);
    const spy = vi.spyOn(client, 'invalidate');
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }, { invalidate }), {
      wrapper: wrap(client),
    });
    act(() => {
      void result.current.mutateAsync();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ id: '1' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports errors and calls onError', async () => {
    const { transport } = fakeTransport();
    const error = new OrbitError(ErrorCode.MUTATION_FAILED, 'boom');
    transport.mutate.mockRejectedValue(error);
    const client = reactClientOf(transport);
    const onError = vi.fn();
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }, { onError }), {
      wrapper: wrap(client),
    });
    act(() => {
      void result.current.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('supports per-call options: onSuccess, onError and invalidate', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const invalidate = vi.fn(() => ['x'] as const);
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }), { wrapper: wrap(client) });
    act(() => {
      void result.current.mutateAsync(undefined, { onSuccess, onError, invalidate });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onSuccess).toHaveBeenCalledWith({ id: '1' }, {});
    expect(invalidate).toHaveBeenCalledWith({ id: '1' });
    expect(onError).not.toHaveBeenCalled();

    const failure = new OrbitError(ErrorCode.MUTATION_FAILED, 'kaboom');
    transport.mutate.mockRejectedValue(failure);
    act(() => {
      void result.current
        .mutateAsync({ payload: { a: 1 } }, { onSuccess, onError, invalidate })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('reset returns to idle', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitMutation({ do: 'x.y' }), { wrapper: wrap(client) });
    act(() => {
      void result.current.mutateAsync();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.reset());
    expect(result.current.isIdle).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('forwards signal and timeoutMs to the transport', async () => {
    const { transport } = fakeTransport();
    transport.mutate.mockResolvedValue(okResponse({ id: '1' }));
    const client = reactClientOf(transport);
    const signal = new AbortController().signal;
    const { result } = renderHook(
      () => useOrbitMutation({ do: 'x.y' }, { signal, timeoutMs: 123 }),
      { wrapper: wrap(client) },
    );
    act(() => {
      void result.current.mutateAsync();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.mutate).toHaveBeenCalledWith('x.y', {}, { signal, timeoutMs: 123 });
  });
});

describe('useOrbitSubscription', () => {
  it('delivers live events, status and errors, and closes on unmount', async () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    const onEvent = vi.fn();
    const { result, unmount } = renderHook(
      () => useOrbitSubscription(['chat'], 'chat { id }', { onEvent }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(transport.subs).toHaveLength(1));
    const sub = transport.subs[0]!;
    expect(sub.query).toBe('chat { id }');

    act(() => sub.emitStatus('live'));
    expect(result.current.status).toBe('live');
    act(() => sub.emit({ type: 'created', id: '1', data: { id: '1', text: 'hi' } }, 4));
    expect(result.current.count).toBe(1);
    expect(result.current.seq).toBe(4);
    expect(result.current.data).toEqual({ id: '1', text: 'hi' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(client.getSubscriptions()).toHaveLength(1);

    act(() => sub.emitError(new OrbitError(ErrorCode.PERMISSION_DENIED, 'nope')));
    expect(result.current.status).toBe('error');
    expect((result.current.error as OrbitError).code).toBe(ErrorCode.PERMISSION_DENIED);

    unmount();
    expect(sub.handle.close).toHaveBeenCalled();
    expect(client.getSubscriptions()).toHaveLength(0);
  });

  it('passes an explicit subscription id through', () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    renderHook(() => useOrbitSubscription(['chat'], 'chat { id }', { id: 'my-feed' }), {
      wrapper: wrap(client),
    });
    expect(transport.subs[0]?.options.id).toBe('my-feed');
  });

  it('does not subscribe when enabled is false', () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    renderHook(() => useOrbitSubscription(['chat'], 'chat { id }', { enabled: false }), {
      wrapper: wrap(client),
    });
    expect(transport.subs).toHaveLength(0);
  });

  it('ignores events, errors and status after unmount', async () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    const onEvent = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(
      () => useOrbitSubscription(['chat'], 'chat { id }', { onEvent, onError }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(transport.subs).toHaveLength(1));
    const sub = transport.subs[0]!;
    unmount();
    act(() => {
      sub.emit({ type: 'created', id: '9', data: { id: '9' } });
      sub.emitError(new OrbitError(ErrorCode.INTERNAL, 'late'));
      sub.emitStatus('live');
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);
    expect(result.current.status).toBe('idle');
  });
});

describe('useOrbitStream', () => {
  it('accumulates frames and marks done', async () => {
    const { transport } = fakeTransport();
    transport.stream.mockReturnValue(
      frames([
        { level: 0, data: 'root' },
        { level: 1, data: 'child' },
        { level: 'done', data: null },
      ]),
    );
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitStream(['s'], 'analytics { x }'), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.isDone).toBe(true));
    expect(result.current.frames).toHaveLength(3);
    expect(result.current.level).toBe(1);
  });

  it('aborts the stream on unmount', async () => {
    const { transport } = fakeTransport();
    let capturedSignal: AbortSignal | undefined;
    transport.stream.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return frames([{ level: 0, data: 'x' }]);
    });
    const client = reactClientOf(transport);
    const { unmount } = renderHook(() => useOrbitStream(['s'], 'analytics { x }'), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(capturedSignal).toBeDefined());
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('honours an external abort signal', async () => {
    const { transport } = fakeTransport();
    let capturedSignal: AbortSignal | undefined;
    transport.stream.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return frames([{ level: 0, data: 'x' }]);
    });
    const client = reactClientOf(transport);
    const external = new AbortController();
    const { unmount } = renderHook(
      () => useOrbitStream(['s'], 'analytics { x }', { signal: external.signal }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(capturedSignal).toBeDefined());
    external.abort();
    expect(capturedSignal?.aborted).toBe(true);
    unmount();
  });

  it('handles an already-aborted external signal', async () => {
    const { transport } = fakeTransport();
    let capturedSignal: AbortSignal | undefined;
    transport.stream.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return frames([]);
    });
    const client = reactClientOf(transport);
    const external = new AbortController();
    external.abort();
    renderHook(() => useOrbitStream(['s'], 'analytics { x }', { signal: external.signal }), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
  });

  it('forwards stream options and ignores abort errors', async () => {
    const { transport } = fakeTransport();
    transport.stream.mockImplementation((_query: string, options: Record<string, unknown>) => {
      expect(options).toMatchObject({ timeoutMs: 50, format: 'msgpack', headers: { 'x-test': '1' } });
      return {
        async *[Symbol.asyncIterator]() {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      };
    });
    const client = reactClientOf(transport);
    const { result } = renderHook(
      () =>
        useOrbitStream(['s'], 'analytics { x }', {
          timeoutMs: 50,
          format: 'msgpack',
          headers: { 'x-test': '1' },
        }),
      { wrapper: wrap(client) },
    );
    await vi.waitFor(() => expect(result.current.isDone).toBe(false));
    // An AbortError never surfaces as a state error.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.error).toBeUndefined();
  });

  it('respects enabled: false for streams', async () => {
    const { transport } = fakeTransport();
    transport.stream.mockReturnValue(frames([{ level: 0, data: 'x' }]));
    const client = reactClientOf(transport);
    const { result } = renderHook(
      () => useOrbitStream(['s'], 'analytics { x }', { enabled: false }),
      { wrapper: wrap(client) },
    );
    expect(result.current.frames).toHaveLength(0);
    expect(transport.stream).not.toHaveBeenCalled();
  });

  it('stops consuming frames after unmount', async () => {
    const { transport } = fakeTransport();
    let release: () => void = () => undefined;
    transport.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { level: 0, data: 'x' };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { level: 1, data: 'y' };
      },
    }));
    const client = reactClientOf(transport);
    const { result, unmount } = renderHook(() => useOrbitStream(['s'], 'analytics { x }'), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.frames).toHaveLength(1));
    unmount();
    act(() => release());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.isDone).toBe(false);
    expect(result.current.frames).toHaveLength(1);
  });

  it('reports stream errors', async () => {
    const { transport } = fakeTransport();
    transport.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { level: 0, data: 'x' };
        throw new Error('stream broke');
      },
    }));
    const client = reactClientOf(transport);
    const { result } = renderHook(() => useOrbitStream(['s'], 'analytics { x }'), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toBe('stream broke');
  });
});
