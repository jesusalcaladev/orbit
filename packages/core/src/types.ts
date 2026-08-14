/**
 * Core types of the Orbit protocol.
 *
 * These types are universal — the *shape* of your data is entirely driven by
 * the adapters and plugins you register. Orbit itself knows nothing of
 * databases, only of moving intent from client to server.
 */

/** String key–value pairs extracted from OQS, passed verbatim to adapters. */
export type Filters = Record<string, string>;

/** Where a query node came from: a client query or a mutation's `return` clause. */
export type NodeOrigin = 'client' | 'mutate';

/**
 * A parsed node of the Orbit Query Syntax tree.
 *
 * Pure data — no logic. Everything an adapter needs is either in the node or
 * in the execution context.
 */
export interface QueryNode {
  /** Entity name as written in the query, e.g. `user`, `posts`, `Product`. */
  entity: string;
  /** Exact key–value pairs from the query string, passed verbatim to adapters. */
  filters: Filters;
  /** Leaf fields requested on this node. */
  fields: string[];
  /** Nested relations, keyed by relation name (which equals the entity name). */
  relations: Record<string, QueryNode>;
  /** Whether this node came from a client query or a mutation's `return` clause. */
  origin: NodeOrigin;
}

/** Arguments of a mutation action (`do`). */
export interface MutationArgs {
  /** The record selector, passed verbatim to the adapter. */
  filter?: Filters;
  /** The new values, passed verbatim to the adapter. */
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The request envelope the client posts to the Orbit endpoint.
 *
 * Exactly one of `query` or `do` must be present.
 */
export interface OrbitEnvelope {
  /** Raw OQS string, e.g. `user(id="123") { name, posts { title } }`. */
  query?: string;
  /** Mutation action in the form `entity.action`, e.g. `user.update`. */
  do?: string;
  /** Arguments passed verbatim to the adapter's `mutate`. */
  args?: MutationArgs;
  /** Optional re-query graph returned after a successful mutation. */
  return?: string;
  /** Optional opaque cache spec, e.g. `ttl=300` or `stale=60`. */
  cache?: string;
}

/** Parent entity information available while an adapter resolves a relation. */
export interface ParentContext {
  entity: string;
  data: unknown;
}

/**
 * The minimal engine surface plugins may call into (avoids a circular type
 * dependency between `types.ts` and `engine.ts`). The engine sets `ctx.orbit`.
 */
export interface OrbitEngineLike {
  execute(envelope: OrbitEnvelope, ctx?: OrbitContext): Promise<OrbitResult>;
}

/**
 * Everything an adapter or plugin needs beyond the query itself.
 *
 * Plugins may use `state` as shared scratch space across the whole pipeline
 * and may set `contentType` to opt into a non-JSON serialization.
 */
export interface OrbitContext {
  /** The request the handler is serving (present when invoked via `handler`). */
  request?: Request;
  /** Request headers (always present when invoked via `handler`). */
  headers?: Headers;
  /** The validated envelope that started the execution. */
  envelope?: OrbitEnvelope;
  /** Parent entity info while resolving a relation. */
  parent?: ParentContext;
  /** The final raw query string after the `onBeforeParse` stage (set by the engine). */
  rawQuery?: string;
  /** Plugin/application scratch space, shared across the whole pipeline. */
  state?: Record<string, unknown>;
  /**
   * Boot-time services injected by plugins via `OrbitPlugin.provides` — the
   * engine collects them at `createOrbit` (duplicate names rejected) and
   * materializes the merged, read-only container onto every execution before
   * any hook runs. Every hook AND every adapter sees the same services;
   * registration order is irrelevant because injection happens before the
   * pipeline starts. Contrast with `state`: `providers` is boot-time
   * singletons shared across requests (frozen — read-only); `state` is
   * per-request scratch. 🧪 Experimental (spec §11, additive).
   */
  providers?: Readonly<Record<string, unknown>>;
  /** The Orbit engine instance (set by the engine itself). */
  orbit?: OrbitEngineLike;
  /** Content type override — set by plugins to opt into non-JSON serialization. */
  contentType?: string;
  /**
   * Uploaded files, keyed by field name — populated by the `handler` when the
   * request is `multipart/form-data` (the `envelope` field carries the JSON
   * envelope, every other field whose value is a `File` lands here). Adapters
   * receive this on `ctx` inside `mutate`; plugins see it too.
   *
   * Programmatic use: `orbit.execute({ do: 'user.upload' }, { files: { avatar } })`.
   */
  files?: Record<string, File>;
  /**
   * Effective cancellation signal for this execution — set by the engine
   * from the caller's `ctx.signal` plus the optional `requestTimeoutMs`
   * deadline. Adapters/plugins may listen to it to cancel their own work.
   */
  signal?: AbortSignal;
  /**
   * Response headers to merge into the handler's `Response` — set by plugins
   * or adapters during the pipeline (e.g. `set-cookie` for session login,
   * CORS, custom `cache-control`). Array values append multiple header lines
   * (`set-cookie` needs one line per cookie). Merged into every handler
   * response format (JSON, msgpack, plugin bodies) and into error responses.
   *
   * Note: for SSE streaming the headers are sent when the response starts,
   * before the pipeline runs — a pipeline-set `responseHeaders` cannot reach
   * an SSE response; pass them via the handler's `ctx` option instead.
   * `execute()` copies the pipeline's value back onto the context it
   * received, so the handler (which owns the Response) can read it.
   */
  responseHeaders?: Record<string, string | string[]>;
  [key: string]: unknown;
}

/** A single request handed to an adapter's `batch` method. */
export interface BatchRequest {
  filters: Filters;
  parent?: ParentContext;
}

/** Result of an adapter's `mutate` call. */
export interface MutationResult {
  /** Identifier of the affected record, echoed back to the client. */
  id?: string | number;
  /** Cache keys the client (or a cache plugin) should invalidate. */
  invalidates?: string[];
  [key: string]: unknown;
}

/**
 * An event pushed to a realtime subscription (`DataAdapter.subscribe`).
 *
 * The transport layer (websocket, SSE, …) relays these to subscribed clients
 * as patches, so a reconnect only replays the delta (benchmark B6) instead of
 * refetching the whole graph.
 */
export interface SubscriptionEvent {
  /** What happened to the record. */
  type: 'created' | 'updated' | 'deleted';
  /** Primary key of the affected record, when known. */
  id?: string | number;
  /** Full record after the change (`created`/`updated` events). */
  data?: unknown;
  /** Minimal change description, for cheap delta sync on reconnect. */
  patch?: Record<string, unknown>;
}

/**
 * A non-JSON payload produced by an `onBeforeSerialize` hook
 * (e.g. msgpack, SSE, protobuf). The handler serves `body` as-is with
 * `contentType`.
 */
export interface SerializedPayload {
  body: string | Uint8Array<ArrayBuffer>;
  contentType: string;
}

/**
 * One event of `orbit.stream(...)`: the graph as it becomes available,
 * level by level. The final event has `level: 'done'` with the full data.
 */
export interface OrbitStreamEvent {
  /** The resolved breadth-first level (0 = root) or `'done'` for the final payload. */
  level: number | 'done';
  /** The graph up to this level (relations of later levels are omitted). */
  data: unknown;
  /** True when the event came from a short-circuiting plugin (e.g. cache hit). */
  fromCache?: boolean;
  /** Set when a plugin serialized the final payload to a non-JSON format. */
  contentType?: string;
}

/** The structured result of `orbit.execute(...)`. */
export interface OrbitResult {
  status: number;
  /** JSON data (when the payload is JSON). */
  data?: unknown;
  /** Raw body when a plugin serialized to a non-JSON format. */
  body?: string | Uint8Array<ArrayBuffer>;
  /** Cache keys the client should invalidate after a mutation. */
  invalidates?: string[];
  /** True when the result was served by a short-circuiting plugin (e.g. cache hit). */
  fromCache?: boolean;
  /** Content type of the payload. */
  contentType: string;
}
