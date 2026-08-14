import { AdapterRegistry } from './adapters/registry.js';
import type { DataAdapter } from './adapters/types.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  readEnvelopeBytes,
  readMsgpackEnvelope,
  validateEnvelope,
} from './envelope.js';
import { ErrorCode, isOrbitError, OrbitError, toOrbitError } from './errors.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_KEY_LENGTH,
  DEFAULT_MAX_VALUE_LENGTH,
  parseOQS,
} from './parser.js';
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

/**
 * Every negotiated response varies on `accept` (JSON/msgpack/SSE) and
 * `accept-encoding` (gzip) — proxies/CDNs must key their cache on both or
 * they can serve the wrong format to a client that asked for another.
 */
const VARY = 'accept, accept-encoding';

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
  /** Maximum identifier length (entity, field and filter-key names). Default 128. */
  maxKeyLength?: number;
  /** Maximum filter-value length (quoted or bare). Default 1024. */
  maxValueLength?: number;
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
  maxKeyLength: number;
  maxValueLength: number;
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
    // Safe to omit the length caps from the key: they are engine-constant
    // (readonly options), this cache is per-engine, and the LRU path only
    // runs with zero plugins — two engines with different caps never share
    // a cache. If caps ever become per-request, they must join this key.
    const key = `${origin}\u0000${this.#options.maxQueryDepth}\u0000${query}`;
    const hit = this.#parseCache.get(key);
    if (hit !== undefined) {
      // Refresh recency (Map is insertion-ordered).
      this.#parseCache.delete(key);
      this.#parseCache.set(key, hit);
      return hit;
    }
    const node = parseOQS(query, {
      maxDepth: this.#options.maxQueryDepth,
      maxKeyLength: this.#options.maxKeyLength,
      maxValueLength: this.#options.maxValueLength,
      origin,
    });
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

  /** Maximum identifier length, enforced at parse (used by the realtime hub too). */
  get maxKeyLength(): number {
    return this.#options.maxKeyLength;
  }

  /** Maximum filter-value length, enforced at parse (used by the realtime hub too). */
  get maxValueLength(): number {
    return this.#options.maxValueLength;
  }

  /**
   * Execute an envelope and return a structured result. Framework-agnostic —
   * use `handler` when you want a fetch-compatible `Response`.
   */
  async execute(envelope: OrbitEnvelope, ctx: OrbitContext = {}): Promise<OrbitResult> {
    const valid = validateEnvelope(envelope);
    const fullCtx: OrbitContext = { ...ctx, envelope: valid, orbit: this };
    try {
      const result =
        valid.do !== undefined
          ? await this.#executeMutation(valid, fullCtx)
          : await this.#consumeQuery(valid, fullCtx);
      return result;
    } catch (error) {
      throw await this.#normalizeError(error, fullCtx);
    } finally {
      // Response headers set by plugins/adapters on the pipeline context ride
      // back to the caller, so the handler (which owns the Response) can
      // merge them — on SUCCESS and on ERROR (a login mutation that issues a
      // cookie and then fails still delivers the cookie with the error). The
      // finally also picks up headers set by `onError` hooks. `execute()`
      // callers that never build a Response simply ignore them.
      if (fullCtx.responseHeaders !== undefined) ctx.responseHeaders = fullCtx.responseHeaders;
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
   * - **Input:** JSON, MessagePack (`Content-Type: application/x-msgpack`) or
   *   `multipart/form-data` (file uploads: the `envelope` field carries the
   *   JSON envelope, every other field whose value is a `File` lands in
   *   `ctx.files` for the adapter's `mutate`).
   * - **Output:** negotiated from `Accept` — JSON (default), `application/x-msgpack`,
   *   or `text/event-stream` (progressive graph streaming).
   * - **Compression:** gzip via `Accept-Encoding` when the runtime supports it.
   */
  async handler(request: Request, ctx: OrbitContext = {}): Promise<Response> {
    const base: OrbitContext = { ...ctx, request, headers: request.headers };
    const format = negotiateFormat(request.headers.get('accept'));
    // Spec §7: gzip applies "when the runtime provides CompressionStream".
    // Check the capability, not just the header — an engine on a runtime
    // without CompressionStream must degrade to plain responses, not 500.
    const gzip =
      typeof CompressionStream !== 'undefined' && wantsGzip(request.headers.get('accept-encoding'));
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

      const contentType = request.headers.get('content-type') ?? '';
      // File uploads travel as multipart/form-data: the `envelope` field is the
      // JSON envelope, File fields become `ctx.files` (never touch the frozen
      // envelope contract — files are context, not envelope fields).
      if (contentType.includes('multipart/form-data')) {
        const { envelope, files } = await this.#readMultipart(request, contentType);
        const fullCtx: OrbitContext = files ? { ...base, files } : base;
        if (format === 'sse') {
          parseOQS(envelope.query ?? '', {
            maxDepth: this.#options.maxQueryDepth,
            maxKeyLength: this.#options.maxKeyLength,
            maxValueLength: this.#options.maxValueLength,
          });
          return this.#sseResponse(this.stream(envelope, fullCtx), gzip, fullCtx);
        }
        const result = await this.execute(envelope, fullCtx);
        return await this.#toResponse(result, format, gzip, fullCtx);
      }

      const raw = new Uint8Array(await request.arrayBuffer());
      const isMsgpack = contentType.includes(MSGPACK_CONTENT_TYPE);
      // Bytes-aware read: uses the known byte length and decodes once.
      const envelope = isMsgpack
        ? readMsgpackEnvelope(raw, this.#options.maxPayloadBytes)
        : readEnvelopeBytes(raw, this.#options.maxPayloadBytes);

      if (format === 'sse') {
        // Fail fast on query syntax errors BEFORE committing to a 200 stream:
        // only resolution-stage errors (e.g. an entity that doesn't resolve)
        // become SSE frames. Without this, ORBIT_INVALID_QUERY would be a 200.
        parseOQS(envelope.query ?? '', {
          maxDepth: this.#options.maxQueryDepth,
          maxKeyLength: this.#options.maxKeyLength,
          maxValueLength: this.#options.maxValueLength,
        });
        return this.#sseResponse(this.stream(envelope, base), gzip, base);
      }

      const result = await this.execute(envelope, base);
      return await this.#toResponse(result, format, gzip, base);
    } catch (error) {
      // `execute` already normalizes (running onError hooks once); only
      // normalize raw errors here so translators never run twice.
      const orbitError = isOrbitError(error) ? error : await this.#normalizeError(error, base);
      return this.#errorResponse(orbitError, format, gzip, base);
    }
  }

  /**
   * Parse a `multipart/form-data` request into an envelope + files.
   *
   * The `envelope` field must be a JSON string (validated exactly like any
   * other envelope — same error codes, same `maxPayloadBytes` limit on the
   * whole body). Every other field whose value is a `File` is collected into
   * `ctx.files` keyed by field name. Non-file fields (other than `envelope`)
   * are rejected — uploads are a deliberate, explicit contract.
   */
  async #readMultipart(
    request: Request,
    contentType: string,
  ): Promise<{ envelope: OrbitEnvelope; files: Record<string, File> }> {
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > this.#options.maxPayloadBytes) {
      throw new OrbitError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        'Request payload exceeds the configured limit',
        {
          details: { maxBytes: this.#options.maxPayloadBytes, received: raw.byteLength },
        },
      );
    }
    let form: FormData;
    try {
      // Reconstruct with the ORIGINAL content-type so the boundary travels with
      // the body (a bare Response loses the multipart boundary).
      form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
    } catch {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        'Envelope is not a valid multipart/form-data body',
      );
    }

    const envelopeField = form.get('envelope');
    if (typeof envelopeField !== 'string') {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        "multipart/form-data uploads must include an 'envelope' field with the JSON envelope",
        { details: { field: 'envelope' } },
      );
    }
    let envelope: OrbitEnvelope;
    try {
      envelope = validateEnvelope(JSON.parse(envelopeField));
    } catch (error) {
      if (error instanceof OrbitError) throw error;
      throw new OrbitError(ErrorCode.INVALID_QUERY, "The 'envelope' field is not valid JSON");
    }

    const files: Record<string, File> = {};
    for (const [name, value] of form.entries()) {
      if (name === 'envelope') continue;
      if (value instanceof File) {
        files[name] = value;
      } else {
        throw new OrbitError(
          ErrorCode.INVALID_QUERY,
          `multipart field '${name}' must be a file or the 'envelope' field`,
          { details: { field: name } },
        );
      }
    }
    return { envelope, files };
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
        : parseOQS(raw, {
            maxDepth: this.#options.maxQueryDepth,
            maxKeyLength: this.#options.maxKeyLength,
            maxValueLength: this.#options.maxValueLength,
            origin,
          });

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

    // A rejected mutation is ORBIT_MUTATION_FAILED (spec §5), not an
    // unclassified internal error. An adapter that throws an `OrbitError`
    // keeps its precise code (e.g. FILTER_INVALID for a bad payload); a
    // plain Error — whose message may embed internals — becomes a sanitized
    // MUTATION_FAILED with the original kept as `cause` for logs.
    let raw: unknown;
    try {
      raw = await adapter.mutate(verb, envelope.args ?? {}, ctx);
    } catch (error) {
      if (isOrbitError(error)) throw error;
      throw new OrbitError(ErrorCode.MUTATION_FAILED, 'Mutation failed', {
        cause: error,
        details: { entity, action: envelope.do },
      });
    }
    const mutation: MutationResult = isRecord(raw) ? raw : {};
    const invalidates =
      Array.isArray(mutation.invalidates) && mutation.invalidates.length > 0
        ? mutation.invalidates
        : undefined;

    // Server-side cache hygiene (spec §8): evict every cached entry whose
    // query reads the mutated entity — the cache plugin indexes entries by
    // the entities in their tree — plus anything the adapter names in
    // `invalidates` (entity names or exact store keys). This runs BEFORE
    // the `return` re-query below so a post-mutation read is always fresh.
    const entityCache = findEntityEvictingCache(this.#options.plugins);
    if (entityCache) {
      entityCache.invalidateEntity(entity);
      if (invalidates) {
        for (const key of invalidates) {
          entityCache.invalidateEntity(key);
          entityCache.invalidate(key);
        }
      }
    }

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

  async #toResponse(
    result: OrbitResult,
    format: OrbitFormat,
    gzip: boolean,
    ctx: OrbitContext,
  ): Promise<Response> {
    // A plugin payload is an explicit override — served verbatim, but still
    // compressed when the client asked for gzip.
    if (result.body !== undefined) {
      const headers = finalHeaders({ 'content-type': result.contentType, vary: VARY }, ctx);
      if (gzip) {
        const bytes =
          typeof result.body === 'string' ? new TextEncoder().encode(result.body) : result.body;
        headers.set('content-encoding', 'gzip');
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
      const headers = finalHeaders({ 'content-type': MSGPACK_CONTENT_TYPE, vary: VARY }, ctx);
      if (gzip) {
        headers.set('content-encoding', 'gzip');
        return new Response(await gzipBytes(bytes), { status: result.status, headers });
      }
      return new Response(bytes, { status: result.status, headers });
    }

    const body = JSON.stringify(payload);
    const headers = finalHeaders({ 'content-type': JSON_CONTENT_TYPE, vary: VARY }, ctx);
    if (gzip) {
      headers.set('content-encoding', 'gzip');
      return new Response(await gzipBytes(new TextEncoder().encode(body)), {
        status: result.status,
        headers,
      });
    }
    return new Response(body, { status: result.status, headers });
  }

  async #errorResponse(
    orbitError: OrbitError,
    format: OrbitFormat,
    gzip: boolean,
    ctx: OrbitContext,
  ): Promise<Response> {
    const payload = orbitError.toJSON();
    if (format === 'sse') {
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: orbitError.status,
        headers: finalHeaders(
          { 'content-type': SSE_CONTENT_TYPE, 'cache-control': 'no-cache', vary: VARY },
          ctx,
        ),
      });
    }
    if (format === 'msgpack') {
      const bytes = encodeMsgpack(payload);
      const headers = finalHeaders(
        { 'content-type': MSGPACK_CONTENT_TYPE, 'cache-control': 'no-store', vary: VARY },
        ctx,
      );
      if (gzip) {
        headers.set('content-encoding', 'gzip');
        return new Response(await gzipBytes(bytes), { status: orbitError.status, headers });
      }
      return new Response(bytes, { status: orbitError.status, headers });
    }
    const body = JSON.stringify(payload);
    const headers = finalHeaders(
      { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store', vary: VARY },
      ctx,
    );
    if (gzip) {
      headers.set('content-encoding', 'gzip');
      return new Response(await gzipBytes(new TextEncoder().encode(body)), {
        status: orbitError.status,
        headers,
      });
    }
    return new Response(body, { status: orbitError.status, headers });
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

    // SSE streams answer immediately — response headers must be known before
    // the pipeline runs. Merge only what the caller provided (e.g. via the
    // handler's `ctx` option); a pipeline-set `responseHeaders` arrives too
    // late to reach this Response (documented on `OrbitContext`).
    const headers = finalHeaders(
      { 'content-type': SSE_CONTENT_TYPE, 'cache-control': 'no-cache', vary: VARY },
      ctx,
    );
    if (gzip) {
      headers.set('content-encoding', 'gzip');
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

  assertCacheAfterTransformers(plugins);

  return new Orbit({
    adapters,
    plugins,
    maxQueryDepth: config.maxQueryDepth ?? DEFAULT_MAX_DEPTH,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxKeyLength: config.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH,
    maxValueLength: config.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH,
  });
}

/**
 * The cache-plugin capability the engine drives for server-side eviction.
 * Discovered by duck-typing (no hardcoded plugin name): any plugin exposing
 * `invalidateEntity` can be driven — `createCachePlugin` provides it, and
 * future cache implementations can too.
 */
interface EntityEvictingCache {
  invalidateEntity(entity: string): void;
  invalidate(key: string): void;
}

/**
 * Enforce the spec §11 registration rule at startup instead of letting it
 * silently corrupt cached values: the cache plugin must be registered
 * AFTER every transformer, because a cache hit short-circuits before
 * `onBeforeSerialize` ever runs — a transformer registered after the cache
 * would be skipped on hits (and the stored value on misses would be the
 * pre-transform payload). Fail loudly at `createOrbit` time, with the exact
 * offending plugin named, so the mistake surfaces at boot, not in
 * production traffic.
 */
function assertCacheAfterTransformers(plugins: PluginRegistry): void {
  let sawCache = false;
  for (const plugin of plugins.list) {
    const isCache =
      typeof (plugin as OrbitPlugin & Partial<EntityEvictingCache>).invalidateEntity === 'function';
    if (!sawCache) {
      if (isCache) sawCache = true;
      continue;
    }
    if (plugin.hooks.onBeforeSerialize) {
      throw new Error(
        `Plugin '${plugin.name}' is registered after the cache plugin but transforms data in ` +
          'onBeforeSerialize — cache hits would serve the untransformed value. Register every ' +
          'transformer BEFORE the cache plugin (spec §11).',
      );
    }
  }
}

/** Find the first mounted plugin that can evict cache entries by entity. */
function findEntityEvictingCache(plugins: PluginRegistry): EntityEvictingCache | undefined {
  for (const plugin of plugins.list) {
    const candidate = plugin as OrbitPlugin & Partial<EntityEvictingCache>;
    if (typeof candidate.invalidateEntity === 'function') {
      return candidate as OrbitPlugin & EntityEvictingCache;
    }
  }
  return undefined;
}

/**
 * Build a response `Headers` set: the engine's base headers (content-type,
 * negotiation metadata) merged with the pipeline's `ctx.responseHeaders`.
 * Array values append one header line per item — `set-cookie` in particular
 * needs a line per cookie, and `Headers.append` preserves that.
 */
function finalHeaders(base: Record<string, string>, ctx: OrbitContext): Headers {
  const headers = new Headers(base);
  if (ctx.responseHeaders) {
    for (const [name, value] of Object.entries(ctx.responseHeaders)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
  }
  return headers;
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
