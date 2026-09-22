/**
 * Adapter registry — every entity the protocol can reach, in one array.
 *
 * Add a data source by writing one module (`<entity>.ts`) and one line here;
 * nothing else in the project changes.
 */
import type { DataAdapter } from '@orbit/core';
import type { PostRepository } from '../domain/posts.ts';
import type { UserRepository } from '../domain/users.ts';
import { createPostsAdapter } from './posts.ts';
import { createUsersAdapter } from './users.ts';

export interface AdapterDeps {
  users: UserRepository;
  posts: PostRepository;
}

export function createAdapters(deps: AdapterDeps): DataAdapter[] {
  return [...createUsersAdapter(deps.users), ...createPostsAdapter(deps.posts)];
}
