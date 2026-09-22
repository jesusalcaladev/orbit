import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
