# Adapters

Adapters answer filters. That's the whole contract — the core knows nothing of databases, only that an adapter can turn a `Record<string, string>` into data.

> **Frozen contract.** The `DataAdapter` interface below is stable (v0.0.1).
> The canonical definition lives in the [protocol spec](../spec.md) — do not
> add methods without updating it.

## The contract

```ts
import type { DataAdapter } from '@orbit/core';

const postgresUserAdapter: DataAdapter = {
  entity: 'user',

  async resolve(filters, ctx) {
    const where = toWhere(filters); // your SQL builder
    return pool.query(`SELECT * FROM users ${where}`).rows;
  },

  async batch(requests, ctx) {
    // requests: [{ filters, parent }, ...] — results must align by index.
    // The N+1 fix: ONE query for all siblings.
    const ids = requests.map((r) => r.parent?.data.id).filter(Boolean);
    const rows = await pool.query(`SELECT * FROM posts WHERE author_id = ANY($1)`, [ids]);
    return requests.map((r) => rows.filter((row) => row.author_id === r.parent?.data.id));
  },

  async mutate(action, args, ctx) {
    // action: 'update' | 'create' | 'delete' | anything you define
    const { filter, payload } = args;
    return {
      id: '123',
      invalidates: [`cache:user:123`],
    };
  },
};
```

### `resolve(filters, ctx)`

- `filters` — the exact key/value pairs from the query, as strings.
- Returns an **object** (one record) or an **array** (many). You decide.
- While resolving a **relation**, `ctx.parent` carries `{ entity, data }` of the resolved parent — scope with it.

### `batch(requests, ctx)` — optional, the N+1 fix

When present, the engine groups **all sibling requests of the same entity at one level** into a single call. `requests` is an array of `{ filters, parent }`; the returned array must align by index. Implement it and a 3-parent graph costs 1 query instead of 3.

### `mutate(action, args, ctx)` — optional

Invoked by the `do` envelope. `action` is the verb after the dot (`user.update` → `update`). `args` carries `filter`, `payload`, and anything else the client sent. Return `{ id?, invalidates? }` — `invalidates` is echoed to the client.

### `subscribe(filters, handler)` — optional, realtime

The realtime hook. Register a listener for changes on this adapter's entity; it returns an **unsubscribe** function.

```ts
const unsubscribe = adapter.subscribe({ status: 'online' }, (event) => {
  // { type: 'created' | 'updated' | 'deleted', id?, data?, patch? }
});
unsubscribe();
```

Entity-scoped by construction, so there is no `subscribeToEntity` — an empty filter set means "every record of this entity". The transport layer (websocket, …) relays these events to clients as patches (see [Realtime & subscriptions](../spec.md)).

## Built-in adapters

### `memoryAdapter` — in-memory data

Perfect for demos, tests, and local development. Zero I/O, zero dependencies.

```ts
import { memoryAdapter } from '@orbit/core';

const adapters = memoryAdapter([
  {
    entity: 'user',
    resolve: ({ id }) => users.find((u) => u.id === id),
    mutate: (action, { filter, payload }) => {
      const user = users.find((u) => u.id === filter?.id);
      if (action === 'update' && payload) Object.assign(user, payload);
      return { id: user?.id, invalidates: [`cache:user:${user?.id}`] };
    },
  },
]);
```

`memoryAdapter` also wires a default `batch` (one `resolve` per request), so relation-heavy demos exercise the batching path automatically.

### `restAdapter` — any REST API behind the contract (`@orbit/rest`)

The first ecosystem package: a fetch-based adapter that speaks the frozen
`DataAdapter` contract to a plain REST API.

```ts
import { createOrbit } from '@orbit/core';
import { restAdapter } from '@orbit/rest';

const orbit = createOrbit({
  adapters: [
    restAdapter({
      entity: 'user',
      baseUrl: 'https://api.example.com/v1',
      parentKey: 'authorId', // relation scoping: posts under a user → ?authorId=7
    }),
  ],
});
```

| Orbit concept | REST translation |
| :--- | :--- |
| `user(id="42") { name }` | `GET /user/42` (an `id` filter becomes the path segment) |
| `users(role="admin")` | `GET /users?role=admin` (other filters become query params) |
| Relation under a parent | `parentKey` injects the parent id as a query param |
| `do: user.create` / `.update` / `.delete` | `POST` / `PATCH` / `DELETE` (per-action overridable via `mutations`) |
| Response body shape | `unwrap` extracts the payload (e.g. `({ data }) => data`) |

Behavior notes:

- Upstream `404` resolves to **`null`** ("no record"); every other failure
  becomes an `OrbitError` that **preserves the upstream status** on the wire
  (a `429` is answered `429`, not flattened to `400`). Mutation failures use
  `ORBIT_MUTATION_FAILED`; a `400`/`422` on reads maps to
  `ORBIT_FILTER_INVALID`.
- No `batch`: REST round-trips cannot be merged, so a deep graph is one
  parallel request per sibling (the engine's per-level `Promise.all`). The
  N+1 fix is why DB adapters implement `batch`; over REST it's a documented
  limitation.
- `fetchFn`, `headers` (static or a function, e.g. for auth tokens) are
  injectable for tests and signed requests.

See [`docs/ecosystem.md`](./ecosystem.md) for the package's roadmap context.

## Writing your own in 5 minutes

1. Pick an entity name.
2. Write `resolve(filters, ctx)` — a function.
3. Optional: add `batch` for N+1, `mutate` for writes, `subscribe` for realtime.
4. Register it.

```ts
createOrbit({ adapters: [{ entity: 'inventory', resolve: myInventoryLookup }] });
```

## Error conventions

- Throw `OrbitError` with a precise code when you know it: `ORBIT_FILTER_INVALID` for bad filters, `ORBIT_PERMISSION_DENIED` for auth, etc.
- Throw plain `Error` for unexpected failures → normalized to `ORBIT_INTERNAL` (500). An `onError` plugin can translate it later.
- A `batch()` returning the wrong number of results is an `ORBIT_INTERNAL` error — the engine fails loudly rather than misaligning data.
