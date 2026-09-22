# The Orbit starter — how a new project is shaped

This folder is the **recommended skeleton for a new Orbit project**: five
layers, one rule per folder, nothing more. Copy it, rename it, grow it —
the full rationale lives in
[docs/project-structure.md](../../docs/project-structure.md).

```
src/
  domain/          entities + repositories — pure TypeScript, ZERO Orbit imports
  adapters/        DataAdapter per entity — the only bridge to the protocol
  plugins/         cross-cutting hooks — authz policy for every host & caller
  app.ts           composition root — createOrbit({ adapters, plugins })
  server/          interface layer — thin hosts; swap this file, keep the app
  config.ts        the only module that reads process.env
  index.ts         entry point — config → app → host → listen
  demo.ts          headless walkthrough over real HTTP (also runs in run-all)
test/
  app.test.ts      the whole protocol through orbit.execute() — no sockets
```

## The rules

1. **The domain never imports Orbit.** `src/domain/` is plain business
   logic — swap the in-memory repositories for Postgres and nothing else
   changes shape. (Try it: `grep -r "@orbit" src/domain` → nothing.)
2. **Adapters are the only bridge.** Filters arrive verbatim from the query
   (`id="1"`), relations resolve through `ctx.parent`, mutations map domain
   errors onto protocol errors and declare what they invalidate.
3. **Plugins own cross-cutting behavior.** The authz policy gates reads in
   the engine, so it holds for *every* host — HTTP, Workers, or a direct
   `orbit.execute()` call. Register policy plugins **before** the cache
   plugin: hooks run in registration order, so a cache hit can never bypass
   authorization.
4. **`app.ts` is the composition root; hosts stay thin.** The node:http host
   does transport + authentication only. Point Express, Hono or Cloudflare
   Workers at the same engine and the API behaves identically
   ([docs/server.md](../../docs/server.md)).
5. **Tests talk to the engine, not the network.** `createApp()` is a plain
   function — `test/app.test.ts` drives parse → policy → adapters → cache
   in-process with `orbit.execute()`.

## Authentication vs authorization (why they live in different files)

| Concern | Where | In this starter |
| :--- | :--- | :--- |
| Authentication — *who is calling* | the host (`server/`, `index.ts` never sees keys) | `x-api-key` → `identifyCaller()` → `ctx.state.caller` |
| Authorization — *what may they do* | the engine (`plugins/`, `adapters/`) | `authzPlugin()` gates reads, `requireCaller()` gates writes |

## Run it

Inside this repository (Node ≥ 22.18 — examples run TypeScript natively):

```bash
pnpm run build                       # once — examples import from dist/
node examples/starter/src/index.ts   # server on :3000 (PORT, ORBIT_PATH, ORBIT_MAX_DEPTH)
pnpm run test:starter                # the suite above (node --test)
node examples/starter/src/demo.ts    # headless HTTP walkthrough with assertions
```

Copy it out of the repo:

```bash
cp -r examples/starter ~/my-app && cd ~/my-app
# package.json + tsconfig.json are already wired; then:
pnpm install && pnpm run dev
```

```bash
curl -s localhost:3000/orbit \
  -H 'content-type: application/json' \
  -H 'x-api-key: starter-admin-1' \
  -d '{"query":"user(id=\"1\") { name, posts(status=\"published\") { title } }"}'
# No key on a `user` query → 403 ORBIT_PERMISSION_DENIED (the policy plugin).
```

API keys for the demo: `starter-admin-1` (admin) · `starter-member-2` (member).

## Growing it — one file per decision

| When you need… | Change | Where |
| :--- | :--- | :--- |
| A real database | swap the repository for `@orbit/postgres` / `@orbit/mongo` | `adapters/` (+ `domain/`) |
| An existing REST API as a source | `@orbit/rest` | `adapters/index.ts` |
| Shared cache / multi-instance | `createRedisCacheStore` / `createKvCacheStore` | `app.ts` |
| Rate limiting | `@orbit/rate-limit` (+ Redis store) | `app.ts` plugins |
| Request logging / metrics | `@orbit/logging` / `@orbit/metrics` | `app.ts` plugins |
| Framework host | `@orbit/express` / `@orbit/hono` / `@orbit/cloudflare-workers` | replace `server/` + `index.ts` |
| Realtime subscriptions | add `subscribe` to an adapter + `attachRealtime` | `adapters/` + host |
| Frontend | `@orbit/client` (vanilla) or `@orbit/react` (hooks + cache) | your app |

## Read next

- [docs/project-structure.md](../../docs/project-structure.md) — the full
  architecture reference (import matrix, growth path, common mistakes).
- [`examples/node/book/`](../node/book/) — the same layering grown up: a
  policy + timing plugin, realtime, and **one engine behind three hosts**
  (Express, Hono, Cloudflare Workers).
- [docs/ecosystem.md](../../docs/ecosystem.md) — every first-party package
  and which layer it belongs to.
