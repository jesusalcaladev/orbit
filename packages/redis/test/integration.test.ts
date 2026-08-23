import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisCacheStore, createRedisRateLimitStore } from '../src/index.js';

/**
 * Integration suite — runs ONLY against a real Redis server.
 *
 * Locally (no Redis) every test is skipped; in CI the workflow starts a
 * `redis:7` service and sets `REDIS_URI`. This is the smoke test the unit
 * suite cannot be: the Lua token-bucket script and the real key/TTL
 * semantics, exercised over an actual Redis connection, including the
 * multi-instance story (two independent clients sharing one server must
 * not double-spend a rate-limit token).
 *
 * Run locally with Docker:
 *   docker run -d -p 6379:6379 redis:7-alpine
 *   REDIS_URI=redis://localhost:6379 pnpm test
 */
const uri = process.env.REDIS_URI;
const d = it.skipIf(!uri);

describe.skipIf(!uri)('integration: real Redis', () => {
  let client: import('redis').RedisClientType;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const { createClient } = await import('redis');
    client = createClient({ url: uri }) as import('redis').RedisClientType;
    await client.connect();
    cleanup.push(async () => {
      await client.quit();
    });
  }, 15_000);

  afterAll(async () => {
    for (const fn of cleanup) await fn();
  });

  d('cache store round-trips across a second independent client', async () => {
    const { createClient } = await import('redis');
    const second = createClient({ url: uri });
    await second.connect();
    cleanup.push(async () => {
      await second.quit();
    });

    // node-redis v4's generic types don't match the structural contract
    // exactly (scanIterator yields batches) — the runtime API is compatible.
    const writer = createRedisCacheStore({
      client: client as unknown as Parameters<typeof createRedisCacheStore>[0]['client'],
      ttlSeconds: 60,
    });
    const reader = createRedisCacheStore({
      client: second as unknown as Parameters<typeof createRedisCacheStore>[0]['client'],
      ttlSeconds: 60,
    });

    const entry = { value: { v: 1 }, createdAt: Date.now(), query: 'user(id="1") { name }' };
    await writer.set('orbit:cache:user-1', entry);
    // The second "instance" reads the SAME bytes from the SAME server.
    await expect(reader.get('orbit:cache:user-1')).resolves.toEqual(entry);

    await writer.delete('orbit:cache:user-1');
    await expect(reader.get('orbit:cache:user-1')).resolves.toBeNull();
  });

  d('two instances sharing one Redis never double-spend a token', async () => {
    const { createClient } = await import('redis');
    const second = createClient({ url: uri });
    await second.connect();
    cleanup.push(async () => {
      await second.quit();
    });

    type RlOptions = Parameters<typeof createRedisRateLimitStore>[0];
    const params = { limit: 5, rate: 0.001, windowMs: 60_000 };
    const instanceA = createRedisRateLimitStore({
      client: client as unknown as RlOptions['client'],
    });
    const instanceB = createRedisRateLimitStore({
      client: second as unknown as RlOptions['client'],
    });

    let allowed = 0;
    let rejected = 0;
    // 20 consumes across two instances against a 5-token bucket: the atomic
    // Lua consume means exactly 5 pass and 15 bounce — no double-spending.
    for (let i = 0; i < 20; i += 1) {
      const store = i % 2 === 0 ? instanceA : instanceB;
      const result = await store.consume('shared-key', params, Date.now());
      if (result.ok) allowed += 1;
      else rejected += 1;
    }
    expect(allowed).toBe(5);
    expect(rejected).toBe(15);
  });

  d('server-side TTL expires cache entries', async () => {
    const store = createRedisCacheStore({
      client: client as unknown as Parameters<typeof createRedisCacheStore>[0]['client'],
      ttlSeconds: 1,
    });
    await store.set('orbit:cache:ttl-probe', {
      value: { v: 1 },
      createdAt: Date.now(),
      query: 'user { name }',
    });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(store.get('orbit:cache:ttl-probe')).resolves.toBeNull();
  });
});
