/**
 * Shared fixtures for the benchmark suite.
 *
 * Both sides of every comparison — Orbit (run.ts) and real GraphQL
 * (graphql.ts) — resolve the SAME data with the SAME shapes, so the
 * head-to-head measures engines, not fixture differences.
 */

export const users = Array.from({ length: 100 }, (_, i) => ({
  id: String(i + 1),
  name: `User ${i + 1}`,
  email: `user${i + 1}@orbit.dev`,
}));

export interface DeepNestData {
  posts: Array<{ id: string; title: string; authorId: string }>;
  comments: Array<{ id: string; text: string; postId: string }>;
  likes: Array<{ id: string; emoji: string; commentId: string }>;
  likedBy: Array<{ id: string; name: string; likeId: string }>;
}

/** The 5-level lazy graph: user → posts(10) → comments(100) → likes(1000) → likedBy(1000). */
export function buildDeepNest(): DeepNestData {
  const posts = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i + 1}`,
    title: `Post ${i + 1}`,
    authorId: '1',
  }));
  const comments = Array.from({ length: 100 }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Comment ${i + 1}`,
    postId: `p${(i % 10) + 1}`,
  }));
  const likes = Array.from({ length: 1000 }, (_, i) => ({
    id: `l${i + 1}`,
    emoji: '❤️',
    commentId: `c${(i % 100) + 1}`,
  }));
  const likedBy = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i + 1),
    name: `Liker ${i + 1}`,
    likeId: `l${i + 1}`,
  }));
  return { posts, comments, likes, likedBy };
}

/** Deterministic pseudo-random generator so feed content stays realistic (no huge repeated runs). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const SENTENCES = [
  'Orbit treats the query string as intent, never as schema.',
  'The core knows nothing of databases, only of moving data through hooks.',
  'Batching turns a thousand round-trips into a single call.',
  'Adapters translate verbatim filters into whatever your source speaks.',
  'Plugins are the nervous system; the core is the skeleton.',
  'MessagePack shrinks the wire without a single dependency.',
  'Stale-while-revalidate keeps reads fast and writes safe.',
  'A contract layer should stay thin enough to disappear.',
  'Streaming delivers the first byte before the last query finishes.',
  'Projection keeps the payload exactly as wide as the client asked.',
  'Error codes travel unmodified from adapter to client.',
  'No magic ORM, no clever query planner, no lock-in.',
  'The envelope is the only schema the protocol owns.',
  'Resolution order follows the shape of the tree, level by level.',
];

/**
 * 20 realistic posts whose JSON weighs in around the GraphQL reference (≈450 KB).
 * Content is varied (no giant repeated runs) so compression numbers are honest.
 */
export function buildFeed(): Array<{
  id: string;
  title: string;
  author: { id: string; name: string; avatar: string; bio: string };
  body: string;
  tags: string[];
  views: number;
  likes: number;
  comments: Array<{ id: string; text: string; by: { id: string; name: string } }>;
  createdAt: string;
}> {
  const rng = makeRng(42);
  return Array.from({ length: 20 }, (_, i) => {
    const paragraphs = Array.from({ length: 112 }, (_, p) => {
      const a = SENTENCES[Math.floor(rng() * SENTENCES.length)]!;
      const b = SENTENCES[Math.floor(rng() * SENTENCES.length)]!;
      const c = SENTENCES[Math.floor(rng() * SENTENCES.length)]!;
      return `${a} ${b} ${c} (paragraph ${i + 1}.${p + 1})`;
    });
    return {
      id: `post-${i + 1}`,
      title: `The future of data layers — part ${i + 1}`,
      author: {
        id: String((i % 5) + 1),
        name: `Author ${(i % 5) + 1}`,
        avatar: `https://cdn.example/avatars/a${(i % 5) + 1}.png`,
        bio: SENTENCES[i % SENTENCES.length]!,
      },
      body: paragraphs.join(' '),
      tags: ['orbit', 'graphql', 'zero-dependency', 'typescript', `topic-${(i % 3) + 1}`],
      views: 1200 + i * 137,
      likes: 89 + i * 3,
      comments: Array.from({ length: 4 }, (_, j) => ({
        id: `c${i}-${j}`,
        text: `Great read — comment ${j + 1} on post ${i + 1}.`,
        by: { id: `u${j + 1}`, name: `Reader ${j + 1}` },
      })),
      createdAt: `2026-08-0${(i % 9) + 1}T10:00:00Z`,
    };
  });
}
