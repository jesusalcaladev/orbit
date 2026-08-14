/**
 * @orbit/rest — a REST `DataAdapter` for @orbit/core.
 *
 * Serves any REST API behind the Orbit contract: queries become `GET` calls
 * with the OQS filters as query parameters (or a `/:id` path when an `id`
 * filter is present), mutations become `POST`/`PATCH`/`DELETE` calls.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { restAdapter } from '@orbit/rest';
 *
 * const orbit = createOrbit({
 *   adapters: [
 *     restAdapter({ entity: 'user', baseUrl: 'https://api.example.com/v1' }),
 *   ],
 * });
 *
 * // query user(id="42") { name }  →  GET /v1/user/42
 * // do user.update { filter: { id: "42" }, payload: { name: "Ada" } }
 * //   →  PATCH /v1/user/42  { name: "Ada" }
 * ```
 *
 * Behavior notes:
 * - Upstream `404` resolves to `null` ("no record"); other failures become
 *   `OrbitError`s that preserve the upstream status on the wire.
 * - Mutation failures always use `ORBIT_MUTATION_FAILED`.
 * - No `batch`: REST round-trips can't be merged, so a deep graph is one
 *   parallel request per sibling (the engine's `Promise.all` per level).
 */
import { ErrorCode, OrbitError, isRecord } from '@orbit/core';
import type { DataAdapter, Filters, MutationArgs, MutationResult, OrbitContext } from '@orbit/core';

/** The HTTP methods the REST adapter can issue. */
export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** HTTP mapping for one mutation action. */
export interface RestMutationSpec {
  /** HTTP method for this action, e.g. `POST`. */
  method: RestMethod;
  /** Path override for this action. Defaults to the adapter path. */
  path?: string;
}

export interface RestAdapterOptions {
  /** Entity name this adapter serves — must match query roots and relations. */
  entity: string;
  /** Base URL of the REST API, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Path segment for this entity, e.g. `users`. Defaults to `entity`. */
  path?: string;
  /** Static headers, or a function returning them (e.g. an auth token). */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** The fetch implementation. Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * When resolving a relation under a parent record, inject a query parameter
   * named `parentKey` whose value is the parent's `id`. For example, `posts`
   * nested under a `user` with `parentKey: 'authorId'` resolves as
   * `GET /posts?authorId=7`.
   */
  parentKey?: string;
  /**
   * Extract the payload from a JSON response body, e.g. `({ data }) => data`.
   * Applied to both `resolve` and `mutate` responses.
   */
  unwrap?: (json: unknown) => unknown;
  /** Per-action HTTP mapping for mutations. Unknown actions reject. */
  mutations?: Record<string, RestMutationSpec>;
}

const DEFAULT_MUTATIONS: Record<string, RestMutationSpec> = {
  create: { method: 'POST' },
  update: { method: 'PATCH' },
  delete: { method: 'DELETE' },
};

/** Join two URL parts with exactly one slash. */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parentIdOf(parent: OrbitContext['parent']): unknown {
  return isRecord(parent?.data) ? parent.data.id : undefined;
}

/**
 * Build the error for an upstream failure.
 *
 * Codes are picked from the frozen `ErrorCode` set, but the upstream HTTP
 * status always passes through (via `options.status`), so a 401/429 from the
 * REST API is never flattened into a misleading 400 on the wire.
 */
function upstreamError(
  entity: string,
  method: string,
  url: string,
  status: number,
  kind: 'resolve' | 'mutate',
): OrbitError {
  const code =
    kind === 'mutate'
      ? ErrorCode.MUTATION_FAILED
      : status === 401 || status === 403
        ? ErrorCode.PERMISSION_DENIED
        : status === 400 || status === 422
          ? ErrorCode.FILTER_INVALID
          : ErrorCode.INTERNAL;
  return new OrbitError(code, `REST ${method} ${url} → ${status} (${entity})`, {
    status,
    details: { status, method, url, entity },
  });
}

/**
 * Build a REST `DataAdapter` for `@orbit/core`.
 *
 * @see RestAdapterOptions for the full configuration surface.
 */
export function restAdapter(options: RestAdapterOptions): DataAdapter {
  const entity = options.entity;
  const doFetch = options.fetchFn ?? fetch;

  const resolveHeaders = async (): Promise<HeadersInit | undefined> => {
    const headers = options.headers;
    if (typeof headers === 'function') return headers();
    return headers;
  };

  return {
    entity,

    async resolve(filters: Filters, ctx: OrbitContext): Promise<unknown> {
      const path = options.path ?? entity;
      const base = joinUrl(options.baseUrl, path);
      const id = filters.id;

      const url = new URL(id !== undefined ? `${base}/${encodeURIComponent(String(id))}` : base);
      for (const [key, value] of Object.entries(filters)) {
        if (key === 'id' && id !== undefined) continue;
        url.searchParams.set(key, value);
      }
      if (ctx.parent && options.parentKey) {
        const parentId = parentIdOf(ctx.parent);
        if (parentId !== undefined) url.searchParams.set(options.parentKey, String(parentId));
      }

      const response = await doFetch(url.toString(), { headers: await resolveHeaders() });
      // 404 from an upstream REST API means "no record" — Orbit represents
      // that as `null` data, not an error. (Collection endpoints that 404 on
      // empty results therefore yield `null`, not `[]` — the adapter never
      // guesses about the payload shape.)
      if (response.status === 404) return null;
      if (!response.ok)
        throw upstreamError(entity, 'GET', url.toString(), response.status, 'resolve');

      const json = await response.json().catch(() => undefined);
      return options.unwrap ? options.unwrap(json) : json;
    },

    async mutate(action: string, args: MutationArgs, _ctx: OrbitContext): Promise<MutationResult> {
      const dot = action.indexOf('.');
      const actionName = dot === -1 ? action : action.slice(dot + 1);
      const spec = options.mutations?.[actionName] ?? DEFAULT_MUTATIONS[actionName];
      if (!spec) {
        throw new OrbitError(ErrorCode.MUTATION_FAILED, `Unknown REST mutation '${action}'`, {
          details: { action },
        });
      }

      const path = spec.path ?? options.path ?? entity;
      const method = spec.method.toUpperCase();
      const id = args.filter?.id;
      const base = joinUrl(options.baseUrl, path);
      const url = id !== undefined ? `${base}/${encodeURIComponent(String(id))}` : base;

      // A payload with GET/DELETE would previously be dropped SILENTLY — the
      // mutation "succeeded" while the data went nowhere. Fail loudly instead:
      // the caller sees ORBIT_MUTATION_FAILED and knows the mapping is wrong.
      if (args.payload !== undefined && (method === 'GET' || method === 'DELETE')) {
        throw new OrbitError(
          ErrorCode.MUTATION_FAILED,
          `REST mutation '${action}' maps to ${method}, which cannot carry a payload`,
          { details: { action, method } },
        );
      }

      const hasBody = args.payload !== undefined && method !== 'GET' && method !== 'DELETE';
      const response = await doFetch(url, {
        method,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...(await resolveHeaders()),
        },
        ...(hasBody ? { body: JSON.stringify(args.payload) } : {}),
      });
      if (!response.ok) throw upstreamError(entity, method, url, response.status, 'mutate');

      const json = await response.json().catch(() => undefined);
      const unwrapped = options.unwrap ? options.unwrap(json) : json;
      return { id, ...(isRecord(unwrapped) ? unwrapped : {}) };
    },
  };
}
