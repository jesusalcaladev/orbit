# @orbit/mongo

A MongoDB `DataAdapter` for [@orbit/core](../core) — translate Orbit's
verbatim string filters into **match documents** over a `mongodb` client you
inject. Filters become `{ field: value }` / `{ field: { $gt: value } }`,
same-entity siblings batch into one `{ field: { $in: [...] } }` query, and
mutations map to `insertOne` / `updateOne` / `deleteOne`.

## Install

```sh
pnpm add @orbit/mongo mongodb
```

## Quick start

```ts
import { createOrbit } from '@orbit/core';
import { MongoClient } from 'mongodb';
import { createMongoAdapter } from '@orbit/mongo';

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();
const db = client.db('app');

const orbit = createOrbit({
  adapters: [
    createMongoAdapter({
      entity: 'user',
      client: db,
      collection: 'users',          // default: entity
      columns: { name: 'full_name' }, // OQS field/filter/payload → document field
    }),
  ],
});
```

Mapping:

| Orbit | MongoDB |
| :--- | :--- |
| `query user(id="42") { name }` | `users.find({ _id: "42" })` → single record |
| `query user(status="active")` | `users.find({ status: "active" })` → array |
| `query posts(limit=20)` | `users.find({}, { limit: 20 })` |
| `do user.create { payload: { name: "Ada" } }` | `users.insertOne({ name: "Ada" })` |
| `do user.update { filter: { id: "42" }, payload: { name: "Ada" } }` | `users.updateOne({ _id: "42" }, { $set: { name: "Ada" } })` |
| `do user.delete { filter: { id: "42" } }` | `users.deleteOne({ _id: "42" })` |

## Options

### `createMongoAdapter({ entity, client, collection?, idField?, columns?, filters?, parentKey?, maxLimit?, mutations?, toId?, fromId? })`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `entity` | `string` | — | Entity name this adapter serves — must match query roots and relations |
| `client` | `MongoDbLike` | — | A `mongodb`-compatible client — the driver's `Db` satisfies it (`db.collection(name)`) |
| `collection?` | `string` | `entity` | Collection name |
| `idField?` | `string` | `'_id'` | Primary-key field |
| `columns?` | `Record<string, string>` | `{}` | OQS name → document field, used for filters, payloads and result re-keying |
| `filters?` | `Record<string, MongoFilterSpec>` | `{}` | Per-key field/operator overrides (equality by default) |
| `parentKey?` | `string` | — | Relation scoping field: `{ <parentKey>: parent.id }` |
| `maxLimit?` | `number` | `1000` | Upper bound for the reserved `limit` filter |
| `mutations?` | `Record<string, 'create' \| 'update' \| 'delete'>` | built-ins | Custom action name → built-in verb |
| `toId?` | `(id: string \| number) => unknown` | identity | Client-facing id → stored id (`filter.id`, payload `id`, parent scoping) |
| `fromId?` | `(stored: unknown) => string \| number \| undefined` | identity / `String()` | Stored id → client-facing id (the `id` result alias, mutation results) |

`MongoFilterSpec`:

```ts
{ field?: string; operator?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'regex' }
```

### Filters & operators

```ts
createMongoAdapter({
  entity: 'user',
  client: db,
  filters: {
    age: { operator: 'gte' },             // age="21"  → { age: { $gte: "21" } }
    name: { operator: 'regex', field: 'full_name' }, // name="^A" → { full_name: { $regex: /^A/ } }
  },
});
```

### Relations

Nested relations scope through the parent context:

```ts
createMongoAdapter({
  entity: 'post',
  client: db,
  parentKey: 'author_id', // posts under user → { author_id: <parent.id> }
});
```

### ObjectId ids

With the driver's native coercion, a 24-hex string filter for `_id` works
out of the box. When you want explicit control (or a custom id type), pass
inverse converters — they are applied at every boundary (`filter.id`, a
payload `id`, parent scoping, result aliases, mutation results):

```ts
import { ObjectId } from 'mongodb';

createMongoAdapter({
  entity: 'user',
  client: db,
  toId: (id) => new ObjectId(id),
  fromId: (id) => (id instanceof ObjectId ? id.toHexString() : String(id)),
});
```

### Batching (the N+1 fix)

When the engine resolves several sibling requests of the same entity, the
adapter's `batch` groups the ones sharing a filter shape into a single
`{ field: { $in: [...] } }` query and regroups the documents back by
request. A graph like `user { posts }` for N users costs one `posts` query,
not N.

Batching only applies to **equality** predicates without `limit`/`cursor`;
anything else falls back to per-request resolves (still correct — just N
round-trips for that level).

## Behavior notes

- **An `id` filter resolves to a single record** (or `null`); every other
  filter set resolves to an array. The `id` alias always reflects the
  primary key (`idField`, default `_id`) — a document field literally named
  `id` is overridden by it (MongoDB's primary key is `_id`; keep business
  ids under a different name).
- **No operator injection.** Field names are validated against a strict
  charset — a filter or payload key can never start with `$` or contain `.`
  — so client input cannot smuggle operator syntax into a query document.
  Payload *values* are walked recursively too: an object value whose keys
  start with `$` or contain `.` fails the mutation with
  `ORBIT_MUTATION_FAILED` instead of being interpreted as an operator. This
  is the Mongo counterpart of `@orbit/postgres` parameterization. Filter
  *values* (always strings from OQS) pass through verbatim and are inert.
- **`limit` is validated** (`1..maxLimit`, integer) and emitted as a `find`
  option. Invalid limits throw `ORBIT_FILTER_INVALID`.
- **`cursor` is not supported by default** and throws
  `ORBIT_FILTER_INVALID` — cursor pagination is app-specific; write a custom
  resolver (or a future extension) for it.
- **`regex` values become real `RegExp` objects** — the pattern is the
  client's input by design; keep patterns conservative (no catastrophic
  backtracking) and scope the field via `filters`.
- **`columns` re-keys documents** so the core's field projection finds your
  OQS names (`full_name` → `name`) and the primary key under `id`.
  Documents are returned whole; the core projects requested fields
  server-side, so unrequested fields never reach the wire.
- **Mutations return `invalidates: [entity]`**, so the engine evicts
  entity-scoped cache entries and echoes the invalidation to the client.
- **Config typos fail fast** (invalid collection/`idField`/column/
  `parentKey` names throw a plain `Error` at construction); client-triggered
  problems (bad filter key, bad limit, unsafe payload) throw `OrbitError`s
  with standard codes.

## Test

```sh
pnpm test
```

The suite runs against an in-memory fake implementing the injected
`MongoCollection` surface — no database in CI. A compile-time assertion in
the suite pins that the real `mongodb` driver's `Db`/`Collection` satisfy
that surface unchanged, so the injected-client contract cannot drift.
