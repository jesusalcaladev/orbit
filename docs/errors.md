# Errors

Every failure in the protocol is an `OrbitError` — one class, predictable codes, correct HTTP statuses. Clients can rely on a single error shape:

```json
{
  "error": {
    "code": "ORBIT_ENTITY_UNREGISTERED",
    "message": "No adapter is registered for entity 'ghost'",
    "details": { "entity": "ghost" }
  }
}
```

## Codes

| Code | HTTP | When | Client action |
| :--- | :--- | :--- | :--- |
| `ORBIT_INVALID_QUERY` | 400 | OQS syntax error, malformed envelope, bad JSON | Fix the query/envelope |
| `ORBIT_ENTITY_UNREGISTERED` | 404 | No adapter matches the requested entity | Register an adapter or fix the name |
| `ORBIT_FILTER_INVALID` | 400 | The resolver rejected the filters (e.g. bad UUID) | Validate input before querying |
| `ORBIT_PERMISSION_DENIED` | 403 | Fired by an auth `onBeforeResolve` hook | Authenticate / re-authorize |
| `ORBIT_MAX_DEPTH_EXCEEDED` | 400 | Query nests deeper than `maxQueryDepth` | Flatten the query |
| `ORBIT_PAYLOAD_TOO_LARGE` | 413 | Envelope exceeds `maxPayloadBytes` | Shrink the request |
| `ORBIT_MUTATION_FAILED` | 500 | The mutation could not be executed | Inspect the server logs |
| `ORBIT_INTERNAL` | 500 | Anything unexpected | Inspect the server logs |

## The class

```ts
import { OrbitError, ErrorCode } from '@orbit/core';

throw new OrbitError(ErrorCode.FILTER_INVALID, 'Invalid UUID format', {
  details: { filter: 'id' },
  status: 422,        // optional override
});
```

`OrbitError` extends `Error`, so `instanceof` works. `ErrorStatus` maps every code to its HTTP status; `isOrbitError` and `toOrbitError` are exported for normalization.

## Normalization rules

- **Adapters** should throw `OrbitError` with precise codes when they know the cause.
- **Anything else** (plain `Error`, strings, `undefined`) becomes `ORBIT_INTERNAL` with the original message preserved as the `cause`.
- A `batch()` returning the wrong number of results is `ORBIT_INTERNAL` — the engine fails loudly instead of misaligning data.

## The `onError` hook

Every plugin can translate errors before they reach the client:

```ts
import { OrbitError, ErrorCode } from '@orbit/core';

const errorTranslator = {
  name: 'translate',
  hooks: {
    onError: ({ error }) => {
      if (error.cause && error.code === ErrorCode.INTERNAL) {
        return new OrbitError(ErrorCode.FILTER_INVALID, 'Filter was invalid');
      }
    },
  },
};
```

- Return an `OrbitError` to replace the current one.
- Return `undefined` to keep it.
- A *failing* `onError` handler never masks the original error.
