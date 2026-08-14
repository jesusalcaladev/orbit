# @orbit/postgres

A PostgreSQL `DataAdapter` for [@orbit/core](../core) — translate Orbit's
verbatim string filters into **parameterized SQL** over a `pg` client you
inject. Queries become `WHERE … = $n` (never string interpolation), same-entity
siblings batch into one `IN ($1, $2, …)` query, and mutations map to
`INSERT`/`UPDATE`/`DELETE … RETURNING`.

## Install

```sh
pnpm add @orbit/postgres pg
```

## Quick start

```ts
import { createOrbit } from '@orbit/core';
import { Pool } from 'pg';
import { createPostgresAdapter } from '@orbit/postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orbit = createOrbit({
  adapters: [
    createPostgresAdapter({
      entity: 'user',
      client: pool,
      table: 'users',          // default: entity
      idColumn: 'user_id',     // default: 'id'
      columns: { name: 'full_name' }, // OQS field/filter/payload → SQL column
    }),
  ],
});
```

Mapping:

| Orbit | SQL |
| :--- | :--- |
| `query user(id="42") { name }` | `SELECT * FROM "users" WHERE "user_id" = $1` (`$1 = '42'`) |
| `query user(status="active")` | `SELECT * FROM "users" WHERE "status" = $1` |
| `query posts(limit=20)` | `SELECT * FROM "posts" LIMIT $1` |
| `do user.create { payload: { name: "Ada" } }` | `INSERT INTO "users" ("full_name") VALUES ($1) RETURNING *` |
| `do user.update { filter: { id: "42" }, payload: { name: "Ada" } }` | `UPDATE "users" SET "full_name" = $1 WHERE "user_id" = $2 RETURNING *` |
| `do user.delete { filter: { id: "42" } }` | `DELETE FROM "users" WHERE "user_id" = $1 RETURNING "user_id" AS "id"` |

## Options

### `createPostgresAdapter({ entity, client, table?, idColumn?, columns?, filters?, parentKey?, maxLimit?, mutations? })`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `entity` | `string` | — | Entity name this adapter serves — must match query roots and relations |
| `client` | `PostgresClient` | — | A `pg`-compatible client (`Pool`/`PoolClient`/`Client`) with `query(text, values?)` |
| `table?` | `string` | `entity` | SQL table name |
| `idColumn?` | `string` | `'id'` | SQL primary-key column |
| `columns?` | `Record<string, string>` | `{}` | OQS name → SQL column, used for filters, payloads and result re-keying |
| `filters?` | `Record<string, PostgresFilterSpec>` | `{}` | Per-key column/operator overrides (equality by default) |
| `parentKey?` | `string` | — | Relation scoping column: `WHERE <parentKey> = parent.id` |
| `maxLimit?` | `number` | `1000` | Upper bound for the reserved `limit` filter |
| `mutations?` | `Record<string, 'create' \| 'update' \| 'delete'>` | built-ins | Custom action name → built-in verb |

`PostgresFilterSpec`:

```ts
{ column?: string; operator?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' }
```

### Filters & operators

```ts
createPostgresAdapter({
  entity: 'user',
  client: pool,
  filters: {
    age: { operator: 'gte' },           // age="21"  → WHERE "age" >= $1
    name: { operator: 'like', column: 'full_name' }, // name="A%" → WHERE "full_name" LIKE $1
  },
});
```

### Relations

Nested relations scope through the parent context:

```ts
createPostgresAdapter({
  entity: 'post',
  client: pool,
  parentKey: 'author_id', // posts under user → WHERE author_id = <parent.id>
});
```

### Batching (the N+1 fix)

When the engine resolves several sibling requests of the same entity, the
adapter's `batch` groups the ones sharing a filter shape into a single
`WHERE col IN ($1, $2, …)` query and regroups the rows back by request. A
graph like `user { posts }` for N users costs one `posts` query, not N.

Batching only applies to **equality** predicates without `limit`/`cursor`;
anything else falls back to per-request resolves (still correct — just N
round-trips for that level).

## Behavior notes

- **An `id` filter resolves to a single record** (or `null`); every other
  filter set resolves to an array.
- **Values are always bind parameters.** A filter value like
  `x'; DROP TABLE users; --` travels as `$1`, never into the SQL text.
  Identifier positions (`table`, `idColumn`, `columns`, `parentKey`, resolved
  filter columns) are validated against a strict charset and quoted, so a
  malicious filter *key* fails with `ORBIT_FILTER_INVALID` instead of
  injecting.
- **`limit` is validated** (`1..maxLimit`, integer) and emitted as a bound
  `LIMIT $n`. Invalid limits throw `ORBIT_FILTER_INVALID`.
- **`cursor` is not supported by default** and throws
  `ORBIT_FILTER_INVALID` — keyset pagination is app-specific; write a custom
  resolver (or a future extension) for it.
- **`columns` re-keys rows** so the core's field projection finds your OQS
  names (`full_name` → `name`) and the primary key under `id`. Rows are
  fetched with `SELECT *`; the core projects requested fields server-side, so
  unrequested columns never reach the wire.
- **Mutations return `invalidates: [entity]`**, so the engine evicts
  entity-scoped cache entries and echoes the invalidation to the client.
- **Config typos fail fast** (invalid identifiers throw a plain `Error` at
  construction); client-triggered problems (bad filter key/value) throw
  `OrbitError`s with standard codes.

## Test

```sh
pnpm test
```

The suite runs against an in-memory fake `pg` client — no database in CI.
