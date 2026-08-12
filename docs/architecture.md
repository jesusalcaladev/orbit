# Architecture

Orbit is a functional pipeline. The core knows nothing of databases — only of moving data through hooks. Everything else lives in adapters and plugins.

## The pipeline

```text
┌─ envelope ────────────────────────────────────────────────┐
│ { query, do?, args?, return?, cache? }                    │
└────────────────────────────┬──────────────────────────────┘
                             ▼
              ┌───────────────────────────┐
              │ validateEnvelope          │  size limit (413) + shape check
              └───────────────────────────┘
                             ▼
              ┌───────────────────────────┐
              │ onBeforeParse  (plugins)  │  rewrite the raw query
              └───────────────────────────┘
                             ▼
              ┌───────────────────────────┐
              │ parseOQS                  │  pure, no side effects
              └───────────────────────────┘
                             ▼
              ┌───────────────────────────┐
              │ onAfterParse   (plugins)  │  enrich / replace the tree
              └───────────────────────────┘
                             ▼
              ┌───────────────────────────┐
              │ onBeforeResolve (plugins) │  short-circuit? (cache hit, auth)
              └────────────┬──────────────┘
                           │ miss
                           ▼
              ┌───────────────────────────┐
              │ resolveGraph (BFS)        │  per level:
              │   · group by entity       │    onBeforeExecute (per request)
              │   · batch or parallel     │    adapter.resolve / adapter.batch
              │   · project fields        │    onAfterResolve (per request)
              │   · expand relations      │    next level with ctx.parent
              └───────────────────────────┘
                           ▼
              ┌───────────────────────────┐
              │ onBeforeSerialize (plugins)│  transform data / swap format
              └───────────────────────────┘
                           ▼
                     JSON payload
```

`onError` wraps the whole pipeline and normalizes every failure to an `OrbitError`.

## The execution model: breadth-first with batching

The query tree is resolved **level by level**:

1. Resolve every node at depth `d`.
2. Group same-entity siblings into one `batch()` call when the adapter supports it — **this is the N+1 fix**: 50 parents × 1 relation = 1 adapter call.
3. Project the requested fields.
4. Collect the next level's relations, carrying each parent's resolved data in `ctx.parent`.
5. Repeat until the tree is exhausted.

```text
user(id="1") { name, posts { title } }
user(id="2") { name, posts { title } }      ← level 0: 2 user requests
        │
        ├─ posts adapter: batch([{parent: user1}, {parent: user2}])   ← ONE call
        │
        ▼
{ name, posts: [...] }  { name, posts: [...] }                        ← level 1
```

A single HTTP request therefore fetches the **entire graph**, whether the adapter batches (1 query) or resolves in parallel (N queries). Batching is your responsibility — the contract is that it *can* happen.

## Serialization

- **Default:** JSON. The handler wraps the result as `{ data, fromCache?, invalidates? }`.
- **Format negotiation:** any `onBeforeSerialize` hook may return `{ body, contentType }` — the handler then serves `body` verbatim. That's the extension point for msgpack (`msgpackr`), CSV, protobuf, or SSE.
- **Content type:** `application/json; charset=utf-8` unless a plugin overrides it.

## Mutations

`do: "user.update"` is split at the first `.` → entity `user`, action `update`. The adapter's `mutate` runs with `filter`/`payload` verbatim. If the envelope has a `return` clause, it is parsed (`origin: 'mutate'`) and resolved **after** the mutation. Cache plugins and clients read the `invalidates` array to clear keys.

## Size & depth guards

- **Payload:** envelopes over `maxPayloadBytes` (default 10 MiB) fail with `ORBIT_PAYLOAD_TOO_LARGE` (413) *before* parsing.
- **Depth:** trees nesting deeper than `maxQueryDepth` (default 10) fail with `ORBIT_MAX_DEPTH_EXCEEDED` at parse time.

## Error flow

1. Anything thrown anywhere becomes an `OrbitError` via `toOrbitError` (adapters may throw precise codes directly).
2. Every `onError` hook gets a chance to translate it.
3. `execute()` rejects with the final `OrbitError`; `handler()` serializes it with the right HTTP status.

## Design decisions

- **Zero runtime dependencies.** The protocol is pure ES2022 — no Node APIs in the core, so it runs in any `Request`/`Response` runtime.
- **Values are verbatim strings.** The core never infers types, keys, or uniqueness — that's the adapter's job.
- **`fromCache` is always explicit** in `execute()` results; the JSON response omits it when false.
- **No implicit query cache.** Caching happens only when a spec is present and a cache plugin is mounted.
