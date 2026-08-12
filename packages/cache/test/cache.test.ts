import { createOrbit, memoryAdapter } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createCachePlugin, createMemoryCacheStore, parseCacheSpec } from '../src/index.js';

describe('@orbit/cache surface', () => {
  it('re-exports the cache factories from the frozen core contract', () => {
    expect(typeof createCachePlugin).toBe('function');
    expect(typeof createMemoryCacheStore).toBe('function');
    expect(typeof parseCacheSpec).toBe('function');
  });

  it('parseCacheSpec behaves (imported through the package)', () => {
    expect(parseCacheSpec('ttl=300')).toEqual({ ttl: 300 });
    expect(parseCacheSpec('ttl=300,stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec('stale=60')).toEqual({ stale: 60 });
    expect(parseCacheSpec('')).toEqual({});
    expect(() => parseCacheSpec('bogus')).toThrow();
  });

  it('the memory store enforces its maxEntries cap', () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    store.set('a', { value: 1, createdAt: 1, query: 'a' });
    store.set('b', { value: 2, createdAt: 2, query: 'b' });
    store.set('c', { value: 3, createdAt: 3, query: 'c' });
    expect(store.get('a')).toBeUndefined(); // oldest evicted
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });
});

describe('@orbit/cache end-to-end', () => {
  it('serves the second request of a cache spec from memory', async () => {
    let calls = 0;
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => {
            calls += 1;
            return { id, name: 'Ada' };
          },
        },
      ]),
      plugins: [createCachePlugin()],
    });

    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    const first = await orbit.execute(envelope);
    expect(first.status).toBe(200);
    expect(first.fromCache).toBeFalsy();
    expect(calls).toBe(1);

    const second = await orbit.execute(envelope);
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
    expect(second.data).toEqual({ name: 'Ada' });
  });
});
