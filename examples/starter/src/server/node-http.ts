/**
 * Interface layer — the protocol on plain `node:http`. Zero dependencies.
 *
 * The host does transport + authentication only: it converts node:http into
 * a fetch-compatible `Request`, hands the caller identity to the engine as
 * context, and writes the `Response` back. Authorization already happened
 * inside the engine (`src/plugins/authz.ts`).
 *
 * Swapping hosts means swapping this one file — see `docs/server.md` for the
 * Express, Hono and Cloudflare Workers variants of the exact same engine.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Orbit } from '@orbit/core';
import type { Config } from '../config.ts';
import { identifyCaller } from '../plugins/authz.ts';

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** node:http request → fetch-compatible `Request` (headers + buffered body). */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://localhost${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

export function createOrbitServer(orbit: Orbit, config: Config): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    const handle = async (): Promise<void> => {
      if (path === config.path && (req.method === 'POST' || req.method === 'GET')) {
        const request = await toRequest(req);
        // Authentication: turn the header into a caller identity for the
        // engine. Everything else (parsing, policy, cache, serialization)
        // is the protocol's job.
        const response = await orbit.handler(request, {
          state: { caller: identifyCaller(readHeader(req, 'x-api-key')) },
        });
        await send(res, response);
        return;
      }
      if (path === '/health' && req.method === 'GET') {
        json(res, 200, { status: 'ok', uptime: process.uptime() });
        return;
      }
      json(res, 404, { error: `Not found. ${req.method} ${config.path} with a JSON envelope.` });
    };

    // Only *infrastructure* failures land here — protocol errors (bad query,
    // denied policy, …) are ordinary responses with the standard
    // { error: { code, message } } shape, written by `orbit.handler`.
    handle().catch((error: unknown) => {
      console.error('[starter] unhandled error:', error);
      if (!res.headersSent) json(res, 500, { error: 'internal server error' });
      else res.end();
    });
  });
}
