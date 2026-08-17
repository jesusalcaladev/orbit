import { OrbitError } from '@orbit/core';
import type { OrbitErrorCode } from '@orbit/core';
import { isRecord } from '@orbit/core';

/**
 * A transport-level failure: the network itself, an unparseable response body,
 * a decompression error, or an HTTP response that does not speak the Orbit
 * error contract (spec §6).
 *
 * Contrast with `OrbitError` (from `@orbit/core`): the server throws that one
 * with a precise `code`/`status`/`details`; this one means *we never got a
 * valid Orbit answer at all*.
 */
export class OrbitNetworkError extends Error {
  /** HTTP status of the response, when one was received. */
  readonly status: number | undefined;

  /** The underlying failure (fetch rejection, parse error, …). */
  override readonly cause: unknown;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrbitNetworkError';
    this.status = options.status;
    this.cause = options.cause;
  }
}

/**
 * Parse a decoded wire payload (`{ error: { code, message, details? } }`,
 * spec §6) into an `OrbitError`. Returns `undefined` when the payload is not
 * an Orbit error at all (then the caller decides: network error, SSE frame,
 * …).
 */
export function orbitErrorFromWire(payload: unknown, status: number): OrbitError | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const { code, message, details } = payload.error;
  if (typeof code !== 'string') return undefined;
  return new OrbitError(
    code as OrbitErrorCode,
    typeof message === 'string' ? message : 'Orbit request failed',
    {
      status,
      ...(details !== undefined ? { details } : {}),
    },
  );
}
