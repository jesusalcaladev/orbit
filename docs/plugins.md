# Plugins

The plugin system is the heart of Orbit. The core is **empty of logic** — all intelligence lives in the plugins you register. Plugins hook into the query lifecycle at well-defined points, in strict order.

## Pipeline order

```text
parse → onBeforeParse → onAfterParse → onBeforeResolve
     → resolve (onBeforeExecute / onAfterResolve per node)
     → onBeforeSerialize → serialize
```

`onError` wraps the entire pipeline.

## The plugin contract

```ts
import type { OrbitPlugin, OrbitError, ErrorCode } from '@orbit/core';

const myPlugin: OrbitPlugin = {
  name: 'my-plugin',          // unique, non-empty
  hooks: {
    // ...
  },
};
```

Register plugins in the order their hooks should run:

```ts
const orbit = createOrbit({
  adapters,
  plugins: [authPlugin, createCachePlugin()],
});
```

`PluginRegistry` is also exported for programmatic mounting (`registry.register(...)`); it rejects duplicate names at startup.

## Hook reference

### `onBeforeParse` — rewrite the query

Receives the raw query string. Return a string to replace it — perfect for aliases, tenant prefixes, or normalization.

```ts
hooks: {
  onBeforeParse: ({ query }) => query.replace(/\bu\s*\(/, 'user('),
}
```

### `onAfterParse` — enrich or replace the parsed tree

Receives the parsed `QueryNode`. Return a node to replace it, or mutate/`ctx.state` for later hooks.

```ts
hooks: {
  onAfterParse: ({ parsed, ctx }) => {
    const state = (ctx.state ??= {});
    state.viewer = 'ana'; // shared with every later hook
  },
}
```

### `onBeforeResolve` — intercept execution (short-circuit)

The last chance to serve data **without touching adapters**. Return `{ shortCircuit: data }` to skip resolution entirely — this is how the cache plugin serves hits and how you'd mock an endpoint.

```ts
hooks: {
  onBeforeResolve: ({ parsed, ctx }) => {
    if (ctx.state?.viewer !== 'admin') {
      throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Admin required');
    }
  },
}
```

### `onBeforeExecute` — per entity, just before the adapter

Runs once per request (per parent). May adjust the filters or the request context:

```ts
hooks: {
  onBeforeExecute: ({ entity, filters }) => {
    if (entity === 'post') return { filters: { ...filters, status: 'published' } };
  },
}
```

### `onAfterResolve` — post-process a resolved result

Runs per request after the adapter returns. Return a value to replace the result — projection, denormalization, masking:

```ts
hooks: {
  onAfterResolve: ({ result }) =>
    isRecord(result) ? { ...result, email: '***' } : result,
}
```

### `onBeforeSerialize` — final transformation before the wire

Receives the assembled data. Return a value to replace it, or a `SerializedPayload` to switch formats entirely:

```ts
hooks: {
  onBeforeSerialize: ({ data }) => ({
    body: JSON.stringify(data),
    contentType: 'application/x-msgpack', // swap in msgpackr here
  }),
}
```

A `SerializedPayload` is `{ body: string | Uint8Array, contentType: string }`. When returned, the handler serves the body **as-is** with that content type. This is the extension point for msgpack, CSV, protobuf, SSE, etc.

### `onError` — translate errors

Receives the normalized `OrbitError`; return an `OrbitError` to replace it:

```ts
hooks: {
  onError: ({ error }) => {
    if (error.code === ErrorCode.INTERNAL) {
      return new OrbitError(ErrorCode.FILTER_INVALID, 'Filter was bad');
    }
  },
}
```

A failing `onError` handler never masks the original error.

## Context & shared state

All hooks receive `ctx`, an `OrbitContext` that is shared across the whole execution:

- `ctx.request`, `ctx.headers` — the request (when served via `handler`).
- `ctx.envelope` — the validated envelope.
- `ctx.parent` — parent entity/data while resolving a relation.
- `ctx.state` — plugin scratch space (`state ??= {}`).
- `ctx.orbit` — the engine (for background work, as the cache plugin does).
- `ctx.rawQuery` — the final raw query after `onBeforeParse`.

## Built-in: the cache plugin

```ts
import { createCachePlugin } from '@orbit/core';

const cache = createCachePlugin();           // in-memory store
// or: createCachePlugin({ store: myRedisStore })  // any CacheStore
```

### Behavior

Reads the cache spec from `envelope.cache` or the `x-orbit-cache` header:

| Spec | Behavior |
| :--- | :--- |
| `ttl=N` | Serve while younger than N s; refetch after |
| `stale=N` | Always serve; background refresh past N s |
| `ttl=N,stale=M` | Fresh for N s; serve + background refresh until N+M s; refetch after |

A spec with neither value falls back to `defaultTtl` (300 s).

### Plugin ordering matters

Cache hits are served **as-is** — the engine does not re-run `onBeforeSerialize` on short-circuited data. Register the cache plugin **after** any plugin that transforms data in `onBeforeSerialize` (masking, projection, wrapping), so the stored value is the final payload:

```ts
plugins: [maskPlugin, createCachePlugin()]  // ✓ cached value is final
plugins: [createCachePlugin(), maskPlugin]  // ✗ cached value is pre-transform
```

### Invalidation

Mutations return `invalidates` keys (`cache:user:123`) for the **client** to clear. The server-side store keys look like `orbit:<hash>` (`cache.keyFor(node)`), so server-side invalidation is explicit:

```ts
cache.invalidate(cache.keyFor(parsedNode));   // one key
cache.invalidatePrefix('orbit:');             // by prefix
cache.clear();                                // everything
```

### Bring your own store

`CacheStore` is a 6-method interface — implement it over Redis, Memcached, Cloudflare KV, or anything else:

```ts
export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  keys?(): IterableIterator<string>; // optional — powers prefix invalidation
}
```
