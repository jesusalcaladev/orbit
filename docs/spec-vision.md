# The Orbit north star — what the spec is really seeking

> A companion to [`spec.md`](../spec.md). The spec is the contract; this
> document is the *why* — the mission behind it, the decision filters that
> keep every change on-mission, and a self-check of the recent work so we
> never drift from what we set out to build.

## 1 · The one-sentence core

> **Orbit is a zero-dependency contract layer that transports *intent* from
> client to server — not a schema, not an ORM, not a runtime. The envelope is
> the only schema the protocol owns.**

That sentence (§0) is the north star. Every feature, every fix, every package
must serve it or stay out of the core. When a proposal feels "clever" but
doesn't trace back to that sentence, it's a deviation.

## 2 · The five pains we exist to kill (§0)

Everything the protocol does maps to one of these:

| Pain | The protocol answer |
| :--- | :--- |
| **N+1 queries** | One query describes a whole graph; `batch` collapses sibling requests into one round-trip (B2: 5 DB calls vs 1112). |
| **Fat payloads** | Projection is server-side — only requested fields leave; msgpack + gzip shrink the wire (B4: 19 KB vs 446 KB). |
| **Slow first bytes** | SSE streams the graph level by level as it resolves (B5: 6 ms TTFB). |
| **Locked-in client stacks** | Framework-agnostic `(Request) => Response` handler; `@orbit/express`/`@orbit/hono` are thin bridges, not forks. |
| **Reconnects that refetch everything** | Realtime subscriptions with `seq` cursors + resume replay only the delta (B6: ~320 µs). |

If a change doesn't serve at least one of these, it belongs in an example or
a demo, not in the core.

## 3 · The seven principles as decision filters (§2)

Before adding anything to the protocol, run it through the filters:

1. **Intent, not schema** — does this add *schema knowledge* to the core?
   If yes: stop. Schema lives in adapters.
2. **The envelope is the only schema** — does this change the envelope's
   shape? Only additively, ever (new optional fields).
3. **The core knows no databases** — does this require data semantics
   (per-record reasoning, query planning, cost estimation)? If yes: it does
   not belong in the engine.
4. **Everything else is a plugin** — can this be a hook instead of an engine
   branch? If yes: hook it.
5. **Zero dependencies** — does this `require`/`import` anything at runtime?
   If yes: it goes in a companion package (`@orbit/*`), not `@orbit/core`.
6. **Best-in-class wire** — does this make the wire slower or fatter?
   If yes: it fails.
7. **Realtime is first-class** — does this treat realtime as an afterthought
   (a separate protocol, a parallel API)? If yes: redesign.

## 4 · What is deliberately NOT in scope (§14)

- **No ORM, no schema DSL, no query planner** — resolvers are plain functions.
- **No bundled clients yet** — the envelope is small enough to hand-roll; a
  client suite is a separate track, once the wire contract is settled.
- **No database coupling** — adapters, always adapters.

## 5 · Guardrails — how to not deviate

Concrete rules derived from the north star, used in every review:

1. **Wire is additive-only.** Nothing marked ✅ may change shape without a
   major version bump (spec §13 compat rule). New fields are optional, new
   frames are new keys, new error codes are added, never repurposed.
2. **Frozen surfaces stay frozen and pinned.** Envelope (§3), errors (§6),
   `DataAdapter` (§9), plugin pipeline (§11) and the exported API surface are
   pinned by `contract.test.ts` / `api-surface.test.ts` — a change to them is
   a deliberate, reviewed breaking change.
3. **The engine must never learn data semantics.** Entity *names* come from
   the query tree (fine). What a record *is*, whether two records overlap, or
   how data relates — that's adapter territory. (This is exactly why
   server-side cache eviction stops at entity granularity: per-record
   precision would need data knowledge the core refuses to own.)
4. **Capabilities over hardcoding.** The engine drives the cache plugin by a
   duck-typed capability (`invalidateEntity`), not by a hardcoded plugin name
   — new cache implementations plug in without engine changes.
5. **Zero-dep is a hard line for the core.** Any runtime dependency means the
   feature ships in `@orbit/*`, and the core stays `npm install`-free.
6. **The spec must be truthful.** If the spec promises something the code
   doesn't do, either the code lands or the spec is corrected — never left
   drifting (that is what `docs/protocol-audit.md` exists to catch).
7. **Stay on 0.0.1 until the freeze genuinely demands a bump.** Version churn
   is not a feature; contract stability is.

## 6 · Alignment check — recent work

| Change | North-star link | Verdict |
| :--- | :--- | :--- |
| Envelope `{ query }`/`{ do }` over WebSocket | §0 (one protocol everywhere) + principle 7 (realtime first-class) | ✅ Aligned — the same envelope, same pipeline, same error contract on the socket; wire additions were optional fields only. |
| `@orbit/express` / `@orbit/hono` | §0 (framework-agnostic) + principle 4 (plugins/adapters) | ✅ Aligned — thin raw bridges; the protocol is untouched and the core stays zero-dep. |
| OQS key/value length caps | Principle 2 (the envelope is the only schema — bound it) + principle 5 (hardening without deps) | ✅ Aligned — parse-time, configurable, no wire change; restores §4's "validated for length" honestly. |
| Entity-scoped server-side cache eviction | Principle 4 (plugin capability, engine drives it) + guardrail 3 (no data semantics in the core) | ✅ Aligned at entity granularity — automatic, precise where the protocol can be precise, and per-record precision deliberately refused. |
| Interactive web demos (chat, uploads, auth, A/B) | Presentation of the protocol; no core surface touched | ✅ Aligned — demos exist to prove the wire, not to extend it. |
| Spec/audit truthfulness fixes (separators, gzip feature-check, dead header) | Guardrail 6 (the spec must be truthful) | ✅ Aligned — the contract document now matches the code. |

## 7 · Temptations to resist (known deviation traps)

- **\"Let's add a validation/schema DSL to the core.\"** Kills principles 1–2
  and §14. Validation is adapter/plugin territory.
- **\"The engine should plan queries / estimate cost.\"** Kills principle 3.
  The BFS-with-batching strategy is the whole plan; adapters keep the smarts.
- **\"Ship the client SDK now.\"** The spec says the client suite is a
  separate track — premature while the wire is still settling.
- **\"Make the cache evict per-record for real precision.\"** Requires data
  semantics; the honest answer is entity granularity, documented.
- **\"Bump to 0.1 to ship it faster.\"** The freeze exists so early adopters
  can trust the contract; churn before 1.0 is a feature, not a bug, of the
  process — but 0.0.1 is where we stay until the roadmap genuinely needs it.

---

*Keep this page next to the spec: the spec says what the protocol IS; this
page says what it is FOR. If a change can't explain itself with both, it
doesn't land.*
