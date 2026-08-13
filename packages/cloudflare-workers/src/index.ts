/**
 * @orbit/cloudflare-workers — run the full Orbit protocol on the edge.
 *
 * ```ts
 * import { createOrbit, memoryAdapter } from '@orbit/core';
 * import { createWorker } from '@orbit/cloudflare-workers';
 *
 * const orbit = createOrbit({
 *   adapters: memoryAdapter([
 *     { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
 *   ]),
 * });
 *
 * export default createWorker({
 *   orbit,
 *   path: '/api/orbit',
 *   realtime: { path: '/realtime' },   // WebSocket subscriptions, Workers-native
 *   ctx: (request, env, ctx) => ({ state: { caller: env.API_KEY } }),
 * });
 * ```
 *
 * The worker is a **thin, faithful bridge**: the original `Request` goes
 * straight to the engine's handler, and the engine's response — status, every
 * header, and the body, including SSE streams — comes back untouched. That
 * keeps the full protocol intact (JSON/msgpack input, JSON/msgpack/SSE
 * output, gzip, multipart uploads, the standard error contract). The Workers
 * bindings (`env`) and execution context (`ctx.waitUntil`) ride on the
 * OrbitContext, so adapters can use `ctx.env.DB` and schedule background work.
 *
 * Realtime WebSockets use the Workers-native `WebSocketPair` upgrade — no
 * Node `node:http` anywhere. The transport shares the core's runtime-agnostic
 * `SubscriptionHub`, so the frame contract is identical to the Node transport
 * (see `docs/realtime.md`).
 */
import type { Orbit, OrbitContext, OrbitHandler } from '@orbit/core';
import { createRealtimeSession } from './websocket.js';
import type { RealtimeSessionOptions } from './websocket.js';

export { createRealtimeSession } from './websocket.js';
export type {
  RealtimeSession,
  RealtimeSessionOptions,
  WsSocket,
  WsEvent,
} from './websocket.js';

/**
 * Anything that can serve the Orbit HTTP protocol: the engine returned by
 * `createOrbit()` (which exposes `.handler`) or a plain
 * `(request, ctx) => Promise<Response>` function.
 */
export type OrbitServer =
  | OrbitHandler
  | { handler(request: Request, ctx?: OrbitContext): Promise<Response> };

/**
 * The worker object workerd runs — same shape as `export default { fetch }`.
 * Named `OrbitWorker` (not `Worker`) so the type never shadows the DOM global.
 */
export interface OrbitWorker<Env = unknown, Ctx = unknown> {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response>;
}

/** Options for the WebSocket upgrade handler (spec §10). */
export interface WebSocketHandlerOptions<Env = unknown, Ctx = unknown>
  extends RealtimeSessionOptions {
  /** Upgrade path. Defaults to `/realtime`. */
  path?: string;
  /** Workers bindings, surfaced to the authorize gate. */
  env?: Env;
  /** The Workers execution context, surfaced to the authorize gate. */
  ctx?: Ctx;
  /** Request-time authorization gate — deny closes the upgrade with 403. */
  authorize?: (request: Request, env: Env, ctx: Ctx) => boolean | Promise<boolean>;
}

/** Options for {@link createWorker}. */
export interface CreateWorkerOptions<Env = unknown, Ctx = unknown> {
  /** The Orbit engine (`createOrbit(...)`) or a compatible handler function. */
  orbit: OrbitServer;
  /** Mount path for the Orbit endpoint. Defaults to `/api/orbit`. */
  path?: string;
  /**
   * Mount the Workers-native WebSocket realtime transport. Pass options
   * (`path`, `serialize: 'msgpack'`, `authorize`, …) or `false` to disable.
   * Defaults to `{ path: '/realtime' }`.
   */
  realtime?: WebSocketHandlerOptions<Env, Ctx> | false;
  /**
   * Called when an *infrastructure* error escapes the engine (invalid URL,
   * body stream failure, a throwing adapter outside the pipeline, …).
   * Protocol errors never reach here: the engine returns them as normal
   * responses with the standard `{ error: { code, message } }` shape.
   * Defaults to logging the error and answering a generic 500 (no internal
   * details leaked to the client).
   */
  onError?: (error: unknown, request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>;
  /**
   * Extra Orbit context merged into every request — e.g. `{ state: { viewer } }`
   * for auth plugins. A function receives the request, the Workers bindings
   * and the execution context, and may return a promise.
   */
  ctx?:
    | OrbitContext
    | ((request: Request, env: Env, ctx: Ctx) => OrbitContext | Promise<OrbitContext>);
  /** Handler for paths outside the Orbit mount. Defaults to a 404. */
  fallback?: (request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>;
}

const DEFAULT_PATH = '/api/orbit';
const DEFAULT_REALTIME_PATH = '/realtime';

/** Normalized handler signature — a plain function plus an optional context. */
type OrbitServe = (request: Request, ctx?: OrbitContext) => Promise<Response>;

/** Normalize the option to a plain handler function. */
function toHandler(orbit: OrbitServer): OrbitServe {
  return typeof orbit === 'function' ? orbit : (request, ctx) => orbit.handler(request, ctx);
}

/**
 * Build a Workers `fetch` handler that serves the full Orbit protocol.
 *
 * ```ts
 * export default createWorker({ orbit, path: '/api/orbit' });
 * ```
 *
 * One call wires everything: the protocol endpoint (with `env`/`ctx` flowing
 * into every request context), the WebSocket realtime upgrade on `/realtime`
 * (or your own path), the fallback for other routes, and error handling.
 */
export function createWorker<Env = unknown, Ctx = unknown>(
  options: CreateWorkerOptions<Env, Ctx>,
): OrbitWorker<Env, Ctx> {
  const { orbit, path = DEFAULT_PATH, realtime = {}, onError, ctx, fallback } = options;
  const realtimeEnabled = realtime !== false;
  const realtimePath =
    realtimeEnabled && typeof realtime === 'object'
      ? (realtime.path ?? DEFAULT_REALTIME_PATH)
      : DEFAULT_REALTIME_PATH;

  return {
    async fetch(request, env, executionCtx) {
      const url = new URL(request.url);
      if (realtimeEnabled && url.pathname === realtimePath) {
        // Realtime needs the engine itself (the hub drives the registered
        // adapters' `subscribe` hooks) — a plain handler function cannot
        // serve subscriptions. Fail with a clear 500, never a crash.
        if (typeof orbit === 'function' || !('adapters' in (orbit as object))) {
          return new Response(
            'Realtime subscriptions require a createOrbit() engine with registered adapters',
            { status: 500 },
          );
        }
        return handleWebSocket(request, orbit as Orbit, {
          ...(typeof realtime === 'object' ? realtime : {}),
          env,
          ctx: executionCtx,
        });
      }
      if (url.pathname === path || url.pathname.startsWith(`${path}/`)) {
        return handleOrbit(request, orbit, { env, ctx: executionCtx, onError, orbitCtx: ctx });
      }
      if (fallback) return fallback(request, env, executionCtx);
      return new Response('Not found', { status: 404 });
    },
  };
}

/** Options for {@link handleOrbit}. */
export interface HandleOrbitOptions<Env = unknown, Ctx = unknown> {
  /** Workers bindings — exposed to adapters as `ctx.env`. */
  env: Env;
  /** The Workers execution context — `waitUntil` is exposed for background work. */
  ctx: Ctx;
  /** Infrastructure errors only — see {@link CreateWorkerOptions.onError}. */
  onError?: (error: unknown, request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>;
  /** Extra Orbit context — see {@link CreateWorkerOptions.ctx}. */
  orbitCtx?:
    | OrbitContext
    | ((request: Request, env: Env, ctx: Ctx) => OrbitContext | Promise<OrbitContext>);
}

/**
 * Serve one Orbit protocol request.
 *
 * `env` (the Workers bindings) rides on the OrbitContext as `ctx.env`, and a
 * `waitUntil` function is attached when the execution context provides one —
 * so adapters and plugins can use `ctx.env.DB` and `ctx.waitUntil(...)`.
 */
export async function handleOrbit<Env = unknown, Ctx = unknown>(
  request: Request,
  orbit: OrbitServer,
  options: HandleOrbitOptions<Env, Ctx>,
): Promise<Response> {
  const handler = toHandler(orbit);
  try {
    // resolveContext is INSIDE the try: a throwing custom ctx function is an
    // infrastructure error like any other — it must reach onError/the generic
    // 500, never escape worker.fetch as an unhandled rejection.
    const base = await resolveContext(request, options);
    return await handler(request, base);
  } catch (error) {
    if (options.onError) return options.onError(error, request, options.env, options.ctx);
    console.error('[orbit:cf] unhandled error:', error);
    return new Response(JSON.stringify({ error: 'internal server error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** Merge bindings + execution context + custom Orbit context into one base. */
async function resolveContext<Env, Ctx>(
  request: Request,
  options: HandleOrbitOptions<Env, Ctx>,
): Promise<OrbitContext> {
  const custom =
    typeof options.orbitCtx === 'function'
      ? await options.orbitCtx(request, options.env, options.ctx)
      : options.orbitCtx;
  // Duck-typed: workerd's ExecutionContext has waitUntil; a plain object may
  // not — attach it only when present so `ctx.waitUntil` is always safe.
  const execution = options.ctx as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
  const waitUntil = execution?.waitUntil;
  return {
    env: options.env,
    ...(typeof waitUntil === 'function'
      ? { waitUntil: (promise: Promise<unknown>) => waitUntil(promise) }
      : {}),
    ...custom,
  };
}

/** A `ResponseInit` extended with the Workers `webSocket` upgrade field. */
type WorkersResponseInit = ResponseInit & { webSocket: WebSocket };

/** Minimal shape of the global WebSocketPair (referenced via globalThis). */
interface WebSocketPairCtor {
  new (): { 0: WebSocket; 1: WebSocket };
}

/**
 * Handle a WebSocket upgrade (`Upgrade: websocket` on the realtime path) the
 * Workers way — `WebSocketPair` + a 101 response with `webSocket`.
 *
 * Returns `404` for a wrong path, `400` for a non-upgrade request on the
 * realtime path, `403` when the `authorize` gate denies, and `501` when
 * `WebSocketPair` is unavailable (i.e. outside workerd — the Node tests hit
 * this branch). On success the returned 101 carries the client side of the
 * pair; the server side runs a {@link RealtimeSession} against the engine.
 */
export async function handleWebSocket<Env = unknown, Ctx = unknown>(
  request: Request,
  orbit: Orbit,
  options: WebSocketHandlerOptions<Env, Ctx> = {},
): Promise<Response> {
  const path = options.path ?? DEFAULT_REALTIME_PATH;
  if (new URL(request.url).pathname !== path) {
    return new Response('Not found', { status: 404 });
  }
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('Bad request', { status: 400 });
  }
  if (options.authorize) {
    try {
      const allowed = await options.authorize(request, options.env as Env, options.ctx as Ctx);
      if (!allowed) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  const ctor = (globalThis as { WebSocketPair?: WebSocketPairCtor }).WebSocketPair;
  if (typeof ctor !== 'function') {
    return new Response('WebSocketPair is not available in this runtime (requires workerd)', {
      status: 501,
    });
  }

  const pair = new ctor();
  const client = pair[0];
  const server = pair[1];
  createRealtimeSession(server as unknown as import('./websocket.js').WsSocket, orbit, options);
  return new Response(null, { status: 101, webSocket: client } as WorkersResponseInit);
}
