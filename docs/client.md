# Client — `@orbit/client`

The **vanilla, framework-agnostic transport client** for the Orbit protocol.
No cache, no hooks, no state: it speaks the wire protocol and returns what the
server said. Higher layers (`@orbit/react`) build their cache and hooks on top
of it, and the browser demos (`examples/web`) run on it directly.

**Zero runtime dependencies** — the only import is `@orbit/core` (the frozen
protocol contracts: envelope validation, `OrbitError`, codecs, content types).

```
@orbit/react            hooks + cache (TTL/SWR, invalidate, persistence)
        │
@orbit/client           this package: execute/query/mutate, stream (SSE),
                        upload (multipart), subscribe/socket (WebSocket)
        │
@orbit/core             spec, errors, codecs, negotiation (frozen)
```

## Quick start

```ts
import { OrbitClient, createClient } from '@orbit/client';

// `createClient` is a plain function; `new OrbitClient` is the same object.
const client = createClient({ baseUrl: 'https://api.example.com/orbit' });

// Fetch the whole relational graph in one round-trip.
const { data } = await client.query('user(id="1") { name, posts { title } }');

// Mutate; `return` re-queries the returned graph after the mutation.
await client.mutate('user.update', {
  filter: { id: '1' },
  payload: { name: 'Ana' },
}, { return: 'user(id="1") { name, posts { title } }' });

// Stream a graph level by level over SSE (spec §7).
for await (const frame of client.stream('user(id="1") { posts { title } }')) {
  console.log(frame.level, frame.data); // level 0, 1, … 'done'
}

// Realtime subscription over the shared WebSocket (spec §10).
const sub = client.subscribe('posts(status="live") { id }', (event, meta) => {
  console.log(event, meta.seq);
});
sub.onStatus((status) => console.log('socket:', status)); // connecting → live
```

## API

| Method | What it does |
| --- | --- |
| `execute(envelope, options?)` | POST any envelope `{ query }` / `{ do }` and parse the reply. The core primitive; everything else is sugar. |
| `query(query, options?)` | `execute({ query })`. |
| `mutate(action, args, options?)` | `execute({ do, args, return? })` — the `return` option re-queries the graph after the mutation (spec §5). |
| `stream(query, options?)` | SSE: async iterable of `{ level, data }` frames (spec §7). Aborting cancels the body read. |
| `upload(action, args, files, options?)` | `multipart/form-data` mutation; each file lands in `ctx.files` (spec §7). |
| `subscribe(query, handler, options?)` | Realtime subscription; returns a handle with `id`, `seq` (resume cursor), `close()`, `onStatus`, `onError`, `onAck`. |
| `socket().request(envelope, options?)` | Envelope request/response over the **same** realtime socket (spec §10) — the reply mirrors the HTTP payload. |
| `close()` | Close every subscription and the socket. Idempotent and terminal. |

### Options

`OrbitClientOptions`:

```ts
interface OrbitClientOptions {
  baseUrl: string;                          // e.g. '/orbit' or 'https://api.example.com/orbit'
  headers?: Record<string, string> | (() => Record<string, string>); // per-request re-evaluated
  format?: 'json' | 'msgpack';              // default 'json'; per-request override below
  gzip?: boolean;                           // Accept-Encoding + decompress; default true
  fetch?: typeof fetch;                     // injectable (tests, Workers, custom transports)
  decompress?: Decompress;                  // injectable gunzip (React Native — no DecompressionStream)
  WebSocket?: typeof WebSocket;             // injectable (Node 20, RN)
  realtimeUrl?: string;                     // explicit WS endpoint; default derived from baseUrl
}
```

`RequestOptions` (every method): `signal` (AbortSignal), `timeoutMs`, `format`
(per-request wire format), `headers` (merged over the client defaults), `cache`
(a cache spec string, e.g. `'ttl=300, stale=60'` — rides on the envelope,
spec §8), `return` (re-query after a mutation).

## Wire format & errors

- **Negotiation is inherited from `@orbit/core`**: `content-type` and `accept`
  are set from the format (`application/json` or `application/x-msgpack`), and
  `accept-encoding: gzip` is sent by default.
- The envelope is **validated client-side** (`validateEnvelope`) before any
  network I/O — a malformed envelope fails fast instead of wasting a
  round-trip.
- Every reply is an `OrbitResponse`: `{ data, status, fromCache?, invalidates?,
  headers, raw }`. `fromCache`/`invalidates` are returned as metadata — the
  client never caches; upper layers decide.
- Failures reject with:
  - `OrbitError` — the server answered a protocol error (spec §6), with the
    same `code`/`status`/`details` as `@orbit/core` (e.g.
    `ErrorCode.PERMISSION_DENIED`).
  - `OrbitNetworkError` — transport/parse/decompression failure, with `status`
    and `cause`.
  - the caller's own abort (`error.name === 'AbortError'`) — cancellation,
    exactly like `fetch`.
- **Abort is first-class**: `signal` + `timeoutMs` combine into one effective
  signal (the timeout is cleared when the request settles). On the server,
  `ctx.signal` receives it (spec §11), so a cancelled client cancels the
  server-side execution.

## Realtime transport

All subscriptions of one client share a **single WebSocket** (multiplexed).
The connection:

- reconnects automatically with bounded exponential backoff
  (`500 → 1200 → 2500 → 5000 ms`);
- `resume`s from the last applied `seq`, so missed events replay from the
  server's retention log (spec §10);
- **falls back transparently to a fresh `subscribe`** when the retention window
  expired — the server answers `ORBIT_SUBSCRIPTION_FAILED` and the client
  re-subscribes silently (no error surfaces to `onError`);
- closes the socket when the last subscription closes, and a failed connect
  never stacks multiple reconnect timers.

Frames are JSON (MessagePack over the socket is a future, additive option).

## Environment compatibility

The client is runtime-agnostic: browser, Node ≥ 20, React Native, Cloudflare
Workers. Every platform-specific primitive is **injectable** — no forced
polyfills in the bundle, and `@orbit/client` itself never references a
Node-specific API.

| Runtime | Missing primitive | Inject |
| --- | --- | --- |
| Browser | — | nothing (defaults work) |
| Node ≥ 21 | — | nothing (global `fetch`/`WebSocket`/`DecompressionStream`) |
| Node 20 | global `WebSocket` | `WebSocket` from the `ws` package |
| React Native (Hermes) | `DecompressionStream` | `decompress` (e.g. a `pako`-based gunzip); `WebSocket` is native; pass `gzip: false` to skip the header entirely |
| Cloudflare Workers | — | nothing (global `fetch`/`WebSocket`) |

The URL derivation rules:

- Requests go to `baseUrl` verbatim.
- The realtime URL defaults to `baseUrl` with `http`→`ws` (`https`→`wss`) and
  the path set to `/realtime` — the server's default path. An explicit
  `realtimeUrl` always wins. A **relative** `baseUrl` (e.g. `'/orbit'`) can
  derive the WS URL only in a browser (`location`); elsewhere pass
  `realtimeUrl`. Resolved lazily — HTTP-only clients never pay for it.

## Using it in a browser without a bundler

The demos (`examples/web`) have no build step: an import map points the bare
specifiers at the built ESM files, which the demo server serves from
`/vendor/@orbit/{client,core}/…`. See `examples/web/server.ts` and the demo
HTML files for the wiring.

## Benchmark

See the README's *Overhead vs raw fetch* section for a measured comparison of
`execute()` against a hand-rolled `fetch` — one POST + one parse, no
intermediate layers.
