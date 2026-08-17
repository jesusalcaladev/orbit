# The book API example

A small but complete API — books, authors and reviews — served **identically**
by three hosts from one engine. It exists to show real-world Orbit usage:
layered architecture, authentication vs authorization, relations, mutations,
caching and the full wire protocol.

## Layers

```
book/
  data.ts     domain      — entities + in-memory repository (validated
                            mutations, cascade deletes, fresh-copy reads).
                            Zero Orbit/framework imports.
  engine.ts   application — the Orbit engine: repository-backed adapters
                            (relations via ctx.parent), an authorization
                            policy plugin, a timing plugin and client-driven
                            caching. Framework-agnostic.
  demo.ts     client      — a protocol walkthrough on `@orbit/client` that
                            runs against any host: relational queries, gated
                            identity, auth mutations, role checks,
                            validation, MessagePack in+out, SSE streaming,
                            caching and realtime (subscribe + socket).
../10-express.ts  interface — Express host (thin: transport + authn only).
../11-hono.ts     interface — Hono host (same engine, same API).
../12-cloudflare-workers.ts  interface — the Workers fetch handler (same engine, same API).
```

## The security model (why it is split this way)

| Concern | Where | How |
| :--- | :--- | :--- |
| Authentication ("who is calling") | the framework entries | `x-api-key` → caller identity via `identifyApiKey`, injected as `ctx.state.caller` |
| Authorization ("what may they do") | the engine (`engine.ts`) | the `book-policy` plugin gates reads; mutation adapters check roles (`book.remove` = admin only) |

Authorization lives in the engine on purpose: it is enforced no matter which
HTTP host serves the API — or even if a client calls `orbit.execute()`
directly.

## What the walkthrough proves

- One request resolves `books → authors → reviews` with no N+1.
- `user { id, role }` is gated (403 `ORBIT_PERMISSION_DENIED` without a key).
- Mutations require a key; `books.create` / `books.remove` require the admin role.
- Bad input fails with the standard error contract, not a 500.
- MessagePack round-trips in a single request; SSE streams the graph in frames.
- **Cache lifecycle, honestly**: `cache: 'ttl=60'` opts a query in (on the
  envelope, equivalent to the `x-orbit-cache` header) — miss → hit with
  `fromCache: true` — and a mutation that changes data clears the store
  server-side, so the next identical query refetches (`fromCache: false`).
  Cache keys are opaque `orbit:<hash>` strings — see `engine.ts`.
- **Realtime**: a WebSocket subscription to `reviews` receives the next
  `reviews.add` mutation as a `{ type: 'created', ... }` event pushed through
  the same engine (spec §10).

## Run

```sh
pnpm run build && node examples/node/frameworks/10-express.ts   # Express on :3100
pnpm run build && node examples/node/frameworks/11-hono.ts      # Hono on :3200
node examples/node/frameworks/12-cloudflare-workers.ts          # Workers — no port, worker.fetch direct
# or all back-to-back:
node examples/node/run-all.ts
```

The realtime endpoint lives on the **same http server** for the Node hosts:
`ws://localhost:3100/realtime` (Express) and `ws://localhost:3200/realtime`
(Hono), mounted with `attachRealtime(server, orbit)`. On Workers, realtime is
the native `WebSocketPair` upgrade served by `createWorker` — the example
drives the identical session contract in-process (no workerd in Node).

> API keys: `admin-123` (admin) · `ana-456` (member).
