import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suite is deliberately CPU-heavy: property/fuzz tests decode 2000
    // random payloads, hash 100k keys and negotiate 1000 adversarial headers,
    // and vitest runs test FILES in parallel. On a loaded machine (CI, a
    // laptop running the monorepo build) those loops outgrow vitest's 5 s
    // per-test default and fail for reasons unrelated to correctness — a red
    // suite that means nothing. The budget is raised here, once, instead of
    // annotating every heavy test; perf ASSERTS (the msgpack scaling ratios)
    // are still held to their own much tighter relative budgets.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // Pure API surfaces with zero runtime statements (re-export barrel and
      // type-only modules) — nothing to execute, so nothing to cover.
      // Pure re-export barrel (`@orbit/core/browser`) — same statement count
      // rule as `src/index.ts`: nothing to execute, nothing to cover.
      exclude: ['src/index.ts', 'src/browser.ts', 'src/types.ts', 'src/adapters/types.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
