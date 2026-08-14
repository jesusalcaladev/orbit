import { describe, expect, it } from 'vitest';
import { createOrbit, memoryAdapter } from '../src/index.js';
import { ErrorCode, OrbitError } from '../src/index.js';
import { SubscriptionHub } from '../src/index.js';
import type { OrbitPlugin } from '../src/index.js';

const db = { name: 'the-db', ping: () => 'pong' };

function providerPlugin(name: string, provides: Record<string, unknown>): OrbitPlugin {
  return { name, provides, hooks: {} };
}

describe('plugin service injection (provides → ctx.providers, spec §11 🧪)', () => {
  it('injects declared services before ANY hook runs and into adapters', async () => {
    const seen: unknown[] = [];
    const plugin: OrbitPlugin = {
      name: 'db-plugin',
      provides: { db },
      hooks: {
        // The earliest hook — providers must already be there.
        onBeforeParse({ ctx }) {
          seen.push(ctx.providers?.db);
        },
        onAfterParse({ ctx }) {
          seen.push(ctx.providers?.db);
        },
        onBeforeResolve({ ctx }) {
          seen.push(ctx.providers?.db);
        },
      },
    };
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          // Adapters receive the same injected services via ctx.
          resolve: (_filters, ctx) => ({ id: '1', seen: ctx.providers?.db }),
        },
      ]),
      plugins: [plugin],
    });

    const result = await orbit.execute({ query: 'user(id="1") { id, seen }' });
    expect((result.data as { seen: unknown }).seen).toBe(db);
    expect(seen.every((value) => value === db)).toBe(true);

    // Streaming executes through the same ctx materialization.
    const streamed: unknown[] = [];
    const streamPlugin: OrbitPlugin = {
      name: 'stream-watcher',
      hooks: { onBeforeParse: ({ ctx }) => void streamed.push(ctx.providers?.db) },
    };
    const orbit2 = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
      plugins: [providerPlugin('db2', { db }), streamPlugin],
    });
    for await (const event of orbit2.stream({ query: 'user { id }' })) {
      expect(event).toBeDefined();
    }
    expect(streamed[0]).toBe(db);
  });

  it('is a boot-time singleton: the same frozen instance on every request', async () => {
    const captured: Array<Readonly<Record<string, unknown>> | undefined> = [];
    const plugin: OrbitPlugin = {
      name: 'watch',
      provides: { db },
      hooks: { onBeforeParse: ({ ctx }) => void captured.push(ctx.providers) },
    };
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
      plugins: [plugin],
    });
    await orbit.execute({ query: 'user { id }' });
    await orbit.execute({ query: 'user { id }' });
    expect(captured.length).toBe(2);
    expect(captured[0]).toBe(captured[1]);
    expect(Object.isFrozen(captured[0])).toBe(true);
    expect(captured[0]?.db).toBe(db);
  });

  it('is ordering-independent: a plugin registered BEFORE the provider sees the service', async () => {
    const consumed: unknown[] = [];
    const consumer: OrbitPlugin = {
      name: 'consumer',
      // Registered first — its hooks run before the provider's, but providers
      // are materialized before the pipeline starts, so ordering never matters.
      hooks: { onBeforeParse: ({ ctx }) => void consumed.push(ctx.providers?.config) },
    };
    const provider = providerPlugin('provider', { config: { tenant: 'acme' } });
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
      plugins: [consumer, provider],
    });
    await orbit.execute({ query: 'user { id }' });
    expect(consumed[0]).toEqual({ tenant: 'acme' });
  });

  it('reaches mutations: onBeforeParse and the adapter mutate both see providers', async () => {
    const seenInHook: unknown[] = [];
    const plugin: OrbitPlugin = {
      name: 'db-plugin',
      provides: { db },
      hooks: { onBeforeParse: ({ ctx }) => void seenInHook.push(ctx.providers?.db) },
    };
    const mutateSeen: unknown[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => ({ id: '1' }),
          mutate: (_action, _args, ctx) => {
            mutateSeen.push(ctx.providers?.db);
            return { id: '1' };
          },
        },
      ]),
      plugins: [plugin],
    });
    const result = await orbit.execute({ do: 'user.update' });
    expect(result.data).toEqual({ success: true, id: '1' });
    expect(seenInHook[0]).toBe(db);
    expect(mutateSeen[0]).toBe(db);
  });

  it('rejects duplicate provider names at boot, naming both plugins', () => {
    const a = providerPlugin('a', { shared: 1 });
    const b = providerPlugin('b', { shared: 2 });
    expect(() => createOrbit({ plugins: [a, b] })).toThrow(/Provider 'shared'.*'a'.*'b'/);
  });

  it('rejects reserved prototype names at boot', () => {
    expect(() =>
      createOrbit({
        plugins: [providerPlugin('bad', { ['__proto__']: { evil: true } })],
      }),
    ).toThrow(/reserved name '__proto__'/);
    expect(() => createOrbit({ plugins: [providerPlugin('bad2', { constructor: 1 })] })).toThrow(
      /reserved name 'constructor'/,
    );
  });

  it('replaces caller-supplied ctx.providers with the engine container', async () => {
    const seen: unknown[] = [];
    const plugin: OrbitPlugin = {
      name: 'watch',
      provides: { db },
      hooks: { onBeforeParse: ({ ctx }) => void seen.push(ctx.providers) },
    };
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
      plugins: [plugin],
    });
    // A caller trying to smuggle its own providers must not win: plugins are
    // the single source of truth for this channel (per-request values belong
    // in ctx.state, which the spread preserves).
    await orbit.execute({ query: 'user { id }' }, { providers: { evil: true } });
    expect(seen[0]).not.toHaveProperty('evil');
    expect((seen[0] as Record<string, unknown>).db).toBe(db);
  });

  it('seeds the realtime subscription gates (hub.authorizedSubscribe)', async () => {
    const plugin: OrbitPlugin = {
      name: 'feature-gate',
      provides: { features: { beta: true } },
      hooks: {
        // Denies the subscription unless the provider made it here — if the
        // hub forgot to merge providers, every subscribe would be denied.
        onBeforeResolve({ ctx }) {
          const features = ctx.providers?.features as { beta?: boolean } | undefined;
          if (features?.beta !== true) {
            throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'beta not enabled');
          }
        },
      },
    };
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'user', resolve: () => ({ id: '1' }), subscribe: () => () => {} },
      ]),
      plugins: [plugin],
    });
    const hub = new SubscriptionHub(orbit);
    // No session ctx at all — providers still arrive from the engine.
    await expect(
      hub.authorizedSubscribe('user(id="1") { id }', 'sub-1', () => {}, {}),
    ).resolves.toBeDefined();
    hub.close();
  });
});
