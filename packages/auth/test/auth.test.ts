import { ErrorCode, createOrbit, memoryAdapter, OrbitError } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import {
  apiKeyAuth,
  bearerAuth,
  createAuthPlugin,
  requireCaller,
  requireRole,
} from '../src/index.js';

interface User {
  id: string;
  name: string;
}

const users: User[] = [
  { id: '1', name: 'Ana' },
  { id: '2', name: 'Bruno' },
];

const ADMIN = { id: 'admin', role: 'admin' };
const MEMBER = { id: '1', role: 'member' };

const KEYS = { 'secret-admin': ADMIN, 'secret-member': MEMBER };

function headers(key: string) {
  return { headers: new Headers({ 'x-api-key': key }) };
}

describe('createAuthPlugin', () => {
  it('denies requests without credentials with ORBIT_PERMISSION_DENIED', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [createAuthPlugin({ authenticate: apiKeyAuth(KEYS) })],
    });
    await expect(orbit.execute({ query: 'user { name }' })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      status: 403,
    });
  });

  it('denies requests with an unknown key', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [createAuthPlugin({ authenticate: apiKeyAuth(KEYS) })],
    });
    await expect(orbit.execute({ query: 'user { name }' }, headers('nope'))).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
  });

  it('cannot resolve a prototype-named key from the API-key table', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [createAuthPlugin({ authenticate: apiKeyAuth(KEYS) })],
    });
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      await expect(orbit.execute({ query: 'user { name }' }, headers(key))).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_DENIED,
      });
    }
  });

  it('stamps ctx.state.caller so mutations see identity', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'todo',
          resolve: () => null,
          mutate: (_action, _args, ctx) => {
            const caller = requireCaller(ctx);
            requireRole(caller, 'admin');
            return { id: String(caller.id) };
          },
        },
      ]),
      plugins: [createAuthPlugin({ authenticate: apiKeyAuth(KEYS) })],
    });
    const result = await orbit.execute({ do: 'todo.create' }, headers('secret-admin'));
    expect(result).toMatchObject({ status: 200 });
    expect(result.data).toMatchObject({ success: true, id: 'admin' });
  });

  it('authorize gates query roots before adapters run', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [
        createAuthPlugin({
          authenticate: apiKeyAuth(KEYS),
          authorize: ({ parsed, caller }) => {
            if (parsed.entity === 'user' && caller.role !== 'admin') {
              throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admins only');
            }
          },
        }),
      ],
    });
    await expect(
      orbit.execute({ query: 'user { name }' }, headers('secret-admin')),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      orbit.execute({ query: 'user { name }' }, headers('secret-member')),
    ).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      message: 'Admins only',
    });
  });

  it('authorize also gates a mutation return re-query (no bypass)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => users,
          mutate: () => ({ id: '1' }),
        },
      ]),
      plugins: [
        createAuthPlugin({
          authenticate: apiKeyAuth(KEYS),
          authorize: ({ caller }) => {
            if (caller.role !== 'admin') {
              throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admins only');
            }
          },
        }),
      ],
    });
    await expect(
      orbit.execute({ do: 'user.update', return: 'user { name }' }, headers('secret-member')),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it('scope injects the caller id into filters', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
      ]),
      plugins: [
        createAuthPlugin({
          authenticate: apiKeyAuth(KEYS),
          scope: ({ filters, caller }) => ({ ...filters, id: String(caller.id) }),
        }),
      ],
    });
    const result = await orbit.execute({ query: 'user { name }' }, headers('secret-member'));
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('skips authenticate when a caller is already seeded (realtime session)', async () => {
    let calls = 0;
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [
        createAuthPlugin({
          authenticate: () => {
            calls += 1;
            return null;
          },
        }),
      ],
    });
    const result = await orbit.execute(
      { query: 'user { name }' },
      { state: { caller: { id: 'seeded', role: 'admin' } } },
    );
    expect(result.status).toBe(200);
    expect(calls).toBe(0);
  });
});

describe('bearerAuth', () => {
  it('extracts the Bearer token and maps it through verify', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [
        createAuthPlugin({
          authenticate: bearerAuth((token) => (token === 'tok-123' ? ADMIN : null)),
        }),
      ],
    });
    await expect(
      orbit.execute(
        { query: 'user { name }' },
        { headers: new Headers({ authorization: 'Bearer tok-123' }) },
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      orbit.execute(
        { query: 'user { name }' },
        { headers: new Headers({ authorization: 'Bearer bad' }) },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });
});

describe('helpers', () => {
  it('requireCaller throws when no caller is stamped', () => {
    expect(() => requireCaller({})).toThrowError('Authentication required');
  });

  it('requireCaller returns the caller when present', () => {
    const ctx = { state: { caller: ADMIN } };
    expect(requireCaller(ctx)).toBe(ADMIN);
  });

  it('requireRole allows a listed role and denies others', () => {
    expect(requireRole(ADMIN, 'admin')).toBe(ADMIN);
    expect(() => requireRole(ADMIN, 'member')).toThrowError('Missing required role: member');
  });
});
