import { ErrorCode, createOrbit } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { restAdapter } from '../src/index.js';

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

/** Build a mock fetch that records calls and answers from a route map. */
function mockFetch(routes: Map<string, unknown>, calls: FetchCall[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = routes.get(url) ?? routes.get('*');
    if (route instanceof Error) throw route;
    if (route === undefined) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('restAdapter.resolve', () => {
  it('hits GET /path/:id when an id filter is present', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      fetchFn: mockFetch(
        new Map([['https://api.example.com/v1/user/42', { id: '42', name: 'Ada' }]]),
        calls,
      ),
    });

    const result = await adapter.resolve({ id: '42' }, {});
    expect(result).toEqual({ id: '42', name: 'Ada' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/user/42');
    expect(calls[0]?.method).toBe('GET');
  });

  it('sends filters as query parameters when there is no id', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      path: 'users',
      fetchFn: mockFetch(
        new Map([['https://api.example.com/v1/users?role=admin', [{ id: '1' }, { id: '2' }]]]),
        calls,
      ),
    });

    const result = await adapter.resolve({ role: 'admin' }, {});
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/users?role=admin');
  });

  it('returns null on upstream 404 (no record)', async () => {
    const fetchFn = async () => new Response('{"message":"nope"}', { status: 404 });
    const adapter = restAdapter({ entity: 'user', baseUrl: 'https://api.example.com', fetchFn });
    expect(await adapter.resolve({ id: 'missing' }, {})).toBeNull();
  });

  it('throws INTERNAL on upstream 5xx (status preserved)', async () => {
    const fetchFn = async () => new Response('boom', { status: 500 });
    const adapter = restAdapter({ entity: 'user', baseUrl: 'https://api.example.com', fetchFn });
    await expect(adapter.resolve({}, {})).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      status: 500,
    });
  });

  it('maps upstream 401/403 to PERMISSION_DENIED (status preserved)', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: async () => new Response('nope', { status: 401 }),
    });
    await expect(adapter.resolve({}, {})).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      status: 401,
    });
    const forbidden = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: async () => new Response('nope', { status: 403 }),
    });
    await expect(forbidden.resolve({}, {})).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      status: 403,
    });
  });

  it('passes the upstream status through on other 4xx (no flattening to 400)', async () => {
    const fetchFn = async () => new Response('slow down', { status: 429 });
    const adapter = restAdapter({ entity: 'user', baseUrl: 'https://api.example.com', fetchFn });
    await expect(adapter.resolve({}, {})).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      status: 429,
    });
  });

  it('injects the parent id through parentKey while resolving a relation', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'post',
      baseUrl: 'https://api.example.com/v1',
      parentKey: 'authorId',
      fetchFn: mockFetch(
        new Map([['https://api.example.com/v1/post?authorId=7', [{ id: 'p1' }]]]),
        calls,
      ),
    });

    const result = await adapter.resolve({}, { parent: { entity: 'user', data: { id: 7 } } });
    expect(result).toEqual([{ id: 'p1' }]);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/post?authorId=7');
  });

  it('skips the parent key when the parent record carries no id', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'post',
      baseUrl: 'https://api.example.com/v1',
      parentKey: 'authorId',
      fetchFn: mockFetch(new Map([['https://api.example.com/v1/post', [{ id: 'p1' }]]]), calls),
    });

    const result = await adapter.resolve({}, { parent: { entity: 'user', data: { name: 'Ada' } } });
    expect(result).toEqual([{ id: 'p1' }]);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/post');
  });

  it('resolves headers as a function (e.g. a live auth token)', async () => {
    const seen: Record<string, string> = {};
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      headers: () => ({ authorization: 'Bearer live-token' }),
      fetchFn: async (_input, init) => {
        Object.assign(seen, init?.headers);
        return new Response('{"id":"1"}', { status: 200 });
      },
    });

    await adapter.resolve({ id: '1' }, {});
    expect(seen.authorization).toBe('Bearer live-token');
  });

  it('maps upstream 400/422 to FILTER_INVALID (status preserved)', async () => {
    for (const status of [400, 422]) {
      const adapter = restAdapter({
        entity: 'user',
        baseUrl: 'https://api.example.com',
        fetchFn: async () => new Response('bad', { status }),
      });
      await expect(adapter.resolve({}, {})).rejects.toMatchObject({
        code: ErrorCode.FILTER_INVALID,
        status,
      });
    }
  });

  it('applies unwrap to the response body', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      unwrap: (json) => (json as { data: unknown }).data,
      fetchFn: mockFetch(
        new Map([
          ['https://api.example.com/user?q=1', { data: [{ id: '1' }], meta: { total: 1 } }],
        ]),
        [],
      ),
    });
    expect(await adapter.resolve({ q: '1' }, {})).toEqual([{ id: '1' }]);
  });

  it('degrades a non-JSON 200 body to undefined (resolve)', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: async () => new Response('<html>oops</html>', { status: 200 }),
    });
    // A 200 with an unparseable body is a miss-shaped payload — the adapter
    // does not invent data, it resolves to undefined (projected to null-ish).
    await expect(adapter.resolve({}, {})).resolves.toBeUndefined();
  });
});

describe('restAdapter.mutate', () => {
  it('create → POST with the payload as body', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      fetchFn: mockFetch(
        new Map([['https://api.example.com/v1/user', { id: 'new-1', name: 'Ada' }]]),
        calls,
      ),
    });

    const result = await adapter.mutate!('user.create', { payload: { name: 'Ada' } }, {});
    expect(result).toMatchObject({ id: 'new-1', name: 'Ada' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{"name":"Ada"}');
  });

  it('update → PATCH /:id with the payload as body', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      fetchFn: mockFetch(
        new Map([['https://api.example.com/v1/user/42', { id: '42', name: 'Grace' }]]),
        calls,
      ),
    });

    const result = await adapter.mutate!(
      'user.update',
      { filter: { id: '42' }, payload: { name: 'Grace' } },
      {},
    );
    expect(result).toMatchObject({ id: '42' });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://api.example.com/v1/user/42');
  });

  it('delete → DELETE /:id without a body', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      fetchFn: mockFetch(new Map([['https://api.example.com/v1/user/42', { ok: true }]]), calls),
    });

    const result = await adapter.mutate!('user.delete', { filter: { id: '42' } }, {});
    expect(result).toMatchObject({ id: '42' });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('supports custom action mappings', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      mutations: { archive: { method: 'PUT', path: 'users/archive' } },
      fetchFn: mockFetch(new Map([['https://api.example.com/users/archive', { id: '42' }]]), calls),
    });

    const result = await adapter.mutate!('user.archive', { filter: { id: '42' } }, {});
    expect(result).toMatchObject({ id: '42' });
    expect(calls[0]?.method).toBe('PUT');
  });

  it('rejects unknown actions with MUTATION_FAILED', async () => {
    const adapter = restAdapter({ entity: 'user', baseUrl: 'https://api.example.com' });
    await expect(adapter.mutate!('user.explode', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('rejects a payload on a GET/DELETE mutation instead of dropping it silently', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      mutations: { touch: { method: 'GET' } },
      fetchFn: mockFetch(new Map(), calls),
    });
    await expect(
      adapter.mutate!('user.touch', { filter: { id: '42' }, payload: { name: 'Ada' } }, {}),
    ).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
      message: expect.stringContaining('GET'),
    });
    // The payload is not silently dropped: no request ever goes out.
    expect(calls).toHaveLength(0);
    // DELETE with a payload is equally rejected.
    await expect(
      adapter.mutate!('user.delete', { filter: { id: '42' }, payload: { reason: 'x' } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
    // Without a payload, DELETE still works (regression guard).
    await expect(
      adapter.mutate!('user.delete', { filter: { id: '42' } }, {}),
    ).resolves.toMatchObject({ id: '42' });
  });

  it('throws MUTATION_FAILED on upstream failure (status preserved)', async () => {
    const fetchFn = async () => new Response('teapot', { status: 418 });
    const adapter = restAdapter({ entity: 'user', baseUrl: 'https://api.example.com', fetchFn });
    await expect(adapter.mutate!('user.create', { payload: {} }, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
      status: 418,
    });
  });

  it('accepts a bare action name (no entity prefix) on direct calls', async () => {
    const calls: FetchCall[] = [];
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: mockFetch(new Map([['https://api.example.com/user', { id: '1' }]]), calls),
    });
    // The engine always passes `entity.action`; the adapter tolerates a bare
    // verb too, splitting only when a dot is present.
    const result = await adapter.mutate!('create', { payload: { name: 'Ada' } }, {});
    expect(result).toMatchObject({ id: '1' });
    expect(calls[0]?.method).toBe('POST');
  });

  it('applies unwrap to mutation responses', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      unwrap: (json) => (json as { data: unknown }).data,
      fetchFn: mockFetch(
        new Map([['https://api.example.com/user', { data: { id: 'x', name: 'Ada' } }]]),
        [],
      ),
    });
    const result = await adapter.mutate!('user.create', { payload: { name: 'Ada' } }, {});
    expect(result).toMatchObject({ id: 'x', name: 'Ada' });
  });

  it('returns only the id when the mutation response is not an object', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: mockFetch(new Map([['https://api.example.com/user', [1, 2, 3]]]), []),
    });
    // A bare array/primitive response carries no fields to merge — the id
    // from the request filter is preserved and nothing is invented.
    const result = await adapter.mutate!('user.create', { filter: { id: '42' } }, {});
    expect(result).toEqual({ id: '42' });
  });

  it('degrades a non-JSON 200 body to just the id (mutate)', async () => {
    const adapter = restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com',
      fetchFn: async () => new Response('not json at all', { status: 200 }),
    });
    const result = await adapter.mutate!('user.create', { filter: { id: '9' } }, {});
    expect(result).toEqual({ id: '9' });
  });
});

describe('restAdapter end-to-end through createOrbit', () => {
  it('serves a real OQS query through a mocked REST backend', async () => {
    const calls: FetchCall[] = [];
    const orbit = createOrbit({
      adapters: [
        restAdapter({
          entity: 'users',
          baseUrl: 'https://api.example.com/v1',
          fetchFn: mockFetch(
            new Map([
              [
                'https://api.example.com/v1/users?role=admin',
                [
                  { id: '1', name: 'Ada' },
                  { id: '2', name: 'Grace' },
                ],
              ],
            ]),
            calls,
          ),
        }),
      ],
    });

    const result = await orbit.execute({ query: 'users(role="admin") { id, name }' });
    expect(result.status).toBe(200);
    expect(result.data).toEqual([
      { id: '1', name: 'Ada' },
      { id: '2', name: 'Grace' },
    ]);
    expect(calls).toHaveLength(1);
  });
});
