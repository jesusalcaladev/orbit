import { defineConfig } from 'vitest/config';

// @orbit/cache is a re-export-only package (the cache plugin lives in the
// frozen @orbit/core surface; this package just re-exports it). It has no
// executable logic of its own, so it carries no coverage thresholds — its
// tests assert re-export integrity instead.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
