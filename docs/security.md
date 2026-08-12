# Orbit Security

The threat model of `@orbit/core`'s HTTP handler, parser, codecs and realtime
transport. What is defended by the contract, what is the deployer's job, and
how each defense is tested.

## Defense in depth, by layer

| Layer | Attack | Defense | Test |
| :--- | :--- | :--- | :--- |
| Envelope (HTTP body) | Oversized payloads | `maxPayloadBytes` (default 10 MiB) enforced before parsing + early 413 on declared `content-length` | `test/errors.test.ts`, `test/server.test.ts` |
| Envelope | Malformed JSON / msgpack | Strict validation → `ORBIT_INVALID_QUERY` (400), never a crash | `test/envelope` coverage in `test/errors.test.ts` |
| OQS parser | ReDoS via pathological input | Hand-written character scanner — **no backtracking regexes** on the hot path | `test/parser.test.ts` |
| OQS parser | Depth-bomb queries | `maxQueryDepth` (default 10) → `ORBIT_MAX_DEPTH_EXCEEDED` before any resolution | `test/parser.test.ts` |
| OQS parser / msgpack / projection | **Prototype pollution** (`__proto__` keys) | `setOwn` — attacker keys are stored as **own properties**, never written through the `__proto__` setter | `test/parser.test.ts`, `test/msgpack.test.ts`, `test/engine.test.ts` |
| Cache | Key collisions → cache poisoning | 64-bit cache keys (`fnv1a64`, two independent 32-bit passes) — collision bound ~4e9 entries | `test/utils.test.ts`, `test/cache.test.ts` |
| Cache | Key cardinality explosion | Bounded store (`maxEntries`, default 10 000) with insertion-order eviction | `test/cache.test.ts` |
| Realtime transport | Handshake / frame protocol abuse | Full RFC 6455 validation (masking, RSV, opcodes, fragmentation, lengths, close codes) → correct close codes | `test/realtime-security.test.ts` (32 tests) |
| Realtime transport | Slow-loris, fragmented floods, declared-length DoS | Byte caps + fragment-count cap (1000) → 1009; `socket.setNoDelay` | `test/realtime-security.test.ts` |
| Realtime transport | Unauthorized connections | `authorize()` gate (403 on sync throw / async reject) + optional `origin` allow-list | `test/realtime-security.test.ts` |

## Prototype pollution — the fix in detail

A query like `user(__proto__="x") { id }` or a msgpack envelope with a map key
of `__proto__` must never rewrite the prototype of the objects the engine
builds. Before the fix, `filters[key] = value` with `key = "__proto__"` went
through the `__proto__` setter, mutating the object's prototype chain instead
of storing a filter — a classic prototype-pollution vector.

The fix (`utils.ts#setOwn`) defines **own** properties via
`Object.defineProperty`, which bypasses the setter entirely. Applied to:

- `parser.ts` — filter keys and relation names
- `engine.ts#project` — projected field names and relation setters
- `msgpack.ts#readMap` — decoded map keys

Regression tests assert the parsed node keeps `Object.prototype` as its
prototype while carrying `__proto__` as an own, verbatim value.

## What the core does NOT do (deployer's job)

These are deliberately out of scope for a zero-dependency contract layer —
they are infrastructure concerns, not protocol concerns:

- **TLS** — terminate at a proxy / your edge (Cloudflare, nginx, a load
  balancer). The handler speaks HTTP; nothing in the protocol assumes plaintext.
- **Rate limiting / DoS at scale** — connection-level throttling, IP bans and
  request budgets belong in the server wrapper. The core defends per-request
  (size, depth, protocol), not per-IP.
- **Authentication / authorization** — that is a plugin's job (`onBeforeParse`
  / `onBeforeResolve`), demonstrated by `examples/03-auth-plugin.ts`. The core
  ships no identity assumptions.
- **Request smuggling** — the `node:http` demo server and any framework wrapper
  must keep their own HTTP-layer hygiene (header size limits, `CL:TE`/`TE:CL`
  handling). The handler consumes a well-formed `Request`.
- **Slowloris at the HTTP layer** — the realtime transport defends its own
  sockets (see tests); the plain HTTP server inherits your wrapper's
  `server.headersTimeout` / `requestTimeout` settings.

## Reporting

This is a research project under the MIT license. If you find a vulnerability,
open an issue with a minimal reproducer before disclosing publicly.
