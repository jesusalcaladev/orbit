# Serialization & transport

Orbit speaks the wire formats your clients need — and negotiates them per request. The default is JSON; the same engine serves **MessagePack**, **SSE streaming**, and **gzip** without a single dependency.

## Format negotiation

The response format is chosen from the request's `Accept` header (`negotiateFormat`):

| `Accept` | Format | Content-Type |
| :--- | :--- | :--- |
| *(missing)* | JSON | `application/json; charset=utf-8` |
| `application/json` | JSON | `application/json; charset=utf-8` |
| `application/x-msgpack` | MessagePack (binary) | `application/x-msgpack` |
| `text/event-stream` | SSE (progressive) | `text/event-stream` |
| `*/*` | JSON | `application/json; charset=utf-8` |

- **q-values** are respected: `application/json;q=0.5, application/x-msgpack;q=0.9` serves msgpack.
- The wildcard `*/*` always falls back to **JSON** — a client that accepts everything gets the plain wire format, never an exotic one.
- Errors are serialized in the same negotiated format, so a msgpack client always gets msgpack errors.

```ts
import { negotiateFormat } from '@orbit/core';

negotiateFormat('application/x-msgpack');           // 'msgpack'
negotiateFormat('text/event-stream');               // 'sse'
negotiateFormat('application/json');                 // 'json'
negotiateFormat('application/json;q=0.5, application/x-msgpack;q=0.9'); // 'msgpack'
negotiateFormat('*/*');                              // 'json'
```

## MessagePack (zero dependencies)

Orbit ships a complete, dependency-free MessagePack codec — `encodeMsgpack` / `decodeMsgpack`:

- nil, booleans, integers (fixint / int8–64 / uint8–64), floats (32/64)
- strings (fixstr / str8 / str16 / str32), binary (bin8 / bin16 / bin32)
- arrays (fixarray / array16 / array32) and maps (fixmap / map16 / map32)
- Integers are encoded in their **smallest representation**; floats become float64.
- Objects follow JSON semantics — `undefined` values are omitted, so `{ data, fromCache, invalidates }` round-trips exactly like JSON.
- Extension types (fixext/ext) are rejected; truncated or trailing bytes throw.

```ts
import { encodeMsgpack, decodeMsgpack } from '@orbit/core';

const bytes = encodeMsgpack({ query: 'user(id="1") { name }', cache: 'ttl=300' });
const envelope = decodeMsgpack(bytes); // { query: 'user(id="1") { name }', cache: 'ttl=300' }
```

> Integer precision: values beyond 2^53 lose precision on decode (they become JS `number`). Send `bigint` or `string` if you need the full 64-bit range.

### Sending a MessagePack envelope

Post the envelope as msgpack and ask for a msgpack response:

```ts
const response = await orbit.handler(new Request('http://localhost/orbit', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-msgpack',
    'accept': 'application/x-msgpack',
  },
  body: encodeMsgpack({ query: 'user(id="1") { name, posts { title } }' }),
}));

const payload = decodeMsgpack(new Uint8Array(await response.arrayBuffer()));
```

`readMsgpackEnvelope(bytes, maxBytes)` validates the decoded envelope and enforces the payload limit — the same contract as the JSON path, so oversized bodies fail fast with `ORBIT_PAYLOAD_TOO_LARGE`.

## gzip

When the client sends `Accept-Encoding: gzip`, the handler compresses the response — for JSON **and** MessagePack. `wantsGzip` implements the q=0 exclusion:

```ts
import { wantsGzip } from '@orbit/core';
wantsGzip('gzip, deflate, br'); // true
wantsGzip('gzip;q=0');          // false
```

The response then carries `content-encoding: gzip` and the client decompresses with a standard `DecompressionStream`:

```ts
const bytes = new Uint8Array(await response.arrayBuffer());
const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
```

## SSE streaming

With `Accept: text/event-stream`, the handler streams the graph **level by level** instead of waiting for the whole tree. The root level is emitted as soon as its adapter answers; relations follow as their levels resolve. This is the TTFB win: the client starts rendering while the database is still working on the deep relations.

```text
data: {"level":0,"data":{"name":"Ana"}}

data: {"level":1,"data":{"name":"Ana","posts":[{"title":"Why Orbit?"}]}}

data: {"level":"done","data":{"name":"Ana","posts":[{"title":"Why Orbit?"}]}}
```

The last frame (`level: "done"`) carries the complete, transformed payload — including `contentType` when a plugin serialized it to a non-JSON format, and `fromCache` on cache hits.

Streaming is driven by `orbit.stream(envelope, ctx)`, an async generator the handler consumes. You can use it directly for custom transports:

```ts
for await (const event of orbit.stream({ query: 'user(id="1") { name, posts { title } }' })) {
  if (event.level === 0) renderRoot(event.data);
  if (event.level === 'done') markComplete(event.data);
}
```

Mutations are not streamable — sending `do` with `accept: text/event-stream` fails with `ORBIT_INVALID_QUERY`.

### Error semantics over SSE

Errors raised **before** the stream starts keep their real HTTP status: the handler pre-checks `content-length`, parses the envelope, and runs a dry-run `parseOQS` so `ORBIT_INVALID_QUERY` / `ORBIT_MAX_DEPTH_EXCEEDED` fail as 400 before any bytes are committed. Errors raised **mid-stream** (e.g. an entity that doesn't resolve) become SSE frames — the status must stay 200 once the event stream is committed:

```text
data: {"error":{"code":"ORBIT_ENTITY_UNREGISTERED","message":"..."}}
```

## Custom formats

`onBeforeSerialize` is the escape hatch for anything else — CSV, protobuf, XML. Return a `SerializedPayload` (`{ body, contentType }`) and the handler serves it verbatim:

```ts
hooks: {
  onBeforeSerialize: ({ data, node }) => ({
    body: toCsv(data, node.fields),
    contentType: 'text/csv',
  }),
}
```

See [examples/node/serialization/07-serializer-custom.ts](../examples/node/serialization/07-serializer-custom.ts) for a working CSV serializer.

## Size constraints

The core enforces a maximum envelope size (`maxPayloadBytes`, default 10 MiB). The handler pre-checks `content-length` **before buffering** — an oversized request fails fast with `ORBIT_PAYLOAD_TOO_LARGE` (413) without reading the body. The msgpack path enforces the same limit on the decoded bytes.
