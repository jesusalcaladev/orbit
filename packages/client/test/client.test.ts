import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, OrbitError } from '@orbit/core';
import type { OrbitEnvelope } from '@orbit/core';
import { createClient, OrbitClient } from '../src/index.js';
import { jsonRes, mockFetch } from './helpers.js';

describe('OrbitClient API', () => {
  it('createClient returns an OrbitClient', () => {
    const client = createClient({ baseUrl: '/orbit' });
    expect(client).toBeInstanceOf(OrbitClient);
    expect(client.baseUrl).toBe('/orbit');
  });

  it('query sends a plain query envelope', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.query('user(id="1") { name }');
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual({
      query: 'user(id="1") { name }',
    });
  });

  it('mutate sends a do envelope with args and no return', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { success: true } }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.mutate('user.update', { filter: { id: '1' }, payload: { name: 'Ana' } });
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual({
      do: 'user.update',
      args: { filter: { id: '1' }, payload: { name: 'Ana' } },
    });
  });

  it('mutate merges options.return into the envelope as a re-query', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { name: 'Ana' } }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.mutate(
      'user.update',
      { filter: { id: '1' }, payload: { name: 'Ana' } },
      { return: 'user(id="1") { name }' },
    );
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual({
      do: 'user.update',
      args: { filter: { id: '1' }, payload: { name: 'Ana' } },
      return: 'user(id="1") { name }',
    });
  });

  it('execute merges options.cache into the envelope', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.execute({ query: 'user(id="1") { name }' }, { cache: 'ttl=300, stale=60' });
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual({
      query: 'user(id="1") { name }',
      cache: 'ttl=300, stale=60',
    });
  });

  it('execute passes the envelope through untouched without a cache option', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await client.execute({ do: 'user.update', args: {} });
    expect(JSON.parse(capture[0]!.init.body as string)).toEqual({
      do: 'user.update',
      args: {},
    });
  });

  it('fails fast on an invalid envelope before hitting the network', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });

    await expect(client.execute({})).rejects.toMatchObject({ code: ErrorCode.INVALID_QUERY });
    await expect(client.execute({ query: 'a', do: 'b.c' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_QUERY,
    });
    expect(capture).toHaveLength(0);
  });

  it('propagates a client-side validation failure as an OrbitError', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await client.execute({ query: 42 } as unknown as OrbitEnvelope);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      expect((error as OrbitError).status).toBe(400);
    }
  });

  it('resolves function headers per request', async () => {
    let token = 'token-1';
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: null }));
    const client = new OrbitClient({
      baseUrl: '/orbit',
      fetch: fetchImpl,
      headers: () => ({ 'x-orbit-token': token }),
    });
    await client.query('user { id }');
    expect(new Headers(capture[0]!.init.headers).get('x-orbit-token')).toBe('token-1');
    token = 'token-2';
    await client.query('user { id }');
    expect(new Headers(capture[1]!.init.headers).get('x-orbit-token')).toBe('token-2');
  });
});

describe('realtime URL derivation', () => {
  /** A WebSocket stub that records the URL it was constructed with. */
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static readonly OPEN = 1;
    readonly url: string;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string | URL) {
      this.url = String(url);
      FakeWebSocket.instances.push(this);
    }
    send(_data: Parameters<WebSocket['send']>[0]): void {}
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(_event: Event): boolean {
      return true;
    }
  }

  const fake = (): typeof WebSocket => FakeWebSocket as unknown as typeof WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('derives ws(s)://host/realtime from an http(s) baseUrl', () => {
    const wsClient = createClient({ baseUrl: 'http://localhost:4321/orbit', WebSocket: fake() });
    wsClient.subscribe('chat { id }', () => {});
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:4321/realtime');

    FakeWebSocket.instances = [];
    const wssClient = createClient({ baseUrl: 'https://api.example.com/orbit', WebSocket: fake() });
    wssClient.subscribe('chat { id }', () => {});
    expect(FakeWebSocket.instances[0]!.url).toBe('wss://api.example.com/realtime');
  });

  it('prefers an explicit realtimeUrl', () => {
    const client = createClient({
      baseUrl: 'http://localhost:4321/orbit',
      realtimeUrl: 'ws://realtime.internal:9000/custom',
      WebSocket: fake(),
    });
    client.subscribe('chat { id }', () => {});
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://realtime.internal:9000/custom');
  });

  it('derives from location.origin for a relative baseUrl', () => {
    const original = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: 'http://localhost:4321' };
    try {
      const client = createClient({ baseUrl: '/orbit', WebSocket: fake() });
      client.subscribe('chat { id }', () => {});
      expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:4321/realtime');
    } finally {
      if (original === undefined) delete (globalThis as { location?: unknown }).location;
      else (globalThis as { location?: unknown }).location = original;
    }
  });

  it('fails fast for a relative baseUrl without a WebSocket origin', () => {
    const client = createClient({ baseUrl: '/orbit', WebSocket: fake() });
    expect(() => client.subscribe('chat { id }', () => {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    // HTTP-only use is unaffected — the URL is resolved lazily.
    expect(() => createClient({ baseUrl: '/orbit' })).not.toThrow();
  });
});
