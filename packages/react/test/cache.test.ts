import { describe, expect, it, vi } from 'vitest';
import { QueryCache } from '../src/cache.js';
import type { CacheEntry } from '../src/types.js';

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const now = Date.now();
  return {
    key: ['u', '1'],
    query: 'user(id="1") { name }',
    data: { name: 'Ana' },
    createdAt: now,
    expiresAt: now + 1_000,
    staleAt: now + 2_000,
    fromCache: false,
    entities: ['user'],
    ...overrides,
  };
}

describe('QueryCache', () => {
  it('derives cache keys from the user key AND the query string', () => {
    const a = QueryCache.keyOf(['u', '1'], 'user { name }');
    const b = QueryCache.keyOf(['u', '1'], 'user { name, age }');
    const c = QueryCache.keyOf('u', 'user { name }');
    expect(a).toBe(JSON.stringify(['u', '1']) + '\u0000user { name }');
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });

  it('stateOf lazily creates idle states and getVersion starts at 0', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    expect(cache.getVersion(key)).toBe(0);
    const state = cache.stateOf(key);
    expect(state.activity).toBe('idle');
    expect(state.version).toBe(0);
    expect(state.entry).toBeUndefined();
    expect(cache.stateOf(key)).toBe(state);
  });

  it('describe stamps key/query metadata without bumping the version', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    cache.describe(key, 'u', 'q');
    const state = cache.stateOf(key);
    expect(state.key).toBe('u');
    expect(state.query).toBe('q');
    expect(state.version).toBe(0);
  });

  it('set stores an entry, bumps the version and clears error/activity', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf(['u', '1'], 'user { name }');
    cache.setActivity(key, 'fetching');
    cache.setError(key, new Error('old'));
    cache.set(key, entry());
    const state = cache.stateOf(key);
    expect(state.entry?.data).toEqual({ name: 'Ana' });
    expect(state.error).toBeUndefined();
    expect(state.activity).toBe('idle');
    expect(state.version).toBe(3); // activity + error + set
    expect(cache.entries()).toHaveLength(1);
    expect(cache.allStates()).toHaveLength(1);
  });

  it('setError records the failure but keeps the previous entry', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    cache.set(key, entry());
    const before = cache.stateOf(key).version;
    cache.setError(key, new Error('boom'));
    const state = cache.stateOf(key);
    expect(state.error?.error.message).toBe('boom');
    expect(state.entry?.data).toEqual({ name: 'Ana' });
    expect(state.version).toBe(before + 1);
  });

  it('setActivity bumps only when the activity actually changes', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    cache.setActivity(key, 'fetching');
    const after = cache.stateOf(key).version;
    cache.setActivity(key, 'fetching');
    expect(cache.stateOf(key).version).toBe(after);
    cache.setActivity(key, 'streaming');
    expect(cache.stateOf(key).version).toBe(after + 1);
  });

  it('remove deletes only existing keys and notifies', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.remove(key); // missing — no-op, no notify
    expect(listener).not.toHaveBeenCalled();
    cache.set(key, entry());
    listener.mockClear();
    cache.remove(key);
    expect(cache.entries()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear evicts everything; clearing an empty cache is a no-op', () => {
    const cache = new QueryCache();
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.clear();
    expect(listener).not.toHaveBeenCalled();
    cache.set('a', entry({ key: 'a' }));
    cache.set('b', entry({ key: 'b' }));
    listener.mockClear();
    cache.clear();
    expect(cache.entries()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('touch bumps the global version and notifies without touching keys', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    cache.set(key, entry());
    const version = cache.stateOf(key).version;
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.touch();
    expect(cache.stateOf(key).version).toBe(version);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe stops notifying after unsubscribe', () => {
    const cache = new QueryCache();
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    cache.set('a', entry({ key: 'a' }));
    unsubscribe();
    cache.set('b', entry({ key: 'b' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dehydrate returns a serializable snapshot of every entry', () => {
    const cache = new QueryCache();
    cache.set('a', entry());
    const snapshot = cache.dehydrate();
    expect(snapshot.v).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      key: ['u', '1'],
      query: 'user(id="1") { name }',
      data: { name: 'Ana' },
      fromCache: false,
      entities: ['user'],
    });
  });

  it('hydrate restores entries and bumps versions', () => {
    const cache = new QueryCache();
    const listener = vi.fn();
    cache.subscribe(listener);
    const snapshot = cache.dehydrate();
    snapshot.entries = [
      {
        key: 'u',
        query: 'user { name }',
        data: { name: 'Grace' },
        createdAt: 100,
        expiresAt: 200,
        staleAt: 300,
        fromCache: true,
        entities: ['user'],
      },
    ];
    cache.hydrate(snapshot);
    const state = cache.stateOf(QueryCache.keyOf('u', 'user { name }'));
    expect(state.entry?.data).toEqual({ name: 'Grace' });
    expect(state.entry?.fromCache).toBe(true);
    expect(state.entry?.entities).toEqual(['user']);
    expect(state.version).toBe(1);
    expect(listener).toHaveBeenCalled();
  });

  it('hydrate skips malformed snapshots and entries', () => {
    const cache = new QueryCache();
    const key = QueryCache.keyOf('u', 'q');
    cache.set(key, entry());
    const before = cache.stateOf(key).version;
    cache.hydrate({ v: 2, entries: [] } as never);
    expect(cache.stateOf(key).version).toBe(before);
    cache.hydrate({ v: 1, entries: {} as never });
    expect(cache.stateOf(key).version).toBe(before);
    cache.hydrate({
      v: 1,
      entries: [
        null as never,
        { query: 'no-timestamps' } as never,
        {
          key: 'u1',
          query: 'bad-exp',
          data: 2,
          createdAt: 1,
          expiresAt: 'nope' as never,
          staleAt: 3,
        } as never,
        {
          key: 'u2',
          query: 'bad-stale',
          data: 3,
          createdAt: 1,
          expiresAt: 2,
          staleAt: 'nope' as never,
        } as never,
        {
          key: 'u',
          query: 'ok',
          data: 1,
          createdAt: 1,
          expiresAt: 2,
          staleAt: 3,
          entities: 'nope',
        } as never,
      ],
    });
    const restored = cache.stateOf(QueryCache.keyOf('u', 'ok'));
    expect(restored.entry?.data).toBe(1);
    expect(restored.entry?.entities).toEqual([]);
    // Malformed-timestamp entries are skipped entirely.
    expect(cache.stateOf(QueryCache.keyOf('u1', 'bad-exp')).entry).toBeUndefined();
    expect(cache.stateOf(QueryCache.keyOf('u2', 'bad-stale')).entry).toBeUndefined();
  });

  it('hydrate defaults a missing key to [] (string-key path too)', () => {
    const cache = new QueryCache();
    cache.hydrate({
      v: 1,
      entries: [
        { query: 'no-key', data: 7, createdAt: 1, expiresAt: 2, staleAt: 3 } as never,
        { key: 'k', query: 'q', data: 8, createdAt: 1, expiresAt: 2, staleAt: 3 } as never,
      ],
    });
    const noKey = cache.stateOf(QueryCache.keyOf([], 'no-key')).entry;
    expect(noKey?.key).toEqual([]);
    expect(noKey?.data).toBe(7);
    expect(cache.stateOf(QueryCache.keyOf('k', 'q')).entry?.data).toBe(8);
  });

  it('evicts the oldest entry when over the max', () => {
    const cache = new QueryCache({ maxEntries: 1 });
    cache.set('a', entry({ key: 'a', createdAt: 100 }));
    cache.set('b', entry({ key: 'b', createdAt: 200 }));
    expect(cache.entries().map((s) => s.state.entry?.key)).toEqual(['b']);
  });
});
