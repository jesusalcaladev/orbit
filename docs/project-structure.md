# Project structure — the recommended architecture

> **Runnable version:** [`examples/starter/`](../examples/starter/) is this
> document as code — copy that folder to start a project. The grown-up
> variant (one engine behind Express, Hono and Cloudflare Workers) lives in
> [`examples/node/book/`](../examples/node/book/).

## Start a project in five steps

```bash
cp -r examples/starter my-app && cd my-app   # 1. the skeleton
# package.json + tsconfig.json are already wired (strict TS, ESM, Node ≥ 22.18)
pnpm install                                  # 2. toolchain
pnpm run dev                                  # 3. http://localhost:3000/orbit
pnpm test                                     # 4. the suite (node --test, no sockets)
# 5. grow it: one file per decision — see "Growing the starter" below
```

## The tree

```
my-app/
├── src/
│   ├── domain/            entities + repositories — pure TypeScript
│   │   ├── users.ts       the User entity, its repository, its seeds
│   │   └── posts.ts       the Post entity, validation lives here (plain Errors)
│   ├── adapters/          DataAdapter per entity — the ONLY bridge to Orbit
│   │   ├── users.ts       resolve() — root lookups + relations via ctx.parent
│   │   ├── posts.ts       resolve() + mutate() — roles, error mapping, invalidates
│   │   └── index.ts       the registry: every entity the protocol can reach
│   ├── plugins/           cross-cutting hooks (the protocol's "brains")
│   │   └── authz.ts       key → caller mapping (hosts) + read policy (engine)
│   ├── server/            interface layer — thin hosts, one file each
│   │   └── node-http.ts    transport + authn only; Express/Hono/Workers plug the same app
│   ├── app.ts             composition root: createOrbit({ adapters, plugins })
│   ├── config.ts          the ONLY module that reads process.env
│   ├── index.ts           entry point: config → app → host → listen
│   └── demo.ts            headless walkthrough over real HTTP (asserted)
├── test/
│   └── app.test.ts        the protocol through orbit.execute() — no sockets
├── package.json           scripts + deps (zero runtime deps beyond @orbit/core)
└── tsconfig.json          strict, NodeNext, erasable-syntax-only
```

## The import matrix — what each layer may import

| Layer | `domain` | `adapters` | `plugins` | `@orbit/*` | HTTP / framework | `process.env` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `src/domain/` | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| `src/adapters/` | ✅ | — | ✅ (errors/roles) | ✅ | ❌ | ❌ |
| `src/plugins/` | ❌ | ❌ | — | ✅ | ❌ | ❌ |
| `src/app.ts` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ (takes `Config`) |
| `src/server/` | ❌ | ❌ | ✅ (authn) | ✅ | ✅ | ❌ (takes `Config`) |
| `src/index.ts` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ (`loadConfig()`) |
| `test/` | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

Two lines matter most: **the domain never imports Orbit** (business logic
survives any protocol or database swap) and **only `config.ts` reads the
environment** (everything else is testable as a pure function).

## Why this shape maps to the protocol

| Orbit idea | Where it lives in the tree |
| :--- | :--- |
| "The developer knows how to fetch data" | `domain/` owns queries and validation; adapters pass filters **verbatim** |
| N+1 batching is a contract | sibling relations collapse into one `batch()` call per level — implement `batch()` (or use `memoryAdapter`) in `adapters/` |
| Auth is a hook, not a framework feature | `plugins/authz.ts` runs `onBeforeResolve` — enforced for every host and for direct `execute()` calls |
| The client defines the cache | `createCachePlugin()` in `app.ts`; spec travels on the envelope (`cache: 'ttl=300'`) or `x-orbit-cache` header |
| One engine, many hosts | `app.ts` returns the engine; `server/` files are disposable adapters around it |
| Errors are a contract | adapters translate domain `Error`s into `OrbitError` codes (`FILTER_INVALID`, `PERMISSION_DENIED`, …) |

### The authentication / authorization split

Authentication ("who is calling") is a **host** concern: every server entry
maps a credential to `ctx.state.caller`. Authorization ("what may they do")
is an **engine** concern: the policy plugin + `requireCaller` enforce it on
queries, on mutation `return` re-queries and inside `mutate` — so no host,
script or `execute()` call can bypass it. Never put authorization only in
the HTTP layer: it works until something else calls the engine.

### Plugin order is a security control

Hooks run in registration order (spec §11). Register **policy plugins before
the cache plugin**: otherwise a cache hit could short-circuit before the
policy runs and serve gated data to an unauthenticated caller. The cache
plugin goes last anyway (it must store the *final* payload — anything with
an `onBeforeSerialize` hook registers before it).

## Where each first-party package lands

| Package | Layer in this architecture |
| :--- | :--- |
| `@orbit/postgres`, `@orbit/mongo`, `@orbit/rest` | `adapters/` — they *are* `DataAdapter`s over injected clients |
| `@orbit/auth`, `@orbit/rate-limit`, `@orbit/logging`, `@orbit/metrics` | `plugins/` — mounted in `app.ts` |
| `@orbit/cache`, `@orbit/redis`, `@orbit/kv-cache` | `app.ts` — `createCachePlugin({ store })` |
| `@orbit/express`, `@orbit/hono`, `@orbit/cloudflare-workers` | replace `server/` + `index.ts` (the engine doesn't change) |
| `@orbit/client`, `@orbit/react` | the frontend — envelope calls, SSE, realtime, hooks + cache |

## Growing the starter — one file per decision

| When you need… | Change | Where |
| :--- | :--- | :--- |
| A real database | repository backed by `pg` / `mongodb` (or `@orbit/postgres` / `@orbit/mongo` directly) | `domain/` + `adapters/` |
| An existing REST backend | `@orbit/rest` fetch adapter | `adapters/index.ts` |
| Shared cache / multi-instance | `createRedisCacheStore` / `createKvCacheStore` | `app.ts` |
| Distributed rate limiting | `@orbit/rate-limit` + `createRedisRateLimitStore` | `app.ts` |
| A framework host | `@orbit/express` / `@orbit/hono` wrapper; authn mapping rides `ctx:` | replace `server/` |
| Realtime | adapter `subscribe` hook + `attachRealtime(server, orbit)` | `adapters/` + host |
| Larger payloads on the wire | nothing — msgpack/SSE/gzip are negotiated by `Accept` | — |

Keep scaling **in this order**: domain first, then adapters, then plugins,
and touch `server/` last — if a change needs a new HTTP framework to exist,
the layering has leaked.

## Testing

Three altitudes, no overlap:

1. **Engine tests (default)** — `orbit.execute(envelope, ctx)` in-process:
   parse → policy → adapters → cache, asserted with plain `assert`. Fast
   enough to run per save; `ctx.state.caller` plays the role of any host.
2. **Host integration** — boot `createOrbitServer(orbit, config)` on port
   `0` and speak real HTTP, exactly like [`src/demo.ts`](../examples/starter/src/demo.ts).
   Assert status codes, headers and the wire shape.
3. **Frontend end-to-end** — `@orbit/client` / `@orbit/react` against the
   real server (the repo uses Playwright for this on the web demos).

Rules of thumb: a new adapter ships with a test per filter it supports; a
new plugin ships with a test for its **denied** path, not only the happy
one; never let tests share an app instance (the starter builds fresh
repositories per `createApp()` call).

## Common mistakes

| Mistake | Why it hurts | Fix |
| :--- | :--- | :--- |
| Business logic inside adapters | the domain becomes untestable without Orbit | validate in `domain/`, translate errors in `adapters/` |
| Authorization only in the HTTP layer | any direct `execute()` bypasses it | policy plugin in the engine |
| Cache plugin registered before a serializer hook | caches stale/pre-transform payloads | cache last (spec §11 enforces it) |
| Interpreting filters (`id` as "the primary key") | the protocol promises filters are verbatim | pass strings through; the repository decides |
| Reading `process.env` in modules | untestable, implicit global config | `loadConfig()` once, pass `Config` down |
| Giant "utils" or single-file apps | no place for policy/adapter seams | the five folders above |

## Result types today

The protocol is *intent, not schema*: results are untyped at the wire level
(deliberately — see [spec.md](../spec.md) §2). Until `adapter.schema`-based
type generation lands (top of the [ROADMAP](../ROADMAP.md) P1 queue), type
results **at the boundary you own**: declare the shape next to the call
site (`const { data } = await orbit.execute(...) as { data: MyShape }`), or
keep query strings and their result interfaces paired in one module per
feature. Never sprinkle assertions through UI code — one boundary, one
type.

## Concept demos vs project templates

`examples/node/` 01–13 are **concept demos**: one file per protocol facet,
deliberately self-contained so the idea isn't hidden behind structure. When
structure is the point, the templates are:

- [`examples/starter/`](../examples/starter/) — a new project, five layers,
  tests, growth table (this document as code).
- [`examples/node/book/`](../examples/node/book/) — the same layering in
  production shape: policy + timing plugins, realtime, and one engine served
  by Express, Hono and Cloudflare Workers.
