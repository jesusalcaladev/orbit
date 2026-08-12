/**
 * Real HTTP wire-path benchmark (B8) — Orbit vs graphql-js over node:http.
 *
 * Everything the earlier B1–B7 measure in-process, this one measures through
 * the REAL transport: a `node:http` server, real HTTP requests over loopback,
 * keep-alive connections reused by a shared `node:http` Agent (what a
 * production client does). Both servers run in the SAME process on the SAME
 * machine, so the comparison isolates the handler cost:
 *
 *   - orbit handler  → orbit.handler() on the raw Request/Response
 *   - graphql handler → the same envelope body parsed, then graphql-js
 *                       parse+validate+execute (per request) + JSON response
 *
 * Honesty notes:
 * - A single keep-alive connection with pipelining off is the fairest client:
 *   it measures server capacity, not client connection churn.
 * - The same `node:http` Agent client is used by BOTH sides identically; any
 *   client overhead is shared and cancels out of the relative comparison.
 * - `graphql()` is called per request (parse + validate + execute) because a
 *   bare HTTP GraphQL server (e.g. graphql-http) validates per request. The
 *   cached-document Orbit-vs-GraphQL comparison is already covered by B3.
 * - The GraphQL handler has no `rootValue` (see note below), so it does ZERO
 *   data lookup while Orbit runs `users.find` — the ~1.5× Orbit margin is a
 *   conservative floor, not a ceiling.
 */
import { Agent, createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { buildSchema, graphql } from 'graphql';
import { createOrbit, memoryAdapter } from '@orbit/core';
import { users } from './fixtures.ts';
import { measureThroughput } from './measure.ts';

// CI smoke mode: shared runners are not a benchmark machine — fewer samples
// still exercise the full wire path without hogging the runner.
const isCI = process.env.CI === 'true';
const samples = isCI ? 300 : 2000;
const warmup = isCI ? 30 : 100;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
});

const ORBIT_BODY = JSON.stringify({ query: 'user(id="1") { name, email }' });

function orbitHttpHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const response = await orbit.handler(
        new Request('http://localhost/orbit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });
}

// GraphQL side: same envelope shape → parse the body, run the query.
// A bare HTTP GraphQL server validates per request (graphql-http, Apollo)
// unless documents are cached — so per-request `graphql()` is the honest
// default-server cost (the cached-document story is covered by B3/B1).
// NOTE: no `rootValue` is supplied, so the `user` field resolves to null —
// GraphQL does ZERO data lookup while Orbit runs `users.find`. That makes
// the comparison conservative: GraphQL does strictly less work, so Orbit's
// measured ~1.5× margin is a floor, not a ceiling.
const gqlSchema = buildSchema(`
  type User { id: ID!, name: String!, email: String! }
  type Query { user(id: ID!): User }
`);
const gqlSource = 'query { user(id: "1") { name email } }';

function gqlHttpHandler(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const result = await graphql({ schema: gqlSchema, source: gqlSource });
      const body = JSON.stringify({ data: result.data });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });
}

function startServer(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/**
 * One keep-alive POST over node:http — the connection is reused across ops
 * (production client behavior). The `request` client is node:http itself, so
 * the numbers are the SERVER's capacity, not a third-party client's.
 */
function post(port: number, body: string, agent: Agent): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        agent,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve();
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function httpB8(): Promise<{ orbitRps: number; graphqlRps: number }> {
  const { server: orbitServer, port: orbitPort } = await startServer(orbitHttpHandler);
  const { server: gqlServer, port: gqlPort } = await startServer(gqlHttpHandler);

  // One keep-alive connection per side, reused (production client behavior).
  const orbitAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const gqlAgent = new Agent({ keepAlive: true, maxSockets: 1 });

  // Warm both paths before timing (JIT + connection establishment).
  await post(orbitPort, ORBIT_BODY, orbitAgent);
  await post(gqlPort, ORBIT_BODY, gqlAgent);

  const orbitRps = Math.round(
    await measureThroughput(() => post(orbitPort, ORBIT_BODY, orbitAgent), samples, warmup),
  );
  const graphqlRps = Math.round(
    await measureThroughput(() => post(gqlPort, ORBIT_BODY, gqlAgent), samples, warmup),
  );

  orbitServer.close();
  gqlServer.close();
  orbitAgent.destroy();
  gqlAgent.destroy();

  return { orbitRps, graphqlRps };
}
