import { ErrorCode, createOrbit, memoryAdapter } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createMemoryRateLimitStore, createRateLimitPlugin } from '../src/index.js';
import type { BucketParams, RateLimitBucketStore, RateLimiter } from '../src/index.js';

/** Fake clock so refill math is deterministic. */
function fakeClock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

function makeOrbit(plugin: ReturnType<typeof createRateLimitPlugin>) {
  return createOrbit({
    adapters: memoryAdapter([
      { entity: 'user', resolve: ({ id }) => ({ id: id ?? '1' }) },
      { entity: 'todo', resolve: () => null, mutate: () => ({ id: 't1' }) },
    ]),
    plugins: [plugin],
  });
}

describe('createRateLimitPlugin', () => {
  it('allows up to limit requests, then rejects with 429', async () => {
    const clock = fakeClock();
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 3, now: clock.now });
    const orbit = makeOrbit(plugin);

    for (let i = 0; i < 3; i += 1) {
      await expect(orbit.execute({ query: 'user { id }' })).resolves.toMatchObject({ status: 200 });
    }
    await expect(orbit.execute({ query: 'user { id }' })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      status: 429,
    });
  });

  it('refills tokens over the window', async () => {
    const clock = fakeClock();
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 2, now: clock.now });
    const orbit = makeOrbit(plugin);

    await orbit.execute({ query: 'user { id }' });
    await orbit.execute({ query: 'user { id }' });
    await expect(orbit.execute({ query: 'user { id }' })).rejects.toMatchObject({ status: 429 });

    // 30 s later, half the bucket has refilled (1 token back).
    clock.advance(30_000);
    await expect(orbit.execute({ query: 'user { id }' })).resolves.toMatchObject({ status: 200 });
    await expect(orbit.execute({ query: 'user { id }' })).rejects.toMatchObject({ status: 429 });
  });

  it('gates mutations too (onBeforeParse runs before adapter.mutate)', async () => {
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 1 });
    const orbit = makeOrbit(plugin);

    await expect(orbit.execute({ do: 'todo.create', args: {} })).resolves.toMatchObject({
      status: 200,
    });
    await expect(orbit.execute({ do: 'todo.create', args: {} })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
  });

  it('keys buckets by keyOf (per-user limits)', async () => {
    const plugin = createRateLimitPlugin({
      windowMs: 60_000,
      limit: 1,
      keyOf: (ctx) => String((ctx.state as { user?: string } | undefined)?.user ?? 'anon'),
    });
    const orbit = makeOrbit(plugin);
    const ctx = (user: string) => ({ state: { user } });

    await expect(orbit.execute({ query: 'user { id }' }, ctx('ana'))).resolves.toMatchObject({
      status: 200,
    });
    await expect(orbit.execute({ query: 'user { id }' }, ctx('ana'))).rejects.toMatchObject({
      status: 429,
    });
    // A different user has their own bucket.
    await expect(orbit.execute({ query: 'user { id }' }, ctx('bruno'))).resolves.toMatchObject({
      status: 200,
    });
  });

  it('reports retryAfterMs in details', async () => {
    const plugin = createRateLimitPlugin({ windowMs: 10_000, limit: 1 });
    const orbit = makeOrbit(plugin);
    await orbit.execute({ query: 'user { id }' });
    const caught = await orbit.execute({ query: 'user { id }' }).catch((e) => e);
    expect(caught.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(caught.status).toBe(429);
    expect(caught.details.retryAfterMs).toBeGreaterThan(0);
    expect(caught.details.limit).toBe(1);
  });

  it('supports a custom onExceeded error', async () => {
    const plugin = createRateLimitPlugin({
      windowMs: 60_000,
      limit: 1,
      onExceeded: (_ctx, key) => new Error(`slow down, ${key}`),
    });
    const orbit = makeOrbit(plugin);
    await orbit.execute({ query: 'user { id }' });
    // A plain Error from onExceeded is sanitized by the engine — the code
    // becomes ORBIT_INTERNAL and the message never leaks. (Return an
    // OrbitError if you want a precise client-facing code.)
    await expect(orbit.execute({ query: 'user { id }' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
  });

  it('reset() drops every bucket', async () => {
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 1 });
    const orbit = makeOrbit(plugin);
    await orbit.execute({ query: 'user { id }' });
    await expect(orbit.execute({ query: 'user { id }' })).rejects.toMatchObject({ status: 429 });
    plugin.reset();
    await expect(orbit.execute({ query: 'user { id }' })).resolves.toMatchObject({ status: 200 });
  });

  it('defaults keyOf to x-forwarded-for, x-real-ip, then anonymous', async () => {
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 1 });
    const orbit = makeOrbit(plugin);
    const withHeaders = (name: string, value: string) => ({
      headers: new Headers({ [name]: value }),
    });

    await expect(
      orbit.execute({ query: 'user { id }' }, withHeaders('x-forwarded-for', '1.2.3.4')),
    ).resolves.toMatchObject({ status: 200 });
    // Same IP → same bucket → denied.
    await expect(
      orbit.execute({ query: 'user { id }' }, withHeaders('x-forwarded-for', '1.2.3.4, 9.9.9.9')),
    ).rejects.toMatchObject({ status: 429 });
    // Different IP → own bucket.
    await expect(
      orbit.execute({ query: 'user { id }' }, withHeaders('x-forwarded-for', '5.6.7.8')),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe('createMemoryRateLimitStore', () => {
  const params: BucketParams = { limit: 2, rate: 2 / 60_000, windowMs: 60_000 };

  it('consumes tokens, then reports retryAfterMs, then refills', async () => {
    const store = createMemoryRateLimitStore();
    expect(await store.consume('k', params, 0)).toEqual({ ok: true });
    expect(await store.consume('k', params, 0)).toEqual({ ok: true });
    const denied = await store.consume('k', params, 0);
    expect(denied).toMatchObject({ ok: false });
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0);

    // A full window later the bucket is back to capacity.
    expect(await store.consume('k', params, 60_001)).toEqual({ ok: true });
    expect(store.bucketCount).toBe(1);
    store.reset?.();
    expect(store.bucketCount).toBe(0);
  });

  it('keys buckets independently', async () => {
    const store = createMemoryRateLimitStore();
    expect(await store.consume('a', params, 0)).toEqual({ ok: true });
    expect(await store.consume('a', params, 0)).toEqual({ ok: true }); // 2 → 1 → 0
    expect(await store.consume('a', params, 0)).toMatchObject({ ok: false });
    expect(await store.consume('b', params, 0)).toEqual({ ok: true }); // own bucket
    expect(store.bucketCount).toBe(2);
  });
});

describe('pluggable bucket store', () => {
  it('delegates the whole decision to an injected store (params + clock)', async () => {
    const consumed: Array<{ key: string; params: BucketParams; now: number }> = [];
    const store: RateLimitBucketStore = {
      consume: (key, params, now) => {
        consumed.push({ key, params, now });
        return { ok: true };
      },
    };
    const plugin = createRateLimitPlugin({
      windowMs: 60_000,
      limit: 5,
      store,
      now: () => 1234,
    });
    const orbit = makeOrbit(plugin);
    await orbit.execute({ query: 'user { id }' });

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ key: 'anonymous', now: 1234 });
    expect(consumed[0]!.params).toEqual({ limit: 5, rate: 5 / 60_000, windowMs: 60_000 });
    expect(plugin.store).toBe(store);
  });

  it('surfaces the store verdict through the 429 error (retryAfterMs)', async () => {
    const store: RateLimitBucketStore = {
      consume: () => ({ ok: false, retryAfterMs: 42 }) as const,
    };
    const plugin = createRateLimitPlugin({ windowMs: 60_000, limit: 1, store });
    const orbit = makeOrbit(plugin);
    const caught = await orbit.execute({ query: 'user { id }' }).catch((e) => e);
    expect(caught.code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(caught.status).toBe(429);
    expect(caught.details.retryAfterMs).toBe(42);
  });
});

describe('provides channel (ctx.providers.rateLimiter)', () => {
  it('exposes the limiter sharing the SAME buckets as the request gate', async () => {
    const plugin = createRateLimitPlugin({
      windowMs: 60_000,
      limit: 1,
      keyOf: (ctx) => ctx.headers?.get('x-key') ?? 'anon',
    });
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: async (_filters, ctx) => {
            const limiter = ctx.providers?.rateLimiter as RateLimiter | undefined;
            const key = ctx.headers?.get('x-key') ?? 'anon';
            // The gate already consumed the only token for THIS key — the
            // provider handle must hit the exact same shared bucket.
            const result = await limiter?.consume(key);
            return { id: '1', adapterAllowed: result?.ok === true };
          },
        },
      ]),
      plugins: [plugin],
    });
    const ctx = { headers: new Headers({ 'x-key': 'ana' }) };

    const first = await orbit.execute({ query: 'user { id, adapterAllowed }' }, ctx);
    expect(first.data).toEqual({ id: '1', adapterAllowed: false });
    await expect(orbit.execute({ query: 'user { id }' }, ctx)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('provides under a custom name, or not at all (provideAs)', async () => {
    const adapters = memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]);
    const named = createOrbit({
      adapters,
      plugins: [createRateLimitPlugin({ windowMs: 60_000, limit: 5, provideAs: 'limits' })],
    });
    expect(named.providers.limits).toBeDefined();
    expect(named.providers.rateLimiter).toBeUndefined();

    const none = createOrbit({
      adapters,
      plugins: [createRateLimitPlugin({ windowMs: 60_000, limit: 5, provideAs: false })],
    });
    expect(none.providers.rateLimiter).toBeUndefined();
  });

  it('rejects a colliding provider name from another plugin at boot', () => {
    const colliding: import('@orbit/core').OrbitPlugin = {
      name: 'custom-limiter',
      hooks: {},
      provides: { rateLimiter: { consume: () => ({ ok: true }) } },
    };
    expect(() =>
      createOrbit({
        adapters: memoryAdapter([{ entity: 'user', resolve: () => ({}) }]),
        plugins: [createRateLimitPlugin({ windowMs: 60_000, limit: 5 }), colliding],
      }),
    ).toThrow(/Provider 'rateLimiter'.*'orbit-rate-limit'.*'custom-limiter'/);
  });
});
