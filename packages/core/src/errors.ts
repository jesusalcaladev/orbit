import type { OrbitContext } from './types.js';

/** The standard error codes of the Orbit protocol. */
export const ErrorCode = {
  /** Parse error in the OQS syntax, or a malformed envelope. */
  INVALID_QUERY: 'ORBIT_INVALID_QUERY',
  /** No adapter is registered for the requested entity. */
  ENTITY_UNREGISTERED: 'ORBIT_ENTITY_UNREGISTERED',
  /** The resolver rejected the given filters (e.g. invalid UUID). */
  FILTER_INVALID: 'ORBIT_FILTER_INVALID',
  /** Fired by an `onBeforeResolve` hook (auth/authorization). */
  PERMISSION_DENIED: 'ORBIT_PERMISSION_DENIED',
  /** The query tree nests deeper than the configured maximum. */
  MAX_DEPTH_EXCEEDED: 'ORBIT_MAX_DEPTH_EXCEEDED',
  /** The request envelope exceeds the configured size limit. */
  PAYLOAD_TOO_LARGE: 'ORBIT_PAYLOAD_TOO_LARGE',
  /** A mutation action could not be executed. */
  MUTATION_FAILED: 'ORBIT_MUTATION_FAILED',
  /** A realtime subscription could not be established or serviced. */
  SUBSCRIPTION_FAILED: 'ORBIT_SUBSCRIPTION_FAILED',
  /** Anything unexpected. Adapters should throw precise codes when they can. */
  INTERNAL: 'ORBIT_INTERNAL',
} as const;

export type OrbitErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status associated with each standard error code. */
export const ErrorStatus: Record<OrbitErrorCode, number> = {
  [ErrorCode.INVALID_QUERY]: 400,
  [ErrorCode.ENTITY_UNREGISTERED]: 404,
  [ErrorCode.FILTER_INVALID]: 400,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.MAX_DEPTH_EXCEEDED]: 400,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.MUTATION_FAILED]: 500,
  [ErrorCode.SUBSCRIPTION_FAILED]: 500,
  [ErrorCode.INTERNAL]: 500,
};

export interface OrbitErrorOptions {
  /** Override the HTTP status derived from `code`. */
  status?: number;
  /** Extra machine-readable detail attached to the error. */
  details?: unknown;
  cause?: unknown;
}

/**
 * The single error type that travels across the whole protocol.
 *
 * Every error the engine throws — or an adapter raises — implements this
 * shape, so clients can rely on a predictable `{ error: { code, message } }`
 * contract.
 */
export class OrbitError extends Error {
  readonly code: OrbitErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: OrbitErrorCode, message: string, options: OrbitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrbitError';
    this.code = code;
    this.status = options.status ?? ErrorStatus[code];
    this.details = options.details;
  }

  /** The wire shape of the error, as served by the handler. */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function isOrbitError(error: unknown): error is OrbitError {
  return error instanceof OrbitError;
}

/**
 * Generic client-safe message for unexpected errors. The real cause stays
 * available to logs/observability via `cause`, but its text — which may
 * embed secrets (tokens, credentials, SQL, stack internals) — never reaches
 * the wire.
 */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Normalize any thrown value into an OrbitError.
 *
 * Adapters can throw `OrbitError` directly with precise codes (e.g.
 * `ORBIT_FILTER_INVALID`) — those messages are protocol-authored and travel
 * unchanged. Everything else becomes a sanitized `ORBIT_INTERNAL`: the
 * original error is preserved as `cause` for server-side logs only, and its
 * message is never echoed to the client (an adapter that throws a plain
 * `Error` may have embedded a token, a connection string or internal
 * details). Adapters that need a precise client-facing message must throw an
 * `OrbitError` explicitly.
 */
export function toOrbitError(error: unknown, _ctx?: OrbitContext): OrbitError {
  if (isOrbitError(error)) return error;
  return new OrbitError(ErrorCode.INTERNAL, INTERNAL_ERROR_MESSAGE, { cause: error });
}
