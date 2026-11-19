# Wire efficiency — what's missing (KB per request & latency)

Orbit already negotiates MessagePack, streams SSE and compresses responses.
This document is the honest gap list for the two budgets that decide whether an
**agent** or a **mobile client** has a good time on a bad network:

1. **Bytes on the wire, both directions.** Agents upload long query text and
   large mutation payloads; phones pay for every KB twice (uplink is the
   expensive one).
2. **Latency per user-visible step.** Not the engine's P99 (B1: 0.11 ms) — the
   number of round-trips and how much of the graph a client must download before
   it can render.

Everything below is **additive** to the frozen contract ([`spec.md`](../spec.md)):
new optional envelope fields, new optional headers, new opt-in client options.
Nothing renames or removes a field, so none of it needs a major bump.

---

## 1. Where the bytes and round-trips go today

| Path                     | Today                                                                                                                  | Where                                                    |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| Request body             | **Compressed.** `content-encoding: gzip` (or `br`) is inflated by the handler and capped on the **inflated** bytes.     | `packages/core/src/engine.ts` `#readBody` / `#inflateBody` |
| Client request body      | **Opt-in.** `compressRequests: true` gzips envelopes ≥ 512 bytes when it shrinks them; no codec → sends raw.            | `packages/client/src/http.ts` `encodeEnvelopeBody`         |
| Response body            | `br` (when the runtime has it) or `gzip`, negotiated by q-value; identity when neither is available.                     | `packages/core/src/serialize/negotiate.ts`                 |
| Response format          | JSON (default) or MessagePack, negotiated from `Accept`.                                                                | `negotiateFormat`                                          |
| Streaming                | SSE, one frame per resolved level — **cumulative**: every frame re-serializes the whole graph so far.                    | `engine.ts` `#sseResponse`                                 |
| Conditional requests     | ETag/`304` only for the **GET** query endpoint; `@orbit/client` only POSTs, and never sends `if-none-match`.             | `engine.ts` (`conditional`), `packages/client/src/http.ts`  |
| Realtime                 | JSON text frames over RFC 6455, no `permessage-deflate`, no binary frames.                                              | `packages/core/src/realtime/`                               |
| Parse cache              | LRU keyed by the **raw query text** — so an inline `id="42"` is a new key (and a new parse) per value.                  | `engine.ts` `#parse`                                        |
| Batched reads            | No: `ops` batches **mutations**, `queries: [...]` does not exist.                                                       | `envelope.ts` `validateEnvelope`                            |
| Persisted-query ids      | The allowlist can match on a digest, and the error reports the digest — but the client still ships the full text.       | `packages/core/src/plugins/allowlist.ts`                    |
| Cold-key coalescing      | None: `revalidating` only de-duplicates stale-while-revalidate refreshes.                                               | `packages/core/src/plugins/cache.ts`                        |

---

## 2. P0 — do first (bytes per request, and the tail)

### P0.1 — Request compression ✅ shipped with this document

What landed:

- **Handler:** `content-encoding: gzip` (and `x-gzip`) is inflated with the
  web-standard `DecompressionStream`; `br` is honoured where the runtime can
  decode it. `identity` is a no-op. Unknown encodings are a `400
  ORBIT_INVALID_QUERY` with `details.encoding`, never a misparse.
- **The cap bounds the inflated bytes.** `content-length` is still checked early
  (the 413 fast path), but `maxPayloadBytes` is enforced **while inflating**:
  a 64 KB body that expands past the limit is cancelled mid-stream and answered
  `413 ORBIT_PAYLOAD_TOO_LARGE`. Without this, accepting compressed bodies would
  have added a decompression bomb to the threat model.
- **Multipart uploads are covered for free:** decoding happens before the
  content-type dispatch, so a gzipped `multipart/form-data` body parses too.
- **Client:** `compressRequests: true` gzips the envelope (JSON or MessagePack,
  `execute`/`query`/`mutate`/`batchMutate` and `stream`) when the body is
  ≥ 512 bytes **and** gzip actually makes it smaller. No `CompressionStream`
  (React Native/Hermes), a throwing `compress`, or a bigger compressed body all
  fall back to the raw body — request compression never breaks a request.

Measured by **B12** (`bench/wire-bench.ts`): a bulk write (8 posts of the B4
feed) followed by the read of the same feed, both through the real handler,
counting bytes in **and** out:

| Path                                        | Round-trip bytes |
| :------------------------------------------ | ---------------: |
| JSON request + gzip JSON response (default) |       **191.7 KB** |
| **gzip request + gzip response**            |        **25.5 KB** |
| gzip MessagePack request + response         |         25.6 KB |

The write request alone drops **173.7 KB → 7.5 KB**. Honest caveat: the B4
fixture's prose is drawn from a small sentence pool, so it compresses far better
than arbitrary text; the *direction* and the "compressed request is no worse
than compressed response" conclusion are what B12 pins.

### P0.2 — `vars` in the envelope (values out of the query text)

The parse LRU keys on the raw query text (`engine.ts` `#parse`), so
`user(id="1") { name }` and `user(id="2") { name }` are **two parses and two
cache lines** for the same shape. Agents and list screens do exactly this.

- Additive envelope field: `{ query, vars: { id: "42" } }`, with `$name`
  placeholders resolved **after** parsing, before resolution.
- Parse cache keys on `query` alone → the hit rate becomes shape-driven.
- The query text also stops being re-uploaded with every value, which compounds
  with P0.1 (gzip already kills the repetition; `vars` kills it pre-compression).
- Server tolerance matters: an unknown `$name` is `ORBIT_FILTER_INVALID` with
  the variable name, and `vars` on a `do`/`ops` envelope is allowed too (the
  adapter keeps receiving verbatim filters).

### P0.3 — `queries: [...]` (batch reads in one round-trip)

`ops` batches mutations; independent reads still cost one round-trip each
(a mobile cold start: feed + profile + notifications = 3 RTTs). An additive
`queries` array turns them into one envelope and one response array, reusing
the existing per-query pipeline and error contract. Bound it like `ops`
(`maxQueries`, default 16) and cap total complexity across the batch.

### P0.4 — Idempotency + bounded retries on the client

A retried POST is a duplicated mutation today, so clients cannot retry the one
failure mode mobile networks produce constantly. Add an optional
`idempotencyKey` (envelope or header) that the core forwards to the adapter
(`ctx.idempotencyKey`) — the adapter owns the dedupe — plus a client retry
policy that retries **only** reads and keyed mutations, with jittered backoff.
This is a latency-tail item: it converts a lost RTT from "the user re-taps" into
"it just works".

---

## 3. P1 — high value once P0 is in

### P1.1 — SSE delta frames (the streaming bytes)

`#resolveLevels` yields the **root value** at each level and `#sseResponse`
serializes it whole. A 5-level graph therefore streams the same root data five
times: ~O(depth × payload) bytes, all of it gzipped on the wire but still
CPU and memory on the client. Opt-in `?stream=delta` (or `Accept:
application/x-ndjson; delta=1`) sends only the level's own nodes, with the
client merging by path. Cumulative stays the default — it is the simplest
contract and already shipped.

### P1.2 — Conditional revalidation from the client

`ETag`/`304` exists only on the GET endpoint and `@orbit/client` never uses it.
- Teach the client to send `if-none-match` (POST is fine: the server has the
  validator for the resource) and to answer `304` from its own cache.
- That is the cheapest possible response: no body, one RTT, and the client's
  cache stays authoritative — which is exactly what `@orbit/react`'s TTL does
  locally today, minus the freshness argument with the server.

### P1.3 — Single-flight for cold cache keys

Two concurrent requests for the same cold key both hit the adapter today
(`revalidating` only covers SWR refreshes). An in-flight promise map keyed like
the cache entry collapses them: one adapter call, N followers. Pure latency win
on server-cold caches.

### P1.4 — Realtime: binary frames + compression

The transport is a hand-rolled RFC 6455 server, so:
- **MessagePack frames** (opcode 2) for `event`/`snapshot` payloads — same
  codec as HTTP, no new dependency; JSON frames stay for compatibility.
- **`permessage-deflate`** negotiation for chat/feed text, with a configurable
  window. B7 shows the fan-out is dominated by libuv writes, so this is a
  bytes-per-message win, not a latency one — right for mobile data plans.

### P1.5 — Columnar/dictionary lists

MessagePack encodes an array of 20 objects with the same 8 keys as 20 maps of 8
keys. A per-list dictionary (`{ keys: [...], rows: [[...]] }`) or a
column-oriented codec cuts homogeneous payloads substantially; it is additive if
the client asks for it via `Accept`. Measure against B4 before committing.

---

## 4. P2 — agent ergonomics and hard bounds

- **Compact `describe`.** Agents currently learn shapes from docs or errors.
  A `describe` envelope answered from the adapter registry (entity names, verbs,
  whether `resolve`/`batch`/`mutate`/`subscribe` exist) with a gzip response is
  the cheapest discovery channel — and it is what makes generated queries safe.
- **Partial errors.** One failing branch currently fails the whole graph. An
  `errors: [{ path, code, message }]` array with `data: null` at that path lets
  an agent retry the branch instead of the request.
- **Byte budget + truncation.** `limit`/`first` plus `hasMore`/`cursor` in the
  response, and a server-side `maxResponseBytes` that truncates deterministically
  with a marker — the response-side counterpart of `maxPayloadBytes`.
- **`dryRun` for mutations.** Validate the envelope, run `authorize`, and return
  what *would* happen without touching the adapter. Agents need a cheap
  "is this allowed?" probe.

---

## 5. Suggested sequence

| Version | Contents                                                                                     |
| :------ | :------------------------------------------------------------------------------------------- |
| **0.2** | P0.1 ✅ (this change) · P0.2 `vars` · P0.3 `queries`                                          |
| **0.3** | P0.4 idempotency/retries · P1.1 delta SSE (opt-in) · P1.3 single-flight · P1.2 conditional    |
| **1.0** | P1.4 realtime binary/deflate · P2 (`describe`, partial errors, budget, `dryRun`)             |
| **2.0** | P1.5 columnar coding, if B4/B12 show it is worth a wire format                                |

---

## 6. How to verify (this is the part that keeps it honest)

- **B12 (`bench/wire-bench.ts`)** — round-trip bytes through the real handler,
  request **and** response, baseline vs request-gzip vs msgpack. Every later P0
  item must be measured the same way; a benchmark that only counts responses
  hides the half of the budget agents actually spend.
- **B13 (to add with P0.2)** — parse-cache hit rate and P50 for
  `user(id="N")` across N values: today every value is a miss; with `vars` the
  shape stays hot. Also record the per-phase budget
  (parse → resolve → serialize) so a latency regression is attributable.
- Re-run `pnpm run bench` before touching numbers in
  [`docs/benchmarks.md`](./benchmarks.md); the figures in this document come
  from B12 on the same machine.

---

## 7. Constraints every item above must respect

- **Additive only.** New optional envelope fields, headers and client options.
  No renames, no removals — the envelope is frozen ([`spec.md`](../spec.md) §3).
- **Bounds before work.** Any new input (compressed body, `vars`, `queries`,
  `idempotencyKey`) gets a cap before it is parsed or expanded, and the cap is
  enforced on the **post-inflate/post-expand** size.
- **Opt-in, never silent.** Delta SSE, columnar responses and request
  compression are client choices; the default wire stays JSON + cumulative SSE.
- **Zero runtime dependencies.** `CompressionStream`/`DecompressionStream` are
  platform APIs; MessagePack is already in-repo. No new packages for the core.
- **Error contract unchanged.** New failures reuse the existing codes
  (`ORBIT_INVALID_QUERY`, `ORBIT_PAYLOAD_TOO_LARGE`, `ORBIT_FILTER_INVALID`) with
  `details`.
