import type { OrbitError } from '../errors.js';
import type {
  Filters,
  OrbitContext,
  OrbitEnvelope,
  OrbitResult,
  QueryNode,
  SerializedPayload,
} from '../types.js';

/** A plugin's `onBeforeResolve` can short-circuit resolution and serve data directly. */
export interface ShortCircuit {
  shortCircuit: unknown;
}

export function isShortCircuit(value: unknown): value is ShortCircuit {
  return typeof value === 'object' && value !== null && 'shortCircuit' in value;
}

export interface BeforeParseInput {
  /** The raw query string, before parsing. Return a string to replace it. */
  query: string;
  ctx: OrbitContext;
}

export interface AfterParseInput {
  /** The parsed query tree. Return a node to replace it. */
  parsed: QueryNode;
  ctx: OrbitContext;
}

export interface BeforeResolveInput {
  /** The root of the parsed query tree. */
  parsed: QueryNode;
  ctx: OrbitContext;
}

export interface BeforeExecuteInput {
  entity: string;
  filters: Filters;
  node: QueryNode;
  ctx: OrbitContext;
}

/** What an `onBeforeExecute` hook may return to adjust a request. */
export interface BeforeExecuteAdjustment {
  filters?: Filters;
  ctx?: OrbitContext;
}

export interface AfterResolveInput {
  result: unknown;
  node: QueryNode;
  ctx: OrbitContext;
}

export interface BeforeSerializeInput {
  data: unknown;
  node: QueryNode;
  ctx: OrbitContext;
}

export interface ErrorInput {
  error: OrbitError;
  ctx: OrbitContext;
}

/**
 * Input to the `onAfterExecute` hook — the pipeline's single "finally": it
 * fires once per `execute()` on BOTH the success path (`result`) and the error
 * path (`error`, already normalized by `onError`), after the `return` re-query
 * (if any) has run. Ideal for request timing/metrics that the serialize hook
 * (spec §11) alone can't see — successful mutations and cache-hit short
 * circuits in particular run no `onBeforeSerialize`.
 *
 * Hook return is ignored; errors thrown inside the hook are swallowed by the
 * engine so a broken observability sink never changes a request's outcome.
 */
export interface AfterExecuteInput {
  /** Success result (defined on the success path). */
  result?: OrbitResult;
  /** Normalized error (defined on the error path, after `onError` translation). */
  error?: OrbitError;
  /** The validated envelope that was executed. */
  envelope: OrbitEnvelope;
  ctx: OrbitContext;
}

/**
 * The hook surface of the Orbit protocol — the "nervous system" of the engine.
 *
 * The core invokes hooks in a strict sequence:
 *
 * ```text
 * parse → onBeforeParse → onAfterParse → onBeforeResolve
 *      → resolve (onBeforeExecute / onAfterResolve per node)
 *      → onBeforeSerialize → serialize
 * ```
 *
 * `onError` wraps the whole pipeline.
 */
export interface OrbitHooks {
  /** Rewrite/normalize the raw query string before parsing. */
  onBeforeParse(input: BeforeParseInput): string | void | Promise<string | void>;
  /** Enrich the parsed query (or return a replacement node). */
  onAfterParse(input: AfterParseInput): QueryNode | void | Promise<QueryNode | void>;
  /**
   * Intercept execution. Return `{ shortCircuit: data }` to serve data
   * directly — great for cache hits, mocks, or feature flags.
   */
  onBeforeResolve(input: BeforeResolveInput): ShortCircuit | void | Promise<ShortCircuit | void>;
  /** Per entity, just before the adapter runs — may tweak filters or context. */
  onBeforeExecute(
    input: BeforeExecuteInput,
  ): BeforeExecuteAdjustment | void | Promise<BeforeExecuteAdjustment | void>;
  /** Post-process the result of a resolver. Return a value to replace it. */
  onAfterResolve(input: AfterResolveInput): unknown | void | Promise<unknown | void>;
  /** Final transformation before serialization. Return a value to replace it. */
  onBeforeSerialize(
    input: BeforeSerializeInput,
  ): unknown | SerializedPayload | void | Promise<unknown | SerializedPayload | void>;
  /** Translate/normalize errors. Return an `OrbitError` to replace it. */
  onError(input: ErrorInput): OrbitError | void | Promise<OrbitError | void>;
  /**
   * Runs once per `execute()`, on success (`result`) and on error (`error`,
   * post-normalization) — the pipeline's "finally". Return is ignored; a thrown
   * error is swallowed so observability never breaks a request.
   *
   * Additive (spec §11): a new, optional hook — plugins that don't define it are
   * unaffected, and `onError` remains the only error-translation hook.
   */
  onAfterExecute(input: AfterExecuteInput): void | Promise<void>;
}

/**
 * A named bundle of hooks. The core is empty of logic; plugins bring the brains.
 *
 * A plugin may also declare boot-time services via `provides`: the engine
 * collects them (in registration order, duplicate names rejected at
 * `createOrbit` time) and injects the merged, read-only container onto every
 * request's `ctx.providers` **before any hook runs** — so every hook AND every
 * adapter sees the injected services regardless of registration order. This is
 * the first-class channel for "inject things into ctx": a Redis client, a
 * config object, a service instance — anything an adapter or a later plugin
 * needs that exists at boot.
 *
 * ```ts
 * const redisPlugin: OrbitPlugin = {
 *   name: 'redis',
 *   provides: { redis: createRedisCacheStore({ client }) },
 *   hooks: { … },
 * };
 * // adapter:
 * resolve(filters, ctx) { const store = ctx.providers?.redis; … }
 * ```
 *
 * The container is shared across requests and frozen — treat it as read-only.
 * Per-request values (a caller identity, a tenant id) belong in `ctx.state`,
 * which is per-request scratch; `provides` is boot-time singletons.
 *
 * Additive to the frozen contract (spec §11): optional field, no hook
 * signature or shape changed. 🧪 Experimental — shape may evolve before 1.0.
 */
export interface OrbitPlugin {
  /** Unique name — used for diagnostics and duplicate detection. */
  name: string;
  hooks: Partial<OrbitHooks>;
  /**
   * Boot-time services injected into every request's `ctx.providers`.
   * Keys must be unique across all mounted plugins and may not be reserved
   * prototype names (`__proto__`, `constructor`, `prototype`) — both are
   * rejected at `createOrbit` time, loudly.
   */
  provides?: Readonly<Record<string, unknown>>;
}

/** Every hook, in pipeline order (used for introspection/tests). */
export const HOOK_ORDER: (keyof OrbitHooks)[] = [
  'onBeforeParse',
  'onAfterParse',
  'onBeforeResolve',
  'onBeforeExecute',
  'onAfterResolve',
  'onBeforeSerialize',
  'onError',
  'onAfterExecute',
];
