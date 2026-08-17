import { decodeMsgpack, encodeMsgpack, isRecord } from '@orbit/core';
import type { OrbitEnvelope } from '@orbit/core';
import { MSGPACK_CONTENT_TYPE } from '@orbit/core';
import { OrbitNetworkError, orbitErrorFromWire } from './errors.js';
import type { ClientFormat, Decompress, OrbitResponse } from './types.js';

export const JSON_CONTENT_TYPE = 'application/json';
const textDecoder = new TextDecoder();

export interface HttpDeps {
  baseUrl: string;
  fetchImpl: typeof fetch;
  decompress: Decompress;
  defaultHeaders: Record<string, string>;
  gzip: boolean;
}

export interface WireRequest {
  body: BodyInit;
  /** Sets `content-type`. Omit for FormData bodies (fetch appends the boundary). */
  contentType?: string;
  accept: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The one network primitive: POST a body to the Orbit endpoint with the
 * negotiated headers (content-type, accept, gzip). Does not parse the reply —
 * callers decide (JSON/MessagePack body, SSE stream).
 */
export async function sendRequest(deps: HttpDeps, request: WireRequest): Promise<Response> {
  const headers: Record<string, string> = {
    ...deps.defaultHeaders,
    ...(request.contentType !== undefined ? { 'content-type': request.contentType } : {}),
    accept: request.accept,
    ...(deps.gzip ? { 'accept-encoding': 'gzip' } : {}),
    ...request.headers,
  };
  try {
    return await deps.fetchImpl(deps.baseUrl, {
      method: 'POST',
      headers,
      body: request.body,
      signal: request.signal,
    });
  } catch (error) {
    // An abort is the caller's own cancellation — propagate it as-is so
    // callers can distinguish it (`error.name === 'AbortError'`), exactly
    // like fetch itself.
    if (isAbortError(error)) throw error;
    throw new OrbitNetworkError('Network request failed', { cause: error });
  }
}

/** POST a validated envelope and parse the reply (spec §6/§7). */
export async function postEnvelope(deps: HttpDeps, request: PostRequest): Promise<OrbitResponse> {
  const contentType = request.format === 'msgpack' ? MSGPACK_CONTENT_TYPE : JSON_CONTENT_TYPE;
  const body =
    request.format === 'msgpack'
      ? encodeMsgpack(request.envelope)
      : JSON.stringify(request.envelope);

  const { signal, cleanup } = effectiveSignal(request.signal, request.timeoutMs);
  let res: Response;
  try {
    res = await sendRequest(deps, {
      body,
      contentType,
      accept: contentType,
      headers: request.headers,
      signal,
    });
  } finally {
    cleanup();
  }

  const bytes = await readBodyBytes(res, deps.decompress);
  const payload = decodeBody(bytes, res.headers, res.status);
  if (res.ok) {
    return parseSuccess(res, payload);
  }
  throw parseErrorBody(res, payload);
}

export interface PostRequest {
  /** A validated envelope (already passed through `validateEnvelope`). */
  envelope: OrbitEnvelope;
  format: ClientFormat;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The default gunzip: the web-standard `DecompressionStream`. */
export const defaultDecompress: Decompress = async (body) => {
  // Cast: lib.dom types `DecompressionStream` with a `BufferSource` writable,
  // which pipeThrough's contravariant check rejects against a
  // `Uint8Array` stream — runtime-wise the pairing is valid.
  const stream = body.pipeThrough(
    new DecompressionStream('gzip') as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    },
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export function parseSuccess(res: Response, payload: unknown): OrbitResponse {
  if (!isRecord(payload)) {
    throw new OrbitNetworkError('Invalid response payload', { status: res.status });
  }
  return {
    data: payload.data,
    fromCache: payload.fromCache === true ? true : undefined,
    invalidates: Array.isArray(payload.invalidates) ? payload.invalidates : undefined,
    status: res.status,
    headers: res.headers,
    raw: res,
  };
}

function parseErrorBody(res: Response, payload: unknown): never {
  // Same contract as the server: an OrbitError with a precise code/status.
  const orbitError = orbitErrorFromWire(payload, res.status);
  if (orbitError) throw orbitError;
  throw new OrbitNetworkError(`Orbit request failed with HTTP ${res.status}`, {
    status: res.status,
  });
}

export async function readBodyBytes(res: Response, decompress: Decompress): Promise<Uint8Array> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    throw new OrbitNetworkError('Failed to read response body', {
      status: res.status,
      cause: error,
    });
  }

  const encoding = res.headers.get('content-encoding');
  if (encoding === null || !encoding.toLowerCase().includes('gzip')) {
    return bytes;
  }
  // Some runtimes (undici in Node) transparently decompress gzip responses
  // but keep the `content-encoding` header visible (browsers strip it) —
  // double-gunzipping already-decompressed bytes would fail. Sniff the gzip
  // magic (0x1f 0x8b) to tell "we got the raw stream" from "the runtime
  // already decoded it".
  const isRawGzip = bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isRawGzip) {
    return bytes;
  }
  try {
    return await decompress(new Blob([bytes]).stream());
  } catch (error) {
    throw new OrbitNetworkError('Failed to decompress response', {
      status: res.status,
      cause: error,
    });
  }
}

/** Decode a response body by its content-type; an empty body decodes to nothing. */
export function decodeBody(bytes: Uint8Array, headers: Headers, status: number): unknown {
  if (bytes.byteLength === 0) return undefined;
  const contentType = headers.get('content-type') ?? '';
  if (contentType.includes(MSGPACK_CONTENT_TYPE)) {
    try {
      return decodeMsgpack(bytes);
    } catch (error) {
      throw new OrbitNetworkError('Failed to decode MessagePack response', {
        status,
        cause: error,
      });
    }
  }
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch (error) {
    throw new OrbitNetworkError('Failed to parse JSON response', { status, cause: error });
  }
}

interface EffectiveSignal {
  signal: AbortSignal | undefined;
  cleanup: () => void;
}

/**
 * Combine a caller signal and an optional timeout into one effective signal,
 * with a cleanup that releases the timer and listeners once the request
 * settles (no leak on long-lived callers).
 */
export function effectiveSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): EffectiveSignal {
  if (timeoutMs === undefined) {
    return { signal, cleanup: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  // DOMException (the standard fetch-abort error) is an Error subclass in
  // every modern runtime, so one instanceof check covers it.
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError';
}
