/**
 * @orbit/logging — first-party observability for @orbit/core.
 *
 * A dependency-free plugin that times each request through the hook pipeline
 * and emits one structured log entry per operation. Queries are timed from
 * `onBeforeParse` to `onBeforeSerialize`; failures (queries **and**
 * mutations) are logged from `onError` with their `OrbitError` code, status
 * and message.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { createLoggingPlugin } from '@orbit/logging';
 *
 * const orbit = createOrbit({
 *   adapters,
 *   plugins: [createLoggingPlugin()],
 * });
 * ```
 *
 * Register the logging plugin **before** the cache plugin (spec §11: the
 * cache must be mounted after any `onBeforeSerialize` plugin, and logging
 * observes `onBeforeSerialize` to time resolved queries).
 *
 * Honest coverage note: a cache **hit** short-circuits in `onBeforeResolve`
 * and never reaches `onBeforeSerialize`, and a successful **mutation** runs
 * no serialize hook (spec §5) — so those two paths are not timed by this
 * plugin. Every error path is, and so is every query that actually resolves.
 */
import type { OrbitContext, OrbitPlugin } from '@orbit/core';

/** One structured log entry emitted per request. */
export interface LogEntry {
  /** Whether the request was a `query` or a `do` mutation. */
  operation: 'query' | 'mutation';
  /** Wall time in ms from `onBeforeParse` to serialize/error. */
  durationMs: number;
  /** HTTP status (200 on success, the error status otherwise). */
  status: number;
  /** Present on failures — the standard error code and message. */
  error?: { code: string; message: string };
  /** The query/`do` label, truncated to `maxLabelLength`. */
  label: string;
  ctx: OrbitContext;
}

export interface LoggingPluginOptions {
  /** Sink for entries. Default: `console.log` with a compact one-line format. */
  logger?: (entry: LogEntry) => void;
  /** Injectable clock (tests). Default: `performance.now`. */
  now?: () => number;
  /** Truncate long query labels to this many characters. Default 64. */
  maxLabelLength?: number;
}

const START_KEY = 'orbit:logging:start';
const META_KEY = 'orbit:logging:meta';

interface Meta {
  operation: 'query' | 'mutation';
  label: string;
}

function truncate(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

function defaultLogger(entry: LogEntry): void {
  const { operation, durationMs, status, error, label } = entry;
  const code = error ? ` ${error.code}` : '';
  console.log(
    `[orbit] ${operation.padEnd(8)} ${status}${code} ${durationMs.toFixed(2)} ms  ${label}`,
  );
}

/** Build a request-timing plugin around the hook pipeline. */
export function createLoggingPlugin(options: LoggingPluginOptions = {}): OrbitPlugin {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => performance.now());
  const maxLabelLength = options.maxLabelLength ?? 64;

  const readMeta = (ctx: OrbitContext): { start: number; meta: Meta } | undefined => {
    const start = ctx.state?.[START_KEY] as number | undefined;
    const meta = ctx.state?.[META_KEY] as Meta | undefined;
    if (start === undefined || meta === undefined) return undefined;
    return { start, meta };
  };

  const clear = (ctx: OrbitContext) => {
    // State is guaranteed to exist when timing was found (readMeta reads it),
    // but optional chaining keeps this safe for direct hook invocations.
    delete ctx.state?.[START_KEY];
    delete ctx.state?.[META_KEY];
  };

  return {
    name: 'orbit-logging',
    hooks: {
      onBeforeParse({ ctx }) {
        // Runs for queries AND mutations (the engine invokes onBeforeParse
        // once before every mutation), so the start stamp covers both.
        const state = (ctx.state ??= {});
        const envelope = ctx.envelope;
        const operation = envelope?.do !== undefined ? 'mutation' : 'query';
        const label = envelope?.do ?? envelope?.query ?? '?';
        state[START_KEY] = now();
        state[META_KEY] = { operation, label: truncate(label, maxLabelLength) };
      },

      onBeforeSerialize({ ctx }) {
        const timing = readMeta(ctx);
        // Only resolved queries reach serialize; mutations don't (spec §5)
        // and cache hits short-circuit before it (spec §11).
        if (timing?.meta.operation !== 'query') return;
        clear(ctx);
        logger({
          operation: 'query',
          durationMs: now() - timing.start,
          status: 200,
          label: timing.meta.label,
          ctx,
        });
      },

      onError({ error, ctx }) {
        const timing = readMeta(ctx);
        if (!timing) return;
        clear(ctx);
        logger({
          operation: timing.meta.operation,
          durationMs: now() - timing.start,
          status: error.status,
          error: { code: error.code, message: error.message },
          label: timing.meta.label,
          ctx,
        });
      },
    },
  };
}
