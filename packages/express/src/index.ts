import { Readable } from 'node:stream';
import type { Server } from 'node:http';
import {
  createRealtimeServer,
  type Orbit,
  type OrbitContext,
  type OrbitHandler,
  type RealtimeServer,
  type RealtimeServerOptions,
} from '@orbit/core';
import express from 'express';

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
 * Options for {@link expressHandler}.
 */
export interface ExpressHandlerOptions {
  /** The Orbit engine (`createOrbit(...)`) or a compatible handler function. */
  orbit: OrbitServer;
  /**
   * Called when an *infrastructure* error escapes the engine (invalid URL,
   * body stream failure, a throwing adapter outside the pipeline, …).
   * Protocol errors never reach here: the engine returns them as normal
   * responses with the standard `{ error: { code, message } }` shape.
   * Defaults to logging the error and answering a generic 500 (no internal
   * details leaked to the client).
   */
  onError?: (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => void;
  /**
   * Extra Orbit context merged into every request — e.g. `{ state: { viewer } }`
   * for auth plugins. A function receives the Express request and may return a
   * promise.
   */
  ctx?: OrbitContext | ((req: express.Request) => OrbitContext | Promise<OrbitContext>);
}

/**
 * Options for {@link createExpressApp}.
 */
export interface CreateExpressAppOptions extends Omit<ExpressHandlerOptions, 'orbit'> {
  /** Mount path for the Orbit endpoint. Defaults to `/orbit`. */
  path?: string;
}

/** Connection-level headers that must never travel on the reconstructed request. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Rebuild a fetch-compatible headers object from Express' `req.headers`,
 * dropping connection-level noise. `content-length` is omitted on purpose:
 * the body may be re-encoded below, and undici recomputes the true length.
 */
function toRequestHeaders(headers: express.Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length') continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Read the request body in whatever state Express left it.
 *
 * - A parser may have run before us (`express.json()`, `express.raw()`, …):
 *   reuse its output.
 * - Otherwise read the raw stream ourselves, so the middleware works with
 *   **no body-parser middleware at all** — and MessagePack / multipart bodies
 *   reach the engine untouched (which is what preserves those protocol
 *   features; re-serializing parsed JSON would destroy them).
 */
async function readBody(req: express.Request): Promise<BodyInit | undefined> {
  const body = req.body;
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === 'string') return body;
  if (body !== undefined && body !== null && typeof body === 'object') {
    return JSON.stringify(body);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const merged = Buffer.concat(chunks);
  return new Uint8Array(merged.buffer as ArrayBuffer, merged.byteOffset, merged.byteLength);
}

/** Normalized handler signature — a plain function plus an optional context. */
type OrbitServe = (request: Request, ctx?: OrbitContext) => Promise<Response>;

/** Normalize the option to a plain handler function. */
function toHandler(orbit: OrbitServer): OrbitServe {
  return typeof orbit === 'function' ? orbit : (request, ctx) => orbit.handler(request, ctx);
}

/**
 * Build an Express middleware that serves the full Orbit protocol.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { expressHandler } from '@orbit/express';
 *
 * const orbit = createOrbit({ adapters });
 * const app = express();
 * app.use('/orbit', expressHandler({ orbit }));
 * ```
 *
 * The middleware is a **thin, faithful bridge**: the original request
 * (headers, body, content-type) is handed to the engine's handler, and the
 * engine's response — status, every header, and the body, including SSE
 * streams — is passed straight through. That keeps content negotiation
 * (JSON / `application/x-msgpack` / `text/event-stream`), gzip, multipart
 * uploads, size limits and the standard error contract 100% intact.
 *
 * No `express.json()` (or any other parser) is required.
 */
export function expressHandler(options: ExpressHandlerOptions): express.Handler {
  const { orbit, onError, ctx } = options;
  const handler = toHandler(orbit);

  return async (req, res, next) => {
    try {
      const method = (req.method ?? 'POST').toUpperCase();
      const init: RequestInit = { method, headers: toRequestHeaders(req.headers) };
      const body = await readBody(req);
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = body;
      }

      const host = req.get('host') ?? 'localhost';
      const request = new Request(`${req.protocol}://${host}${req.originalUrl}`, init);
      const base = typeof ctx === 'function' ? await ctx(req) : ctx;
      const response = await handler(request, base);

      res.status(response.status);
      for (const [name, value] of response.headers) res.setHeader(name, value);

      if (response.body) {
        // Pipe the engine's (possibly streaming — SSE) body straight through.
        const stream = Readable.fromWeb(
          response.body as import('node:stream/web').ReadableStream<Uint8Array>,
        );
        // `.pipe()` does not forward errors — without a listener a broken
        // upstream stream would crash the process instead of failing the
        // response.
        stream.on('error', (err) => {
          console.error('[orbit:express] response stream error:', err);
          res.destroy();
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (onError) {
        return onError(err, req, res, next);
      }
      console.error('[orbit:express] unhandled error:', err);
      if (res.headersSent) {
        res.end();
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
}

/** One RealtimeServer per http server — a second upgrade listener on the same
 * socket would corrupt the WebSocket handshake. */
const attached = new WeakMap<Server, RealtimeServer>();

/**
 * Mount the Orbit realtime transport (WebSocket subscriptions, spec §10) on
 * the same `node:http` server that hosts the Express app. Call it **once**
 * per server — a second call throws.
 *
 * ```ts
 * const orbit = createOrbit({ adapters });
 * const app = createExpressApp(orbit, { path: '/api/orbit' });
 *
 * const server = app.listen(3000);
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
      '[orbit:express] attachRealtime() was already called on this http server — call it once per server',
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

/**
 * Convenience factory: an Express app with the Orbit handler mounted at a
 * single path.
 *
 * ```ts
 * const app = createExpressApp(orbit, { path: '/api/orbit' });
 * app.get('/health', (_req, res) => res.json({ status: 'ok' }));
 * app.listen(3000);
 * ```
 */
export function createExpressApp(
  orbit: OrbitServer,
  options: CreateExpressAppOptions = {},
): express.Express {
  const { path = '/orbit', ...handler } = options;
  const app = express();
  app.use(path, expressHandler({ orbit, ...handler }));
  return app;
}

export default expressHandler;
