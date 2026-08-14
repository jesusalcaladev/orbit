import { ErrorCode, createOrbit, memoryAdapter } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createRateLimitPlugin } from '../src/index.js';

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
