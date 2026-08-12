import { describe, expect, it, vi } from 'vitest';
import { createCachePlugin, createOrbit, memoryAdapter } from '../src/index.js';
import { ErrorCode, OrbitError } from '../src/errors.js';
import type { DataAdapter } from '../src/index.js';
import type { OrbitPlugin } from '../src/index.js';

const users = [
  { id: '1', name: 'Ana', role: 'admin' },
  { id: '2', name: 'Bruno', role: 'editor' },
];
const posts = [
  { id: 'p1', authorId: '1', title: 'Why Orbit?', views: 10, status: 'published' },
  { id: 'p2', authorId: '1', title: 'Draft', views: 0, status: 'draft' },
  { id: 'p3', authorId: '2', title: 'Zero-dep', views: 5, status: 'published' },
];

/** Auth plugin: rejects non-admin viewers at the onBeforeResolve stage. */
const authPlugin: OrbitPlugin = {
  name: 'auth',
  hooks: {
    onBeforeResolve: ({ ctx }) => {
      if (ctx.state?.viewer !== 'admin') {
        throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admin role required');
      }
    },
  },
};

function makeApp() {
  const postsResolve = vi.fn();
  const adapters: DataAdapter[] = memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id }) => {
        if (id) return users.find((u) => u.id === id);
        return users;
      },
    },
    {
      entity: 'posts',
      resolve: ({ id, status }, ctx) => {
        postsResolve(ctx.parent ? 'relation' : 'root');
        let list = posts;
        const parent = ctx.parent;
        if (parent) list = list.filter((p) => p.authorId === (parent.data as (typeof users)[number]).id);
        if (status) list = list.filter((p) => p.status === status);
        if (id) return list.find((p) => p.id === id);
        return list;
      },
    },
  ]);
  const orbit = createOrbit({
    adapters,
    plugins: [authPlugin, createCachePlugin()],
  });
  return { orbit, postsResolve };
}

describe('integration — full pipeline', () => {
  it('blocks unauthorized viewers with 403', async () => {
    const { orbit } = makeApp();
    await expect(
      orbit.execute({ query: 'user(id="1") { name }' }, { state: { viewer: 'guest' } }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED, status: 403 });
  });

  it('serves the graph for authorized viewers', async () => {
    const { orbit } = makeApp();
    const result = await orbit.execute(
      { query: 'user(id="1") { name, posts(status="published") { title } }' },
      { state: { viewer: 'admin' } },
    );
    expect(result.data).toEqual({ name: 'Ana', posts: [{ title: 'Why Orbit?' }] });
  });

  it('batches the same relation across parents into one adapter call', async () => {
    const { orbit } = makeApp();
    const postsAdapter = orbit.adapters.get('posts')!;
    const batchSpy = vi.spyOn(postsAdapter, 'batch');

    await orbit.execute(
      { query: 'user { name, posts { title } }' },
      { state: { viewer: 'admin' } },
    );

    // 2 parent users → ONE batched call with both requests (N+1 fix).
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(2);
    batchSpy.mockRestore();
  });

  it('caches per-viewer because short-circuit happens after auth', async () => {
    const { orbit, postsResolve } = makeApp();
    const envelope = { query: 'user(id="1") { name }', cache: 'ttl=300' };
    const ctx = { state: { viewer: 'admin' } };

    const first = await orbit.execute(envelope, ctx);
    expect(first.fromCache).toBe(false);
    const second = await orbit.execute(envelope, ctx);
    expect(second.fromCache).toBe(true);
    expect(postsResolve).toHaveBeenCalledTimes(0);
  });

  it('end-to-end through the HTTP handler', async () => {
    const { orbit } = makeApp();
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name, posts { title } }' }),
    });
    const response = await orbit.handler(request, { state: { viewer: 'admin' } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string; posts: { title: string }[] } };
    expect(body.data.name).toBe('Ana');
    expect(body.data.posts).toHaveLength(2);
  });

  it('propagates the auth error through the handler with a 403', async () => {
    const { orbit } = makeApp();
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});
