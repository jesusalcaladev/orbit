# @orbit/react

Hooks & cache for **React and React Native** over [`@orbit/client`](../client/).

**Zero transport.** This package never touches the wire: `fetch`, negotiation,
gzip, errors, abort, SSE and WebSocket all live in `@orbit/client`, which you
wrap. `@orbit/react` adds the layer that was missing: a declarative cache
(TTL + stale-while-revalidate), protocol-driven invalidation, hooks, SSR
dehydrate/hydrate, optional persistence and a cross-platform devtools panel.

```tsx
import { createReactClient, OrbitProvider, useOrbitQuery } from '@orbit/react';

const client = createReactClient({ baseUrl: '/orbit' });

function Feed() {
  const { data, isLoading } = useOrbitQuery(
    ['posts', 'feed'],
    'posts { id, title, author { name } }',
    { ttl: 30_000 },
  );
  return isLoading ? <Spinner /> : <PostList posts={data} />;
}

export function App() {
  return (
    <OrbitProvider client={client}>
      <Feed />
    </OrbitProvider>
  );
}
```

## Hooks

| Hook | What it does |
| --- | --- |
| `useOrbitQuery(key, query, options)` | Read with the cache: fresh → instant, stale → instant + background refresh, missing → fetch. |
| `useOrbitMutation(spec, options)` | `{ do, args?, return? }`; `invalidates` entities evict the cache automatically. |
| `useOrbitSubscription(key, query, options)` | Live events over the shared WebSocket (reconnect + `resume` handled by the transport). |
| `useOrbitStream(key, query, options)` | SSE levels as they arrive (`frames` grows, `isDone` at the end). |
| `useOrbitClient()` | The imperative cache API from any component. |

## Imperative cache API

`prefetch`, `invalidate(key | predicate)`, `setQueryData`, `getQueryData`,
`dehydrate`/`hydrate` (SSR), `persistClient`/`hydrateClient` (AsyncStorage /
localStorage), `clear`.

## Devtools

`@orbit/react/devtools` ships a floating panel that works on **both** web and
React Native — the same component tree renders through injectable primitives:

```tsx
import { OrbitDevtools } from '@orbit/react/devtools';

<OrbitProvider client={client}>
  <App />
  <OrbitDevtools client={client} />
</OrbitProvider>
```

On React Native, pass the `react-native` components as `primitives` — see
`src/devtools/ui.tsx` for the wiring. Persist with AsyncStorage:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hydrateClient, persistClient } from '@orbit/react';

await hydrateClient(client, AsyncStorage);
await persistClient(client, AsyncStorage); // after mutations
```

## Tests

```bash
pnpm --filter @orbit/react test        # vitest (jsdom)
pnpm --filter @orbit/react typecheck
```
