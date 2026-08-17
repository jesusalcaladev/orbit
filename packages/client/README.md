# @orbit/client

Vanilla, framework-agnostic [Orbit](https://github.com/orbit) client — the
**transport layer** of the ecosystem. No cache, no hooks, no state: it speaks
the wire protocol and returns what the server said. Higher layers
(`@orbit/react`) build their cache and hooks on top of it, and the browser
demos (`examples/web`) run on it directly.

Zero third-party runtime dependencies — the only import is `@orbit/core`
(envelope validation, `OrbitError`, codecs, negotiation).

## What it does

- `execute` / `query` / `mutate` — POST the envelope (`{ query }` / `{ do }`),
  with `return` re-querying the graph after a mutation
- `stream` — SSE, the graph level by level (`{ level, data }` frames)
- `subscribe` / `socket().request` — realtime WebSocket, multiplexed on one
  socket, with reconnect + `resume` from the last `seq` and transparent
  fallback when the server's retention window expired
- `upload` — multipart mutations with files (`ctx.files` on the server)
- JSON / MessagePack negotiation (request body + `Accept`), gzip with
  automatic double-gunzip detection (undici leaves the header visible)
- typed errors reusing the `@orbit/core` contract (`OrbitError` codes) plus
  `OrbitNetworkError` for transport/parse failures
- `AbortSignal` + per-request timeout; the abort propagates to the server
  (`ctx.signal`, spec §11)
- client-side envelope validation (`validateEnvelope`) — fail fast, no wasted
  round-trips

## Status

**M1–M3 complete.** HTTP core (JSON + MessagePack, validation, errors,
abort/timeout, gzip), SSE streaming, multipart uploads and realtime
(WebSocket) — all with unit tests and e2e tests against a real server, 100%
coverage thresholds like `@orbit/core` (see
[`plan-client-vanilla.md`](../../plan-client-vanilla.md)). M4: docs +
adoption in `examples/web` and the book demo.

## Quickstart

```ts
import { createClient, OrbitError } from '@orbit/client';

const client = createClient({ baseUrl: '/orbit', headers: { 'x-orbit-token': token } });

// Query
const { data, fromCache } = await client.query('user(id="1") { name, posts { title } }', {
  cache: 'ttl=300, stale=60',
});

// Mutation with a re-query
const { data: updated, invalidates } = await client.mutate(
  'user.update',
  { filter: { id: '1' }, payload: { name: 'Ana' } },
  { return: 'user(id="1") { name }' },
);

// Stream the graph level by level over SSE
for await (const frame of client.stream('user(id="1") { posts { title } }')) {
  console.log(frame.level, frame.data); // level 0, 1, … 'done'
}

// Realtime — one shared socket, automatic reconnect + resume
const sub = client.subscribe('posts(status="live") { id }', (event, meta) => {
  console.log(event, meta.seq);
});
sub.onStatus((status) => console.log('socket:', status)); // connecting → live

// Errors are typed: OrbitError (protocol) vs OrbitNetworkError (transport)
try {
  await client.query('ghost { id }');
} catch (error) {
  if (error instanceof OrbitError) console.error(error.code, error.status, error.details);
}
```

## API

| Method | Purpose |
| --- | --- |
| `execute(envelope, options?)` | POST any envelope and parse the reply — the core primitive |
| `query(query, options?)` | sugar for `execute({ query })` |
| `mutate(action, args, options?)` | sugar for `execute({ do, args, return? })` |
| `stream(query, options?)` | SSE async iterable of graph levels (spec §7) |
| `upload(action, args, files, options?)` | multipart mutation (spec §7) |
| `subscribe(query, handler, options?)` | realtime subscription handle (`id`, `seq`, `close`, `onStatus`, `onError`, `onAck`) |
| `socket().request(envelope, options?)` | envelope request/response over the same socket (spec §10) |
| `close()` | close every subscription and the socket |

Full reference — options, wire format, errors, environment compatibility —
in [`docs/client.md`](../../docs/client.md).

## Overhead vs raw fetch

`execute()` is one POST + one parse — client-side envelope validation and
response parsing on top of the same request a hand-rolled `fetch` would make.
Measured against a raw fetch hitting the same server:

```text
  raw fetch        avg 1.34 ms    p50 1.13 ms    p95 1.73 ms
  client.execute   avg 1.28 ms    p50 1.15 ms    p95 1.76 ms
  client overhead   ~0 % on avg (validation + response parsing)
```

No intermediate layers, no added latency. Re-run locally with
`pnpm run build && node packages/client/bench/overhead.ts`.

## Environment notes

- **React Native:** no `DecompressionStream` — inject a gunzip via
  `decompress` (or set `gzip: false`); `WebSocket` is native.
- **Node 20:** global `WebSocket` is not stable — inject one via the
  `WebSocket` option (e.g. `ws`).
- **Cloudflare Workers / browsers:** everything is global — defaults work.

## Development

```sh
pnpm --filter @orbit/client run build          # compile to dist/
pnpm --filter @orbit/client run typecheck      # tsc --noEmit
pnpm --filter @orbit/client run test           # vitest
pnpm --filter @orbit/client run test:coverage  # vitest with 100% thresholds
```
