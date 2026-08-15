import { describe, expect, it, vi } from 'vitest';
import { createCachePlugin, createOrbit, memoryAdapter } from '@orbit/core';
import { createKvCacheStore } from '../src/index.js';
import type { KvNamespaceLike } from '../src/index.js';

interface KvListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

/** An in-memory KV namespace that mimics Workers KV get/put/delete/list. */
class FakeKvNamespace implements KvNamespaceLike {
  readonly data = new Map<string, string>();
  lastPutOptions: { expirationTtl?: number } | undefined;
  /** Split list() into pages of this size to exercise pagination. */
  pageSize = 1000;
  /**
   * Real KV cursors are opaque continuation tokens into a STABLE snapshot —
   * deleting items between pages must not shift the remaining pages. The
   * fake snapshots the keyset at the start of each enumeration (first call
   * without a cursor) and pages through that snapshot.
   */
  private snapshot: string[] | undefined;

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    this.lastPutOptions = options;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KvListResult> {
    const prefix = options?.prefix ?? '';
    // The store always asks for limit 1000 — real KV pages server-side. The
    // fake pages by its own `pageSize` so tests can force pagination.
    if (options?.cursor === undefined) {
      this.snapshot = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    }
    const all = this.snapshot ?? [];
    const start = Number(options?.cursor ?? 0);
    const page = all.slice(start, start + this.pageSize);
    const complete = start + this.pageSize >= all.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      ...(complete ? {} : { cursor: String(start + this.pageSize) }),
    };
  }
}

const entry = { value: { name: 'Ana' }, createdAt: 123, query: 'user(id="1") { name }' };

describe('@orbit/kv-cache — createKvCacheStore', () => {
  it('round-trips an entry through set/get', async () => {
    const namespace = new FakeKvNamespace();
    const store = createKvCacheStore({ namespace });
    await store.set('orbit:abc', entry);
    expect(await store.get('orbit:abc')).toEqual(entry);
  });

  it('returns undefined for a missing key', async () => {
    const namespace = new FakeKvNamespace();
    const store = createKvCacheStore({ namespace });
    expect(await store.get('orbit:nope')).toBeUndefined();
  });

  it('treats a corrupted value as a miss (never throws)', async () => {
    const namespace = new FakeKvNamespace();
    // The store reads keys under the DEFAULT prefix ('orbit:' + plugin key),
    // so the corrupted entries must be seeded at their full key to actually
    // reach parseEntry — a miss for the wrong reason would make this test
    // vacuous.
    const store = createKvCacheStore({ namespace });
    const seed = (key: string, value: string) => namespace.data.set(`orbit:${key}`, value);
    seed('bad', '{not json');
    seed('array', '[1,2,3]');
    seed('scalar', '"just a string"');
    seed('notimestamp', JSON.stringify({ value: 1, query: '' }));
    seed('novalue', JSON.stringify({ createdAt: 1, query: '' }));
    seed('noquery', JSON.stringify({ value: 1, createdAt: 1, query: 42 }));

    for (const key of ['bad', 'array', 'scalar', 'notimestamp', 'novalue', 'noquery']) {
      expect(await store.get(key)).toBeUndefined();
    }
  });

  it('stores under the configured prefix and yields bare keys', async () => {
    const namespace = new FakeKvNamespace();
    const store = createKvCacheStore({ namespace, prefix: 'app:' });
    await store.set('orbit:a', entry);
    await store.set('orbit:b', entry);

    expect(namespace.data.has('app:orbit:a')).toBe(true);
    expect(namespace.data.has('app:orbit:b')).toBe(true);

    const keys: string[] = [];
    for await (const key of store.keys!()) keys.push(key);
    expect(keys.sort()).toEqual(['orbit:a', 'orbit:b']);
  });

  it('keys() pages through list() with cursors and still yields every bare key', async () => {
    const namespace = new FakeKvNamespace();
    namespace.pageSize = 2; // force pagination (KV pages at 1000 by default)
    const store = createKvCacheStore({ namespace, prefix: 'app:' });
    for (let i = 0; i < 5; i += 1) await store.set(`orbit:${i}`, entry);

    const keys: string[] = [];
    for await (const key of store.keys!()) keys.push(key);
    expect(keys.sort()).toEqual(['orbit:0', 'orbit:1', 'orbit:2', 'orbit:3', 'orbit:4']);
  });

  it('delete removes only the targeted key', async () => {
    const namespace = new FakeKvNamespace();
    const store = createKvCacheStore({ namespace });
    await store.set('orbit:a', entry);
    await store.set('orbit:b', entry);
    await store.delete('orbit:a');
    expect(await store.get('orbit:a')).toBeUndefined();
    expect(await store.get('orbit:b')).toEqual(entry);
  });

  it('clear pages through list() and removes every prefixed key', async () => {
    const namespace = new FakeKvNamespace();
    namespace.pageSize = 2; // force pagination
    namespace.data.set('other:key', 'keep me');
    const store = createKvCacheStore({ namespace, prefix: 'app:' });
    for (let i = 0; i < 5; i += 1) await store.set(`orbit:${i}`, entry);

    await store.clear();
    expect(namespace.data.size).toBe(1);
    expect(namespace.data.has('other:key')).toBe(true);
  });

  it('applies a server-side expirationTtl when set', async () => {
    const namespace = new FakeKvNamespace();
    const store = createKvCacheStore({ namespace, expirationTtl: 300 });
    await store.set('orbit:a', entry);
    expect(namespace.lastPutOptions).toEqual({ expirationTtl: 300 });
  });

  it('plugs into the cache plugin end to end (async store)', async () => {
    const namespace = new FakeKvNamespace();
    const cache = createCachePlugin({ store: createKvCacheStore({ namespace }) });
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
