/**
 * Playwright config for the interactive web demos (examples/web).
 *
 * The demo server is started automatically on a dedicated port and serves
 * the built packages from /vendor (run `pnpm run build` first — the
 * `test:e2e` root script does). Tests run headless Chromium against the
 * real engine over HTTP and WebSocket.
 *
 * Run:  pnpm run test:e2e
 */
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = 4381;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: BASE,
    // The demos are interactive; screenshots help debug flakes.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node examples/web/server.ts',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { PORT: String(PORT) },
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
