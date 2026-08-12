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
