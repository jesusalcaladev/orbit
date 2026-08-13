import type { Server } from 'node:http';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import {
  createRealtimeServer,
  type Orbit,
  type OrbitContext,
  type OrbitHandler,
  type RealtimeServer,
  type RealtimeServerOptions,
} from '@orbit/core';

export {
  // Convenience: mount the core WebSocket transport with one call, or go
  // lower-level and build the RealtimeServer yourself.
  createRealtimeServer,
};
export type { RealtimeServer, RealtimeServerOptions };

/**
 * Anything that can serve the Orbit HTTP protocol: the engine returned by
 * `createOrbit()` (which exposes `.handler`) or a plain
 * `(request, ctx) => Promise<Response>` function.
 */
export type OrbitServer =
  | OrbitHandler
  | { handler(request: Request, ctx?: OrbitContext): Promise<Response> };

/**
 * Options for {@link honoHandler}.
 */
export interface HonoHandlerOptions {
  /** The Orbit engine (`createOrbit(...)`) or a compatible handler function. */
  orbit: OrbitServer;
  /**
   * Called when an *infrastructure* error escapes the engine (invalid URL,
   * body stream failure, a throwing adapter outside the pipeline, …).
   * Protocol errors never reach here: the engine returns them as normal
   * responses with the standard `{ error: { code, message } }` shape.
   *
   * When omitted the error is rethrown, so the app-level `app.onError`
   * handler deals with it — the idiomatic Hono way.
   */
  onError?: (err: unknown, c: Context) => Response | Promise<Response>;
  /**
   * Extra Orbit context merged into every request — e.g. `{ state: { viewer } }`
   * for auth plugins. A function receives the Hono context (handy for
   * `c.get('viewer')` from auth middleware) and may return a promise.
   */
  ctx?: OrbitContext | ((c: Context) => OrbitContext | Promise<OrbitContext>);
}

/**
 * Options for {@link createHonoApp}.
 */
export interface CreateHonoAppOptions extends Omit<HonoHandlerOptions, 'orbit'> {
  /** Mount path for the Orbit endpoint. Defaults to `/orbit`. */
  path?: string;
}

/** Normalized handler signature — a plain function plus an optional context. */
type OrbitServe = (request: Request, ctx?: OrbitContext) => Promise<Response>;

/** Normalize the option to a plain handler function. */
function toHandler(orbit: OrbitServer): OrbitServe {
  return typeof orbit === 'function' ? orbit : (request, ctx) => orbit.handler(request, ctx);
}

/**
 * Build a Hono middleware that serves the full Orbit protocol.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { honoHandler } from '@orbit/hono';
 *
 * const orbit = createOrbit({ adapters });
 * const app = new Hono();
 * app.use('/orbit', honoHandler({ orbit }));
 * ```
 *
 * The middleware is a **thin, faithful bridge**: Hono's original `Request`
 * (`c.req.raw`) is handed straight to the engine's handler, and the engine's
 * response is returned untouched. That keeps content negotiation
 * (JSON / `application/x-msgpack` / `text/event-stream`), gzip, multipart
 * uploads, size limits and the standard error contract 100% intact.
 */
export function honoHandler(options: HonoHandlerOptions): MiddlewareHandler {
  const { orbit, onError, ctx } = options;
  const handler = toHandler(orbit);

  return async (c) => {
    try {
      const base = typeof ctx === 'function' ? await ctx(c) : ctx;
      return await handler(c.req.raw, base);
    } catch (err) {
      if (onError) return onError(err, c);
      throw err; // let the app's onError handler deal with it — the Hono way
    }
  };
}

/**
 * Convenience factory: a Hono app with the Orbit handler mounted at a single
 * path.
 *
 * ```ts
 * import { serve } from '@hono/node-server';
 *
 * const app = createHonoApp(orbit, { path: '/api/orbit' });
 * app.get('/health', (c) => c.json({ status: 'ok' }));
 * serve({ fetch: app.fetch, port: 3000 });
 * ```
 */
export function createHonoApp(orbit: OrbitServer, options: CreateHonoAppOptions = {}): Hono {
  const { path = '/orbit', ...handler } = options;
  const app = new Hono();
  app.use(path, honoHandler({ orbit, ...handler }));
  return app;
}

/** One RealtimeServer per http server — a second upgrade listener on the same
 * socket would corrupt the WebSocket handshake. */
const attached = new WeakMap<Server, RealtimeServer>();

/**
 * Mount the Orbit realtime transport (WebSocket subscriptions, spec §10) on
 * the same `node:http` server that hosts the Hono app. Call it **once** per
 * server — a second call throws.
 *
 * ```ts
 * import { serve } from '@hono/node-server';
 *
 * const orbit = createOrbit({ adapters });
 * const app = createHonoApp(orbit, { path: '/api/orbit' });
 *
 * const server = serve({ fetch: app.fetch, port: 3000 });
 * const realtime = attachRealtime(server, orbit);  // ws://localhost:3000/realtime
 *
 * // …on shutdown — close the realtime sessions BEFORE the server, otherwise
 * // the upgraded sockets keep server.close() waiting forever:
 * realtime.close();
 * server.close();
 * ```
 *
 * `attachRealtime` takes the engine itself (`createOrbit()`), not a handler
 * function — subscriptions need the registered adapters. Options (`path`,
 * `retentionMs`, `serialize`, `authorize`, …) match the core server; the
 * upgrade path defaults to `/realtime`.
 */
export function attachRealtime(
  server: Server,
  orbit: Orbit,
  options: RealtimeServerOptions = {},
): RealtimeServer {
  if (attached.has(server)) {
    throw new Error(
      '[orbit:hono] attachRealtime() was already called on this http server — call it once per server',
    );
  }
  const realtime = createRealtimeServer(orbit, options);
  realtime.attach(server);
  attached.set(server, realtime);
  // Belt-and-suspenders: if the server shuts down without an explicit
  // realtime.close(), release every session and subscription. Live WebSocket
  // clients must still be closed first — they keep server.close() pending, so
  // this hook only fires once they are gone. `RealtimeServer.close()` is
  // idempotent, so the explicit close() + this hook cannot double-free.
  server.once('close', () => realtime.close());
  return realtime;
}

export default honoHandler;
