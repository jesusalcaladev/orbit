import type {
  BatchRequest,
  Filters,
  MutationArgs,
  MutationResult,
  OrbitContext,
  SubscriptionEvent,
} from '../types.js';

/**
 * The contract every data source must implement.
 *
 * The core knows nothing about databases — only that an adapter can answer a
 * filter and, optionally, batch and mutate. You decide what `resolve` does:
 * SQL, a REST call, an in-memory array, a message queue… it's just a function.
 */
export interface DataAdapter {
  /** Entity name this adapter serves, e.g. `user`. Must match query roots and relations. */
  entity: string;

  /**
   * Answer a filter set. Return an object (one record) or an array (many).
   *
   * While resolving a relation, `ctx.parent` carries the parent entity and its
   * resolved data — use it to scope the query (e.g. `WHERE author_id = parent.id`).
   */
  resolve(filters: Filters, ctx: OrbitContext): unknown | Promise<unknown>;

  /**
   * Optional batch execution for N+1 mitigation.
   *
   * When present, the core groups sibling requests of the same entity into a
   * SINGLE call instead of N round-trips. Results must align with `requests`
   * by index.
   */
  batch?(requests: BatchRequest[], ctx: OrbitContext): Promise<unknown[]>;

  /** Optional mutation handler, invoked by the `do` envelope. */
  mutate?(action: string, args: MutationArgs, ctx: OrbitContext): MutationResult | Promise<MutationResult>;

  /**
   * Optional realtime hook: register a listener for changes on this entity.
   *
   * Entity-scoped by construction (`adapter.entity`), so a separate
   * `subscribeToEntity` method would be redundant — an empty filter set means
   * "every record of this entity". Returns an unsubscribe function.
   *
   * The engine exposes this to transports (websocket, …) which relay events
   * to subscribed clients as patches.
   */
  subscribe?(filters: Filters, handler: (event: SubscriptionEvent) => void): () => void;
}

/** Anything that can look an adapter up by entity name. */
export interface AdapterRegistryLike {
  get(entity: string): DataAdapter | undefined;
}
