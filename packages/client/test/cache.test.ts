import { describe, expect, it, vi } from 'vitest';
import { OrbitClient, QueryCache } from '../src/index.js';
import { jsonRes, mockFetch } from './helpers.js';

describe('QueryCache — standalone', () => {
  it('stores and returns entries keyed by the query string', () => {
    const cache = new QueryCache();
    cache.set('user(id="1") { name }', { data: { name: 'Ana' } });
    const hit = cache.get('user(id="1") { name }');
    expect(hit?.data).toEqual({ name: 'Ana' });
    // A different query is a different key.
    expect(cache.get('user(id="2") { name }')).toBeUndefined();
  });

  it('honors a ttl from the cache spec — expired entries are misses', () => {
    // The spec grammar speaks seconds (`ttl=300` = 300 s), so use fake time.
    vi.useFakeTimers();
    try {
      const cache = new QueryCache();
      cache.set('user(id="1") { id }', { data: { id: '1' } }, 'ttl=300');
      expect(cache.get('user(id="1") { id }')?.data).toEqual({ id: '1' });
      vi.advanceTimersByTime(300_001);
      expect(cache.get('user(id="1") { id }')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('indexes entries by every entity in the query tree (root + relations)', () => {
    const cache = new QueryCache();
    cache.set('user(id="1") { name, posts { title, comments { text } } }', { data: {} }, 'ttl=300');
    // Entity-precise eviction (spec §8 semantics): touching `posts` evicts,
    // touching an unrelated entity does not.
    cache.invalidate(['posts']);
    expect(cache.get('user(id="1") { name, posts { title, comments { text } } }')).toBeUndefined();
  });

  it('evicts only queries that touch the mutated entity', () => {
    const cache = new QueryCache();
    cache.set('user(id="1") { name }', { data: 1 }, 'ttl=300');
    cache.set('reviews(limit="5") { text }', { data: 2 }, 'ttl=300');
    cache.invalidate(['user']);
    expect(cache.get('user(id="1") { name }')).toBeUndefined();
    expect(cache.get('reviews(limit="5") { text }')?.data).toBe(2);
  });

  it('accepts exact keys and mixed targets from the invalidates echo', () => {
    const cache = new QueryCache();
    cache.set('user(id="1") { name }', { data: 1 }, 'ttl=300');
    cache.set('user(id="2") { name }', { data: 2 }, 'ttl=300');
    cache.invalidate([QueryCache.keyFor('user(id="1") { name }'), 'review']);
    expect(cache.get('user(id="1") { name }')).toBeUndefined();
    expect(cache.get('user(id="2") { name }')?.data).toBe(2);
  });

  it('clears everything and reports its size', () => {
    const cache = new QueryCache({ maxEntries: 2 });
    cache.set('a { x }', { data: 1 }, 'ttl=300');
    cache.set('b { x }', { data: 2 }, 'ttl=300');
    cache.set('c { x }', { data: 3 }, 'ttl=300'); // LRU cap
    expect(cache.size).toBeLessThanOrEqual(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('b { x }')).toBeUndefined();
  });

  it('ignores malformed targets without throwing', () => {
    const cache = new QueryCache();
    cache.set('user { name }', { data: 1 }, 'ttl=300');
    expect(() => cache.invalidate([])).not.toThrow();
    expect(cache.get('user { name }')?.data).toBe(1);
    // Non-string and empty-string targets are skipped, never thrown on.
    expect(() => cache.invalidate([undefined as unknown as string, ''])).not.toThrow();
    expect(cache.get('user { name }')?.data).toBe(1);
  });

  it('indexes each entity once even when it appears at several depths', () => {
    const cache = new QueryCache();
    const q = 'user { posts { author { name } }, comments(user="1") { text } }';
    cache.set(q, { data: 1 }, 'ttl=300');
    expect(cache.get(q)?.data).toBe(1);
    cache.invalidate(['comments']);
    expect(cache.get(q)).toBeUndefined();
  });

  it('treats an unparseable spec as no-TTL and an unparseable query as unindexable', () => {
    const cache = new QueryCache();
    // A garbage spec still stores (it participates in eviction), just without a TTL.
    expect(() => cache.set('user { name }', { data: 1 }, 'garbage-spec!!!')).not.toThrow();
    expect(cache.get('user { name }')?.data).toBe(1);
    // An unparseable query is never stored.
    cache.set('user { name', { data: 2 }, 'ttl=300');
    expect(cache.get('user { name')).toBeUndefined();
    // A spec WITHOUT a ttl (`stale=60`) stores without expiry too.
    cache.set('reviews { text }', { data: 3 }, 'stale=60');
    expect(cache.get('reviews { text }')?.data).toBe(3);
  });

  it('indexes a self-repeating entity once', () => {
    const cache = new QueryCache();
    const q = 'a { b { a { x } } }'; // `a` appears at depth 0 and depth 2
    cache.set(q, { data: 1 }, 'ttl=300');
    expect(cache.get(q)?.data).toBe(1);
    cache.invalidate(['a']);
    expect(cache.get(q)).toBeUndefined();
  });
});

describe('OrbitClient with a QueryCache (spec §8 end-to-end)', () => {
  it('serves repeated cached queries without a network round-trip', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { name: 'Ana' } }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      cache: new QueryCache(),
    });

    const first = await client.query('user(id="1") { name }', { cache: 'ttl=300' });
    expect(first.data).toEqual({ name: 'Ana' });
    expect(first.fromCache).toBeUndefined();

    const second = await client.query('user(id="1") { name }', { cache: 'ttl=300' });
    expect(second.data).toEqual({ name: 'Ana' });
    expect(second.fromCache).toBe(true);
    expect(capture).toHaveLength(1); // one network call only
  });

  it('never caches queries without a cache spec', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { n: 1 } }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      cache: new QueryCache(),
    });
    await client.query('user(id="1") { name }');
    await client.query('user(id="1") { name }');
    expect(capture).toHaveLength(2);
  });

  it('mutations always hit the network and evict via the invalidates echo', async () => {
    let calls = 0;
    const { fetchImpl } = mockFetch((url, init) => {
      calls += 1;
      if (JSON.parse(String(init.body)).do !== undefined) {
        return jsonRes({ data: { success: true }, invalidates: ['user'] });
      }
      return jsonRes({ data: { name: `v${calls}` } });
    });
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      cache: new QueryCache(),
    });

    await client.query('user(id="1") { name }', { cache: 'ttl=300' });
    await client.mutate('user.update', { filter: { id: '1' }, payload: { name: 'B' } });
    // The mutation evicted the user query → this refetches.
    const after = await client.query('user(id="1") { name }', { cache: 'ttl=300' });
    expect(after.fromCache).toBeUndefined();
    expect(after.data).toEqual({ name: 'v3' });
  });

  it('does not cache mutations or errors', async () => {
    let fail = true;
    const { fetchImpl } = mockFetch(() => {
      if (fail) return jsonRes({ error: { code: 'ORBIT_INTERNAL', message: 'x' } }, 500);
      return jsonRes({ data: { ok: true } });
    });
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      cache: new QueryCache(),
    });
    await expect(client.query('user { name }', { cache: 'ttl=300' })).rejects.toThrow();
    fail = false;
    const ok = await client.query('user { name }', { cache: 'ttl=300' });
    expect(ok.fromCache).toBeUndefined(); // failed attempt was not cached
  });
});
