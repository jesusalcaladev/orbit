import { AdapterRegistry } from './adapters/registry.js';
import type { DataAdapter } from './adapters/types.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_OPS,
  readEnvelopeBytes,
  readMsgpackEnvelope,
  validateEnvelope,
} from './envelope.js';
import { ErrorCode, isOrbitError, OrbitError, toOrbitError } from './errors.js';
import {
  DEFAULT_MAX_BREADTH,
  DEFAULT_MAX_COMPLEXITY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_KEY_LENGTH,
  DEFAULT_MAX_VALUE_LENGTH,
  parseOQS,
} from './parser.js';
import type { ParseOptions } from './parser.js';
import { PluginRegistry } from './plugins/registry.js';
import { isShortCircuit } from './plugins/types.js';
import type { OrbitPlugin, AfterExecuteInput } from './plugins/types.js';
import {
  MSGPACK_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  negotiateEncoding,
  negotiateFormat,
} from './serialize/negotiate.js';
import type { OrbitEncoding, OrbitFormat } from './serialize/negotiate.js';
import { encodeMsgpack } from './serialize/msgpack.js';
import { etagFor, etagMatches } from './serialize/etag.js';
import { createCachePlugin } from './plugins/cache.js';
import type {
  BatchRequest,
  Filters,
  MutationOp,
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
import { isRecord, setOwn, traceId } from './utils.js';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** A fetch-compatible handler function for Orbit queries. Takes a Request and returns a Promise<Response>. */
export type OrbitHandler = (request: Request) => Promise<Response>;

/**
 * Every negotiated response varies on `accept` (JSON/msgpack/SSE) and
 * `accept-encoding` (br/gzip) — proxies/CDNs must key their cache on both or
 * they can serve the wrong format to a client that asked for another.
 */
const VARY = 'accept, accept-encoding';

/** Max entries in the parse LRU — bounded so a hot client can't grow it forever. */
const PARSE_CACHE_MAX = 256;

/**
 * The `parsed` value handed to `onBeforeResolve` when there is no query tree —
 * a mutation batch, whose ops are gated before any of them runs. Hooks that
 * rewrite or short-circuit on a query tree must ignore it; it exists only so
 * the hook signature stays uniform.
 */
const UNPARSED: QueryNode = Object.freeze({
  entity: '',
  filters: Object.freeze({}) as Filters,
  fields: Object.freeze([]) as unknown as string[],
  relations: Object.freeze({}) as QueryNode['relations'],
  origin: 'client',
});

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
  /**
   * Maximum selections (fields + relations) on any single node of a query.
   * Default 128. Depth does not bound fan-out, so a query one level deep can
   * still ask for thousands of columns; this caps that shape.
   */
  maxQueryBreadth?: number;
  /**
   * Maximum selections across an entire query tree. Default 1024. Bounds the
   * total work one request can ask for, including the many-mid-width-nodes
   * shape a per-node breadth cap alone would admit.
   */
  maxQueryComplexity?: number;
  /** Optional cache plugin configuration. When set, automatically mounts
   *  `createCachePlugin` with these options and integrates caching into the
   *  handler (reads cache spec from `envelope.cache` or `x-orbit-cache` header). */
  cache?: import('./plugins/cache.js').CachePluginOptions;
  /**
   * Hard deadline for `execute()` (non-streaming requests), in ms. When the
   * pipeline exceeds it, the request rejects with `ORBIT_INTERNAL` and a
   * timeout message. Default: off (no timeout). Streaming/SSE is exempt by
   * design — streams are long-lived. The effective `AbortSignal` is exposed
   * on `ctx.signal` so adapters/plugins can cancel their own work.
   */
  requestTimeoutMs?: number;
  /**
   * Maximum number of fields accepted in a `multipart/form-data` upload
   * (the `envelope` field plus one field per file). Default 64 — bounds the
   * per-request object count even when the byte cap is not reached.
   */
  maxMultipartFields?: number;
  /**
   * Maximum number of batch mutation ops per envelope (the `ops` array).
   * Default 64 — mutations run sequentially, so a payload within the byte
   * limit can still carry thousands of them; the count gets its own bound.
   * Rejected with `ORBIT_INVALID_QUERY` and `details.maxOps` (spec §3).
   */
  maxOps?: number;
}

interface OrbitOptions {
  adapters: AdapterRegistry;
  plugins: PluginRegistry;
  /**
   * Boot-time services merged from every plugin's `provides`, in registration
   * order (duplicates rejected at `createOrbit`). Injected onto every
   * execution's `ctx.providers` before any hook runs (spec §11, 🧪).
   */
  providers: Readonly<Record<string, unknown>>;
  maxQueryDepth: number;
  maxQueryBreadth: number;
  maxQueryComplexity: number;
  maxPayloadBytes: number;
  maxKeyLength: number;
  maxValueLength: number;
  requestTimeoutMs: number | undefined;
  maxMultipartFields: number;
  maxOps: number;
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

/**
 * Conditional-GET context for a response (spec §7). Absent when validators do
 * not apply — mutations are not shared-cache representations, so a POST
 * response gets neither an `etag` nor a `304`.
 */
interface Conditional {
  /** The request's `if-none-match` header (may be absent). */
  ifNoneMatch: string | null;
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
  /**
   * The engine's parse limits, as one object.
   *
   * Every `parseOQS` call in the engine goes through here so a new limit cannot
   * be added to some call sites and forgotten in others — a limit that only
   * guards the direct `execute()` path would still be bypassable over HTTP and
   * SSE. The subscription hub reads the same three limits off the engine.
   */
  #parseOptions(origin?: NodeOrigin): ParseOptions {
    return {
      maxDepth: this.#options.maxQueryDepth,
      maxKeyLength: this.#options.maxKeyLength,
      maxValueLength: this.#options.maxValueLength,
      maxBreadth: this.#options.maxQueryBreadth,
      maxComplexity: this.#options.maxQueryComplexity,
      ...(origin !== undefined ? { origin } : {}),
    };
  }

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
    const node = parseOQS(query, this.#parseOptions(origin));
    this.#parseCache.set(key, node);
    if (this.#parseCache.size > PARSE_CACHE_MAX) {
      // The map just grew past the cap, so it is non-empty: a key exists.
      this.#parseCache.delete(this.#parseCache.keys().next().value as string);
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

  /**
   * The merged, read-only service container declared by plugins
   * (`OrbitPlugin.provides`). The engine injects it onto every execution's
   * `ctx.providers`; exposed here so the realtime subscription gates (which
   * run the pipeline directly, not via `execute`) can merge it too.
   */
  get providers(): Readonly<Record<string, unknown>> {
    return this.#options.providers;
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

  /** Maximum selections on a single node, enforced at parse (used by the realtime hub too). */
  get maxQueryBreadth(): number {
    return this.#options.maxQueryBreadth;
  }

  /** Maximum selections in a whole query tree, enforced at parse (used by the realtime hub too). */
  get maxQueryComplexity(): number {
    return this.#options.maxQueryComplexity;
  }

  /** Maximum batch mutation ops per envelope (used by the realtime hub too). */
  get maxOps(): number {
    return this.#options.maxOps;
  }

  /**
   * Execute an envelope and return a structured result. Framework-agnostic —
   * use `handler` when you want a fetch-compatible `Response`.
   */
  async execute(envelope: OrbitEnvelope, ctx: OrbitContext = {}): Promise<OrbitResult> {
    const valid = validateEnvelope(envelope, this.#options.maxOps);
    // Providers are the engine's channel (plugin-declared boot-time services):
    // the merged container REPLACES any caller-supplied `providers`, so plugins
    // stay the single source of truth. Per-request caller values belong in
    // `ctx.state`, which the spread below preserves.
    const fullCtx: OrbitContext = {
      ...ctx,
      providers: this.#options.providers,
      trace: ctx.trace ?? traceId(),
      envelope: valid,
      orbit: this,
    };

    // Effective cancellation: the caller's AbortSignal (if any) plus the
    // optional engine timeout. The signal rides on ctx so adapters/plugins
    // can cancel their own work; the race below guarantees the promise
    // rejects even if an adapter never settles. (The hung promise itself is
    // unreachable from JS — documented limitation; a request that aborts
    // mid-resolution stops consuming the event loop once its work settles.)
    const controller = new AbortController();
    const external = ctx.signal;
    const onExternalAbort = () => controller.abort(external?.reason);
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutMs = this.#options.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      /* v8 ignore next — Node's Timeout always has unref(); the guard keeps
         the type honest in DOM-typed runtimes where the timer is a number. */
      if (typeof timer.unref === 'function') timer.unref();
    }
    fullCtx.signal = controller.signal;

    try {
      const run =
        valid.ops !== undefined
          ? this.#executeBatchMutations(valid.ops, fullCtx)
          : valid.do !== undefined
            ? this.#executeMutation(valid, fullCtx)
            : this.#consumeQuery(valid, fullCtx);
      const result = await raceWithAbort(run, controller.signal);
      // Observability "finally": fire on success too, so metrics cover the
      // mutations and cache hits that skip the serialize hook (spec §11).
      await this.#fireAfterExecute({ result, envelope: valid, ctx: fullCtx });
      return result;
    } catch (error) {
      const orbitError = controller.signal.aborted
        ? new OrbitError(
            ErrorCode.INTERNAL,
            external?.aborted ? 'Request aborted by the caller' : 'Request timed out',
            { details: { timeoutMs } },
          )
        : await this.#normalizeError(error, fullCtx);
      await this.#fireAfterExecute({
        error: orbitError,
        envelope: valid,
        ctx: fullCtx,
      });
      throw orbitError;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
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
   * Run `onAfterExecute` hooks (observability/metrics) once per `execute()` —
   * on both the success (`result`) and error (`error`) paths, after `onError`
   * translation. The pipeline's "finally": it covers mutations and cache-hit
   * short circuits that the serialize hook (spec §11) never sees. Hook errors
   * are swallowed so a broken metrics sink never changes a request's outcome.
   */
  async #fireAfterExecute(input: AfterExecuteInput): Promise<void> {
    for (const plugin of this.#options.plugins.list) {
      const hook = plugin.hooks.onAfterExecute;
      if (typeof hook !== 'function') continue;
      try {
        await hook(input);
      } catch {
        // Observability hooks must never break request resolution.
      }
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
    const valid = validateEnvelope(envelope, this.#options.maxOps);
    const fullCtx: OrbitContext = {
      ...ctx,
      providers: this.#options.providers,
      envelope: valid,
      orbit: this,
    };
    if (valid.do !== undefined || valid.ops !== undefined) {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        "Streaming supports queries only (no 'do' or 'ops' actions)",
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
   * - **Compression:** `br` (Brotli, when the runtime provides
   *   `CompressionStream('br')`) or `gzip` via `Accept-Encoding`, negotiated by
   *   q-value. Neither is applied when the runtime lacks the codec.
   */
  async handler(request: Request, ctx: OrbitContext = {}): Promise<Response> {
    const base: OrbitContext = { ...ctx, request, headers: request.headers };
    const format = negotiateFormat(request.headers.get('accept'));
    // Spec §7: compression applies "when the runtime provides
    // CompressionStream". Brotli additionally needs the codec itself (Node only
    // shipped `CompressionStream('br')` recently), so the capability — not just
    // the header — decides: a client asking for `br` on such a runtime falls
    // back to gzip, and to an uncompressed body when it accepts neither.
    const encoding =
      typeof CompressionStream === 'undefined'
        ? null
        : negotiateEncoding(request.headers.get('accept-encoding'), {
            brotli: hasBrotli(),
          });
    // Conditional requests are only meaningful for the cacheable GET endpoint:
    // a POST response is not a shared-cache representation, so it gets neither
    // a validator nor a 304 (spec §7). `undefined` opts the response out.
    const conditional =
      request.method === 'GET' ? { ifNoneMatch: request.headers.get('if-none-match') } : undefined;
    try {
      // CORS preflight (additive, spec §7): an OPTIONS request carries no
      // envelope — the browser is asking the SERVER for permission before any
      // application request exists. When a mounted plugin can answer
      // preflights (`@orbit/cors` — duck-typed `preflight` method, the same
      // pattern as the cache plugin's eviction capability), run it and serve
      // a bare 204 with the `access-control-*` headers it stamped on
      // `ctx.responseHeaders`. A plugin that throws denies the preflight with
      // its error's status. Without such a plugin the request falls through
      // to the envelope path, which rejects it exactly as before.
      if (request.method === 'OPTIONS') {
        const answerPreflight = findPreflightHandler(this.#options.plugins);
        if (answerPreflight !== undefined) {
          await answerPreflight(request, base);
          return new Response(null, {
            status: 204,
            headers: finalHeaders({ vary: VARY }, base),
          });
        }
      }

      // GET endpoint (spec §3 additive): queries via query-string/headers,
      // making them CDN-cacheable. Only { query } envelopes are allowed —
      // mutations (do/ops) must use POST. The query can come from the `query`
      // URL parameter or the `X-Orbit-Query` header; cache spec from the
      // `cache` URL parameter or the `X-Orbit-Cache` header.
      if (request.method === 'GET') {
        const url = new URL(request.url);
        const query = url.searchParams.get('query') ?? request.headers.get('x-orbit-query');
        if (!query) {
          throw new OrbitError(
            ErrorCode.INVALID_QUERY,
            "GET requests require a 'query' parameter or 'X-Orbit-Query' header",
          );
        }
        const cache =
          url.searchParams.get('cache') ?? request.headers.get('x-orbit-cache') ?? undefined;
        const envelope: OrbitEnvelope = {
          query,
          ...(cache !== undefined ? { cache } : {}),
        };
        if (format === 'sse') {
          parseOQS(query, this.#parseOptions());
          return this.#sseResponse(this.stream(envelope, base), encoding, base);
        }
        const result = await this.execute(envelope, base);
        return await this.#toResponse(result, format, encoding, base, conditional);
      }

      const contentType = request.headers.get('content-type') ?? '';
      // The body first: the cheap `content-length` pre-check, the
      // `content-encoding` decoding and the inflated-size cap all live in one
      // place (`#readBody`), so compressed and plain bodies share every bound.
      const raw = await this.#readBody(request);
      // File uploads travel as multipart/form-data: the `envelope` field is the
      // JSON envelope, File fields become `ctx.files` (never touch the frozen
      // envelope contract — files are context, not envelope fields).
      if (contentType.includes('multipart/form-data')) {
        const { envelope, files } = await this.#readMultipart(raw, contentType);
        // `#readMultipart` always returns an object (possibly empty).
        const fullCtx: OrbitContext = { ...base, files };
        if (format === 'sse') {
          parseOQS(envelope.query ?? '', this.#parseOptions());
          return this.#sseResponse(this.stream(envelope, fullCtx), encoding, fullCtx);
        }
        const result = await this.execute(envelope, fullCtx);
        return await this.#toResponse(result, format, encoding, fullCtx, conditional);
      }

      const isMsgpack = contentType.includes(MSGPACK_CONTENT_TYPE);
      // Bytes-aware read: uses the known byte length and decodes once.
      const envelope = isMsgpack
        ? readMsgpackEnvelope(raw, this.#options.maxPayloadBytes)
        : readEnvelopeBytes(raw, this.#options.maxPayloadBytes);

      if (format === 'sse') {
        // Fail fast on query syntax errors BEFORE committing to a 200 stream:
        // only resolution-stage errors (e.g. an entity that doesn't resolve)
        // become SSE frames. Without this, ORBIT_INVALID_QUERY would be a 200.
        parseOQS(envelope.query ?? '', this.#parseOptions());
        return this.#sseResponse(this.stream(envelope, base), encoding, base);
      }

      const result = await this.execute(envelope, base);
      return await this.#toResponse(result, format, encoding, base, conditional);
    } catch (error) {
      // `execute` already normalizes (running onError hooks once); only
      // normalize raw errors here so translators never run twice.
      const orbitError = isOrbitError(error) ? error : await this.#normalizeError(error, base);
      // Building the error response can itself fail (a runtime without the
      // negotiated compression codec, a broken plugin header…). An exception
      // here would escape the handler and crash the host — degrade to the
      // plainest safe answer instead: the error contract as uncompressed
      // JSON with `no-store`.
      //
      // `await` inside the `try` is load-bearing: `#errorResponse` is async and
      // compresses via `compressBytes`, so the realistic failure is a REJECTED
      // promise, not a synchronous throw. Returning it without awaiting leaves
      // the rejection outside this catch, and the handler's whole safety net is
      // bypassed precisely when it is needed.
      try {
        return await this.#errorResponse(orbitError, format, encoding, base);
      } catch {
        return new Response(JSON.stringify(orbitError.toJSON()), {
          status: orbitError.status,
          headers: {
            'content-type': JSON_CONTENT_TYPE,
            'cache-control': 'no-store',
          },
        });
      }
    }
  }

  /**
   * Read the request body, honouring a compressed `content-encoding`
   * (spec §7, additive): `gzip` wherever the runtime can decode it, `br`
   * where `DecompressionStream('br')` exists.
   *
   * The size cap is enforced on the DECOMPRESSED bytes as the stream arrives.
   * `content-length` bounds the compressed body, but a few KB of gzip can
   * inflate to gigabytes (a decompression bomb), so `maxPayloadBytes` must
   * bound the inflated result — and it must do so while inflating, because
   * buffering the whole expansion first is exactly the DoS being prevented.
   */
  async #readBody(request: Request): Promise<Uint8Array> {
    // Cheap pre-check before buffering: reject oversized bodies early.
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > this.#options.maxPayloadBytes) {
      throw this.#payloadTooLarge(declared);
    }

    const raw = new Uint8Array(await request.arrayBuffer());
    const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase();
    if (encoding === '' || encoding === 'identity') return this.#capBody(raw);

    const codec =
      encoding === 'gzip' || encoding === 'x-gzip' ? 'gzip' : encoding === 'br' ? 'br' : null;
    if (codec === null) {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        `Unsupported request content-encoding: ${encoding}`,
        { details: { encoding } },
      );
    }
    return this.#inflateBody(raw, codec);
  }

  /** Reject a body that is over the limit; otherwise pass it through. */
  #capBody(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength > this.#options.maxPayloadBytes) {
      throw this.#payloadTooLarge(bytes.byteLength);
    }
    return bytes;
  }

  #payloadTooLarge(received: number): OrbitError {
    return new OrbitError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      'Request payload exceeds the configured limit',
      { details: { maxBytes: this.#options.maxPayloadBytes, received } },
    );
  }

  /**
   * Inflate a compressed request body, refusing to grow past
   * `maxPayloadBytes` — the decompression-bomb guard.
   */
  async #inflateBody(bytes: Uint8Array, codec: 'gzip' | 'br'): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        `This runtime cannot decode '${codec}' request bodies`,
      );
    }
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
        new DecompressionStream(codec as CompressionFormat) as unknown as {
          readable: ReadableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        },
      );
    } catch {
      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        `This runtime cannot decode '${codec}' request bodies`,
      );
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.#options.maxPayloadBytes) {
          // Cancelling is best-effort: the stream may already have errored.
          try {
            await reader.cancel();
          } catch {
            // Nothing left to release.
          }
          throw this.#payloadTooLarge(total);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof OrbitError) throw error;
      throw new OrbitError(ErrorCode.INVALID_QUERY, `Request body is not valid ${codec}`);
    }
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
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
    raw: Uint8Array,
    contentType: string,
  ): Promise<{ envelope: OrbitEnvelope; files: Record<string, File> }> {
    let form: FormData;
    try {
      // Reconstruct with the ORIGINAL content-type so the boundary travels with
      // the body (a bare Response loses the multipart boundary).
      form = await new Response(new Blob([raw as BlobPart]), {
        headers: { 'content-type': contentType },
      }).formData();
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
      envelope = validateEnvelope(JSON.parse(envelopeField), this.#options.maxOps);
    } catch (error) {
      if (error instanceof OrbitError) throw error;
      throw new OrbitError(ErrorCode.INVALID_QUERY, "The 'envelope' field is not valid JSON");
    }

    // Field-count cap (P0 hardening): the byte cap bounds the BODY, but a
    // request with thousands of tiny fields is cheap to send and expensive
    // to parse — bound the object count too.
    const maxFields = this.#options.maxMultipartFields;
    let fields = 0;
    const files: Record<string, File> = {};
    for (const [name, value] of form.entries()) {
      fields += 1;
      if (fields > maxFields) {
        throw new OrbitError(
          ErrorCode.INVALID_QUERY,
          `multipart upload exceeds the maximum of ${maxFields} fields`,
          { details: { maxFields, received: fields } },
        );
      }
      if (name === 'envelope') continue;
      if (value instanceof File) {
        // Attacker-controlled field name: `setOwn` defines an own property so a
        // field literally called `__proto__` cannot rewrite this object's
        // prototype (every other attacker-keyed map in core does the same).
        setOwn(files, name, value);
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
    /* v8 ignore next 3 — every caller (execute, stream) validates the
       envelope first, so `query` is always a string here; kept as a guard. */
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
        : parseOQS(raw, this.#parseOptions(origin));

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
        return {
          data: result.shortCircuit,
          fromCache: true,
          contentType: JSON_CONTENT_TYPE,
        };
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

  /**
   * Execute a batch of mutations (`ops: [{ do, args?, return? }, …]`).
   * Each op runs through the full mutation pipeline (onBeforeParse, adapter,
   * cache invalidation, optional `return` re-query). Execution is sequential:
   * if any op fails, the error is returned immediately and subsequent ops
   * are skipped. The response `data` is an array of per-op results; the
   * top-level `invalidates` is the union of all ops' invalidation keys.
   *
   * `onBeforeResolve` fires ONCE for the whole batch before the first op runs.
   * That pre-flight point is what lets a gate reject the batch atomically —
   * without it, a policy plugin could only reject op N after ops 1..N-1 had
   * already committed, leaving the caller with a half-applied batch it was
   * told had failed.
   */
  async #executeBatchMutations(ops: MutationOp[], ctx: OrbitContext): Promise<OrbitResult> {
    const results: unknown[] = [];
    const allInvalidates: string[] = [];

    for (const plugin of this.#options.plugins.list) {
      await plugin.hooks.onBeforeResolve?.({ parsed: UNPARSED, ctx });
    }

    for (const op of ops) {
      const opEnvelope: OrbitEnvelope = {
        do: op.do,
        ...(op.args !== undefined ? { args: op.args } : {}),
        ...(op.return !== undefined ? { return: op.return } : {}),
      };
      const opResult = await this.#executeMutation(opEnvelope, ctx);
      results.push(opResult.data ?? null);
      if (opResult.invalidates) {
        for (const key of opResult.invalidates) {
          if (!allInvalidates.includes(key)) allInvalidates.push(key);
        }
      }
    }

    return {
      status: 200,
      data: results,
      ...(allInvalidates.length > 0 ? { invalidates: allInvalidates } : {}),
      contentType: JSON_CONTENT_TYPE,
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

    // Spec §11 (additive rule): mutations run `onBeforeParse` once before
    // the adapter. The hook's SIDE EFFECTS are the point — auth plugins stamp
    // `ctx.state.caller` from the request headers here, and a gate that
    // throws (e.g. PERMISSION_DENIED) rejects the mutation. The returned
    // string is ignored: a mutation has no query to rewrite. Without this,
    // mutations ran zero pipeline hooks, so identity never reached `mutate`
    // and query-gated auth silently skipped mutations — an authorization
    // hole.
    for (const plugin of this.#options.plugins.list) {
      await plugin.hooks.onBeforeParse?.({ query: action, ctx });
    }

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
      // Stores may be async (Redis/KV) — eviction must settle before the
      // `return` re-query below so a post-mutation read is always fresh.
      await entityCache.invalidateEntity(entity);
      if (invalidates) {
        for (const key of invalidates) {
          await entityCache.invalidateEntity(key);
          await entityCache.invalidate(key);
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
      data: {
        success: true,
        ...(mutation.id !== undefined ? { id: mutation.id } : {}),
      },
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

      const requests: Array<{
        pending: Pending;
        filters: Filters;
        ctx: OrbitContext;
      }> = [];
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
              // Projection preserves the container type, so an array PROJECTION
              // implies an array adapter result — the else arm is defensive.
              /* v8 ignore next — see above. */
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
    encoding: OrbitEncoding | null,
    ctx: OrbitContext,
    conditional: Conditional | undefined,
  ): Promise<Response> {
    // A plugin payload is an explicit override — served verbatim, but still
    // compressed with the negotiated codec.
    if (result.body !== undefined) {
      const headers = finalHeaders({ 'content-type': result.contentType, vary: VARY }, ctx);
      if (encoding !== null) {
        const bytes =
          typeof result.body === 'string' ? new TextEncoder().encode(result.body) : result.body;
        headers.set('content-encoding', encoding);
        return new Response(await compressBytes(bytes, encoding), {
          status: result.status,
          headers,
        });
      }
      return new Response(result.body as BodyInit, {
        status: result.status,
        headers,
      });
    }

    const payload = {
      data: result.data ?? null,
      ...(result.fromCache ? { fromCache: true } : {}),
      ...(result.invalidates ? { invalidates: result.invalidates } : {}),
    };

    // The validator covers the RESOURCE (`data`), never the envelope: the
    // `fromCache` marker says how THIS response was produced, so hashing the
    // whole body would give a cache hit a different validator than the miss it
    // is equivalent to — conditional GETs would never see a 304 behind a CDN.
    // Encoding-independent by construction (the same validator serves JSON and
    // MessagePack of the same resource).
    const validator = new TextEncoder().encode(JSON.stringify(result.data ?? null));

    if (format === 'msgpack') {
      const bytes = encodeMsgpack(payload);
      const headers = finalHeaders({ 'content-type': MSGPACK_CONTENT_TYPE, vary: VARY }, ctx);
      if (conditional !== undefined) {
        const notModified = conditionalResponse(validator, headers, conditional.ifNoneMatch);
        if (notModified !== undefined) return notModified;
      }
      if (encoding !== null) {
        headers.set('content-encoding', encoding);
        return new Response(await compressBytes(bytes, encoding), {
          status: result.status,
          headers,
        });
      }
      return new Response(bytes, { status: result.status, headers });
    }

    const body = JSON.stringify(payload);
    const headers = finalHeaders({ 'content-type': JSON_CONTENT_TYPE, vary: VARY }, ctx);
    if (conditional !== undefined) {
      const notModified = conditionalResponse(validator, headers, conditional.ifNoneMatch);
      if (notModified !== undefined) return notModified;
    }
    if (encoding !== null) {
      headers.set('content-encoding', encoding);
      return new Response(await compressBytes(new TextEncoder().encode(body), encoding), {
        status: result.status,
        headers,
      });
    }
    return new Response(body, { status: result.status, headers });
  }

  async #errorResponse(
    orbitError: OrbitError,
    format: OrbitFormat,
    encoding: OrbitEncoding | null,
    ctx: OrbitContext,
  ): Promise<Response> {
    const payload = orbitError.toJSON();
    // Error responses are never cacheable (spec §7: `cache-control: no-store`
    // is part of the error contract) — enforce it AFTER the pipeline headers
    // are merged, so a plugin that stamped `cache-control: public, max-age=…`
    // on a request that then failed (e.g. the cache plugin's miss marker
    // followed by a resolution error) can never make an error cacheable.
    const noStore = (headers: Headers) => {
      headers.set('cache-control', 'no-store');
      return headers;
    };
    if (format === 'sse') {
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: orbitError.status,
        headers: noStore(
          finalHeaders(
            {
              'content-type': SSE_CONTENT_TYPE,
              'cache-control': 'no-cache',
              vary: VARY,
            },
            ctx,
          ),
        ),
      });
    }
    if (format === 'msgpack') {
      const bytes = encodeMsgpack(payload);
      const headers = noStore(
        finalHeaders(
          {
            'content-type': MSGPACK_CONTENT_TYPE,
            'cache-control': 'no-store',
            vary: VARY,
          },
          ctx,
        ),
      );
      if (encoding !== null) {
        headers.set('content-encoding', encoding);
        return new Response(await compressBytes(bytes, encoding), {
          status: orbitError.status,
          headers,
        });
      }
      return new Response(bytes, { status: orbitError.status, headers });
    }
    const body = JSON.stringify(payload);
    const headers = noStore(
      finalHeaders(
        {
          'content-type': JSON_CONTENT_TYPE,
          'cache-control': 'no-store',
          vary: VARY,
        },
        ctx,
      ),
    );
    if (encoding !== null) {
      headers.set('content-encoding', encoding);
      return new Response(await compressBytes(new TextEncoder().encode(body), encoding), {
        status: orbitError.status,
        headers,
      });
    }
    return new Response(body, { status: orbitError.status, headers });
  }

  #sseResponse(
    events: AsyncGenerator<OrbitStreamEvent>,
    encoding: OrbitEncoding | null,
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
        /* v8 ignore next 3 — the stream never re-pulls after close(), so a
           pull can only run while the pipeline is still producing. */
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
      {
        'content-type': SSE_CONTENT_TYPE,
        'cache-control': 'no-cache',
        vary: VARY,
      },
      ctx,
    );
    if (encoding !== null) {
      headers.set('content-encoding', encoding);
      stream = stream.pipeThrough(compressionStream(encoding));
    }
    return new Response(stream, { status: 200, headers });
  }

  async #normalizeError(error: unknown, ctx: OrbitContext): Promise<OrbitError> {
    let orbitError = toOrbitError(error, ctx);
    for (const plugin of this.#options.plugins.list) {
      try {
        const translated = await plugin.hooks.onError?.({
          error: orbitError,
          ctx,
        });
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

  // Providers (spec §11, 🧪): merge every plugin's `provides` in registration
  // order. Duplicate names and reserved prototype names fail loudly at boot —
  // same philosophy as the registry's duplicate plugin-name rejection: a
  // silent last-wins override is how subtle production bugs are born.
  const providers = collectProviders(plugins);

  return new Orbit({
    adapters,
    plugins,
    providers,
    maxQueryDepth: config.maxQueryDepth ?? DEFAULT_MAX_DEPTH,
    maxQueryBreadth: config.maxQueryBreadth ?? DEFAULT_MAX_BREADTH,
    maxQueryComplexity: config.maxQueryComplexity ?? DEFAULT_MAX_COMPLEXITY,
    maxPayloadBytes: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxKeyLength: config.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH,
    maxValueLength: config.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH,
    requestTimeoutMs: config.requestTimeoutMs,
    maxMultipartFields: config.maxMultipartFields ?? 64,
    maxOps: config.maxOps ?? DEFAULT_MAX_OPS,
  });
}

/**
 * A plugin that can answer CORS preflights (and bare OPTIONS requests) —
 * duck-typed, the same pattern as the cache plugin's eviction capability: the
 * engine never imports `@orbit/cors`, it only looks for a plugin that exposes
 * `preflight`. The method receives the raw request and stamps the
 * `access-control-*` answer onto `ctx.responseHeaders`; throwing denies the
 * preflight with the thrown error's status (e.g. a 403).
 */
interface PreflightPlugin {
  preflight?(request: Request, ctx: OrbitContext): void | Promise<void>;
}

/** Find the first mounted plugin that can answer a preflight, if any. */
function findPreflightHandler(
  plugins: PluginRegistry,
): NonNullable<PreflightPlugin['preflight']> | undefined {
  for (const plugin of plugins.list) {
    const candidate = plugin as OrbitPlugin & PreflightPlugin;
    if (typeof candidate.preflight === 'function') return candidate.preflight.bind(candidate);
  }
  return undefined;
}

/**
 * The cache-plugin capability the engine drives for server-side eviction.
 * Discovered by duck-typing (no hardcoded plugin name): any plugin exposing
 * `invalidateEntity` can be driven — `createCachePlugin` provides it, and
 * future cache implementations can too.
 */
interface EntityEvictingCache {
  invalidateEntity(entity: string): void | Promise<void>;
  invalidate(key: string): void | Promise<void>;
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

/** Provider names a plugin may never declare (prototype traps / pollution). */
const RESERVED_PROVIDER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Merge every plugin's `provides` into one read-only container, in
 * registration order (spec §11, 🧪). Failures are loud, at boot:
 * - a name declared by two plugins throws, naming both — no silent last-wins;
 * - reserved prototype names (`__proto__`, `constructor`, `prototype`) throw —
 *   a provider called `__proto__` would be unreachable/ambiguous anyway.
 *
 * The result is frozen: the container is shared across requests, so plugins
 * must treat it as read-only (per-request values go in `ctx.state`).
 */
function collectProviders(plugins: PluginRegistry): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const plugin of plugins.list) {
    const provides = plugin.provides;
    if (provides === undefined) continue;
    for (const [name, value] of Object.entries(provides)) {
      if (RESERVED_PROVIDER_NAMES.has(name)) {
        throw new Error(
          `Plugin '${plugin.name}' provides reserved name '${name}' — pick another provider name`,
        );
      }
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new Error(
          `Provider '${name}' is provided by both '${previous}' and '${plugin.name}' — ` +
            'provider names must be unique across all mounted plugins',
        );
      }
      owner.set(name, plugin.name);
      // Own-property write: a hostile/hostile-looking plugin key can never
      // rewrite the container's prototype (see utils#setOwn).
      setOwn(merged, name, value);
    }
  }
  return Object.freeze(merged);
}

/**
 * Build a response `Headers` set: the engine's base headers (content-type,
 * negotiation metadata) merged with the pipeline's `ctx.responseHeaders`.
 * Array values append one header line per item — `set-cookie` in particular
 * needs a line per cookie, and `Headers.append` preserves that. `vary` is
 * merged as the LIST header it is: a plugin adding `origin` (e.g.
 * `@orbit/cors`) keeps the engine's `accept, accept-encoding` on the wire
 * instead of silently replacing it.
 */
function finalHeaders(base: Record<string, string>, ctx: OrbitContext): Headers {
  const headers = new Headers(base);
  if (ctx.responseHeaders) {
    for (const [name, value] of Object.entries(ctx.responseHeaders)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (name.toLowerCase() === 'vary') {
        /* v8 ignore start — defensive: every `finalHeaders` call site passes
           `vary: VARY` as a base header, so there is always an existing value
           to merge into and always at least one surviving token. Kept so a
           future call site that sets no base `vary` degrades to the plugin's
           tokens rather than throwing or emitting an empty header. */
        const tokens = headers
          .get('vary')
          ?.split(',')
          .map((token) => token.trim())
          .filter((token) => token !== '');
        const merged = tokens ?? [];
        for (const token of value.split(',')) {
          const trimmed = token.trim();
          if (trimmed !== '' && !merged.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
            merged.push(trimmed);
          }
        }
        if (merged.length > 0) headers.set('vary', merged.join(', '));
        /* v8 ignore stop */
      } else {
        headers.set(name, value);
      }
    }
  }
  return headers;
}

/**
 * Apply the conditional-GET contract (spec §7) to a negotiated payload.
 *
 * Stamps a weak ETag derived from the response bytes — unless a plugin already
 * set one (plugins own their validators, exactly like the cache headers) — and
 * answers `304 Not Modified` when the client's `If-None-Match` says its copy is
 * current. The 304 keeps every header, `cache-control` included, so a CDN stays
 * inside its freshness window; it carries no body and no `content-encoding`,
 * because it transmits no representation.
 *
 * Returns `undefined` when the caller should serve the payload normally.
 */
function conditionalResponse(
  bytes: Uint8Array,
  headers: Headers,
  ifNoneMatch: string | null,
): Response | undefined {
  if (!headers.has('etag')) headers.set('etag', etagFor(bytes));
  if (ifNoneMatch === null) return undefined;
  // The statement above guarantees an `etag` header exists by now — the cast
  // replaces an unreachable null check (same idiom as the cache plugin).
  const etag = headers.get('etag') as string;
  return etagMatches(ifNoneMatch, etag) ? new Response(null, { status: 304, headers }) : undefined;
}

/**
 * Race a promise against an AbortSignal: settles with the promise's value,
 * or rejects with an `AbortError` (DOMException-like) the moment the signal
 * aborts — even if the promise never settles. Used by `execute` for the
 * caller signal + engine timeout.
 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const onSettle = () => {
      cleanup();
      promise.then(resolve, reject);
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      promise.then(undefined, () => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(onSettle, onSettle);
  });
}

/**
 * Memoized-per-constructor Brotli capability probe. The answer cannot change
 * for a given `CompressionStream`, and constructing the stream is the only
 * reliable test: `CompressionStream` exists on every supported runtime but
 * historically implemented gzip/deflate only (Node added `'br'` later, Workers
 * vary), so checking the constructor exists is not enough — asking it for
 * `'br'` is. Keying the memo on the constructor also re-probes honestly if a
 * runtime (or a test) swaps the implementation.
 */
let brotliProbe: { ctor: unknown; capable: boolean } | undefined;

function hasBrotli(): boolean {
  if (brotliProbe === undefined || brotliProbe.ctor !== CompressionStream) {
    brotliProbe = { ctor: CompressionStream, capable: probeBrotli() };
  }
  return brotliProbe.capable;
}

function probeBrotli(): boolean {
  try {
    // Throws where the platform doesn't implement the codec (e.g. Node), and
    // also where `CompressionStream` doesn't exist at all — both mean "no".
    compressionStream('br');
    return true;
  } catch {
    return false;
  }
}

/**
 * Construct a compression stream for a negotiated codec.
 *
 * The bundled DOM lib's `CompressionFormat` predates Brotli (gzip/deflate/
 * deflate-raw only), so the cast is required — but it is honest: Brotli is only
 * ever requested after `hasBrotli()` successfully constructed one, and an
 * unsupported format still throws where the platform doesn't accept it.
 */
function compressionStream(encoding: OrbitEncoding): CompressionStream {
  return new CompressionStream(encoding as CompressionFormat);
}

/** Compress a byte payload via the web-standard `CompressionStream`. */
async function compressBytes(
  bytes: Uint8Array<ArrayBuffer>,
  encoding: OrbitEncoding,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new Blob([bytes]).stream().pipeThrough(compressionStream(encoding));
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
