/**
 * Composition root — the one place that knows the whole picture.
 *
 * `createApp` wires domain repositories → adapters → plugins into an Orbit
 * engine. It is framework-free: the node:http host below, or Express, Hono
 * or Cloudflare Workers, all serve *this* engine unchanged.
 */
import { createCachePlugin, createOrbit } from '@orbit/core';
import type { Orbit } from '@orbit/core';
import { createAdapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { PostRepository } from './domain/posts.ts';
import { UserRepository } from './domain/users.ts';
import { authzPlugin } from './plugins/authz.ts';

export interface AppDomain {
  users: UserRepository;
  posts: PostRepository;
}

/** Build a fresh domain — new repositories per app, never shared state. */
export function createDomain(): AppDomain {
  return { users: new UserRepository(), posts: new PostRepository() };
}

export function createApp(
  config: Config = loadConfig(),
  domain: AppDomain = createDomain(),
): Orbit {
  return createOrbit({
    maxQueryDepth: config.maxQueryDepth,
    requestTimeoutMs: config.requestTimeoutMs,
    // Plugin order matters (spec §11) and hooks run in registration order:
    // 1. the authorization policy first — a cache hit can never bypass it;
    // 2. the cache plugin LAST, so cached values are the final payload.
    plugins: [authzPlugin(), createCachePlugin()],
    adapters: createAdapters(domain),
  });
}
