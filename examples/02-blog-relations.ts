/**
 * 02 — Relations, batching & mutations
 *
 * A blog graph: `user { posts { comments { author } } }`. The engine walks
 * the tree breadth-first and groups sibling requests by entity — when the
 * adapter implements `batch`, N parents resolve in ONE call (the N+1 fix).
 *
 * The `resolve` counter shows the difference: 2 users × 3 posts would be
 * 6 round-trips without batching; here it is a single batched call.
 *
 * Run:  node examples/02-blog-relations.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit, memoryAdapter } from '../dist/index.js';

interface User {
  id: string;
  name: string;
}

interface Post {
  id: string;
  authorId: string;
  title: string;
}

interface Comment {
  id: string;
  postId: string;
  text: string;
}

const users: User[] = [
  { id: '1', name: 'Ana' },
  { id: '2', name: 'Bruno' },
];
const posts: Post[] = [
  { id: 'p1', authorId: '1', title: 'Why Orbit?' },
  { id: 'p2', authorId: '1', title: 'Hooks deep dive' },
  { id: 'p3', authorId: '2', title: 'Zero-dep parsing' },
];
const comments: Comment[] = [
  { id: 'c1', postId: 'p1', text: 'Great post!' },
  { id: 'c2', postId: 'p1', text: 'Subscribed.' },
  { id: 'c3', postId: 'p3', text: 'Nice.' },
];

let postResolves = 0;

const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id }) => {
        if (id) return users.find((u) => u.id === id);
        return users;
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
      // `batch` is inherited from memoryAdapter — count how often `resolve`
      // actually runs: siblings share ONE batched call.
      resolve: ({ id }, ctx) => {
        postResolves += 1;
        let list = posts;
        const parent = ctx.parent;
        if (parent) list = list.filter((p) => p.authorId === (parent.data as User).id);
        if (id) return list.find((p) => p.id === id);
        return list;
      },
    },
    {
      entity: 'comments',
      resolve: (_filters, ctx) => {
        const parent = ctx.parent;
        if (parent) return comments.filter((c) => c.postId === (parent.data as Post).id);
        return comments;
      },
    },
  ]),
});

export async function main(): Promise<void> {
  postResolves = 0;

  // One request fetches the whole graph — no N+1, no waterfall.
  const graph = await orbit.execute({
    query: 'user { name, posts { title, comments { text } } }',
  });
  console.log('graph:', JSON.stringify(graph.data, null, 2));
  console.log(`posts resolve() calls for the whole graph: ${postResolves}`);

  // A mutation with a re-query (`return` clause).
  const mutated = await orbit.execute({
    do: 'user.update',
    args: { filter: { id: '2' }, payload: { name: 'Bruno v2' } },
    return: 'user(id="2") { name }',
  });
  console.log('after mutation:', JSON.stringify(mutated.data));
  if (mutated.invalidates) console.log('invalidates:', JSON.stringify(mutated.invalidates));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
