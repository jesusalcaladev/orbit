# @orbit/auth

First-party authentication & authorization for [@orbit/core](../core) — a
**dependency-free plugin** that resolves a caller identity from the request
context and stamps it onto `ctx.state.caller`, then gates and scopes reads.

## Why this package exists

The protocol core ships no auth — by design, auth is "just a hook" (spec §2).
The demos hand-roll the split every time:

- **Authentication** (who is calling) → resolve a token/key into a caller.
- **Authorization** (what they may do) → deny or scope the query.

This package packages that split once, with the one subtlety done right:
identity is stamped in `onBeforeParse`, and the engine runs `onBeforeParse`
once before every **mutation** (spec §5/§11 additive rule) — so
`ctx.state.caller` reaches the adapter's `mutate` too, not just queries.

## Install

```sh
pnpm add @orbit/auth
```

## Quick start

```ts
import { createOrbit, ErrorCode, OrbitError } from '@orbit/core';
import { createAuthPlugin, apiKeyAuth, requireCaller } from '@orbit/auth';

const orbit = createOrbit({
  adapters,
  plugins: [
    createAuthPlugin({
      authenticate: apiKeyAuth({
        'admin-123': { id: 'admin', role: 'admin' },
        'ana-456': { id: 'ana', role: 'member' },
      }),
      authorize: ({ parsed, caller }) => {
        if (parsed.entity === 'user' && caller.role !== 'admin') {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admins only');
        }
      },
    }),
  ],
});
```

`apiKeyAuth` reads `x-api-key` (configurable). Missing or unknown keys answer
`ORBIT_PERMISSION_DENIED` (403). A lookup uses `Object.hasOwn`, so a hostile
header value (`__proto__`, `constructor`) can never resolve an inherited
property and pass authentication.

## Options

| Option | Required | Meaning |
| :--- | :--- | :--- |
| `authenticate` | ✅ | Resolve the caller from `ctx` (headers, cookies, …). Return the caller, or `null`/`undefined` to deny. Throw an `OrbitError` for a precise code. |
| `authorize` | — | Read gate in `onBeforeResolve` — throw to deny **before any adapter runs**. Runs for client queries **and** a mutation's `return` re-query, so `{ do, return }` cannot bypass the gate. |
| `scope` | — | Row-level scoping in `onBeforeExecute` — return filters (usually the incoming filters plus a tenant/user id). |
| `missingMessage` | — | Denial message (default `"Authentication required"`). |

## Authenticator presets

- **`bearerAuth(verify, headerName?)`** — reads `Authorization: Bearer <token>`
  and hands the token to `verify`. Return the caller for a valid token and
  `null` for an invalid/expired one (a `null` is a 403; a thrown plain
  `Error` becomes a sanitized 500 — don't throw for ordinary auth failures).
- **`apiKeyAuth(keys, headerName?)`** — a static API-key table, `x-api-key`
  by default, with prototype-pollution-safe lookups.

## Helpers for mutations

Mutations do **not** run `onBeforeResolve`, so write policy lives inside the
adapter's `mutate` — the caller is already there:

```ts
import { requireCaller, requireRole } from '@orbit/auth';

async mutate(action, args, ctx) {
  const caller = requireCaller(ctx);      // throws 403 if unauthenticated
  if (action === 'delete') requireRole(caller, 'admin');
  // …
}
```

- **`requireCaller(ctx, message?)`** — throw `ORBIT_PERMISSION_DENIED` when no
  caller is stamped.
- **`requireRole(caller, ...roles)`** — require `caller.role` to be one of the
  listed roles.

## Realtime sessions

If a caller is already present on `ctx.state.caller` — e.g. seeded by a
realtime `authorize` session (spec §10) or a framework authn layer —
`authenticate` is **skipped**, so a socket upgrade's identity is never
clobbered by a second credential check.

## Contract

Implements the frozen `OrbitPlugin` interface (spec §11); no core changes, no
new error codes — `ORBIT_PERMISSION_DENIED` (403) is the denial contract.
12 tests in `packages/auth/test/`.
