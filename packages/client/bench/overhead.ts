/**
 * Mini benchmark: @orbit/client `execute()` vs a hand-rolled raw fetch.
 *
 * One process, one server: a trivial Orbit engine with an in-memory adapter.
 * The point is to measure CLIENT overhead — not the engine — so both paths
 * hit the exact same handler; the raw path is the same POST + JSON.parse a
 * typical hand-written client would do.
 *
 * Run:  pnpm --filter @orbit/client exec tsx bench/overhead.ts
 *       (or: pnpm run build && node packages/client/bench/overhead.ts)
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOrbit, memoryAdapter } from '@orbit/core';
import { OrbitClient } from '../dist/index.js';

const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, name: `Item ${i}` }));
const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'items',
      resolve: () => items,
    },
  ]),
});

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://${req.headers.host ?? 'localhost'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.concat(chunks),
  });
  const response = await orbit.handler(request);
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

const client = new OrbitClient({ baseUrl });

const QUERY = 'items { id, name }';
const ITERATIONS = 2000;

async function time(fn: () => Promise<void>): Promise<{ avg: number; p50: number; p95: number }> {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))] ?? 0;
  return {
    avg: samples.reduce((acc, x) => acc + x, 0) / samples.length,
    p50: p(50),
    p95: p(95),
  };
}

const rawFetch = async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  });
  await res.json();
};

const clientExec = async () => {
  await client.query(QUERY);
};

// Warm up both paths (connection pool + server JIT), then measure in
// alternating order so neither side benefits from being second.
for (let i = 0; i < 100; i += 1) {
  await rawFetch();
  await clientExec();
}
const raw = await time(rawFetch);
const clientRun = await time(clientExec);
const clientRun2 = await time(clientExec);
const raw2 = await time(rawFetch);
const clientMs = (clientRun.avg + clientRun2.avg) / 2;
const rawMs = (raw.avg + raw2.avg) / 2;

const fmt = (ms: number) => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${Math.round(ms * 1000)} µs`);

console.log(
  `\n@orbit/client overhead vs raw fetch — ${ITERATIONS} requests each, same server, warm\n`,
);
console.log(
  `  raw fetch        avg ${fmt(rawMs).padEnd(10)} p50 ${fmt(raw2.p50).padEnd(10)} p95 ${fmt(raw2.p95)}`,
);
console.log(
  `  client.execute   avg ${fmt(clientMs).padEnd(10)} p50 ${fmt(clientRun2.p50).padEnd(10)} p95 ${fmt(clientRun2.p95)}`,
);
console.log(
  `  client overhead   ${rawMs === 0 ? 'n/a' : `${((clientMs / rawMs - 1) * 100).toFixed(1)} %`} on avg (validation + response parsing)`,
);

client.close();
server.closeAllConnections?.();
await new Promise<void>((resolve) => server.close(() => resolve()));
