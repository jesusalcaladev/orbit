---
"@orbit/core": minor
"@orbit/client": minor
---

Compress request bodies in both directions. The handler inflates
`content-encoding: gzip` (and `br` where the runtime can decode it) envelopes
and enforces `maxPayloadBytes` on the **inflated** bytes while inflating, so a
decompression bomb is a bounded `413` instead of a new DoS surface; unknown
encodings answer `400 ORBIT_INVALID_QUERY` and a transit-inflated body is not
decoded twice. `@orbit/client` gains opt-in `compressRequests` (envelopes ≥ 512
bytes, only when gzip shrinks them, identity fallback without a codec) plus an
injectable `compress`. Benchmark B12 measures the round-trip: 191.7 KB → 25.5 KB
for an agent write + read, with the write request alone dropping 173.7 → 7.5 KB.
See `docs/wire-efficiency.md`.
