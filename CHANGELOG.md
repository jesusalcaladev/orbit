# Changelog

All notable changes to `@orbit/core` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Mutation `return` re-queries now run the full hook pipeline** — `onBeforeParse`, `onAfterParse` and `onBeforeResolve` did not previously run on the post-mutation re-query, so authorization gates (e.g. the `onBeforeResolve` role check in example 03) could be bypassed with `{ do, return }`. The sub-query is now executed exactly like a client query (spec §5: "hooks included"); plugins see the sub-envelope `{ query }`, and no envelope-level `cache` spec applies, so the re-query is fresh unless the client explicitly sends the `x-orbit-cache` header. Regression test in `test/engine.test.ts`.
- **`RealtimeServer.close()` now terminates sessions' sockets** — it sent a close frame and released hub state but never closed the upgraded TCP sockets, so a following `http.Server.close()` waited forever and the process hung (reproduced in examples 08/09). Every close path now `destroy()`s the socket after writing the close frame (Node keeps upgraded sockets half-open after `end()`); examples 08/09 exit cleanly. Regression test in `test/realtime.test.ts`.

### Changed
- **Contract freeze (spec §3/§6/§9/§11)** — the `QueryNode` shape and hook signatures are now pinned in the spec and enforced by `test/contract.test.ts`. Decisions: the node field stays `origin` (no `_origin`); cache specs never live on the node (`_cacheSpec` rejected — caching is request context); mutation `return` nodes are stamped `origin: 'mutate'` again, restoring the documented metadata (`docs/oqs.md`, `docs/architecture.md`).
- **Monorepo (pnpm workspaces)** — the repository is now a multi-package workspace: `packages/core` hosts `@orbit/core` (src, tests, build, vitest config); root examples and benchmarks consume the built package via `@orbit/core`; docs and spec live at the root. `package-lock.json` replaced by `pnpm-lock.yaml`.
- **Example lifecycle** — 08/09 flush and exit explicitly when run standalone (Node's undici `WebSocket` keeps its client-side socket handle alive after a clean close — a platform behavior, not an Orbit leak); `run-all` flushes the summary and exits once every example is done.

### Added
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
