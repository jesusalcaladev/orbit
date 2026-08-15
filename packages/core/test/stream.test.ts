import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../src/index.js';
import { createOrbit } from '../src/engine.js';
import { ErrorCode, OrbitError } from '../src/errors.js';

const users = [
  { id: '1', name: 'Ana' },
  { id: '2', name: 'Bruno' },
];
const posts = [
  { id: 'p1', authorId: '1', title: 'First' },
  { id: 'p2', authorId: '1', title: 'Second' },
  { id: 'p3', authorId: '2', title: 'Third' },
];

function makeOrbit() {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => {
          if (id) return users.find((u) => u.id === id);
          return users;
        },
      },
      {
        entity: 'posts',
        resolve: (_filters, ctx) => {
          const parent = ctx.parent;
          if (parent) return posts.filter((p) => p.authorId === (parent.data as { id: string }).id);
          return posts;
        },
      },
    ]),
  });
}

async function collect(events: AsyncGenerator<{ level: number | 'done'; data: unknown }>) {
  const out: Array<{ level: number | 'done'; data: unknown }> = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('orbit.stream', () => {
  it('emits the root level first, then relations, then done (consume as it arrives)', async () => {
    const orbit = makeOrbit();
    // Events carry a live view of the graph — the SSE handler serializes each
    // one the moment it arrives. Consume incrementally to observe the progress.
    const gen = orbit.stream({ query: 'user(id="1") { name, posts { title } }' });

    const first = await gen.next();
    expect(first.value).toEqual({ level: 0, data: { name: 'Ana' } }); // posts not resolved yet

    const second = await gen.next();
    expect(second.value).toEqual({
      level: 1,
      data: { name: 'Ana', posts: [{ title: 'First' }, { title: 'Second' }] },
    });

    const done = await gen.next();
    expect(done.value).toEqual({
      level: 'done',
      data: { name: 'Ana', posts: [{ title: 'First' }, { title: 'Second' }] },
    });
  });

  it('emits one level per depth of the tree', async () => {
    const orbit = makeOrbit();
    const events = await collect(orbit.stream({ query: 'user { name, posts { title } }' }));
    // level 0 = users (root-many), level 1 = posts, done
    expect(events.map((e) => e.level)).toEqual([0, 1, 'done']);
  });

  it('emits a single done event for short-circuits (cache hits)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ cached: true }) }]),
      plugins: [
        {
          name: 'stub',
          hooks: {
            onBeforeResolve: () => ({ shortCircuit: { name: 'Cached' } }),
          },
        },
      ],
    });
    const events = await collect(orbit.stream({ query: 'user(id="1") { name }' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ level: 'done', data: { name: 'Cached' }, fromCache: true });
  });

  it('applies onBeforeSerialize transforms to the final event only', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
      plugins: [
        {
          name: 'wrap',
          hooks: {
            onBeforeSerialize: ({ data }) => ({ user: data }),
          },
        },
      ],
    });
    const events = await collect(orbit.stream({ query: 'user { name }' }));
    expect(events[0]!.data).toEqual({ name: 'Ana' }); // partial: unwrapped
    expect(events[1]!.data).toEqual({ user: { name: 'Ana' } }); // done: wrapped
  });

  it('rejects mutations', async () => {
    const orbit = makeOrbit();
    await expect(collect(orbit.stream({ do: 'user.update', args: {} }))).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
  });

  it('carries the plugin-serialized contentType on the final done event', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
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
      ],
    });
    const events = [];
    for await (const event of orbit.stream({ query: 'user { name }' })) events.push(event);
    expect(events.at(-1)).toMatchObject({
      level: 'done',
      data: 'name:Ana',
      contentType: 'text/csv',
    });
  });

  it('normalizes errors through onError hooks', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => null }]),
      plugins: [
        {
          name: 'translate',
          hooks: {
            onError: ({ error }) => {
              if (error.code === ErrorCode.INTERNAL) {
                return new OrbitError(ErrorCode.FILTER_INVALID, 'mapped');
              }
            },
          },
        },
      ],
    });
    await expect(collect(orbit.stream({ query: 'ghost { id }' }))).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
    });
  });
});
