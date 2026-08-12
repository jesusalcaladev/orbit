import { beforeEach, describe, expect, it } from 'vitest';
import { createOrbit, memoryAdapter } from '../src/index.js';
import { ErrorCode } from '../src/errors.js';

const users = [{ id: '1', name: 'Ana' }];

beforeEach(() => {
  users[0]!.name = 'Ana'; // mutation tests must not leak into others
});

function makeOrbit(overrides: Partial<Parameters<typeof createOrbit>[0]> = {}) {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => users.find((u) => u.id === id),
        mutate: (action, { payload }) => {
          if (action === 'update') Object.assign(users[0]!, payload ?? {});
          return { id: users[0]!.id, invalidates: ['cache:user:1'] };
        },
      },
    ]),
    ...overrides,
  });
}

function post(envelope: unknown): Request {
  return new Request('http://localhost/orbit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

describe('handler', () => {
  it('serves a query as JSON', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ data: { name: 'Ana' } });
  });

  it('serves mutations with data and invalidates', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      post({ do: 'user.update', args: { filter: { id: '1' }, payload: { name: 'Ana P.' } } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { success: true, id: '1' },
      invalidates: ['cache:user:1'],
    });
  });

  it('serves mutations with a return graph', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      post({
        do: 'user.update',
        args: { filter: { id: '1' }, payload: { name: 'Ana R.' } },
        return: 'user(id="1") { name }',
      }),
    );
    expect(await response.json()).toEqual({
      data: { name: 'Ana R.' },
      invalidates: ['cache:user:1'],
    });
  });

  it('returns structured errors with proper status codes', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'ghost { id }' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'ORBIT_ENTITY_UNREGISTERED',
        message: expect.stringContaining('ghost'),
        details: { entity: 'ghost' },
      },
    });
  });

  it('returns 400 for a syntax error', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ query: 'user(id="1' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('returns 400 for invalid envelopes', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(post({ nope: true }));
    expect(response.status).toBe(400);
  });

  it('returns 400 for non-JSON bodies', async () => {
    const orbit = makeOrbit();
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('returns 413 when the payload exceeds the limit', async () => {
    const orbit = makeOrbit({ maxPayloadBytes: 64 });
    const big = 'x'.repeat(200);
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `user(name="${big}")` }),
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('serves non-JSON payloads produced by plugins as-is', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: `name:${(data as { name: string }).name}`,
              contentType: 'text/csv',
            }),
          },
        },
      ],
    });
    const response = await orbit.handler(post({ query: 'user(id="1") { name }' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(await response.text()).toBe('name:Ana');
  });

  it('passes request headers through to plugins', async () => {
    const orbit = makeOrbit({
      plugins: [
        {
          name: 'header-check',
          hooks: {
            onBeforeResolve: ({ ctx }) => {
              if (ctx.headers?.get('x-debug') !== '1') {
                throw Object.assign(new Error('missing header'), { orbit: true });
              }
            },
          },
        },
      ],
    });
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debug': '1' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(200);
  });
});
