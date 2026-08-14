import { ErrorCode, createOrbit } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '../src/index.js';
import type { PostgresClient, PostgresQueryResult, PostgresRow } from '../src/index.js';

interface QueryCall {
  text: string;
  values: unknown[];
}

class FakeClient implements PostgresClient {
  calls: QueryCall[] = [];
  private handler: (call: QueryCall) => PostgresRow[] = () => [];

  onQuery(handler: (call: QueryCall) => PostgresRow[]): this {
    this.handler = handler;
    return this;
  }

  async query(text: string, values: unknown[] = []): Promise<PostgresQueryResult> {
    const call = { text, values };
    this.calls.push(call);
    return { rows: this.handler(call) };
  }
}

describe('createPostgresAdapter.resolve', () => {
  it('resolves an id filter to a single record via a parameterized WHERE', async () => {
    const client = new FakeClient().onQuery(() => [{ id: '42', name: 'Ada' }]);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(adapter.resolve({ id: '42' }, {})).resolves.toEqual({ id: '42', name: 'Ada' });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" WHERE "id" = $1');
    expect(client.calls[0]?.values).toEqual(['42']);
  });

  it('resolves a non-id filter to an array', async () => {
    const client = new FakeClient().onQuery(() => [{ id: '1' }, { id: '2' }]);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(adapter.resolve({ status: 'active' }, {})).resolves.toEqual([
      { id: '1' },
      { id: '2' },
    ]);
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" WHERE "status" = $1');
  });

  it('ANDs multiple filters in order', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await adapter.resolve({ status: 'active', role: 'admin' }, {});
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" WHERE "status" = $1 AND "role" = $2');
    expect(client.calls[0]?.values).toEqual(['active', 'admin']);
  });

  it('returns null when an id filter matches nothing', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(adapter.resolve({ id: 'missing' }, {})).resolves.toBeNull();
  });

  it('maps OQS names to SQL columns and re-keys rows (plus id)', async () => {
    const client = new FakeClient().onQuery(() => [{ user_id: '42', full_name: 'Ada' }]);
    const adapter = createPostgresAdapter({
      entity: 'user',
      client,
      table: 'users',
      idColumn: 'user_id',
      columns: { name: 'full_name' },
    });

    await expect(adapter.resolve({ id: '42' }, {})).resolves.toEqual({
      user_id: '42',
      full_name: 'Ada',
      id: '42',
      name: 'Ada',
    });
    expect(client.calls[0]?.text).toBe('SELECT * FROM "users" WHERE "user_id" = $1');
  });

  it('emits a validated LIMIT', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await adapter.resolve({ limit: '5' }, {});
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" LIMIT $1');
    expect(client.calls[0]?.values).toEqual([5]);
  });

  it('rejects an invalid limit with ORBIT_FILTER_INVALID', async () => {
    const client = new FakeClient();
    const adapter = createPostgresAdapter({ entity: 'user', client });

    for (const limit of ['0', '-1', 'abc', '1001']) {
      await expect(adapter.resolve({ limit }, {})).rejects.toMatchObject({
        code: ErrorCode.FILTER_INVALID,
      });
    }
    expect(client.calls).toHaveLength(0);
  });

  it('honors a custom maxLimit', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client, maxLimit: 50 });

    await adapter.resolve({ limit: '50' }, {});
    expect(client.calls[0]?.values).toEqual([50]);
    await expect(adapter.resolve({ limit: '51' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
  });

  it('rejects the cursor filter as unsupported', async () => {
    const adapter = createPostgresAdapter({ entity: 'user', client: new FakeClient() });
    await expect(adapter.resolve({ cursor: 'abc' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
  });

  it('scopes a relation through parentKey', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'post', client, parentKey: 'author_id' });

    await adapter.resolve({}, { parent: { entity: 'user', data: { id: 7 } } });
    expect(client.calls[0]?.text).toBe('SELECT * FROM "post" WHERE "author_id" = $1');
    expect(client.calls[0]?.values).toEqual([7]);
  });

  it('translates operator overrides from the filters spec', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({
      entity: 'user',
      client,
      filters: { age: { operator: 'gte' }, name: { operator: 'like', column: 'full_name' } },
    });

    await adapter.resolve({ age: '21', name: 'A%' }, {});
    expect(client.calls[0]?.text).toBe(
      'SELECT * FROM "user" WHERE "age" >= $1 AND "full_name" LIKE $2',
    );
    expect(client.calls[0]?.values).toEqual(['21', 'A%']);
  });

  it('binds values as parameters — never interpolates them into SQL', async () => {
    const malicious = "x'; DROP TABLE users; --";
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await adapter.resolve({ name: malicious }, {});
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" WHERE "name" = $1');
    expect(client.calls[0]?.values).toEqual([malicious]);
    expect(client.calls[0]?.text).not.toContain('DROP');
  });

  it('rejects a malicious filter key (identifier injection) as FILTER_INVALID', async () => {
    const adapter = createPostgresAdapter({ entity: 'user', client: new FakeClient() });
    await expect(adapter.resolve({ 'id; DROP TABLE users': '1' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
  });
});

describe('createPostgresAdapter.batch', () => {
  it('groups same-shape siblings into one IN-clause query and regroups rows', async () => {
    const client = new FakeClient().onQuery(({ values }) =>
      (values as string[]).map((status) => ({ id: status, status })),
    );
    const adapter = createPostgresAdapter({ entity: 'post', client });

    const results = await adapter.batch!(
      [{ filters: { status: 'live' } }, { filters: { status: 'draft' } }],
      {},
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toContain('"status" IN ($1, $2)');
    expect(client.calls[0]?.values).toEqual(['live', 'draft']);
    expect(results).toEqual([[{ id: 'live', status: 'live' }], [{ id: 'draft', status: 'draft' }]]);
  });

  it('batches id lookups into a single IN query returning single records', async () => {
    const client = new FakeClient().onQuery(({ values }) =>
      (values as string[]).map((id) => ({ id, name: `user-${id}` })),
    );
    const adapter = createPostgresAdapter({ entity: 'user', client });

    const results = await adapter.batch!([{ filters: { id: '1' } }, { filters: { id: '2' } }], {});

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe('SELECT * FROM "user" WHERE "id" IN ($1, $2)');
    expect(results).toEqual([
      { id: '1', name: 'user-1' },
      { id: '2', name: 'user-2' },
    ]);
  });

  it('batches relation scoping through parentKey', async () => {
    const client = new FakeClient().onQuery(({ values }) =>
      (values as number[]).map((authorId) => ({ id: `p${authorId}`, author_id: authorId })),
    );
    const adapter = createPostgresAdapter({ entity: 'post', client, parentKey: 'author_id' });

    const results = await adapter.batch!(
      [
        { filters: {}, parent: { entity: 'user', data: { id: 1 } } },
        { filters: {}, parent: { entity: 'user', data: { id: 2 } } },
      ],
      {},
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe('SELECT * FROM "post" WHERE "author_id" IN ($1, $2)');
    expect(results).toEqual([[{ id: 'p1', author_id: 1 }], [{ id: 'p2', author_id: 2 }]]);
  });

  it('falls back to per-request resolves when shapes differ', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await adapter.batch!([{ filters: { id: '1' } }, { filters: { status: 'live' } }], {});

    expect(client.calls).toHaveLength(2);
  });

  it('falls back when any request carries a limit', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'post', client });

    await adapter.batch!(
      [{ filters: { status: 'live', limit: '5' } }, { filters: { status: 'draft' } }],
      {},
    );

    expect(client.calls).toHaveLength(2);
  });

  it('falls back when any predicate is not equality', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({
      entity: 'user',
      client,
      filters: { age: { operator: 'gt' } },
    });

    await adapter.batch!([{ filters: { age: '20' } }, { filters: { age: '30' } }], {});

    expect(client.calls).toHaveLength(2);
  });
});

describe('createPostgresAdapter.mutate', () => {
  it('create → INSERT ... RETURNING *', async () => {
    const client = new FakeClient().onQuery(() => [{ id: 'new-1', name: 'Ada' }]);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(adapter.mutate!('create', { payload: { name: 'Ada' } }, {})).resolves.toEqual({
      id: 'new-1',
      invalidates: ['user'],
    });
    expect(client.calls[0]?.text).toBe('INSERT INTO "user" ("name") VALUES ($1) RETURNING *');
    expect(client.calls[0]?.values).toEqual(['Ada']);
  });

  it('create maps payload keys to columns and reads the id from idColumn', async () => {
    const client = new FakeClient().onQuery(() => [{ user_id: 'new-1' }]);
    const adapter = createPostgresAdapter({
      entity: 'user',
      client,
      table: 'users',
      idColumn: 'user_id',
      columns: { name: 'full_name' },
    });

    await expect(adapter.mutate!('create', { payload: { name: 'Ada' } }, {})).resolves.toEqual({
      id: 'new-1',
      invalidates: ['user'],
    });
    expect(client.calls[0]?.text).toBe('INSERT INTO "users" ("full_name") VALUES ($1) RETURNING *');
  });

  it('update → parameterized SET with the id in WHERE', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(
      adapter.mutate!('update', { filter: { id: '42' }, payload: { name: 'Grace' } }, {}),
    ).resolves.toEqual({ id: '42', invalidates: ['user'] });
    expect(client.calls[0]?.text).toBe('UPDATE "user" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    expect(client.calls[0]?.values).toEqual(['Grace', '42']);
  });

  it('update ignores a payload id (the id comes from filter.id)', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await adapter.mutate!(
      'update',
      { filter: { id: '42' }, payload: { id: '99', name: 'Grace' } },
      {},
    );
    expect(client.calls[0]?.text).toBe('UPDATE "user" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    expect(client.calls[0]?.values).toEqual(['Grace', '42']);
  });

  it('delete → DELETE ... RETURNING id', async () => {
    const client = new FakeClient().onQuery(() => [{ id: '42' }]);
    const adapter = createPostgresAdapter({ entity: 'user', client });

    await expect(adapter.mutate!('delete', { filter: { id: '42' } }, {})).resolves.toEqual({
      id: '42',
      invalidates: ['user'],
    });
    expect(client.calls[0]?.text).toBe('DELETE FROM "user" WHERE "id" = $1 RETURNING "id" AS "id"');
    expect(client.calls[0]?.values).toEqual(['42']);
  });

  it('supports custom action aliases', async () => {
    const client = new FakeClient().onQuery(() => []);
    const adapter = createPostgresAdapter({
      entity: 'user',
      client,
      mutations: { archive: 'update' },
    });

    await adapter.mutate!('archive', { filter: { id: '42' }, payload: { active: 'false' } }, {});
    expect(client.calls[0]?.text).toContain('UPDATE "user" SET "active" = $1');
  });

  it('rejects unknown actions with MUTATION_FAILED', async () => {
    const adapter = createPostgresAdapter({ entity: 'user', client: new FakeClient() });
    await expect(adapter.mutate!('explode', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('requires filter.id for update/delete', async () => {
    const adapter = createPostgresAdapter({ entity: 'user', client: new FakeClient() });
    await expect(adapter.mutate!('update', { payload: { name: 'x' } }, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
    await expect(adapter.mutate!('delete', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('requires a payload for create/update', async () => {
    const adapter = createPostgresAdapter({ entity: 'user', client: new FakeClient() });
    await expect(adapter.mutate!('create', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
    await expect(
      adapter.mutate!('update', { filter: { id: '42' }, payload: { id: '42' } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
  });
});

describe('createPostgresAdapter configuration', () => {
  it('fails fast on an invalid table/idColumn/column identifier', () => {
    const client = new FakeClient();
    expect(() =>
      createPostgresAdapter({ entity: 'user', client, table: 'users; DROP TABLE' }),
    ).toThrow(/invalid table identifier/);
    expect(() => createPostgresAdapter({ entity: 'user', client, idColumn: 'id;--' })).toThrow(
      /invalid idColumn identifier/,
    );
    expect(() =>
      createPostgresAdapter({ entity: 'user', client, columns: { name: 'full name' } }),
    ).toThrow(/invalid column identifier/);
  });
});

describe('createPostgresAdapter end-to-end through createOrbit', () => {
  it('serves a query and a mutation-with-return through the engine', async () => {
    const client = new FakeClient().onQuery(({ text }) => {
      if (text.startsWith('SELECT')) return [{ id: '42', name: 'Grace' }];
      return [{ id: '42' }];
    });
    const orbit = createOrbit({
      adapters: [createPostgresAdapter({ entity: 'user', client })],
    });

    const query = await orbit.execute({ query: 'user(id="42") { name }' });
    expect(query.status).toBe(200);
    expect(query.data).toEqual({ name: 'Grace' });

    const mutation = await orbit.execute({
      do: 'user.update',
      args: { filter: { id: '42' }, payload: { name: 'Grace' } },
      return: 'user(id="42") { id, name }',
    });
    expect(mutation.status).toBe(200);
    expect(mutation.data).toEqual({ id: '42', name: 'Grace' });
  });
});
