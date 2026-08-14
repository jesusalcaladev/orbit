import { describe, expect, it, vi } from 'vitest';
import { createCachePlugin, createOrbit, memoryAdapter } from '@orbit/core';
import { createRedisCacheStore } from '../src/index.js';
import type { RedisStoreClient } from '../src/index.js';

/** An in-memory Redis client that mimics node-redis's get/set/del/scanIterator. */
class FakeRedisClient implements RedisStoreClient {
  readonly data = new Map<string, string>();
  lastSetOptions: { EX?: number } | undefined;

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
    this.data.set(key, value);
    this.lastSetOptions = options;
    return 'OK';
  }

  async del(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) this.data.delete(key);
    return list.length;
  }

  async *scanIterator(options: { MATCH: string }): AsyncIterableIterator<string> {
    const prefix = options.MATCH.split('*')[0]!;
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) yield key;
    }
  }
}

const entry = { value: { name: 'Ana' }, createdAt: 123, query: 'user(id="1") { name }' };

describe('@orbit/redis — createRedisCacheStore', () => {
  it('round-trips an entry through set/get', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client });
    await store.set('orbit:abc', entry);
    expect(await store.get('orbit:abc')).toEqual(entry);
  });

  it('returns undefined for a missing key', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client });
    expect(await store.get('orbit:nope')).toBeUndefined();
  });

  it('treats a corrupted value as a miss (never throws)', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client });
    client.data.set('orbit:bad', '{not json');
    client.data.set('orbit:array', '[1,2,3]');
    client.data.set('orbit:notimestamp', JSON.stringify({ value: 1, query: '' }));
    client.data.set('orbit:novalue', JSON.stringify({ createdAt: 1, query: '' }));
    client.data.set('orbit:scalar', '"just a string"');

    for (const key of [
      'orbit:bad',
      'orbit:array',
      'orbit:notimestamp',
      'orbit:novalue',
      'orbit:scalar',
    ]) {
      expect(await store.get(key)).toBeUndefined();
    }
  });

  it('stores under the configured prefix and yields bare keys', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client, prefix: 'app:' });
    await store.set('orbit:a', entry);
    await store.set('orbit:b', entry);

    expect(client.data.has('app:orbit:a')).toBe(true);
    expect(client.data.has('app:orbit:b')).toBe(true);

    const keys: string[] = [];
    for await (const key of store.keys!()) keys.push(key);
    expect(keys.sort()).toEqual(['orbit:a', 'orbit:b']);
  });

  it('delete removes only the targeted key', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client });
    await store.set('orbit:a', entry);
    await store.set('orbit:b', entry);
    await store.delete('orbit:a');
    expect(await store.get('orbit:a')).toBeUndefined();
    expect(await store.get('orbit:b')).toEqual(entry);
  });

  it('clear removes every prefixed key and leaves the rest of the db alone', async () => {
    const client = new FakeRedisClient();
    client.data.set('other:key', 'keep me');
    const store = createRedisCacheStore({ client, prefix: 'app:' });
    await store.set('orbit:a', entry);
    await store.set('orbit:b', entry);
    await store.clear();
    expect(client.data.size).toBe(1);
    expect(client.data.has('other:key')).toBe(true);
  });

  it('applies a server-side TTL (EX) when ttlSeconds is set', async () => {
    const client = new FakeRedisClient();
    const store = createRedisCacheStore({ client, ttlSeconds: 300 });
    await store.set('orbit:a', entry);
    expect(client.lastSetOptions).toEqual({ EX: 300 });
  });

  it('plugs into the cache plugin end to end (async store)', async () => {
    const client = new FakeRedisClient();
    const cache = createCachePlugin({ store: createRedisCacheStore({ client }) });
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [cache],
    });
    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };

    const first = await orbit.execute(envelope);
    expect(first.fromCache).toBe(false);
    const second = await orbit.execute(envelope);
    expect(second.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);

    await cache.invalidatePrefix('orbit:');
    const third = await orbit.execute(envelope);
    expect(third.fromCache).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
