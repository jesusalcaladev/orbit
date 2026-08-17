import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ErrorCode, OrbitError } from '@orbit/core';
import { OrbitProvider } from '../src/provider.js';
import { DevtoolsStore } from '../src/devtools/store.js';
import { OrbitDevtools, webPrimitives } from '../src/devtools/ui.js';
import type { DevtoolsPrimitives } from '../src/devtools/ui.js';
import type { OrbitReactClient } from '../src/client.js';
import { fakeTransport, okResponse, reactClientOf } from './helpers.js';

function wrap(client: OrbitReactClient) {
  return ({ children }: { children: ReactNode }) => (
    <OrbitProvider client={client}>{children}</OrbitProvider>
  );
}

describe('DevtoolsStore', () => {
  it('builds a stable snapshot of queries, subscriptions, events and stats', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ id: 'p1', title: 'Hello' }, { fromCache: true }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['posts'], 'posts { id, title }');
    client.trackSubscription(['chat'], 'chat { id }', 7, 'live');

    const store = new DevtoolsStore(client);
    const snapshot = store.getSnapshot();
    expect(snapshot.stats.entries).toBe(1);
    expect(snapshot.queries).toHaveLength(1);
    expect(snapshot.queries[0]).toMatchObject({
      key: ['posts'],
      query: 'posts { id, title }',
      status: 'fresh',
      fromCache: true,
    });
    expect(snapshot.queries[0]!.dataPreview).toContain('Hello');
    expect(snapshot.subscriptions).toEqual([{ key: ['chat'], query: 'chat { id }', seq: 7, status: 'live' }]);
    expect(snapshot.events.length).toBeGreaterThan(0);
    store.close();
  });

  it('notifies subscribers on cache changes with a new snapshot reference', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    const store = new DevtoolsStore(client);
    const first = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    await client.ensureQuery(['u'], 'user { n }');
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(first);
    const unsub = store.subscribe(vi.fn());
    unsub();
    store.close();
  });

  it('marks stale, loading and error rows', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { n }', { ttl: 60_000 });
    const cacheKey = client.cacheKeyOf(['u'], 'user { n }');
    const entry = client.cache.stateOf(cacheKey).entry;
    entry!.expiresAt = Date.now() - 1;
    let store = new DevtoolsStore(client);
    expect(store.getSnapshot().queries[0]?.status).toBe('stale');

    entry!.expiresAt = Date.now() + 60_000;
    client.cache.setActivity(cacheKey, 'fetching');
    store = new DevtoolsStore(client);
    expect(store.getSnapshot().queries[0]?.status).toBe('loading');
    store.close();

    // An error-only key (failed query, no entry) renders an error row.
    const failing = fakeTransport();
    failing.transport.query.mockRejectedValue(new OrbitError(ErrorCode.INTERNAL, 'boom'));
    const failingClient = reactClientOf(failing.transport);
    await failingClient.ensureQuery(['e'], 'err { x }');
    const failingStore = new DevtoolsStore(failingClient);
    const rows = failingStore.getSnapshot().queries;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.errorMessage).toBe('boom');
    expect(rows[0]?.hasData).toBe(false);
    failingStore.close();
  });

  it('falls back to String() for non-serializable data in the preview', () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    const cacheKey = client.cacheKeyOf(['c'], 'c { x }');
    client.cache.describe(cacheKey, ['c'], 'c { x }');
    client.cache.set(cacheKey, {
      key: ['c'],
      query: 'c { x }',
      data: circular,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1_000,
      staleAt: Date.now() + 2_000,
      fromCache: false,
      entities: ['c'],
    });
    const store = new DevtoolsStore(client);
    expect(store.getSnapshot().queries[0]?.dataPreview).toBe(String(circular));
    store.close();
  });

  it('skips keys without key/query metadata (describe-less slots)', () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    // cache.set() alone never stamps key/query metadata.
    client.cache.set(client.cacheKeyOf(['ghost'], 'q'), {
      key: ['ghost'],
      query: 'q',
      data: { n: 1 },
      createdAt: Date.now(),
      expiresAt: Date.now() + 1_000,
      staleAt: Date.now() + 2_000,
      fromCache: false,
      entities: [],
    });
    const store = new DevtoolsStore(client);
    const snapshot = store.getSnapshot();
    expect(snapshot.stats.entries).toBe(1); // cached, but not displayable
    expect(snapshot.queries).toHaveLength(0);
    store.close();
  });

  it('skips entry-less states that are not in flight', () => {
    const { transport } = fakeTransport();
    const client = reactClientOf(transport);
    client.cache.describe(client.cacheKeyOf('ghost', 'q'), 'ghost', 'q');
    const store = new DevtoolsStore(client);
    expect(store.getSnapshot().queries).toHaveLength(0);
    store.close();
  });

  it('exposes refetch/invalidate/clear actions', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    const store = new DevtoolsStore(client);
    store.refetch(['u'], 'user { n }');
    await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(1));
    store.invalidate(['u']);
    expect(client.getQueryData(['u'])).toBeUndefined();
    await client.ensureQuery(['u'], 'user { n }');
    store.clear();
    expect(client.cache.entries()).toHaveLength(0);
    store.close();
  });
});

describe('OrbitDevtools (web primitives)', () => {
  async function renderPanel(client: OrbitReactClient, props: Record<string, unknown> = {}) {
    const utils = render(
      <OrbitProvider client={client}>
        <OrbitDevtools client={client} {...props} />
      </OrbitProvider>,
    );
    return utils;
  }

  it('shows a cached query with its status and data preview', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ id: 'p1', title: 'Hello world' }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['posts'], 'posts { id, title }');

    renderPanel(client);
    const panel = screen.getByTestId('orbit-devtools');
    expect(panel).toBeDefined();
    expect(screen.getByText(/Orbit devtools/)).toBeDefined();
    expect(screen.getByText('["posts"]')).toBeDefined();
    expect(screen.getByText('fresh')).toBeDefined();
    expect(screen.getByText('posts { id, title }')).toBeDefined();
    expect(screen.getByText(/Hello world/)).toBeDefined();
  });

  it('renders stale and loading chips with compact TTLs and server-cache meta', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }, { fromCache: true }));
    const client = reactClientOf(transport, { defaultTtl: 500, defaultStale: 500 });
    await client.ensureQuery(['u'], 'user { n }');
    const cacheKey = client.cacheKeyOf(['u'], 'user { n }');
    client.cache.stateOf(cacheKey).entry!.expiresAt = Date.now() - 1; // stale

    renderPanel(client);
    expect(screen.getByText('stale')).toBeDefined();
    expect(screen.getByText(/ttl · server-cached/)).toBeDefined();
    expect(screen.getByText(/0ms ttl/)).toBeDefined();
  });

  it('renders a loading chip while a fetch is in flight', async () => {
    const { transport } = fakeTransport();
    let releaseFetch: (() => void) | undefined;
    transport.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve(okResponse({ n: 1 }));
        }),
    );
    const client = reactClientOf(transport);
    void client.ensureQuery(['u'], 'user { n }');
    await vi.waitFor(() => expect(releaseFetch).toBeDefined());

    renderPanel(client);
    expect(screen.getByText('loading')).toBeDefined();
    act(() => releaseFetch!());
    await waitFor(() => expect(screen.getByText('fresh')).toBeDefined());
  });

  it('renders every activity event type in the feed', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    transport.mutate.mockResolvedValue(okResponse({ ok: true }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { n }');
    await client.mutate('x.y', {});
    client.logEvent({ type: 'subscription', key: ['s'], query: 's { id }', at: Date.now(), detail: 'live' });
    client.logEvent({ type: 'stream', key: ['t'], query: 't { x }', at: Date.now(), detail: 'level 0' });
    client.logEvent({ type: 'invalidate', at: Date.now(), key: ['u'] });
    client.logEvent({ type: 'setData', at: Date.now() });
    client.logEvent({ type: 'clear', at: Date.now() });
    client.logEvent({ type: 'hydrate', at: Date.now() });

    renderPanel(client);
    fireEvent.click(screen.getByText(/Activity/));
    for (const type of ['query', 'mutation', 'subscription', 'stream', 'invalidate', 'setData', 'clear', 'hydrate']) {
      expect(screen.getAllByText(type).length).toBeGreaterThan(0);
    }
  });

  it('refetches every query from the footer', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['a'], 'a { n }');
    await client.ensureQuery(['b'], 'b { n }');

    renderPanel(client);
    fireEvent.click(screen.getByText('⟳ refetch all'));
    await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(4));
  });

  it('shows empty states per tab and switches tabs', async () => {
    const client = reactClientOf(fakeTransport().transport);
    renderPanel(client);
    expect(screen.getByText(/No cached queries yet/)).toBeDefined();

    fireEvent.click(screen.getByText(/Subscriptions \(0\)/));
    expect(screen.getByText('No active subscriptions.')).toBeDefined();

    fireEvent.click(screen.getByText(/Activity \(0\)/));
    expect(screen.getByText(/Nothing yet/)).toBeDefined();

    // Back to the queries tab.
    fireEvent.click(screen.getByText(/Queries \(0\)/));
    expect(screen.getByText(/No cached queries yet/)).toBeDefined();
  });

  it('formats string keys without JSON (devtools display)', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery('u', 'user { n }');

    renderPanel(client);
    expect(screen.getByText('u')).toBeDefined();
    expect(screen.queryByText('"u"')).toBeNull();
  });

  it('invalidates and refetches from the row actions', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { n }');

    renderPanel(client);
    const row = screen.getByTestId(`query-${client.cacheKeyOf(['u'], 'user { n }')}`);
    expect(row).toBeDefined();

    fireEvent.click(screen.getAllByText('✕')[0]!);
    expect(client.getQueryData(['u'])).toBeUndefined();
    await waitFor(() => expect(screen.getByText(/No cached queries yet/)).toBeDefined());
  });

  it('refetches a row from the panel action', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { n }');

    renderPanel(client);
    fireEvent.click(screen.getAllByText('⟳')[0]!);
    await vi.waitFor(() => expect(transport.query).toHaveBeenCalledTimes(2));
  });

  it('clears the cache from the footer and closes via the backdrop', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { n }');

    renderPanel(client);
    fireEvent.click(screen.getByText('✕ clear cache'));
    expect(client.cache.entries()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('orbit-devtools-backdrop'));
    expect(screen.getByTestId('orbit-devtools-toggle')).toBeDefined();
    fireEvent.click(screen.getByText('🔮 Orbit'));
    expect(screen.getByTestId('orbit-devtools')).toBeDefined();
  });

  it('renders the toggle when initialOpen is false and the header close works', () => {
    const client = reactClientOf(fakeTransport().transport);
    renderPanel(client, { initialOpen: false });
    expect(screen.getByTestId('orbit-devtools-toggle')).toBeDefined();
    expect(screen.queryByTestId('orbit-devtools')).toBeNull();
    fireEvent.click(screen.getByText('🔮 Orbit'));
    expect(screen.getByTestId('orbit-devtools')).toBeDefined();
    fireEvent.click(screen.getByText('close'));
    expect(screen.getByTestId('orbit-devtools-toggle')).toBeDefined();
  });

  it('shows an error row for failed queries and renders the activity feed', async () => {
    const { transport } = fakeTransport();
    transport.query.mockRejectedValue(new OrbitError(ErrorCode.INTERNAL, 'kaboom'));
    const client = reactClientOf(transport);
    await client.ensureQuery(['e'], 'err { x }');

    renderPanel(client);
    expect(screen.getByText('error')).toBeDefined();
    expect(screen.getByText('kaboom')).toBeDefined();

    fireEvent.click(screen.getByText(/Activity/));
    expect(screen.getAllByText('query').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/kaboom/).length).toBeGreaterThan(0);
  });

  it('renders the subscriptions tab with tracked subscriptions', async () => {
    const client = reactClientOf(fakeTransport().transport);
    client.trackSubscription(['chat'], 'chat { id }', 2, 'live');
    renderPanel(client);
    fireEvent.click(screen.getByText(/Subscriptions \(1\)/));
    expect(screen.getByText('["chat"]')).toBeDefined();
    expect(screen.getByText('seq 2')).toBeDefined();
  });

  it('renders through injected (React Native) primitives', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ n: 1 }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['rn'], 'rn { n }');

    // A fake RN-ish primitive set — same component tree, different leaves.
    const rnPrimitives: DevtoolsPrimitives = {
      View: ({ style, children, testID, onPress }) => (
        <div data-testid={testID} data-rn data-onpress={onPress ? 'yes' : undefined} style={style as never}>
          {children}
        </div>
      ),
      Text: ({ style, children }) => <span data-rn-text style={style as never}>{children}</span>,
      Button: ({ title, onPress, style }) => (
        <button type="button" data-rn-btn onClick={onPress} style={style as never}>
          {title}
        </button>
      ),
      ScrollView: ({ style, children, testID }) => (
        <div data-testid={testID} data-rn-scroll style={style as never}>
          {children}
        </div>
      ),
    };
    renderPanel(client, { primitives: rnPrimitives });
    expect(screen.getByTestId('orbit-devtools').getAttribute('data-rn')).toBeDefined();
    expect(screen.getByText('["rn"]')).toBeDefined();
    // Interactive leaves receive onPress on the RN path too.
    expect(screen.getAllByText('✕')[0]!.closest('button')?.getAttribute('data-rn-btn')).toBeDefined();
  });

  it('supports the bottom-left position for the toggle', () => {
    const client = reactClientOf(fakeTransport().transport);
    renderPanel(client, { initialOpen: false, position: 'bottom-left' });
    const toggle = screen.getByTestId('orbit-devtools-toggle');
    expect(toggle.style.left).toBe('24px');
    expect(toggle.style.right).toBe('');
  });

  it('webPrimitives export exists', () => {
    expect(webPrimitives.View).toBeDefined();
    expect(webPrimitives.Text).toBeDefined();
    expect(webPrimitives.Button).toBeDefined();
    expect(webPrimitives.ScrollView).toBeDefined();
  });
});
