import { ErrorCode, OrbitError, validateEnvelope } from '@orbit/core';
import type { MutationArgs, OrbitEnvelope, OrbitStreamEvent, SubscriptionEvent } from '@orbit/core';
import { defaultDecompress, postEnvelope } from './http.js';
import type { HttpDeps } from './http.js';
import { buildFormData, postFormData } from './multipart.js';
import type { UploadFiles } from './multipart.js';
import { RealtimeClient } from './realtime.js';
import type { SubscriptionHandle, SubscribeOptions } from './realtime.js';
import { streamEvents } from './stream.js';
import type {
  Decompress,
  ClientFormat,
  OrbitClientOptions,
  OrbitResponse,
  RequestOptions,
  SocketClient,
} from './types.js';

/**
 * The vanilla, framework-agnostic Orbit client — transport only.
 *
 * No cache, no hooks, no state: `execute`/`query`/`mutate` speak the protocol
 * and return what the server said (`data`, `fromCache`, `invalidates`),
 * `stream` reads the graph level by level over SSE, `upload` posts files as
 * multipart, and `subscribe`/`socket` drive the realtime WebSocket transport.
 * Higher layers (`@orbit/react`) build their cache and hooks on top of this.
 *
 * ```ts
 * const client = new OrbitClient({ baseUrl: '/orbit' });
 * const { data } = await client.query('user(id="1") { name, posts { title } }');
 * await client.mutate('user.update', { filter: { id: '1' }, payload: { name: 'Ana' } });
 * for await (const frame of client.stream('user(id="1") { posts { title } }')) {
 *   console.log(frame.level, frame.data);
 * }
 * const sub = client.subscribe('posts(status="live") { id }', (event) => …);
 * ```
 */
export class OrbitClient {
  readonly baseUrl: string;

  /** Explicit realtime URL, when one was configured (`OrbitClientOptions.realtimeUrl`). */
  readonly realtimeUrl: string | undefined;

  readonly #clientHeaders: OrbitClientOptions['headers'];
  readonly #defaultFormat: ClientFormat;
  readonly #gzip: boolean;
  readonly #fetchImpl: typeof fetch;
  readonly #decompress: Decompress;
  readonly #WebSocket: typeof WebSocket;
  #realtime: RealtimeClient | undefined;

  constructor(options: OrbitClientOptions) {
    this.baseUrl = options.baseUrl;
    this.#clientHeaders = options.headers;
    this.#defaultFormat = options.format ?? 'json';
    this.#gzip = options.gzip ?? true;
    this.#fetchImpl = options.fetch ?? fetch;
    this.#decompress = options.decompress ?? defaultDecompress;
    this.#WebSocket = options.WebSocket ?? WebSocket;
    this.realtimeUrl = options.realtimeUrl;
  }

  /** Fetch data — sugar for `execute({ query })`. */
  query(query: string, options: RequestOptions = {}): Promise<OrbitResponse> {
    return this.execute({ query }, options);
  }

  /** Run a mutation — sugar for `execute({ do, args, return? })`. */
  mutate(action: string, args: MutationArgs, options: RequestOptions = {}): Promise<OrbitResponse> {
    const { return: returnQuery, ...rest } = options;
    const envelope: OrbitEnvelope = {
      do: action,
      args,
      ...(returnQuery !== undefined ? { return: returnQuery } : {}),
    };
    return this.execute(envelope, rest);
  }

  /**
   * Stream a query's graph level by level over SSE (spec §7). The async
   * iterable yields `{ level, data }` frames as they arrive and ends after
   * the `{ level: 'done' }` frame. Aborting the signal cancels the body read.
   */
  stream(query: string, options: RequestOptions = {}): AsyncIterable<OrbitStreamEvent> {
    const { cache, format, headers, signal, timeoutMs } = options;
    const envelope = this.#validated({ query }, cache);
    return streamEvents(this.#httpDeps(), {
      envelope,
      format: format ?? this.#defaultFormat,
      headers,
      signal,
      timeoutMs,
    });
  }

  /**
   * Upload files with a mutation — `multipart/form-data` (spec §7): the JSON
   * `envelope` field carries `{ do, args, return? }`, each file lands in
   * `ctx.files` inside `mutate`. Responses negotiate normally.
   */
  upload(
    action: string,
    args: MutationArgs,
    files: UploadFiles,
    options: RequestOptions = {},
  ): Promise<OrbitResponse> {
    const { cache, format, headers, signal, timeoutMs, return: returnQuery } = options;
    const envelope = this.#validated(
      {
        do: action,
        args,
        ...(returnQuery !== undefined ? { return: returnQuery } : {}),
      },
      cache,
    );
    return postFormData(this.#httpDeps(), {
      form: buildFormData(envelope, files),
      format: format ?? this.#defaultFormat,
      headers,
      signal,
      timeoutMs,
    });
  }

  /**
   * Subscribe to a realtime query over the shared WebSocket (spec §10). The
   * handle's `seq` is the resume cursor; a dropped connection reconnects with
   * backoff, resumes from it, and transparently falls back to a fresh
   * subscribe if the server's retention window expired.
   */
  subscribe(
    query: string,
    handler: (event: SubscriptionEvent, meta: { seq: number }) => void,
    options: SubscribeOptions = {},
  ): SubscriptionHandle {
    return this.#realtimeClient().subscribe(query, handler, options);
  }

  /** Envelope request/response over the shared realtime socket (spec §10). */
  socket(): SocketClient {
    return this.#realtimeClient().socket;
  }

  /** Close every realtime subscription and socket; frees resources. */
  close(): void {
    this.#realtime?.close();
  }

  /**
   * POST an envelope and return the parsed Orbit response.
   *
   * The envelope is validated client-side (`validateEnvelope` from
   * `@orbit/core`) before any network I/O, so a malformed envelope fails fast
   * with `ORBIT_INVALID_QUERY` instead of wasting a round-trip.
   *
   * Rejects with:
   * - `OrbitError` — the server answered a protocol error (spec §6).
   * - `OrbitNetworkError` — transport/parse/decompression failure.
   * - the caller's own abort (name `'AbortError'`) — cancellation.
   */
  async execute(envelope: OrbitEnvelope, options: RequestOptions = {}): Promise<OrbitResponse> {
    const { cache, format, headers, signal, timeoutMs } = options;
    return postEnvelope(this.#httpDeps(), {
      envelope: this.#validated(envelope, cache),
      format: format ?? this.#defaultFormat,
      headers,
      signal,
      timeoutMs,
    });
  }

  #validated(envelope: OrbitEnvelope, cache: string | undefined): OrbitEnvelope {
    const full = cache !== undefined ? { ...envelope, cache } : envelope;
    return validateEnvelope(full);
  }

  #httpDeps(): HttpDeps {
    return {
      baseUrl: this.baseUrl,
      fetchImpl: this.#fetchImpl,
      decompress: this.#decompress,
      defaultHeaders: resolveHeaders(this.#clientHeaders),
      gzip: this.#gzip,
    };
  }

  #realtimeClient(): RealtimeClient {
    if (this.#realtime === undefined) {
      this.#realtime = new RealtimeClient(realtimeUrlOf(this), this.#WebSocket);
    }
    return this.#realtime;
  }
}

/** Create a client — same as `new OrbitClient(options)`. */
export function createClient(options: OrbitClientOptions): OrbitClient {
  return new OrbitClient(options);
}

function resolveHeaders(headers: OrbitClientOptions['headers']): Record<string, string> {
  if (typeof headers === 'function') return headers();
  return headers ?? {};
}

/**
 * Derive the realtime WebSocket URL from the HTTP base: swap the protocol
 * (`http`→`ws`, `https`→`wss`) and point at `/realtime` (the default server
 * path). An explicit `realtimeUrl` always wins; a relative baseUrl needs a
 * WebSocket origin (`location` in browsers) — otherwise the caller must pass
 * `realtimeUrl`. Resolved lazily, so HTTP-only clients never pay for it.
 */
function realtimeUrlOf(client: OrbitClient): string {
  if (client.realtimeUrl !== undefined) return client.realtimeUrl;
  const baseUrl = client.baseUrl;
  if (/^https?:\/\//.test(baseUrl)) {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/realtime';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const origin =
    typeof location !== 'undefined' ? (location as { origin?: string }).origin : undefined;
  if (origin !== undefined) return `${origin.replace(/^http/, 'ws')}/realtime`;
  throw new OrbitError(
    ErrorCode.INVALID_QUERY,
    "Cannot derive the realtime URL from a relative baseUrl without a WebSocket origin — pass 'realtimeUrl' explicitly",
  );
}
