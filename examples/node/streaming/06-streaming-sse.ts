/**
 * 06 — Streaming: text/event-stream
 *
 * With `accept: text/event-stream`, the handler streams the graph level by
 * level — the root user arrives as soon as its adapter answers, then each
 * relation level follows. Clients can render progressively instead of
 * waiting for the whole tree (great for deep graphs on slow networks).
 *
 * Run:  node examples/node/06-streaming-sse.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit, memoryAdapter, SSE_CONTENT_TYPE } from '@orbit/core';

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

export async function main(): Promise<void> {
  const response = await orbit.handler(
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: SSE_CONTENT_TYPE },
      body: JSON.stringify({ query: 'user(id="1") { name, posts { title } }' }),
    }),
  );

  console.log('content-type:', response.headers.get('content-type'));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6);
      if (data) console.log('frame:', data);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
