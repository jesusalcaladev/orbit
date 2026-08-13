# 🗺️ Orbit — Roadmap & Status

> **Live checklist against `SPEC.md` (v2.0).** What's built, what's missing, and
> what to do next. This is the source of truth for "where we are" — update it as
> work lands.

**Legend:** ✅ Done · 🟡 Partial · ⬜ Not started · 🔴 Known to be weak

---

## 0. Core philosophy (SPEC §1) — ✅ Aligned

| Item | Status | Where |
| :--- | :--- | :--- |
| Thin zero-dependency contract layer (no magic ORM) | ✅ | `src/`, `package.json` (0 runtime deps) |
| Framework-agnostic handler `(Request) => Response` | ✅ | `Orbit#handler`, `docs/server.md`, `examples/node/standalone-server.ts` |
| Filters passed verbatim, no schema lock-in | ✅ | `src/types.ts` `Filters`, `src/adapters/types.ts` |

---

## 1. Plugin architecture (SPEC §2) — ✅ Core complete, ecosystem pending

| Hook (SPEC §2.1) | Status | Where |
| :--- | :--- | :--- |
| `onBeforeParse` | ✅ | `src/plugins/types.ts` |
| `onAfterParse` | ✅ | `src/plugins/types.ts` |
| `onBeforeResolve` (short-circuit) | ✅ | `src/plugins/types.ts`, engine `isShortCircuit` |
| `onBeforeExecute` (per entity) | ✅ | `src/plugins/types.ts` |
| `onAfterResolve` | ✅ | `src/plugins/types.ts` |
| `onBeforeSerialize` | ✅ | `src/plugins/types.ts` |
| `onError` | ✅ | `src/plugins/types.ts`, engine `#normalizeError` |
| Plugin registry + duplicate-name rejection | ✅ | `src/plugins/registry.ts` |
| Strict pipeline order (introspectable) | ✅ | `src/plugins/types.ts` `HOOK_ORDER` |

**⬜ First-party plugin packages** (the "brains", shipped as `@orbit/<target>`):  - [ ] **`@orbit/auth`** — hooks `onBeforeResolve`/`onBeforeExecute` with role checks. *Only a hand-written example exists today: `examples/node/03-auth-plugin.ts`.*
- [x] **`@orbit/cache`** — shipped as a distribution package that re-exports the plugin from the frozen core (one-way dependency, no `core → cache` cycle). The code-level split is a deliberate breaking change reserved for a future major — see §9.
- [ ] **`@orbit/redis`** — a `RedisCacheStore` implementing the `CacheStore` contract (contract is done and swappable; only the store impl is missing). Supports TTL/SWR and prefix invalidation.
- [ ] **`@orbit/kv-cache`** — Cloudflare Workers KV `CacheStore`, same contract as `@orbit/redis` (see below). (`@orbit/cloudflare-workers` is the *server wrapper* package — see §7.)
- [ ] **`@orbit/logging`** — observability/span-timing around hooks; will help with benchmark B3.

---

## 2. Query Syntax — OQS (SPEC §3) — ✅ Complete

| Item | Status | Where |
| :--- | :--- | :--- |
| Entity roots + verbatim filters | ✅ | `src/parser.ts` |
| Nested relations / field projection | ✅ | `src/parser.ts`, engine BFS |
| Depth limit (DoS) | ✅ | `DEFAULT_MAX_DEPTH`, `ORBIT_MAX_DEPTH_EXCEEDED` |
| Mutations `do: "entity.action"` | ✅ | `src/types.ts`, engine `#executeMutation` |
| `filter` / `payload` / `return` sub-graph | ✅ | mutation envelope |
| `invalidates` keys on mutation result | ✅ | `MutationResult` |

---

## 3. Envelope & transport (SPEC §4, §7) — ✅ Done

| Item | Status | Where |
| :--- | :--- | :--- |
| Envelope validation (exactly one of query/do) | ✅ | `src/envelope.ts` |
| Max payload size + early 413 | ✅ | `src/envelope.ts`, engine |
| JSON (default) | ✅ | engine |
| MessagePack (zero-dep codec) | ✅ | `src/serialize/msgpack.ts` |
| SSE streaming (level-by-level) | ✅ | `Orbit#stream` + `text/event-stream` handler |
| gzip (`CompressionStream`) | ✅ | engine `gzipBytes` |
| `Accept` / `Accept-Encoding` negotiation | ✅ | `src/serialize/negotiate.ts` |
| **File uploads (multipart/form-data → `ctx.files`)** | ✅ | engine `#readMultipart`, `OrbitContext.files` — native, zero-dep, envelope contract untouched |

**✅ Parsed-node naming DECIDED (frozen):** the node field is `origin` (no `_origin`); cache specs never live on the node (`_cacheSpec` rejected — caching is request context, read from `ctx.envelope.cache` / the `x-orbit-cache` header). Mutation `return` nodes are stamped `origin: 'mutate'`. Pinned in spec §11 + `test/contract.test.ts`.

---

## 4. Adapters (SPEC §5) — Core contract done; adapters pending

| Item | Status | Where |
| :--- | :--- | :--- |
| `DataAdapter` contract (`resolve`/`batch`/`mutate`) | ✅ | `src/adapters/types.ts` |
| `AdapterRegistry` (entity lookup) | ✅ | `src/adapters/registry.ts` |
| N+1 batching (group siblings → one `batch()`) | ✅ | engine |
| `memoryAdapter` | ✅ | `src/adapters/memory.ts` — **keep in core** (reference + test double) |

**Decisions / TODOs:**
- [x] **Remove `fetchAdapter` from core** — done (see CHANGELOG): REST was opinionated and didn't belong in the pure contract layer; example 04 writes the frozen contract by hand. A future **`@orbit/rest`** package can add a fetch-based adapter.
- [ ] **`@orbit/postgres`** — adapter translating `filters` → `WHERE ...` via `pg`.
- [ ] **`@orbit/mongo`** — adapter mapping `filters` → `$match` via the `mongodb` driver.
- [ ] **`@orbit/sqlite`** *(optional)* — quick local/embedded adapter.
- [ ] **Optional `schema` on `DataAdapter`** — SPEC §5.1 mentions this for type-generation plugins. Not implemented; decide if it ships.
- [ ] Decide whether `delete`/`create` verb conventions and any `subscribeToEntity` (live updates) belong in the contract **before** writing the DB adapters (changing the contract later = touching everything).

---

## 5. Caching (SPEC §6) — Core ✅, advanced spec 🟡

| Item | Status | Where |
| :--- | :--- | :--- |
| `cache` envelope + `x-orbit-cache` header | ✅ | `src/plugins/cache.ts` `parseCacheSpec`/`readSpec` |
| TTL / stale-while-revalidate / background refresh | ✅ | `src/plugins/cache.ts` |
| `invalidates` echoed on mutations | ✅ | `MutationResult` + engine |
| Prefix invalidation (`invalidatePrefix`) | ✅ | cache plugin |
| Swappable `CacheStore` (→ Redis/Memcached/KV) | ✅ | `CacheStore` contract |

**⬜ Not yet:**
- [ ] **Field-level TTL** (`field:price=ttl=60, field:name=ttl=3600`) — `parseCacheSpec` only parses `ttl`/`stale` today; field-scoped cache keys don't exist.
- [ ] **Redis-backed store** → **`@orbit/redis`** (implements `CacheStore`).
- [ ] **Cloudflare KV store** → **`@orbit/kv-cache`** (implements `CacheStore` for Workers; distinct from the `@orbit/cloudflare-workers` *server wrapper*).
- [ ] **Memcached store** → **`@orbit/memcached`** *(optional)*.

---

## 6. Errors (SPEC §8) — ✅ Done

| Item | Status | Where |
| :--- | :--- | :--- |
| `OrbitError` + standard codes + HTTP status | ✅ | `src/errors.ts` |
| `onError` translation hook | ✅ | engine `#normalizeError` |
| Client-predictable behavior | ✅ | `docs/errors.md` |

---

## 7. First-party adapters / plugins / packages (SPEC §9) — ⬜ The bulk of what's missing

The core is a single `@orbit/core` package. The SPEC's distribution model is
**separate packages**. The full blueprint — contracts, scaffolding
conventions, build order — lives in **[docs/ecosystem.md](./docs/ecosystem.md)**.
Future structure (each as its own published package):

```
@orbit/core                 ✅ (exists — engine, hooks, OQS, envelope, memory adapter)
@orbit/hono                 ✅ thin server wrapper — the Orbit handler on Hono
@orbit/express              ✅ thin server wrapper — the Orbit handler on Express
@orbit/cloudflare-workers   ✅ thin fetch handler — the Orbit handler on Workers (incl. Workers-native realtime)
@orbit/bun / @orbit/deno    ⬜ (if desired — handler already runs anywhere)
@orbit/postgres             ⬜
@orbit/mongo                ⬜
@orbit/sqlite               ⬜ (optional)
@orbit/rest                 ✅ fetch-based adapter (queries→GET, mutations→POST/PATCH/DELETE)
@orbit/cache                ✅ distribution home; impl stays in frozen core (see §9 note)
@orbit/redis                ⬜ (CacheStore for Redis — cache + optional feature store)
@orbit/kv-cache             ⬜ (CacheStore for Cloudflare KV)
@orbit/memcached            ⬜ (optional)
@orbit/auth                 ⬜
@orbit/logging              ⬜
@orbit/client               ⬜ core frontend client — protocol must be frozen first
@orbit/client-react         ⬜ cache-aware React bindings
```

- [x] **Monorepo set up** — pnpm workspaces, `packages/core` holds `@orbit/core`; docs/spec/examples live at the root. Further packages slot in as `packages/*` per `docs/ecosystem.md`. Turbo/nx can be added when the build graph grows.
- [ ] **Clients** (`@orbit/client`, `@orbit/client-react`) — **defer until the envelope/hook contract is frozen.**

---

## 8. Performance & quality (SPEC §11) — ✅ Measured against real GraphQL

| Benchmark | Status |
| :--- | :--- |
| B1 latency (P99) | ✅ 0.05–0.09 ms vs graphql-js 0.092–0.098 ms cached-doc / 1.65–1.75 ms naive (measured) — near-parity once both cache the parse; naive servers pay ~24–35× |
| B2 deep-nest DB round-trips | ✅ 5 vs graphql-js 1112 resolver calls (measured) |
| B3 throughput (engine core vs goal ~30k) | ✅ ~98–116k RPS core — ~3.2–3.4× graphql-js cached-doc (~30–34k), ~55–75× naive (~1.4–2.1k); full fetch path is undici-bound (~11.2–13.3k), documented in `docs/benchmarks.md` |
| B4 payload size | ✅ 19 KB (msgpack+gzip) vs graphql-js JSON 446 KB (measured) — gzip equalizes at 19.1 KB; the protocol's edge is round-trips/throughput/streaming, not B4 |
| B5 streaming TTFB | ✅ 5–6 ms |
| B6 reconnect/warm-cache replay | ✅ Excellent |
| B7 realtime fan-out (200 sockets) | ✅ Excellent — 7.7–9.1 ms fan-out, 3.6–8.4 ms resume replay |
| B8 wire path (real HTTP, keep-alive) | ✅ ~1.5× graphql-js (~1.5k vs ~1.03k RPS) — same node:http server, same client, measured |
| B9 deep-nest warm replay (cache vs DataLoader) | ✅ 0.15 ms / 0 DB calls vs 59 ms / 5 DB batches per request — DataLoader closes the cold N+1 but pays all 5 batches every request; Orbit's contract-level cache replays warm from memory |

**Benchmarks are now real head-to-heads:** `graphql` (v17) is a devDependency of
**the bench harness only** (`bench/graphql.ts` — the core keeps its
zero-runtime-dependency contract) and runs the same fixtures on the same
machine. Competition numbers in `docs/benchmarks.md` are measured, not quoted
from the spec. Run `npm run bench` to refresh B1–B9 on any machine; GitHub
Actions CI (`pnpm run bench` on ubuntu/node 22) uploads the results as an
artifact on every push.

---

## 9. Suggested execution order

1. ✅ **Core contract frozen** — envelope, DataAdapter, error codes, QueryNode
   shape and hook signatures pinned in spec §3/§6/§9/§11 + `test/contract.test.ts`.
   Decisions: `origin` (no `_origin`), no `_cacheSpec` on the node, no
   `delete`/`create` methods, `subscribe` in the contract.
2. ✅ **Benchmarks are real** — graphql-js v17 measured head-to-head on this
   machine (B1–B4). Honest per-metric picture: ~24–35× vs naive GraphQL and
   ~1.4–1.8× vs cached-document GraphQL on single-query latency (near-parity
   once both cache the parse); ~222× on deep-nest round-trips (5 vs 1112
   resolver calls); ~3.2–3.4× on throughput vs cached-doc; parity on
   compressed payload (gzip equalizes — the edge is
   round-trips/throughput/streaming, not B4). B3's goal is met — no engine
   change needed; the only remaining gap is the undici transport, documented.
3. **Split packages in a monorepo** — DONE: `@orbit/rest` (fetch-based
   adapter, shipped with 13 tests against the real `DataAdapter` contract) and
   `@orbit/cache` (distribution home of the cache plugin — re-exports from the
   frozen core to keep the dependency direction one-way; Redis/KV stores
   implement the re-exported `CacheStore` contract). (`@orbit/core` keeps only
   the memory adapter as reference.) **Server wrappers shipped too:**
   `@orbit/hono` + `@orbit/express` — thin raw bridges that pass the
   framework's original request to the engine and pipe the response through
   untouched (full protocol fidelity, see `docs/server.md`), each with 11
   real end-to-end tests and a layered book-API example (`examples/node/10-express.ts`, `examples/node/11-hono.ts`). **`@orbit/cloudflare-workers`** ships the same book API behind a plain `fetch` handler with Workers bindings on the OrbitContext and Workers-native WebSocket realtime (`examples/node/12-cloudflare-workers.ts`).
4. **Ship `@orbit/auth`** (easy — hooks already exist).
5. **Ship `@orbit/redis`** (Redis `CacheStore`), then **`@orbit/kv-cache`**
   (Cloudflare KV).
6. **Ship `@orbit/postgres` + `@orbit/mongo`** (implement the frozen `DataAdapter`).
7. **Clients** (`@orbit/client`, `@orbit/client-react`) only once the protocol is stable.
8. Optional stretch: field-level TTL, `@orbit/sqlite`, `@orbit/memcached`,
   type-generation via `adapter.schema`.


---

## Status recap

| Area | Status |
| :--- | :--- |
| Core engine (parse → hooks → resolve → serialize) | ✅ |
| Contract freeze (spec §3/§6/§9/§11 + contract tests) | ✅ |
| Monorepo (pnpm workspaces) | ✅ (`packages/core`; more packages slot in) |
| Plugin system (all 7 hooks + registry) | ✅ |
| OQS + mutations | ✅ |
| Envelope / serialization / SSE / gzip / **file uploads** | ✅ |
| Errors | ✅ |
| Caching core (TTL/SWR/invalidate) | ✅ (in core; `@orbit/cache` distribution package shipped) |
| In-memory adapter | ✅ (keep in `@orbit/core`) |
| REST/fetch adapter | ✅ (`@orbit/rest` — queries→GET, mutations→POST/PATCH/DELETE) |
| Benchmarks | ✅ (B1–B9 goals met) |
| Auth plugin | ⬜ (`@orbit/auth`) |
| Redis cache store | ⬜ (`@orbit/redis`) |
| Cloudflare KV cache store | ⬜ (`@orbit/kv-cache`) |
| Postgres / Mongo adapters | ⬜ (`@orbit/postgres`, `@orbit/mongo`) |
| Server wrappers | ✅ (`@orbit/hono`, `@orbit/express`, `@orbit/cloudflare-workers` — thin raw bridges / fetch handler + realtime on every host) |
| Clients | ⬜ (`@orbit/client`, `@orbit/client-react`, defer) |
