/**
 * @orbit/auth — first-party authentication & authorization for @orbit/core.
 *
 * One plugin packages the authn/authz split the demos hand-roll: an
 * `authenticate` function resolves the caller identity from the request
 * context (headers, cookies, a realtime session…), and optional `authorize`
 * / `scope` functions gate and scope reads. Because the identity is stamped
 * in `onBeforeParse`, it reaches **queries AND mutations** (the engine runs
 * `onBeforeParse` once before every mutation — spec §5/§11 additive rule),
 * so `ctx.state.caller` is always available inside an adapter's `mutate`.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { createAuthPlugin, apiKeyAuth, requireCaller } from '@orbit/auth';
 *
 * const orbit = createOrbit({
 *   adapters,
 *   plugins: [
 *     createAuthPlugin({
 *       authenticate: apiKeyAuth({ 'secret-admin': { id: 'admin', role: 'admin' } }),
 *       authorize: ({ parsed, caller }) => {
 *         if (parsed.entity === 'user' && caller.role !== 'admin') {
 *           throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admins only');
 *         }
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * The plugin is dependency-free and additive: no core changes, no new error
 * codes — `ORBIT_PERMISSION_DENIED` (403) is the denial contract.
 */
import { ErrorCode, OrbitError } from '@orbit/core';
import type { Filters, OrbitContext, OrbitPlugin, QueryNode } from '@orbit/core';

/** The caller identity an app resolves from a request (user, api key, …). */
export interface Caller {
  id: string | number;
  role?: string;
  [key: string]: unknown;
}

/**
 * Resolve the caller identity from the request context. Return the caller to
 * authenticate, or `null`/`undefined` to deny. Throw an `OrbitError` for a
 * precise code (e.g. `ORBIT_PERMISSION_DENIED`); a plain `Error` becomes a
 * sanitized `ORBIT_INTERNAL` by the engine — so signal *denial* by returning
 * `null`, and signal *unexpected failure* by throwing.
 */
export type Authenticator<C = Caller> = (
  ctx: OrbitContext,
) => C | null | undefined | Promise<C | null | undefined>;

/** Input to the optional `authorize` read gate. */
export interface AuthorizeInput<C = Caller> {
  /** The parsed root of the query tree. */
  parsed: QueryNode;
  /** The authenticated caller (never null/undefined here). */
  caller: C;
  ctx: OrbitContext;
}

/** Input to the optional `scope` filter-scoping hook. */
export interface ScopeInput<C = Caller> {
  entity: string;
  filters: Filters;
  caller: C;
  ctx: OrbitContext;
}

export interface AuthPluginOptions<C = Caller> {
  /** Resolve the caller from the request context (headers, cookies, …). */
  authenticate: Authenticator<C>;
  /**
   * Read gate, run in `onBeforeResolve` — throw to deny the query **before
   * any adapter runs**. Runs for client queries AND a mutation's `return`
   * re-query (spec §5: "hooks included"), so there is no authorization
   * bypass through `{ do, return }`. Mutations themselves do not run
   * `onBeforeResolve` — enforce write policy inside the adapter's `mutate`
   * with the `requireCaller` / `requireRole` helpers.
   */
  authorize?: (input: AuthorizeInput<C>) => void | Promise<void>;
  /**
   * Row-level scoping, run in `onBeforeExecute` — return filters (typically
   * the incoming filters plus a tenant/user id) to constrain what an adapter
   * may resolve. Queries only (mutations scope themselves).
   */
  scope?: (input: ScopeInput<C>) => Filters | void | Promise<Filters | void>;
  /**
   * Message for the `ORBIT_PERMISSION_DENIED` error raised when
   * `authenticate` returns no caller. Default "Authentication required".
   */
  missingMessage?: string;
}

const CALLER_KEY = 'caller';

/**
 * Build the auth plugin. Registers the caller on `ctx.state.caller` in
 * `onBeforeParse` (covering queries, mutations and re-queries), then applies
 * the optional `authorize`/`scope` gates. If a caller is already present on
 * `ctx.state.caller` — seeded by a framework authn layer or a realtime
 * `authorize` session (spec §10) — `authenticate` is skipped, so identity is
 * never clobbered by a second credential check.
 */
export function createAuthPlugin<C = Caller>(options: AuthPluginOptions<C>): OrbitPlugin {
  const { authenticate, authorize, scope, missingMessage = 'Authentication required' } = options;

  const getCaller = (ctx: OrbitContext): C | null | undefined =>
    ctx.state?.[CALLER_KEY] as C | null | undefined;

  return {
    name: 'orbit-auth',
    hooks: {
      async onBeforeParse({ ctx }) {
        if (getCaller(ctx) !== undefined && getCaller(ctx) !== null) return;
        const caller = await authenticate(ctx);
        if (caller === null || caller === undefined) {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, missingMessage);
        }
        const state = (ctx.state ??= {});
        state[CALLER_KEY] = caller;
      },

      async onBeforeResolve({ parsed, ctx }) {
        if (!authorize) return;
        const caller = getCaller(ctx);
        if (caller === undefined || caller === null) {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, missingMessage);
        }
        await authorize({ parsed, caller, ctx });
      },

      async onBeforeExecute({ entity, filters, ctx }) {
        if (!scope) return;
        const caller = getCaller(ctx);
        if (caller === undefined || caller === null) {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, missingMessage);
        }
        const adjusted = await scope({ entity, filters, caller, ctx });
        if (adjusted !== undefined) return { filters: adjusted };
      },
    },
  };
}

/**
 * Require a caller inside an adapter's `mutate` (write policy lives in the
 * adapter — mutations do not run `onBeforeResolve`). Throws
 * `ORBIT_PERMISSION_DENIED` when no caller was stamped.
 */
export function requireCaller<C = Caller>(
  ctx: OrbitContext,
  message = 'Authentication required',
): C {
  const caller = ctx.state?.[CALLER_KEY] as C | undefined;
  if (caller === undefined || caller === null) {
    throw new OrbitError(ErrorCode.PERMISSION_DENIED, message);
  }
  return caller;
}

/**
 * Require one of the given roles on a caller (reads `caller.role`). Useful
 * inside `authorize` and inside an adapter's `mutate`. Throws
 * `ORBIT_PERMISSION_DENIED` otherwise.
 */
export function requireRole<C extends Caller>(caller: C, ...roles: string[]): C {
  const role = caller.role;
  if (typeof role !== 'string' || !roles.includes(role)) {
    throw new OrbitError(
      ErrorCode.PERMISSION_DENIED,
      `Missing required role${roles.length === 1 ? '' : 's'}: ${roles.join(', ')}`,
      { details: { requiredRoles: roles } },
    );
  }
  return caller;
}

/**
 * `authenticate` preset for `Authorization: Bearer <token>` (header name
 * configurable). The token is handed to `verify`, which returns the caller
 * or `null` for an invalid/expired token — return `null`, don't throw, so
 * the denial is a 403 and not a sanitized 500.
 */
export function bearerAuth<C = Caller>(
  verify: (token: string) => C | null | undefined | Promise<C | null | undefined>,
  headerName = 'authorization',
): Authenticator<C> {
  return (ctx) => {
    const header = ctx.headers?.get(headerName)?.trim() ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return null;
    return verify(match[1]);
  };
}

/**
 * `authenticate` preset for a static API-key table (`x-api-key` by default).
 * Lookups use `Object.hasOwn`, so a hostile header value like `__proto__` or
 * `constructor` can never resolve to an inherited prototype member and pass
 * authentication.
 */
export function apiKeyAuth<C = Caller>(
  keys: Readonly<Record<string, C>>,
  headerName = 'x-api-key',
): Authenticator<C> {
  return (ctx) => {
    const key = ctx.headers?.get(headerName)?.trim();
    if (!key) return null;
    return Object.hasOwn(keys, key) ? (keys[key] as C) : null;
  };
}
