import { describe, expect, it, vi } from 'vitest';
import { createOrbit } from '../src/engine.js';
import { ErrorCode, OrbitError } from '../src/errors.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import type { OrbitPlugin } from '../src/plugins/types.js';
import { memoryAdapter } from '../src/adapters/memory.js';

const users = [{ id: '1', name: 'Ana', email: 'ana@orbit.dev', role: 'admin' }];

function makeOrbit(plugins: OrbitPlugin[]) {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => users.find((u) => u.id === id),
      },
    ]),
    plugins,
  });
}

const noopPlugin: OrbitPlugin = { name: 'noop', hooks: {} };

describe('PluginRegistry', () => {
  it('registers plugins in order', () => {
    const registry = new PluginRegistry();
    registry.register([{ name: 'a', hooks: {} }, { name: 'b', hooks: {} }]);
    expect(registry.list.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('accepts a single plugin or an array', () => {
    const registry = new PluginRegistry();
    registry.register({ name: 'one', hooks: {} });
    registry.register([{ name: 'two', hooks: {} }]);
    expect(registry.list).toHaveLength(2);
  });

  it('rejects duplicate plugin names', () => {
    const registry = new PluginRegistry();
    registry.register({ name: 'dup', hooks: {} });
    expect(() => registry.register({ name: 'dup', hooks: {} })).toThrow(/already registered/);
  });

  it('rejects malformed plugins', () => {
    const registry = new PluginRegistry();
    expect(() => registry.register({ name: '', hooks: {} } as never)).toThrow(/name/);
    expect(() => registry.register({ name: 'x' } as never)).toThrow(/hooks/);
  });
});

describe('hook lifecycle', () => {
  it('runs onBeforeParse before parsing, allowing query rewrites', async () => {
    const rewrite: OrbitPlugin = {
      name: 'rewrite',
      hooks: {
        onBeforeParse: ({ query }) => query.replace(/\bu\s*\(/, 'user('),
      },
    };
    const orbit = makeOrbit([rewrite]);
    const result = await orbit.execute({ query: 'u(id="1") { name }' });
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('runs onAfterParse after parsing, allowing the node to be replaced', async () => {
    const swap: OrbitPlugin = {
      name: 'swap',
      hooks: {
        onAfterParse: () => ({ entity: 'user', filters: { id: '1' }, fields: ['name'], relations: {}, origin: 'client' as const }),
      },
    };
    const orbit = makeOrbit([swap]);
    const result = await orbit.execute({ query: 'user(id="999") { email }' });
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('short-circuits via onBeforeResolve and flags fromCache', async () => {
    const cache: OrbitPlugin = {
      name: 'mock-cache',
      hooks: {
        onBeforeResolve: () => ({ shortCircuit: { name: 'Cached Ana' } }),
      },
    };
    const resolve = vi.fn(({ id }: { id?: string }) => users.find((u) => u.id === id));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [cache],
    });
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.data).toEqual({ name: 'Cached Ana' });
    expect(result.fromCache).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('runs onBeforeExecute per entity, allowing filter adjustments', async () => {
    const enforceRole: OrbitPlugin = {
      name: 'enforce-role',
      hooks: {
        onBeforeExecute: ({ entity, filters }) => {
          if (entity === 'user') return { filters: { ...filters, role: 'admin' } };
        },
      },
    };
    const seen = vi.fn();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id, role }, ctx) => {
            seen({ id, role });
            void ctx;
            return users.find((u) => u.id === id && (!role || u.role === role));
          },
        },
      ]),
      plugins: [enforceRole],
    });
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.data).toEqual({ name: 'Ana' });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }));
  });

  it('runs onAfterResolve per node, allowing result transforms', async () => {
    const mask: OrbitPlugin = {
      name: 'mask',
      hooks: {
        onAfterResolve: ({ result }) =>
          typeof result === 'object' && result !== null
            ? { ...(result as Record<string, unknown>), email: '***' }
            : result,
      },
    };
    const orbit = makeOrbit([mask]);
    const result = await orbit.execute({ query: 'user(id="1") { name, email }' });
    expect(result.data).toEqual({ name: 'Ana', email: '***' });
  });

  it('runs onBeforeSerialize on the final data', async () => {
    const wrap: OrbitPlugin = {
      name: 'wrap',
      hooks: {
        onBeforeSerialize: ({ data }) => ({ user: data }),
      },
    };
    const orbit = makeOrbit([wrap]);
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.data).toEqual({ user: { name: 'Ana' } });
  });

  it('translates errors through onError', async () => {
    const translator: OrbitPlugin = {
      name: 'translator',
      hooks: {
        onError: ({ error }) => {
          if (error.code === ErrorCode.INTERNAL) {
            return new OrbitError(ErrorCode.FILTER_INVALID, 'filter was bad');
          }
        },
      },
    };
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => {
            throw new Error('db exploded');
          },
        },
      ]),
      plugins: [translator],
    });
    await expect(orbit.execute({ query: 'user(id="1")' })).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
      status: 400,
    });
  });

  it('runs hooks in registration order across plugins', async () => {
    const log: string[] = [];
    const mk = (name: string, hook: keyof NonNullable<OrbitPlugin['hooks']>): OrbitPlugin => ({
      name,
      hooks: {
        [hook]: () => {
          log.push(`${name}:${hook}`);
        },
      },
    });
    const orbit = makeOrbit([mk('first', 'onBeforeParse'), mk('second', 'onBeforeParse')]);
    await orbit.execute({ query: 'user(id="1") { name }' });
    expect(log).toEqual(['first:onBeforeParse', 'second:onBeforeParse']);
  });

  it('exposes plugins on the engine', () => {
    const orbit = makeOrbit([noopPlugin]);
    expect(orbit.plugins.list.map((p) => p.name)).toEqual(['noop']);
  });
});
