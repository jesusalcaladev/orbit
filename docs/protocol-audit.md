# Protocol audit

An exhaustive spec-vs-implementation verification of the Orbit protocol,
comparing every normative statement in [`spec.md`](../spec.md) against the
`@orbit/core` implementation (`packages/core/src/`) and the existing contract
tests (`packages/core/test/contract.test.ts`, `api-surface.test.ts`).

**Method:** each spec section was read in full; every frozen claim (envelope rules, error codes + statuses, content negotiation, cache semantics, adapter
surface, realtime frames, plugin pipeline) was checked against the source and
exercised through the handler (`packages/core/test/` covers 324 cases). The
audit itself is a **supplement** to the tests — it documents the contract
points and the deltas found.

**Legend:** ✅ verified consistent · 🔧 inconsistency found and fixed · ⚠️
observation (documented, no change required).

---

## Summary of inconsistencies found

| # | Where | What | Severity | Status |
| :- | :--- | :--- | :--- | :--- |
| 1 | `cache` spec separator (spec §8 vs `parseCacheSpec`) | Spec says "space-separated" (`ttl=300 stale=60`); the parser only accepted commas, so the spec-literal spelling returned `ORBIT_INVALID_QUERY` | **Bug** | 🔧 parser now accepts both; tests added |
| 2 | Realtime `resume.after` (spec §10 vs transport) | Spec example used a string cursor (`"after": "evt-42"`); the transport and `docs/realtime.md` use the numeric per-subscription `seq` (`after: 42`) | Doc drift | 🔧 spec corrected to the numeric form |
| 3 | Envelope over WebSocket (spec §10) | Spec claimed clients send `{ query }`/`{ do }` frames on the socket; the transport speaks subscription control frames only | Over-promise | 🔧 spec corrected (marked 🔜) |
| 4 | OQS length validation (spec §4) | Spec claimed keys/values are "validated for length"; the parser validates characters/escapes only (size is bounded by `maxPayloadBytes`) | Doc drift | 🔧 spec reworded |
| 5 | `x-orbit-cache-key` header (`examples/web/server.ts`) | The web demo forwarded a header the engine never emits — dead code | Cleanup | 🔧 removed |
| 6 | Websocket status (spec §2 principle 6) | Marked websocket as 🔜 while it shipped in v0.0.1 | Doc drift | 🔧 spec updated |
| 7 | Subscription auth context (spec §10) | Spec said the adapter's `subscribe` gets handshake auth context; v0.0.1 authorizes at the upgrade only (`authorize` option) | Over-promise | 🔧 spec corrected (marked 🔜) |
| 8 | Example count (spec §13) | "9 examples" while 11 node examples + 5 web demos + book API exist | Doc drift | 🔧 spec updated |
| 9 | gzip without `CompressionStream` (spec §7 vs handler) | Spec conditions gzip on "when the runtime provides CompressionStream"; the handler gzipped on the header alone → a runtime without it would 500 | **Bug** | 🔧 handler now feature-checks `CompressionStream` |
| 10 | `invalidates` eviction (spec §8 vs engine) | Spec said mutations return `invalidates` "so the cache plugin can evict precisely"; the engine only *echoes* them (no mutation hook exists, and plugin keys are opaque hashes an app-level key like `cache:user:1` can't address) | Over-promise | 🔧 spec reworded (echo + app-wired eviction; tag-based eviction listed as 🔜) |
| 11 | Accept negotiation edge cases | msgpack-vs-SSE ties, wildcard-vs-explicit at equal/lower `q` weren't pinned by tests | Verification gap | 🔧 tests added |
| 12 | `{ query }` / `{ do }` over WebSocket (spec §10) | Spec promised envelope frames on the socket; the transport spoke subscription control frames only — the spec marked it 🔜 | **Feature gap** | ✅ implemented: request/response over WS (correlation `id` outside the frozen envelope, same pipeline + payload as HTTP, `contentType` echoed for plugin-serialized bodies, binary bodies → `null`), 12 e2e tests |

None of the fixes changed a frozen wire shape: #1 is a strict superset (both
spellings now parse), #2–#4/#6–#8 are documentation truthfulness, and #12 is
an additive feature (new optional frame fields only, zero frozen-shape
changes).

---

## Section-by-section audit

### §2 Core principles

- Zero dependencies ✅ (core ships with none; `ws`/`graphql` are devDependencies
  of the web demo harness only).
- Principle 6: msgpack/gzip/SSE ✅ and WebSocket realtime ✅ — the "🔜
  (websocket)" marker was stale → 🔧 fixed.

### §3 Request envelope — FROZEN

- Exactly one of `query`/`do`; both or neither → `ORBIT_INVALID_QUERY` (400) ✅
  (`validateEnvelope`).
- `args` must be an object; `return`/`cache` must be strings ✅.
- Unknown fields are dropped, not rejected ✅ (matches the "additive only" rule).
- `maxPayloadBytes` default 10 MiB ✅ — enforced **early** via `content-length`
  (413 before buffering) and again on the buffered bytes; multipart too ✅.
- `maxQueryDepth` default 10 ✅.

### §4 OQS

- Grammar (entity, filters, selection, relations) ✅ matches `parser.ts`.
- Filters passed verbatim as `Record<string, string>` ✅ — bare numbers/booleans
  stay strings; quoted escapes (`\n`, `\t`, `\"`, `\\`, …) handled ✅.
- Relation nesting depth enforced per level ✅ (`ORBIT_MAX_DEPTH_EXCEEDED`, 400).
- Projection: only requested leaf fields leave the server ✅; a node with no
  selection returns the value as-is ✅.
- "Validated for length" — not implemented (only characters) → 🔧 spec reworded
  (#4). Residual: individual key/value length is bounded only by the whole-body
  cap — noted, acceptable.

### §5 Mutations

- `do` must be `entity.action` ✅; malformed → `ORBIT_INVALID_QUERY`.
- Unknown entity → `ORBIT_ENTITY_UNREGISTERED` (404) ✅; adapter without
  `mutate` → `ORBIT_MUTATION_FAILED` (500) ✅.
- Without `return`: `{ data: { success: true, id? } }` ✅.
- With `return`: re-query through the **same pipeline** (hooks included), nodes
  stamped `origin: 'mutate'` ✅ — the auth gate cannot be bypassed by a
  mutation's re-query ✅ (regression-covered).
- `invalidates` echoed back ✅.
- Mutations are not streamable ✅ — `stream()` throws for `do` envelopes; the
  SSE path answers `ORBIT_INVALID_QUERY` with a non-200 status.

### §6 Response & error shapes — FROZEN

- Success shapes: `{ data }`, `{ data, fromCache }`, `{ data, invalidates }` ✅.
- Error shape `{ error: { code, message, details? } }` ✅ (`OrbitError#toJSON`).
- Every frozen code ↔ status mapping verified against `ErrorStatus` ✅:

  | Code | HTTP | Verified |
  | :--- | :--- | :--- |
  | `ORBIT_INVALID_QUERY` | 400 | ✅ |
  | `ORBIT_ENTITY_UNREGISTERED` | 404 | ✅ |
  | `ORBIT_FILTER_INVALID` | 400 | ✅ |
  | `ORBIT_PERMISSION_DENIED` | 403 | ✅ |
  | `ORBIT_MAX_DEPTH_EXCEEDED` | 400 | ✅ |
  | `ORBIT_PAYLOAD_TOO_LARGE` | 413 | ✅ |
  | `ORBIT_MUTATION_FAILED` | 500 | ✅ |
  | `ORBIT_SUBSCRIPTION_FAILED` | 500 | ✅ |
  | `ORBIT_INTERNAL` | 500 | ✅ |
- `onError` hooks translate errors; a failing handler never masks the original ✅.
- Errors normalize exactly once (execute normalizes; the handler only
  re-normalizes raw throws) ✅.

### §7 Serialization & content negotiation

- Input: JSON (default) ✅, `application/x-msgpack` ✅, `multipart/form-data`
  with the `envelope` field + `File` fields → `ctx.files` ✅; non-file,
  non-envelope fields rejected ✅.
- Output table verified against `negotiateFormat` ✅:

  | `Accept` | Result |
  | :--- | :--- |
  | (none) / `application/json` | JSON `application/json; charset=utf-8` ✅ |
  | `application/x-msgpack` | msgpack ✅ |
  | `text/event-stream` | SSE ✅ |
  | `text/*` | SSE ✅ |
  | `application/*`, `*/*` | JSON ✅ |
  | `q`-values, `q=0` exclusions | honored ✅ |
  | Explicit beats wildcard; ties → most specific | ✅ (code-documented) |
- Compression: gzip for JSON/msgpack/SSE/plugin payloads ✅ when
  `Accept-Encoding` includes `gzip` (and not `gzip;q=0`) **and** the runtime
  provides `CompressionStream` — the handler now feature-checks instead of
  trusting the header alone (#9).
- SSE: one frame per breadth-first level + `{level:"done"}` frame ✅; parse
  errors fail fast with a non-200 status ✅; mid-stream resolution errors
  become SSE frames ✅; pull-based stream = backpressure ✅.

⚠️ Observations:
- Two explicit formats tied at `q=1` (e.g. `text/event-stream,
  application/x-msgpack`) resolve by "most specific" rank (msgpack wins) — the
  spec table doesn't pin this tie-break; code documents it.
- gzip assumes `CompressionStream` exists (Node ≥ 20 does); the spec's "when
  the runtime provides it" guard is not a runtime feature check.

### §8 Caching

- Spec sources: envelope `cache` field **and** `x-orbit-cache` header ✅
  (envelope wins).
- `invalidates` from mutations is echoed to the client only — the engine never
  auto-evicts (no mutation hook in the frozen pipeline; plugin keys are opaque
  `orbit:<hash>` hashes that app-level keys can't address). Server-side
  eviction is app-wired (`invalidate`/`invalidatePrefix`), as the book example
  does. Tag-based precise eviction is 🔜 → spec §8 reworded accordingly (#10).
- `ttl=`, `stale=`, `ttl=,stale=` combos, and a JSON-object form ✅.
- **Space-separated specs failed** (spec §8 says "space-separated") → 🔧 parser
  accepts comma **and** space; regression tests added (#1). Trailing separators
  (`ttl=1,`) still fail; interior doubled separators (`ttl=1,,stale=2`) are
  tolerated as whitespace-tolerant leniency — accepted deliberately.
- `fromCache: true` on hits ✅; SWR serves stale + background refresh ✅;
  `invalidates` / prefix invalidation ✅.
- Cache plugin stores the **final serialized** value → register after
  transformers (no double-transform on hits) ✅ (pinned by tests).
- Keys are opaque `orbit:<64-bit-hash>` — server-side invalidation is by
  prefix/whole-store; precise per-query invalidation is application-level.

### §9 DataAdapter — FROZEN

- `resolve(filters, ctx)` required ✅; `batch`, `mutate`, `subscribe` optional ✅.
- `batch` groups same-entity siblings into one call; results aligned by index,
  length validated (mismatch → `ORBIT_INTERNAL` with details) ✅.
- No `delete`/`subscribeToEntity` methods (decided against in the spec) ✅.
- `SubscriptionEvent { type, id?, data?, patch? }` ✅.
- `memoryAdapter` wires resolve + default batch + forwards mutate/subscribe ✅.

### §10 Realtime & subscriptions

- Zero-dependency RFC 6455 server (hand-rolled frames, masked-client
  enforcement, control-frame limits, fragment reassembly + count cap, 1009
  before buffering) ✅ — hardened by `realtime-security.test.ts`.
- Frames: `{ subscribe, id }` → `{ ack }`; events `{ id, seq, event }`;
  `unsubscribe` → `{ unsubscribed }`; `resume` → replay `seq > after` ✅.
- Subscription dedup: N clients share one adapter hook (keyed by
  entity + canonical filters) ✅.
- Retention window (default 60 s) + resume replay ✅ (B6).
- Heartbeats: ping every 30 s, missed pong → close ✅.
- Path filter + 404 for non-matching upgrades ✅; `authorize`/`origin` gates ✅.
- Spec drift on `resume.after` (string vs numeric) → 🔧 fixed (#2); envelope
  (`{ query }`/`{ do }`) over WS over-promised → 🔧 fixed (#3); handshake auth
  context into subscriptions over-promised → 🔧 fixed (#7).

### §11 Plugin pipeline — FROZEN

- Hook order verified in code: `onBeforeParse → parse → onAfterParse →
  onBeforeResolve → (onBeforeExecute → resolve/batch → onAfterResolve →
  project) → onBeforeSerialize → serialize` ✅ (pinned by contract test).
- Hook signatures and return contracts ✅; `undefined` keeps current value ✅;
  short-circuit = any object with a `shortCircuit` key ✅.
- `onBeforeParse`/`onAfterParse`/`onBeforeResolve` run once per query; the
  other hooks per node/level ✅.
- `QueryNode` frozen shape (`entity`, `filters`, `fields`, `relations`,
  `origin`) ✅; `origin: 'client' | 'mutate'` ✅.
- Parse LRU only active with no plugins (mutation-safe) ✅.

### §12 Benchmarks

- The B1–B9 harness exists (`bench/`) and asserts its goals (`npm run bench`).
  Numbers are machine-measured; not re-run in this audit. The `resume`
  benchmark uses the numeric `seq` cursor, consistent with the transport (#2).

### §13 Versioning

- v0.0.1 row updated to list 11 node examples + 5 web demos + the book API
  (#8). Contract freeze statements match the pinning tests
  (`contract.test.ts`, `api-surface.test.ts`).

---

## What was changed by this audit

| File | Change |
| :--- | :--- |
| `packages/core/src/plugins/cache.ts` | `parseCacheSpec` accepts comma- **and** space-separated specs (spec §8). |
| `packages/core/test/cache.test.ts` | Regression tests: space-separated parse + end-to-end cache hit. |
| `packages/core/src/engine.ts` | gzip only when the runtime provides `CompressionStream` (spec §7). |
| `packages/core/test/negotiate.test.ts` | Pinned Accept tie-breaks and wildcard-vs-q edge cases. |
| `packages/core/src/realtime/server.ts` | `{ query }` / `{ do }` envelope request/response over the socket (spec §10). |
| `packages/core/test/realtime-request.test.ts` | 12 e2e tests: query/mutation/return/errors/cache/pipeline/msgpack/mixing/plugin bodies. |
| `spec.md` | §2 websocket status, §4 length wording, §8 separator + invalidates semantics, §10 resume/after + WS envelope + auth-context claims, §13 example count. |
| `examples/web/server.ts` | Removed the dead `x-orbit-cache-key` forwarding. |

Everything else checked out consistent. The frozen contract (envelope §3,
errors §6, adapter §9, pipeline §11) needed no implementation change.

---

## What remains at the protocol level

Prioritized gaps — the spec marks these 🔜, so nothing here is a contradiction;
this is the work queue.

### Near-term (designable now)

1. **Auth context into subscriptions & envelope requests (spec §10 🔜).** The
   frozen `subscribe(filters, handler)` signature has no `ctx`, and WS
   envelope requests currently execute with an empty context — an app that
   gates mutations on `ctx.state.caller` cannot authenticate a socket
   session beyond the upgrade `authorize` gate. Additive opt-in: `authorize`
   returning a context object the transport forwards to both `execute` and
   (via a new optional hook parameter) adapters.
2. **Precise server-side cache invalidation.** Today only whole-store / prefix
   invalidation works server-side; `invalidates` keys are app-level and cannot
   address the opaque `orbit:<hash>` plugin keys. A tag index (invalidate by
   entity + filters touched by a mutation) would make §8's "evict precisely"
   literally true.
3. **OQS key/value length caps.** Bounded only by `maxPayloadBytes` today;
   explicit per-key/per-value caps would restore the spec's original "validated
   for length" promise as hardening.

### Roadmap (0.1.x → 2.0)

- **`@orbit/auth`** — the book example's `policyPlugin` is the hand-written
  prototype for this package.
- **`@orbit/redis` / `@orbit/kv-cache`** — `CacheStore` is a shipped interface;
  no production stores yet.
- **`@orbit/cloudflare-workers`** — the third server wrapper (ROADMAP 🟡).
- **0.1.x**: Postgres adapter, federation-friendly relation semantics.
- **1.0**: lock envelope + error codes for backwards compatibility.
- **2.0**: native (WASM/C++) parser for the B3 wire-path gap, first-party
  client SDKs, federated Orbit servers.
