/**
 * Orbit — zero-dependency demo server.
 *
 * A complete Orbit endpoint on top of node:http. No framework, no runtime
 * dependencies: the `handler` is a fetch-compatible function, so it drops
 * into Hono, Express, Cloudflare Workers, Bun or Deno unchanged.
 *
 * Run it with:  npm run example
 * Try it with:
 *   curl -s localhost:3000/orbit \
 *     -H 'content-type: application/json' \
 *     -d '{"query":"user(id=\"1\") { name, posts(status=\"published\") { title, views } }"}'
 */
// The example imports the built package so it runs with Node's native
// TypeScript support (`npm run example` builds first).
import { createServer } from 'node:http';
import { createCachePlugin, createOrbit, memoryAdapter } from '@orbit/core';
import type { OrbitContext } from '@orbit/core';

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
];

const posts: Post[] = [
  { id: 'p1', authorId: '1', title: 'Why Orbit?', views: 1200, status: 'published' },
  { id: 'p2', authorId: '1', title: 'Hooks deep dive', views: 300, status: 'draft' },
  { id: 'p3', authorId: '2', title: 'Zero-dep parsing', views: 900, status: 'published' },
];

const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id, role }): unknown => {
        let list = users;
        if (role) list = list.filter((u) => u.role === role);
        if (id) return list.find((u) => u.id === id);
        return list;
      },
      mutate: (action, { filter, payload }) => {
        const user = users.find((u) => u.id === filter?.id);
        if (!user) return { id: undefined };
        if (action === 'update' && payload) Object.assign(user, payload);
        return { id: user.id, invalidates: [`cache:user:${user.id}`] };
      },
    },
    {
      entity: 'posts',
      resolve: ({ id, status }, ctx: OrbitContext): unknown => {
        let list = posts;
        const parent = ctx.parent;
        if (parent) list = list.filter((p) => p.authorId === (parent.data as User).id);
        if (status) list = list.filter((p) => p.status === status);
        if (id) return list.find((p) => p.id === id);
        return list;
      },
    },
  ]),
  plugins: [createCachePlugin()],
});

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/orbit') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    const response = await orbit.handler(
      new Request('http://localhost:3000/orbit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );

    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    });
    res.end(await response.text());
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. POST /orbit with a JSON envelope.' }));
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log(`🛰  Orbit demo running on http://localhost:${PORT}/orbit`);
  console.log('    curl -s localhost:3000/orbit -H "content-type: application/json" \\');
  console.log('      -d \'{"query":"user(id=\\"1\\") { name, posts { title } }"}\'');
});
