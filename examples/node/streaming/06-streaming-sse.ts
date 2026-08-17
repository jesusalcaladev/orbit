/**
 * 06 — Streaming: text/event-stream, through @orbit/client
 *
 * With `accept: text/event-stream`, the handler streams the graph level by
 * level — the root user arrives as soon as its adapter answers, then each
 * relation level follows. `client.stream()` turns those frames into an async
 * iterable, so clients can render progressively instead of waiting for the
 * whole tree (great for deep graphs on slow networks).
 *
 * Run:  node examples/node/streaming/06-streaming-sse.ts   (after `npm run build`)
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createClient } from '@orbit/client';

const users = [{ id: '1', name: 'Ana' }];
const posts = [
  { id: 'p1', authorId: '1', title: 'Why Orbit?' },
  { id: 'p2', authorId: '1', title: 'Hooks deep dive' },
];

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => (id ? users.find((u) => u.id === id) : users) },
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

/** A tiny relay: POST /orbit → orbit.handler, byte-for-byte back. */
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/orbit') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('POST /orbit');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const response = await orbit.handler(
    new Request(`http://localhost${req.url ?? '/orbit'}`, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] ?? 'application/json',
        accept: req.headers.accept ?? 'application/json',
        ...(req.headers['accept-encoding']
          ? { 'accept-encoding': String(req.headers['accept-encoding']) }
          : {}),
      },
      body: Buffer.concat(chunks),
    }),
  );
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') ?? 'application/json',
    ...(response.headers.get('content-encoding')
      ? { 'content-encoding': response.headers.get('content-encoding')! }
      : {}),
  });
  if (response.body) {
    // Stream the body through (SSE arrives frame by frame) and forward
    // `content-encoding` — the client gunzips gzip responses itself.
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
});

export async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = createClient({ baseUrl: `http://127.0.0.1:${port}/orbit` });

  // The client streams the graph level by level — the root user first, then
  // its posts relation, then a final `done` frame with the full tree.
  for await (const frame of client.stream('user(id="1") { name, posts { title } }')) {
    console.log(`frame: level=${frame.level} data=${JSON.stringify(frame.data)}`);
  }

  client.close();
  server.close();
  server.closeAllConnections();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
