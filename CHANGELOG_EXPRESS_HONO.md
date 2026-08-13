# Changelog — @orbit/express & @orbit/hono (v0.0.2)

This changelog tracks the server-wrapper packages (`@orbit/express`,
`@orbit/hono`) on top of the core protocol. The core's own history lives in
[`CHANGELOG.md`](./CHANGELOG.md).

## v0.0.2 (unreleased)

### Server wrappers: shipped as thin raw bridges

- **`@orbit/express`** — `expressHandler({ orbit, onError?, ctx? })` and
  `createExpressApp(orbit, { path })`. Reads the raw body itself (reuses
  `req.body` when a parser ran, otherwise reads the stream), so **no
  `express.json()` is required** and MessagePack / multipart bodies reach the
  engine untouched. The engine's response — status, every header, and the
  body including SSE streams — is piped straight through. Stream errors are
  handled instead of crashing the process.
- **`@orbit/hono`** — `honoHandler({ orbit, onError?, ctx? })` and
  `createHonoApp(orbit, { path })`. Passes `c.req.raw` straight to the
  engine and returns its `Response` untouched. Infrastructure errors rethrow
  by default so the idiomatic `app.onError` handles them.
- Both accept the engine (`createOrbit()`) **or** a plain handler function
  (`OrbitServer`), with an optional `ctx` for authenticated state.

### Realtime

- **`attachRealtime(server, orbit, options)`** on both packages mounts the
  core WebSocket transport (`createRealtimeServer`) on the same `node:http`
  server — one call, `ws://host/realtime`. Call it once per server (a second
  call throws to protect the handshake); a `server.on('close')` hook releases
  sessions as a belt-and-suspenders.
- End-to-end realtime tests in both packages: WS subscribe → mutation/hub
  event → frame.

### Error semantics

- Protocol errors are ordinary HTTP responses (`{ error: { code, message } }`)
  — they never reach `onError`. `onError` is reserved for infrastructure
  failures: Express's is a classic error middleware `(err, req, res, next)`,
  Hono's returns a `Response`. The Express default logs and answers a generic
  500 (no internal details leaked).

### Examples

- **`examples/10-express.ts` / `examples/11-hono.ts`** — the layered book API
  (`examples/book/`): domain → engine → thin framework entries, with relations,
  authn in the framework + authz in the engine, client-driven caching,
  realtime, and a full protocol walkthrough on both hosts.
- Graceful shutdown in `try/finally` — a failing demo can never hang the
  process; `run-all.ts` integrates both entries.

### Tooling & hygiene

- Both packages now build and test on **vitest 4 + TypeScript 7 +
  @types/node 24** (`@hono/node-server` for the hono tests), aligned with
  `@orbit/rest` / `@orbit/cache`.
- `tsconfig.build.json`, package metadata (files/keywords/license), READMEs
  for both packages, `docs/server.md` realtime snippets, and
  `docs/ecosystem.md` + `ROADMAP.md` status flips to shipped.
