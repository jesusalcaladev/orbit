/**
 * 13 — Full stack: MongoDB + Redis + Auth + Rate-limit + Cache + Logging
 *
 * One Orbit engine with the whole first-party ecosystem mounted, proving
 * what each package saves you:
 *
 * - `@orbit/mongo`      — OQS → MongoDB match documents (operators, columns
 *                        mapping, `toId`/`fromId`), the N+1 fix (`$in`
 *                        batching), mutations (`create`/`update`/`delete`).
 * - `@orbit/redis`      — the Redis `CacheStore` (cache shared across
 *                        instances) AND the atomic rate-limit bucket store
 *                        (limits shared across instances, one Lua EVAL).
 * - `@orbit/auth`       — identity stamping that reaches queries AND
 *                        mutations, read gates (`authorize`) and row-level
 *                        scoping (`scope`).
 * - `@orbit/rate-limit` — token buckets gating queries AND mutations, with
 *                        the standard `RateLimit-*` response headers.
 * - `@orbit/logging`    — one structured, timed entry per request.
 *
 * Run:  node examples/node/stack/13-fullstack-mongo.ts   (after `npm run build`)
 *
 * No server required — an in-memory Mongo-compatible client and an
 * in-memory Redis-compatible client stand in, so the demo runs anywhere.
 * To run against the real thing, set the connection string:
 *
 *   MONGODB_URI=mongodb://localhost:27017 node examples/node/stack/13-fullstack-mongo.ts
 *
 * The real `mongodb` driver satisfies the adapter's contract as-is (the
 * package ships zero driver dependencies by design); for Redis, pass any
 * node-redis v4/v5 client to `createRedisCacheStore` / `createRedisRateLimitStore`
 * — the same shape the in-memory fake implements below.
 */
import { pathToFileURL } from 'node:url';
import { createCachePlugin, createOrbit, ErrorCode, isOrbitError, OrbitError } from '@orbit/core';
import type { Orbit, OrbitContext } from '@orbit/core';
import { createMongoAdapter } from '@orbit/mongo';
import type { MongoCollection, MongoDbLike, MongoDocument, MongoFindResult } from '@orbit/mongo';
import { createRedisCacheStore, createRedisRateLimitStore } from '@orbit/redis';
import type { RedisRateLimitClient, RedisStoreClient } from '@orbit/redis';
import { apiKeyAuth, createAuthPlugin } from '@orbit/auth';
import { createLoggingPlugin } from '@orbit/logging';
import type { LogEntry } from '@orbit/logging';
import { createRateLimitPlugin } from '@orbit/rate-limit';
import { MongoClient } from 'mongodb';

// ---------------------------------------------------------------------------
// In-memory stand-ins (real clients satisfy the same structural contracts —
// the adapter/store packages ship zero driver dependencies by design).
// ---------------------------------------------------------------------------

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

/** Evaluate the match documents the adapter builds ($eq/$ne/$gt/…/$in/$regex). */
function matchesFilter(doc: MongoDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, cond]) => {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
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
    }
    return looseEq(doc[field], cond);
  });
}

/** A Mongo-like client that counts every call (real or fake). */
interface CountedDb extends MongoDbLike {
  readonly callCount: number;
}

/** Wrap any Mongo-like client so every find/insert/update/delete is counted. */
function countingDb(inner: MongoDbLike): CountedDb {
  let count = 0;
  const wrap = (collection: MongoCollection): MongoCollection => ({
    find: (filter, options) => ({
      toArray: async () => {
        count += 1;
        return collection.find(filter, options).toArray();
      },
    }),
    insertOne: async (doc) => {
      count += 1;
      return collection.insertOne(doc);
    },
    updateOne: async (filter, update) => {
      count += 1;
      return collection.updateOne(filter, update);
    },
    deleteOne: async (filter) => {
      count += 1;
      return collection.deleteOne(filter);
    },
  });
  return {
    collection: (name) => wrap(inner.collection(name)),
    get callCount() {
      return count;
    },
  };
}

/** A tiny in-memory MongoDB — just the four methods the adapter needs. */
class FakeMongoDb implements CountedDb {
  readonly collections = new Map<string, MongoDocument[]>();
  callCount = 0;
  nextId = 1;

  seed(name: string, docs: MongoDocument[]): this {
    this.collections.set(
      name,
      docs.map((doc) => ({ ...doc })),
    );
    return this;
  }

  collection(name: string): MongoCollection {
    if (!this.collections.has(name)) this.collections.set(name, []);
    return new FakeMongoCollection(this, name);
  }
}

class FakeMongoCollection implements MongoCollection {
  readonly db: FakeMongoDb;
  readonly name: string;

  constructor(db: FakeMongoDb, name: string) {
    this.db = db;
    this.name = name;
  }

  find(filter: Record<string, unknown>, options?: { limit?: number }): MongoFindResult {
    return {
      toArray: async () => {
        this.db.callCount += 1;
        let docs = this.db.collections.get(this.name) ?? [];
        docs = docs.filter((doc) => matchesFilter(doc, filter));
        if (options?.limit !== undefined) docs = docs.slice(0, options.limit);
        return docs.map((doc) => ({ ...doc }));
      },
    };
  }

  async insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }> {
    this.db.callCount += 1;
    const stored = { ...doc };
    if (stored._id === undefined) {
      stored._id = `auto-${this.db.nextId}`;
      this.db.nextId += 1;
    }
    this.db.collections.get(this.name)!.push(stored);
    return { insertedId: stored._id };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number }> {
    this.db.callCount += 1;
    const docs = this.db.collections.get(this.name) ?? [];
    const doc = docs.find((d) => matchesFilter(d, filter));
    if (doc) Object.assign(doc, (update as { $set: Record<string, unknown> }).$set);
    return { matchedCount: doc ? 1 : 0 };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }> {
    this.db.callCount += 1;
    const docs = this.db.collections.get(this.name) ?? [];
    const index = docs.findIndex((d) => matchesFilter(d, filter));
    if (index >= 0) {
      docs.splice(index, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
}

/**
 * A tiny in-memory Redis — the `get`/`set`/`del`/`scanIterator` surface the
 * cache store needs, plus `eval` running the same token-bucket math as the
 * shipped Lua script (one EVAL = one atomic decision).
 */
class FakeRedis implements RedisStoreClient, RedisRateLimitClient {
  readonly data = new Map<string, string>();
  readonly buckets = new Map<string, { tokens: number; last: number }>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<unknown> {
    this.data.set(key, value);
    void options;
    return 'OK';
  }

  async del(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.data.delete(key);
      this.buckets.delete(key);
    }
    return list.length;
  }

  async *scanIterator(options: { MATCH: string }): AsyncIterableIterator<string> {
    const prefix = options.MATCH.split('*')[0]!;
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) yield key;
    }
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: Array<string | number> },
  ): Promise<unknown> {
    const args = options.arguments.map(Number);
    const now = args[0] ?? 0;
    const limit = args[1] ?? 0;
    const rate = args[2] ?? 0;
    const key = options.keys[0]!;
    const bucket = this.buckets.get(key) ?? { tokens: limit, last: now };
    this.buckets.set(key, bucket);
    const elapsed = Math.max(0, now - bucket.last);
    bucket.last = now;
    bucket.tokens = Math.min(limit, bucket.tokens + elapsed * rate);
    if (bucket.tokens < 1) {
      return [
        0,
        Math.ceil((1 - bucket.tokens) / rate),
        Math.ceil((limit - bucket.tokens) / rate),
        0,
      ];
    }
    bucket.tokens -= 1;
    return [1, 0, Math.ceil((limit - bucket.tokens) / rate), Math.floor(bucket.tokens)];
  }
}

// ---------------------------------------------------------------------------
// The engine — every package, one wiring.
// ---------------------------------------------------------------------------

const API_KEYS: Record<string, { id: string; role: string }> = {
  'admin-key': { id: '1', role: 'admin' },
  'ana-key': { id: '2', role: 'member' },
};

/** All requests share one rate-limit bucket key (first x-forwarded-for entry). */
const headers = (key: string) => new Headers({ 'x-api-key': key, 'x-forwarded-for': '10.0.0.1' });

interface Stack {
  orbit: Orbit;
  mongoCalls: () => number;
  logEntries: () => number;
  infra: string;
}

async function buildStack(): Promise<Stack> {
  const uri = process.env.MONGODB_URI;

  const seedUsers: MongoDocument[] = [
    { _id: '1', name: 'Ana', role: 'admin' },
    { _id: '2', name: 'Bruno', role: 'viewer' },
  ];
  const seedPosts: MongoDocument[] = [
    { _id: 'p1', title: 'Orbit in production', author_id: '1' },
    { _id: 'p2', title: 'Realtime without deps', author_id: '1' },
    { _id: 'p3', title: 'Batching for fun', author_id: '2' },
  ];

  let base: MongoDbLike;
  let infra = 'in-memory Mongo-compatible client (set MONGODB_URI for the real driver)';

  if (uri) {
    const client = new MongoClient(uri);
    try {
      await client.connect();
      const real = client.db('orbit_demo');
      // Idempotent: start from a clean slate every run.
      await Promise.all([
        real.collection('users').deleteMany({}),
        real.collection('posts').deleteMany({}),
      ]);
      await Promise.all([
        real.collection('users').insertMany(seedUsers),
        real.collection('posts').insertMany(seedPosts),
      ]);
      base = real;
      infra = `real MongoDB at ${uri}`;
    } catch (error) {
      console.warn(
        `  ⚠ could not connect to MongoDB (${(error as Error).message}) — falling back to the in-memory client`,
      );
      base = new FakeMongoDb().seed('users', seedUsers).seed('posts', seedPosts);
    }
  } else {
    base = new FakeMongoDb().seed('users', seedUsers).seed('posts', seedPosts);
  }

  // Every call is counted on both paths, so the N+1 / cache-hit assertions
  // hold against the real driver too.
  const counted: CountedDb = base instanceof FakeMongoDb ? base : countingDb(base);
  const mongoCalls = () => counted.callCount;

  // node-redis v4/v5 `createClient()` satisfies the same contract as this fake.
  const redis = new FakeRedis();
  const collected: LogEntry[] = [];

  // Spec §11 ordering: the cache plugin must be mounted AFTER every plugin
  // with an `onBeforeSerialize` hook (logging) — enforced at `createOrbit`.
  const orbit = createOrbit({
    adapters: [
      createMongoAdapter({ entity: 'user', client: counted, collection: 'users' }),
      createMongoAdapter({
        entity: 'posts',
        client: counted,
        collection: 'posts',
        parentKey: 'author_id',
      }),
    ],
    plugins: [
      createLoggingPlugin({ logger: (entry) => collected.push(entry) }),
      createAuthPlugin({
        authenticate: apiKeyAuth(API_KEYS),
        // Read gate: runs BEFORE any adapter query touches Mongo.
        authorize: ({ parsed, caller }) => {
          if (parsed.entity === 'user' && caller.role !== 'admin') {
            throw new OrbitError(
              ErrorCode.PERMISSION_DENIED,
              `Role '${caller.role}' cannot query users`,
            );
          }
        },
        // Row-level scope: members only ever see their own posts.
        scope: ({ entity, filters, caller }) => {
          if (entity === 'posts' && caller.role !== 'admin') {
            return { ...filters, author_id: String(caller.id) };
          }
        },
      }),
      createRateLimitPlugin({
        windowMs: 60_000,
        limit: 14,
        store: createRedisRateLimitStore({ client: redis }),
      }),
      createCachePlugin({ store: createRedisCacheStore({ client: redis }), defaultTtl: 60 }),
    ],
  });

  return {
    orbit,
    mongoCalls,
    logEntries: () => collected.length,
    infra,
  };
}

// ---------------------------------------------------------------------------
// The walkthrough — each check fails loudly so `run-all.ts` reports it.
// ---------------------------------------------------------------------------

let failures = 0;

function check(condition: boolean, message: string): void {
  console.log(`  ${condition ? '✔' : '✘'} ${message}`);
  if (!condition) failures += 1;
}

export async function main(): Promise<void> {
  const { orbit, mongoCalls, logEntries, infra } = await buildStack();

  console.log('\n  infra: ' + infra);
  console.log('  redis: in-memory Redis-compatible client (swap in node-redis `createClient()`)');

  // ── auth ────────────────────────────────────────────────────────────────
  console.log('\n· auth — who may read what (@orbit/auth)');
  const adminRead = await orbit.execute(
    { query: 'user(id="1") { id, name }' },
    { headers: headers('admin-key') },
  );
  check(
    (adminRead.data as { name?: string } | undefined)?.name === 'Ana',
    'admin reads user(id="1") → Ana',
  );

  try {
    await orbit.execute({ query: 'user(id="1") { id, name }' }, { headers: headers('ana-key') });
    check(false, 'member querying `user` is blocked');
  } catch (error) {
    check(
      isOrbitError(error) && error.code === ErrorCode.PERMISSION_DENIED,
      'member querying `user` → ORBIT_PERMISSION_DENIED (403), before any Mongo call',
    );
  }

  const scoped = await orbit.execute(
    { query: 'posts { id, title }' },
    { headers: headers('ana-key') },
  );
  const scopedData = scoped.data as Array<{ id: string; title: string }>;
  check(
    Array.isArray(scopedData) && scopedData.length === 1 && scopedData[0]!.id === 'p3',
    'member scope → only author_id="2" rows reach the adapter (p3)',
  );

  // ── cache ───────────────────────────────────────────────────────────────
  console.log('\n· cache — Redis store, entity-precise eviction (@orbit/cache + @orbit/redis)');
  const cacheCtx: OrbitContext = { headers: headers('admin-key') };
  const beforeCache = mongoCalls();
  const miss = await orbit.execute(
    { query: 'user(id="1") { id, name }', cache: 'ttl=60' },
    cacheCtx,
  );
  check(!miss.fromCache, 'first read → cache MISS (resolved from Mongo)');
  const hit = await orbit.execute(
    { query: 'user(id="1") { id, name }', cache: 'ttl=60' },
    cacheCtx,
  );
  check(hit.fromCache === true, 'second read → cache HIT, 0 Mongo calls');
  check(mongoCalls() - beforeCache === 1, 'exactly 1 Mongo query served both reads');

  await orbit.execute(
    { do: 'posts.create', args: { payload: { title: 'Cache eviction 101', author_id: '1' } } },
    { headers: headers('admin-key') },
  );
  const stillHit = await orbit.execute(
    { query: 'user(id="1") { id, name }', cache: 'ttl=60' },
    cacheCtx,
  );
  check(
    stillHit.fromCache === true,
    'a posts.create does NOT evict the user entry (eviction is entity-precise)',
  );

  await orbit.execute({ query: 'posts { id, title }', cache: 'ttl=60' }, cacheCtx);
  await orbit.execute({ query: 'posts { id, title }', cache: 'ttl=60' }, cacheCtx);
  await orbit.execute(
    { do: 'posts.create', args: { payload: { title: 'Another post', author_id: '1' } } },
    { headers: headers('admin-key') },
  );
  const postsAfter = await orbit.execute(
    { query: 'posts { id, title }', cache: 'ttl=60' },
    cacheCtx,
  );
  check(
    postsAfter.fromCache !== true,
    'posts cache AUTO-EVICTED after posts.create — server-side, no client call',
  );

  // ── N+1 fix ─────────────────────────────────────────────────────────────
  console.log('\n· N+1 fix — sibling relations collapse into one $in batch (@orbit/mongo)');
  const beforeGraph = mongoCalls();
  const graph = await orbit.execute(
    { query: 'user { id, name, posts { title } }' },
    { headers: headers('admin-key') },
  );
  const users = graph.data as Array<{ id: string; name: string; posts: unknown[] }>;
  const graphCalls = mongoCalls() - beforeGraph;
  check(
    users.length === 2 && users.every((u) => Array.isArray(u.posts)),
    '2 users, each with posts',
  );
  check(
    graphCalls === 2,
    `3 resolver requests (1 root + 2 relation) → ${graphCalls} Mongo calls (1 find + 1 $in batch)`,
  );

  // ── rate limit ──────────────────────────────────────────────────────────
  console.log(
    '\n· rate limit — Redis buckets, standard headers (@orbit/rate-limit + @orbit/redis)',
  );
  let blocked = 0;
  for (let i = 0; i < 6; i += 1) {
    // Fresh ctx per request — like a real HTTP handler (a reused ctx would
    // carry the previous request's pipeline headers into the next).
    const ctx: OrbitContext = { headers: headers('admin-key') };
    try {
      await orbit.execute({ query: 'user(id="1") { id, name }' }, ctx);
      const h = ctx.responseHeaders ?? {};
      const remaining = h['ratelimit-remaining'];
      const reset = h['ratelimit-reset'];
      if (i < 2) {
        check(
          String(remaining) === String(1 - i),
          `request ${i + 1} allowed · RateLimit-Remaining: ${remaining} · Reset: ${reset}s`,
        );
      }
    } catch (error) {
      if (isOrbitError(error) && error.status === 429) {
        blocked += 1;
        const h = ctx.responseHeaders ?? {};
        if (blocked === 1) {
          check(
            true,
            `request ${i + 1} → 429 ORBIT_PERMISSION_DENIED · Retry-After: ${h['retry-after']}s`,
          );
          check(
            h['ratelimit-limit'] === '14',
            'the 429 still carries RateLimit-Limit: 14 (headers ride error responses too)',
          );
        }
      } else {
        check(false, `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  check(
    blocked >= 1,
    'the shared bucket holds: once the limit is spent, the next request is a 429',
  );

  // ── logging ─────────────────────────────────────────────────────────────
  console.log('\n· logging — one structured entry per request (@orbit/logging)');
  const count = logEntries();
  check(count > 0, `${count} requests flowed through the pipeline, each timed`);
  console.log(`  [orbit] query    200  1.20 ms  user(id="1") { id, name }   ← sample entry format`);

  console.log(`\n  ${failures === 0 ? '✔ all checks passed' : `✘ ${failures} checks failed`}`);
  if (failures > 0) throw new Error(`${failures} checks failed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
