# @orbit/hono

Thin Hono middleware for [@orbit/core](../core) — mount the full Orbit
protocol (JSON, MessagePack, SSE streaming, gzip, file uploads) on any Hono
app. Runs on any Hono host: Node, Bun, Deno, Cloudflare Workers.

## Install

```sh
pnpm add @orbit/hono
```

## Quick start

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createHonoApp } from '@orbit/hono';

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
});

const app = createHonoApp(orbit, { path: '/api/orbit' });
app.get('/health', (c) => c.json({ status: 'ok' }));

// `Hono` itself is runtime-agnostic — host it on Node with @hono/node-server
// (Bun: Bun.serve, Deno: Deno.serve, Workers: export the fetch handler).
import { serve } from '@hono/node-server';
serve({ fetch: app.fetch, port: 3000 });
```

`POST /api/orbit` now speaks the Orbit protocol:

```sh
curl -s localhost:3000/api/orbit \
  -H 'content-type: application/json' \
  -d '{ "query": "user(id=\"1\") { name }" }'
```

## Middleware form

Prefer `app.use` when you already have a Hono app:

```ts
import { Hono } from 'hono';
import { honoHandler } from '@orbit/hono';

const app = new Hono();
app.use('/orbit', honoHandler({ orbit }));
```

## Options

### `honoHandler({ orbit, onError?, ctx? })`

| Option | Type | Description |
| :--- | :--- | :--- |
| `orbit` | `Orbit` \| handler fn | `createOrbit(...)` or a plain `(request, ctx?) => Promise<Response>` |
| `onError?` | `(err, c) => Response` | **Infrastructure** errors only — protocol errors are normal responses |
| `ctx?` | `OrbitContext` \| `(c) => OrbitContext` | Extra context per request, e.g. authenticated state |

When `onError` is omitted, infrastructure errors **rethrow** so the
app-level `app.onError` handles them — the idiomatic Hono way.

### `createHonoApp(orbit, { path?, onError?, ctx? })`

Same options plus `path` (default `/orbit`) — returns a ready `Hono`.

## Protocol fidelity

The middleware is a thin, faithful bridge: Hono's original `Request`
(`c.req.raw`) is handed straight to the engine, and the engine's response is
returned untouched.

- **Input:** JSON, `application/x-msgpack`, `multipart/form-data` uploads
- **Output:** JSON, `application/x-msgpack`, `text/event-stream` (SSE), gzip
- **Errors:** the standard `{ error: { code, message, details } }` contract
- **Streaming:** SSE responses pipe through without buffering

## Realtime (WebSocket subscriptions)

The same http server also hosts the core realtime transport — one call:

```ts
import { serve } from '@hono/node-server';
import { attachRealtime } from '@orbit/hono';

const orbit = createOrbit({ adapters });
const app = createHonoApp(orbit, { path: '/api/orbit' });
const server = serve({ fetch: app.fetch, port: 3000 });
const realtime = attachRealtime(server, orbit);  // ws://localhost:3000/realtime

// …on shutdown:
realtime.close();
server.close();
```

`attachRealtime` takes the engine (`createOrbit()`), not a handler —
subscriptions need the registered adapters. Options (`path`, `retentionMs`,
`serialize: 'msgpack'`, `authorize`, `origin`, …) match the core server;
`createRealtimeServer` is re-exported for lower-level use. Subscribers send
`{ subscribe, id }` frames and receive `{ ack }`, `{ event }` and
`{ error }` frames — see `docs/realtime.md`.

## Error handling

Protocol errors are ordinary HTTP responses with correct status codes — they
never hit `onError` or `app.onError`. `onError` is reserved for
**infrastructure** failures (invalid URL, body stream failure, a throwing
adapter outside the pipeline). When omitted, the error **rethrows** so the
app-level handler deals with it — the idiomatic Hono way:

```ts
const app = createHonoApp(orbit, { path: '/orbit' });
app.onError((err, c) => c.json({ error: 'internal error' }, 500));
```

> Note for Express users: `@orbit/express`'s `onError` is a classic error
> middleware `(err, req, res, next) => void`; Hono's returns a `Response`.
> Same job, framework-native signature.

## Streaming, compression & proxies

- Responses are **streamed through** the wrapper, so SSE frames arrive the
  moment the engine produces them — nothing is buffered.
- **gzip** is negotiated by the engine via `Accept-Encoding`; compressed
  bytes pass through untouched.
- Behind Nginx, disable response buffering for the SSE endpoint
  (`proxy_buffering off` or `X-Accel-Buffering: no`) or frames wait for the
  buffer to flush.

## Recipes

**Authenticated state** (identity per request):

```ts
app.use('/orbit', honoHandler({
  orbit,
  ctx: (c) => ({ state: { viewer: c.req.header('x-user-id') } }),
}));
```

**MessagePack client:**

```ts
import { encodeMsgpack } from '@orbit/core';

await fetch('/orbit', {
  method: 'POST',
  headers: { 'content-type': 'application/x-msgpack' },
  body: encodeMsgpack({ query: 'user(id="1") { name }' }),
});
```

## Example

The same layered book API — relations, auth, caching and realtime — also runs
on Hono — see [`examples/node/frameworks/11-hono.ts`](../../examples/node/frameworks/11-hono.ts):

```sh
node examples/node/frameworks/11-hono.ts
```

## Test

```sh
pnpm test
```
