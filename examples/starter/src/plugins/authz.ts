/**
 * Authentication mapping + authorization policy.
 *
 * The split (defense in depth):
 *
 * - **Authentication** ("who is calling") happens at the host: every server
 *   entry maps the `x-api-key` header to a caller with `identifyCaller` and
 *   injects it as `ctx.state.caller`.
 * - **Authorization** ("what may they do") happens in the engine via
 *   `authzPlugin` + `requireCaller`, so it is enforced no matter which host
 *   serves the API — or even if someone calls `orbit.execute()` directly.
 */
import { ErrorCode, OrbitError } from '@orbit/core';
import type { OrbitPlugin } from '@orbit/core';

export interface Caller {
  id: string;
  name: string;
  role: 'admin' | 'member';
}

/** The demo API keys — in production this lookup is your session/JWT store. */
const API_KEYS: Record<string, Caller> = {
  'starter-admin-1': { id: '1', name: 'Ana', role: 'admin' },
  'starter-member-2': { id: '2', name: 'Bruno', role: 'member' },
};

/** Host-side authentication: map an `x-api-key` value to a caller identity. */
export function identifyCaller(key: string | null | undefined): Caller | null {
  if (!key) return null;
  return API_KEYS[key] ?? null;
}

/** Require an authenticated caller, or raise the protocol's 403. */
export function requireCaller(ctx: { state?: Record<string, unknown> }): Caller {
  const caller = ctx.state?.caller as Caller | undefined;
  if (!caller) {
    throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Authentication required (x-api-key header)');
  }
  return caller;
}

/**
 * Read policy for the engine: the `user` entity *is* identity, so it is only
 * reachable by an authenticated caller. Register this plugin BEFORE the cache
 * plugin — hooks run in registration order, so a cache hit can never bypass
 * authorization.
 */
export function authzPlugin(): OrbitPlugin {
  return {
    name: 'starter-authz',
    hooks: {
      onBeforeResolve({ parsed, ctx }) {
        if (parsed.entity === 'user') requireCaller(ctx);
      },
    },
  };
}
