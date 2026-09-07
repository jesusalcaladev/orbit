import { createOrbit, memoryAdapter } from '@orbit/core';
import type { CacheEntry, CacheStore } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createKvCachePlugin } from '../src/index.js';

/**
 * An async `CacheStore` — mimics `@orbit/redis` and `@orbit/kv-cache`, the
 * documented backends for `createKvCachePlugin`. The frozen `CacheStore`
 * contract is sync-or-async, and every ecosystem store returns `Promise`s.
 */
function asyncStore(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, entry) {
      entries.set(key, entry);
    },
    async delete(key) {
      entries.delete(key);
    },
    async clear() {
      entries.clear();
    },
    *keys() {
      yield* entries.keys();
    },
  };
}

describe('createKvCachePlugin with an async store (Redis/KV contract)', () => {
  it('serves a cached value from an async store on the second request', async () => {
    const store = asyncStore();
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
      plugins: [createKvCachePlugin({ store })],
    });

    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    const first = await orbit.execute(envelope);
    expect(first.status).toBe(200);
    expect(first.fromCache).toBeFalsy();
    expect(first.data).toEqual({ name: 'Ada' });
    expect(calls).toBe(1);

    // Second request MUST hit the async store's cached value, not short-circuit
    // with the store's unresolved Promise.
    const second = await orbit.execute(envelope);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual({ name: 'Ada' });
    expect(calls).toBe(1);
  });

  it('treats an entry with a non-finite createdAt as expired (corruption fail-safe)', async () => {
    const store = asyncStore();
    let lastKey = '';
    const recording: CacheStore = {
      ...store,
      async set(key, entry) {
        lastKey = key;
        return store.set(key, entry);
      },
    };
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
      plugins: [createKvCachePlugin({ store: recording })],
    });

    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    await orbit.execute(envelope); // miss → stores a fresh entry
    expect(lastKey).not.toBe('');

    // Corrupt the stored entry (simulating a buggy/legacy store): a NaN
    // `createdAt` must never be served as perpetually fresh.
    await store.set(lastKey, { value: { name: 'Stale' }, createdAt: Number.NaN, query: 'seed' });

    const after = await orbit.execute(envelope);
    expect(after.fromCache).toBeFalsy();
    expect(after.data).toEqual({ name: 'Ada' });
    expect(calls).toBe(2);
  });

  it('exposes the full CachePlugin surface (store, keyFor, invalidate…)', () => {
    const plugin = createKvCachePlugin({ store: asyncStore() });
    expect(plugin.name).toBe('orbit-cache');
    expect(plugin.store).toBeDefined();
    expect(typeof plugin.keyFor).toBe('function');
    expect(typeof plugin.invalidate).toBe('function');
    expect(typeof plugin.invalidatePrefix).toBe('function');
    expect(typeof plugin.invalidateEntity).toBe('function');
    expect(typeof plugin.clear).toBe('function');
  });

  it('defaults to an in-memory store when none is passed, like createCachePlugin', async () => {
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
      plugins: [createKvCachePlugin()],
    });

    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    await orbit.execute(envelope);
    await orbit.execute(envelope);
    expect(calls).toBe(1);
  });

  it('invalidateEntity evicts cached entries that read the mutated entity', async () => {
    const store = asyncStore();
    let reads = 0;
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => {
            reads += 1;
            return { id, name: 'Ada' };
          },
          mutate: (_action, args) => ({ id: args.filter?.id }),
        },
      ]),
      plugins: [createKvCachePlugin({ store })],
    });

    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    await orbit.execute(envelope); // miss → cached
    await orbit.execute(envelope); // hit
    expect(reads).toBe(1);

    await orbit.execute({
      do: 'user.update',
      args: { filter: { id: '1' }, payload: { name: 'Grace' } },
    });

    const after = await orbit.execute(envelope);
    expect(reads).toBe(2); // evicted by the mutation → fresh resolve
    expect(after.data).toEqual({ name: 'Ada' });
  });
});
