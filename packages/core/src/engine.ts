import { AdapterRegistry } from './adapters/registry.js';
import type { DataAdapter } from './adapters/types.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  readEnvelopeBytes,
  readMsgpackEnvelope,
  validateEnvelope,
} from './envelope.js';
import { ErrorCode, isOrbitError, OrbitError, toOrbitError } from './errors.js';
import { DEFAULT_MAX_DEPTH, parseOQS } from './parser.js';
import { PluginRegistry } from './plugins/registry.js';
import { isShortCircuit } from './plugins/types.js';
import type { OrbitPlugin } from './plugins/types.js';
import {
  MSGPACK_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  negotiateFormat,
  wantsGzip,
} from './serialize/negotiate.js';
import type { OrbitFormat } from './serialize/negotiate.js';
import { encodeMsgpack } from './serialize/msgpack.js';
import { createCachePlugin } from './plugins/cache.js';
import type {
  BatchRequest,
  Filters,
  MutationResult,
  NodeOrigin,
  OrbitContext,
  OrbitEnvelope,
  OrbitResult,
  OrbitStreamEvent,
  ParentContext,
  QueryNode,
  SerializedPayload,
} from './types.js';
import { isRecord, setOwn } from './utils.js';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** A fetch-compatible handler function for Orbit queries. Takes a Request and returns a Promise<Response>. */
export type OrbitHandler = (request: Request) => Promise<Response>;

/** Max entries in the parse LRU — bounded so a hot client can't grow it forever. */
const PARSE_CACHE_MAX = 256;

export interface OrbitConfig {
  /** Adapters to mount (entity → data source). */
  adapters?: DataAdapter[] | AdapterRegistry;
  /** Plugins to mount, in hook execution order. */
  plugins?: OrbitPlugin[] | PluginRegistry;
  /** Maximum relation nesting depth. Default 10. */
  maxQueryDepth?: number;
  /** Maximum envelope size in bytes. Default 10 MiB. */
  maxPayloadBytes?: number;
  /** Optional cache plugin configuration. When set, automatically mounts
   *  `createCachePlugin` with these options and integrates caching into the
   *  handler (reads cache spec from `envelope.cache` or `x-orbit-cache` header). */
  cache?: import('./plugins/cache.js').CachePluginOptions;
}

interface OrbitOptions {
  adapters: AdapterRegistry;
  plugins: PluginRegistry;
  maxQueryDepth: number;
  maxPayloadBytes: number;
}

interface SerializeOutcome {
  data?: unknown;
  payload?: SerializedPayload['body'];
  contentType: string;
}

/** The terminal value of the query pipeline generator. */
interface QueryFinal {
  data?: unknown;
  body?: SerializedPayload['body'];
  fromCache: boolean;
  contentType: string;
}

/** One yielded stage of the query pipeline (one resolved breadth-first level). */
interface QueryStage {
  level: number;
  data: unknown;
}

interface Pending {
  node: QueryNode;
  parent?: ParentContext;
  set: (value: unknown) => void;
}

/**
 * The Orbit engine: a functional pipeline that knows nothing of databases,
 * only of moving data through hooks.
 *
 * ```text
 * parse → onBeforeParse → onAfterParse → onBeforeResolve
 *      → resolve (onBeforeExecute / onAfterResolve per node, level by level)
 *      → onBeforeSerialize → serialize
 * ```
 */
export class Orbit {
  readonly #options: OrbitOptions;
  /** LRU of parsed query trees — only used when no plugins can mutate them. */
  readonly #parseCache = new Map<string, QueryNode>();

  constructor(options: OrbitOptions) {
    this.#options = options;
  }

  /**
   * Parse with a bounded LRU cache keyed by origin, depth and raw query.
   *
   * Only safe when no plugins are mounted: `onAfterParse` receives the tree
   * and could mutate it, which would corrupt the shared cache entry. With an
   * empty plugin list the tree is read-only, so repeat queries skip parsing.
   */
  #parse(query: string, origin: NodeOrigin): QueryNode {
    const key = `${origin}\u0000${this.#options.maxQueryDepth}\u0000${query}`;
    const hit = this.#parseCache.get(key);
    if (hit !== undefined) {
      // Refresh recency (Map is insertion-ordered).
      this.#parseCache.delete(key);
      this.#parseCache.set(key, hit);
      return hit;
    }
    const node = parseOQS(query, { maxDepth: this.#options.maxQueryDepth, origin });
    this.#parseCache.set(key, node);
    if (this.#parseCache.size > PARSE_CACHE_MAX) {
      const oldest = this.#parseCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#parseCache.delete(oldest);
    }
    return node;
  }

  /** Plugins in registration order. */
  get plugins(): PluginRegistry {
    return this.#options.plugins;
  }

  /** Registered adapters. */
  get adapters(): AdapterRegistry {
    return this.#options.adapters;
  }

  /** Maximum relation nesting depth (used by the realtime hub too). */
  get maxQueryDepth(): number {
    return this.#options.maxQueryDepth;
  }

  /**
   * Execute an envelope and return a structured result. Framework-agnostic —
   * use `handler` when you want a fetch-compatible `Response`.
   */
  async execute(envelope: OrbitEnvelope, ctx: OrbitContext = {}): Promise<OrbitResult> {
    const valid = validateEnvelope(envelope);
    const fullCtx: OrbitContext = { ...ctx, envelope: valid, orbit: this };
    try {
      if (valid.do !== undefined) return await this.#executeMutation(valid, fullCtx);
      return await this.#consumeQuery(valid, fullCtx);
    } catch (error) {
      throw await this.#normalizeError(error, fullCtx);
    }
  }

  /**
   * Stream a query's graph as it becomes available, level by level.
   *
   * The root level is emitted as soon as its adapter answers; relations are
   * emitted as their levels resolve. The final event has `level: 'done'` with
   * the complete, transformed payload. Mutations are not streamable.
   */
  async *stream(envelope: OrbitEnvelope, ctx: OrbitContext = {}): AsyncGenerator<OrbitStreamEvent> {
    const valid = validateEnvelope(envelope);
    const fullCtx: OrbitContext = { ...ctx, envelope: valid, orbit: this };
    if (valid.do !== undefined) {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        "Streaming supports queries only (no 'do' actions)",
      );
    }
    try {
      const gen = this.#queryStages(valid, fullCtx);
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          const final = step.value;
          yield {
            level: 'done',
            data: final.body ?? final.data,
            ...(final.body !== undefined ? { contentType: final.contentType } : {}),
            ...(final.fromCache ? { fromCache: true } : {}),
          };
          return;
        }
        yield { level: step.value.level, data: step.value.data };
      }
    } catch (error) {
      throw await this.#normalizeError(error, fullCtx);
    }
  }

  /**
   * A fetch-compatible HTTP handler with full content negotiation.
   *
   * - **Input:** JSON or MessagePack envelopes (`Content-Type`).
   * - **Output:** negotiated from `Accept` — JSON (default), `application/x-msgpack`,
   *   or `text/event-stream` (progressive graph streaming).
   * - **Compression:** gzip via `Accept-Encoding` when the runtime supports it.
   */
  async handler(request: Request, ctx: OrbitContext = {}): Promise<Response> {
    const base: OrbitContext = { ...ctx, request, headers: request.headers };
    const format = negotiateFormat(request.headers.get('accept'));
    const gzip = wantsGzip(request.headers.get('accept-encoding'));
    try {
      // Cheap pre-check before buffering: reject oversized bodies early.
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > this.#options.maxPayloadBytes) {
        throw new OrbitError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          'Request payload exceeds the configured limit',
          {
            details: { maxBytes: this.#options.maxPayloadBytes, received: declared },
          },
        );
      }

      const raw = new Uint8Array(await request.arrayBuffer());
      const isMsgpack = (request.headers.get('content-type') ?? '').includes(MSGPACK_CONTENT_TYPE);
      // Bytes-aware read: uses the known byte length and decodes once.
      const envelope = isMsgpack
        ? readMsgpackEnvelope(raw, this.#options.maxPayloadBytes)
        : readEnvelopeBytes(raw, this.#options.maxPayloadBytes);

      if (format === 'sse') {
        // Fail fast on query syntax errors BEFORE committing to a 200 stream:
        // only resolution-stage errors (e.g. an entity that doesn't resolve)
        // become SSE frames. Without this, ORBIT_INVALID_QUERY would be a 200.
        parseOQS(envelope.query ?? '', { maxDepth: this.#options.maxQueryDepth });
        return this.#sseResponse(this.stream(envelope, base), gzip, base);
      }

      const result = await this.execute(envelope, base);
      return await this.#toResponse(result, format, gzip);
    } catch (error) {
      // `execute` already normalizes (running onError hooks once); only
      // normalize raw errors here so translators never run twice.
      const orbitError = isOrbitError(error) ? error : await this.#normalizeError(error, base);
      return this.#errorResponse(orbitError, format, gzip);
    }
  }

  async #consumeQuery(
    envelope: OrbitEnvelope,
    ctx: OrbitContext,
    origin: NodeOrigin = 'client',
  ): Promise<OrbitResult> {
    const gen = this.#queryStages(envelope, ctx, origin);
    let final: QueryFinal;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        final = step.value;
        break;
      }
    }
    return {
      status: 200,
      ...(final!.body !== undefined ? { body: final!.body } : { data: final!.data ?? null }),
      fromCache: final!.fromCache,
      contentType: final!.contentType,
    };
  }

  /**
   * The query pipeline as an async generator: hooks → level-by-level
   * resolution → serialization. `execute` and `stream` both consume it.
   */
  async *#queryStages(
    envelope: OrbitEnvelope,
    ctx: OrbitContext,
    origin: NodeOrigin = 'client',
  ): AsyncGenerator<QueryStage, QueryFinal> {
    if (typeof envelope.query !== 'string') {
      throw new OrbitError(ErrorCode.INVALID_QUERY, "Missing 'query' string in envelope");
    }

    // 1. onBeforeParse — plugins may rewrite the raw query.
    let raw = envelope.query;
    for (const plugin of this.#options.plugins.list) {
      const result = await plugin.hooks.onBeforeParse?.({ query: raw, ctx });
      if (typeof result === 'string') raw = result;
    }
    ctx.rawQuery = raw;

    // 2. Parse. With no plugins the tree is immutable (nothing can mutate it
    // via onAfterParse), so repeat queries skip parsing via the LRU.
    let parsed =
      this.#options.plugins.list.length === 0
        ? this.#parse(raw, origin)
        : parseOQS(raw, { maxDepth: this.#options.maxQueryDepth, origin });

    // 3. onAfterParse — enrich or replace the parsed tree.
    for (const plugin of this.#options.plugins.list) {
      const result = await plugin.hooks.onAfterParse?.({ parsed, ctx });
      if (result !== undefined) parsed = result;
    }

    // 4. onBeforeResolve — a plugin may short-circuit (cache hit, mock…).
    // Short-circuited data is served as-is: the cache plugin stores the FINAL
    // serialized value, so re-running onBeforeSerialize on hits would double
    // every transformation. Register the cache plugin AFTER transformers.
    for (const plugin of this.#options.plugins.list) {
      const result = await plugin.hooks.onBeforeResolve?.({ parsed, ctx });
      if (isShortCircuit(result)) {
        return { data: result.shortCircuit, fromCache: true, contentType: JSON_CONTENT_TYPE };
      }
    }

    // 5. Resolve the graph level by level (BFS with per-entity batching).
    const levels = this.#resolveLevels(parsed, ctx);
    let rootValue: unknown;
    let level = 0;
    for (;;) {
      const step = await levels.next();
      if (step.done) {
        rootValue = step.value;
        break;
      }
      yield { level: level++, data: step.value };
    }

    // 6. onBeforeSerialize — final transformation before the wire.
    const outcome = await this.#applyBeforeSerialize(rootValue, parsed, ctx);
    return {
      ...(outcome.payload !== undefined ? { body: outcome.payload } : { data: outcome.data }),
      fromCache: false,
      contentType: outcome.contentType,
    };
  }

  async #executeMutation(envelope: OrbitEnvelope, ctx: OrbitContext): Promise<OrbitResult> {
    const action = envelope.do!;
    const separator = action.indexOf('.');
    if (separator <= 0 || separator === action.length - 1) {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        `Mutation action '${action}' must be in the form 'entity.action'`,
      );
    }
    const entity = action.slice(0, separator);
    const verb = action.slice(separator + 1);

    const adapter = this.#options.adapters.get(entity);
    if (!adapter) {
      throw new OrbitError(
        ErrorCode.ENTITY_UNREGISTERED,
        `No adapter is registered for entity '${entity}'`,
        {
          details: { entity },
        },
      );
    }
    if (typeof adapter.mutate !== 'function') {
      throw new OrbitError(
        ErrorCode.MUTATION_FAILED,
        `Adapter '${entity}' does not support mutations`,
        { details: { entity, action } },
      );
    }

    const result = await adapter.mutate(verb, envelope.args ?? {}, ctx);
    const mutation: MutationResult = isRecord(result) ? result : {};
    const invalidates =
      Array.isArray(mutation.invalidates) && mutation.invalidates.length > 0
        ? mutation.invalidates
        : undefined;

    // Optional re-query of the affected sub-graph. Executed through the SAME
    // query pipeline as a client query (spec §5: "hooks included") — auth
    // gates like `onBeforeResolve` must apply here, or a mutation's `return`
    // would be an authorization bypass. Nodes are stamped `origin: 'mutate'`
    // (per docs/oqs.md): the re-query is a server-initiated read, and plugins
    // may want to distinguish it. The sub-envelope carries no `cache` field,
    // so an envelope-level cache spec never applies to the re-query (a
    // post-mutation read should be fresh); only an explicit `x-orbit-cache`
    // header opts into caching.
    if (typeof envelope.return === 'string') {
      const subEnvelope: OrbitEnvelope = { query: envelope.return };
      const result = await this.#consumeQuery(
        subEnvelope,
        { ...ctx, envelope: subEnvelope },
        'mutate',
      );
      return { ...result, ...(invalidates ? { invalidates } : {}) };
    }

    return {
      status: 200,
      data: { success: true, ...(mutation.id !== undefined ? { id: mutation.id } : {}) },
      ...(invalidates ? { invalidates } : {}),
      contentType: JSON_CONTENT_TYPE,
    };
  }

  /**
   * Resolve one breadth-first level at a time, yielding the (still mutating)
   * root value after every level. Returns the complete graph when exhausted.
   */
  async *#resolveLevels(root: QueryNode, ctx: OrbitContext): AsyncGenerator<unknown, unknown> {
    let rootValue: unknown;
    let level: Pending[] = [
      {
        node: root,
        set: (value) => {
          rootValue = value;
        },
      },
    ];

    while (level.length > 0) {
      level = await this.#resolveLevel(level, ctx);
      yield rootValue;
    }
    return rootValue;
  }

  /**
   * Resolve one level of the query tree.
   *
   * Requests are grouped by entity: when an adapter implements `batch`, all
   * sibling requests of the same entity become ONE call (the N+1 fix); when it
   * does not, they resolve in parallel. Relations discovered here become the
   * next level, carrying their parent's resolved data in `ctx.parent`.
   */
  async #resolveLevel(pendings: Pending[], ctx: OrbitContext): Promise<Pending[]> {
    const nextLevel: Pending[] = [];

    const groups = new Map<string, Pending[]>();
    for (const pending of pendings) {
      const list = groups.get(pending.node.entity);
      if (list) list.push(pending);
      else groups.set(pending.node.entity, [pending]);
    }

    for (const [entity, group] of groups) {
      const adapter = this.#options.adapters.get(entity);
      if (!adapter) {
        throw new OrbitError(
          ErrorCode.ENTITY_UNREGISTERED,
          `No adapter is registered for entity '${entity}'`,
          {
            details: { entity },
          },
        );
      }

      const requests: Array<{ pending: Pending; filters: Filters; ctx: OrbitContext }> = [];
      for (const pending of group) {
        let filters = { ...pending.node.filters };
        let requestCtx: OrbitContext = { ...ctx, parent: pending.parent };
        for (const plugin of this.#options.plugins.list) {
          const adjustment = await plugin.hooks.onBeforeExecute?.({
            entity,
            filters,
            node: pending.node,
            ctx: requestCtx,
          });
          if (adjustment?.filters) filters = { ...adjustment.filters };
          if (adjustment?.ctx) requestCtx = { ...requestCtx, ...adjustment.ctx };
        }
        requests.push({ pending, filters, ctx: requestCtx });
      }

      // One round-trip when the adapter can batch; otherwise parallel resolves.
      let results: unknown[];
      if (requests.length > 1 && typeof adapter.batch === 'function') {
        const batchRequests: BatchRequest[] = requests.map((r) => ({
          filters: r.filters,
          parent: r.ctx.parent,
        }));
        results = await adapter.batch!(batchRequests, ctx);
        if (!Array.isArray(results) || results.length !== requests.length) {
          throw new OrbitError(
            ErrorCode.INTERNAL,
            `Batch for entity '${entity}' must return exactly ${requests.length} results`,
            {
              details: {
                entity,
                expected: requests.length,
                got: Array.isArray(results) ? results.length : typeof results,
              },
            },
          );
        }
      } else {
        results = await Promise.all(requests.map((r) => adapter.resolve(r.filters, r.ctx)));
      }

      // Post-process, project and expand relations.
      for (let i = 0; i < requests.length; i += 1) {
        const request = requests[i]!;
        let result = results[i];
        for (const plugin of this.#options.plugins.list) {
          const transformed = await plugin.hooks.onAfterResolve?.({
            result,
            node: request.pending.node,
            ctx: request.ctx,
          });
          if (transformed !== undefined) result = transformed;
        }

        const projected = this.#project(request.pending.node, result);
        request.pending.set(projected);

        for (const [name, relation] of Object.entries(request.pending.node.relations)) {
          if (Array.isArray(projected)) {
            for (let j = 0; j < projected.length; j += 1) {
              const item = projected[j];
              if (!isRecord(item)) continue;
              const parentData = Array.isArray(result) ? result[j] : result;
              nextLevel.push({
                node: relation,
                parent: { entity, data: parentData },
                set: (value) => {
                  if (value !== undefined) {
                    // Own property: a relation named `__proto__` must not
                    // rewrite the item's prototype (see utils#setOwn).
                    setOwn(item, name, value);
                  }
                },
              });
            }
          } else if (isRecord(projected)) {
            nextLevel.push({
              node: relation,
              parent: { entity, data: result },
              set: (value) => {
                if (value !== undefined) {
                  // Own property: same protection as the array branch above.
                  setOwn(projected, name, value);
                }
              },
            });
          }
        }
      }
    }

    return nextLevel;
  }

  /**
   * Project a node onto resolved data: keep only the requested leaf fields.
   * Arrays are mapped item-by-item. When the node selects nothing at all,
   * the whole value is returned as-is.
   */
  #project(node: QueryNode, data: unknown): unknown {
    if (Array.isArray(data)) return data.map((item) => this.#project(node, item));
    if (!isRecord(data)) return data;
    if (node.fields.length === 0 && Object.keys(node.relations).length === 0) return data;
    const out: Record<string, unknown> = {};
    for (const field of node.fields) {
      if (field in data) {
        // Fast path: only `__proto__` carries the prototype-setter trap, so
        // only it needs defineProperty. Plain assignment stays the hot path
        // (projection runs per node, per level, per record).
        if (field === '__proto__') {
          setOwn(out, field, data[field]);
        } else {
          out[field] = data[field];
        }
      }
    }
    return out;
  }

  async #applyBeforeSerialize(
    data: unknown,
    node: QueryNode,
    ctx: OrbitContext,
  ): Promise<SerializeOutcome> {
    let current = data;
    for (const plugin of this.#options.plugins.list) {
      const result = await plugin.hooks.onBeforeSerialize?.({
        data: current,
        node,
        ctx,
      });
      if (result === undefined) continue;
      const payload = result as SerializedPayload;
      if (isRecord(payload) && typeof payload.contentType === 'string') {
        const body = payload.body;
        if (typeof body === 'string' || body instanceof Uint8Array) {
          return { payload: body, contentType: payload.contentType };
        }
      }
      current = result;
    }
    return { data: current, contentType: ctx.contentType ?? JSON_CONTENT_TYPE };
  }

  async #toResponse(result: OrbitResult, format: OrbitFormat, gzip: boolean): Promise<Response> {
    // A plugin payload is an explicit override — served verbatim, but still
    // compressed when the client asked for gzip.
    if (result.body !== undefined) {
      const headers: Record<string, string> = { 'content-type': result.contentType };
      if (gzip) {
        const bytes =
          typeof result.body === 'string' ? new TextEncoder().encode(result.body) : result.body;
        headers['content-encoding'] = 'gzip';
        return new Response(await gzipBytes(bytes), { status: result.status, headers });
      }
      return new Response(result.body as BodyInit, { status: result.status, headers });
    }

    const payload = {
      data: result.data ?? null,
      ...(result.fromCache ? { fromCache: true } : {}),
      ...(result.invalidates ? { invalidates: result.invalidates } : {}),
    };

    if (format === 'msgpack') {
      const bytes = encodeMsgpack(payload);
      const headers: Record<string, string> = { 'content-type': MSGPACK_CONTENT_TYPE };
      if (gzip) {
        headers['content-encoding'] = 'gzip';
        return new Response(await gzipBytes(bytes), { status: result.status, headers });
      }
      return new Response(bytes, { status: result.status, headers });
    }

    const body = JSON.stringify(payload);
    if (gzip) {
      return new Response(await gzipBytes(new TextEncoder().encode(body)), {
        status: result.status,
        headers: { 'content-type': JSON_CONTENT_TYPE, 'content-encoding': 'gzip' },
      });
    }
    return new Response(body, {
      status: result.status,
      headers: { 'content-type': JSON_CONTENT_TYPE },
    });
  }

  async #errorResponse(
    orbitError: OrbitError,
    format: OrbitFormat,
    gzip: boolean,
  ): Promise<Response> {
    const payload = orbitError.toJSON();
    if (format === 'sse') {
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: orbitError.status,
        headers: { 'content-type': SSE_CONTENT_TYPE, 'cache-control': 'no-cache' },
      });
    }
    if (format === 'msgpack') {
      const bytes = encodeMsgpack(payload);
      const headers: Record<string, string> = { 'content-type': MSGPACK_CONTENT_TYPE };
      if (gzip) {
        headers['content-encoding'] = 'gzip';
        return new Response(await gzipBytes(bytes), { status: orbitError.status, headers });
      }
      return new Response(bytes, { status: orbitError.status, headers });
    }
    const body = JSON.stringify(payload);
    if (gzip) {
      return new Response(await gzipBytes(new TextEncoder().encode(body)), {
        status: orbitError.status,
        headers: { 'content-type': JSON_CONTENT_TYPE, 'content-encoding': 'gzip' },
      });
    }
    return new Response(body, {
      status: orbitError.status,
      headers: { 'content-type': JSON_CONTENT_TYPE },
    });
  }

  #sseResponse(
    events: AsyncGenerator<OrbitStreamEvent>,
    gzip: boolean,
    ctx: OrbitContext,
  ): Response {
    const encoder = new TextEncoder();
    const normalize = (error: unknown) =>
      isOrbitError(error) ? Promise.resolve(error) : this.#normalizeError(error, ctx);
    // Events carry a live view of the graph — serialize each one the moment it
    // arrives. `pull` (not `start`) drives the generator, so the stream respects
    // backpressure: a slow client pauses resolution instead of buffering the
    // whole graph in memory.
    let settled = false;
    let stream: ReadableStream<Uint8Array<ArrayBuffer>> = new ReadableStream({
      async pull(controller) {
        if (settled) {
          controller.close();
          return;
        }
        try {
          const step = await events.next();
          if (step.done) {
            settled = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.value)}\n\n`));
        } catch (error) {
          // `stream()` already normalizes; anything else (e.g. a circular value
          // in JSON.stringify) becomes ORBIT_INTERNAL with the real ctx.
          settled = true;
          const normalized = await normalize(error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized.toJSON())}\n\n`));
          controller.close();
        }
      },
      async cancel() {
        // Client disconnected — stop pulling from the pipeline.
        settled = true;
        await events.return?.(undefined);
      },
    });

    const headers: Record<string, string> = {
      'content-type': SSE_CONTENT_TYPE,
      'cache-control': 'no-cache',
    };
    if (gzip) {
      headers['content-encoding'] = 'gzip';
      stream = stream.pipeThrough(new CompressionStream('gzip'));
    }
    return new Response(stream, { status: 200, headers });
  }

  async #normalizeError(error: unknown, ctx: OrbitContext): Promise<OrbitError> {
    let orbitError = toOrbitError(error, ctx);
    for (const plugin of this.#options.plugins.list) {
      try {
        const translated = await plugin.hooks.onError?.({ error: orbitError, ctx });
        if (translated instanceof OrbitError) orbitError = translated;
      } catch {
        // A failing error handler must never mask the original error.
      }
    }
    return orbitError;
  }
}

/** Create an Orbit engine. */
export function createOrbit(config: OrbitConfig = {}): Orbit {
  const adapters =
    config.adapters instanceof AdapterRegistry
      ? config.adapters
      : new AdapterRegistry().register(config.adapters ?? []);

  const plugins =
    config.plugins instanceof PluginRegistry
      ? config.plugins
      : new PluginRegistry().register(config.plugins ?? []);

  let cachePlugin: import('./plugins/cache.js').CachePlugin | undefined;
  if (config.cache !== undefined) {
    cachePlugin = createCachePlugin(config.cache);
    plugins.register(cachePlugin);
  }

  return new Orbit({
    adapters,
    plugins,
    maxQueryDepth: config.maxQueryDepth ?? DEFAULT_MAX_DEPTH,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
}

/** gzip a byte payload via the web-standard CompressionStream. */
async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
