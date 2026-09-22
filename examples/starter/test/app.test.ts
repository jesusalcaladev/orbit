/**
 * The starter's test suite — no HTTP, no sockets, no fixtures to boot.
 *
 * Because `createApp()` is a plain function, tests drive the whole protocol
 * (parse → policy → adapters → cache) through `orbit.execute()` in-process.
 * Run:  pnpm run test:starter   (Node ≥ 22.18, same as every example)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode, OrbitError } from '@orbit/core';
import { createApp } from '../src/app.ts';
import type { Caller } from '../src/plugins/authz.ts';

const ADMIN: Caller = { id: '1', name: 'Ana', role: 'admin' };

function isOrbitErrorWith(code: string) {
  return (error: unknown): boolean => error instanceof OrbitError && error.code === code;
}

describe('starter app', () => {
  it('resolves a relational graph through the engine', async () => {
    const orbit = createApp();
    const result = await orbit.execute(
      { query: 'user(id="1") { name, role, posts(status="published") { title, views } }' },
      { state: { caller: ADMIN } },
    );
    assert.deepEqual(result.data, {
      name: 'Ana',
      role: 'admin',
      posts: [{ title: 'Why Orbit?', views: 1200 }],
    });
  });

  it('denies identity reads without a caller', async () => {
    const orbit = createApp();
    await assert.rejects(
      () => orbit.execute({ query: 'user { id, name }' }),
      isOrbitErrorWith(ErrorCode.PERMISSION_DENIED),
    );
  });

  it('runs an authenticated mutation and echoes invalidates', async () => {
    const orbit = createApp();
    const result = await orbit.execute(
      { do: 'posts.create', args: { payload: { title: 'Test-driven starter' } } },
      { state: { caller: ADMIN } },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.invalidates, ['posts']);
  });

  it('rejects unauthenticated writes with the standard contract', async () => {
    const orbit = createApp();
    await assert.rejects(
      () => orbit.execute({ do: 'posts.create', args: { payload: { title: 'nope' } } }),
      isOrbitErrorWith(ErrorCode.PERMISSION_DENIED),
    );
  });

  it('serves repeated queries from the cache, then evicts on mutation', async () => {
    const orbit = createApp();
    const envelope = { query: 'posts(status="published") { title }', cache: 'ttl=60' };

    const first = await orbit.execute(envelope);
    assert.notEqual(first.fromCache, true);

    const second = await orbit.execute(envelope);
    assert.equal(second.fromCache, true);

    // The mutation names `posts` → every cached query reading it evicts.
    await orbit.execute(
      { do: 'posts.create', args: { payload: { title: 'Cache buster' } } },
      { state: { caller: ADMIN } },
    );
    const third = await orbit.execute(envelope);
    assert.notEqual(third.fromCache, true);
  });

  it('fails unknown entities with the standard error contract', async () => {
    const orbit = createApp();
    await assert.rejects(
      () => orbit.execute({ query: 'ghost { id }' }),
      isOrbitErrorWith(ErrorCode.ENTITY_UNREGISTERED),
    );
  });
});
