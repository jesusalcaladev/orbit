# Contributing

Thanks for helping make Orbit better! Here's how to get started.

## Setup

Orbit is a **pnpm monorepo** — the core package lives in `packages/core`, and
new packages slot in as `packages/*`.

```bash
pnpm install
```

## Commands

| Command | What it does |
| :--- | :--- |
| `pnpm test` | Run the Vitest suite (270+ tests, in `packages/core`) |
| `pnpm run test:watch` | Watch mode |
| `pnpm run test:coverage` | Coverage report with thresholds (90% stmts / 90% funcs / 85% branch; currently 94% stmts) |
| `pnpm run typecheck` | Strict TypeScript check (builds the core first, then checks examples/bench) |
| `pnpm run build` | Emit ESM + `.d.ts` to `packages/core/dist` |
| `pnpm run example` | Run the zero-dependency demo server |
| `pnpm run examples` | Run all nine runnable examples |
| `pnpm run bench` | Run the B1–B7 benchmarks and regenerate the chart |

## Running the benchmarks

`npm run bench` builds `dist/`, measures all seven scenarios, and writes
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
