import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/index.js';

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const handlerOf =
  (respond: () => Response | Promise<Response>) =>
  async (_request: Request): Promise<Response> =>
    respond();

describe('createMetrics — snapshot shape', () => {
  it('starts at zero', () => {
    const metrics = createMetrics();
    const snap = metrics.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.byStatus).toEqual({});
    expect(snap.errors).toEqual({});
    expect(snap.cache).toEqual({ hits: 0, misses: 0 });
    expect(snap.rateLimited).toBe(0);
    expect(snap.duration.count).toBe(0);
  });

  it('reset() clears everything', async () => {
    const metrics = createMetrics();
    const ok = metrics.wrapHandler(handlerOf(() => jsonRes({ data: 1 })));
    await ok(new Request('http://x/orbit', { method: 'POST' }));
    const bad = metrics.wrapHandler(
      handlerOf(() => jsonRes({ error: { code: 'ORBIT_INTERNAL', message: 'x' } }, 500)),
    );
    await bad(new Request('http://x/orbit', { method: 'POST' }));
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.duration).toMatchObject({ count: 0, sum: 0, max: 0, p50: 0, p99: 0 });
    expect(snap.duration.buckets).toMatchObject({ '5': 0, '10': 0 });
  });
});

describe('createMetrics — wrapHandler', () => {
  it('counts requests by status and times them', async () => {
    let clock = 0;
    const metrics = createMetrics({ now: () => clock });
    const handler = metrics.wrapHandler(async (_request: Request) => {
      clock += 7;
      return jsonRes({ data: 1 });
    });
    await handler(new Request('http://x/orbit', { method: 'POST' }));
    await handler(new Request('http://x/orbit', { method: 'POST' }));

    const snap = metrics.snapshot();
    expect(snap.requests).toBe(2);
    expect(snap.byStatus[200]).toBe(2);
    expect(snap.duration.count).toBe(2);
    expect(snap.duration.sum).toBe(14);
    expect(snap.duration.max).toBe(7);
    expect(snap.duration.p99).toBe(7);
  });

  it('counts error codes from the wire shape without consuming the body', async () => {
    const metrics = createMetrics();
    const handler = metrics.wrapHandler(
      handlerOf(() => jsonRes({ error: { code: 'ORBIT_INVALID_QUERY', message: 'x' } }, 400)),
    );
    const res = await handler(new Request('http://x/orbit', { method: 'POST' }));
    // The caller's body must be intact.
    await expect(res.json()).resolves.toEqual({
      error: { code: 'ORBIT_INVALID_QUERY', message: 'x' },
    });

    const snap = metrics.snapshot();
    expect(snap.errors.ORBIT_INVALID_QUERY).toBe(1);
    expect(snap.byStatus[400]).toBe(1);
  });

  it('counts cache hits/misses from x-orbit-cache and rate-limited 429s', async () => {
    const metrics = createMetrics();
    let hit = false;
    const handler = metrics.wrapHandler(
      handlerOf(() =>
        hit
          ? jsonRes({ data: 1, fromCache: true }, 200, { 'x-orbit-cache': 'hit' })
          : jsonRes({ data: 1 }, 200, { 'x-orbit-cache': 'miss' }),
      ),
    );
    await handler(new Request('http://x/orbit', { method: 'POST' }));
    hit = true;
    await handler(new Request('http://x/orbit', { method: 'POST' }));

    const limited = metrics.wrapHandler(
      handlerOf(() => jsonRes({ error: { code: 'ORBIT_PERMISSION_DENIED', message: 'x' } }, 429)),
    );
    await limited(new Request('http://x/orbit', { method: 'POST' }));

    const snap = metrics.snapshot();
    expect(snap.cache).toEqual({ hits: 1, misses: 1 });
    expect(snap.rateLimited).toBe(1);
  });

  it('keeps only the recent window for percentiles (bounded memory)', async () => {
    let clock = 0;
    let step = 10;
    const metrics = createMetrics({ now: () => clock, window: 2 });
    const handler = metrics.wrapHandler(async (_request: Request) => {
      clock += step;
      step += 10;
      return jsonRes({ data: 1 });
    });
    await handler(new Request('http://x/orbit', { method: 'POST' })); // 10
    await handler(new Request('http://x/orbit', { method: 'POST' })); // 20
    await handler(new Request('http://x/orbit', { method: 'POST' })); // 30 — evicts the 10
    const snap = metrics.snapshot();
    expect(snap.duration.count).toBe(2); // only the recent window
    expect(snap.duration.p99).toBe(30);
    expect(snap.requests).toBe(3); // counters stay exact
  });

  it('buckets durations for histogram export', async () => {
    let clock = 0;
    const metrics = createMetrics({ now: () => clock, bucketsMs: [10, 100] });
    const handler = metrics.wrapHandler(async (_request: Request) => {
      clock += 50;
      return jsonRes({ data: 1 });
    });
    await handler(new Request('http://x/orbit', { method: 'POST' }));
    await handler(new Request('http://x/orbit', { method: 'POST' }));

    const snap = metrics.snapshot();
    expect(snap.duration.buckets).toEqual({ '10': 0, '100': 2 });
  });

  it('tolerates non-JSON error bodies (proxies) as unknown errors', async () => {
    const metrics = createMetrics();
    const handler = metrics.wrapHandler(
      handlerOf(() => new Response('<html>boom</html>', { status: 502 })),
    );
    await handler(new Request('http://x/orbit', { method: 'POST' }));
    const snap = metrics.snapshot();
    expect(snap.byStatus[502]).toBe(1);
    expect(snap.errors.unknown).toBe(1);
  });

  it('counts non-protocol JSON bodies and non-ORBIT codes as unknown errors', async () => {
    const metrics = createMetrics();
    const handler = metrics.wrapHandler(handlerOf(() => jsonRes({ data: 'not an error' }, 500)));
    await handler(new Request('http://x/orbit', { method: 'POST' }));
    const weird = metrics.wrapHandler(
      handlerOf(() => jsonRes({ error: { code: 'NOT_ORBIT', message: 'x' } }, 500)),
    );
    await weird(new Request('http://x/orbit', { method: 'POST' }));
    expect(metrics.snapshot().errors.unknown).toBe(2);
  });

  it('passes handler arguments through untouched', async () => {
    const metrics = createMetrics();
    const seen: unknown[] = [];
    const base = async (...args: unknown[]) => {
      seen.push(args);
      return jsonRes({ data: 1 });
    };
    const handler = metrics.wrapHandler(base as typeof base);
    const request = new Request('http://x/orbit', { method: 'POST' });
    await handler(request, { extra: 1 });
    expect(seen[0]).toEqual([request, { extra: 1 }]);
  });
});
