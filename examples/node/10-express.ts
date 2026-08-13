/**
 * 10 — Book API on Express
 *
 * The HTTP host for the shared book API. Architecture (best-practice layers):
 *
 *   examples/node/book/data.ts    → domain: entities + in-memory repository
 *   examples/node/book/engine.ts  → application: Orbit engine, adapters, auth
 *                              policy, timing, caching (framework-agnostic)
 *   examples/node/10-express.ts   → interface: Express wiring on top
 *
 * The framework layer only does transport + authentication (mapping
 * `x-api-key` to a caller identity); authorization stays in the engine, so
 * the same API is served identically by Hono (`examples/node/11-hono.ts`).
 *
 * Run:  node examples/node/10-express.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { attachRealtime, createExpressApp } from '@orbit/express';
import { buildBookOrbit, identifyApiKey } from './book/engine.ts';
import { runBookDemo } from './book/demo.ts';

export async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 3100;
  const orbit = buildBookOrbit();

  const app = createExpressApp(orbit, {
    path: '/api/orbit',
    // Authentication: turn the API key into a caller identity for the engine.
    ctx: (req) => ({ state: { caller: identifyApiKey(req.get('x-api-key')) } }),
    // Only *infrastructure* errors land here — protocol errors are ordinary
    // responses with the standard { error: { code, message } } shape.
    onError: (err, _req, res) => {
      console.error('[book:express] unhandled error:', err);
      res.status(500).json({ error: 'internal server error' });
    },
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/', (_req, res) =>
    res.json({
      name: 'Orbit × Express — book API',
      endpoint: 'POST /api/orbit',
      entities: ['authors', 'books', 'reviews', 'user'],
      protocol: ['json', 'msgpack', 'sse streaming', 'file uploads', 'gzip'],
      realtime: '/realtime (WebSocket subscriptions)',
      auth: 'x-api-key header — admin-123 (admin), ana-456 (member)',
      layerMap: {
        domain: 'examples/node/book/data.ts',
        application: 'examples/node/book/engine.ts',
        interface: 'this file',
      },
    }),
  );

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  // The same http server also hosts the Orbit realtime transport.
  const realtime = attachRealtime(server, orbit);
  console.log(
    `🚀 Orbit × Express — book API → http://localhost:${port}/api/orbit  (ws://localhost:${port}/realtime)\n`,
  );

  try {
    await runBookDemo(`http://localhost:${port}`, 'express');
  } finally {
    // Shutdown must run even when the demo fails — an open WebSocket or
    // listening server would keep the process alive forever otherwise.
    realtime.close(); // terminate every WebSocket session
    await new Promise<void>((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    });
  }
  console.log('✔ express host shut down cleanly');
}

// Run directly when this file is the entry point (so `run-all.ts` can import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
