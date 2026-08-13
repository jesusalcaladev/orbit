# @orbit/express

Thin Express middleware for [@orbit/core](../core) — mount the full Orbit
protocol (JSON, MessagePack, SSE streaming, gzip, file uploads) on any
Express app. **No body-parser middleware required.**

## Install

```sh
pnpm add @orbit/express
```

## Quick start

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createExpressApp } from '@orbit/express';

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
});

const app = createExpressApp(orbit, { path: '/api/orbit' });
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(3000);
```

`POST /api/orbit` now speaks the Orbit protocol:

```sh
curl -s localhost:3000/api/orbit \
  -H 'content-type: application/json' \
  -d '{ "query": "user(id=\"1\") { name }" }'
```

## Middleware form

Prefer `app.use` when you already have an Express app:

```ts
import express from 'express';
import { expressHandler } from '@orbit/express';

const app = express();
app.use('/orbit', expressHandler({ orbit }));
```

## Options

### `expressHandler({ orbit, onError?, ctx? })`

| Option | Type | Description |
| :--- | :--- | :--- |
| `orbit` | `Orbit` \| handler fn | `createOrbit(...)` or a plain `(request, ctx?) => Promise<Response>` |
| `onError?` | `(err, req, res, next) => void` | **Infrastructure** errors only — protocol errors are normal responses |
| `ctx?` | `OrbitContext` \| `(req) => OrbitContext` | Extra context per request, e.g. authenticated state |

### `createExpressApp(orbit, { path?, onError?, ctx? })`

Same options plus `path` (default `/orbit`) — returns a ready `express.Express`.

## Protocol fidelity

The middleware is a thin, faithful bridge: the original request (raw body +
headers) goes to the engine, and the engine's response — status, **every
header**, and the body, including SSE streams — comes back untouched.

- **Input:** JSON, `application/x-msgpack`, `multipart/form-data` uploads
- **Output:** JSON, `application/x-msgpack`, `text/event-stream` (SSE), gzip
- **Errors:** the standard `{ error: { code, message, details } }` contract
- **Works with or without** `express.json()` / `express.raw()` — the raw
  stream is read when no parser ran, so nothing is lost in re-serialization

## Realtime (WebSocket subscriptions)

The same http server also hosts the core realtime transport — one call:

```ts
import { attachRealtime } from '@orbit/express';

const orbit = createOrbit({ adapters });
const app = createExpressApp(orbit, { path: '/api/orbit' });
const server = app.listen(3000);
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

Protocol errors (bad envelope, unknown entity, permission denied, …) are
ordinary HTTP responses with correct status codes — they never hit `onError`.
`onError` is reserved for **infrastructure** failures (invalid URL, body
stream failure, a throwing adapter outside the pipeline). Default: the error
is logged and a generic `500 { error: 'Internal server error' }` is returned
(no internals leaked):

```ts
app.use('/orbit', expressHandler({
  orbit,
  onError: (err, _req, res) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  },
}));
```

> Note for Hono users: `@orbit/hono`'s `onError` returns a `Response` (and
> rethrows by default so `app.onError` handles it); Express's is a classic
> error middleware `(err, req, res, next) => void`. Same job, framework-native
> signature.

## Streaming, compression & proxies

- Responses are **streamed through** the wrapper (chunked, no
  `Content-Length`), so SSE frames arrive the moment the engine produces
  them — nothing is buffered.
- **gzip** is negotiated by the engine via `Accept-Encoding`; compressed
  bytes pass through untouched. Stacking Express's `compression` middleware
  is safe: it skips responses that already carry `Content-Encoding`.
- Behind Nginx, disable response buffering for the SSE endpoint
  (`proxy_buffering off` or `X-Accel-Buffering: no`) or frames wait for the
  buffer to flush.

## Recipes

**Authenticated state** (identity per request):

```ts
app.use('/orbit', expressHandler({
  orbit,
  ctx: (req) => ({ state: { viewer: req.headers['x-user-id'] } }),
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

A complete, layered book API — relations, auth, caching and realtime — runs
as [`examples/node/frameworks/10-express.ts`](../../examples/node/frameworks/10-express.ts):

```sh
node examples/node/frameworks/10-express.ts
```

## Test

```sh
pnpm test
```
