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

A complete version ships in [examples/node/standalone-server.ts](../examples/node/standalone-server.ts) — run it with `npm run example`.

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

Or use the thin wrapper — same thing, one line:

```ts
import { createHonoApp } from '@orbit/hono';
const app = createHonoApp(orbit, { path: '/orbit' });
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

Or use the thin wrapper — it reads the raw body itself, so no `express.json()`
is needed and MessagePack / multipart uploads keep working:

```ts
import { createExpressApp } from '@orbit/express';
const app = createExpressApp(orbit, { path: '/orbit' });
```

Both wrappers (`@orbit/express`, `@orbit/hono`) also mount the realtime
WebSocket transport on the same http server:

```ts
import { attachRealtime } from '@orbit/express';
const server = app.listen(3000);
const realtime = attachRealtime(server, orbit); // ws://localhost:3000/realtime
```

Call `attachRealtime` **once** per server (a second call throws). On shutdown,
close the realtime sessions **before** the server — upgraded sockets keep
`server.close()` waiting forever otherwise:

```ts
realtime.close(); // terminate every WebSocket session
server.close();
```

## Cloudflare Workers

Zero Node APIs — the engine is a fetch handler, and realtime uses the
Workers-native `WebSocketPair` upgrade:

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createWorker } from '@orbit/cloudflare-workers';

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
});

export default createWorker({
  orbit,
  path: '/api/orbit',
  realtime: { path: '/realtime', authorize: (request, env) => request.headers.get('x-key') === env.API_KEY },
  ctx: (request) => ({ state: { viewer: request.headers.get('x-user-id') } }),
});
```

`createWorker` returns the exact `{ fetch(request, env, ctx) }` shape workerd
expects. The Workers bindings (`env`) ride on the OrbitContext as `ctx.env`,
so adapters can use `ctx.env.DB` and schedule background work with
`ctx.waitUntil`. `handleOrbit(request, orbit, { env, ctx })` is exported for
existing workers that want the protocol on one route.

The realtime transport shares the core's runtime-agnostic `SubscriptionHub`,
so the frame contract is identical to the Node transport — subscribe/ack,
`seq`-numbered events, `resume` within the connection, and `{ query }` /
`{ do }` envelope requests on the same socket. Two honest edge differences:
no cross-connection `resume` (that needs Durable Objects — future work) and
no application-level heartbeats (the platform keeps connections alive). See
`docs/realtime.md`.

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

## File uploads (multipart/form-data)

Orbit supports file uploads **natively in the handler** — no plugin, no
framework, no new dependency. The frozen envelope contract is untouched:
files are *context*, never envelope fields.

### Client side

Send `multipart/form-data` with an `envelope` field (the JSON envelope) plus
one field per file:

```ts
const form = new FormData();
form.set('envelope', JSON.stringify({
  do: 'user.uploadAvatar',
  args: { filter: { id: '1' } },
}));
form.set('avatar', avatarFile, 'me.png');

await fetch('/orbit', { method: 'POST', body: form });
```

### Server side

Every field whose value is a `File` lands in `ctx.files` (keyed by field
name) — the adapter reads it in `mutate`:

```ts
const adapter: DataAdapter = {
  entity: 'user',
  async mutate(action, args, ctx) {
    const file = ctx.files?.['avatar'];   // a File — name, type, size, bytes
    if (action === 'uploadAvatar' && file) {
      await s3.putObject({ key: `${ctx.state.viewer}/${file.name}`, body: file });
    }
    return { id: '1', invalidates: ['cache:user:1'] };
  },
};
```

### Rules

- The `envelope` field is validated exactly like any other envelope (same
  error codes, same depth limits).
- Non-file fields other than `envelope` are rejected (`ORBIT_INVALID_QUERY`)
  — uploads are an explicit contract, not a free-for-all.
- **Size limit:** `maxPayloadBytes` (default 10 MiB) applies to the **whole
  multipart body** — enforced twice: early via `content-length` (413 before
  buffering) and again on the buffered bytes.
- Responses negotiate normally (`Accept`: JSON, msgpack, or SSE) — the file
  upload only changes the request shape.
- Programmatic use: `orbit.execute({ do: 'user.uploadAvatar' }, { files: { avatar } })`.
- Plugins see `ctx.files` in query hooks (mutations run only `adapter.mutate`,
  no pipeline), e.g. for size/type validation gates.

## Payload and depth configuration

```ts
createOrbit({
  maxQueryDepth: 8,       // default 10
  maxPayloadBytes: 1_000_000, // default 10 MiB
});
```
