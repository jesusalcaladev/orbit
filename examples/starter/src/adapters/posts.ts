/**
 * Adapter layer — the `posts` entity (queries + mutations).
 *
 * Queries resolve relations through `ctx.parent`; mutations enforce roles
 * here (authorization for writes lives next to the data it writes), map
 * domain errors onto the protocol's error contract, and name what they
 * invalidate so both server and client caches evict precisely.
 */
import { ErrorCode, memoryAdapter, OrbitError } from '@orbit/core';
import type { DataAdapter } from '@orbit/core';
import type { User } from '../domain/users.ts';
import type { PostRepository } from '../domain/posts.ts';
import { requireCaller } from '../plugins/authz.ts';

export function createPostsAdapter(posts: PostRepository): DataAdapter[] {
  return memoryAdapter([
    {
      entity: 'posts',
      // Root lookup by filter, or scoped to the resolved parent (the
      // `user { posts }` relation). Filters stay verbatim strings and apply
      // in *both* modes — a relation carries its own filters per parent.
      resolve: ({ id, status }, ctx) => {
        const parent = ctx.parent?.data as User | undefined;
        if (id) return posts.byId(String(id));
        if (parent) {
          const own = posts.byAuthor(parent.id);
          return status ? own.filter((post) => post.status === status) : own;
        }
        return status ? posts.byStatus(String(status)) : posts.all();
      },
      async mutate(action, args, ctx) {
        const caller = requireCaller(ctx); // writes always need a caller

        if (action === 'create') {
          const payload = (args.payload ?? {}) as { title?: unknown };
          try {
            const post = posts.create({
              authorId: caller.id,
              title: String(payload.title ?? ''),
            });
            // Entity-scoped invalidation (spec §8): the engine also evicts
            // every cached query that reads `posts`, and this key tells the
            // *client* what to clear.
            return { id: post.id, invalidates: ['posts'] };
          } catch (error) {
            // Domain errors are plain messages — map onto the protocol.
            throw new OrbitError(
              ErrorCode.FILTER_INVALID,
              error instanceof Error ? error.message : String(error),
            );
          }
        }

        if (action === 'remove') {
          if (caller.role !== 'admin') {
            throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Only admins can remove posts');
          }
          const id = String(args.filter?.id ?? '');
          if (!posts.remove(id)) {
            throw new OrbitError(ErrorCode.FILTER_INVALID, `No post with id '${id}'`);
          }
          return { success: true, invalidates: ['posts'] };
        }

        throw new OrbitError(ErrorCode.MUTATION_FAILED, `posts.${action} is not supported`);
      },
    },
  ]);
}
