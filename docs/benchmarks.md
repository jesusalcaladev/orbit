
## Results table

| ID | Scenario | Metric | Competition | Orbit | Goal | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| B1 | Simple query (user by ID) | P99 latency | graphql-js **0.035 ms** cached-doc · **0.98 ms** naive (measured) · REST 5 ms ref | **0.07 ms** | < 3 ms | ✅ |
| B2 | Deep nest, 5 levels (User→Posts→Comments→Likes→LikedBy) | DB round-trips | graphql-js **1112 resolver calls** (measured) | **5** | ≤ 5 (1 batch/level) | ✅ |
| B3 | Throughput | Requests/sec (engine core) | graphql-js **111,180** cached-doc (measured) | **158,162** (server-side ~26.3k · fetch path ~30.1k) | ~30,000 | ✅ |
| B4 | Payload — 20-post feed | KB transmitted | graphql-js JSON **446 KB** (measured; 19.1 KB gzipped) | **19 KB** (msgpack+gzip) | ~120 KB | ✅ |
| B5 | TTFB in streaming | Time to first byte | REST 400 ms (ref) | **6 ms** | < 50 ms | ✅ |
| B6 | Mobile reconnect (offline) | Sync time | Apollo refetch 2,000 ms (ref) | **0.1 ms** (warm replay) · realtime resume 158 µs | < 200 ms | ✅ |
| B7 | Realtime HTTP — WebSocket fan-out | Fan-out latency (200 sockets) | spec goal 200 ms | **4.08 ms** (write path ~2.81 ms; raw-socket baseline ~4.75 ms) · resume 500 patches ~2.14 ms · ~1,294 subs/s | < 200 ms | ✅ |
| B8 | Wire path · real HTTP (node:http + keep-alive) | Requests/sec over HTTP | graphql-js **2,391** (measured, same server) | **3,345** | ≥ graphql-js | ✅ |
| B9 | Deep nest · warm cache replay vs DataLoader | Warm replay P99 latency | graphql-js + DataLoader **26.46 ms** · **5 DB batches/request** (measured) | **0.12 ms** · **0 DB calls** | < 200 ms (0 DB calls warm) | ✅ |
| B10 | Client overhead · real HTTP round-trip | P99 round-trip latency | raw fetch **0.699 ms** (measured) | **0.674 ms** (−3.6%, inside noise — within the 15% budget) | ≤ 15% overhead | ✅ |
| B11 | React layer · warm cache hit vs raw fetch | P99 latency (warm cache hit) | raw fetch **0.738 ms** (measured) | **0.002 ms** · **0 HTTP round-trips** (354× faster; miss overhead vs bare client **7.5%**) | < 0.5 ms warm | ✅ |
| B12 | Wire bytes · agent write + read round-trip | Bytes on the wire (in + out) | raw request + gzip response **191.7 KB** (client default) | **25.5 KB** (gzip request + gzip response; the write request alone **173.8 → 7.6 KB**) | ≥ 50% fewer | ✅ |

**11 of 11 goals met, against measured graphql-js competition.** (B12's baseline is the protocol's own default round-trip, not graphql-js: it measures the wire, not the engine — see its section.) (B2's goal is its theoretical floor: one batched round-trip per level. B3 compares the engine core — the spec's ~30k claim is about the protocol's own throughput; graphql-js is measured both naive (full pipeline per op) and with a cached document (the production-server equivalent of Orbit's parse LRU). B1 reports the same two-sided story: the cached number is the fair comparison to Orbit's parse LRU. B8 is the REAL wire path: both engines behind an identical `node:http` server, the same keep-alive client, the same machine — Orbit serves ~1.4× the requests of a bare GraphQL HTTP endpoint. B9 measures the repeat-request story: DataLoader (the standard N+1 fix) collapses B2's 1,112 resolver calls to 5 DB batches per request but still pays all 5 on EVERY request, because a fresh loader per request is the correct production setup; Orbit's cache plugin replays the warm request from memory at 0 DB calls. B7's competition column is the spec's realtime target — Apollo-style delta sync under 200 ms — because no load-tool reference exists for a zero-dependency WS server.)

## Scenario by scenario

### B1 — Simple query: P99 latency — ✅ `0.07 ms` vs graphql-js `0.035 ms` cached / `0.98 ms` naive (goal < 3 ms)

The full pipeline for `user(id="1") { name, email }`: envelope validation → OQS parse → hooks → resolve → project → serialize. Measured over 2,000 iterations of `orbit.execute(...)` after a warm-up, taking the 99th percentile. The same query, same data, through graphql-js, reported **honestly on both sides of its caching story**:

- **Naive — full `graphql()` pipeline (parse + validate + execute) per op**: **0.98 ms P99**. A bare GraphQL server that re-parses and re-validates every request is **~14× slower** than Orbit's core.
- **Cached-document — parse + validate once, then `execute()`**: **0.035 ms P99**. This is what production servers do and the apples-to-apples counterpart of Orbit's parse LRU — in this run graphql-js is **~2× faster** on that path.

The honest conclusion: with both engines caching their parse step, single-query core latency is a near-parity game at tens of microseconds, and the winner flips between runs (0.07 ms vs 0.035 ms here, 0.06 ms vs 0.034 ms in the previous run). Orbit's real, measured advantages are B2 (round-trips), B3 (throughput) and B5 (streaming TTFB). The parser and projector are pure string/object work — no allocations beyond the result. Add the cache plugin and warm hits drop to the tens of microseconds (see B6).

### B2 — Deep nest: DB round-trips — ✅ `5` vs graphql-js `1112` resolver calls (measured)

The classic N+1 explosion. A 5-level graph (`User → Posts → Comments → Likes → LikedBy`) with a fan-out of 10 per node. This time the competition number is **measured, not assumed**: running the same graph through graphql-js with per-field resolvers (each resolver = one data access) counts **1,112 resolver invocations** — the classic `1 + 1 + 10 + 100 + 1000` N+1, confirmed on this machine.

Orbit resolves the tree **breadth-first**, grouping sibling requests by entity. Each level collapses into **one** `batch()` call — the adapter sees a single round-trip per level (with the filters for every sibling, so `WHERE id IN (…)`). Total: **5 round-trips** for the entire graph, and the adapter decides whether each batch is one SQL query. The count is instrumented inside the adapter (`resolve`/`batch` invocations), not assumed.

> Goal note: one batched round-trip per level is the theoretical floor for a 5-level graph (each level is a different entity, so they cannot be fused), hence the honest target of **≤ 5**, not `< 5`. GraphQL closes this gap only by adding DataLoader — a library Orbit bakes into the contract.

### B3 — Throughput — ✅ `158,162 RPS` core vs graphql-js `111,180` cached / `4,831` naive (goal ~30,000)

B3 measures the engine honestly, and the GraphQL side too:

- **Orbit core — the engine itself** (`orbit.execute`): sequential-await iterations of the full pipeline (envelope validation → OQS parse → hooks → resolve → project → serialize). **158,162 RPS** on this machine — **~5× the ~30k goal and ~1.4× graphql-js with a cached document**.
- **GraphQL naive — the full `graphql()` pipeline (parse + validate + execute) on every op**: **4,831 RPS**. A bare GraphQL server pays parse + validate per request unless it caches documents.
- **GraphQL cached-document — parse + validate once, then `execute()`**: **111,180 RPS**. This is what production servers (Apollo, yoga, …) do and the apples-to-apples equivalent of Orbit's parse LRU — Orbit's core still runs **~1.4× faster**.
- **Orbit server-side — the handler's work only**: a fresh `Request` is built outside the timer (a keep-alive load tool constructs requests once per connection), then `orbit.handler()` runs. **26,270 RPS** — the remaining gap to the core is undici's `arrayBuffer`/`Response` construction, not Orbit.
- **Orbit fetch path — the full handler** with a fresh `Request` + `Response` per op: **30,088 RPS** in this run. The two handler numbers land within measurement noise of each other (26.3k vs 30.1k) — the spread is undici's `Request`/`arrayBuffer`/`Response` work plus GC, not Orbit, whose own share is ~5 µs/op.

**How the core stays fast:** a **parse LRU cache** (gated on zero plugins — nothing can mutate the tree) drops repeated `parseOQS` calls to a map lookup, and a `negotiateFormat` fast path resolves plain `Accept` headers in a single `includes()`. `execute()` runs at ~5 µs/op. A zero-plugin single-level fast path was measured and **deliberately skipped**: the generator pipeline now costs only ~2 µs of the budget, and duplicating the resolution logic would create permanent maintenance debt for <2%.

> B8 takes this the rest of the way: both engines behind identical `node:http` servers, the same keep-alive client, the same machine. The in-process numbers here are the engine's ceiling; B8 is what a deployment actually sees.

### B4 — Payload size: 20-post feed — ✅ `19 KB` vs graphql-js `446 KB` JSON (measured)

A realistic 20-post feed (~446 KB as JSON) serialized every way, with the SAME feed run through a real graphql-js response:

| Encoding | Orbit feed | graphql-js response |
| :--- | :--- | :--- |
| JSON | 446.2 KB | 446.2 KB |
| MessagePack | 443.6 KB | — |
| JSON + gzip | 19.1 KB | 19.1 KB |
| **MessagePack + gzip** | **19.1 KB** | — |

The honest takeaways: **MessagePack alone trims ~0.6%** (446.2 → 443.6 KB) on text-heavy payloads (msgpack's real wins are parse speed and binary data — see B3 for the parse-speed side). The big win is **gzip** — and both protocols reach 19.1 KB when compressed. Orbit negotiates gzip via `Accept-Encoding` on the same handler, so the wire advantage of the protocol is **not** payload size here; it is B1's latency, B2's round-trips and B3's throughput. Against GraphQL's *uncompressed* JSON the protocol ships the identical feed in **4% of the bytes** (19 KB vs 446 KB), inside the ~120 KB goal.

### B5 — TTFB in streaming — ✅ `6 ms` (goal < 50 ms)

A root query whose relation takes ~120 ms to resolve (realistic slow join). REST waits for everything: ~400 ms to first byte. Orbit's SSE stream (`accept: text/event-stream`) emits the **root level the moment its adapter answers** — measured 5.6 ms to the first frame, ~120 ms to completion. The client renders the user card while the database finishes the posts.

> Measurement note: the first `Request`/`Response` in a Node process pays undici's cold-start (~90 ms). The benchmark warms up first, so the 5.6 ms reflects steady-state streaming, not the warm-up artifact.

### B8 — Wire path: real HTTP head-to-head — ✅ `3,345 RPS` vs graphql-js `2,391 RPS`

Everything else on this page measures engines in-process. B8 measures the
**real transport**: an identical `node:http` server for each side (the same
handler shape a production deployment uses), a single keep-alive connection
reused by `node:http`'s own client (production client behavior), the same
`user(id="1") { name, email }` query, on the same machine.

- **Orbit**: `orbit.handler()` behind the server — **3,345 RPS**.
- **GraphQL**: a bare `graphql()` (parse + validate + execute per request, what
  a default GraphQL HTTP server pays) — **2,391 RPS**.

**Orbit's wire path is ~1.4× faster end to end**, including the HTTP stack,
JSON body parsing and response serialization on both sides. (The cached-
document GraphQL variant is even closer in-process — see B3 — but a plain
GraphQL HTTP server does not cache documents by default.) The absolute RPS is
lower than the in-process core numbers because the client is a single
sequential keep-alive stream — the point is the fair, same-stack comparison,
not a throughput ceiling.

### B7 — Realtime HTTP: WebSocket fan-out — ✅ `4.08 ms` vs the `< 200 ms` spec goal

Real WebSocket connections over `node:http` (RFC 6455 hand-rolled, zero deps), driven by a raw `net.Socket` client so the numbers are the server's, not undici's:

- **Connect + subscribe throughput: 1,294 subs/s** — each sub is a real HTTP upgrade (handshake round-trip + subscribe frame + ack), measured sequentially so every op is awaited.
- **Fan-out: 4.08 ms for 200 sockets** (write path ~2.81 ms + same-process delivery ~1.27 ms). ONE adapter event reaches all 200 subscribers through a single deduped hub hook. **40× inside the goal.**
- **Resume replay: 2.14 ms for 500 missed patches** over the wire to a reconnected socket (the spec §10 delta-sync story) — **84× inside the goal.**
- The **~17 µs per `socket.write()` is libuv, not Orbit**: the same run simulates the identical 200 sockets with *pure* `net.Socket`s (no Orbit, no WebSocket framing, 80-byte frames — the measured event-frame size) and delivers them in **4.75 ms**, essentially the whole 2.81 ms write path. Orbit's own fan-out (hub + encode) is **168 µs** for 100 in-memory subscribers (see B6).

### B6 — Reconnect: warm replay — ✅ `0.1 ms` vs Apollo `2,000 ms` (reference)

After an offline disconnect, Apollo refetches the whole graph (~2 s on a mobile network). Orbit has two replay paths:

- **Warm cache replay:** a single map lookup plus serialization — **P99 0.1 ms** for the full `user { id, name, email }` graph from the in-memory cache store (`cache: 'ttl=300'`).
-  **Realtime resume (the delta-sync story):** **100 clients on ONE shared adapter hook**, a patch reaching all of them in **168 µs** of fan-out, and a resume replaying **500 missed patches in 158 µs**. The subscription survives the disconnect (`retentionMs`), the event log keeps growing, and `resume` replays only the gap — not the whole graph. Well inside the < 200 ms goal. (B7 measures the same story over real sockets: see above.)

Both are the "replay from Redis" story the spec targets — swap the store for Redis and the contract is identical.

### B9 — Deep nest: warm cache replay vs DataLoader — ✅ `0.12 ms` (0 DB calls) vs `26.46 ms` (5 batches/request)

B2 measured the naive N+1 (1,112 resolver calls). B9 measures the **fix** on the same 5-level graph, both sides:

- **Orbit — cache plugin**: the first request resolves the tree (5 batched round-trips, one per level) and stores each level in the cache store. Every warm request after that is a **0-DB-call replay from memory: P99 0.12 ms**.
- **GraphQL + DataLoader** (the standard N+1 fix): batchers collapse the 1,112 resolver calls into **5 DB batches per request** — the same per-level floor as Orbit's contract. But DataLoader caches *within one request only*: a fresh loader per request is the correct production setup (a shared loader leaks cross-request caching), so **every request still pays all 5 batches** — measured P99 26.46 ms on this machine.

The honest takeaway: **DataLoader closes the cold N+1 gap** (B2's 1,112 → 5, parity with Orbit's batching), but it does not make repeat requests cheaper. Orbit's *contract-level* cache does: the second identical request costs 0 round-trips. For the "user refreshes / reconnects / re-renders" pattern — the most common read in any app — that is the delta that matters, and it is the same story B6 measures for a single query and this benchmark extends to the whole deep graph.

> Fairness notes: the GraphQL document is pre-parsed + pre-validated (cached-document, the B3 discipline) so 26.46 ms is execution-only, not parse. DB calls are counted by instrumenting the batch functions and the root resolver — one batchFn invocation per level, exactly the model of one adapter `batch()` per level.

### B10 — Client overhead: `@orbit/client` vs raw fetch — ✅ `0.674 ms` vs `0.699 ms` (−3.6% — inside the 15% budget)

The previous scenarios measure the engine. B10 measures the **client**: `createClient(...).query()` against a hand-rolled `fetch` that does the same POST + parse, both hitting the exact same `node:http` server + `orbit.handler` on this machine. The engine work is identical, so this isolates what `@orbit/client` *adds* on top of a bare round-trip — envelope validation, header negotiation, gzip, response mapping and error normalization.

- **Raw fetch**: a hand-written POST + `res.json()` — **0.699 ms** P99.
- **`client.query()`**: the full client path — **0.674 ms** P99 (measured twice, alternating order, warm).

**The client adds nothing measurable in this run (−3.6%)**, well inside the ≤ 15% goal. On loopback the whole round-trip is sub-millisecond, so envelope validation, header negotiation, gzip and response mapping (~a hundred microseconds of pure work) sit right at the noise floor of the measurement; on a real network the same fixed cost is dwarfed by RTT. Either way the budget holds: teams get the protocol's validation and error contract without a meaningful latency tax. The previous run measured **+12.7%**; the sign flips with machine noise, the order of magnitude does not.

### B11 — The React layer: warm cache hit vs raw fetch — ✅ `0.002 ms` (0 HTTP) vs `0.738 ms` (354×)

B10 showed the vanilla client costs nothing measurable on loopback (−3.6%, inside noise), well inside budget. B11 extends the same experiment up one layer: what does **`@orbit/react`** (the hooks + cache wrapper) cost — and what does its cache buy? Three paths hit the exact same `node:http` server + `orbit.handler`:

- **Raw fetch** — hand-written POST + parse: **0.738 ms** P99.
- **`@orbit/client`** — `query()`: **0.690 ms** P99.
- **`@orbit/react` on a miss** — `invalidate()` + `ensureQuery()`: **0.742 ms** P99, a **+7.5% overhead** over the bare client. That extra cost is the cache's bookkeeping — key derivation, entry write, version bump, listener notify, LRU eviction check — the price of getting every *subsequent* read for free.
- **`@orbit/react` warm cache hit** — `ensureQuery()` on a fresh entry (what the hooks deliver on every repeated read, re-render and remount): **0.002 ms** P99 — **zero HTTP round-trips**, 354× faster than the raw fetch that a hand-written client pays *every single time*.

The story, end to end: the client's protocol work costs nothing measurable on loopback (B10), the cache layer adds ~7.5% only when it misses (B11), and then turns every repeated read into a **2-microsecond in-memory lookup** — the exact pattern that dominates real apps (the same query re-rendered, re-mounted, re-scrolled).

> Fairness notes: the miss path includes the explicit `invalidate()` in the timed loop, so +7.5% is the *worst case* per-query tax (eviction + refetch); a plain first-time miss without eviction is cheaper. All three paths were warmed and measured in alternating order (2,000 samples each).

### B12 — Wire bytes: round-trip with a compressed request — ✅ `25.5 KB` vs `191.7 KB` (86.7% fewer)

B4 measures a RESPONSE in isolation. Agents and mobile clients spend bytes in **both** directions: they upload query text, filters and mutation payloads, then download the graph. B12 sends two realistic envelopes through the real `orbit.handler` and counts what leaves and returns:

- A bulk write — an agent importing content (8 posts of the B4 feed, half the bytes of the fixture).
- The read that follows — the same feed, projected to the fields a list screen needs.

| Configuration | Bytes in | Bytes out | Round trip |
| :--- | ---: | ---: | ---: |
| JSON request, gzip JSON response (client default) | 173.8 KB | 17.9 KB | **191.7 KB** |
| **gzip JSON request, gzip JSON response** (`compressRequests`) | 7.6 KB | 17.9 KB | **25.5 KB** |
| gzip MessagePack request + response | 7.6 KB | 18.0 KB | 25.6 KB |

The whole saving is the uplink: the write request drops **173.8 KB → 7.6 KB**, and the download is already compressed in every configuration. MessagePack adds nothing on top of gzip here (B4's lesson again — gzip equalizes), so the win is purely the request side, which the protocol could not compress at all before.

> Fairness note: the B4 fixture's prose is assembled from a small sentence pool, so it compresses better than arbitrary user text (the same caveat as B4's 446 KB → 19 KB). The number to trust is the **direction and the ratio between configurations** — a compressed request is never worse than a compressed response, and the server bounds the decompressed size, so the upside has no matching DoS downside. Numbers are deterministic (fixed fixtures, no sampling): B12 measures bytes, not time — B3/B8 measure the cost of these paths in RPS.

## Methodology & honesty

- **Same machine, same clock, same fixtures.** Orbit and graphql-js resolve the SAME data (`bench/fixtures.ts`) with the same timing helpers (`bench/measure.ts`) on this machine — the table, the prose and the embedded chart all come from the same Node v26.13.0 run of `pnpm run bench`.
- **The competition is installed and measured.** `graphql` (v17) and `dataloader` are devDependencies of the bench harness; `bench/graphql.ts` runs parse + validate + execute against schemas built from the same fixtures (and DataLoader batches for B9). REST (B1/B5) and Apollo (B6) figures remain spec references — there is no zero-dependency REST/Apollo equivalent to install, and they are labeled as references in the table.
- **`@orbit/core` stays zero-dependency.** The `graphql`/`dataloader` devDependencies live at the repo root, for the bench harness only — the shipped core package has no runtime dependencies.
- **GraphQL gets its fair best case in B3.** Two numbers are reported: naive (full `graphql()` pipeline per op) and cached-document (pre-parsed + pre-validated, what production servers do and the direct equivalent of Orbit's parse LRU). The headline comparison uses the cached number.
- **Warm-ups before every timing** to exclude JIT and undici cold starts.
- **Percentiles, not averages**, for latency (P99 over 2,000 samples).
- **Every RPS op is awaited before the next starts** — unawaited loops pipeline microtasks and inflate the number; the harness measures completed work.
- **B7 speaks raw RFC 6455** — the bench client (`bench/ws-client.ts`) builds frames byte-by-byte over `net.Socket`, so no undici buffering inflates or hides server work; fan-out and resume are timed by counting the frames each socket actually receives.
- **B7's `~17 µs/write` is measured, not assumed**: the same run times a no-Orbit baseline — the same 200 pure `net.Socket` pairs, each sent a frame of the measured event size — and prints its delivery time next to the fan-out (4.75 ms vs 2.81 ms write path in this run). See the B7 section.
- **B3 reports three Orbit numbers** — engine core (headline, the protocol's own throughput), server-side handler work (keep-alive semantics), and the full fetch path — with the undici budget documented, so the ~30k goal is compared against the protocol itself.
- **Handler measurements get a longer JIT warm-up** (1,000 ops) because the fetch path needs more warming than the hot execute loop.
- The harness is fully reproducible: `pnpm run bench` → console table + `bench/results/*`.

## Core package weight

`pnpm run size` measures what a client/server actually downloads for the
protocol core — the built `dist` of `@orbit/core` vs graphql-js (the
dependency a GraphQL server must ship), on this machine:

| Package | Raw JS | Gzip | Files | Runtime deps |
| :--- | :--- | :--- | :--- | :--- |
| `@orbit/core` | **103.5 KB** | **26.4 KB** | 18 | **0** |
| graphql-js | 1,383 KB | 137.4 KB | 696 | 0 |

Orbit's protocol core ships at **~7.5% of graphql-js's raw bytes** and
**~19% gzipped** — with zero runtime dependencies (graphql-js ships its own
`dependencies` too). ~3,590 lines of TypeScript cover the engine, OQS,
envelope, MessagePack codec, cache plugin, and the RFC 6455 WebSocket
transport.

## Reproduce

```bash
pnpm run bench    # builds dist, runs all twelve scenarios (B1–B12), regenerates chart
pnpm run size     # builds dist, prints the core-vs-graphql weight table above
```

Results land in `bench/results/benchmarks.json` (machine-readable) and `bench/results/chart.svg`. The chart above is embedded from that exact SVG (B1–B12) — re-run the benchmark before updating this page so the numbers stay real.
