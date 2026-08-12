# Realtime — WebSocket subscriptions

Orbit's realtime transport (spec §10): a **zero-dependency WebSocket server**
that streams adapter `subscribe` events to clients, keeps subscription state
across disconnects, and replays missed patches on resume.

The transport is Node-specific (`node:http`). The `SubscriptionHub` it uses is
runtime-agnostic and can be driven by any transport later (SSE, uWebSockets…).

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

See [`examples/08-realtime.ts`](../examples/08-realtime.ts) for a runnable
demo including a real disconnect → resume cycle.
