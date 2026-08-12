# Server integration

Orbit's handler is a plain `(request: Request, ctx?: OrbitContext) => Promise<Response>`. Any runtime that speaks the fetch API can host it.

## node:http (zero dependencies)

```ts
import { createServer } from 'node:http';
import { createOrbit, memoryAdapter, createCachePlugin } from '@orbit/core';

const orbit = createOrbit({ adapters, plugins: [createCachePlugin()] });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const response = await orbit.handler(
    new Request('http://localhost:3000/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.concat(chunks).toString('utf8'),
    }),
  );
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
});
```

A complete version ships in [examples/standalone-server.ts](../examples/standalone-server.ts) — run it with `npm run example`.

## Hono

```ts
import { Hono } from 'hono';
import { createOrbit, createCachePlugin } from '@orbit/core';
import { postgresAdapter } from 'your-adapters'; // any DataAdapter[] or AdapterRegistry

const orbit = createOrbit({
  adapters: [postgresAdapter('users')],
  plugins: [createCachePlugin()],
});

const app = new Hono();
app.post('/orbit', (c) => orbit.handler(c.req.raw, c.env));
```

## Express

```ts
import express from 'express';
import { createOrbit } from '@orbit/core';

const orbit = createOrbit({ /* adapters, plugins */ });
const app = express();

app.post('/orbit', async (req, res) => {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const response = await orbit.handler(
    new Request(`http://${req.headers.host}${req.originalUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  res.status(response.status).type('application/json').send(await response.text());
});
```

## Cloudflare Workers

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return orbit.handler(request, { env, state: { ctx } });
  },
};
```

## Bun

```ts
const server = Bun.serve({ port: 3000, fetch: (req) => orbit.handler(req) });
```

## Deno

```ts
Deno.serve({ port: 3000 }, (req) => orbit.handler(req));
```

## Calling the endpoint

```ts
const res = await fetch('http://localhost:3000/orbit', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-orbit-cache': 'ttl=60',      // optional cache spec
  },
  body: JSON.stringify({
    query: 'user(id="123") { name, posts(status="published") { title } }',
  }),
});

const { data, fromCache, invalidates } = await res.json();
```

## Programmatic use (no HTTP)

```ts
const result = await orbit.execute(
  { query: 'user(id="1") { name }' },
  { state: { viewer: 'ana' } }, // your auth context
);
// result: { status: 200, data: { name: 'Ana' }, fromCache: false, contentType: 'application/json; charset=utf-8' }
```

## Payload and depth configuration

```ts
createOrbit({
  maxQueryDepth: 8,       // default 10
  maxPayloadBytes: 1_000_000, // default 10 MiB
});
```
