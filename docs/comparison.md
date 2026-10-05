# Orbit vs GraphQL vs tRPC vs REST frameworks

An honest, source-verified comparison. Every "Orbit today" cell below was
checked against the code in this repo, not copied from the README. Where the
docs and the source disagree, **the source wins** and the discrepancy is called
out in [Known documentation drift](#known-documentation-drift).

> **Scope note.** Orbit is not trying to be "GraphQL with different syntax". It
> is an _intent-first_ data layer: you hand it adapters that know how to fetch
> an entity, and it handles graph traversal, batching, caching, realtime and
> the wire format. That trade-off is the whole comparison — you give up a
> schema-first contract and get back a much smaller core and no schema runtime.

## 1. The one-table version

| Dimension                 | Orbit                                                                          | GraphQL (graphql-js / Apollo / Hasura)       | tRPC                                   | Express / Fastify (REST)       |
| ------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------- | ------------------------------ |
| Contract model            | Intent-first: adapters, **no schema**                                          | Schema-first, SDL required                   | Schema-first via Zod, end-to-end typed | None (routes are the contract) |
| Query syntax              | OQS — one line, nesting + filters (`user(id="1") { name }`)                    | GraphQL selection set                        | Method path + Zod input                | URL + method + body            |
| N+1                       | **Solved by construction** — one batched round-trip per level                  | Needs DataLoader (Apollo) or engine batching | Needs a batching middleware            | Manual                         |
| Typed results             | ⚠️ adapter/client generics only — the wire is `unknown` (see §4)               | ✅ codegen                                   | ✅ best-in-class end-to-end            | Manual / OpenAPI               |
| Runtime schema validation | ❌ none (syntax + limits only)                                                 | ✅ the core feature                          | ✅ Zod                                 | ❌                             |
| Client cache              | ✅ built-in, protocol-driven invalidation (`x-orbit-cache`)                    | ✅ Apollo normalized cache                   | ✅ React Query                         | ❌ bring your own              |
| Server cache              | ✅ first-class plugin (TTL/SWR/entity eviction, Redis/KV)                      | ⚠️ usually CDN/edge                          | ❌                                     | ❌                             |
| Realtime                  | ✅ SSE + WS, one shared socket, `resume` replay + gap detection (§6) | ✅ `graphql-ws` subscriptions                | ⚠️ needs a separate WS lib             | ⚠️ socket.io etc.              |
| File uploads              | ✅ `multipart/form-data` built into the envelope                               | ⚠️ spec extensions                           | ⚠️ per-procedure                       | ✅ middleware                  |
| Content negotiation       | ✅ JSON + MessagePack + gzip + brotli + SSE                                    | ⚠️ transport-coupled                         | ❌ JSON                                | ❌                             |
| Batch mutations           | ✅ `ops: [...]`, sequential, fail-fast                                         | ❌ one op per request                        | `httpBatchLink`                        | ❌                             |
| HTTP cost                 | 1 request → whole graph                                                        | 1 request → whole graph                      | 1 request → whole graph                | N requests                     |
| Cold-start cost           | Low — zero-dependency core                                                     | High — schema build/registry                 | Med — codegen step                     | Low                            |
| Runtime deps              | **0** for core                                                                 | graphql + executor + validation              | client + server + zod                  | framework + your stack         |

## 2. What Orbit genuinely does better

These are measured claims, not marketing. Full numbers in
[docs/benchmarks.md](./benchmarks.md).

| Claim                            | Evidence                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cheaper wire path                | The same 5-level feed costs graphql-js **1,112 resolver calls** vs Orbit **5 batched queries**; payload drops **446 KB → 19 KB** (B2/B4)                              |
| Realtime is not an addon         | SSE, WebSocket, one shared socket and bounded `resume` replay ship in the frozen core — no second protocol to design, and a lost event is *provable* rather than silent (§6). |
| Caching is a first-class citizen | TTL + stale-while-revalidate + **entity-scoped eviction** (a mutation on `user` evicts exactly the cached queries that read `user`) is a core plugin, not a CDN trick |
| Zero-dependency core             | `@orbit/core` ships **no runtime dependencies** — a frozen contract layer you can audit in an afternoon                                                               |
| No schema runtime                | No schema build, no registry, no codegen step required to ship. The cost is the missing validation in §1                                                              |

## 3. Where Orbit is behind (be honest about this)

| Gap                                   | Impact                                                                                                                     | Fix / status                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **No schema validation**              | A query for a field that does not exist is silently projected away instead of rejected. A typo fails silently, not loudly. | Still open — the #1 DX item (`ROADMAP.md` P1 #10)                  |
| ~~**No persisted queries / allowlist**~~ | *Fixed:* `createQueryAllowlistPlugin` restricts execution to a known query set.                                        | Shipped — digest matching, audit mode, opt-in mutation gate       |
| ~~**No breadth/complexity cost limits**~~ | *Fixed:* `maxQueryBreadth` (per node) and `maxQueryComplexity` (whole tree), enforced at every entry point.    | Shipped — `ORBIT_MAX_BREADTH_EXCEEDED` / `ORBIT_MAX_COMPLEXITY_EXCEEDED` |
| **No federation / gateway**           | Single service only.                                                                                                       | Deferred to 2.0                                                   |
| **Fewer hosts**                       | Express/Hono/Workers ship; **Fastify, Koa, Nest, Next, Deno, Bun do not.**                                                 | `@orbit/fastify` is small and unwritten                           |
| **Cross-instance realtime**           | The subscription hub and replay log are process-local; multi-instance needs sticky routing.                                | Real limitation                                                   |
| **No CLI / dev server / OTel**        | No `orbit dev`, no tracing spans, no codegen command.                                                                      | Not started                                                       |

## 4. Typed results without a schema

The protocol is intentionally untyped on the wire: `OrbitResult.data` and
`@orbit/client`'s `OrbitResponse.data` are `unknown`, and `client.query()` takes
**no type parameter**. You get typing by annotating at the boundary you own —
the adapter — and casting at the edge:

```ts
import { createOrbit, type DataAdapter, type OrbitResult } from "@orbit/core";

type User = { id: string; name: string };

// The adapter is where you know the shape, so type it there.
const userAdapter: DataAdapter = {
  entity: "user",
  resolve: (filters) =>
    db.users.find((u) => u.id === filters.id) as User | undefined,
};

const orbit = createOrbit({ adapters: [userAdapter] });

// Narrow once, at the edge (the wire is `unknown` by design):
const { data } = await orbit.execute({ query: 'user(id="1") { name }' });
const user = data as User;
```

`@orbit/react` is the layer that adds real generics — `useOrbitQuery<User>(...)`
types `data` for you. So the _client_ can be typed even though the wire is not.
This is **adapter-derived typing, not schema-derived typing**: it gives you
safety at the adapter and client boundaries, but it cannot give you the thing
GraphQL gives you — rejecting an invalid query _before_ it runs. A requested
field that does not exist is silently omitted from the projection rather than
raising an error.

## 5. Choosing between them

Pick **GraphQL** when you need schema-first guarantees, a shared contract
across many independently-deployed clients, and introspection tooling.

Pick **tRPC** when your client and server are the same TypeScript codebase and
you want maximum end-to-end inference with less machinery.

Pick **REST + Express/Fastify** when you want total control, a boring
deployment story, and no new protocol to teach a team.

Pick **Orbit** when the data is a graph that clients traverse repeatedly, you
want realtime and server-side caching without bolting on two more systems, and
you would rather own a 0-dependency core than a schema toolchain. The honest
summary: **Orbit trades schema-level guarantees for a much smaller core plus
built-in caching and realtime.**

## 6. Realtime: the replay gap — now closed

This used to be the most consequential spec/code disagreement in the project,
and it was **a real data-loss bug**, not just a docs problem. It is fixed.

**The bug.** The server keeps a bounded 512-event ring per subscription
(`RESUME_LOG_MAX`) and drops anything older. `SubscriptionHub.resume` replayed
whatever survived, and the client accepted any `seq` greater than its cursor
without checking continuity. So after a disconnection longer than the ring, a
client reconnected, "successfully" resumed, and applied a **silently incomplete**
event stream: valid-looking data, missing changes, no error, no refetch. A cursor
ahead of the server was worse — it asked to resume from a `seq` the server never
reached, so it received nothing, forever.

**The fix, in both directions:**

- **Server** — `resume` is honoured only when the replay is *provably complete*.
  If `after` predates the oldest retained event, or is ahead of the server, it
  returns `null` and the driver rejects with `ORBIT_SUBSCRIPTION_FAILED`; the
  client re-subscribes from scratch. A partial replay is never presented as a
  success.
- **Client** — any `seq > cursor + 1` is reported as a hole through `onGap`
  (`{ from, to? }`), and a fresh `ack` resets the cursor, since a new
  server-side subscription restarts at `seq` 1.
- **React** — `useOrbitSubscription` refetches the query on a gap (and exposes
  `state.gaps`), so the UI heals itself instead of rendering stale data.

The remaining honest limitation is unchanged: the ring is **process-local**, so
multi-instance deployments need sticky routing or a shared bus. That is a
deployment constraint, not a correctness hole.

## Known documentation drift — RESOLVED

Found while verifying this page, and **fixed in this pass**. The code was always
correct; the prose overstated it. Each row now reads as the source does.

| Claim in docs (was)                                       | Resolution                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.md` §8 documented **field-level TTL** as implemented | Now marked **NOT IMPLEMENTED** with the reserved design. Only whole-result `ttl`/`stale` ship; unrecognised keys are ignored, not rejected.            |
| `spec.md` §10 said seq numbers let clients **detect gaps** | **Fixed in code, then documented.** `SubscriptionHub.resume` now refuses a replay it cannot serve completely, and the client reports holes via `onGap` (§6). |
| `spec.md` §7 said a matching **ETag avoids serialization work** | Now states what it actually saves: the body and its compression, not the serialize step (the digest is computed over the bytes it must produce anyway). |
| `ROADMAP.md` marked **Brotli** as ⬜ not started           | Marked ✅ — it ships in `serialize/negotiate.ts`.                                                                                                        |
| Docs referred to **seven hooks**                          | There are eight (`onAfterExecute`).                                                                                                                     |
| `spec.md` §3 said the cache spec may be a **JSON object** | Now stated as **NOT IMPLEMENTED**: the `cache` field is a string spec only.                                                                            |

## Also added in this pass

Two gaps from §3 that were listed as open are now shipped:

- **No persisted queries / allowlist** → `createQueryAllowlistPlugin` (§3),
  restricting execution to a known set of queries at `onBeforeParse`, with
  digest matching, audit mode and an opt-in mutation gate.
- **No breadth/complexity cost limits** → `maxQueryBreadth` (per node) and
  `maxQueryComplexity` (whole tree), enforced in the parser for every entry
  point including SSE and subscriptions.
