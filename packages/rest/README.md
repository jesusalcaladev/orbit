# @orbit/rest

A REST `DataAdapter` for [@orbit/core](../core) — serve any REST API behind
the Orbit contract. Queries become `GET` calls, mutations become
`POST`/`PATCH`/`DELETE`. **Zero third-party runtime dependencies** (the
global `fetch` does the work).

## Install

```sh
pnpm add @orbit/rest
```

## Quick start

```ts
import { createOrbit } from '@orbit/core';
import { restAdapter } from '@orbit/rest';

const orbit = createOrbit({
  adapters: [
    restAdapter({ entity: 'user', baseUrl: 'https://api.example.com/v1' }),
  ],
});
```

Mapping:

| Orbit | REST |
| :--- | :--- |
| `query user(id="42") { name }` | `GET /v1/user/42` |
| `query user { name }` | `GET /v1/user` |
| `do user.update { filter: { id: "42" }, payload: { name: "Ada" } }` | `PATCH /v1/user/42` with `{ "name": "Ada" }` |
| `do user.create { payload: { name: "Ada" } }` | `POST /v1/user` |
| `do user.delete { filter: { id: "42" } }` | `DELETE /v1/user/42` |

## Options

### `restAdapter({ entity, baseUrl, path?, headers?, fetchFn?, parentKey?, unwrap?, mutations? })`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `entity` | `string` | — | Entity name this adapter serves — must match query roots and relations |
| `baseUrl` | `string` | — | Base URL of the REST API, e.g. `https://api.example.com/v1` |
| `path?` | `string` | `entity` | Path segment for this entity, e.g. `users` |
| `headers?` | `HeadersInit` \| `() => HeadersInit \| Promise<HeadersInit>` | — | Static headers, or a function returning them (e.g. an auth token) |
| `fetchFn?` | `typeof fetch` | global `fetch` | The fetch implementation — handy in tests and non-standard runtimes |
| `parentKey?` | `string` | — | When resolving a relation under a parent record, inject a query parameter named `parentKey` whose value is the parent's `id` |
| `unwrap?` | `(json: unknown) => unknown` | identity | Extract the payload from a JSON response body, e.g. `({ data }) => data` |
| `mutations?` | `Record<string, RestMutationSpec>` | `create→POST`, `update→PATCH`, `delete→DELETE` | Per-action HTTP mapping; unknown actions reject |

### Relations

Nested relations resolve through the parent context. For a `posts` entity
nested under `user`:

```ts
restAdapter({
  entity: 'posts',
  baseUrl: 'https://api.example.com/v1',
  parentKey: 'authorId', // GET /v1/posts?authorId=<parent.id>
});
```

### Custom mutations

```ts
restAdapter({
  entity: 'user',
  baseUrl: 'https://api.example.com/v1',
  mutations: {
    archive: { method: 'POST', path: 'users/archive' },
    restore: { method: 'POST', path: 'users/restore' },
  },
});
```

`do user.archive` now calls `POST /v1/users/archive`. Any action without a
spec rejects with `ORBIT_MUTATION_FAILED`.

## Behavior notes

- **Upstream `404` resolves to `null`** ("no record"); other failures become
  `OrbitError`s that preserve the upstream status on the wire (a 401/429 is
  never flattened into a misleading 400). Upstream `401`/`403` map to
  `ORBIT_PERMISSION_DENIED` (with the original status, so a 401 stays 401);
  `400`/`422` map to `ORBIT_FILTER_INVALID`; everything else is
  `ORBIT_INTERNAL`.
- **Mutation failures always use `ORBIT_MUTATION_FAILED`** (with the
  upstream status preserved via `details`/`options.status`).
- **A payload on a `GET`/`DELETE` mutation is rejected**, not silently
  dropped: `ORBIT_MUTATION_FAILED` with the mapped method named — a
  mutation that "succeeded" while its data went nowhere is worse than a
  loud error.
- **No `batch`** — REST round-trips can't be merged, so a deep graph is one
  parallel request per sibling (the engine's `Promise.all` per level). For
  N+1 relief you'd write a `batch` adapter against your own API.
- Collection endpoints that 404 on empty results yield `null`, not `[]` —
  the adapter never guesses about the payload shape.

## Example

The book API serves the same engine through Express, Hono and Cloudflare
Workers (`examples/node/frameworks/`); a REST-backed adapter slotting in is
a drop-in `DataAdapter` (see `docs/adapters.md` for the frozen contract).

## Test

```sh
pnpm test
```
