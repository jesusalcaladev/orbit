/**
 * Headless walkthrough of the starter over real HTTP — boot the server on an
 * ephemeral port, talk to it with `fetch`, assert the contract, shut down.
 *
 * Run:  node examples/starter/src/demo.ts   (after `pnpm run build`)
 * Also runs as example 00 inside `examples/node/run-all.ts`.
 */
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createOrbitServer } from './server/node-http.ts';

const ADMIN_KEY = 'starter-admin-1';

export async function main(): Promise<void> {
  const config = { ...loadConfig(), port: 0 }; // ephemeral port — never clashes
  const orbit = createApp(config);
  const server = createOrbitServer(orbit, config);

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://localhost:${port}`;

  const send = async (envelope: unknown, key?: string) => {
    const response = await fetch(`${base}${config.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      },
      body: JSON.stringify(envelope),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  try {
    // 1 · One round-trip resolves the relational graph (no N+1).
    const graph = await send(
      { query: 'user(id="1") { name, role, posts(status="published") { title, views } }' },
      ADMIN_KEY,
    );
    assert.equal(graph.status, 200);
    console.log('graph:    ', JSON.stringify(graph.body.data));

    // 2 · Identity is gated by the engine policy — no key means 403.
    const denied = await send({ query: 'user { id, name }' });
    assert.equal(denied.status, 403);
    console.log('denied:   ', `${denied.status}`, JSON.stringify(denied.body.error));

    // 3 · A mutation through the adapter, echoing what clients must invalidate.
    const created = await send(
      { do: 'posts.create', args: { payload: { title: 'Shipped the starter!' } } },
      ADMIN_KEY,
    );
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.invalidates, ['posts']);
    console.log('mutation: ', JSON.stringify(created.body));

    // 4 · Client-driven caching: same query twice — second one is a hit.
    const cached = { query: 'posts(status="published") { title }', cache: 'ttl=60' };
    const miss = await send(cached);
    const hit = await send(cached);
    assert.equal(miss.body.fromCache, undefined);
    assert.equal(hit.body.fromCache, true);
    console.log('cache:    ', `miss → hit (fromCache: ${String(hit.body.fromCache)})`);
  } finally {
    // Shutdown must run even when an assertion fails.
    await new Promise<void>((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    });
  }
  console.log('✔ starter shut down cleanly');
}

// Run directly when this file is the entry point (so `run-all.ts` can import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
