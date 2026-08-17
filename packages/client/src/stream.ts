import { encodeMsgpack, isRecord } from '@orbit/core';
import type { OrbitEnvelope, OrbitStreamEvent } from '@orbit/core';
import { MSGPACK_CONTENT_TYPE, SSE_CONTENT_TYPE } from '@orbit/core';
import { OrbitNetworkError, orbitErrorFromWire } from './errors.js';
import { JSON_CONTENT_TYPE, effectiveSignal, sendRequest } from './http.js';
import type { HttpDeps } from './http.js';
import type { ClientFormat } from './types.js';

export interface StreamRequest {
  /** A validated envelope (already passed through `validateEnvelope`). */
  envelope: OrbitEnvelope;
  format: ClientFormat;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Stream a query's graph level by level over `text/event-stream` (spec §7):
 *
 * ```text
 * data: {"level":0,"data":{…}}
 * data: {"level":1,"data":{…}}
 * data: {"level":"done","data":{…}}
 * ```
 *
 * Each frame becomes one `OrbitStreamEvent`; mid-stream errors arrive as
 * `data: {"error":{…}}` frames and throw the standard `OrbitError`. The
 * generator respects `signal` — aborting cancels the body read, not just the
 * fetch — and cleans up its timers/listeners when iteration ends.
 */
export async function* streamEvents(
  deps: HttpDeps,
  request: StreamRequest,
): AsyncGenerator<OrbitStreamEvent> {
  const contentType = request.format === 'msgpack' ? MSGPACK_CONTENT_TYPE : JSON_CONTENT_TYPE;
  const body =
    request.format === 'msgpack'
      ? encodeMsgpack(request.envelope)
      : JSON.stringify(request.envelope);
  const { signal, cleanup } = effectiveSignal(request.signal, request.timeoutMs);

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => {
    // Cancel the body read — the pending read() resolves, the loop ends, and
    // the connection is released. The abort error is thrown below. `cancel`
    // rejects only if the body stream errors while canceling — swallowed.
    if (reader !== undefined) {
      /* v8 ignore next — see above. */
      reader.cancel().catch(() => {});
    }
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort);

  try {
    const res = await sendRequest(deps, {
      body,
      contentType,
      accept: SSE_CONTENT_TYPE,
      headers: request.headers,
      signal,
    });

    if (!res.ok) {
      // A failed query answers with an SSE error frame (spec §6 over SSE).
      throw await sseErrorFromResponse(res);
    }

    reader = (await gunzipIfNeeded(res)).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = parseSseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (event === undefined) continue;
        if (event.error !== undefined) throw sseErrorFromFrame(event.error, res.status);
        const streamEvent = toStreamEvent(event);
        if (streamEvent !== undefined) yield streamEvent;
      }
    }
    // A trailing frame without the final blank line.
    const event = parseSseFrame(buffer);
    if (event !== undefined) {
      if (event.error !== undefined) throw sseErrorFromFrame(event.error, res.status);
      const streamEvent = toStreamEvent(event);
      if (streamEvent !== undefined) yield streamEvent;
    }

    // The abort listener cancelled the body read, ending the loop — surface
    // the abort (same contract as fetch: `error.name === 'AbortError'`).
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Aborted', 'AbortError');
    }
  } finally {
    if (reader !== undefined) {
      /* v8 ignore next — cancel() rejects only if the body stream errors. */
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    cleanup();
  }
}

/** A parsed SSE `data:` payload that speaks the Orbit stream contract. */
function toStreamEvent(message: Record<string, unknown>): OrbitStreamEvent | undefined {
  if (message.level !== 'done' && typeof message.level !== 'number') return undefined;
  return {
    level: message.level,
    data: message.data,
    ...(message.fromCache === true ? { fromCache: true } : {}),
    ...(typeof message.contentType === 'string' ? { contentType: message.contentType } : {}),
  };
}

/**
 * The SSE parser: extract the JSON carried by `data:` lines of one frame.
 *
 * `data:` lines are joined with `\n` (SSE spec); a leading space after the
 * colon is stripped. Comments (`:`) and other fields (`event`, `id`, `retry`)
 * are ignored — the wire carries only `data:` frames.
 */
export function parseSseFrame(frame: string): Record<string, unknown> | undefined {
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      data += (data === '' ? '' : '\n') + value;
    }
  }
  if (data === '') return undefined;
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A non-200 SSE response carries its `{ error }` in the first frame. */
async function sseErrorFromResponse(res: Response): Promise<never> {
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw new OrbitNetworkError('Failed to read response body', {
      status: res.status,
      cause: error,
    });
  }
  const message = parseSseFrame(text);
  throw sseErrorFromFrame(message?.error, res.status);
}

function sseErrorFromFrame(errorField: unknown, status: number): never {
  const orbitError = orbitErrorFromWire({ error: errorField }, status);
  if (orbitError) throw orbitError;
  throw new OrbitNetworkError(`Orbit request failed with HTTP ${status}`, { status });
}

/**
 * SSE responses can be gzip-compressed (the engine compresses the whole
 * stream). Runtime behavior differs: browsers and undici keep the raw gzip
 * bytes on `body` streams, but some runtimes decode while leaving the header.
 * Sniff the gzip magic on the first chunk; when raw, stream-decompress with
 * the web-standard `DecompressionStream`; otherwise pass through. Runtimes
 * without `DecompressionStream` (React Native) should pass `gzip: false`.
 */
async function gunzipIfNeeded(res: Response): Promise<ReadableStream<Uint8Array>> {
  const body = res.body;
  if (body === null) return new ReadableStream({ start: (c) => c.close() });
  const encoding = res.headers.get('content-encoding') ?? '';
  if (!encoding.toLowerCase().includes('gzip')) return body;

  // Peek the first chunk through the SAME reader that will deliver the rest —
  // a separate read would consume the stream.
  const reader = body.getReader();
  const first = await reader.read();
  const raw =
    first.value !== undefined &&
    first.value.byteLength >= 2 &&
    first.value[0] === 0x1f &&
    first.value[1] === 0x8b;
  const source = replay(reader, first);
  if (!raw) return source;
  return source.pipeThrough(
    new DecompressionStream('gzip') as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    },
  );
}

/** A stream that replays one already-read chunk, then pulls from `reader`. */
function replay(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: ReadableStreamReadResult<Uint8Array>,
): ReadableStream<Uint8Array> {
  let replayed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (first.done) {
          controller.close();
          return;
        }
        controller.enqueue(first.value!);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      /* v8 ignore next — see above. */
      reader.cancel().catch(() => {});
    },
  });
}
