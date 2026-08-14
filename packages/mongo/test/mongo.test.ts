import { ErrorCode, createOrbit } from '@orbit/core';
import type { Collection, Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createMongoAdapter } from '../src/index.js';
import type { MongoCollection, MongoDbLike, MongoDocument, MongoFindResult } from '../src/index.js';

// ---------------------------------------------------------------------------
// Type-level compatibility with the real mongodb driver (compile-time only).
// The structural contract must accept Db / Collection as-is — no casts in
// user code.
// ---------------------------------------------------------------------------
const dbAsClient: MongoDbLike = null as unknown as Db;
const collectionAsContract: MongoCollection = null as unknown as Collection;
void dbAsClient;
void collectionAsContract;

interface Call {
  collection: string;
  op: string;
  [key: string]: unknown;
}

/** Loose equality that also matches ObjectId-like wrappers by their string form. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    String(a) === String(b)
  ) {
    return true;
  }
  return false;
}

function matchesFilter(doc: MongoDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const keys = Object.keys(cond as Record<string, unknown>);
      if (keys.length === 1) {
        const op = keys[0]!;
        const value = (cond as Record<string, unknown>)[op];
        switch (op) {
          case '$ne':
            return !looseEq(doc[field], value);
          case '$gt':
            return (doc[field] as number) > (value as number);
          case '$gte':
            return (doc[field] as number) >= (value as number);
          case '$lt':
            return (doc[field] as number) < (value as number);
          case '$lte':
            return (doc[field] as number) <= (value as number);
          case '$regex':
            return (value as RegExp).test(String(doc[field]));
          case '$in':
            return (value as unknown[]).some((item) => looseEq(doc[field], item));
        }
      }
      return looseEq(doc[field], cond);
    }
    return looseEq(doc[field], cond);
  });
}

class FakeMongoCollection implements MongoCollection {
  private db: FakeMongoDb;
  private name: string;

  constructor(db: FakeMongoDb, name: string) {
    this.db = db;
    this.name = name;
  }

  find(filter: Record<string, unknown>, options?: { limit?: number }): MongoFindResult {
    return {
      toArray: async () => {
        this.db.calls.push({ collection: this.name, op: 'find', filter, options });
        let docs = this.db.collections.get(this.name) ?? [];
        docs = docs.filter((doc) => matchesFilter(doc, filter));
        if (options?.limit !== undefined) docs = docs.slice(0, options.limit);
        return docs.map((doc) => ({ ...doc }));
      },
    };
  }

  async insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }> {
    this.db.calls.push({ collection: this.name, op: 'insertOne', doc: { ...doc } });
    const stored = { ...doc };
    if (stored._id === undefined) stored._id = `auto-${this.db.nextId}`;
    this.db.nextId += 1;
    this.db.collections.get(this.name)!.push(stored);
    return { insertedId: stored._id };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number }> {
    this.db.calls.push({ collection: this.name, op: 'updateOne', filter, update });
    const docs = this.db.collections.get(this.name) ?? [];
    const doc = docs.find((d) => matchesFilter(d, filter));
    if (doc) Object.assign(doc, (update as { $set: Record<string, unknown> }).$set);
    return { matchedCount: doc ? 1 : 0 };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }> {
    this.db.calls.push({ collection: this.name, op: 'deleteOne', filter });
    const docs = this.db.collections.get(this.name) ?? [];
    const index = docs.findIndex((d) => matchesFilter(d, filter));
    if (index >= 0) {
      docs.splice(index, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
}

class FakeMongoDb implements MongoDbLike {
  collections = new Map<string, MongoDocument[]>();
  calls: Call[] = [];
  nextId = 1;

  seed(name: string, docs: MongoDocument[]): this {
    this.collections.set(
      name,
      docs.map((doc) => ({ ...doc })),
    );
    return this;
  }

  collection(name: string): FakeMongoCollection {
    if (!this.collections.has(name)) this.collections.set(name, []);
    return new FakeMongoCollection(this, name);
  }
}

/** An ObjectId-like wrapper to prove the toId/fromId plumbing. */
class FakeObjectId {
  readonly hex: string;

  constructor(hex: string) {
    this.hex = hex;
  }

  toString(): string {
    return this.hex;
  }
}

const toFakeObjectId = (id: string | number): FakeObjectId => new FakeObjectId(String(id));
const fromFakeObjectId = (stored: unknown): string | number | undefined =>
  stored instanceof FakeObjectId ? stored.hex : String(stored);

describe('createMongoAdapter.resolve', () => {
  it('resolves an id filter to a single document via a match on _id', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42', name: 'Ada' }]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.resolve({ id: '42' }, {})).resolves.toEqual({
      _id: '42',
      id: '42',
      name: 'Ada',
    });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.filter).toEqual({ _id: '42' });
  });

  it('resolves a non-id filter to an array', async () => {
    const db = new FakeMongoDb().seed('user', [
      { _id: '1', status: 'active' },
      { _id: '2', status: 'active' },
    ]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.resolve({ status: 'active' }, {})).resolves.toEqual([
      { _id: '1', id: '1', status: 'active' },
      { _id: '2', id: '2', status: 'active' },
    ]);
    expect(db.calls[0]?.filter).toEqual({ status: 'active' });
  });

  it('ANDs multiple filters into one match document', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await adapter.resolve({ status: 'active', role: 'admin' }, {});
    expect(db.calls[0]?.filter).toEqual({ status: 'active', role: 'admin' });
  });

  it('returns null when an id filter matches nothing', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.resolve({ id: 'missing' }, {})).resolves.toBeNull();
  });

  it('maps OQS names to document fields and re-keys documents (plus id)', async () => {
    const db = new FakeMongoDb().seed('users', [{ _id: '42', full_name: 'Ada' }]);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      collection: 'users',
      columns: { name: 'full_name' },
    });

    await expect(adapter.resolve({ name: 'Ada' }, {})).resolves.toEqual([
      { _id: '42', full_name: 'Ada', id: '42', name: 'Ada' },
    ]);
    expect(db.calls[0]?.filter).toEqual({ full_name: 'Ada' });
  });

  it('aliases the configured idField under id', async () => {
    const db = new FakeMongoDb().seed('user', [{ uuid: 'abc', name: 'Ada' }]);
    const adapter = createMongoAdapter({ entity: 'user', client: db, idField: 'uuid' });

    await expect(adapter.resolve({ id: 'abc' }, {})).resolves.toEqual({
      uuid: 'abc',
      name: 'Ada',
      id: 'abc',
    });
    expect(db.calls[0]?.filter).toEqual({ uuid: 'abc' });
  });

  it('emits a validated limit as a find option', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await adapter.resolve({ limit: '5' }, {});
    expect(db.calls[0]?.filter).toEqual({});
    expect(db.calls[0]?.options).toEqual({ limit: 5 });
  });

  it('rejects an invalid limit with ORBIT_FILTER_INVALID', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    for (const limit of ['0', '-1', 'abc', '1001']) {
      await expect(adapter.resolve({ limit }, {})).rejects.toMatchObject({
        code: ErrorCode.FILTER_INVALID,
      });
    }
    expect(db.calls).toHaveLength(0);
  });

  it('honors a custom maxLimit', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db, maxLimit: 50 });

    await adapter.resolve({ limit: '50' }, {});
    expect(db.calls[0]?.options).toEqual({ limit: 50 });
    await expect(adapter.resolve({ limit: '51' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
  });

  it('rejects the cursor filter as unsupported', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(adapter.resolve({ cursor: 'abc' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
  });

  it('scopes a relation through parentKey', async () => {
    const db = new FakeMongoDb().seed('post', []);
    const adapter = createMongoAdapter({ entity: 'post', client: db, parentKey: 'author_id' });

    await adapter.resolve({}, { parent: { entity: 'user', data: { id: 7 } } });
    expect(db.calls[0]?.filter).toEqual({ author_id: 7 });
  });

  it('translates operator overrides from the filters spec', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      filters: { age: { operator: 'gte' }, name: { operator: 'regex', field: 'full_name' } },
    });

    await adapter.resolve({ age: '21', name: '^A' }, {});
    expect(db.calls[0]?.filter).toEqual({
      age: { $gte: '21' },
      full_name: { $regex: /^A/ },
    });
  });

  it('rejects a malformed regex value with ORBIT_FILTER_INVALID', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      filters: { name: { operator: 'regex' } },
    });

    await expect(adapter.resolve({ name: '(' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a $ operator-injection filter key as FILTER_INVALID', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.resolve({ $where: 'x' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
    await expect(adapter.resolve({ 'name.$gt': 'x' }, {})).rejects.toMatchObject({
      code: ErrorCode.FILTER_INVALID,
    });
    expect(db.calls).toHaveLength(0);
  });

  it('passes filter values verbatim — a value can never become an operator', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await adapter.resolve({ name: 'x"; $gt: 0' }, {});
    expect(db.calls[0]?.filter).toEqual({ name: 'x"; $gt: 0' });
  });

  it('converts ids through toId/fromId (ObjectId-style stored ids)', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: new FakeObjectId('64a1b2c3'), name: 'Ada' }]);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      toId: toFakeObjectId,
      fromId: fromFakeObjectId,
    });

    await expect(adapter.resolve({ id: '64a1b2c3' }, {})).resolves.toEqual({
      _id: expect.any(FakeObjectId),
      name: 'Ada',
      id: '64a1b2c3',
    });
    expect(db.calls[0]?.filter).toEqual({ _id: expect.any(FakeObjectId) });
  });
});

describe('createMongoAdapter.batch', () => {
  it('groups same-shape siblings into one $in query and regroups rows', async () => {
    const db = new FakeMongoDb().seed('post', [
      { _id: '1', status: 'live' },
      { _id: '2', status: 'draft' },
    ]);
    const adapter = createMongoAdapter({ entity: 'post', client: db });

    const results = await adapter.batch!(
      [{ filters: { status: 'live' } }, { filters: { status: 'draft' } }],
      {},
    );

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.filter).toEqual({ status: { $in: ['live', 'draft'] } });
    expect(results).toEqual([
      [{ _id: '1', id: '1', status: 'live' }],
      [{ _id: '2', id: '2', status: 'draft' }],
    ]);
  });

  it('batches id lookups into a single $in query returning single records', async () => {
    const db = new FakeMongoDb().seed('user', [
      { _id: '1', name: 'user-1' },
      { _id: '2', name: 'user-2' },
    ]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    const results = await adapter.batch!([{ filters: { id: '1' } }, { filters: { id: '2' } }], {});

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.filter).toEqual({ _id: { $in: ['1', '2'] } });
    expect(results).toEqual([
      { _id: '1', id: '1', name: 'user-1' },
      { _id: '2', id: '2', name: 'user-2' },
    ]);
  });

  it('batches relation scoping through parentKey', async () => {
    const db = new FakeMongoDb().seed('post', [
      { _id: 'p1', author_id: 1 },
      { _id: 'p2', author_id: 2 },
    ]);
    const adapter = createMongoAdapter({ entity: 'post', client: db, parentKey: 'author_id' });

    const results = await adapter.batch!(
      [
        { filters: {}, parent: { entity: 'user', data: { id: 1 } } },
        { filters: {}, parent: { entity: 'user', data: { id: 2 } } },
      ],
      {},
    );

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.filter).toEqual({ author_id: { $in: [1, 2] } });
    expect(results).toEqual([
      [{ _id: 'p1', id: 'p1', author_id: 1 }],
      [{ _id: 'p2', id: 'p2', author_id: 2 }],
    ]);
  });

  it('batches ObjectId-style ids through toId', async () => {
    const db = new FakeMongoDb().seed('user', [
      { _id: new FakeObjectId('a1'), name: 'u1' },
      { _id: new FakeObjectId('a2'), name: 'u2' },
    ]);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      toId: toFakeObjectId,
      fromId: fromFakeObjectId,
    });

    const results = await adapter.batch!(
      [{ filters: { id: 'a1' } }, { filters: { id: 'a2' } }],
      {},
    );

    expect(db.calls[0]?.filter).toEqual({
      _id: { $in: [expect.any(FakeObjectId), expect.any(FakeObjectId)] },
    });
    expect(results).toEqual([
      { _id: expect.any(FakeObjectId), name: 'u1', id: 'a1' },
      { _id: expect.any(FakeObjectId), name: 'u2', id: 'a2' },
    ]);
  });

  it('falls back to per-request resolves when shapes differ', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await adapter.batch!([{ filters: { id: '1' } }, { filters: { status: 'live' } }], {});

    expect(db.calls).toHaveLength(2);
  });

  it('falls back when any request carries a limit', async () => {
    const db = new FakeMongoDb().seed('post', []);
    const adapter = createMongoAdapter({ entity: 'post', client: db });

    await adapter.batch!(
      [{ filters: { status: 'live', limit: '5' } }, { filters: { status: 'draft' } }],
      {},
    );

    expect(db.calls).toHaveLength(2);
  });

  it('falls back when any predicate is not equality', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      filters: { age: { operator: 'gt' } },
    });

    await adapter.batch!([{ filters: { age: '20' } }, { filters: { age: '30' } }], {});

    expect(db.calls).toHaveLength(2);
  });
});

describe('createMongoAdapter.mutate', () => {
  it('create → insertOne with the mapped document and the inserted id', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.mutate!('create', { payload: { name: 'Ada' } }, {})).resolves.toEqual({
      id: 'auto-1',
      invalidates: ['user'],
    });
    expect(db.calls[0]?.op).toBe('insertOne');
    // The adapter sends the payload; the server assigns _id.
    expect(db.calls[0]?.doc).toEqual({ name: 'Ada' });
    expect(db.collections.get('user')?.[0]).toEqual({ _id: 'auto-1', name: 'Ada' });
  });

  it('create maps payload keys to fields and honors a payload id', async () => {
    const db = new FakeMongoDb().seed('users', []);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      collection: 'users',
      columns: { name: 'full_name' },
    });

    await expect(
      adapter.mutate!('create', { payload: { id: 'new-1', name: 'Ada' } }, {}),
    ).resolves.toEqual({ id: 'new-1', invalidates: ['user'] });
    expect(db.calls[0]?.doc).toEqual({ _id: 'new-1', full_name: 'Ada' });
  });

  it('create converts a payload id through toId', async () => {
    const db = new FakeMongoDb().seed('user', []);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      toId: toFakeObjectId,
      fromId: fromFakeObjectId,
    });

    await expect(
      adapter.mutate!('create', { payload: { id: '64a1b2c3', name: 'Ada' } }, {}),
    ).resolves.toEqual({ id: '64a1b2c3', invalidates: ['user'] });
    expect(db.calls[0]?.doc).toEqual({ _id: expect.any(FakeObjectId), name: 'Ada' });
  });

  it('update → updateOne with $set and the id in the filter', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42', name: 'Grace' }]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(
      adapter.mutate!('update', { filter: { id: '42' }, payload: { name: 'Grace' } }, {}),
    ).resolves.toEqual({ id: '42', invalidates: ['user'] });
    expect(db.calls[0]?.op).toBe('updateOne');
    expect(db.calls[0]?.filter).toEqual({ _id: '42' });
    expect(db.calls[0]?.update).toEqual({ $set: { name: 'Grace' } });
    expect(db.collections.get('user')?.[0]).toEqual({ _id: '42', name: 'Grace' });
  });

  it('update ignores a payload id (the id comes from filter.id)', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42' }]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await adapter.mutate!(
      'update',
      { filter: { id: '42' }, payload: { id: '99', name: 'Grace' } },
      {},
    );
    expect(db.calls[0]?.update).toEqual({ $set: { name: 'Grace' } });
  });

  it('delete → deleteOne with the id in the filter', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42' }]);
    const adapter = createMongoAdapter({ entity: 'user', client: db });

    await expect(adapter.mutate!('delete', { filter: { id: '42' } }, {})).resolves.toEqual({
      id: '42',
      invalidates: ['user'],
    });
    expect(db.calls[0]?.op).toBe('deleteOne');
    expect(db.calls[0]?.filter).toEqual({ _id: '42' });
    expect(db.collections.get('user')).toHaveLength(0);
  });

  it('supports custom action aliases', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42' }]);
    const adapter = createMongoAdapter({
      entity: 'user',
      client: db,
      mutations: { archive: 'update' },
    });

    await adapter.mutate!('archive', { filter: { id: '42' }, payload: { active: 'false' } }, {});
    expect(db.calls[0]?.update).toEqual({ $set: { active: 'false' } });
  });

  it('rejects unknown actions with MUTATION_FAILED', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(adapter.mutate!('explode', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('requires filter.id for update/delete', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(adapter.mutate!('update', { payload: { name: 'x' } }, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
    await expect(adapter.mutate!('delete', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('requires a payload for create/update', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(adapter.mutate!('create', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
    await expect(
      adapter.mutate!('update', { filter: { id: '42' }, payload: { id: '42' } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
  });

  it('rejects a payload value whose keys could be interpreted as operators', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(
      adapter.mutate!('create', { payload: { name: { $gt: 'x' } } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
    await expect(
      adapter.mutate!('update', { filter: { id: '1' }, payload: { name: { a: { $set: 1 } } } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
    await expect(
      adapter.mutate!('create', { payload: { name: { 'a.b': 1 } } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
  });

  it('rejects a payload key that is not a valid field name', async () => {
    const adapter = createMongoAdapter({ entity: 'user', client: new FakeMongoDb() });
    await expect(
      adapter.mutate!('create', { payload: { 'name.first': 'Ada' } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
    await expect(
      adapter.mutate!('create', { payload: { $push: ['x'] } }, {}),
    ).rejects.toMatchObject({ code: ErrorCode.MUTATION_FAILED });
  });
});

describe('createMongoAdapter configuration', () => {
  it('fails fast on an invalid collection/idField/column/parentKey name', () => {
    const db = new FakeMongoDb();
    expect(() =>
      createMongoAdapter({ entity: 'user', client: db, collection: 'users; drop' }),
    ).toThrow(/invalid collection/);
    expect(() => createMongoAdapter({ entity: 'user', client: db, idField: 'id;--' })).toThrow(
      /invalid idField/,
    );
    expect(() =>
      createMongoAdapter({ entity: 'user', client: db, columns: { name: 'full name' } }),
    ).toThrow(/invalid column/);
    expect(() =>
      createMongoAdapter({ entity: 'user', client: db, parentKey: 'author.$id' }),
    ).toThrow(/invalid parentKey/);
  });
});

describe('createMongoAdapter end-to-end through createOrbit', () => {
  it('serves a query and a mutation-with-return through the engine', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '42', name: 'Grace' }]);
    const orbit = createOrbit({
      adapters: [createMongoAdapter({ entity: 'user', client: db })],
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

  it('resolves nested relations with parentKey scoping and batching', async () => {
    const db = new FakeMongoDb().seed('user', [{ _id: '1', name: 'Ada' }]).seed('post', [
      { _id: 'p1', title: 'A', author_id: '1' },
      { _id: 'p2', title: 'B', author_id: '1' },
    ]);
    const orbit = createOrbit({
      adapters: [
        createMongoAdapter({ entity: 'user', client: db }),
        createMongoAdapter({ entity: 'post', client: db, parentKey: 'author_id' }),
      ],
    });

    const result = await orbit.execute({ query: 'user(id="1") { name, post { title } }' });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      name: 'Ada',
      post: [{ title: 'A' }, { title: 'B' }],
    });
  });
});
