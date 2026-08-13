/**
 * Direct tests for the shared realtime session driver (`realtime/driver.ts`).
 *
 * The driver is the single home of the frame-level protocol (spec §10):
 * subscribe/ack, unsubscribe, resume replay, and `{ query }` / `{ do }`
 * envelope request/response. Both transports — the Node one (`server.ts`)
 * and the Cloudflare Workers one (`@orbit/cloudflare-workers`) — delegate
 * here, so these tests pin the contract in isolation with a plain `send`
 * callback. Transport-specific behavior (frame encoding, heartbeats,
 * retention, socket APIs) is covered by their own suites.
 */
import { describe, expect, it } from 'vitest';
import { createOrbit, createSessionDriver, memoryAdapter } from '../src/index.js';
import { SubscriptionHub } from '../src/index.js';
import type { SubscriptionEvent } from '../src/types.js';

function makeWorld() {
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const orbit = createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'post',
        resolve: () => [],
        mutate: (_action, args) => {
          const payload = args.payload as { id: string };
          const event: SubscriptionEvent = { type: 'created', id: payload.id, data: payload };
          for (const handler of handlers) handler(event);
          return { id: payload.id };
        },
        subscribe: (_filters, handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
    ]),
  });
  return { orbit, handlers };
}

/** Collect the frames a driver sends and drive it with a fake transport. */
function makeSession(orbit: ReturnType<typeof makeWorld>['orbit']) {
  const sent: Array<Record<string, unknown>> = [];
  const hub = new SubscriptionHub(orbit);
  const driver = createSessionDriver(orbit, hub, (message) => sent.push(message));
  return {
    driver,
    hub,
    sent,
    last: () => sent[sent.length - 1],
  };
}

describe('createSessionDriver — the shared frame contract (spec §10)', () => {
  it('acks subscriptions and delivers events with per-subscription seq', async () => {
    const { orbit, handlers } = makeWorld();
    const { driver, sent } = makeSession(orbit);

    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    expect(sent).toContainEqual({ ack: 's1' });

    for (const handler of handlers) handler({ type: 'created', id: 'p1', data: { id: 'p1' } });
    expect(sent.at(-1)).toEqual({
      id: 's1',
      seq: 1,
      event: { type: 'created', id: 'p1', data: { id: 'p1' } },
    });
  });

  it('rejects a duplicate subscription on the same connection', async () => {
    const { orbit } = makeWorld();
    const { driver } = makeSession(orbit);
    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    await expect(driver.dispatch({ subscribe: 'post { id }', id: 's1' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('unsubscribes and releases the adapter hook', async () => {
    const { orbit, handlers } = makeWorld();
    const { driver, sent } = makeSession(orbit);

    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    expect(handlers.size).toBe(1);
    await driver.dispatch({ unsubscribe: 's1' });
    expect(sent).toContainEqual({ unsubscribed: 's1' });
    expect(handlers.size).toBe(0);
  });

  it('replays the gap on resume within the connection', async () => {
    const { orbit, handlers } = makeWorld();
    const { driver, sent } = makeSession(orbit);

    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    for (const handler of handlers) handler({ type: 'created', id: 'p1', data: { id: 'p1' } });
    for (const handler of handlers) handler({ type: 'created', id: 'p2', data: { id: 'p2' } });

    await driver.dispatch({ resume: 's1', after: 1 });
    expect(sent.at(-1)).toEqual({ resumed: 's1', after: 1 });
    const replayed = sent.filter((f) => f.id === 's1' && f.event !== undefined);
    expect(replayed.at(-1)).toEqual({
      id: 's1',
      seq: 2,
      event: { type: 'created', id: 'p2', data: { id: 'p2' } },
    });
  });

  it('answers envelope requests with the echoed correlation id', async () => {
    const { orbit } = makeWorld();
    const { driver, sent } = makeSession(orbit);

    await driver.dispatch({ query: 'post { id }', id: 'q1' });
    expect(sent.at(-1)).toMatchObject({ id: 'q1', status: 200, data: [] });
  });

  it('executes mutations and echoes the id on failure too', async () => {
    const { orbit } = makeWorld();
    const { driver, sent } = makeSession(orbit);

    await driver.dispatch({ do: 'post.create', args: { payload: { id: 'p9' } }, id: 'm1' });
    expect(sent.at(-1)).toMatchObject({ id: 'm1', status: 200, data: { success: true, id: 'p9' } });

    // Invalid envelope (both query and do) → 400 with the id echoed.
    await driver.dispatch({ query: 'post { id }', do: 'post.create', id: 'b1' });
    expect(sent.at(-1)).toMatchObject({
      id: 'b1',
      status: 400,
      error: { code: 'ORBIT_INVALID_QUERY' },
    });
  });

  it('throws on unknown control frames (transport sends the error frame)', async () => {
    const { orbit } = makeWorld();
    const { driver } = makeSession(orbit);
    await expect(driver.dispatch({ teleport: 'nowhere' })).rejects.toThrow(/subscribe/);
  });

  it('releaseAll unsubscribes everything immediately (no retention)', async () => {
    const { orbit, handlers } = makeWorld();
    const { driver } = makeSession(orbit);

    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    await driver.dispatch({ subscribe: 'post { id }', id: 's2' });
    expect(handlers.size).toBe(1); // shared adapter hook

    driver.releaseAll();
    expect(handlers.size).toBe(0);
    expect(driver.activeIds()).toEqual([]);
  });

  it('calls onAttach when a subscription is (re)attached', async () => {
    const { orbit } = makeWorld();
    const attached: string[] = [];
    const hub = new SubscriptionHub(orbit);
    const driver = createSessionDriver(orbit, hub, () => {}, {
      onAttach: (clientId) => attached.push(clientId),
    });

    await driver.dispatch({ subscribe: 'post { id }', id: 's1' });
    expect(attached).toEqual(['s1']);
    // Resume of a live subscription also counts as an attach.
    await driver.dispatch({ resume: 's1', after: 0 });
    expect(attached).toEqual(['s1']);
  });
});
