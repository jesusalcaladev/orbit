/**
 * Entry point — config → engine → host.
 *
 * Run:  pnpm run dev   (or `node src/index.ts` — Node ≥ 22.18 runs TS natively)
 * Try:  curl -s localhost:3000/orbit \
 *         -H 'content-type: application/json' \
 *         -H 'x-api-key: starter-admin-1' \
 *         -d '{"query":"user(id=\"1\") { name, posts(status=\"published\") { title } }"}'
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createOrbitServer } from './server/node-http.ts';

const config = loadConfig();
const orbit = createApp(config);
const server = createOrbitServer(orbit, config);

server.listen(config.port, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`🛰  Orbit starter → http://localhost:${port}${config.path}`);
  console.log(`   keys: starter-admin-1 (admin), starter-member-2 (member)`);
});

// Graceful shutdown — an open server would keep demos and tests alive forever.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
