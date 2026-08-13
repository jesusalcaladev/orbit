/**
 * 11 — Book API on Hono
 *
 * The Hono host for the shared book API — the exact same engine as the
 * Express host (`examples/node/10-express.ts`), proving that the Orbit engine is
 * framework-agnostic:
 *
 *   examples/node/book/data.ts    → domain: entities + in-memory repository
 *   examples/node/book/engine.ts  → application: Orbit engine, adapters, auth
 *                              policy, timing, caching (framework-agnostic)
 *   examples/node/11-hono.ts      → interface: Hono wiring on top
 *
 * The framework layer only does transport + authentication; authorization
 * stays in the engine. `Hono` itself is runtime-agnostic, so the app is
 * hosted on Node with `@hono/node-server`.
 *
 * Run:  node examples/node/11-hono.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { attachRealtime, createHonoApp } from '@orbit/hono';
import { buildBookOrbit, identifyApiKey } from './book/engine.ts';
import { runBookDemo } from './book/demo.ts';

export async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 3200;
  const orbit = buildBookOrbit();

  const app = createHonoApp(orbit, {
    path: '/api/orbit',
    // Authentication: turn the API key into a caller identity for the engine.
    ctx: (c) => ({ state: { caller: identifyApiKey(c.req.header('x-api-key')) } }),
  });

  app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/', (c) =>
    c.json({
      name: 'Orbit × Hono — book API',
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

  // Infrastructure errors rethrow out of the wrapper by default → this is
  // the idiomatic Hono place to catch them. Protocol errors are ordinary
  // responses and never land here.
  app.onError((err, c) => {
    console.error('[book:hono] unhandled error:', err);
    return c.json({ error: 'internal server error' }, 500);
  });

  const server = serve({ fetch: app.fetch, port }) as unknown as import('node:http').Server;
  // The same http server also hosts the Orbit realtime transport.
  const realtime = attachRealtime(server, orbit);
  console.log(
    `🚀 Orbit × Hono — book API → http://localhost:${port}/api/orbit  (ws://localhost:${port}/realtime)\n`,
  );

  try {
    await runBookDemo(`http://localhost:${port}`, 'hono');
  } finally {
    // Shutdown must run even when the demo fails — an open WebSocket or
    // listening server would keep the process alive forever otherwise.
    realtime.close(); // terminate every WebSocket session
    await new Promise<void>((resolve) => {
      // Close idle keep-alive connections first so close() completes promptly.
      if ('closeIdleConnections' in server) server.closeIdleConnections();
      server.close(() => resolve());
    });
  }
  console.log('✔ hono host shut down cleanly');
}

// Run directly when this file is the entry point (so `run-all.ts` can import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
