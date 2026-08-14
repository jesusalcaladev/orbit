# @orbit/logging

First-party observability for [@orbit/core](../core) — a **dependency-free
request-timing plugin** that emits one structured log entry per operation.

## Why this package exists

The book demo hand-rolls a `timingPlugin` (start on `onBeforeResolve`, log on
`onBeforeSerialize`). This packages it once, with honest coverage: queries are
timed end-to-end and every error (query **or** mutation) is logged with its
standard `OrbitError` code, status and message.

## Install

```sh
pnpm add @orbit/logging
```

## Quick start

```ts
import { createOrbit } from '@orbit/core';
import { createLoggingPlugin } from '@orbit/logging';

const orbit = createOrbit({
  adapters,
  plugins: [createLoggingPlugin()],
});
```

Default output (one line per request):

```text
[orbit] query    200 0.42 ms  user(id="1") { name }
[orbit] mutation 500 ORBIT_MUTATION_FAILED 1.02 ms  books.create
```

Register the logging plugin **before** the cache plugin — spec §11 requires
the cache to be mounted after any `onBeforeSerialize` plugin, and logging
observes `onBeforeSerialize` to time resolved queries.

## Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `logger` | `console.log` | Sink receiving a structured `LogEntry`. |
| `now` | `performance.now` | Injectable clock (tests). |
| `maxLabelLength` | `64` | Truncate long query labels with `…`. |

## The `LogEntry` shape

```ts
interface LogEntry {
  operation: 'query' | 'mutation';
  durationMs: number;
  status: number;                       // 200, or the error status
  error?: { code: string; message: string };
  label: string;                        // the query or `do` action
  ctx: OrbitContext;
}
```

## Honest coverage notes

- **Queries that resolve** are timed from `onBeforeParse` to
  `onBeforeSerialize`.
- **Errors** (queries and mutations) are timed to `onError` with the standard
  code/status/message.
- **Cache hits** short-circuit in `onBeforeResolve` and never reach
  `onBeforeSerialize` (spec §11) — they are intentionally not timed.
- **Successful mutations** run no serialize hook (spec §5) — they are
  intentionally not timed. Use framework middleware or the adapter itself for
  write-path metrics.

## Contract

Implements the frozen `OrbitPlugin` interface (spec §11); no core changes, no
new error codes. 5 tests in `packages/logging/test/`.
