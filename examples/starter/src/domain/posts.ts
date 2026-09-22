/**
 * Domain layer — posts.
 *
 * Pure TypeScript: the entity and an in-memory repository. Validation lives
 * here (plain `Error`s with user-facing messages); the adapter layer maps
 * those onto protocol errors. Zero Orbit imports on purpose.
 */

export interface Post {
  id: string;
  authorId: string;
  title: string;
  views: number;
  status: 'published' | 'draft';
}

/** Seed data so the starter runs out of the box — swap for your real source. */
export function seedPosts(): Post[] {
  return [
    { id: 'p1', authorId: '1', title: 'Why Orbit?', views: 1200, status: 'published' },
    { id: 'p2', authorId: '1', title: 'Hooks deep dive', views: 300, status: 'draft' },
    { id: 'p3', authorId: '2', title: 'Zero-dep parsing', views: 900, status: 'published' },
  ];
}

/**
 * In-memory repository: the single owner of post data. Queries return fresh
 * copies; mutations validate input and throw plain `Error`s — the adapter
 * translates them into the protocol's error contract.
 */
export class PostRepository {
  private readonly posts = new Map<string, Post>();
  private seq = 0;

  constructor(seed: Post[] = seedPosts()) {
    for (const post of seed) this.posts.set(post.id, { ...post });
    this.seq = seed.length;
  }

  byId(id: string): Post | null {
    const post = this.posts.get(id);
    return post ? { ...post } : null;
  }

  byAuthor(authorId: string): Post[] {
    return this.all().filter((post) => post.authorId === authorId);
  }

  byStatus(status: string): Post[] {
    return this.all().filter((post) => post.status === status);
  }

  all(): Post[] {
    return [...this.posts.values()].map((post) => ({ ...post }));
  }

  create(input: { authorId: string; title: string }): Post {
    const title = input.title.trim();
    if (title === '') throw new Error('A post needs a title');
    const post: Post = {
      id: `p${++this.seq}`,
      authorId: input.authorId,
      title,
      views: 0,
      status: 'published',
    };
    this.posts.set(post.id, post);
    return { ...post };
  }

  remove(id: string): boolean {
    return this.posts.delete(id);
  }
}
