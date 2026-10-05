/**
 * @orbit/cors — first-party CORS for @orbit/core.
 *
 * A dependency-free plugin that answers the allowlist, preflight and
 * credential contract from the frozen response-headers channel (spec §7):
 * every decision is written to `ctx.responseHeaders`, so the engine merges
 * it into JSON, MessagePack, plugin bodies AND error responses — no host
 * (Express/Hono/Workers/Next) needs its own CORS layer for the `/orbit` path.
 *
 * The engine runs plugin hooks for queries AND mutations, so a single mount
 * covers GET, POST, multipart uploads and the mutation `return` re-query.
 * Preflights are answered by the engine (which calls this plugin's
 * `preflight` capability for bare OPTIONS requests) with a bare 204.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { createCorsPlugin } from '@orbit/cors';
 *
 * const orbit = createOrbit({
 *   adapters,
 *   plugins: [
 *     createCorsPlugin({ origins: ['https://app.example'], credentials: true }),
 *   ],
 * });
 * ```
 */

import type { OrbitContext, OrbitPlugin } from '@orbit/core';

/** A function that decides whether one origin is allowed. */
export type OriginMatcher = (origin: string) => boolean;

/**
 * Header names that are never reflected from a preflight's
 * `access-control-request-headers` onto the allowlist. Reflection is scoped
 * on principle: the engine itself only reads `content-type`, `accept`,
 * `accept-encoding` and `x-orbit-*`, but a hostile preflight still must not
 * make the server advertise `cookie`/`authorization`/`host` as allowed.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'origin',
  'referer',
  'user-agent',
  'cookie',
  'authorization',
  'access-control-request-method',
  'access-control-request-headers',
]);

/** Default methods advertised on a preflight answer. */
const DEFAULT_METHODS = ['GET', 'POST', 'OPTIONS'] as const;

/**
 * Options of {@link createCorsPlugin}.
 */
export interface CorsOptions {
  /**
   * The allowlist — the ONLY security decision here. Accepts:
   * - `'*'` — allow any origin (cannot be combined with `credentials: true`);
   * - one origin string or an array of exact origins (`https://app.example`);
   * - a predicate (`(origin) => origin.endsWith('.example')`);
   * - `'-'` — deny every origin (preflights are answered without the
   *   allow-origin header, so browsers block everything).
   *
   * Default `'*'`.
   */
  origins?: string | string[] | OriginMatcher;
  /** Advertise `access-control-allow-credentials: true`. Default `false`. */
  credentials?: boolean;
  /** Headers exposed to non-preflight responses (`access-control-expose-headers`). */
  exposeHeaders?: string[];
  /** Methods advertised on preflights. Default `['GET', 'POST', 'OPTIONS']`. */
  methods?: string[];
  /**
   * Static header allowlist, merged into the allow-headers answer whenever
   * the preflight requests headers (a bare preflight — no
   * `access-control-request-headers` — gets NO allow-headers answer).
   * Default `['content-type']`.
   */
  headers?: string[];
  /** Preflight cache lifetime (seconds, `access-control-max-age`). Default `600`. */
  maxAge?: number;
}

export interface CorsPlugin extends OrbitPlugin {
  /** True when `origin` passes the configured allowlist (diagnostics/tests). */
  isAllowed(origin: string): boolean;
  /**
   * Answer a bare OPTIONS request by stamping the `access-control-*` headers
   * onto `ctx.responseHeaders`. Called by the engine's handler (additive
   * duck-typed capability, like the cache plugin's `invalidateEntity`).
   */
  preflight(request: Request, ctx: OrbitContext): void;
}

/**
 * Join header-list values with ', ' (the HTTP list separator the
 * `access-control-*` headers use).
 */
function joinList(items: string[]): string {
  return items.join(', ');
}

/**
 * Reflect a preflight's requested headers, minus the forbidden set, as a
 * deduplicated list. An empty result means "nothing to advertise".
 */
function reflectRequestedHeaders(requested: string | null): string[] {
  if (requested === null) return [];
  const names = requested
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0 && !FORBIDDEN_REQUEST_HEADERS.has(name));
  return [...new Set(names)];
}

/**
 * Build the first-party CORS plugin. Register it like any other plugin —
 * its `onAfterParse` hook rides the same pipeline as auth and caching.
 */
export function createCorsPlugin(options: CorsOptions = {}): CorsPlugin {
  const {
    origins = '*',
    credentials = false,
    exposeHeaders,
    methods = [...DEFAULT_METHODS],
    headers = ['content-type'],
    maxAge = 600,
  } = options;

  if (credentials && origins === '*') {
    throw new Error(
      "createCorsPlugin: origins '*' cannot be combined with credentials: true — browsers refuse " +
        'the `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true` combination; ' +
        'list your origins explicitly instead',
    );
  }

  // The literal `*` is stored as a MATCHER that allows everything, but the
  // WIRE value stays origin-specific: echoing the request's Origin (the
  // standard permissive CORS shape) keeps `credentials: true` available as a
  // per-plantilla upgrade, matches how every mainstream CORS middleware
  // behaves, and needs `vary: origin` so shared caches key the answer on the
  // requesting origin. The one exception is a request WITHOUT an Origin
  // header (same-origin/curl): there `*` is echoed verbatim — it is the only
  // value that means "any origin".
  const wildcard = origins === '*';
  const allow = (origin: string): boolean => {
    if (wildcard) return true;
    if (origins === '-') return false;
    if (typeof origins === 'function') return origins(origin);
    if (Array.isArray(origins)) return origins.includes(origin);
    return origins === origin;
  };

  /**
   * Stamp the permissive CORS contract for one allowed `origin` onto the
   * responseHeaders channel — never clobbering a header another plugin set
   * explicitly. With the wildcard allowlist the wire value is the literal
   * `*` (nothing origin-specific, so no `vary: origin`); with an explicit
   * allowlist the value IS the requesting origin and `vary: origin` rides
   * the same channel — the ENGINE's header merge appends list tokens, so the
   * final wire value is `accept, accept-encoding, origin`.
   */
  const stamp = (ctx: OrbitContext, origin: string, extra: Record<string, string>): void => {
    const responseHeaders = (ctx.responseHeaders ??= {});
    if (responseHeaders['access-control-allow-origin'] === undefined) {
      responseHeaders['access-control-allow-origin'] = wildcard ? '*' : origin;
    }
    if (credentials && responseHeaders['access-control-allow-credentials'] === undefined) {
      responseHeaders['access-control-allow-credentials'] = 'true';
    }
    if (exposeHeaders !== undefined && exposeHeaders.length > 0) {
      if (responseHeaders['access-control-expose-headers'] === undefined) {
        responseHeaders['access-control-expose-headers'] = joinList(exposeHeaders);
      }
    }
    if (!wildcard && responseHeaders.vary === undefined) {
      responseHeaders.vary = 'origin';
    }
    for (const [name, value] of Object.entries(extra)) {
      if (responseHeaders[name] === undefined) responseHeaders[name] = value;
    }
  };

  /** Shared preflight answer: 204 + the stamped access-control headers. */
  const answerPreflight = (request: Request, ctx: OrbitContext): void => {
    const origin = request.headers.get('origin') ?? '';
    const responseHeaders = (ctx.responseHeaders ??= {});

    if (origin !== '' && allow(origin)) {
      const requested = request.headers.get('access-control-request-headers');
      const reflected = reflectRequestedHeaders(requested);
      const extra: Record<string, string> = {
        'access-control-allow-methods': joinList(methods),
      };
      // Advertise headers ONLY when the preflight asked about them: a bare
      // preflight (no `access-control-request-headers`) gets no allow-headers
      // answer at all — there is nothing to permit. When it does ask, the
      // answer is the UNION of the configured allowlist and the requested
      // (reflected, forbidden-filtered) names — configured first, then the
      // extra requested ones, deduplicated.
      if (reflected.length > 0) {
        const merged = [...headers];
        for (const name of reflected) {
          if (!merged.includes(name)) merged.push(name);
        }
        extra['access-control-allow-headers'] = joinList(merged);
      }
      stamp(ctx, origin, extra);
    } else {
      // A disallowed (or absent) origin still gets a 204 — a CORS rejection
      // is not an application error — but without the allow-origin /
      // allow-methods headers: the browser blocks the request. `vary: origin`
      // stays, so a shared cache cannot serve the allowed origin's answer to
      // a disallowed one.
      if (responseHeaders.vary === undefined) responseHeaders.vary = 'origin';
    }
    if (Number.isFinite(maxAge) && maxAge > 0) {
      if (responseHeaders['access-control-max-age'] === undefined) {
        responseHeaders['access-control-max-age'] = String(Math.floor(maxAge));
      }
    }
  };

  const plugin: CorsPlugin = {
    name: 'orbit-cors',
    isAllowed: allow,
    preflight: answerPreflight,

    hooks: {
      /**
       * Actual responses (GET/POST/multipart/…): stamp the allowlist +
       * credentials + exposed headers.
       *
       * `onBeforeParse` (not `onAfterParse`) is deliberate: the engine runs
       * it for queries AND mutations (spec §11 additive rule — the hook's
       * side effects are the point), so cross-origin mutation responses get
       * the allow-origin header too. It also runs before any adapter, so an
       * entity-not-found error response still carries the CORS headers.
       */
      onBeforeParse({ ctx }) {
        const request = ctx.request;
        if (request === undefined || request.method === 'OPTIONS') return;
        const origin = request.headers.get('origin') ?? '';
        if (origin === '') return; // same-origin or a non-browser client
        if (!allow(origin)) return;
        stamp(ctx, origin, {});
      },
    },
  };

  return plugin;
}
