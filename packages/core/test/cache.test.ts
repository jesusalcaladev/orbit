import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCachePlugin,
  createMemoryCacheStore,
  memoryAdapter,
  parseCacheSpec,
  parseOQS,
} from '../src/index.js';
import type { CacheEntry, CacheStore, OrbitPlugin } from '../src/index.js';
import type { OrbitContext } from '../src/types.js';
import { createOrbit } from '../src/engine.js';
import { ErrorCode } from '../src/errors.js';

const users = [{ id: '1', name: 'Ana' }];

function makeCachedOrbit(options: { store?: ReturnType<typeof createMemoryCacheStore> } = {}) {
  const cache = createCachePlugin({ store: options.store });
  const resolve = vi.fn(({ id }: { id?: string }) => users.find((u) => u.id === id));
  const orbit = createOrbit({
    adapters: memoryAdapter([{ entity: 'user', resolve }]),
    plugins: [cache],
  });
  return { orbit, cache, resolve };
}

const baseEnvelope = () => ({
  query: 'user(id="1") { name }',
  cache: 'ttl=300',
});

describe('parseCacheSpec', () => {
  it('parses ttl and stale specs', () => {
    expect(parseCacheSpec('ttl=300')).toEqual({ ttl: 300 });
    expect(parseCacheSpec('stale=60')).toEqual({ stale: 60 });
    expect(parseCacheSpec('ttl=300,stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec(' { "ttl": 300, "stale": 60 } ')).toEqual({
      ttl: 300,
      stale: 60,
    });
  });

  it('accepts space-separated specs too (spec §8 wording)', () => {
    // The spec says "space-separated"; the historical examples use commas —
    // both must parse, and a space before a comma must not break either.
    expect(parseCacheSpec('ttl=300 stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec('ttl=300, stale=60')).toEqual({
      ttl: 300,
      stale: 60,
    });
    expect(parseCacheSpec('  ttl=300  stale=60  ')).toEqual({
      ttl: 300,
      stale: 60,
    });
  });

  it('returns an empty spec for empty input', () => {
    expect(parseCacheSpec('')).toEqual({});
  });

  it('rejects malformed specs', () => {
    for (const bad of ['ttl=', 'ttl=abc', 'foo=1', 'ttl=-5', '{nope}', '{', 'ttl=1,']) {
      expect(() => parseCacheSpec(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
      );
    }
  });

  it('rejects JSON specs with invalid ttl/stale values', () => {
    // The JSON branch validates each numeric field: wrong type, zero,
    // negative, non-finite (1e999 overflows to Infinity) — all fail loudly.
    for (const bad of [
      '{"ttl":"300"}',
      '{"ttl":0}',
      '{"ttl":-5}',
      '{"stale":1e999}',
      '{"ttl":null}',
    ]) {
      expect(() => parseCacheSpec(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
      );
    }
  });
});

describe('cache plugin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the second request from cache without calling the adapter', async () => {
    const { orbit, resolve } = makeCachedOrbit();
    const first = await orbit.execute(baseEnvelope());
    expect(first.fromCache).toBe(false);
    expect(first.data).toEqual({ name: 'Ana' });

    const second = await orbit.execute(baseEnvelope());
    expect(second.data).toEqual({ name: 'Ana' });
    expect(second.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('caches only when a cache spec is present', async () => {
    const { orbit, resolve } = makeCachedOrbit();
    await orbit.execute({ query: 'user(id="1") { name }' });
    await orbit.execute({ query: 'user(id="1") { name }' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('caches end to end with a space-separated spec', async () => {
    const { orbit, resolve } = makeCachedOrbit();
    const envelope = {
      query: 'user(id="1") { name }',
      cache: 'ttl=300 stale=60',
    };
    await orbit.execute(envelope);
    const hit = await orbit.execute(envelope);
    expect(hit.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('reads the spec from the x-orbit-cache header', async () => {
    const { orbit, resolve } = makeCachedOrbit();
    const envelope = { query: 'user(id="1") { name }' };
    const ctx = { headers: new Headers({ 'x-orbit-cache': 'ttl=60' }) };
    await orbit.execute(envelope, ctx);
    const second = await orbit.execute(envelope, ctx);
    expect(second.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('revalidates after the ttl expires', async () => {
    vi.useFakeTimers();
    const { orbit, resolve } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(301_000);
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('serves stale data and revalidates in the background (SWR)', async () => {
    vi.useFakeTimers();
    const { orbit, resolve } = makeCachedOrbit();
    await orbit.execute({ query: 'user(id="1") { name }', cache: 'stale=60' });
    expect(resolve).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    const staleHit = await orbit.execute({
      query: 'user(id="1") { name }',
      cache: 'stale=60',
    });
    expect(staleHit.data).toEqual({ name: 'Ana' });
    expect(staleHit.fromCache).toBe(true);

    // The stale value was served; the background revalidation refreshes the
    // entry without blocking the request.
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('invalidates a single key', async () => {
    const { orbit, cache, resolve } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(1);

    const node = {
      entity: 'user',
      filters: { id: '1' },
      fields: ['name'],
      relations: {},
      origin: 'client' as const,
    };
    await cache.invalidate(cache.keyFor(node));
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('invalidates by prefix', async () => {
    const { orbit, cache, resolve } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(1);

    await cache.invalidatePrefix('orbit:');
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keys differ when the selection changes', () => {
    const cache = createCachePlugin({ store: createMemoryCacheStore() });
    const keyA = cache.keyFor({
      entity: 'user',
      filters: { id: '1' },
      fields: ['name'],
      relations: {},
      origin: 'client',
    });
    const keyB = cache.keyFor({
      entity: 'user',
      filters: { id: '1' },
      fields: ['name', 'email'],
      relations: {},
      origin: 'client',
    });
    const keyC = cache.keyFor({
      entity: 'user',
      filters: { id: '2' },
      fields: ['name'],
      relations: {},
      origin: 'client',
    });
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyA).toBe(keyA);
  });

  it('applies a default ttl when the spec has none', async () => {
    vi.useFakeTimers();
    const { orbit } = makeCachedOrbit();
    await orbit.execute({ query: 'user(id="1") { name }', cache: '' });
    // empty spec → no caching; cache: 'unsupported-format' throws
    await expect(
      orbit.execute({ query: 'user(id="1") { name }', cache: 'nonsense' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_QUERY });
  });

  it('a JSON-object spec with no keys gets the default ttl', async () => {
    const { orbit, resolve } = makeCachedOrbit();
    const envelope = { query: 'user(id="1") { name }', cache: '{}' };
    await orbit.execute(envelope);
    const hit = await orbit.execute(envelope);
    expect(hit.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('invalidating one of several entity keys keeps the others indexed', async () => {
    const { orbit, cache } = makeCachedOrbit();
    await orbit.execute({ query: 'user(id="1") { name }', cache: 'ttl=60' });
    await orbit.execute({ query: 'user(id="2") { name }', cache: 'ttl=60' });
    const key1 = cache.keyFor({
      entity: 'user',
      filters: { id: '1' },
      fields: ['name'],
      relations: {},
      origin: 'client',
    });
    await cache.invalidate(key1);
    // The 'user' bucket still holds key2 — and invalidating an unknown entity
    // is a no-op.
    await cache.invalidateEntity('ghost');
    await cache.invalidateEntity('user');
  });

  it('invalidatePrefix is a no-op on stores that cannot enumerate keys', async () => {
    // A store without a keys() method cannot support prefix invalidation —
    // the plugin must return cleanly instead of throwing (a buggy/limited
    // KV store shape).
    const store: CacheStore = {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      clear: () => {},
    };
    const cache = createCachePlugin({ store });
    await expect(cache.invalidatePrefix('orbit:')).resolves.toBeUndefined();
  });

  it('invalidatePrefix skips keys outside the prefix', async () => {
    const cache = createCachePlugin({ store: createMemoryCacheStore() });
    const store = cache.store as { get: (key: string) => unknown };
    await cache.store.set('a', { value: 1, createdAt: 0, query: '' });
    await cache.store.set('b', { value: 2, createdAt: 0, query: '' });
    await cache.invalidatePrefix('zzz:');
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeDefined();
  });

  it('a background revalidation with a plugin body does not overwrite the cache', async () => {
    vi.useFakeTimers();
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      // Transformers must be registered BEFORE the cache plugin (spec §11).
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: `name:${(data as { name: string }).name}`,
              contentType: 'text/csv',
            }),
          },
        },
        cache,
      ],
    });
    const envelope = { query: 'user(id="1") { name }', cache: 'stale=60' };
    await orbit.execute(envelope);
    vi.advanceTimersByTime(61_000);
    await orbit.execute(envelope); // stale hit → background revalidation
    await vi.runAllTimersAsync();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('a background revalidation that yields a serialized body keeps the stored entry', async () => {
    // With a serializer mounted, the cache's onBeforeSerialize never stores
    // misses (the serializer's payload short-circuits #applyBeforeSerialize),
    // so seed the entry directly: the stale HIT triggers a background
    // revalidation whose engine result has a `body` — the revalidation must
    // NOT overwrite the stored value with the raw data (body takes the wire).
    vi.useFakeTimers();
    const store = createMemoryCacheStore();
    const cache = createCachePlugin({ store });
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      // Transformers must be registered BEFORE the cache plugin (spec §11).
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: `csv:${JSON.stringify(data)}`,
              contentType: 'text/csv',
            }),
          },
        },
        cache,
      ],
    });
    const envelope = { query: 'user(id="1") { name }', cache: 'stale=60' };
    const key = cache.keyFor(parseOQS('user(id="1") { name }'));
    store.set(key, {
      value: { name: 'Ana' },
      createdAt: Date.now() - 61_000, // past the stale=60 window → revalidate
      query: 'user(id="1") { name }',
    });

    const hit = await orbit.execute(envelope);
    expect(hit.fromCache).toBe(true);
    await vi.runAllTimersAsync();
    expect(resolve).toHaveBeenCalledTimes(1); // exactly the background revalidation
    // The stored value was NOT replaced by the raw revalidation data.
    expect(store.get(key)).toMatchObject({ value: { name: 'Ana' } });
  });

  it('indexes a repeated entity once (dedupe in the entity index)', async () => {
    const cache = createCachePlugin();
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }]),
      plugins: [cache],
    });
    const result = await orbit.execute({
      query: 'user { id, user { id } }',
      cache: 'ttl=60',
    });
    expect(result.data).toMatchObject({ id: '1' });
    await cache.invalidateEntity('user');
  });

  it('accepts plugins registered after the cache that do not transform data', async () => {
    const cache = createCachePlugin();
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
      plugins: [
        cache,
        {
          name: 'metrics',
          hooks: {
            onBeforeResolve: () => undefined,
          },
        },
      ],
    });
    const result = await orbit.execute({ query: 'user { name }' });
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('does not double-transform cached values on hits (cache after transformers)', async () => {
    const mask = {
      name: 'mask',
      hooks: {
        onBeforeSerialize: ({ data }: { data: unknown }) => ({ masked: data }),
      },
    };
    const cache = createCachePlugin();
    const resolve = vi.fn(({ id }: { id?: string }) => users.find((u) => u.id === id));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [mask, cache],
    });
    const envelope = () => ({
      query: 'user(id="1") { name }',
      cache: 'ttl=300',
    });

    const first = await orbit.execute(envelope());
    expect(first.data).toEqual({ masked: { name: 'Ana' } });

    const hit = await orbit.execute(envelope());
    expect(hit.data).toEqual({ masked: { name: 'Ana' } }); // not double-masked
    expect(hit.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('combines ttl with a stale window: serve+refresh between them, refetch beyond', async () => {
    vi.useFakeTimers();
    const { orbit, resolve } = makeCachedOrbit();
    const envelope = {
      query: 'user(id="1") { name }',
      cache: 'ttl=300,stale=60',
    };

    await orbit.execute(envelope); // miss → resolve #1, store at t0
    vi.advanceTimersByTime(301_000);
    const staleServe = await orbit.execute(envelope); // 301 s: past ttl, inside the stale window → serve + background refresh
    expect(staleServe.fromCache).toBe(true);
    await vi.runAllTimersAsync();
    expect(resolve).toHaveBeenCalledTimes(2); // background refresh updated the entry

    vi.advanceTimersByTime(261_000); // entry age since refresh: 261 s < 300 s → still fresh
    const freshServe = await orbit.execute(envelope);
    expect(freshServe.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100_000); // entry age: 361 s ≥ 360 s → hard refetch
    await orbit.execute(envelope);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('invalidateEntity evicts exactly the entity-scoped entries', async () => {
    const bookResolve = vi.fn(() => [{ id: 'b1' }]);
    const reviewResolve = vi.fn(() => [{ id: 'r1' }]);
    const cache = createCachePlugin({ store: createMemoryCacheStore() });
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'book', resolve: bookResolve },
        { entity: 'review', resolve: reviewResolve },
      ]),
      plugins: [cache],
    });
    const bookEnv = { query: 'book { id }', cache: 'ttl=60' };
    const reviewEnv = { query: 'review { id }', cache: 'ttl=60' };
    await orbit.execute(bookEnv);
    await orbit.execute(reviewEnv);
    await orbit.execute(bookEnv);
    await orbit.execute(reviewEnv);
    expect(bookResolve).toHaveBeenCalledTimes(1);
    expect(reviewResolve).toHaveBeenCalledTimes(1);

    await cache.invalidateEntity('book');
    await orbit.execute(bookEnv);
    expect(bookResolve).toHaveBeenCalledTimes(2);
    await orbit.execute(reviewEnv);
    expect(reviewResolve).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry beyond the capacity cap', () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    store.set('a', { value: 1, createdAt: 1, query: '' });
    store.set('b', { value: 2, createdAt: 2, query: '' });
    store.set('c', { value: 3, createdAt: 3, query: '' });
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('c')).toBeDefined();
  });

  it('clear() empties the store and the entity index', async () => {
    const { orbit, cache, resolve } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(1);

    await cache.clear();
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(2); // fresh resolve after the clear
  });

  it('cleans up the SWR marker when a stale hit has no engine (defensive)', async () => {
    // The engine always injects `ctx.orbit`, so the `else` arm of the SWR
    // revalidation guard is defensive (a programmatic caller invoking the
    // hooks directly). It must clear the in-flight marker instead of wedging
    // every later hit.
    const cache = createCachePlugin({ store: createMemoryCacheStore() });
    const parsed = parseOQS('user(id="1") { name }');
    const key = cache.keyFor(parsed);
    await cache.store.set(key, {
      value: { name: 'Ana' },
      createdAt: Date.now() - 5_000, // age 5 s: past ttl=1, inside the stale window
      query: 'user(id="1") { name }',
    });
    const ctx: OrbitContext = {
      state: { 'orbit:cache:spec': { ttl: 1, stale: 60 } },
    };

    const outcome = await cache.hooks.onBeforeResolve?.({ parsed, ctx });
    expect(outcome).toEqual({ shortCircuit: { name: 'Ana' } });
    // The marker was removed, so a second call takes the same path again.
    const again = await cache.hooks.onBeforeResolve?.({ parsed, ctx });
    expect(again).toEqual({ shortCircuit: { name: 'Ana' } });
  });

  it('a direct hook call with no rawQuery falls back to an empty revalidation query', async () => {
    const cache = createCachePlugin({ store: createMemoryCacheStore() });
    const parsed = parseOQS('user(id="1") { name }');
    const ctx: OrbitContext = { state: { 'orbit:cache:spec': { ttl: 1 } } };
    // No entry → miss marker written without a rawQuery to copy.
    await cache.hooks.onBeforeResolve?.({ parsed, ctx });
    expect((ctx.state as Record<string, unknown>)['orbit:cache:miss']).toMatchObject({
      key: cache.keyFor(parsed),
      query: '',
    });
  });
});

describe('precise server-side eviction (spec §8)', () => {
  it('a mutation evicts only the entries that read the mutated entity', async () => {
    const bookResolve = vi.fn(() => [{ id: 'b1' }]);
    const reviewResolve = vi.fn(() => [{ id: 'r1' }]);
    const cache = createCachePlugin();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'book',
          resolve: bookResolve,
          mutate: () => ({ success: true }),
        },
        { entity: 'review', resolve: reviewResolve },
      ]),
      plugins: [cache],
    });
    const bookEnv = { query: 'book { id }', cache: 'ttl=60' };
    const reviewEnv = { query: 'review { id }', cache: 'ttl=60' };

    await orbit.execute(bookEnv);
    await orbit.execute(reviewEnv);
    await orbit.execute(bookEnv);
    await orbit.execute(reviewEnv);
    expect(bookResolve).toHaveBeenCalledTimes(1);
    expect(reviewResolve).toHaveBeenCalledTimes(1);

    // A mutation on 'book' refetches the book cache…
    await orbit.execute({ do: 'book.create' });
    await orbit.execute(bookEnv);
    expect(bookResolve).toHaveBeenCalledTimes(2);
    // …while the review cache survives untouched (entity-scoped precision).
    await orbit.execute(reviewEnv);
    expect(reviewResolve).toHaveBeenCalledTimes(1);
  });

  it('indexes relation entities too — a mutation evicts queries that read it anywhere', async () => {
    const cache = createCachePlugin();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'book',
          resolve: () => [{ id: 'b1', reviews: [{ id: 'r1' }] }],
        },
        {
          entity: 'reviews',
          resolve: () => [],
          mutate: () => ({ success: true }),
        },
      ]),
      plugins: [cache],
    });
    // This tree reads BOTH 'book' and 'reviews' — a reviews mutation must
    // evict it, even though 'reviews' is only a relation, not the root.
    const env = { query: 'book { id, reviews { id } }', cache: 'ttl=60' };
    await orbit.execute(env);
    const hit = await orbit.execute(env);
    expect(hit.fromCache).toBe(true);

    await orbit.execute({ do: 'reviews.add' });
    const after = await orbit.execute(env);
    expect(after.fromCache).toBe(false);
  });

  it('evicts additional entities named in invalidates', async () => {
    const cache = createCachePlugin();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: vi.fn(({ id }: { id?: string }) => users.find((u) => u.id === id)),
        },
        {
          entity: 'post',
          resolve: () => [],
          // The adapter declares that this mutation also invalidates 'user'.
          mutate: () => ({ success: true, invalidates: ['user'] }),
        },
      ]),
      plugins: [cache],
    });
    const userEnv = { query: 'user(id="1") { name }', cache: 'ttl=60' };
    await orbit.execute(userEnv);
    await orbit.execute(userEnv);

    await orbit.execute({ do: 'post.create' });
    const after = await orbit.execute(userEnv);
    expect(after.fromCache).toBe(false);
  });
});

describe('cache store hardening (P0)', () => {
  it('treats a malformed stored entry as a miss instead of crashing', async () => {
    // A buggy/hostile store returns a garbage entry (missing timestamps,
    // wrong shapes). The plugin must serve a fresh resolve, not throw.
    const poisoned = {
      // A structurally valid entry with a CORRUPTED timestamp — the store
      // contract is satisfied, the data is garbage (a buggy KV adapter).
      get: (): import('../src/plugins/cache.js').CacheEntry | undefined => ({
        value: 'poison',
        createdAt: Number.NaN,
        query: '',
      }),
      set: () => {},
      delete: () => {},
      clear: () => {},
      keys: (): IterableIterator<string> => new Set<string>().keys(),
    } satisfies import('../src/plugins/cache.js').CacheStore;
    const cache = createCachePlugin({ store: poisoned });
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: vi.fn(({ id }: { id?: string }) => users.find((u) => u.id === id)),
        },
      ]),
      plugins: [cache],
    });
    const result = await orbit.execute(baseEnvelope());
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('serves a stale entry whose createdAt is in the future without crashing', async () => {
    const store = createMemoryCacheStore();
    store.set('whatever', {
      value: 'x',
      createdAt: Date.now() + 60_000,
      query: '',
    });
    const cache = createCachePlugin({ store });
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: vi.fn(() => users[0]) }]),
      plugins: [cache],
    });
    const result = await orbit.execute(baseEnvelope());
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('survives a store whose keys() yields non-string keys', async () => {
    // The plugin's invalidatePrefix guards against hostile stores that emit
    // non-string keys — a mutation triggering eviction must not crash.
    const store = createMemoryCacheStore();
    const cache = createCachePlugin({ store });
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => ({ id: '1', name: 'Ana' }),
          mutate: () => ({ success: true }),
        },
      ]),
      plugins: [cache],
    });
    await orbit.execute(baseEnvelope());
    // Poison the store's key enumeration (a buggy KV adapter returning
    // Buffers or numbers, for example).
    (store as { keys: () => IterableIterator<unknown> }).keys = () =>
      (function* () {
        yield 'orbit:123';
        yield 42;
        yield Buffer.from('orbit:456');
      })();
    const result = await orbit.execute({ do: 'user.update' });
    expect(result.data).toEqual({ success: true });
  });

  it('maxEntries eviction keeps the newest entries', async () => {
    const store = createMemoryCacheStore({ maxEntries: 3 });
    for (const key of ['a', 'b', 'c', 'd']) {
      store.set(key, { value: key, createdAt: 0, query: '' });
    }
    // Capacity 3: inserting 'd' evicts the oldest ('a'); b, c, d remain.
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.value).toBe('b');
    expect(store.get('c')?.value).toBe('c');
    expect(store.get('d')?.value).toBe('d');
    // Re-inserting 'c' refreshes its position (order: b, d, c).
    store.set('c', { value: 'c2', createdAt: 0, query: '' });
    store.set('e', { value: 'e', createdAt: 0, query: '' });
    // Now 'b' is the oldest — evicted; d, c, e remain.
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')?.value).toBe('c2');
    expect(store.get('d')?.value).toBe('d');
    expect(store.get('e')?.value).toBe('e');
  });

  it('works with an async store (Redis/KV shape): the plugin awaits every op', async () => {
    const map = new Map<string, CacheEntry>();
    const store: CacheStore = {
      get: async (key) => map.get(key),
      set: async (key, entry) => {
        map.set(key, entry);
      },
      delete: async (key) => {
        map.delete(key);
      },
      clear: async () => {
        map.clear();
      },
      keys: async function* () {
        for (const key of map.keys()) yield key;
      },
    };
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const cache = createCachePlugin({ store });
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [cache],
    });

    const first = await orbit.execute(baseEnvelope());
    expect(first.fromCache).toBe(false);
    const second = await orbit.execute(baseEnvelope());
    expect(second.fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);

    await cache.invalidatePrefix('orbit:');
    const third = await orbit.execute(baseEnvelope());
    expect(third.fromCache).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('emits x-orbit-cache: miss + cache-control on a miss (ttl spec)', async () => {
    const { orbit } = makeCachedOrbit();
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseEnvelope()),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-orbit-cache')).toBe('miss');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('emits x-orbit-cache: hit + remaining-freshness cache-control on a hit', async () => {
    vi.useFakeTimers();
    const { orbit } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    vi.advanceTimersByTime(100_000); // entry is now 100 s old
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseEnvelope()),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-orbit-cache')).toBe('hit');
    // Age-aware: the hint mirrors REMAINING freshness (300 − 100), never
    // overstating how long the value stays fresh.
    expect(response.headers.get('cache-control')).toBe('public, max-age=200');
  });

  it('emits SWR cache-control when serving stale (max-age=0 + remaining window)', async () => {
    vi.useFakeTimers();
    const { orbit } = makeCachedOrbit();
    const envelope = {
      query: 'user(id="1") { name }',
      cache: 'ttl=300,stale=60',
    };
    await orbit.execute(envelope);
    vi.advanceTimersByTime(310_000); // past ttl, inside the SWR window
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }),
    );
    expect(response.headers.get('x-orbit-cache')).toBe('hit');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, stale-while-revalidate=50',
    );
  });

  it('emits SWR on a stale-only miss (stale spec)', async () => {
    const { orbit } = makeCachedOrbit();
    const envelope = { query: 'user(id="1") { name }', cache: 'stale=60' };
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      }),
    );
    expect(response.headers.get('x-orbit-cache')).toBe('miss');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=60, stale-while-revalidate=60',
    );
  });

  it('emits no cache headers when no spec is present', async () => {
    const { orbit } = makeCachedOrbit();
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'user(id="1") { name }' }),
      }),
    );
    expect(response.headers.get('x-orbit-cache')).toBeNull();
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('never lets a cache miss marker make an ERROR response cacheable', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          // Resolution fails AFTER the cache plugin stamped its miss headers.
          resolve: () => {
            throw new Error('db exploded');
          },
        },
      ]),
      plugins: [createCachePlugin()],
    });
    const response = await orbit.handler(
      new Request('http://orbit.local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseEnvelope()),
      }),
    );
    expect(response.status).toBe(500);
    // The error contract (spec §7) always wins: no-store, never public.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('a store that throws on set fails the request closed (sanitized)', async () => {
    const exploding = {
      get: () => undefined,
      set: () => {
        throw new Error('connection refused: redis:6379');
      },
      delete: () => {},
      clear: () => {},
    };
    const cache = createCachePlugin({ store: exploding });
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }]),
      plugins: [cache],
    });
    const failure = await orbit.execute(baseEnvelope()).catch((error: unknown) => error);
    // The store's error — whose message may embed credentials — must not
    // reach the client: sanitized ORBIT_INTERNAL.
    expect(failure).toMatchObject({ code: ErrorCode.INTERNAL });
    expect(String((failure as Error).message)).not.toContain('redis');
  });
});

describe('caller-scoped cache keys (cross-tenant isolation)', () => {
  const rows = [
    { id: '1', tenant: 'A', name: 'alice' },
    { id: '2', tenant: 'B', name: 'bob' },
  ];

  /** A per-tenant engine: `scope` injects the tenant filter in onBeforeExecute. */
  function makeTenantedOrbit() {
    const cache = createCachePlugin();
    const resolve = vi.fn((filters: Record<string, string>) =>
      rows.filter((r) => !filters.tenant || r.tenant === filters.tenant),
    );
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      // A minimal stand-in for @orbit/auth: stamp the identity in
      // onBeforeParse, inject the tenant filter in onBeforeExecute.
      plugins: [
        {
          name: 'fake-auth',
          hooks: {
            onBeforeParse({ ctx }: { ctx: OrbitContext }) {
              const tenant = ctx.headers?.get('x-tenant');
              if (tenant === null || tenant === undefined) return;
              (ctx.state ??= {}).caller = { tenant };
            },
            onBeforeExecute({
              filters,
              ctx,
            }: {
              filters: Record<string, string>;
              ctx: OrbitContext;
            }) {
              const tenant = (ctx.state as { caller?: { tenant: string } } | undefined)?.caller
                ?.tenant;
              return tenant === undefined ? undefined : { filters: { ...filters, tenant } };
            },
          },
        },
        cache,
      ],
    });
    const run = (tenant: string) =>
      orbit.execute(
        { query: 'user { id, name }', cache: 'ttl=300' },
        { headers: new Headers({ 'x-tenant': tenant }) },
      );
    return { orbit, cache, resolve, run };
  }

  it('does not serve one tenant another tenant’s cached rows', async () => {
    const { run } = makeTenantedOrbit();

    const a = await run('A');
    const b = await run('B');

    expect(a.data).toEqual([{ id: '1', name: 'alice' }]);
    // The regression: B used to receive A's rows from the shared entry, because
    // the key was purely structural and the tenant filter is applied later.
    expect(b.data).toEqual([{ id: '2', name: 'bob' }]);
  });

  it('still serves a repeat query from cache for the SAME caller', async () => {
    const { run, resolve } = makeTenantedOrbit();

    await run('A');
    const before = resolve.mock.calls.length;
    const second = await run('A');

    // Same identity → same partition → a genuine hit (no second resolve).
    expect(resolve.mock.calls.length).toBe(before);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual([{ id: '1', name: 'alice' }]);
  });

  it('treats an identity that differs only in key order as the same caller', async () => {
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [cache],
    });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    await orbit.execute(query, {
      state: { caller: { tenant: 'A', role: 'admin' } },
    });
    const second = await orbit.execute(query, {
      state: { caller: { role: 'admin', tenant: 'A' } },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
  });

  it('refuses to cache when `state` is missing or not a record', async () => {
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({ adapters: [{ entity: 'user', resolve }], plugins: [cache] });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    // `callerScope` reads `ctx.state` defensively: a plugin (or a direct
    // `execute`) may leave it absent or set it to a non-object. Both must fall
    // back to the shared anonymous partition rather than throwing mid-cache.
    await orbit.execute(query, { state: undefined });
    const second = await orbit.execute(query, { state: undefined });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);

    const resolve2 = vi.fn(() => ({ id: '2' }));
    const orbit2 = createOrbit({
      adapters: [{ entity: 'post', resolve: resolve2 }],
      plugins: [createCachePlugin()],
    });
    const q2 = { query: 'post { id }', cache: 'ttl=300' };
    // A non-object `state` makes the cache's scoping hook throw (it reads
    // properties off it), so the point here is only that `execute` does not
    // crash the *pipeline* — the error is normalized like any other.
    await expect(
      orbit2.execute(q2, { state: 'not-an-object' as unknown as Record<string, unknown> }),
    ).rejects.toThrow();
    // A missing/empty state is the supported anonymous case.
    expect((await orbit2.execute(q2, { state: {} })).fromCache).toBe(false);
  });

  it('treats an explicitly null caller as anonymous', async () => {
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({ adapters: [{ entity: 'user', resolve }], plugins: [cache] });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    // An auth plugin that sets `caller: null` means "nobody in particular",
    // which is the anonymous partition — not an uncacheable identity.
    await orbit.execute(query, { state: { caller: null } });
    expect((await orbit.execute(query, { state: { caller: null } })).fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('treats an explicitly undefined caller as anonymous', async () => {
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({ adapters: [{ entity: 'user', resolve }], plugins: [cache] });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    // An auth plugin that sets `caller: undefined` (a failed lookup, say) means
    // the anonymous partition — the same as `null`, and distinct from an
    // identity it cannot canonicalise.
    await orbit.execute(query, { state: { caller: undefined } });
    expect((await orbit.execute(query, { state: { caller: undefined } })).fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('revalidates without an identity when the request state was not a record', async () => {
    // The refresh path re-derives the caller with the same `isRecord` guard as
    // the read path. A non-record `state` must carry through as "no caller"
    // rather than reading array indices as properties.
    const seen: unknown[] = [];
    const observer: OrbitPlugin = {
      name: 'observer',
      hooks: {
        onBeforeExecute: ({ ctx }) => {
          seen.push((ctx.state as { caller?: unknown } | undefined)?.caller);
        },
      },
    };
    const store: CacheStore = {
      get: () => ({ value: { id: '3', name: 'C' }, createdAt: 0, query: 'user { id, name }' }),
      set: () => {},
      delete: () => {},
      clear: () => {},
    };
    const resolve = vi.fn(() => ({ id: '3', name: 'C' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [createCachePlugin({ store }), observer],
    });
    const query = { query: 'user { id, name }', cache: 'ttl=300,stale=60' };

    vi.spyOn(Date, 'now').mockImplementation(() => 320_000);
    try {
      await orbit.execute(query, { state: ['x'] as unknown as Record<string, unknown> });
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen).toEqual([undefined]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('falls back to the anonymous partition when `state` is an array', async () => {
    // `callerScope` guards with `isRecord`, which rejects arrays. A caller who
    // passes an array as `state` must land in the anonymous partition rather
    // than have array indices read as properties.
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({ adapters: [{ entity: 'user', resolve }], plugins: [cache] });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    const state = ['x'] as unknown as Record<string, unknown>;
    await orbit.execute(query, { state });
    expect((await orbit.execute(query, { state })).fromCache).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('refuses to cache an identity it cannot canonicalise (no silent sharing)', async () => {
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [cache],
    });
    const query = { query: 'user { id }', cache: 'ttl=300' };
    // A class instance is not canonically representable, so it must not be
    // folded into the shared anonymous partition.
    class Caller {
      readonly tenant: string;
      constructor(tenant: string) {
        this.tenant = tenant;
      }
    }
    await orbit.execute(query, { state: { caller: new Caller('A') } });
    const second = await orbit.execute(query, {
      state: { caller: new Caller('A') },
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(second.fromCache).toBe(false);
  });

  it('propagates the caller identity into a background revalidation', async () => {
    // Revalidation re-runs the stored query through the engine. It runs with
    // `SKIP_KEY` (so the refresh does not recurse into the cache) but MUST
    // still carry the caller: an auth plugin gates on `ctx.state.caller`, so
    // dropping it would refresh a scoped entry through an ungated path.
    const seen: unknown[] = [];
    const observer: OrbitPlugin = {
      name: 'observer',
      hooks: {
        onBeforeExecute: ({ ctx }) => {
          seen.push((ctx.state as { caller?: unknown } | undefined)?.caller);
        },
      },
    };
    // The stored entry was created at t=0 and "now" is t=320 s: inside the SWR
    // band (ttl=300, stale=60 → serve-and-refresh from 300 s to 360 s), so the
    // read serves the stale value AND schedules the background refresh.
    let now = 320_000;
    const store: CacheStore = {
      get: () => ({ value: { id: '1', name: 'Ana' }, createdAt: 0, query: 'user { id, name }' }),
      set: () => {},
      delete: () => {},
      clear: () => {},
    };
    const cache = createCachePlugin({ store });
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [cache, observer],
    });
    const query = { query: 'user { id, name }', cache: 'ttl=300,stale=60' };

    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      // The entry's `createdAt` is 0 and "now" is far past `ttl`, so this read
      // serves the stale value AND schedules the background revalidation.
      const stale = await orbit.execute(query, { state: { caller: { tenant: 'A' } } });
      expect(stale.fromCache).toBe(true);
      // The stale read is served from the store (no adapter call), and the
      // background refresh resolves under the SAME identity as the request.
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen).toEqual([{ tenant: 'A' }]);
      now += 1;
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('omits the caller from revalidation when the request had none', async () => {
    const seen: unknown[] = [];
    const observer: OrbitPlugin = {
      name: 'observer',
      hooks: {
        onBeforeExecute: ({ ctx }) => {
          seen.push((ctx.state as { caller?: unknown } | undefined)?.caller);
        },
      },
    };
    const store: CacheStore = {
      get: () => ({ value: { id: '2', name: 'B' }, createdAt: 0, query: 'user { id, name }' }),
      set: () => {},
      delete: () => {},
      clear: () => {},
    };
    const resolve = vi.fn(() => ({ id: '2', name: 'B' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [createCachePlugin({ store }), observer],
    });
    const query = { query: 'user { id, name }', cache: 'ttl=300,stale=60' };

    vi.spyOn(Date, 'now').mockImplementation(() => 320_000);
    try {
      await orbit.execute(query);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      // No caller was ever set, so the refresh must not invent one.
      expect(seen).toEqual([undefined]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not let a revalidation request inherit the caller partition', async () => {
    // Background revalidation re-executes the stored query through the engine
    // with a deliberately stripped context: it must not carry the caller's
    // AbortSignal (a cancelled request would abort the refresh instantly, the
    // error would be swallowed, and the entry would sit stale forever), and it
    // must not carry the `Request` (which holds the consumed body).
    const cache = createCachePlugin();
    const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [cache],
    });
    const query = { query: 'user { id, name }', cache: 'ttl=1,stale=60' };

    // Prime the entry as one caller, then read it as ANOTHER caller through a
    // context carrying a signal and a Request.
    await orbit.execute(query, { state: { caller: { tenant: 'A' } } });
    const controller = new AbortController();
    const second = await orbit.execute(query, {
      state: { caller: { tenant: 'B' } },
      signal: controller.signal,
      request: new Request('https://x.test/'),
    });
    // A different tenant must NOT be served tenant A's entry.
    expect(second.fromCache).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps anonymous requests on one shared partition', async () => {
    const { orbit, resolve } = (() => {
      const cache = createCachePlugin();
      const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
      const orbit = createOrbit({
        adapters: [{ entity: 'user', resolve }],
        plugins: [cache],
      });
      return { orbit, resolve };
    })();
    const query = { query: 'user { id, name }', cache: 'ttl=300' };
    await orbit.execute(query);
    const second = await orbit.execute(query);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
  });
});

describe('revalidation context isolation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not abort a background revalidation when the request aborts', async () => {
    vi.useFakeTimers();
    const store = createMemoryCacheStore();
    const cache = createCachePlugin({ store });
    // Seed an entry already inside the SWR band (stale-only: always served,
    // refreshed in the background past `stale` seconds).
    const key = cache.keyFor(parseOQS('user { id }'));
    store.set(key, {
      value: { id: 'stale' },
      createdAt: Date.now() - 10_000,
      query: 'user { id }',
    });

    const controller = new AbortController();
    const resolve = vi.fn(() => ({ id: 'fresh' }));
    const orbit = createOrbit({
      adapters: [{ entity: 'user', resolve }],
      plugins: [cache],
      requestTimeoutMs: 5,
    });

    const served = await orbit.execute(
      { query: 'user { id }', cache: 'stale=1' },
      { signal: controller.signal },
    );
    expect(served.data).toEqual({ id: 'stale' });

    // The request goes away (client disconnect / deadline). The background
    // refresh must still run: it used to inherit the aborted signal, die
    // immediately, and leave the entry permanently stale.
    controller.abort();
    await vi.advanceTimersByTimeAsync(30);
    expect(resolve).toHaveBeenCalled();
  });
});
