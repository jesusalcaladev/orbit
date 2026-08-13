# Realtime — WebSocket subscriptions

Orbit's realtime transport (spec §10): a **zero-dependency WebSocket server**
that streams adapter `subscribe` events to clients, keeps subscription state
across disconnects, replays missed patches on resume, and serves `{ query }` /
`{ do }` envelope requests with the same payload as HTTP.

The transport is Node-specific (`node:http`). The `SubscriptionHub` it uses is
runtime-agnostic and can be driven by any transport later (SSE, uWebSockets…).

**One frame contract, one implementation.** The frame-level protocol
(subscribe/ack, unsubscribe, resume, and the `{ query }` / `{ do }` envelope
request/response) lives in a shared, runtime-agnostic **session driver**
(`createSessionDriver`, exported by `@orbit/core`). Both the Node transport
and the Cloudflare Workers transport (`@orbit/cloudflare-workers`, which
upgrades with the Workers-native `WebSocketPair`) drive the same driver — so
the contract cannot drift between runtimes. Transports keep what is theirs:
frame encoding (JSON/msgpack), socket APIs, retention windows (Node only) and
heartbeats.

## Quick start

```ts
import { createServer } from 'node:http';
import { createOrbit, memoryAdapter, createRealtimeServer } from '@orbit/core';

const orbit = createOrbit({ adapters: /* your adapters, with `subscribe` */ });

const httpServer = createServer();
const realtime = createRealtimeServer(orbit, { path: '/realtime' });
realtime.attach(httpServer);
httpServer.listen(3000);
```

The client subscribes over WebSocket:

```js
const ws = new WebSocket('ws://localhost:3000/realtime');
ws.onopen = () => ws.send(JSON.stringify({ subscribe: 'posts(status="live") { id, title }', id: 'feed' }));
ws.onmessage = ({ data }) => console.log(JSON.parse(data));
```

## Protocol frames (frozen in spec.md §10)

| Direction | Frame | Meaning |
| :--- | :--- | :--- |
| client → | `{ "subscribe": oqs, "id": "feed" }` | Subscribe; `id` names the subscription. |
| client → | `{ "unsubscribe": "feed" }` | Stop delivery. |
| client → | `{ "resume": "feed", "after": 42 }` | Reconnect: re-attach and replay `seq > 42`. |
| server → | `{ "ack": "feed" }` | Subscription established. |
| server → | `{ "id": "feed", "seq": 43, "event": { type, id?, data?, patch? } }` | One record change. |
| server → | `{ "unsubscribed": "feed" }` | Subscription released. |
| server → | `{ "resumed": "feed", "after": 42 }` | Replay finished. |
| server → | `{ "error": { code, message, details? } }` | Standard `OrbitError` shape. |

Frames are JSON by default, or MessagePack with `serialize: 'msgpack'`
(binary frames). Control traffic (`ping`/`pong`/`close`) lives at the
WebSocket layer — the server pings every `heartbeatMs` (default 30 s) and
closes connections that don't pong back.

## Envelope request/response (query/do over the socket)

The same socket also serves **envelope requests** — send `{ query }` or
`{ do }` (plus any envelope field: `args`, `return`, `cache`) and the server
answers with the exact payload HTTP would serve:

```js
ws.send(JSON.stringify({ query: 'user(id="1") { name }', id: 'req-1' }));
ws.send(JSON.stringify({
  do: 'user.update',
  args: { filter: { id: '1' }, payload: { name: 'Ana' } },
  id: 'req-2',
}));

// server →
{ id: 'req-1', status: 200, data: { name: 'Ana' } }
{ id: 'req-2', status: 200, data: { success: true, id: '1' }, invalidates: ['cache:user:1'] }
{ id: 'req-3', status: 404, error: { code: 'ORBIT_ENTITY_UNREGISTERED', message: '…' } }
```

| Frame | Meaning |
| :--- | :--- |
| client → | `{ "query": oqs, "id"?: string }` | Query through the full pipeline. |
| client → | `{ "do": "entity.action", "args"?, "return"?, "cache"?, "id"?: string }` | Mutation through the full pipeline. |
| server → | `{ "id"?, "status", "data", "contentType"?, "fromCache"?, "invalidates"? }` | Success — the HTTP JSON payload. |
| server → | `{ "id"?, "status", "error": { code, message, details? } }` | Failure — the standard error contract. |

Contract details:

- **`id` is a correlation id, not an envelope field.** The frozen envelope
  (spec §3) drops unknown fields, so the transport reads `id` itself and
  echoes it back verbatim — omit it for fire-and-forget.
- Envelopes are validated **exactly like HTTP** (`query` XOR `do`, `args` /
  `return` / `cache` rules, depth limits) and run the **full plugin
  pipeline** — auth gates, caching (`fromCache`), error translation all
  apply, so a policy that denies on HTTP denies on the socket too.
- Responses mirror HTTP JSON: `{ data, contentType?, fromCache?,
  invalidates? }` plus a `status`. When a plugin serialized the payload to a
  string (e.g. CSV), the string rides as `data` with its `contentType`;
  custom-serializer binary payloads (`Uint8Array`) and SSE streaming stay
  HTTP-only — `data` is `null` for them. Message size is capped by
  `maxMessageBytes` (default 1 MiB).

## Retention & resume (the B6 story)

When a socket drops, its subscriptions are **detached, not destroyed**: the
shared adapter hook stays alive, the per-subscription event log keeps
growing, and the client has a `retentionMs` window (default 60 s) to
reconnect and send `{ resume, after }`. The server replays only the patches
after the cursor — measured at **microseconds** for hundreds of patches
(benchmark B6). Re-subscribing with the same `id` re-attaches without
replay; `unsubscribe` (or the retention expiry) releases the adapter hook.

## Scaling

Every client on the same `(entity, filters)` shares **one** adapter
`subscribe` hook: 100 clients on `posts` cost one adapter subscription, and
the fan-out happens in memory inside the hub.

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `path` | `/realtime` | Upgrade path. |
| `maxMessageBytes` | 1 MiB | Oversized messages close the socket (1009). |
| `heartbeatMs` | 30 000 | Server ping interval. |
| `retentionMs` | 60 000 | How long a detached subscription survives for resume. |
| `serialize` | `json` | `'json'` or `'msgpack'`. |
| `authorize` | — | `(request) => boolean \| Promise<boolean>` gate before upgrade. |
| `origin` | — | Allowed `Origin` header(s); others get 403. |

## Error codes

`ORBIT_SUBSCRIPTION_FAILED` (500) covers duplicate ids, unknown/expired
subscriptions on resume, and adapters without a `subscribe` hook;
`ORBIT_ENTITY_UNREGISTERED` (404) covers unknown entities.

## Programmatic use

The `SubscriptionHub` is exported for transports that aren't WebSocket:

```ts
import { SubscriptionHub } from '@orbit/core';

const hub = new SubscriptionHub(orbit);
hub.subscribe('posts(status="live") { id }', 'feed', (seq, event) => {
  console.log(seq, event); // 1 { type: 'created', id: 'p3', … }
});
hub.detach('feed');      // offline: log keeps growing
hub.resume('feed', 0, handler); // replay seq > 0
hub.unsubscribe('feed'); // release the shared adapter hook
```

See [`examples/node/streaming/08-realtime.ts`](../examples/node/streaming/08-realtime.ts) for a runnable
demo including a real disconnect → resume cycle.
