# Server integration

Orbit's handler is a plain `(request: Request, ctx?: OrbitContext) => Promise<Response>`. Any runtime that speaks the fetch API can host it.

## node:http (zero dependencies)

```ts
import { createServer } from "node:http";
import { createOrbit, memoryAdapter, createCachePlugin } from "@orbit/core";

const orbit = createOrbit({ adapters, plugins: [createCachePlugin()] });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const response = await orbit.handler(
    new Request("http://localhost:3000/orbit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks).toString("utf8"),
    }),
  );
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
});
```

A complete version ships in [examples/node/standalone-server.ts](../examples/node/standalone-server.ts) — run it with `pnpm run example`.

## Hono

```ts
import { Hono } from "hono";
import { createOrbit, createCachePlugin } from "@orbit/core";

const orbit = createOrbit({
  adapters: [userRepositoryAdapter], // your DataAdapter
  plugins: [createCachePlugin()],
});

const app = new Hono();
app.post("/orbit", (c) => orbit.handler(c.req.raw, c.env));
```

Or use the thin wrapper — same thing, one line:

```ts
import { createHonoApp } from "@orbit/hono";
const app = createHonoApp(orbit, { path: "/orbit" });
```

## Express

```ts
import express from "express";
import { createOrbit } from "@orbit/core";

const orbit = createOrbit({/* adapters, plugins */});
const app = express();

app.post("/orbit", async (req, res) => {
  const body =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const response = await orbit.handler(
    new Request(`http://${req.headers.host}${req.originalUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  res
    .status(response.status)
    .type("application/json")
    .send(await response.text());
});
```

Or use the thin wrapper — it reads the raw body itself, so no `express.json()`
is needed and MessagePack / multipart uploads keep working:

```ts
import { createExpressApp } from "@orbit/express";
const app = createExpressApp(orbit, { path: "/orbit" });
```

Both wrappers (`@orbit/express`, `@orbit/hono`) also mount the realtime
WebSocket transport on the same http server:

```ts
import { attachRealtime } from "@orbit/express";
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
import { createOrbit, memoryAdapter } from "@orbit/core";
import { createWorker } from "@orbit/cloudflare-workers";

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: "user", resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
});

export default createWorker({
  orbit,
  path: "/api/orbit",
  realtime: {
    path: "/realtime",
    authorize: (request, env) => request.headers.get("x-key") === env.API_KEY,
  },
  ctx: (request) => ({ state: { viewer: request.headers.get("x-user-id") } }),
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

## Next.js

The handler is a fetch function, so it drops straight into App Router route
handlers — with **one round-trip per graph** and no extra infrastructure:

```ts
// app/api/orbit/route.ts
import { createOrbit, memoryAdapter, createCachePlugin } from "@orbit/core";
import { createCorsPlugin } from "@orbit/cors";

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: "user", resolve: ({ id }) => users.find((u) => u.id === id) },
  ]),
  plugins: [
    createCorsPlugin({ origins: ["https://app.example"], credentials: true }),
    createCachePlugin(),
  ],
});

export const POST = (request: Request) => orbit.handler(request);
export const GET = (request: Request) => orbit.handler(request); // CDN-cacheable reads
export const OPTIONS = (request: Request) => orbit.handler(request); // CORS preflights → 204
```

Notes for the Next.js host:

- **Same-origin server-to-server calls skip HTTP entirely** — from a Server
  Component or a Route Handler, call `orbit.execute({ query: '…' }, ctx)`
  directly against the same engine instance (no fetch to your own API, no
  self-request deadlock risk).
- **Cross-origin browser calls** need CORS: mount `@orbit/cors` (above) or
  set `Access-Control-*` via `ctx.responseHeaders` — the engine merges them
  into every response, errors included.
- **Cookies**: read `request.headers` inside an `authenticate` hook
  (`@orbit/auth`) or any plugin; write `set-cookie` via `ctx.responseHeaders`.
- **Streaming (SSE) and MessagePack** negotiate normally from `Accept` —
  no Next.js-specific configuration needed. Realtime WebSocket subscriptions
  are not supported on the App Router runtime (no Upgrade hook) — host the
  core transport (`createRealtimeServer` / `attachRealtime`) on a Node side
  server or use `@orbit/cloudflare-workers` for Workers-native realtime.
- The engine must be a **module singleton** (top-level `createOrbit`, as
  above) so the parse cache, in-memory stores and plugins persist across
  invocations.

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
const res = await fetch("http://localhost:3000/orbit", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-orbit-cache": "ttl=60", // optional cache spec
  },
  body: JSON.stringify({
    query: 'user(id="123") { name, posts(status="published") { title } }',
  }),
});

const { data, fromCache, invalidates } = await res.json();
```

## Response headers & cookies

**Reading request headers** (including cookies) is total: the engine exposes
`ctx.headers` to every plugin and adapter, so `ctx.headers.get('cookie')` and
`ctx.headers.get('authorization')` are available anywhere in the pipeline.

**Writing response headers** is a first-class, additive channel: set
`ctx.responseHeaders` from any plugin hook or from an adapter inside
`mutate`, and the handler merges it into the response (JSON, MessagePack,
plugin-serialized bodies AND error responses):

```ts
const loginPlugin: OrbitPlugin = {
  name: "session-cookie",
  hooks: {
    onAfterParse({ ctx }) {
      // A session cookie issued by the protocol itself.
      ctx.responseHeaders = {
        "set-cookie": [
          "sid=abc; HttpOnly; Path=/; SameSite=Lax",
          "theme=dark; Path=/",
        ],
      };
    },
  },
};
```

- **Array values append one header line per item** — `set-cookie` in
  particular must be one line per cookie; `Headers.append` preserves that
  (the Node `Headers` iteration joins multi-value headers with `, `, which
  would corrupt cookie attributes — `@orbit/express` copies each cookie
  individually via `getSetCookie()`).
- **Adapters can set them too** — the classic login mutation:
  `ctx.responseHeaders = { 'set-cookie': 'session=…; HttpOnly; Path=/' }`
  inside `mutate` and the cookie rides out with the `{ success }` payload.
- **`execute()` copies the pipeline's value back** onto the context it
  received, so programmatic callers can read it too.
- **SSE caveat:** streaming responses send their headers the moment the
  stream starts, before the pipeline runs — a plugin-set `responseHeaders`
  cannot reach an SSE response. Pass them via the handler's `ctx` option
  instead: `orbit.handler(request, { responseHeaders: { … } })`.
- **CORS** stays a deployer concern: attach `Access-Control-*` in the
  framework layer (Express middleware, Hono middleware, a wrapping `fetch`
  in the worker) or via `ctx.responseHeaders` on the paths that need it.

**Negotiation metadata is emitted automatically:** every response carries
`vary: accept, accept-encoding` (so a CDN/proxy keying its cache on URL
cannot serve the wrong format), error responses carry `cache-control:
no-store`, and SSE responses carry `cache-control: no-cache`.

## Programmatic use (no HTTP)

```ts
const result = await orbit.execute(
  { query: 'user(id="1") { name }' },
  { state: { viewer: "ana" } }, // your auth context
);
// result: { status: 200, data: { name: 'Ana' }, fromCache: false, contentType: 'application/json; charset=utf-8' }
```

## File uploads (multipart/form-data)

Orbit supports file uploads **natively in the handler** — no plugin, no
framework, no new dependency. The frozen envelope contract is untouched:
files are _context_, never envelope fields.

### Client side

Send `multipart/form-data` with an `envelope` field (the JSON envelope) plus
one field per file:

```ts
const form = new FormData();
form.set(
  "envelope",
  JSON.stringify({
    do: "user.uploadAvatar",
    args: { filter: { id: "1" } },
  }),
);
form.set("avatar", avatarFile, "me.png");

await fetch("/orbit", { method: "POST", body: form });
```

### Server side

Every field whose value is a `File` lands in `ctx.files` (keyed by field
name) — the adapter reads it in `mutate`:

```ts
const adapter: DataAdapter = {
  entity: "user",
  async mutate(action, args, ctx) {
    const file = ctx.files?.["avatar"]; // a File — name, type, size, bytes
    if (action === "uploadAvatar" && file) {
      await s3.putObject({
        key: `${ctx.state.viewer}/${file.name}`,
        body: file,
      });
    }
    return { id: "1", invalidates: ["cache:user:1"] };
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

## Query cost limits

Depth alone does not bound the work a query can ask for: `user { a, b, … ×5000 }`
is one level deep but fans out into thousands of columns. Two more caps close
that shape, and they are enforced in the **parser** — so they apply to every
entry point (`execute`, the `handler`, SSE, and realtime subscriptions).

```ts
createOrbit({
  maxQueryDepth: 8, // default 10      — nesting levels
  maxQueryBreadth: 64, // default 128    — selections on a SINGLE node
  maxQueryComplexity: 512, // default 1024 — selections in the WHOLE tree
  maxPayloadBytes: 1_000_000, // default 10 MiB
});
```

`maxQueryBreadth` bounds fan-out at one level; `maxQueryComplexity` bounds the
total, catching the many-mid-width-nodes shape (`a { 100 fields, b { 100 … } }`)
that a per-node cap alone would admit. Exceeding either throws
`ORBIT_MAX_BREADTH_EXCEEDED` / `ORBIT_MAX_COMPLEXITY_EXCEEDED` (both 400) with
`details` naming the entity, field and position at which the budget ran out.
