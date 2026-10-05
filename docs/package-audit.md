# Package audit — evidence and verdicts

An audit of all 15 workspace packages, run against the source (not the docs).
Verdicts are **proposals**: nothing was deleted, moved or renamed in this pass,
because every change below touches public import paths.

**Recommendation up front: keep all 15.** The two that look redundant on paper
are not — the apparent overlap is a naming problem, not a packaging one. Details
and the one naming fix worth doing are below.

## Method

For each package: what it exports, its runtime dependencies, its source size,
its test count, and whether anything else in the workspace depends on it. A
package is redundant only if another package provides the *same* capability on
the *same* inputs — not merely if both touch caching.

| Package | Deps | Src LOC | Tests | Verdict |
| --- | --- | --- | --- | --- |
| `core` | **none** | 6520 | 29 files / 582 | Keep — the protocol |
| `client` | core | 1880 | 9 files / 150 | Keep |
| `react` | client | 1870 | 6 files / 141 | Keep |
| `cors` | core | 257 | 3 files / 11 | Keep |
| `auth` | core | 214 | 1 file / 15 | Keep |
| `cache` | core | 118 | 2 files / 9 | Keep — see §1 |
| `kv-cache` | core | 125 | 1 file / 9 | Keep — see §1 |
| `redis` | core | 301 | 2 files / 17 | Keep |
| `rate-limit` | core | 390 | 1 file / 26 | Keep |
| `metrics` | core | 242 | 1 file / 10 | Keep |
| `logging` | core | 164 | 1 file / 11 | Keep |
| `rest` | core | 234 | 1 file / 26 | Keep — it is an adapter |
| `express` | core, express | 282 | 1 file / 18 | Keep |
| `hono` | core, hono | 172 | 1 file / 13 | Keep |
| `cloudflare-workers` | core | 517 | 1 file / 40 | Keep |

Every package except `core` depends **only** on `@orbit/core` (and, for the
framework hosts, its own framework). The dependency graph is a clean star around
a zero-dependency core — there is no circular, redundant or orphaned layer
anywhere in the tree.

## 1. `@orbit/cache` vs `@orbit/kv-cache` — the one real confusion

These two are *not* duplicates; the naming just makes them look like it.

- `@orbit/cache` exports **`createKvCachePlugin`** — a *cache plugin*
  (`onBeforeResolve`/`onAfterResolve` hooks that add TTL/SWR to the pipeline).
- `@orbit/kv-cache` exports **`createKvCacheStore`** — a **`CacheStore`**, a
  plain `get`/`set`/`delete`/`clear` adapter over a Workers KV binding.

Different layers: one wraps the query pipeline, the other implements a storage
interface the plugin consumes. The audit's original suspicion was wrong, and
merging them would fuse a pipeline plugin with a storage backend.

The genuine problem is vocabulary, not structure: **two unrelated exports both
contain the token `KvCache`** (`createKvCachePlugin`, `createKvCacheStore`), and
neither name says which layer it is. A developer grepping for "KV cache" cannot
tell them apart.

**Proposed fix (naming only, no package removal).** Rename for the layer, keeping
back-compat aliases:

- `createKvCachePlugin` → `createStoreCachePlugin` (it is the plugin that turns
  a `CacheStore` into a caching plugin; alias the old name).
- `createKvCacheStore` → `createWorkersKvStore` (names its actual backend —
  Workers KV — the way `createRedisCacheStore` names Redis).

Both renames are purely additive if the old names stay exported, so this is a
deprecation, not a breaking change. **Not applied** — it is a public API
decision for the maintainer.

Note also that `createKvCachePlugin` is documented in three places as being for
"external key-value stores (Redis, Cloudflare KV, Memcached…)" while
`createKvCacheStore` is Cloudflare-specific. That overlap is intentional (the
plugin is backend-agnostic, one store is not) but the docs do not say so
plainly.

## 2. `@orbit/rest` is an adapter, not a framework

Worth stating because its name suggests a REST *server*. It is the opposite: a
`DataAdapter` that lets Orbit **consume** a REST API as a data source
(`GET /v1/user/42` for `user(id="42")`). The framework hosts are `express`,
`hono` and `cloudflare-workers`. No overlap; the name is just easy to misread.

## 3. Framework hosts are thin and earn their place

`hono` (172 LOC) and `express` (282 LOC) are small because the engine is
runtime-agnostic and returns standard `Response` objects — the adapters are
genuinely thin. Each ships its own tests (13 and 18). `cloudflare-workers` is
larger (517 LOC) because it carries both an HTTP host **and** the WebSocket
realtime transport with its own adapter.

Not shipped: Fastify, Koa, Nest, Next, Deno, Bun. Each would be a small adapter
of the existing shape; `@orbit/fastify` is the cheapest next one.

## 4. Cross-package duplication: none material

The only repeated code is the intentional per-runtime realtime transport, and it
is already factored correctly: both the Node and Workers transports delegate
their frame protocol to a single runtime-agnostic driver
(`packages/core/src/realtime/driver.ts`), so the frozen frame contract cannot
drift between runtimes. That is duplication *prevented*, not present.

`@orbit/core`'s cache plugin and `@orbit/cache`'s `createKvCachePlugin` overlap
in *concept* (both add TTL/SWR to the pipeline), but they are different
mechanisms — the core one is in-memory-first with entity eviction, the store one
is built for network latency. Not a merge candidate; worth a note in the docs.

## What I would actually do

1. **Nothing structural.** All 15 packages are coherent, layered and used.
2. Rename the two `KvCache` exports per §1, with aliases — the only change that
   measurably reduces confusion.
3. Keep adding framework hosts on demand; they are cheap and independent.