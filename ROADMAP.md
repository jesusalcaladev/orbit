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
| Framework-agnostic handler `(Request) => Response` | ✅ | `Orbit#handler`, `docs/server.md`, `examples/standalone-server.ts` |
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

**⬜ First-party plugin packages** (the "brains", shipped as `@orbit/<target>`):
- [ ] **`@orbit/auth`** — hooks `onBeforeResolve`/`onBeforeExecute` with role checks. *Only a hand-written example exists today: `examples/03-auth-plugin.ts`.*
- [ ] **`@orbit/cache`** — split the core cache plugin out of `@orbit/core` (it currently lives inline in `src/plugins/cache.ts`).
- [ ] **`@orbit/redis`** — a `RedisCacheStore` implementing the `CacheStore` contract (contract is done and swappable; only the store impl is missing). Supports TTL/SWR and prefix invalidation.
- [ ] **`@orbit/cloudflare-workers`** — Cloudflare Workers KV `CacheStore`, same contract as `@orbit/redis` (see below).
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

## 3. Envelope & transport (SPEC §4, §7) — ✅ Done, minor alignment

| Item | Status | Where |
| :--- | :--- | :--- |
| Envelope validation (exactly one of query/do) | ✅ | `src/envelope.ts` |
| Max payload size + early 413 | ✅ | `src/envelope.ts`, engine |
| JSON (default) | ✅ | engine |
| MessagePack (zero-dep codec) | ✅ | `src/serialize/msgpack.ts` |
| SSE streaming (level-by-level) | ✅ | `Orbit#stream` + `text/event-stream` handler |
| gzip (`CompressionStream`) | ✅ | engine `gzipBytes` |
| `Accept` / `Accept-Encoding` negotiation | ✅ | `src/serialize/negotiate.ts` |

**🟡 Align parsed-node naming with SPEC:**
- SPEC proposes `_cacheSpec` / `_origin` on the parsed node. The codebase uses `origin` on the node and keeps the cache spec in `ctx.state` (not on the node). Decide the canonical shape **before shipping adapters/clients** so the wire/plugin contract is stable.

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
- [ ] **Cloudflare KV store** → **`@orbit/cloudflare-workers`** (implements `CacheStore` for Workers).
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
**separate packages**. Future structure (each as its own published package):

```
@orbit/core                 ✅ (exists — engine, hooks, OQS, envelope, memory adapter)
@orbit/hono                 ⬜ thin server wrapper for the Hono handler
@orbit/express              ⬜ thin server wrapper for Express
@orbit/cloudflare-workers   ⬜ workers handler wrapper (pairs with @orbit/kv-cache)
@orbit/bun / @orbit/deno    ⬜ (if desired — handler already runs anywhere)
@orbit/postgres             ⬜
@orbit/mongo                ⬜
@orbit/sqlite               ⬜ (optional)
@orbit/rest                 ⬜ (new fetch-based adapter — the old `fetchAdapter` was removed from core)
@orbit/cache                🟡 (core cache plugin done; split out)
@orbit/redis                ⬜ (CacheStore for Redis — cache + optional feature store)
@orbit/kv-cache             ⬜ (CacheStore for Cloudflare KV)
@orbit/memcached            ⬜ (optional)
@orbit/auth                 ⬜
@orbit/logging              ⬜
@orbit/client               ⬜ core frontend client — protocol must be frozen first
@orbit/client-react         ⬜ cache-aware React bindings
```

- [ ] Set up a **monorepo** (pnpm/turbo/nx) and split the README's `@orbit/core` into the packages above.
- [ ] **Clients** (`@orbit/client`, `@orbit/client-react`) — **defer until the envelope/hook contract is frozen.**

---

## 8. Performance & quality (SPEC §11) — 🔴 One known gap

| Benchmark | Status |
| :--- | :--- |
| B1 latency (P99) | ✅ Good |
| B2 deep-nest DB round-trips | ✅ Good |
| B3 throughput (engine core vs goal ~30k) | ✅ Core exceeds the goal (~103–125k RPS measured); the full fetch path is undici-bound (~13k), documented in `docs/benchmarks.md` |
| B4 payload size | ✅ Good |
| B5 streaming TTFB | ✅ Good |
| B6 reconnect/warm-cache replay | ✅ Excellent |
| B7 realtime fan-out (200 sockets) | ✅ Excellent — 8.0 ms fan-out, 3.8 ms resume replay |

**TODO:** re-run `npm run bench` on the target machine to refresh the B1–B7 numbers — the engine core already exceeds B3's goal; the remaining wire-path cost is undici-bound and documented in `docs/benchmarks.md`.

---

## 9. Suggested execution order

1. **Freeze the core contract** (hook signatures, `QueryNode` shape, adapter
   interface, envelope) — decide `_cacheSpec`/`_origin` naming and whether
   `delete`/`create`/`subscribe` enter the contract.
2. **Attack benchmark B3** — the one weak spot in an otherwise strong core.
3. **Split packages in a monorepo** — write `@orbit/rest` as a new adapter
   package (`fetchAdapter` was already removed from core; example 04 shows the
   hand-written contract), split the cache plugin into `@orbit/cache`.
   (`@orbit/core` keeps only the memory adapter as reference.)
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
| Plugin system (all 7 hooks + registry) | ✅ |
| OQS + mutations | ✅ |
| Envelope / serialization / SSE / gzip | ✅ |
| Errors | ✅ |
| Caching core (TTL/SWR/invalidate) | ✅ (in core; → `@orbit/cache`) |
| In-memory adapter | ✅ (keep in `@orbit/core`) |
| REST/fetch adapter | ⬜ (`@orbit/rest` new — `fetchAdapter` removed from core) |
| Benchmarks | ✅ (B1–B7 goals met) |
| Auth plugin | ⬜ (`@orbit/auth`) |
| Redis cache store | ⬜ (`@orbit/redis`) |
| Cloudflare KV cache store | ⬜ (`@orbit/kv-cache`) |
| Postgres / Mongo adapters | ⬜ (`@orbit/postgres`, `@orbit/mongo`) |
| Server wrappers | ⬜ (`@orbit/hono`, `@orbit/express`, `@orbit/cloudflare-workers`) |
| Clients | ⬜ (`@orbit/client`, `@orbit/client-react`, defer) |
