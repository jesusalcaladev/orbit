import { describe, expect, it, vi } from 'vitest';
import { createCachePlugin, createOrbit, memoryAdapter } from '@orbit/core';
import { createRateLimitPlugin } from '@orbit/rate-limit';
import { createRedisCacheStore, createRedisRateLimitStore } from '../src/index.js';
import type { RedisRateLimitClient, RedisStoreClient } from '../src/index.js';

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

  it('clear deletes in multi-key DEL batches, not one round-trip per key', async () => {
    const client = new FakeRedisClient();
    const delCalls: Array<string | string[]> = [];
    const original = client.del.bind(client);
    client.del = async (keys) => {
      delCalls.push(keys);
      return original(keys);
    };
    const store = createRedisCacheStore({ client });
    for (let i = 0; i < 250; i += 1) await store.set(`orbit:key-${i}`, entry);
    await store.clear();
    expect(client.data.size).toBe(0);
    // 250 keys → two full chunks of 100 plus one remainder of 50.
    const arrays = delCalls.filter((call): call is string[] => Array.isArray(call));
    expect(arrays.map((batch) => batch.length)).toEqual([100, 100, 50]);
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

/**
 * A fake Redis client that SIMULATES the atomic Lua script: the bucket hash
 * lives in `data`, and `eval` applies the same token-bucket math in JS.
 * This lets the wrapper (prefix/TTL/args) and the multi-instance SHARING
 * contract be tested without a real Redis.
 */
class FakeRateLimitRedis implements RedisRateLimitClient {
  readonly data = new Map<string, { tokens: number; last: number }>();
  readonly evalCalls: Array<{ keys: string[]; args: Array<string | number> }> = [];
  lastScript = '';

  async eval(script: string, options: { keys: string[]; arguments: Array<string | number> }) {
    this.lastScript = script;
    this.evalCalls.push({ keys: options.keys, args: options.arguments });
    const args = options.arguments.map(Number);
    const now = args[0] ?? 0;
    const limit = args[1] ?? 0;
    const rate = args[2] ?? 0;
    const key = options.keys[0]!;
    const existing = this.data.get(key);
    if (existing === undefined) this.data.set(key, { tokens: limit, last: now });
    // Re-read: TS control-flow narrows `existing` away after the method call
    // that passed it by reference, so grab the (now guaranteed) entry fresh.
    const bucket = this.data.get(key)!;
    const elapsed = Math.max(0, now - bucket.last);
    bucket.last = now;
    bucket.tokens = Math.min(limit, bucket.tokens + elapsed * rate);
    if (bucket.tokens < 1) {
      return [0, Math.ceil((1 - bucket.tokens) / rate)];
    }
    bucket.tokens -= 1;
    return [1, 0];
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

describe('@orbit/redis — createRedisRateLimitStore', () => {
  it('consumes through the atomic script with prefix + TTL args', async () => {
    const client = new FakeRateLimitRedis();
    const store = createRedisRateLimitStore({ client, prefix: 'app:' });
    const result = await store.consume(
      'ana',
      { limit: 5, rate: 5 / 60_000, windowMs: 60_000 },
      1000,
    );

    expect(result).toEqual({ ok: true });
    expect(client.evalCalls).toHaveLength(1);
    expect(client.evalCalls[0]!.keys).toEqual(['app:ana']);
    // now, limit, rate, default ttl = max(60, 2 × windowMs/1000)
    expect(client.evalCalls[0]!.args).toEqual([1000, 5, 5 / 60_000, 120]);
    expect(client.lastScript).toContain('math.min');
  });

  it('uses the default orbit:rate-limit: prefix and honors ttlSeconds', async () => {
    const client = new FakeRateLimitRedis();
    const store = createRedisRateLimitStore({ client, ttlSeconds: 30 });
    await store.consume('bruno', { limit: 1, rate: 1 / 60_000, windowMs: 60_000 }, 0);
    expect(client.evalCalls[0]!.keys).toEqual(['orbit:rate-limit:bruno']);
    expect(client.evalCalls[0]!.args[3]).toBe(30);
  });

  it('returns exceeded + retryAfterMs from the script verdict', async () => {
    const canned: { result: unknown } = { result: [0, 250] };
    const client: RedisRateLimitClient = {
      eval: async () => canned.result,
    };
    const store = createRedisRateLimitStore({ client });
    const denied = await store.consume('k', { limit: 1, rate: 1 / 60_000, windowMs: 60_000 }, 0);
    expect(denied).toEqual({ ok: false, retryAfterMs: 250 });

    canned.result = [1, 0];
    await expect(
      store.consume('k', { limit: 1, rate: 1 / 60_000, windowMs: 60_000 }, 0),
    ).resolves.toEqual({ ok: true });
  });

  it('reset() deletes every key under the prefix (SCAN + DEL)', async () => {
    const client = new FakeRateLimitRedis();
    const store = createRedisRateLimitStore({ client, prefix: 'rl:' });
    await store.consume('a', { limit: 1, rate: 1 / 60_000, windowMs: 60_000 }, 0);
    await store.consume('b', { limit: 1, rate: 1 / 60_000, windowMs: 60_000 }, 0);
    expect(client.data.size).toBe(2);
    await store.reset();
    expect(client.data.size).toBe(0);
  });

  it('shares limits across instances: two plugins over ONE Redis', async () => {
    // The multi-instance story: two independent orbits (two "deploys") each
    // mount their own plugin, but both point at the SAME Redis client — the
    // atomic consume means the combined traffic respects ONE shared bucket.
    const client = new FakeRateLimitRedis();
    const makeInstance = () => {
      const plugin = createRateLimitPlugin({
        windowMs: 60_000,
        limit: 2,
        store: createRedisRateLimitStore({ client }),
      });
      return createOrbit({
        adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
        plugins: [plugin],
      });
    };
    const instanceA = makeInstance();
    const instanceB = makeInstance();

    await expect(instanceA.execute({ query: 'user { id }' })).resolves.toMatchObject({
      status: 200,
    });
    await expect(instanceB.execute({ query: 'user { id }' })).resolves.toMatchObject({
      status: 200,
    });
    // Third request hits the shared limit — no matter which instance.
    await expect(instanceA.execute({ query: 'user { id }' })).rejects.toMatchObject({
      status: 429,
    });
    await expect(instanceB.execute({ query: 'user { id }' })).rejects.toMatchObject({
      status: 429,
    });
    expect(client.data.size).toBe(1); // one shared bucket, not two
  });
});
