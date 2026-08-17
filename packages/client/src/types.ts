import type { OrbitEnvelope } from '@orbit/core';

/** The wire format the client speaks — request body content-type AND `Accept`. */
export type ClientFormat = 'json' | 'msgpack';

/** Realtime socket connection state, reported via `SubscriptionHandle.onStatus`. */
export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/** The reply to a `{ query }` / `{ do }` envelope request over the socket. */
export interface SocketReply {
  /** HTTP-style status of the execution. */
  status: number;
  /** The resolved data (`null` when the adapter resolved nothing). */
  data: unknown;
  /** True when served from a cache (spec §8). */
  fromCache?: boolean;
  /** Cache keys the server asks the client to evict. */
  invalidates?: string[];
  /** Set when a plugin serialized the payload to a non-JSON format. */
  contentType?: string;
}

/** Envelope request/response over the realtime socket (spec §10). */
export interface SocketClient {
  /** Execute an envelope through the full pipeline, answered on the same socket. */
  request(envelope: OrbitEnvelope, options?: SocketRequestOptions): Promise<SocketReply>;
}

export interface SocketRequestOptions {
  /** Abort waiting for the reply (the frame may still arrive). */
  signal?: AbortSignal;
  /** Give up waiting after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Gunzip a gzip-compressed response body.
 *
 * Injectable for runtimes without a web-standard `DecompressionStream`
 * (React Native/Hermes). The default uses `DecompressionStream` when the
 * runtime provides it.
 */
export type Decompress = (body: ReadableStream<Uint8Array>) => Promise<Uint8Array>;

export interface OrbitClientOptions {
  /** The Orbit endpoint, e.g. `'/orbit'` or `'https://api.example.com/orbit'`. */
  baseUrl: string;
  /**
   * Headers sent with every request. A function is re-evaluated per request,
   * so dynamic tokens stay fresh.
   */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Default wire format. Default `'json'`. Per-request via `RequestOptions.format`. */
  format?: ClientFormat;
  /** Send `Accept-Encoding: gzip` and decompress gzip responses. Default `true`. */
  gzip?: boolean;
  /** Injectable fetch (tests, runtimes without a global, custom transports). */
  fetch?: typeof fetch;
  /** Injectable gunzip (see {@link Decompress}). */
  decompress?: Decompress;
  /**
   * WebSocket constructor for the realtime transport. Defaults to
   * `globalThis.WebSocket` (browsers, Node ≥21). Injectable for Node 20
   * (`ws`) and React Native.
   */
  WebSocket?: typeof WebSocket;
  /**
   * The realtime endpoint, e.g. `'ws://localhost:3000/realtime'`. Defaults to
   * `baseUrl` with the protocol swapped (`http`→`ws`, `https`→`wss`) and the
   * path set to `/realtime`.
   */
  realtimeUrl?: string;
}

export interface RequestOptions {
  /** Cancel the request (also cancels a pending timeout). */
  signal?: AbortSignal;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Override the client's default wire format for this request. */
  format?: ClientFormat;
  /** Headers merged over the client's defaults for this request. */
  headers?: Record<string, string>;
  /** Cache spec, e.g. `'ttl=300, stale=60'` — rides on the envelope (spec §8). */
  cache?: string;
  /** Re-query returned after a successful mutation (spec §5) — sugar for `mutate`. */
  return?: string;
}

/** The result of a successful Orbit request (spec §6). */
export interface OrbitResponse<T = unknown> {
  /** The resolved data — `null` when the adapter resolved nothing. */
  data: T;
  /** True when the response was served from a cache (spec §8). */
  fromCache?: boolean;
  /** Cache keys the server asks the client to evict (spec §6/§8). */
  invalidates?: string[];
  /** HTTP status of the response. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** The underlying fetch Response — escape hatch for advanced use. */
  raw: Response;
}
