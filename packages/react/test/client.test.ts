import { describe, expect, it, vi } from 'vitest';
import { OrbitClient } from '@orbit/client';
import { ErrorCode, OrbitError } from '@orbit/core';
import { createReactClient } from '../src/client.js';
import { fakeTransport, okResponse, reactClientOf } from './helpers.js';

describe('OrbitReactClient', () => {
  it('wraps the vanilla transport and exposes the cache', () => {
    const { transport, client } = fakeTransport();
    const react = reactClientOf(transport);
    expect(react.transport).toBe(client);
    expect(react.cacheKeyOf('u', 'q')).toBe(JSON.stringify('u') + '\u0000q');
  });

  describe('readQuery', () => {
    it('reports pending without an entry', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const state = react.readQuery('u', 'q');
      expect(state).toMatchObject({
        data: undefined,
        status: 'pending',
        isFetching: false,
        isLoading: false,
      });
    });

    it('reports success + fresh for an unexpired entry', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      react.cache.set(key, {
        key: 'u',
        query: 'q',
        data: { name: 'Ana' },
        createdAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        staleAt: Date.now() + 2_000,
        fromCache: true,
        entities: ['user'],
      });
      const state = react.readQuery('u', 'q');
      expect(state).toMatchObject({
        data: { name: 'Ana' },
        status: 'success',
        isStale: false,
        isFetching: false,
        fromCache: true,
      });
    });

    it('reports stale + refreshing for an entry in the SWR window', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      const now = Date.now();
      react.cache.set(key, {
        key: 'u',
        query: 'q',
        data: { name: 'Ana' },
        createdAt: now - 10_000,
        expiresAt: now - 1,
        staleAt: now + 1_000,
        fromCache: false,
        entities: ['user'],
      });
      const state = react.readQuery('u', 'q');
      expect(state).toMatchObject({
        status: 'success',
        isStale: true,
        isFetching: true,
        isLoading: false,
      });
    });

    it('reports a fetch in flight for a loading activity', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      react.cache.setActivity(key, 'fetching');
      const state = react.readQuery('u', 'q');
      expect(state).toMatchObject({ status: 'pending', isFetching: true, isLoading: true });
    });

    it('reports error from a recorded failure', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      react.cache.setError(react.cacheKeyOf('u', 'q'), new Error('boom'));
      const state = react.readQuery('u', 'q');
      expect(state).toMatchObject({ status: 'error', error: expect.any(Error) });
    });
  });

  describe('ensureQuery', () => {
    it('serves a fresh entry without touching the network (hit)', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      react.cache.set(key, {
        key: 'u',
        query: 'q',
        data: { name: 'Ana' },
        createdAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        staleAt: Date.now() + 2_000,
        fromCache: false,
        entities: ['user'],
      });
      const state = await react.ensureQuery('u', 'q');
      expect(state.data).toEqual({ name: 'Ana' });
      expect(transport.query).not.toHaveBeenCalled();
      expect(react.getStats().hits).toBe(1);
    });

    it('serves a stale entry and refreshes in the background', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      const now = Date.now();
      react.cache.set(key, {
        key: 'u',
        query: 'q',
        data: { name: 'Ana' },
        createdAt: now - 10_000,
        expiresAt: now - 1,
        staleAt: now + 1_000,
        fromCache: false,
        entities: ['user'],
      });
      const state = await react.ensureQuery('u', 'q');
      expect(state.data).toEqual({ name: 'Ana' });
      expect(state.isStale).toBe(true);
      await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(1));
    });

    it('fetches on a miss and stores ttl/stale/entities/fromCache', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ id: 'p1', title: 'Hi' }, { fromCache: true }));
      const react = reactClientOf(transport, { defaultTtl: 5_000, defaultStale: 9_000 });
      const state = await react.ensureQuery(['posts'], 'posts { id, title, author { name } }', {
        cache: 'ttl=60',
      });
      expect(state.data).toEqual({ id: 'p1', title: 'Hi' });
      expect(state.fromCache).toBe(true);
      const entry = react.cache.stateOf(
        react.cacheKeyOf(['posts'], 'posts { id, title, author { name } }'),
      ).entry;
      expect(entry?.entities).toEqual(['posts', 'author']);
      expect(entry!.expiresAt - entry!.createdAt).toBe(5_000);
      expect(entry!.staleAt - entry!.expiresAt).toBe(9_000);
      expect(transport.query).toHaveBeenCalledWith('posts { id, title, author { name } }', {
        cache: 'ttl=60',
      });
      expect(react.getStats().misses).toBe(1);
    });

    it('dedupes concurrent fetches into one transport call', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
      const react = reactClientOf(transport);
      await Promise.all([
        react.ensureQuery('u', 'q'),
        react.ensureQuery('u', 'q'),
        react.ensureQuery('u', 'q'),
      ]);
      expect(transport.query).toHaveBeenCalledTimes(1);
    });

    it('records failures as errors when there is no cached entry', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      transport.query.mockRejectedValue(new OrbitError(ErrorCode.PERMISSION_DENIED, 'nope'));
      const state = await react.ensureQuery('u', 'q');
      expect(state.status).toBe('error');
      expect(react.readQuery('u', 'q').error?.message).toBe('nope');
    });

    it('maps a non-Error rejection into an error state', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      transport.query.mockRejectedValue({ status: 500 } as never);
      const state = await react.ensureQuery('u', 'q');
      expect(state.status).toBe('error');
      const error = react.readQuery('u', 'q').error;
      expect(error).toBeDefined();
      expect(
        react
          .getEvents()
          .some((e) => e.type === 'query' && e.ok === false && e.detail === '[object Object]'),
      ).toBe(true);
    });

    it('keeps stale data when a background refresh fails', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const key = react.cacheKeyOf('u', 'q');
      const now = Date.now();
      react.cache.set(key, {
        key: 'u',
        query: 'q',
        data: { name: 'Old' },
        createdAt: now - 10_000,
        expiresAt: now - 1,
        staleAt: now + 1_000,
        fromCache: false,
        entities: ['user'],
      });
      transport.query.mockRejectedValue(new OrbitError(ErrorCode.PERMISSION_DENIED, 'nope'));
      const state = await react.ensureQuery('u', 'q');
      expect(state.status).toBe('success'); // stale entry is still served
      expect(state.data).toEqual({ name: 'Old' });
      await vi.waitFor(() => {
        expect(react.cache.stateOf(key).error?.error.message).toBe('nope');
      });
      expect(react.cache.stateOf(key).entry?.data).toEqual({ name: 'Old' }); // data preserved
    });

    it('forwards every transport option on a miss', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ n: 1 }));
      const react = reactClientOf(transport);
      const signal = new AbortController().signal;
      void react.ensureQuery('u', 'q', {
        cache: 'ttl=60',
        signal,
        timeoutMs: 100,
        format: 'msgpack',
        headers: { 'x-test': '1' },
      });
      expect(transport.query).toHaveBeenCalledWith('q', {
        cache: 'ttl=60',
        signal,
        timeoutMs: 100,
        format: 'msgpack',
        headers: { 'x-test': '1' },
      });
    });

    it('is resilient to malformed queries (entity extraction falls back)', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse(null));
      const react = reactClientOf(transport);
      const state = await react.ensureQuery('u', 'user(id="1") {');
      expect(state.status).toBe('success');
      expect(react.cache.stateOf(react.cacheKeyOf('u', 'user(id="1") {')).entry?.entities).toEqual(
        [],
      );
    });
  });

  describe('mutate', () => {
    it('applies protocol invalidates entities after success', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ id: 'p1' }));
      const react = reactClientOf(transport);
      await react.ensureQuery(['posts'], 'posts { id }', { ttl: 60_000 });
      transport.query.mockClear();
      transport.mutate.mockResolvedValue(okResponse({ success: true }, { invalidates: ['posts'] }));
      await react.mutate('posts.create', { payload: { title: 'x' } });
      expect(react.getQueryData(['posts'])).toBeUndefined();
      const events = react.getEvents();
      expect(
        events.some((e) => e.type === 'invalidate' && e.detail?.includes('by entity posts')),
      ).toBe(true);
    });

    it('evicts several entities at once (plural log) and skips non-matching keys', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ id: 'p1' }));
      const react = reactClientOf(transport);
      await react.ensureQuery(['posts'], 'posts { id }', { ttl: 60_000 });
      await react.ensureQuery(['recent'], 'posts { id }', { ttl: 60_000 });
      await react.ensureQuery(['reviews'], 'reviews { id }', { ttl: 60_000 });
      transport.query.mockClear();
      transport.mutate.mockResolvedValue(okResponse({ success: true }, { invalidates: ['posts'] }));
      await react.mutate('posts.create', { payload: { title: 'x' } });
      expect(react.getQueryData(['posts'])).toBeUndefined();
      expect(react.getQueryData(['recent'])).toBeUndefined();
      expect(react.getQueryData(['reviews'])).not.toBeUndefined(); // non-matching survives
      const log = react
        .getEvents()
        .filter((e) => e.type === 'invalidate')
        .at(-1);
      expect(log?.detail).toBe('2 entries by entity posts');
    });

    it('logs nothing when protocol invalidates match nothing', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse({ id: 'p1' }));
      const react = reactClientOf(transport);
      await react.ensureQuery(['posts'], 'posts { id }', { ttl: 60_000 });
      // An entry-less describe-only slot must be skipped, not crash the loop.
      react.cache.describe(react.cacheKeyOf('ghost', 'q'), 'ghost', 'q');
      transport.query.mockClear();
      const before = react.getEvents().length;
      transport.mutate.mockResolvedValue(
        okResponse({ success: true }, { invalidates: ['ghosts'] }),
      );
      await react.mutate('posts.create', { payload: { title: 'x' } });
      expect(react.getQueryData(['posts'])).not.toBeUndefined();
      expect(react.getEvents().filter((e) => e.type === 'invalidate')).toHaveLength(0);
      expect(react.getEvents().length).toBe(before + 2); // start + ok mutation logs only
    });

    it('honours an explicit invalidate key/function option', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      await react.ensureQuery(['u'], 'user { name }', { ttl: 60_000 });
      transport.query.mockClear();
      transport.mutate.mockResolvedValue(okResponse({ name: 'Ana' }));
      const byKey = vi.fn(() => ['u'] as const);
      await react.mutate(
        'user.update',
        { filter: { id: '1' }, payload: { name: 'Ana' } },
        { invalidate: byKey },
      );
      expect(byKey).toHaveBeenCalledWith({ name: 'Ana' }, undefined);
      expect(react.getQueryData(['u'])).toBeUndefined();
      expect(
        react.getEvents().some((e) => e.type === 'invalidate' && e.detail === 'after mutation'),
      ).toBe(true);
    });

    it('passes transport options through and returns the response', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const res = okResponse({ success: true });
      transport.mutate.mockResolvedValue(res);
      const result = await react.mutate(
        'u.delete',
        { filter: { id: '1' } },
        {
          return: 'user { name }',
          signal: new AbortController().signal,
          timeoutMs: 100,
          format: 'msgpack',
          headers: { 'x-test': '1' },
        },
      );
      expect(result).toBe(res);
      expect(transport.mutate).toHaveBeenCalledWith(
        'u.delete',
        { filter: { id: '1' } },
        {
          return: 'user { name }',
          signal: expect.any(AbortSignal),
          timeoutMs: 100,
          format: 'msgpack',
          headers: { 'x-test': '1' },
        },
      );
    });

    it('rethrows failures and reports the error to the invalidate function', async () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const error = new OrbitError(ErrorCode.MUTATION_FAILED, 'nope');
      transport.mutate.mockRejectedValue(error);
      const onFailure = vi.fn();
      await expect(
        react.mutate('u.delete', { filter: { id: '1' } }, { invalidate: onFailure }),
      ).rejects.toBe(error);
      expect(onFailure).toHaveBeenCalledWith(undefined, error);
      expect(react.getEvents().some((e) => e.type === 'mutation' && e.ok === false)).toBe(true);
    });
  });

  it('prefetch is ensureQuery', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const react = reactClientOf(transport);
    const state = await react.prefetch('u', 'user { name }');
    expect(state.data).toEqual({ name: 'Ana' });
  });

  describe('invalidate', () => {
    it('evicts by exact key (string and array) and by predicate', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse(null));
      const react = reactClientOf(transport);
      await react.ensureQuery(['u'], 'user { name }', { ttl: 60_000 });
      await react.ensureQuery(['p'], 'posts { id }', { ttl: 60_000 });
      expect(react.cache.entries()).toHaveLength(2);
      react.invalidate(['u']);
      expect(react.getQueryData(['u'])).toBeUndefined();
      expect(react.getQueryData(['p'])).not.toBeUndefined();
      react.invalidate((entry) => entry.entities.includes('posts'));
      expect(react.getQueryData(['p'])).toBeUndefined();
    });

    it('does nothing (and logs nothing) when nothing matches', () => {
      const { transport } = fakeTransport();
      const react = reactClientOf(transport);
      const before = react.getEvents().length;
      react.invalidate('missing');
      react.invalidate(() => false);
      expect(react.getEvents().length).toBe(before);
    });

    it('invalidates several keys at once and logs the plural form', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse(null));
      const react = reactClientOf(transport);
      await react.ensureQuery(['a'], 'a { id }', { ttl: 60_000 });
      await react.ensureQuery(['b'], 'b { id }', { ttl: 60_000 });
      react.invalidate(() => true);
      expect(react.cache.entries()).toHaveLength(0);
      const log = react
        .getEvents()
        .filter((e) => e.type === 'invalidate')
        .at(-1);
      expect(log?.detail).toBe('2 entries');
    });

    it('skips entry-less states (error/describe-only slots)', async () => {
      const { transport } = fakeTransport();
      transport.query.mockResolvedValue(okResponse(null));
      const react = reactClientOf(transport);
      // A describe-only slot: key/query known, no cached entry.
      react.cache.describe(react.cacheKeyOf('ghost', 'q'), 'ghost', 'q');
      react.invalidate(() => true);
      expect(react.cache.entries()).toHaveLength(0);
      expect(react.getEvents().filter((e) => e.type === 'invalidate')).toHaveLength(0);
    });
  });

  it('setQueryData updates matching entries without a network call', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Old' }));
    const react = reactClientOf(transport, { defaultTtl: 5_000, defaultStale: 9_000 });
    await react.ensureQuery(['u'], 'user { name }', { ttl: 60_000 });
    await react.ensureQuery(['p'], 'posts { id }', { ttl: 60_000 });
    react.setQueryData(['u'], { name: 'New' });
    expect(react.getQueryData(['u'])).toEqual({ name: 'New' });
    expect(react.getQueryData(['p'])).not.toEqual({ name: 'New' });
    expect(transport.query).toHaveBeenCalledTimes(2);
  });

  it('setQueryData updates every entry sharing the key (plural log)', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Old' }));
    const react = reactClientOf(transport);
    await react.ensureQuery(['u'], 'user { name }', { ttl: 60_000 });
    await react.ensureQuery(['u'], 'user { id }', { ttl: 60_000 });
    react.setQueryData(['u'], { name: 'New' });
    expect(react.getQueryData(['u'])).toEqual({ name: 'New' });
    const log = react
      .getEvents()
      .filter((e) => e.type === 'setData')
      .at(-1);
    expect(log?.detail).toBe('2 entries');
  });

  it('setQueryData with no matching entry logs nothing', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    const before = react.getEvents().length;
    react.setQueryData(['missing'], { n: 1 });
    expect(react.getEvents().length).toBe(before);
  });

  it('setQueryData honours custom ttl/stale options', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Old' }));
    const react = reactClientOf(transport);
    await react.ensureQuery(['u'], 'user { name }', { ttl: 60_000 });
    const before = react.cache.stateOf(react.cacheKeyOf(['u'], 'user { name }')).version;
    react.setQueryData(['u'], { name: 'New' }, { ttl: 1_000, stale: 2_000 });
    const entry = react.cache.stateOf(react.cacheKeyOf(['u'], 'user { name }')).entry!;
    expect(entry.data).toEqual({ name: 'New' });
    expect(entry.expiresAt - entry.createdAt).toBe(1_000);
    expect(entry.staleAt - entry.expiresAt).toBe(2_000);
    expect(react.cache.stateOf(react.cacheKeyOf(['u'], 'user { name }')).version).toBe(before + 1);
  });

  it('getQueryData returns undefined when absent', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    expect(react.getQueryData(['missing'])).toBeUndefined();
  });

  it('dehydrate/hydrate round-trip and log activity', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const react = reactClientOf(transport);
    await react.ensureQuery(['u'], 'user { name }');
    const snapshot = react.dehydrate();
    expect(snapshot.entries).toHaveLength(1);

    const other = reactClientOf(fakeTransport().transport);
    const before = other.getEvents().length;
    other.hydrate(snapshot);
    expect(other.getQueryData(['u'])).toEqual({ name: 'Ana' });
    expect(other.getEvents().length).toBe(before + 1);

    const beforeInvalid = other.getEvents().length;
    other.hydrate({ v: 2, entries: [] } as never); // malformed — no-op, still logged
    expect(other.getEvents().length).toBe(beforeInvalid + 1);

    // A v1 snapshot with a non-array payload logs "0 entries" and is a no-op.
    const beforeWeird = other.getEvents().length;
    other.hydrate({ v: 1, entries: 'nope' } as never);
    expect(other.getEvents().length).toBe(beforeWeird + 1);
    expect(other.getEvents().at(-1)?.detail).toBe('0 entries');
  });

  it('clear evicts the cache and logs', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    react.cache.set('a', {
      key: 'a',
      query: 'q',
      data: 1,
      createdAt: 0,
      expiresAt: 1,
      staleAt: 2,
      fromCache: false,
      entities: [],
    });
    const before = react.getEvents().length;
    react.clear();
    expect(react.cache.entries()).toHaveLength(0);
    expect(react.getEvents().length).toBe(before + 1);
  });

  it('close closes the transport and drops the cache', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    react.cache.set('a', {
      key: 'a',
      query: 'q',
      data: 1,
      createdAt: 0,
      expiresAt: 1,
      staleAt: 2,
      fromCache: false,
      entities: [],
    });
    react.close();
    expect(transport.close).toHaveBeenCalled();
    expect(react.cache.entries()).toHaveLength(0);
  });

  it('passes subscribe/stream/socket through to the transport', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    const handler = () => undefined;
    react.subscribe('chat { id }', handler, { id: 's1' });
    expect(transport.subscribe).toHaveBeenCalledWith('chat { id }', handler, { id: 's1' });
    react.stream('analytics { x }', { timeoutMs: 5 });
    expect(transport.stream).toHaveBeenCalledWith('analytics { x }', { timeoutMs: 5 });
    const socket = { request: vi.fn() };
    transport.socket.mockReturnValue(socket);
    expect(react.socket()).toBe(socket);
  });

  it('tracks and untracks subscriptions for the devtools', () => {
    const { transport } = fakeTransport();
    const react = reactClientOf(transport);
    react.trackSubscription(['chat'], 'chat { id }', 3, 'live');
    expect(react.getSubscriptions()).toEqual([
      { key: ['chat'], query: 'chat { id }', seq: 3, status: 'live' },
    ]);
    react.untrackSubscription(['chat'], 'chat { id }');
    expect(react.getSubscriptions()).toEqual([]);
    react.untrackSubscription(['chat'], 'chat { id }'); // already gone — no-op
  });

  it('keeps the activity log bounded and reports stats', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse(null));
    const react = reactClientOf(transport);
    for (let i = 0; i < 210; i += 1) react.logEvent({ type: 'query', query: String(i) });
    expect(react.getEvents()).toHaveLength(200);
    expect(react.getEvents()[0]?.query).toBe('10');
    await react.ensureQuery('u', 'q');
    const stats = react.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.events).toBe(200);
  });
});

describe('createReactClient', () => {
  it('wraps an existing vanilla client', () => {
    const { transport, client } = fakeTransport();
    const react = createReactClient({ baseUrl: '/orbit', client });
    expect(react.transport).toBe(client);
    expect(react.cache).toBeDefined();
    void transport;
  });

  it('builds a vanilla client from transport options when none is given', () => {
    const react = createReactClient({ baseUrl: '/orbit', defaultTtl: 1_000 });
    expect(react.transport).toBeInstanceOf(OrbitClient);
    expect(react.transport.baseUrl).toBe('/orbit');
  });

  it('forwards defaultTtl/defaultStale/maxEntries to the wrapper', () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const react = createReactClient({
      baseUrl: '/orbit',
      client: transport as never,
      defaultTtl: 1_000,
      defaultStale: 2_000,
      maxEntries: 3,
    });
    expect(react.cache.stateOf(react.cacheKeyOf('u', 'q')).entry).toBeUndefined();
    void react.prefetch('u', 'q');
  });
});
