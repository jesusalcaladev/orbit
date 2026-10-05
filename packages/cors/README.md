# @orbit/cors

First-party CORS for [`@orbit/core`](../core) — a dependency-free plugin that
answers the allowlist, preflight and credential contract from the frozen
response-headers channel (spec §7). No host layer (Express, Hono, Workers,
Next.js) needs its own CORS middleware for the Orbit route.

```bash
npm install @orbit/cors
```

```ts
import { createOrbit, memoryAdapter } from '@orbit/core';
import { createCorsPlugin } from '@orbit/cors';

const orbit = createOrbit({
  adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) }]),
  plugins: [
    createCorsPlugin({
      origins: ['https://app.example', 'https://staging.example'],
      credentials: true,
      maxAge: 600,
    }),
  ],
});
```

## What it does

| Concern | Behavior |
| :--- | :--- |
| **Allowlist** | `origins` accepts `'*'` (allow any), `'-'` (deny all), one string, an array of exact origins, or a predicate. Default `'*'`. |
| **Preflight (`OPTIONS`)** | Answered by the engine with `204 No Content` + `access-control-allow-methods` / `-allow-headers` / `-max-age`. Disallowed origins still get 204 — but without the allow headers, so the browser blocks the request (a CORS rejection is not an application error). |
| **Actual responses** | `access-control-allow-origin` (+ credentials/expose headers) stamped in `onBeforeParse`, so **queries AND mutations** carry it — even error responses (the hook runs before any adapter). |
| **Credentials** | `credentials: true` advertises `access-control-allow-credentials: true`. Combining it with the literal `*` allowlist throws at boot — browsers refuse that pairing. |
| **Cache safety** | With an explicit allowlist every response varies on `origin` (merged with the engine's `accept, accept-encoding` list). The wildcard emits the literal `*` and needs no `vary: origin`. |
| **Header reflection** | A preflight's `access-control-request-headers` is reflected, filtered of forbidden names (`cookie`, `authorization`, `host`, …) and unioned with the configured `headers` allowlist. A bare preflight gets no `allow-headers` at all. |

## Preflights without a host layer

The engine's handler answers bare `OPTIONS` requests through the plugin's
duck-typed `preflight` capability (the same additive pattern as the cache
plugin's eviction capability) — so `orbit.handler()` covers browsers
out of the box, on every runtime:

```ts
// Next.js App Router — app/api/orbit/route.ts
export const POST = (request: Request) => orbit.handler(request);
export const GET = (request: Request) => orbit.handler(request);
// OPTIONS needs no export: the engine answers preflights itself.
```

## Options

```ts
interface CorsOptions {
  origins?: string | string[] | ((origin: string) => boolean); // default '*'
  credentials?: boolean;          // default false
  exposeHeaders?: string[];       // access-control-expose-headers
  methods?: string[];             // default ['GET', 'POST', 'OPTIONS']
  headers?: string[];             // default ['content-type']
  maxAge?: number;                // default 600
}
```

`plugin.isAllowed(origin)` is exposed for diagnostics and tests.
