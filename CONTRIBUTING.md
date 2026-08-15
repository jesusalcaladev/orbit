# Contributing

Thanks for helping make Orbit better! Here's how to get started.

## Setup

Orbit is a **pnpm monorepo** — the frozen protocol core lives in
`packages/core` (`@orbit/core`), the ecosystem packages slot in as
`packages/*` (`@orbit/rest`, `@orbit/cache`, …).

```bash
pnpm install
```

## Commands

| Command | What it does |
| :--- | :--- |
| `pnpm test` | Run the full Vitest suite across every workspace (635 tests: 400 core + 18 express + 13 hono + 24 rest + 4 cache + 35 cloudflare-workers + 21 rate-limit + 15 auth + 9 logging + 17 redis + 9 kv-cache + 30 postgres + 40 mongo) |
| `pnpm run test:watch` | Watch mode (core) |
| `pnpm run test:coverage` | Coverage per package with v8 thresholds (≥90% stmts / funcs / lines, ≥85% branch) — run `pnpm -r run test:coverage` |
| `pnpm run typecheck` | Strict TypeScript check (builds all packages, then checks examples/bench) |
| `pnpm run build` | Emit ESM + `.d.ts` to `dist/` in every package |
| `pnpm run example` | Run the zero-dependency demo server |
| `pnpm run examples` | Run all eleven runnable examples |
| `pnpm run bench` | Run the B1–B9 benchmarks and regenerate the chart |

## Running the benchmarks

`npm run bench` builds `dist/`, measures all nine scenarios, and writes
`bench/results/benchmarks.json` + `bench/results/chart.svg`. The chart in
`docs/benchmarks.md` is a copy of that SVG — re-embed it when the numbers
change so the docs stay honest.

## Guidelines

- **Zero runtime dependencies.** New features must not add runtime deps. Dev-only tooling stays minimal too.
- **Clean, typed, documented.** Follow the existing style: strict TS, JSDoc on public API, no `any`.
- **Tests first.** Every behavior lands with tests in `test/` — the suite is the protocol's spec.
- **No magic.** If a behavior can't be explained in one sentence, reconsider it. Orbit delegates, it doesn't guess.
- **Keep it thin.** The core transports intent; "brains" live in plugins and adapters.

## Structure

```
packages/core/
  src/
    parser.ts        OQS grammar
    engine.ts        the pipeline, executor, HTTP handler
    types.ts         protocol types
    errors.ts        OrbitError + codes
    envelope.ts      envelope validation + size limit
    plugins/         hook types, PluginRegistry, cache plugin
    adapters/        DataAdapter, registry, memory adapter
    realtime/        WebSocket transport (RFC 6455), hub, frames
  test/              the Vitest suite (incl. test/contract.test.ts)
docs/                protocol documentation
examples/            standalone zero-dep demos (consume @orbit/core)
bench/               the B1–B7 benchmark suite
```
