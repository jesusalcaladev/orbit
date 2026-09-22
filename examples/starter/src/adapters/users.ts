/**
 * Adapter layer — the `user` entity.
 *
 * The adapter is the *only* bridge between the domain and the protocol:
 * filters arrive verbatim from OQS (`id="1"`) and are handed to the
 * repository as plain strings — Orbit never interprets them.
 */
import { memoryAdapter } from '@orbit/core';
import type { DataAdapter } from '@orbit/core';
import type { Post } from '../domain/posts.ts';
import type { UserRepository } from '../domain/users.ts';

export function createUsersAdapter(users: UserRepository): DataAdapter[] {
  return memoryAdapter([
    {
      entity: 'user',
      // One entity answers two questions: a root lookup (`user(id="1")`) and
      // the `author` relation (`posts { author { name } }`) — `ctx.parent`
      // carries the resolved post when Orbit is walking the graph.
      resolve: ({ id }, ctx) => {
        const parent = ctx.parent?.data as Post | undefined;
        if (parent) return users.byId(parent.authorId);
        if (id) return users.byId(String(id));
        return users.all();
      },
    },
  ]);
}
