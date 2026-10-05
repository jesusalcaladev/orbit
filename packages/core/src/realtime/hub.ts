/**
 * The subscription core of the realtime layer — runtime-agnostic (no sockets
 * here). The WebSocket transport feeds it client intent; adapters feed it
 * record changes via their frozen `subscribe(filters, handler)` hook.
 *
 * Scaling rule: every client that subscribes to the SAME (entity, filters)
 * shares ONE adapter subscription. 100 clients on `posts` cost one adapter
 * hook, not 100 — the fan-out happens here, in memory.
 */
import type { Orbit } from '../engine.js';
import { ErrorCode, OrbitError } from '../errors.js';
import { parseOQS } from '../parser.js';
import type { Filters, OrbitContext, QueryNode, SubscriptionEvent } from '../types.js';

/** How many events each subscription keeps for `resume` replay (ring buffer). */
export const RESUME_LOG_MAX = 512;

/** A live subscription, as seen by the transport layer. */
export interface RealtimeSubscription {
  /** The client-visible id (provided by the client in the `subscribe` frame). */
  id: string;
  /** Stop delivery. Safe to call more than once. */
  unsubscribe(): void;
}

interface Subscriber {
  key: string;
  events: SubscriptionEvent[];
  seq: number;
  /** Delivery callback — `undefined` while detached (offline, awaiting resume). */
  onEvent?: (seq: number, event: SubscriptionEvent) => void;
}

interface Shared {
  filters: Filters;
  unsubscribe: () => void;
  subscribers: Set<Subscriber>;
}

/** Canonical form of a filter set so `{a:"1",b:"2"}` and `{b:"2",a:"1"}` match. */
function canonicalFilters(filters: Filters): string {
  // Object keys are unique, so `a[0] === b[0]` can never happen — the two
  // arms below are the whole domain (and keep the order deterministic).
  return JSON.stringify(Object.entries(filters).sort((a, b) => (a[0] > b[0] ? 1 : -1)));
}

export class SubscriptionHub {
  readonly #orbit: Orbit;
  readonly #shared = new Map<string, Shared>();
  readonly #subscribers = new Map<string, Subscriber>();

  constructor(orbit: Orbit) {
    this.#orbit = orbit;
  }

  /**
   * Register a subscription from an already-parsed (and already-gated) tree.
   * `sourceQuery` is only kept for diagnostics; the tree — not a re-parse —
   * decides the shared (entity, filters) key and the adapter hook. Skips the
   * duplicate-client bookkeeping of `subscribe` (the caller manages it).
   */
  #subscribeParsed(
    node: QueryNode,
    _sourceQuery: string,
    clientId: string,
    onEvent: (seq: number, event: SubscriptionEvent) => void,
  ): RealtimeSubscription {
    const key = `${node.entity}\u0000${canonicalFilters(node.filters)}`;

    const adapter = this.#orbit.adapters.get(node.entity);
    if (!adapter) {
      throw new OrbitError(
        ErrorCode.ENTITY_UNREGISTERED,
        `No adapter is registered for entity '${node.entity}'`,
        {
          details: { entity: node.entity },
        },
      );
    }
    if (typeof adapter.subscribe !== 'function') {
      throw new OrbitError(
        ErrorCode.SUBSCRIPTION_FAILED,
        `Adapter '${node.entity}' does not support subscriptions`,
        { details: { entity: node.entity } },
      );
    }

    // Dedupe: one adapter hook per distinct (entity, filters).
    let shared = this.#shared.get(key);
    if (!shared) {
      const unsubscribe = adapter.subscribe(node.filters, (event) => this.#fanOut(key, event));
      shared = { filters: node.filters, unsubscribe, subscribers: new Set() };
      this.#shared.set(key, shared);
    }

    const subscriber: Subscriber = { key, events: [], seq: 0, onEvent };
    shared.subscribers.add(subscriber);
    this.#subscribers.set(clientId, subscriber);

    return {
      id: clientId,
      unsubscribe: () => this.unsubscribe(clientId),
    };
  }

  /**
   * Subscribe a client to an OQS subscription (e.g. `posts(status="live")`).
   *
   * The root node's entity + filters select the adapter and its hook; nested
   * relations are not part of the event stream (each event is a
   * `SubscriptionEvent` patch). `clientId` must be unique within the hub.
   */
  subscribe(
    oqs: string,
    clientId: string,
    onEvent: (seq: number, event: SubscriptionEvent) => void,
  ): RealtimeSubscription {
    const node = parseOQS(oqs, {
      maxDepth: this.#orbit.maxQueryDepth,
      maxKeyLength: this.#orbit.maxKeyLength,
      maxValueLength: this.#orbit.maxValueLength,
      // Same cost limits as the query path: a subscription query is executed
      // by the pipeline too, so it must not be a way around them.
      maxBreadth: this.#orbit.maxQueryBreadth,
      maxComplexity: this.#orbit.maxQueryComplexity,
    });
    const key = `${node.entity}\u0000${canonicalFilters(node.filters)}`;

    const existing = this.#subscribers.get(clientId);
    if (existing !== undefined) {
      if (existing.onEvent !== undefined) {
        throw new OrbitError(
          ErrorCode.SUBSCRIPTION_FAILED,
          `A subscription '${clientId}' already exists`,
        );
      }
      if (existing.key !== key) {
        throw new OrbitError(
          ErrorCode.SUBSCRIPTION_FAILED,
          `Subscription '${clientId}' exists for a different query — resume or use a new id`,
        );
      }
      // Re-attach a detached subscription (client re-subscribed before resume).
      existing.onEvent = onEvent;
      return { id: clientId, unsubscribe: () => this.unsubscribe(clientId) };
    }

    const adapter = this.#orbit.adapters.get(node.entity);
    if (!adapter) {
      throw new OrbitError(
        ErrorCode.ENTITY_UNREGISTERED,
        `No adapter is registered for entity '${node.entity}'`,
        {
          details: { entity: node.entity },
        },
      );
    }
    if (typeof adapter.subscribe !== 'function') {
      throw new OrbitError(
        ErrorCode.SUBSCRIPTION_FAILED,
        `Adapter '${node.entity}' does not support subscriptions`,
        { details: { entity: node.entity } },
      );
    }

    // Dedupe: one adapter hook per distinct (entity, filters).
    let shared = this.#shared.get(key);
    if (!shared) {
      const unsubscribe = adapter.subscribe(node.filters, (event) => this.#fanOut(key, event));
      shared = { filters: node.filters, unsubscribe, subscribers: new Set() };
      this.#shared.set(key, shared);
    }

    const subscriber: Subscriber = { key, events: [], seq: 0, onEvent };
    shared.subscribers.add(subscriber);
    this.#subscribers.set(clientId, subscriber);

    return {
      id: clientId,
      unsubscribe: () => this.unsubscribe(clientId),
    };
  }

  /**
   * Subscribe with the session's auth context (spec §10): the query gates
   * (`onBeforeParse` rewrite + identity stamping, `onAfterParse` enrichment,
   * `onBeforeResolve` — auth plugins throw here to deny) run against the
   * parsed subscription BEFORE any adapter hook is registered. A plugin that
   * denies the query rejects the subscription with its own error (e.g.
   * `ORBIT_PERMISSION_DENIED`). The adapter `subscribe` hook stays
   * stateless — the frozen contract is untouched; authorization happens at
   * subscribe time. A `shortCircuit` return is ignored (a subscription does
   * not resolve a payload); thrown errors reject.
   */
  async authorizedSubscribe(
    oqs: string,
    clientId: string,
    onEvent: (seq: number, event: SubscriptionEvent) => void,
    ctx: OrbitContext,
  ): Promise<RealtimeSubscription> {
    // The subscription gates run the pipeline directly (not via execute), so
    // inject the engine's plugin-declared providers the same way execute does —
    // plugins and the subscription gates see identical services (spec §11 🧪).
    ctx = { ...ctx, providers: this.#orbit.providers };
    let query = oqs;
    for (const plugin of this.#orbit.plugins.list) {
      const result = await plugin.hooks.onBeforeParse?.({ query, ctx });
      if (typeof result === 'string') query = result;
    }
    const parse = (raw: string): QueryNode =>
      parseOQS(raw, {
        maxDepth: this.#orbit.maxQueryDepth,
        maxKeyLength: this.#orbit.maxKeyLength,
        maxValueLength: this.#orbit.maxValueLength,
        // Same cost limits as `subscribe` and the query path: this parse runs
        // the subscription gates, so it must not be a way around them.
        maxBreadth: this.#orbit.maxQueryBreadth,
        maxComplexity: this.#orbit.maxQueryComplexity,
      });
    let parsed = parse(query);
    for (const plugin of this.#orbit.plugins.list) {
      const result = await plugin.hooks.onAfterParse?.({ parsed, ctx });
      if (result !== undefined) parsed = result;
    }
    for (const plugin of this.#orbit.plugins.list) {
      await plugin.hooks.onBeforeResolve?.({ parsed, ctx });
    }
    // The GATES ran against the post-`onBeforeParse` query (possibly rewritten
    // by a plugin) and against the post-`onAfterParse` tree — but `subscribe`
    // re-parses its argument from scratch. Pass the gated tree through so the
    // subscription that is actually registered is EXACTLY the one that was
    // authorized: re-parsing here would drop an `onAfterParse` replacement
    // (an auth plugin that rewrites the tree to scope the subscription would
    // be silently bypassed in what gets registered), and a re-parse of the
    // raw string could even throw a parse error after the gates already
    // approved the rewritten tree.
    return this.#subscribeParsed(parsed, query, clientId, onEvent);
  }

  /**
   * Detach a subscription without releasing it: the event log keeps growing
   * (so `resume` can replay the gap) but delivery stops. Used when a socket
   * drops; the transport schedules an `unsubscribe` after its retention
   * window unless the client resumes first.
   */
  detach(clientId: string): void {
    const subscriber = this.#subscribers.get(clientId);
    if (subscriber) subscriber.onEvent = undefined;
  }

  /** Stop a subscription and release the shared adapter hook when it empties. */
  unsubscribe(clientId: string): void {
    const subscriber = this.#subscribers.get(clientId);
    if (!subscriber) return;
    this.#subscribers.delete(clientId);

    const shared = this.#shared.get(subscriber.key);
    /* v8 ignore next — a tracked subscriber always has its shared bucket
       (both are removed together); kept as a guard. */
    if (!shared) return;
    shared.subscribers.delete(subscriber);
    if (shared.subscribers.size === 0) {
      shared.unsubscribe();
      this.#shared.delete(subscriber.key);
    }
  }

  /**
   * Re-attach a (possibly detached) subscription and replay events with
   * `seq > after` (spec §10 resume).
   *
   * Resume is only honoured when the replay is **provably complete**. The ring
   * buffer retains at most `RESUME_LOG_MAX` events, so the seqs still on hand
   * are `[firstSeq, subscriber.seq]`. A client asking for everything after
   * `after` gets a gapless stream only when `after >= firstSeq - 1`; a smaller
   * `after` means events `after+1 … firstSeq-1` were dropped and a "successful"
   * replay would silently under-report changes.
   *
   * Returns `null` when the subscription is unknown or already released, and
   * **also** when continuity cannot be guaranteed (expired retention window, or
   * a cursor ahead of the server — both unresumable). Callers must treat `null`
   * as "cannot resume" and re-subscribe from scratch: a partial replay is worse
   * than a fresh start, because the client cannot tell the difference.
   */
  resume(
    clientId: string,
    after: number,
    onEvent: (seq: number, event: SubscriptionEvent) => void,
  ): RealtimeSubscription | null {
    const subscriber = this.#subscribers.get(clientId);
    if (!subscriber) return null;
    const firstSeq = subscriber.seq - subscriber.events.length + 1;
    // `after < firstSeq - 1`: the client is older than the ring (events lost).
    // `after > subscriber.seq`: the client is ahead of us, so nothing at all
    // can be replayed and its view cannot be confirmed. Neither is resumable.
    if (after < firstSeq - 1 || after > subscriber.seq) return null;
    subscriber.onEvent = onEvent;
    for (let i = 0; i < subscriber.events.length; i += 1) {
      const seq = firstSeq + i;
      if (seq > after) onEvent(seq, subscriber.events[i]!);
    }
    return { id: clientId, unsubscribe: () => this.unsubscribe(clientId) };
  }

  /** Number of active client subscriptions (useful for benchmarks/monitoring). */
  get activeCount(): number {
    return this.#subscribers.size;
  }

  /** Release every subscription and every shared adapter hook. */
  close(): void {
    for (const shared of this.#shared.values()) shared.unsubscribe();
    this.#shared.clear();
    this.#subscribers.clear();
  }

  #fanOut(key: string, event: SubscriptionEvent): void {
    const shared = this.#shared.get(key);
    if (!shared) return;
    for (const subscriber of shared.subscribers) {
      subscriber.seq += 1;
      subscriber.events.push(event);
      if (subscriber.events.length > RESUME_LOG_MAX) subscriber.events.shift();
      // Detached subscribers keep the log (for resume) but get no delivery.
      subscriber.onEvent?.(subscriber.seq, event);
    }
  }
}
