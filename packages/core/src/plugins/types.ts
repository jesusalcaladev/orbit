import type { OrbitError } from '../errors.js';
import type { Filters, OrbitContext, QueryNode, SerializedPayload } from '../types.js';

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
}

/** A named bundle of hooks. The core is empty of logic; plugins bring the brains. */
export interface OrbitPlugin {
  /** Unique name — used for diagnostics and duplicate detection. */
  name: string;
  hooks: Partial<OrbitHooks>;
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
];
