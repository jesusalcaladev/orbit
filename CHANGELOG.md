# Changelog

All notable changes to `@orbit/core` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Client-side query cache (`@orbit/client` `QueryCache`)** — the client
  half of spec §8: entries keyed by query string, TTLs from the same spec
  grammar the server speaks (`ttl=300` via the core's `parseCacheSpec`),
  entity-precise indexing of every entity in the query tree (root AND
  relations), and eviction from the mutation's `invalidates` echo — entity
  names or exact keys. `OrbitClient` accepts a `cache:` option; queries with
  a cache spec are served fresh from it without a network round-trip and
  marked `fromCache`, mutations always hit the network and evict through
  their echo. Client coverage stays at **100%** on all four metrics.
- **Duplicate rejection in OQS (spec §4)** — a repeated filter key
  (`user(id="1", id="2")`), repeated field (`user { name, name }`) or
  repeated relation (`user { posts { a }, posts { b } }`) now raises
  `ORBIT_INVALID_QUERY` naming the offender; previously duplicates silently
  kept the last value or dropped the first subtree.
- **Timeout bounds the whole exchange in `@orbit/client`** — `timeoutMs`
  used to be released as soon as the response HEADERS arrived, so a server
  that stalled/trickled the body hung past the timeout (envelope, upload and
  decompression paths; the SSE stream path already handled this).
- **Full-stack example (`examples/node/stack/13-fullstack-mongo.ts`)** —
  one Orbit engine with the whole first-party ecosystem mounted and proven
  live: `@orbit/mongo` adapters (relations + `$in` batching, mutations),
  the Redis `CacheStore` with entity-precise eviction, Redis-backed
  distributed rate-limit buckets with standard `RateLimit-*` headers,
  `@orbit/auth` read gates + row scoping, and per-request `@orbit/logging`
  — 20 live assertions, runnable with zero infra (in-memory Mongo/Redis
  stand-ins) or against real drivers via `MONGODB_URI`. Registered as
  example 13 in `run-all.ts`; docs updated (`examples/README.md`,
  `docs/examples.md`). Root devDependencies: `mongodb` + the five
  `@orbit/*` workspace packages.
- **Coverage ≥90% everywhere (all packages)** — every package now ships a
  `vitest.config.ts` with v8 coverage thresholds (≥90% stmts/funcs/lines,
  ≥85% branch — most at or over 90% branch) and a `test:coverage` script;
  `pnpm -r run test:coverage` enforces them. Added ~40 tests across
  redis/kv-cache/logging/rate-limit/auth/rest/express/cloudflare-workers/
  mongo (incl. fixing two vacuous corrupted-entry tests in the Redis/KV
  stores whose keys never matched the store prefix, so `parseEntry`'s
  fail-safe path is now actually exercised). **@orbit/core reaches 100%
  coverage on all four metrics** (462 tests, up from 400) with a real
  retention-timer fix (re-attach now cancels the pending release) and
  ping-first heartbeats; **@orbit/cloudflare-workers at 100%** (40 tests)
  and **@orbit/rate-limit at 100%** (22 tests). Suite: **703 tests**
  (core 462 + redis 17 + kv-cache 9 + logging 9 + rate-limit 22 + auth 15 +
  rest 24 + express 18 + hono 13 + cloudflare-workers 40 + mongo 40 +
  postgres 30 + cache 4). Also: `OrbitContext.waitUntil` type fix in
  `@orbit/cloudflare-workers` and `realtime: true` typed on the CFW
  transport options.
- **Standard rate-limit response headers (`@orbit/rate-limit`)** — every
  gated response now carries `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset` (draft-ietf-httpapi-ratelimit-headers, as
  `express-rate-limit` / `@nestjs/throttler` do), and the 429 carries
  `Retry-After` — emitted via the §7 `responseHeaders` channel, never
  clobbering headers another plugin set. The `ConsumeResult` contract gained
  optional `remaining`/`resetAfterMs` (both first-party stores report them;
  the Redis Lua script returns `{allowed, retryAfterMs, resetAfterMs,
  remaining}`). Tests: rate-limit 15 → 18.
- **Distributed rate limiting (`@orbit/rate-limit` + `@orbit/redis`)** —
  `createRateLimitPlugin` now accepts a **pluggable atomic bucket store**
  (`RateLimitBucketStore`): the single `consume(key, params, now)` method
  refills, checks and decrements in ONE step inside the store, so N
  instances sharing a store can never double-spend a token (a
  read-modify-write store would be racy by design). `createMemoryRateLimitStore`
  is the synchronous reference (and the default — behavior unchanged);
  `@orbit/redis` ships **`createRedisRateLimitStore`** — one Lua `EVAL` per
  consume, prefixed hash buckets (`orbit:rate-limit:`), server-side TTL
  (default `2 × windowMs`, `ttlSeconds` override) and `reset()` via
  SCAN+DEL — so limits are shared across every instance pointing at the
  same Redis. The plugin also exposes the limiter on
  **`ctx.providers.rateLimiter`** (🧪 provides channel, `provideAs` to
  rename/disable) so adapters and plugins consume the SAME shared buckets
  imperatively. Failures fail closed (a store outage rejects, sanitized).
  Tests: rate-limit 8 → 15, redis 9 → 14 (incl. a two-instance sharing
  contract against an in-memory fake — no network in CI).
- **Plugin service injection into `ctx` (`provides` → `ctx.providers`)** 🧪
  (spec §11, additive) — an `OrbitPlugin` may declare boot-time services
  (`provides: { cacheStore, config, … }`) and the engine collects them at
  `createOrbit` (registration order; **duplicate names and reserved
  prototype names throw at boot**, both plugins named) into a frozen,
  read-only container injected onto **every** execution's `ctx.providers`
  **before any hook runs** — so every hook AND every adapter sees the
  services regardless of registration order. Reaches queries, mutations
  (`onBeforeParse` + `mutate`), `stream()`, mutation `return` re-queries and
  the realtime subscription gates (`authorizedSubscribe`). Per-request
  values stay in `ctx.state`; `providers` is boot-time singletons. 8 tests
  in `test/providers.test.ts`. Spec §11, `docs/plugins.md`, ROADMAP §1.
- **Age-aware cache HTTP headers** (spec §7/§8, additive) — when a cache
  spec is applied, the cache plugin now emits `x-orbit-cache: hit|miss` and
  `cache-control` via the `responseHeaders` channel: `public, max-age=<remaining
  freshness>` on a fresh serve and `public, max-age=0,
  stale-while-revalidate=<remaining window>` when serving stale, so a
  CDN/proxy caches Orbit's answers for exactly as long as Orbit itself
  would. Neither header is emitted without a spec, and the error contract's
  `cache-control: no-store` is now enforced AFTER pipeline headers are
  merged — a cache miss marker stamped before a resolution failure can never
  make an error cacheable. 6 tests in `test/cache.test.ts`.
- **`@orbit/redis` — batched `clear()`** — the Redis store now deletes in
  multi-key `DEL` chunks (100 keys) instead of one round-trip per key; test
  pins the exact batch shape. 9 tests.
- **`@orbit/auth`** — first-party authentication & authorization plugin
  (`createAuthPlugin`) with `authenticate`/`authorize`/`scope` and
  `bearerAuth`/`apiKeyAuth` presets plus `requireCaller`/`requireRole`
  helpers. Identity is stamped in `onBeforeParse` (reaching queries AND
  mutations and a mutation's `return` re-query); a caller already seeded on
  `ctx.state.caller` (a realtime `authorize` session) short-circuits
  re-authentication; `authorize` gates the `return` re-query too (no
  authorization bypass). `apiKeyAuth` lookups use `Object.hasOwn`, so a
  `__proto__`/`constructor` header can never pass authentication. 12 tests.
- **`@orbit/logging`** — first-party request-timing plugin
  (`createLoggingPlugin`): one structured `LogEntry` per resolved query
  (`onBeforeParse` → `onBeforeSerialize`) and per error (queries + mutations
  via `onError`, with the standard code/status/message). Documented
  non-timed paths: cache-hit short-circuits and successful mutations (no
  serialize hook in the mutation pipeline). 5 tests.
- **`@orbit/redis`** — production Redis `CacheStore`
  (`createRedisCacheStore({ client, prefix?, ttlSeconds? })`) over an
  injected node-redis client: entries stored as JSON, optional server-side
  `EX` TTL, prefix invalidation + `clear()` via `SCAN` (never `FLUSHDB`),
  corrupted values are misses while transport errors fail closed. 8 tests
  against an in-memory fake — no network in CI. README + `docs/ecosystem.md`.
- **`@orbit/kv-cache`** — production Cloudflare Workers KV `CacheStore`
  (`createKvCacheStore({ namespace, prefix?, expirationTtl? })`) over an
  injected KV binding: entries stored as JSON, optional `expirationTtl`,
  prefix invalidation + `clear()` paging through `list()`. 8 tests against an
  in-memory fake. README + `docs/ecosystem.md`.
- **`@orbit/postgres`** — production PostgreSQL `DataAdapter`
  (`createPostgresAdapter({ entity, client, table?, idColumn?, columns?,
  filters?, parentKey?, maxLimit?, mutations? })`) over an injected `pg`
  client: verbatim string filters become **parameterized** `WHERE` clauses
  (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`like` operator overrides), sibling
  requests batch into one `IN (...)` query (the N+1 fix), `limit` is
  validated, relations scope via `parentKey`, and mutations map to
  `INSERT`/`UPDATE`/`DELETE … RETURNING` (`create`/`update`/`delete` + custom
  aliases). Values travel only as bind parameters and identifier positions
  are validated + quoted, so neither a filter value nor a filter key can
  inject SQL. 30 tests against an in-memory fake — no database in CI.
  README + `docs/adapters.md` + `docs/ecosystem.md` + ROADMAP §4/§7/§9/§10.

- **`@orbit/mongo`** — production MongoDB `DataAdapter`
  (`createMongoAdapter({ entity, client, collection?, idField?, columns?,
  filters?, parentKey?, maxLimit?, mutations?, toId?, fromId? })`) over an
  injected `mongodb` client (the driver's `Db` satisfies the contract as-is,
  pinned by a compile-time assertion): verbatim string filters become match
  documents (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`regex` operator overrides),
  sibling requests batch into one `$in` query (the N+1 fix), `limit` is
  validated, relations scope via `parentKey`, mutations map to
  `insertOne`/`updateOne`/`deleteOne` (`create`/`update`/`delete` + custom
  aliases), and `toId`/`fromId` convert client ids at every boundary
  (ObjectId support; default identity, so 24-hex `_id` strings work through
  the driver's native coercion). **No operator injection**: field names are
  charset-validated (a filter/payload key can never start with `$` or
  contain `.`) and payload values are walked recursively, so a `$`-keyed
  object value fails with `ORBIT_MUTATION_FAILED` instead of becoming a
  query operator — Mongo's counterpart of the postgres parameterization
  guarantee. Read results alias the primary key under `id` and re-key
  mapped columns. 38 tests against an in-memory fake — no database in CI.
  README + `docs/ecosystem.md` + ROADMAP §4/§7/§9/§10 (0.1.x milestone
  complete).

### Changed
- **`CacheStore` widened to sync-or-async** — every method may now return a
  `Promise` (`get`/`set`/`delete`/`clear`) and `keys()` may be a sync or
  async iterable, which is what lets Redis/KV stores exist. The cache plugin
  `await`s each call and its imperative methods (`invalidate`,
  `invalidatePrefix`, `invalidateEntity`, `clear`) now return `Promise<void>`;
  the engine awaits entity eviction after a mutation so the post-mutation
  `return` re-query is fresh even against an async store.
  `createMemoryCacheStore` stays synchronous and is a `CacheStore` subtype —
  existing sync stores still satisfy the contract unchanged. `docs/plugins.md`,
  `docs/ecosystem.md` and the cache READMEs updated.

### Docs
- **Pagination convention** (`docs/adapters.md`) — reserved `limit`/`cursor`
  filter keys, a page shape example, and validate-the-limit guidance. No
  syntax change (filters are verbatim by design — spec §4).
- `docs/ecosystem.md` + ROADMAP §1/§7/§10 mark `@orbit/auth` and
  `@orbit/logging` shipped; README ecosystem list + test count (483)
  refreshed.

### Added
- **Response headers channel** — plugins and adapters can now set
  `ctx.responseHeaders` (a `Record<string, string | string[]>`) anywhere in
  the pipeline and the handler merges it into every response format (JSON,
  MessagePack, plugin bodies) **and** error responses. Array values append
  one header line per item, so `set-cookie` survives as separate lines.
  This is the protocol's channel for session cookies (a login mutation can
  flick its own cookie from inside `mutate`), CORS and custom
  `cache-control`. `execute()` copies the pipeline's value back onto the
  context it received. Documented in `docs/server.md`, `docs/plugins.md`,
  spec §7.
- **Negotiation metadata on every response** — `vary: accept,
  accept-encoding` (CDN/proxy caches key on both dimensions and can never
  serve the wrong format), `cache-control: no-store` on error responses
  (SSE already had `no-cache`).
- **Shared realtime session driver** — `createSessionDriver` (exported by
  `@orbit/core`) is the single implementation of the frame-level protocol
  (subscribe/ack, unsubscribe, resume, envelope request/response). The Node
  transport and the Cloudflare Workers transport both drive it, so the
  frozen frame contract cannot drift between runtimes. Direct unit tests in
  `test/realtime-driver.test.ts`.
- **Express `set-cookie` fidelity** — the wrapper copies multi-value
  `set-cookie` headers one line per cookie via `getSetCookie()` instead of
  the `, `-joined `Headers` iteration (which corrupts cookie attributes).
- **`@orbit/cloudflare-workers`** — run the full protocol on the edge from a
  single `fetch` handler. `createWorker({ orbit, path, realtime, ctx,
  onError, fallback })` returns the exact `{ fetch(request, env, ctx) }`
  shape workerd expects; `handleOrbit` serves one request inside an existing
  worker. The Workers bindings ride the OrbitContext as `ctx.env` (plus
  `ctx.waitUntil` when the execution context provides one), so adapters can
  use `ctx.env.DB` and schedule background work. Realtime uses the
  Workers-native `WebSocketPair` upgrade over the core's runtime-agnostic
  `SubscriptionHub` — same frame contract as the Node transport
  (subscribe/ack, seq events, in-connection resume, `{ query }`/`{ do }`
  envelopes), with two honest edge differences: no cross-connection resume
  (Durable Objects = future work) and no app-level heartbeats (the platform
  keeps connections alive). 26 tests in `packages/cloudflare-workers/test/`
  exercise the full protocol through `worker.fetch` (JSON/msgpack/SSE/gzip/
  uploads/errors/cache) and the realtime session over a fake socket.
  Example `examples/node/12-cloudflare-workers.ts` serves the same book API
  as Express/Hono. Documented in `docs/server.md`, `docs/ecosystem.md`.
- **Interactive web demos** (`npm run web`, `examples/web/`) — one server
  mounts the real engine AND a real graphql-js competition on a shared world,
  then serves five vanilla HTML/CSS/JS demos from an index page
  (http://localhost:4321):
  - `01-chat` — realtime chat over the zero-dependency WebSocket with
    per-message round-trip latency;
  - `02-file-image` — native multipart uploads (envelope + files in
    `ctx.files`) with drag & drop and a gallery;
  - `03-mini-post` — a feed with nested relations
    (`posts { author { name } }`) and like/unlike mutations;
  - `04-mini-auth` — register/login with scrypt-hashed passwords, the
    `x-orbit-token` header stamped into `ctx.state.caller` by a plugin, and
    a protected query denied with `ORBIT_PERMISSION_DENIED`;
  - `05-orbit-vs-graphql` — the A/B lab: the same chat over both protocols
    on one server, simultaneous sends and batched rounds, end-to-end
    round-trip latencies (send → mutation → shared bus → subscription →
    tab), p50/p95/p99/max, payload bytes and a comparative chart.
  The GraphQL side runs `graphql-js` + `ws` + `graphql-ws` as devDependencies
  of the example harness only — `@orbit/core` stays zero-dependency.
  Documented in `docs/examples.md`.

### Added
- **Native file uploads** — the handler now accepts `multipart/form-data`
  requests: the `envelope` field carries the JSON envelope, every other
  field whose value is a `File` lands in `ctx.files` (keyed by field name)
  for adapters and plugins — `{ do: 'user.uploadAvatar', args: {...} }`
  receives the avatar as a real `File` in `mutate`. The whole body counts
  against `maxPayloadBytes` (413), a missing envelope is a 400, and the
  JSON/MessagePack paths are untouched. 12 tests in `test/upload.test.ts`;
  documented in `docs/server.md` and spec §7.
- **Core weight measurement** — `bench/size.ts` (`npm run size`):
  `@orbit/core` ships **103.5 KB raw / 26.4 KB gzipped** vs graphql-js
  **1 383 KB / 137.4 KB** — **13.4× smaller raw, 5.2× smaller gzipped**,
  zero runtime dependencies. Documented in `docs/benchmarks.md`.
- **`@orbit/rest`** — first ecosystem package (the old `fetchAdapter` is
  back, as it should be: an adapter, not core logic). A fetch-based
  `DataAdapter`: queries become `GET` calls (filters as query params,
  `/:id` path when an `id` filter is present), relations inject the
  parent id via `parentKey`, mutations map to `POST`/`PATCH`/`DELETE`
  (customizable per action), upstream 404 → `null`, other failures →
  precise `OrbitError`s. 14 tests in `packages/rest/test/`.
- **`@orbit/cache`** — the cache plugin's dedicated distribution package.
  The implementation deliberately STAYS inside the frozen `@orbit/core`
  (its export surface is pinned by `api-surface.test.ts`; moving the code
  would invert the dependency direction into a `core → cache → core`
  cycle). The package depends on the core one-way, re-exports the plugin
  and the `CacheStore` contract, and is the home of the Redis/KV/Memcached
  stores next. The code-level split is a deliberate breaking change
  reserved for a future major. 4 tests in `packages/cache/test/`.
- **Monorepo build wiring** — `pnpm build` / `pnpm test` / `pnpm typecheck`
  now fan out to every workspace (`pnpm -r`); each package is
  self-sufficient (own `vitest.config.ts`, dev deps). Total suite:
  **324 tests** (307 core + 13 rest + 4 cache).

### Docs
- **Package READMEs completed** — new `packages/cache/README.md` and
  `packages/rest/README.md` (the two shipped ecosystem packages that lacked
  one): quick start, options tables, behavior notes, the `CacheStore`
  contract for implementers. Every shipped `@orbit/*` package now carries a
  README.
- **Stale counts corrected** — `docs/ecosystem.md` + `ROADMAP.md` now
  report the real rest test count (14, not 13) and the real express/hono
  end-to-end totals (14 + 13); the CHANGELOG's rest (14) and
  cloudflare-workers (26) test counts now match the suite.
- **`@orbit/rest` typing tightened** — `RestMutationSpec.method` is now a
  closed `RestMethod` union (`GET | POST | PUT | PATCH | DELETE`) instead of
  a bare `string`, so a typo in a mutation map fails at compile time.
- **New `docs/ecosystem.md`** — the blueprint for the first-party
  `@orbit/*` package ecosystem: every planned package (adapters, caches,
  plugins, server wrappers, clients), the frozen contract each one
  implements (`CacheStore`, `DataAdapter`, `OrbitPlugin`, the handler),
  the monorepo scaffolding conventions, and the build order. Linked from
  `docs/plugins.md`, the README docs table and ROADMAP §7.
- **Docs fine-tuning** — `docs/architecture.md` pipeline diagram updated to
  the real engine internals (`#consumeQuery` / `#resolveLevels` instead of
  the removed `resolveGraph`); `docs/benchmarks.md` reproduce note fixed
  (seven → nine scenarios); README test count corrected (295).
- **Removed `docs/plan-realtime-b3.md`** — the historical planning doc for
  the realtime transport; superseded by `docs/realtime.md`, spec §10 and
  the shipped implementation (zero references remained).

### Security
- **Prototype-pollution hardening** — attacker-controlled keys (`__proto__`,
  `constructor`) in OQS filters/relations, projected fields and decoded
  MessagePack maps are now stored as OWN properties via `setOwn`
  (`Object.defineProperty`), never written through the `__proto__` setter.
  A query like `user(__proto__="x")` previously rewrote an object's
  prototype chain; now it is a verbatim filter. Tests in `test/parser.test.ts`,
  `test/msgpack.test.ts` and `test/engine.test.ts`.
- **64-bit cache keys** — `fnv1a64` (two independent 32-bit FNV passes, still
  dependency-free) replaces the single 32-bit hash for cache keys: the
  collision bound goes from ~65k entries (feasible intentional
  cache-poisoning) to ~4e9. `fnv1a` stays exported for API compatibility.
- **New `docs/security.md`** — the threat model: what the core defends
  (payload/depth limits, ReDoS-free parser, prototype pollution, cache
  collisions, realtime frame rules) and what is the deployer's job (TLS,
  rate limiting, auth, HTTP-layer hygiene).

### Changed
- **Public API surface frozen (spec §13)** — every export of `src/index.ts`
  (runtime values AND type names) is now pinned exact-set by
  `test/api-surface.test.ts`: renaming, removing or silently adding an export
  fails CI. The contract is now two-tier — protocol shapes pinned by
  `test/contract.test.ts`, the import surface pinned by the new test.

### Security
- **`ORBIT_INTERNAL` is sanitized** — `toOrbitError` no longer echoes a plain
  `Error`'s message to the client: unexpected failures answer the generic
  `"Internal server error"` and the original error (which may embed tokens,
  connection strings or stack internals) stays server-side as `cause`.
  Adapters that want a precise client-facing message must throw an
  `OrbitError` explicitly. The demo server's catch-all was sanitized the
  same way. Tests assert the wire shape never contains the original text.

### Changed
- **Plain mutation rejections are `ORBIT_MUTATION_FAILED` (spec §5)** — an
  adapter `mutate` that throws a plain `Error` is wrapped as a sanitized
  `ORBIT_MUTATION_FAILED` (original preserved as `cause`) instead of leaking
  as an unclassified `ORBIT_INTERNAL`; thrown `OrbitError`s keep their
  precise code and message.
- **Cache plugin ordering is enforced at `createOrbit`** (spec §11) —
  mounting a cache plugin before a plugin with an `onBeforeSerialize` hook
  now throws with the offending plugin named, instead of silently serving
  pre-transform cached values.
- **`@orbit/rest` hardening** — a payload on a `GET`/`DELETE` mutation is
  rejected with `ORBIT_MUTATION_FAILED` (previously dropped silently), and
  upstream `401`/`403` now map to `ORBIT_PERMISSION_DENIED` (status
  preserved) instead of `ORBIT_INTERNAL`.

### Docs
- **Spec truthfulness** — §2 principle 7 badge corrected (`🔜 (transport)` →
  `✅`, realtime shipped in v0.0.1); §7 pins the equal-`q` tie-break
  (MessagePack > SSE > JSON, already covered by `negotiate.test.ts`); §13
  example count corrected (11 → 12 node examples). `docs/plugins.md` notes
  the enforced cache ordering; `packages/rest/README.md` documents the new
  payload/status behavior; README coverage figures refreshed (~90% branch).

### Added
- **B9 · Deep-nest warm replay vs DataLoader** — the same 5-level graph from
  B2 through graphql-js + DataLoader (devDependency of the bench harness
  only): batchers collapse the 1,112 resolver calls to **5 DB batches per
  request** (the same per-level floor as Orbit's contract), but fresh loaders
  per request (the correct production setup) mean every request still pays
  all 5 batches — measured **56 ms P99**. Orbit with the cache plugin replays
  the warm request from memory at **0 DB calls, 0.09 ms P99** (~600×). The
  honest takeaway: DataLoader closes the cold N+1 gap (B2); contract-level
  caching is what makes repeat requests free.
- **Benchmarks are now real head-to-heads against graphql-js** — B1–B4's
  competition figures were previously reference values quoted from the spec
  table ("GraphQL 8 ms / 15k RPS / 450 KB / 1111 queries"); they are now
  MEASURED on this machine. `graphql` (v17) is a devDependency of the bench
  harness only (`bench/graphql.ts` resolves the same fixtures through parse +
  validate + execute); `@orbit/core` keeps its zero-runtime-dependency
  contract. Bench fixtures and timing helpers extracted to
  `bench/fixtures.ts` / `bench/measure.ts` (shared by both sides).
- **The honest, measured picture** — every comparison reports BOTH the naive
  GraphQL number (full `graphql()` pipeline per op: parse + validate +
  execute) and the cached-document number (the production-server equivalent of
  Orbit's parse LRU):
  - B1 P99 latency: 0.05–0.09 ms vs naive 1.65–1.75 ms (~24–35×) /
    cached-doc 0.092–0.098 ms (~1.4–1.8× — near-parity once both cache the
    parse).
  - B2 deep-nest round-trips: 5 vs 1,112 resolver calls (measured N+1).
  - B3 throughput: ~98–116k RPS vs naive ~1.4–2.1k / cached-doc ~30–34k
    (~3.2–3.4×).
  - B4 payload: 19 KB (msgpack+gzip) vs 446 KB uncompressed GraphQL JSON —
    gzip equalizes both protocols at 19.1 KB; MessagePack alone trims ~1% on
    text-heavy payloads, so the protocol's edge is round-trips, throughput
    and streaming (B2/B3/B5), not compressed size.
  Spec §12 and `docs/benchmarks.md` updated with the measured methodology.

### Fixed
- **Mutation `return` re-queries now run the full hook pipeline** — `onBeforeParse`, `onAfterParse` and `onBeforeResolve` did not previously run on the post-mutation re-query, so authorization gates (e.g. the `onBeforeResolve` role check in example 03) could be bypassed with `{ do, return }`. The sub-query is now executed exactly like a client query (spec §5: "hooks included"); plugins see the sub-envelope `{ query }`, and no envelope-level `cache` spec applies, so the re-query is fresh unless the client explicitly sends the `x-orbit-cache` header. Regression test in `test/engine.test.ts`.
- **`RealtimeServer.close()` now terminates sessions' sockets** — it sent a close frame and released hub state but never closed the upgraded TCP sockets, so a following `http.Server.close()` waited forever and the process hung (reproduced in examples 08/09). Every close path now `destroy()`s the socket after writing the close frame (Node keeps upgraded sockets half-open after `end()`); examples 08/09 exit cleanly. Regression test in `test/realtime.test.ts`.

### Changed
- **Contract freeze (spec §3/§6/§9/§11)** — the `QueryNode` shape and hook signatures are now pinned in the spec and enforced by `test/contract.test.ts`. Decisions: the node field stays `origin` (no `_origin`); cache specs never live on the node (`_cacheSpec` rejected — caching is request context); mutation `return` nodes are stamped `origin: 'mutate'` again, restoring the documented metadata (`docs/oqs.md`, `docs/architecture.md`).
- **Monorepo (pnpm workspaces)** — the repository is now a multi-package workspace: `packages/core` hosts `@orbit/core` (src, tests, build, vitest config); root examples and benchmarks consume the built package via `@orbit/core`; docs and spec live at the root. `package-lock.json` replaced by `pnpm-lock.yaml`.
- **Example lifecycle** — 08/09 flush and exit explicitly when run standalone (Node's undici `WebSocket` keeps its client-side socket handle alive after a clean close — a platform behavior, not an Orbit leak); `run-all` flushes the summary and exits once every example is done.

### Added
- **B8 · Wire-path benchmark (real HTTP)** — `bench/http-bench.ts`: both
  engines behind an identical `node:http` server, a single keep-alive
  connection reused by `node:http`'s own client, the same query, the same
  machine. Orbit serves **~1.5× the requests** of a bare `graphql()` HTTP
  endpoint (1,661 vs 1,069 RPS). This is the full stack — HTTP parsing, JSON
  body, handler, serialization — not the in-process core numbers of B3.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — a 12-job matrix
  (ubuntu/macos/windows × Node 18/20/22/24) running typecheck, Biome and the
  test suite, plus a `bench` job that runs B1–B9 on ubuntu/Node 22 and
  uploads `bench/results/*` as an artifact with a summary. CI badge in the
  README.
- **B7 · Realtime HTTP benchmark** — real WebSocket connections over `node:http` (raw RFC 6455 client, `bench/ws-client.ts`): 972 subs/s, fan-out to 200 sockets in **8.0 ms** (write path 5.2 ms), resume replay of 500 patches in **3.8 ms** — 25–52× inside the < 200 ms goal. New 7th row in the results table and chart.
- **Security suite for the WebSocket transport** (`test/realtime-security.test.ts` + `test/ws-helper.ts`) — 32 tests speaking raw frames over `net.Socket`: handshake/gates, frame-protocol violations with the right close codes (unmasked, RSV, reserved opcodes, control-frame rules, declared-length DoS → 1009, continuation/fragmentation violations, invalid close payloads/codes, HTTP-after-upgrade), slow-loris resilience, fragmented-message correctness with interleaved control frames, message-level validation (invalid JSON/msgpack, non-objects, bad resume), retention expiry.
- **`examples/09-speed.ts`** — the speed showcase: engine core µs/op + RPS, full fetch handler, deep 5-level graph, payload shaving, realtime fan-out — measured live on the running machine.

### Changed
- **Realtime security fixes** — (1) a fresh data frame during a fragmented message is now a 1002 close (RFC 6455 §5.4; previously silently discarded); (2) close frames with 1-byte payloads or invalid codes (< 1000, 1004/1005/1006/1015) are a 1002; (3) `authorize()` that **throws synchronously or rejects asynchronously** now answers 403 instead of crashing the process or hanging (it is invoked inside the promise chain); (4) handshake rejections use `socket.end()` so the status line always reaches the client; (5) `FrameDecoder` validates RSV/masking/control-frame rules from the 2-byte header before buffering payload (fail-fast anti-DoS — an unmasked huge frame is a 1002, not a buffered 1009); (6) `socket.setNoDelay(true)` on upgrade (many small frames); (7) **fragment-count cap** (1000) — the byte cap bounds payload, the count cap bounds the per-fragment Buffer objects, closing a 1-byte-fragment flood with a 1009.
- **Bench harness hardening** — event-driven frame waits (no `sleep(0)` polling), fan-out warm-up, resume measured by counting the frames actually received (with a units bug in the first version caught and fixed).

### Added
- **WebSocket realtime transport** — zero-dependency RFC 6455 (`src/realtime/`): handshake + frame codec (`frames.ts`), a `SubscriptionHub` that dedupes N clients onto one shared adapter `subscribe` hook with per-subscription sequence numbers and a bounded resume log (`hub.ts`), and `createRealtimeServer` (`server.ts`) with subscribe/unsubscribe/resume frames, retention across disconnects, heartbeats, auth/origin gates, and JSON or MessagePack frames. New error code `ORBIT_SUBSCRIPTION_FAILED`. Spec §10 flips 🔜 → ✅.
- **`examples/08-realtime.ts`** — a runnable demo: subscribe → mutations stream events → disconnect → resume replays the missed patches.
- **B6 realtime benchmark** — 100 clients on one shared hook: fan-out and resume replay measured in microseconds (goal < 200 ms).
- **Parse LRU cache** in the engine (gated on zero plugins) — `execute()` dropped from ~14.4 µs to ~9.7 µs/op (~103k RPS core); `negotiateFormat` fast path for non-binary `Accept` headers.
- **B3 benchmark reworked** — measures three honest numbers: engine core (headline, ~103k RPS vs the ~30k goal), server-side handler work (~21k), and the full fetch path (undici client cost included). All six goals ✅.

### Changed
- **Frozen contracts** — canonical [`spec.md`](./spec.md) is now the single source of truth: envelope, error codes, serialization, the `DataAdapter` contract, realtime/subscriptions design, and the v2.0 roadmap. Every section is marked ✅ implemented or 🔜 planned.
- **`DataAdapter` contract finalized**: added `subscribe(filters, handler)` (+ `SubscriptionEvent`) for realtime; `delete` and `subscribeToEntity` were explicitly **rejected** (the `do: 'entity.delete'` mutation path and per-adapter entity scoping already cover them). `memoryAdapter` forwards `subscribe` when defined.
- **Removed `fetchAdapter`** (REST via global `fetch`) — adapters are a 20-line hand-written contract; example 04 now exercises the full frozen contract (`resolve`/`batch`/`mutate`/`subscribe`) against a `Map`.
- **Engine hot path**: bytes-aware envelope reading (`readEnvelopeBytes`) and a non-async `memoryAdapter` resolve shaved `execute()` from ~20µs to ~12.7µs/op.

### Added
- **7 runnable examples** (`examples/01-hello.ts` → `07-serializer-custom.ts` + `run-all.ts`) covering hello-world, relations & batching, auth plugins, adapters by hand, MessagePack, SSE streaming, and custom serializers.
- **Benchmark suite B1–B6** (`bench/run.ts`, `npm run bench`) measuring P99 latency, deep-nest DB round-trips, throughput, payload size, streaming TTFB and reconnect replay against the spec's reference figures — with a generated SVG chart (`bench/results/chart.svg`) and machine-readable JSON.
- **Zero-dependency MessagePack codec** — `encodeMsgpack` / `decodeMsgpack` (full integer/string/bin/array/map coverage, JSON-compatible `undefined` handling).
- **`Accept` negotiation** — `negotiateFormat` (JSON / msgpack / SSE with q-values, wildcard → JSON) and `wantsGzip` (`Accept-Encoding`).
- **SSE streaming** — `orbit.stream()` async generator plus a `text/event-stream` handler path that emits the graph level by level.
- **gzip responses** — via `CompressionStream`, for both JSON and MessagePack payloads.
- **MessagePack request envelopes** — `readMsgpackEnvelope` with the same payload-size enforcement as JSON.
- **New docs**: `docs/serialization.md`, `docs/benchmarks.md` (with chart), `docs/examples.md`.
- Engine fixes from review: negative-integer double-encoding in the msgpack codec, pre-buffer `content-length` check for early 413s, wildcard `Accept` maps to JSON.

### Security — P0 hardening (all seven items closed)
- **Auth context into WebSocket subscriptions & socket envelopes** (spec §10
  🔜 → ✅) — the transport's `authorize` may now return an `OrbitContext`
  that seeds the session: it rides into every `{ query }`/`{ do }` envelope
  executed over the socket (so `ctx.state.caller` reaches `mutate` and the
  auth pipeline) and into the subscription gates — `authorizedSubscribe`
  runs the full pipeline (`onBeforeParse` rewrite + identity stamping,
  `onAfterParse`, `onBeforeResolve`) with the session ctx, so a denied
  subscription is rejected with the plugin's error (e.g.
  `ORBIT_PERMISSION_DENIED`) before any adapter hook is registered.
  Subscription-control failures now echo the client's correlation `id` on
  the error frame (Node + Cloudflare Workers transports). Previously an
  authenticated socket could run mutations with **no identity** — the top
  gap in `docs/protocol-audit.md`. 3 tests in `realtime-request.test.ts`.
- **Deterministic fuzz suite** (`test/fuzz.test.ts`, fixed seeds, CI-stable)
  — 2000 OQS strings, 2000 msgpack byte payloads, 1500 envelopes, 1000
  cache specs, 1000 `Accept` headers, 500 engine envelopes + 300
  wire-msgpack envelopes. Invariants: only protocol errors, no hang, no
  crash. **Fuzz-caught and fixed:** unguarded DataView reads in the msgpack
  codec (truncated floats/fixed-width ints threw `RangeError`) and a
  nesting bomb (100k fixarrays → JS stack overflow) — the codec now
  bounds-checks every raw read (`need()`) and caps nesting at 512,
  fast-failing with its own error.
- **Per-request timeout / cancellation** — `requestTimeoutMs` on
  `createOrbit` (opt-in, `unref`'d timer) plus the caller's `AbortSignal`
  on `OrbitContext.signal`: a hanging adapter now rejects with a sanitized
  timeout/abort error instead of hanging the handler forever, and
  adapters/plugins observe the aborted signal to cancel their own work. 7
  tests in `engine.test.ts`.
- **`@orbit/rate-limit`** — first zero-dep token-bucket plugin package: one
  `onBeforeParse` hook gates queries AND mutations (spec §11 additive
  rule); per-IP buckets by default (`x-forwarded-for`/`x-real-ip`), any
  `keyOf` for real identity; exceeded limits are `ORBIT_PERMISSION_DENIED`
  with status **429** and `details.retryAfterMs`; injectable clock, 8
  tests. README + `docs/security.md` + `docs/ecosystem.md` + ROADMAP P0 #4.
- **Multipart field-count cap** — `maxMultipartFields` (default 64) rejects
  the thousands-of-fields DoS with `ORBIT_INVALID_QUERY` +
  `details.maxFields` (the byte cap bounds the body, the count cap bounds
  the parse). 2 tests in `upload.test.ts`.
- **Cache-store hardening** — a corrupted entry (non-finite `createdAt`)
  fails safe to a miss instead of being served as perpetually fresh;
  `invalidatePrefix` skips non-string keys from a buggy store; a store that
  throws on `set` fails the request closed (sanitized). 5 tests in
  `cache.test.ts`.
- **`details` audit** — every internal error path emits only structural
  payloads (entities, byte counts, field names); raw error messages never
  appear in `details`.

## [0.0.1] — 2026-08-11

### Added
- **OQS — Orbit Query Syntax**: entity roots with verbatim filters, field projection, nested relations, depth limits.
- **Hook-based plugin system**: `onBeforeParse`, `onAfterParse`, `onBeforeResolve` (short-circuit), `onBeforeExecute`, `onAfterResolve`, `onBeforeSerialize`, `onError` — with `PluginRegistry` (duplicate-name rejection).
- **BFS resolution with per-entity batching** — sibling requests of an entity collapse into one `batch()` call per level (the N+1 fix).
- **Adapters**: `DataAdapter` contract (`resolve`/`batch`/`mutate`/`subscribe`), `AdapterRegistry`, `memoryAdapter` (with batching, mutations and realtime subscriptions). REST upstreams are a one-off adapter you write in 20 lines.
- **Cache plugin**: TTL / stale-while-revalidate with background revalidation, in-memory store (swappable via `CacheStore`), prefix invalidation.
- **Mutations**: `do: "entity.action"` envelopes with `filter`/`payload`, optional `return` sub-graph, `invalidates` keys.
- **Errors**: `OrbitError` with 8 standard codes and correct HTTP statuses; `onError` translation hook.
- **Zero runtime dependencies** — TypeScript + Vitest are dev-only; ESM build with `.d.ts`.
- **Test suite**: 199 Vitest tests across parser, errors, plugins, engine, adapters, cache (with simulated clocks), server, serialization, negotiation, streaming, coverage edge cases, and end-to-end integration (~96% statement / ~90.5% branch coverage).
- **Docs**: `README.md` (with the "why this idea exists" origin story), `docs/oqs.md`, `docs/plugins.md`, `docs/adapters.md`, `docs/architecture.md`, `docs/server.md`, `docs/errors.md`, `CONTRIBUTING.md`.
- **Demo server**: `examples/standalone-server.ts` — zero-dependency Orbit endpoint on `node:http`.
