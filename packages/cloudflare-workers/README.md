# @orbit/cloudflare-workers

Run the full [@orbit/core](../core) protocol on the edge — JSON, MessagePack,
SSE streaming, gzip, file uploads **and Workers-native WebSocket realtime**,
from a single `fetch` handler. Zero Node APIs, zero extra dependencies.

## Install

```sh
pnpm add @orbit/cloudflare-workers
```

## Quick start

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
  realtime: { path: '/realtime' }, // WebSocket subscriptions, Workers-native
});
```

`POST /api/orbit` speaks the Orbit protocol; `wss://…/realtime` upgrades to
the realtime transport:

```sh
curl -s https://your-worker.workers.dev/api/orbit \
  -H 'content-type: application/json' \
  -d '{ "query": "user(id=\"1\") { name }" }'
```

## Options

### `createWorker({ orbit, path?, realtime?, ctx?, onError?, fallback? })`

| Option | Type | Description |
| :--- | :--- | :--- |
| `orbit` | `Orbit` \| handler fn | `createOrbit(...)` or a plain `(request, ctx?) => Promise<Response>` |
| `path?` | `string` | Orbit endpoint mount. Default `/api/orbit` |
| `realtime?` | `RealtimeOptions` \| `false` | WebSocket transport. Default `{ path: '/realtime' }`; `false` disables it |
| `ctx?` | `OrbitContext` \| `(request, env, ctx) => OrbitContext` | Extra context per request, e.g. authenticated state |
| `onError?` | `(err, request, env, ctx) => Response` | **Infrastructure** errors only — protocol errors are normal responses |
| `fallback?` | `(request, env, ctx) => Response` | Handler for paths outside the mounts. Default 404 |

`createWorker` returns a plain `{ fetch(request, env, ctx) }` object — the
exact shape workerd expects from `export default`.

### `handleOrbit(request, orbit, { env, ctx, orbitCtx?, onError? })`

Serve a single protocol request without the factory — handy inside an
existing worker or for route-based frameworks:

```ts
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      return handleOrbit(request, orbit, { env, ctx });
    }
    return new Response('Not found', { status: 404 });
  },
};
```

The Workers bindings (`env`) ride on the OrbitContext as `ctx.env`, and
`ctx.waitUntil` is attached when the execution context provides one — so
adapters can use `ctx.env.DB` and schedule background work.

## Protocol fidelity

The worker is a thin, faithful bridge: the original `Request` goes straight
to the engine's handler, and the engine's response — status, **every header**,
and the body, including SSE streams — comes back untouched.

- **Input:** JSON, `application/x-msgpack`, `multipart/form-data` uploads
- **Output:** JSON, `application/x-msgpack`, `text/event-stream` (SSE), gzip
- **Errors:** the standard `{ error: { code, message, details } }` contract
- **Streaming:** SSE responses pipe through without buffering

## Realtime (WebSocket subscriptions)

Realtime uses the Workers-native `WebSocketPair` upgrade — no `node:http`
anywhere. The transport drives the core's runtime-agnostic `SubscriptionHub`,
so the frame contract is identical to the Node transport (see
`docs/realtime.md`): subscribe/ack, event frames with per-subscription `seq`,
`resume` replay within the connection, and `{ query }` / `{ do }` envelope
requests multiplexed on the same socket.

```ts
const worker = createWorker({
  orbit,
  realtime: {
    path: '/realtime',
    authorize: (request, env) => env.API_KEY === request.headers.get('x-api-key'),
  },
});
```

Lifecycle differences from Node, stated honestly:

- **No retention window.** A closed socket releases its adapter hooks
  immediately; cross-connection `resume` would require Durable Objects
  (listed as future work). `resume` within the same connection works.
- **No application heartbeats.** Cloudflare keeps the connection alive and
  detects dead peers at the platform level.

`createRealtimeSession(server, orbit, options)` is exported for tests and
advanced use; `handleWebSocket(request, orbit, options)` performs the 101
upgrade (returns `501` outside workerd, where `WebSocketPair` is absent).

## Error handling

Protocol errors (bad envelope, unknown entity, permission denied, …) are
ordinary HTTP responses with correct status codes — they never hit `onError`.
`onError` is reserved for **infrastructure** failures (invalid URL, body
stream failure, a throwing adapter outside the pipeline). Default: the error
is logged and a generic `500 { error: 'internal server error' }` is returned
(no internals leaked):

```ts
const worker = createWorker({
  orbit,
  onError: (error) =>
    Response.json({ error: (error as Error).message }, { status: 418 }),
});
```

> Note for Express/Hono users: `@orbit/express` and `@orbit/hono` are Node
> middleware (`(err, req, res, next)` / `(err, c) => Response`); the Workers
> package is a `fetch` handler — same job, runtime-native signature.

## Recipes

**Bindings in adapters** (D1, KV, R2, …):

```ts
const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'user',
      resolve: async ({ id }, ctx) => {
        const stmt = ctx.env.DB.prepare('SELECT * FROM users WHERE id = ?');
        return (await stmt.bind(id).first()) ?? null;
      },
    },
  ]),
});
```

**Authenticated state** (identity per request, from a token):

```ts
const worker = createWorker({
  orbit,
  ctx: (request) => {
    const token = request.headers.get('authorization')?.slice(7);
    return { state: { viewer: verifyToken(token) } };
  },
});
```

**MessagePack client:**

```ts
import { encodeMsgpack } from '@orbit/core';

await fetch('/api/orbit', {
  method: 'POST',
  headers: { 'content-type': 'application/x-msgpack' },
  body: encodeMsgpack({ query: 'user(id="1") { name }' }),
});
```

## Example

The same layered book API — relations, auth, caching and realtime — runs on
the edge — see [`examples/node/12-cloudflare-workers.ts`](../../examples/node/12-cloudflare-workers.ts):

```sh
node examples/node/12-cloudflare-workers.ts
```

## Test

```sh
pnpm test
```

The whole package is tested in plain Node: `worker.fetch` is a standard
fetch handler, and the realtime session is driven over a fake `WsSocket` (the
Workers WebSocket surface is a stable, documented subset). The only
workerd-only path — the `WebSocketPair` 101 upgrade — is exercised by stubbing
the globals.
