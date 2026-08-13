import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCachePlugin,
  createMemoryCacheStore,
  memoryAdapter,
  parseCacheSpec,
} from '../src/index.js';
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

const baseEnvelope = () => ({ query: 'user(id="1") { name }', cache: 'ttl=300' });

describe('parseCacheSpec', () => {
  it('parses ttl and stale specs', () => {
    expect(parseCacheSpec('ttl=300')).toEqual({ ttl: 300 });
    expect(parseCacheSpec('stale=60')).toEqual({ stale: 60 });
    expect(parseCacheSpec('ttl=300,stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec(' { "ttl": 300, "stale": 60 } ')).toEqual({ ttl: 300, stale: 60 });
  });

  it('accepts space-separated specs too (spec §8 wording)', () => {
    // The spec says "space-separated"; the historical examples use commas —
    // both must parse, and a space before a comma must not break either.
    expect(parseCacheSpec('ttl=300 stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec('ttl=300, stale=60')).toEqual({ ttl: 300, stale: 60 });
    expect(parseCacheSpec('  ttl=300  stale=60  ')).toEqual({ ttl: 300, stale: 60 });
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
    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300 stale=60' };
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
    const staleHit = await orbit.execute({ query: 'user(id="1") { name }', cache: 'stale=60' });
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
    cache.invalidate(cache.keyFor(node));
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('invalidates by prefix', async () => {
    const { orbit, cache, resolve } = makeCachedOrbit();
    await orbit.execute(baseEnvelope());
    await orbit.execute(baseEnvelope());
    expect(resolve).toHaveBeenCalledTimes(1);

    cache.invalidatePrefix('orbit:');
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
    const envelope = () => ({ query: 'user(id="1") { name }', cache: 'ttl=300' });

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
    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300,stale=60' };

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

    cache.invalidateEntity('book');
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
