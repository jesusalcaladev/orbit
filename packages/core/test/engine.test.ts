import { describe, expect, it, vi } from 'vitest';
import { createOrbit } from '../src/engine.js';
import { ErrorCode, OrbitError } from '../src/errors.js';
import { memoryAdapter } from '../src/adapters/memory.js';
import type { DataAdapter } from '../src/adapters/types.js';
import type { Filters, OrbitContext } from '../src/types.js';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Post {
  id: string;
  authorId: string;
  title: string;
  views: number;
  status: 'published' | 'draft';
}

const users: User[] = [
  { id: '1', name: 'Ana', email: 'ana@orbit.dev', role: 'admin' },
  { id: '2', name: 'Bruno', email: 'bruno@orbit.dev', role: 'editor' },
  { id: '3', name: 'Carla', email: 'carla@orbit.dev', role: 'admin' },
];

const posts: Post[] = [
  { id: 'p1', authorId: '1', title: 'Why Orbit?', views: 1200, status: 'published' },
  { id: 'p2', authorId: '1', title: 'Hooks deep dive', views: 300, status: 'draft' },
  { id: 'p3', authorId: '2', title: 'Zero-dep parsing', views: 900, status: 'published' },
];

function blogAdapters(): DataAdapter[] {
  return memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id, role }) => {
        let list = users;
        if (role) list = list.filter((u) => u.role === role);
        if (id) return list.find((u) => u.id === id);
        return list;
      },
      mutate: (action, { filter, payload }) => {
        const user = users.find((u) => u.id === filter?.id);
        if (!user)
          throw new OrbitError(ErrorCode.FILTER_INVALID, `No user with id '${filter?.id}'`);
        if (action === 'update' && payload) Object.assign(user, payload);
        return { id: user.id, invalidates: [`cache:user:${user.id}`] };
      },
    },
    {
      entity: 'posts',
      resolve: ({ id, status }, ctx) => {
        let list = posts;
        if (ctx.parent) {
          const parent = ctx.parent.data as User;
          list = list.filter((p) => p.authorId === parent.id);
        }
        if (status) list = list.filter((p) => p.status === status);
        if (id) return list.find((p) => p.id === id);
        return list;
      },
    },
  ]);
}

function makeOrbit(overrides: Partial<Parameters<typeof createOrbit>[0]> = {}) {
  return createOrbit({ adapters: blogAdapters(), ...overrides });
}

describe('resolution', () => {
  it('resolves a single record and projects requested fields', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user(id="1") { name, email }' });
    expect(result.data).toEqual({ name: 'Ana', email: 'ana@orbit.dev' });
    expect(result.status).toBe(200);
  });

  it('returns the whole object when no selection is made', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user(id="1")' });
    expect(result.data).toEqual(users[0]);
  });

  it('resolves many records at the root', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user(role="admin") { name }' });
    expect(result.data).toEqual([{ name: 'Ana' }, { name: 'Carla' }]);
  });

  it('resolves nested relations with per-parent scope', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({
      query: 'user(id="1") { name, posts(status="published") { title, views } }',
    });
    expect(result.data).toEqual({
      name: 'Ana',
      posts: [{ title: 'Why Orbit?', views: 1200 }],
    });
  });

  it('resolves a relation for every parent record', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user { name, posts { title } }' });
    expect(result.data).toEqual([
      { name: 'Ana', posts: [{ title: 'Why Orbit?' }, { title: 'Hooks deep dive' }] },
      { name: 'Bruno', posts: [{ title: 'Zero-dep parsing' }] },
      { name: 'Carla', posts: [] },
    ]);
  });

  it('returns null when nothing matches', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user(id="nope") { name }' });
    expect(result.data).toBeNull();
  });

  it('passes filters verbatim to the adapter', async () => {
    const seen = vi.fn();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'thing',
          resolve: (filters: Filters, ctx: OrbitContext) => {
            seen(filters, ctx);
            return { id: filters.id };
          },
        },
      ]),
    });
    const result = await orbit.execute({ query: 'thing(id="001",status="a b") { id }' });
    expect(result.data).toEqual({ id: '001' });
    expect(seen).toHaveBeenCalledWith({ id: '001', status: 'a b' }, expect.any(Object));
  });

  it('exposes the parent context while resolving relations', async () => {
    const seen = vi.fn();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'a',
          resolve: () => ({ id: 'A' }),
        },
        {
          entity: 'b',
          resolve: (_filters, ctx) => {
            seen(ctx.parent);
            return [];
          },
        },
      ]),
    });
    await orbit.execute({ query: 'a { b { id } }' });
    expect(seen).toHaveBeenCalledWith({ entity: 'a', data: { id: 'A' } });
  });
});

describe('prototype-pollution safety', () => {
  it('projects a __proto__ field without rewriting the result prototype', async () => {
    const record = { id: '1', name: 'Ana', email: 'ana@orbit.dev' };
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => (id === '1' ? record : null),
        },
      ]),
    });
    const result = await orbit.execute({ query: 'user(id="1") { __proto__ }' });
    const data = result.data as Record<string, unknown>;
    // `__proto__` is requested as a field; the projected object must keep a
    // normal prototype and carry the field as an OWN key.
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    // The projected value mirrors the source record's own property: the
    // record inherits `__proto__` from Object.prototype, so the projected
    // own key holds exactly that value.
    expect(Object.getOwnPropertyDescriptor(data, '__proto__')?.value).toBe(
      Object.getPrototypeOf(record),
    );
  });

  it('resolves a __proto__ relation without rewriting the parent prototype', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => ({ id: '1', name: 'Ana' }),
        },
        {
          entity: '__proto__',
          resolve: () => ({ name: 'polluted?' }),
        },
      ]),
    });
    const result = await orbit.execute({ query: 'user { name, __proto__ { name } }' });
    const data = result.data as Record<string, unknown>;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    // The relation lands as an OWN key named `__proto__` — not a rewrite of
    // the result object's prototype.
    expect(Object.hasOwn(data, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(data, '__proto__')?.value).toBeDefined();
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });
});

describe('batching (N+1 mitigation)', () => {
  it('groups sibling requests into a single batch call', async () => {
    const batch = vi.fn(async (requests: { filters: Filters }[]) =>
      requests.map((r) => [{ from: r.filters }]),
    );
    const single = vi.fn(() => []);
    const orbit = createOrbit({
      adapters: [
        {
          entity: 'root',
          resolve: () => [{ id: '1' }, { id: '2' }, { id: '3' }],
        },
        {
          entity: 'child',
          resolve: single,
          batch: batch as never,
        },
      ],
    });
    const result = await orbit.execute({ query: 'root { child { from } }' });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    expect(batch.mock.calls[0]![0]).toHaveLength(3);
    expect(result.data).toEqual([
      { child: [{ from: {} }] },
      { child: [{ from: {} }] },
      { child: [{ from: {} }] },
    ]);
  });

  it('resolves in parallel when the adapter has no batch', async () => {
    const single = vi.fn(() => []);
    const orbit = createOrbit({
      adapters: [
        {
          entity: 'root',
          resolve: () => [{ id: '1' }, { id: '2' }],
        },
        {
          entity: 'child',
          resolve: single,
        },
      ],
    });
    await orbit.execute({ query: 'root { child { id } }' });
    expect(single).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when a batch returns the wrong number of results', async () => {
    const orbit = createOrbit({
      adapters: [
        {
          entity: 'root',
          resolve: () => [{ id: '1' }, { id: '2' }],
        },
        {
          entity: 'child',
          resolve: () => [],
          batch: () => Promise.resolve([{}]),
        },
      ],
    });
    await expect(orbit.execute({ query: 'root { child { id } }' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
  });
});

describe('errors', () => {
  it('rejects unregistered entities', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({ query: 'ghost { id }' })).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
      status: 404,
    });
  });

  it('rejects a missing query', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({})).rejects.toMatchObject({ code: ErrorCode.INVALID_QUERY });
    await expect(orbit.execute({ query: 42 as never })).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
  });

  it('rejects envelopes with both query and do', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({ query: 'user { id }', do: 'user.update' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
  });

  it('enforces maxQueryDepth', async () => {
    const orbit = makeOrbit({ maxQueryDepth: 2 });
    // `e` nests as a relation at depth 3, above the configured maximum of 2.
    await expect(orbit.execute({ query: 'a { b { c { d { e } } } }' })).rejects.toMatchObject({
      code: ErrorCode.MAX_DEPTH_EXCEEDED,
    });
  });

  it('propagates precise adapter errors', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => {
            throw new OrbitError(ErrorCode.FILTER_INVALID, 'Invalid UUID format');
          },
        },
      ]),
    });
    await expect(orbit.execute({ query: 'user(id="x")' })).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
      status: 400,
    });
  });

  it('wraps unexpected adapter errors as ORBIT_INTERNAL', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => {
            throw new Error('kaboom');
          },
        },
      ]),
    });
    await expect(orbit.execute({ query: 'user(id="1")' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      status: 500,
    });
  });
});

describe('mutations', () => {
  it('executes entity.action mutations and echoes the id', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({
      do: 'user.update',
      args: { filter: { id: '1' }, payload: { name: 'Anita' } },
    });
    expect(result.data).toEqual({ success: true, id: '1' });
    expect(users[0]!.name).toBe('Anita');
    expect(result.invalidates).toEqual(['cache:user:1']);
    // restore
    users[0]!.name = 'Ana';
  });

  it('re-queries the return graph after a mutation', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({
      do: 'user.update',
      args: { filter: { id: '2' }, payload: { name: 'Bruno X' } },
      return: 'user(id="2") { name, email }',
    });
    expect(result.data).toEqual({ name: 'Bruno X', email: 'bruno@orbit.dev' });
    users[1]!.name = 'Bruno';
  });

  it('runs auth gates on mutation return re-queries (no bypass)', async () => {
    // Mirrors the example-03 auth pattern: onBeforeParse stamps the caller,
    // onBeforeResolve enforces roles. A mutation's `return` sub-query must go
    // through the same pipeline, or a viewer could exfiltrate records.
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => ({ id: id ?? '1', name: 'Ana', email: 'ana@orbit.dev' }),
          mutate: () => ({ id: '1' }),
        },
      ]),
      plugins: [
        {
          name: 'auth',
          hooks: {
            onBeforeParse({ query, ctx }) {
              const state = (ctx.state ??= {});
              state.caller = ctx.headers?.get('x-api-key') === 'admin' ? 'admin' : 'viewer';
              return query;
            },
            onBeforeResolve({ ctx }) {
              if (ctx.state?.caller !== 'admin') {
                throw new OrbitError(
                  ErrorCode.PERMISSION_DENIED,
                  `Role '${ctx.state?.caller}' cannot query users`,
                );
              }
            },
          },
        },
      ],
    });

    // A viewer cannot read records through a mutation's `return`.
    await expect(
      orbit.execute(
        { do: 'user.update', args: {}, return: 'user { id, name, email }' },
        { headers: new Headers({ 'x-api-key': 'viewer' }) },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });

    // The admin's re-query resolves normally.
    const admin = await orbit.execute(
      { do: 'user.update', args: {}, return: 'user { id, name }' },
      { headers: new Headers({ 'x-api-key': 'admin' }) },
    );
    expect(admin.data).toEqual({ id: '1', name: 'Ana' });
  });

  it('rejects mutations on entities without a mutate handler', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({ do: 'posts.create', args: {} })).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('rejects malformed mutation actions', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({ do: 'update' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
    await expect(orbit.execute({ do: 'user.' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
  });

  it('rejects mutations on unregistered entities', async () => {
    const orbit = makeOrbit();
    await expect(orbit.execute({ do: 'ghost.create', args: {} })).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
    });
  });

  it('surfaces adapter mutation errors', async () => {
    const orbit = makeOrbit();
    await expect(
      orbit.execute({ do: 'user.update', args: { filter: { id: 'zzz' }, payload: {} } }),
    ).rejects.toMatchObject({ code: ErrorCode.FILTER_INVALID });
  });
});

describe('short-circuit & context', () => {
  it('serves short-circuited data without touching adapters', async () => {
    const resolve = vi.fn();
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [
        {
          name: 'stub',
          hooks: {
            onBeforeResolve: () => ({ shortCircuit: { stubbed: true } }),
          },
        },
      ],
    });
    const result = await orbit.execute({ query: 'user(id="1")' });
    expect(result.data).toEqual({ stubbed: true });
    expect(result.fromCache).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('shares plugin state through the context', async () => {
    const orbit = createOrbit({
      adapters: blogAdapters(),
      plugins: [
        {
          name: 'set-user',
          hooks: {
            onAfterParse: ({ ctx }) => {
              const state = (ctx.state ??= {});
              state.viewer = 'ana';
            },
          },
        },
        {
          name: 'see-user',
          hooks: {
            onBeforeExecute: ({ ctx }) => {
              expect(ctx.state?.viewer).toBe('ana');
            },
          },
        },
      ],
    });
    await orbit.execute({ query: 'user(id="1") { name }' });
  });
});
