import { ErrorCode, OrbitError } from '../errors.js';
import type {
  BatchRequest,
  Filters,
  MutationArgs,
  MutationResult,
  OrbitContext,
  SubscriptionEvent,
} from '../types.js';
import type { DataAdapter } from './types.js';

export interface MemoryAdapterDefinition {
  /** Entity name this adapter serves. */
  entity: string;
  /**
   * Resolve a filter set against the in-memory data. Return an object (one
   * record) or an array (many). Use `ctx.parent` to scope relations.
   */
  resolve: (filters: Filters, ctx: OrbitContext) => unknown | Promise<unknown>;
  /** Optional mutation handler. */
  mutate?: (
    action: string,
    args: MutationArgs,
    ctx: OrbitContext,
  ) => MutationResult | Promise<MutationResult>;
  /** Optional realtime hook, relayed verbatim to the built adapter. */
  subscribe?: (filters: Filters, handler: (event: SubscriptionEvent) => void) => () => void;
}

/**
 * Builds in-memory adapters — perfect for demos, tests and local development.
 * Zero I/O, zero dependencies.
 *
 * ```ts
 * const adapters = memoryAdapter([
 *   {
 *     entity: 'user',
 *     resolve: ({ id }) => users.find((u) => u.id === id),
 *   },
 * ]);
 * ```
 */
export function memoryAdapter(definitions: MemoryAdapterDefinition[]): DataAdapter[] {
  return definitions.map((def) => ({
    entity: def.entity,
    // Deliberately NOT `async`: a sync resolver returns a plain value and the
    // engine's Promise.all still awaits it. Avoiding the async wrapper keeps
    // the hot path free of an extra microtask + promise allocation. A resolver
    // that throws synchronously propagates as a sync throw — the engine always
    // awaits, so it surfaces as a rejected pipeline either way.
    resolve(filters: Filters, ctx: OrbitContext): unknown | Promise<unknown> {
      return def.resolve(filters, ctx);
    },
    batch(requests: BatchRequest[], ctx: OrbitContext): Promise<unknown[]> {
      return Promise.all(requests.map((r) => def.resolve(r.filters, { ...ctx, parent: r.parent })));
    },
    async mutate(action: string, args: MutationArgs, ctx: OrbitContext): Promise<MutationResult> {
      if (!def.mutate) {
        throw new OrbitError(
          ErrorCode.MUTATION_FAILED,
          `Memory adapter '${def.entity}' does not support mutations`,
          { details: { entity: def.entity } },
        );
      }
      return def.mutate(action, args, ctx);
    },
    ...(def.subscribe ? { subscribe: def.subscribe } : {}),
  }));
}
