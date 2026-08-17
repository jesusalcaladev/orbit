/**
 * Real-browser verification of the web demos against the live engine.
 *
 * - Every demo page loads cleanly (the @orbit/client import maps resolve
 *   from /vendor — a broken map fails here, not in a bundler).
 * - chat-realtime: a message sent over HTTP comes back over the WebSocket
 *   and renders in the feed — and a second, independent tab receives the
 *   same event live, proving the server-side broadcast round-trip.
 */
import { expect, test, type Page } from '@playwright/test';

const DEMOS: Array<{ path: string; heading: RegExp; allow403?: boolean }> = [
  { path: '/chat-realtime/', heading: /Chat/ },
  { path: '/twitter-post/', heading: /Post/ },
  { path: '/03-mini-post/', heading: /Mini-post feed/ },
  // This demo deliberately fires the protected query without a token on load
  // (the whole point is showing ORBIT_PERMISSION_DENIED) — Chromium logs
  // those two 403 responses as console errors, which are expected.
  { path: '/04-mini-auth/', heading: /Mini-auth/, allow403: true },
  { path: '/05-orbit-vs-graphql/', heading: /Orbit vs GraphQL/ },
  { path: '/06-tiktok-feed/', heading: /TikTok/ },
  { path: '/07-react/', heading: /Orbit × React/ },
];

/** Collect browser console/page errors on a page as it loads. */
async function captureErrors(page: Page, allow403: boolean): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The mini-auth demo intentionally queries without a token at startup.
    if (allow403 && /Failed to load resource:.*403/.test(msg.text())) return;
    errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

for (const { path, heading, allow403 } of DEMOS) {
  test(`loads ${path} without console errors`, async ({ page }) => {
    const errors = await captureErrors(page, allow403 === true);
    await page.goto(path);
    await expect(page.locator('h1')).toHaveText(heading);
    // Give late module/fetch failures time to surface.
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
}

test('chat-realtime: a sent message returns over the WebSocket and renders', async ({ page }) => {
  const text = `e2e-${Date.now()}`;
  await page.goto('/chat-realtime/');
  // The subscription is live (the client reconnected/attached to /realtime).
  await expect(page.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });

  await page.locator('#name').fill('E2E');
  await page.locator('#text').fill(text);
  await page.locator('#send').click();

  // The mutation is broadcast as a WS event; the feed renders it.
  await expect(page.locator('#chat .message').filter({ hasText: text })).toBeVisible({
    timeout: 10_000,
  });
});

test('chat-realtime: the event reaches a second tab live (server broadcast)', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const pageA = await first.newPage();
  const pageB = await second.newPage();
  try {
    await pageA.goto('/chat-realtime/');
    await pageB.goto('/chat-realtime/');
    await expect(pageA.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });
    await expect(pageB.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });

    const text = `x-tab-${Date.now()}`;
    await pageA.locator('#text').fill(text);
    await pageA.locator('#send').click();

    // The same event lands in the OTHER tab — one server, live fan-out.
    await expect(pageB.locator('#chat .message').filter({ hasText: text })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await first.close();
    await second.close();
  }
});

test('tiktok-feed: a like mutates, returns over the WebSocket and re-renders the count', async ({
  page,
}) => {
  await page.goto('/06-tiktok-feed/');
  await expect(page.locator('h1')).toHaveText(/TikTok/);
  await expect(page.locator('.clip').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });

  const like = page.locator('.clip .like').first();
  await expect(like).toBeVisible();
  const before = Number((await like.textContent())?.match(/\d+/)?.[0]);
  await like.click();

  // The mutation is broadcast as a WS event; the card re-renders from it.
  await expect(like).toHaveText(new RegExp(`[♥♡] ${before + 1}`), { timeout: 10_000 });
});

test('tiktok-feed: a like in one tab updates the same card in another tab live', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const pageA = await first.newPage();
  const pageB = await second.newPage();
  try {
    await pageA.goto('/06-tiktok-feed/');
    await pageB.goto('/06-tiktok-feed/');
    await expect(pageA.locator('.clip').first()).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('.clip').first()).toBeVisible({ timeout: 10_000 });
    await expect(pageA.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });
    await expect(pageB.locator('#conn-pill')).toHaveClass(/live/, { timeout: 15_000 });

    const likeB = pageB.locator('.clip .like').first();
    const before = Number((await likeB.textContent())?.match(/\d+/)?.[0]);

    await pageA.locator('.clip .like').first().click();

    // The same event lands in the OTHER tab — one server, live fan-out.
    await expect(likeB).toHaveText(new RegExp(`[♥♡] ${before + 1}`), { timeout: 10_000 });
  } finally {
    await first.close();
    await second.close();
  }
});

test('react: the feed renders, a like round-trips over the WebSocket and the devtools opens', async ({
  page,
}) => {
  await page.goto('/07-react/');
  await expect(page.locator('h1')).toHaveText(/Orbit × React/);

  // The React tree mounted: feed cards + the live subscription badge.
  const feed = page.locator('[data-testid="react-feed"]');
  await expect(feed.locator('.clip').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="live-badge"]')).toContainText('live', {
    timeout: 15_000,
  });

  // A like goes through useOrbitMutation; the WS event re-renders the card.
  const like = feed.locator('.clip .like').first();
  const before = Number((await like.textContent())?.match(/\d+/)?.[0]);
  await like.click();
  await expect(like).toHaveText(new RegExp(`♥ ${before + 1}`), { timeout: 10_000 });

  // The cross-platform devtools: open the panel and see the cached query.
  await page.locator('[data-testid="orbit-devtools-toggle"]').click();
  const panel = page.locator('[data-testid="orbit-devtools-panel"]');
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(panel).toContainText('Orbit devtools');
  await expect(panel).toContainText(/clips \{/);
  // Both subscriptions share the clips query — the devtools dedupes by key.
  await expect(panel).toContainText(/Subscriptions \(1\)/);
});
