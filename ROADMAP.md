# 🗺️ Orbit — Roadmap & Status

> **Live checklist against `SPEC.md` (v2.0).** What's built, what's missing, and
> what to do next. This is the source of truth for "where we are" — update it as
> work lands.

**Legend:** ✅ Done · 🟡 Partial · ⬜ Not started · 🔴 Known to be weak

---

## 0. Core philosophy (SPEC §2) — ✅ Aligned

| Item | Status | Where |
| :--- | :--- | :--- |
| Thin zero-dependency contract layer (no magic ORM) | ✅ | `src/`, `package.json` (0 runtime deps) |
| Framework-agnostic handler `(Request) => Response` | ✅ | `Orbit#handler`, `docs/server.md`, `examples/node/standalone-server.ts` |
| Filters passed verbatim, no schema lock-in | ✅ | `src/types.ts` `Filters`, `src/adapters/types.ts` |

---

## 1. Plugin architecture (SPEC §11) — ✅ Core complete, ecosystem pending

| Hook (SPEC §11) | Status | Where |
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
| **Service injection into ctx** (`provides` → `ctx.providers`) 🧪 | ✅ | `src/plugins/types.ts`, engine `collectProviders` — boot-time services injected before any hook runs; duplicate/reserved names rejected at `createOrbit`; reaches queries, mutations, `stream()`, `return` re-queries and realtime gates. 8 tests in `test/providers.test.ts`. |

**⬜ First-party plugin packages** (the "brains", shipped as `@orbit/<target>`):  - [x] **`@orbit/auth`** — shipped: `authenticate`/`authorize`/`scope` + `bearerAuth`/`apiKeyAuth` presets and `requireCaller`/`requireRole` helpers (identity stamped in `onBeforeParse` reaches mutations too). 12 tests.
- [x] **`@orbit/cache`** — shipped as a distribution package that re-exports the plugin from the frozen core (one-way dependency, no `core → cache` cycle). The code-level split is a deliberate breaking change reserved for a future major — see §9.
- [x] **`@orbit/redis`** — shipped: `createRedisCacheStore({ client, prefix?, ttlSeconds? })` — a `CacheStore` over an injected node-redis client (dependency-free beyond `@orbit/core`). TTL/SWR, prefix invalidation via `SCAN`, `clear()` via `SCAN`+`DEL` (never `FLUSHDB`) — plus **`createRedisRateLimitStore`**: the distributed atomic bucket store for `@orbit/rate-limit` (one Lua `EVAL` per consume, prefix + server-side TTL, `reset()` via SCAN+DEL). 14 tests against in-memory fakes (no network).
- [x] **`@orbit/kv-cache`** — shipped: `createKvCacheStore({ namespace, prefix?, expirationTtl? })` — a `CacheStore` over an injected Workers KV binding. `clear()`/prefix invalidation page through `list()`. 8 tests against an in-memory fake. (`@orbit/cloudflare-workers` is the *server wrapper* package — see §7.)
- [x] **`@orbit/logging`** — shipped: dependency-free request-timing plugin (one structured `LogEntry` per resolved query or error). 5 tests.

---

## 2. Query Syntax — OQS (SPEC §4) — ✅ Complete

| Item | Status | Where |
| :--- | :--- | :--- |
| Entity roots + verbatim filters | ✅ | `src/parser.ts` |
| Nested relations / field projection | ✅ | `src/parser.ts`, engine BFS |
| Depth limit (DoS) | ✅ | `DEFAULT_MAX_DEPTH`, `ORBIT_MAX_DEPTH_EXCEEDED` |
| Mutations `do: "entity.action"` | ✅ | `src/types.ts`, engine `#executeMutation` |
| `filter` / `payload` / `return` sub-graph | ✅ | mutation envelope |
| `invalidates` keys on mutation result | ✅ | `MutationResult` |

---

## 3. Envelope & transport (SPEC §3, §7) — ✅ Done

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

## 4. Adapters (SPEC §5, §9) — Core contract done; adapters pending

| Item | Status | Where |
| :--- | :--- | :--- |
| `DataAdapter` contract (`resolve`/`batch`/`mutate`) | ✅ | `src/adapters/types.ts` |
| `AdapterRegistry` (entity lookup) | ✅ | `src/adapters/registry.ts` |
| N+1 batching (group siblings → one `batch()`) | ✅ | engine |
| `memoryAdapter` | ✅ | `src/adapters/memory.ts` — **keep in core** (reference + test double) |

**Decisions / TODOs:**
- [x] **Remove `fetchAdapter` from core** — done (see CHANGELOG): REST was opinionated and didn't belong in the pure contract layer; example 04 writes the frozen contract by hand. A future **`@orbit/rest`** package can add a fetch-based adapter.
- [x] **`@orbit/postgres`** — adapter translating `filters` → parameterized
  `WHERE …` over an injected `pg` client, with `IN`-clause batching, operator
  overrides and `create`/`update`/`delete` mutations. 30 tests against an
  in-memory fake (no network in CI).
- [x] **`@orbit/mongo`** — adapter mapping `filters` → match documents over an
  injected `mongodb` client: equality/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$regex`
  operator overrides, `$in`-clause batching, `create`/`update`/`delete`
  mutations, `toId`/`fromId` id conversion (ObjectId support), and a
  no-operator-injection guarantee (field names are charset-validated, payload
  values are walked recursively so `$`-keyed objects can never become query
  operators). 38 tests against an in-memory fake, plus a compile-time
  assertion that the real `mongodb` driver satisfies the injected-client
  contract — no network in CI.
- [ ] **`@orbit/sqlite`** *(optional)* — quick local/embedded adapter.
- [ ] **Optional `schema` on `DataAdapter`** — mentioned for type-generation plugins; the spec does not define it yet (open decision). Not implemented.
- [x] **Verb conventions decided** — `do: 'entity.create' | 'entity.update' |
  'entity.delete'` (plus custom aliases via the adapter's `mutations` map) are
  adapter-level conventions riding the frozen `mutate(action, …)` path — no
  contract change. `subscribeToEntity` stays rejected (spec §9).

---

## 5. Caching (SPEC §8) — Core ✅, advanced spec 🟡

| Item | Status | Where |
| :--- | :--- | :--- |
| `cache` envelope + `x-orbit-cache` header | ✅ | `src/plugins/cache.ts` `parseCacheSpec`/`readSpec` |
| TTL / stale-while-revalidate / background refresh | ✅ | `src/plugins/cache.ts` |
| `invalidates` echoed on mutations | ✅ | `MutationResult` + engine |
| Prefix invalidation (`invalidatePrefix`) | ✅ | cache plugin |
| Swappable `CacheStore` (→ Redis/Memcached/KV) | ✅ | `CacheStore` contract |

**⬜ Not yet:**
- [ ] **Field-level TTL** (`field:price=ttl=60, field:name=ttl=3600`) — `parseCacheSpec` only parses `ttl`/`stale` today; field-scoped cache keys don't exist.
- [x] **Redis-backed store** → **`@orbit/redis`** (implements `CacheStore`).
- [x] **Cloudflare KV store** → **`@orbit/kv-cache`** (implements `CacheStore` for Workers; distinct from the `@orbit/cloudflare-workers` *server wrapper*).
- **`CacheStore` is now sync-or-async** — every method may return a `Promise`
  (the plugin `await`s each call), which is what lets Redis/KV stores exist;
  `createMemoryCacheStore` stays synchronous and is a `CacheStore` subtype.
- [ ] **Memcached store** → **`@orbit/memcached`** *(optional)*.

---

## 6. Errors (SPEC §6) — ✅ Done

| Item | Status | Where |
| :--- | :--- | :--- |
| `OrbitError` + standard codes + HTTP status | ✅ | `src/errors.ts` |
| `onError` translation hook | ✅ | engine `#normalizeError` |
| Client-predictable behavior | ✅ | `docs/errors.md` |

---

## 7. First-party adapters / plugins / packages (SPEC §13) — ⬜ The bulk of what's missing

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
@orbit/postgres             ✅ DataAdapter over an injected pg client (parameterized WHERE, IN batching, create/update/delete)
@orbit/mongo                ✅ DataAdapter over an injected mongodb client (filters→$match, $in batching, create/update/delete, ObjectId via toId/fromId)
@orbit/sqlite               ⬜ (optional)
@orbit/rest                 ✅ fetch-based adapter (queries→GET, mutations→POST/PATCH/DELETE)
@orbit/cache                ✅ distribution home; impl stays in frozen core (see §9 note)
@orbit/redis                ✅ (CacheStore for Redis — cache + optional feature store)
@orbit/kv-cache             ✅ (CacheStore for Cloudflare KV)
@orbit/memcached            ⬜ (optional)
@orbit/auth                 ✅ authn/authz hooks (authenticate/authorize/scope + presets)
@orbit/logging              ✅ request-timing / observability
@orbit/client               ⬜ core frontend client — protocol must be frozen first
@orbit/client-react         ⬜ cache-aware React bindings
```

- [x] **Monorepo set up** — pnpm workspaces, `packages/core` holds `@orbit/core`; docs/spec/examples live at the root. Further packages slot in as `packages/*` per `docs/ecosystem.md`. Turbo/nx can be added when the build graph grows.
- [ ] **Clients** (`@orbit/client`, `@orbit/client-react`) — **defer until the envelope/hook contract is frozen.**

---

## 8. Performance & quality (SPEC §12) — ✅ Measured against real GraphQL

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
   adapter, shipped with 16 tests against the real `DataAdapter` contract) and
   `@orbit/cache` (distribution home of the cache plugin — re-exports from the
   frozen core to keep the dependency direction one-way; Redis/KV stores
   implement the re-exported `CacheStore` contract). (`@orbit/core` keeps only
   the memory adapter as reference.) **Server wrappers shipped too:**
   `@orbit/hono` + `@orbit/express` — thin raw bridges that pass the
   framework's original request to the engine and pipe the response through
   untouched (full protocol fidelity, see `docs/server.md`), with 14
   (express) + 13 (hono) real end-to-end tests and a layered book-API example (`examples/node/frameworks/10-express.ts`, `examples/node/frameworks/11-hono.ts`). **`@orbit/cloudflare-workers`** ships the same book API behind a plain `fetch` handler with Workers bindings on the OrbitContext and Workers-native WebSocket realtime (`examples/node/frameworks/12-cloudflare-workers.ts`).
4. **Ship `@orbit/auth`** (easy — hooks already exist).
5. ✅ **Ship `@orbit/redis`** (Redis `CacheStore`) + ✅ **`@orbit/kv-cache`**
   (Cloudflare KV) — done: the `CacheStore` contract was widened to
   sync-or-async to make real network stores possible.
6. ✅ **Ship `@orbit/postgres`** (parameterized `WHERE`, `IN`-clause
   batching, `create`/`update`/`delete` — 30 tests) **+ ✅ `@orbit/mongo`**
   (match documents, `$in` batching, `create`/`update`/`delete`, ObjectId
   via `toId`/`fromId` — 38 tests; the real driver satisfies the injected
   client contract, pinned by a compile-time assertion).
   **`@orbit/sqlite`** stays ⬜ (optional).
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
| Cache HTTP headers (`x-orbit-cache`, age-aware `cache-control`) | ✅ (spec §7/§8 — hit/miss + CDN/SWR hints; errors always `no-store`) |
| Plugin service injection (`provides` → `ctx.providers`) | ✅ (🧪 spec §11 additive — 8 tests) |
| In-memory adapter | ✅ (keep in `@orbit/core`) |
| REST/fetch adapter | ✅ (`@orbit/rest` — queries→GET, mutations→POST/PATCH/DELETE) |
| Benchmarks | ✅ (B1–B9 goals met) |
| Auth plugin | ✅ (`@orbit/auth`) |
| Logging plugin | ✅ (`@orbit/logging`) |
| Rate limiting plugin | ✅ (`@orbit/rate-limit` — atomic bucket store: in-memory default, Redis shared; limiter on `ctx.providers.rateLimiter`) |
| Redis cache store | ✅ (`@orbit/redis` — incl. distributed rate-limit bucket store) |
| Cloudflare KV cache store | ✅ (`@orbit/kv-cache`) |
| Postgres adapter | ✅ (`@orbit/postgres` — parameterized WHERE, IN batching, create/update/delete) |
| Mongo adapter | ✅ (`@orbit/mongo` — filters→match documents, `$in` batching, create/update/delete, ObjectId via `toId`/`fromId`, operator-injection-safe) |
| Server wrappers | ✅ (`@orbit/hono`, `@orbit/express`, `@orbit/cloudflare-workers` — thin raw bridges / fetch handler + realtime on every host) |
| Clients | ⬜ (`@orbit/client`, `@orbit/client-react`, defer) |

---

## 10. Core evolution plan — what's missing (security first)

> The live "next" queue for the protocol core, prioritized. Legend: ✅ done ·
> 🟡 designed/partial · ⬜ not started · 🔴 known to be weak. Gates are the
> SPEC §13 milestones: **0.1.x** (real adapters), **1.0** (full freeze —
> nothing here may remain open), **2.0 🔮** (federation, WASM parser, SDKs).

### P0 — Security (must all land before 1.0)

| # | Item | Status | Why it matters |
| :- | :--- | :--- | :--- |
| 1 | **Auth context into WebSocket subscriptions & socket envelopes** (SPEC §10 🔜) | ✅ | `authorize` may now return an `OrbitContext` that seeds the session: it rides into every `{ query }`/`{ do }` envelope executed over the socket (so `ctx.state.caller` reaches `mutate`) and into the subscription gates (`authorizedSubscribe` runs the full pipeline with it — a denied subscribe is rejected with the plugin's error and the client's correlation `id`). Node + Cloudflare Workers transports. 3 new tests in `realtime-request.test.ts`. |
| 2 | **Fuzz the parser, msgpack codec & envelope** | ✅ | Deterministic suite in `test/fuzz.test.ts` (fixed seeds, CI-stable): 2000 OQS strings, 2000 msgpack byte payloads, 1500 envelopes, 1000 cache specs, 1000 Accept headers, 500 engine envelopes + 300 wire-msgpack envelopes — invariants: only protocol errors, no hang, no stack overflow. **Fuzz-caught & fixed:** unguarded DataView reads in the msgpack codec (truncated floats → `RangeError`) and a nesting-bomb path (100k fixarrays → stack overflow) — both now fast-fail with the codec's own error. |
| 3 | **Per-request timeout / cancellation** | ✅ | `requestTimeoutMs` on `createOrbit` (opt-in, unref'd) + caller `AbortSignal` on `OrbitContext.signal`. A hung adapter now rejects with a sanitized timeout error instead of hanging the handler; adapters/plugins see the aborted signal to cancel their own work. 7 new tests in `engine.test.ts`. |
| 4 | **Rate limiting plugin (`@orbit/rate-limit`)** | ✅ | First-party zero-dep token-bucket plugin, one line to mount. Gates in `onBeforeParse` (covers queries AND mutations — see §11 additive rule); buckets per IP (`x-forwarded-for`/`x-real-ip`) or any `keyOf`; 429 via `ORBIT_PERMISSION_DENIED` + status override with `details.retryAfterMs`; injectable clock. **Pluggable ATOMIC bucket store** (`RateLimitBucketStore.consume` — refill+check+decrement in one step): in-memory default, `@orbit/redis` `createRedisRateLimitStore` (Lua `EVAL`) for limits shared across instances; the limiter rides `ctx.providers.rateLimiter` (🧪 provides channel) so adapters consume the same shared buckets. 15 tests. |
| 5 | **Multipart field-count cap** | ✅ | `maxMultipartFields` (default 64) rejects a thousands-of-fields DoS with `ORBIT_INVALID_QUERY` + `details.maxFields`. 2 new tests in `upload.test.ts`. |
| 6 | **Error-message sanitization** | ✅ | `ORBIT_INTERNAL` no longer echoes plain `Error` messages (tokens/credentials stay server-side); plain mutation rejections are sanitized `ORBIT_MUTATION_FAILED`. **`details` audit done:** every internal path emits only structural payloads (entities, byte counts, field names) — never raw messages. |
| 7 | **Cache-store hardening** | ✅ | Corrupted entries (non-finite `createdAt`) fail-safe to a miss instead of being served as perpetually fresh; `invalidatePrefix` skips non-string keys from a buggy store; a store that throws on `set` fails the request closed (sanitized). Capacity-eviction and poisoning tests in `cache.test.ts`. Production stores (`@orbit/redis`/`@orbit/kv-cache`) remain P1 #1. |

### P1 — Functionality (the productive gaps)

| # | Item | Status | Notes |
| :- | :--- | :--- | :--- |
| 1 | **`@orbit/redis` + `@orbit/kv-cache`** (SPEC §8 "Redis is planned") | ✅ | Shipped: the `CacheStore` contract was widened to sync-or-async, then `createRedisCacheStore` (injected node-redis client, 14 tests incl. the distributed rate-limit store) and `createKvCacheStore` (injected KV binding, 8 tests) landed. Unblocks multi-instance deploys + the B6/B9 story at scale. |
| 2 | **`@orbit/auth`** | ✅ | Shipped: `createAuthPlugin({ authenticate, authorize?, scope? })` + `bearerAuth`/`apiKeyAuth` presets and `requireCaller`/`requireRole` helpers. Identity stamped in `onBeforeParse` reaches queries AND mutations; `authorize` also gates the mutation `return` re-query. 12 tests. |
| 3 | **`@orbit/postgres` + `@orbit/mongo`** (0.1.x) | ✅ | Postgres: parameterized `WHERE`, `IN`-clause batching, `create`/`update`/`delete` (`RETURNING`), `parentKey` scoping, validated `limit`, quoted identifiers — no SQL injection (30 tests). Mongo: `filters` → match documents (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`regex`), `$in` batching, `create`/`update`/`delete`, `parentKey` scoping, validated `limit`, `toId`/`fromId` id conversion (ObjectId), and a no-operator-injection guarantee — field names charset-validated, payload values walked recursively (38 tests + a compile-time real-driver contract assertion). |
| 4 | **`@orbit/client`** (after 1.0 freeze) | ⬜ | First-party SDK: typed envelope helpers, WS client with reconnect/resume (the demos' `shared.js` `orbitSocket` is the prototype), client-side cache honoring `invalidates`. Today every consumer re-implements the socket. |
| 5 | **Batch mutations (`ops`)** | ⬜ decision | One mutation per envelope today. An additive optional `ops: []` field would fit the SPEC §3 "additive only" rule — decide before 1.0 whether to ship. |
| 6 | **GET query endpoint** | ⬜ decision | Envelope via query-string/headers for CDN-cacheable reads; currently the handler expects a body (POST). Optional, spec-additive. |
| 7 | **Pagination convention** | ✅ | Documented in `docs/adapters.md` — reserved `limit`/`cursor` filter keys, page shape, and validate-the-limit guidance. No syntax change (filters are verbatim by design). |
| 8 | **`@orbit/logging`** | ✅ | Shipped: `createLoggingPlugin({ logger?, now?, maxLabelLength? })` — times queries from `onBeforeParse`→`onBeforeSerialize` and logs every error (queries + mutations). Cache hits / successful mutations are documented non-timed paths. 5 tests. |
| 9 | **`@orbit/fastify` wrapper** *(optional)* | ⬜ | Express/Hono/CF ship; Fastify is the remaining major host. |

### P2 — Quality & architecture (the road to 1.0)

| # | Item | Status | Notes |
| :- | :--- | :--- | :--- |
| 1 | **1.0 contract audit** (SPEC §13) | ⬜ | Re-verify every ✅ section against the source before freezing v1; `docs/protocol-audit.md` already documents the method and the open items. |
| 2 | **Property-based msgpack/negotiate tests** | ⬜ | Round-trip properties for the codec; tie-break/q-value properties for negotiation (some already pinned). |
| 3 | **Brotli support** *(optional)* | ⬜ | gzip is shipped; `Accept-Encoding: br` via `CompressionStream('br')` where the runtime provides it. |
| 4 | **Deno/Bun runnable examples** | ⬜ | The handler already runs anywhere; `docs/server.md` covers them but no runnable examples exist. |
| 5 | **B3 wire-path gap** | 🟡 | Engine core already beats the goal (~100k RPS); the full fetch path is undici-bound (~13k, documented). Optional: keep-alive pool tuning — not a protocol change. |

### Milestones (SPEC §13)

- **0.1.x** — P1 #1 (Redis/KV cache stores) + #3 (Postgres/Mongo adapters) — ✅ complete.
- **1.0** — P0 closed (all 7 shipped in v0.0.1+), P2 #1 audit green, envelope/error
  codes locked for backwards compatibility; `@orbit/client` work may start.
- **2.0 🔮** — federated Orbit servers, native (WASM/C++) parser to close the B3
  wire-path gap, first-party client SDKs.
