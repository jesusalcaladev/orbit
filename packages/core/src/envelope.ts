import { ErrorCode, OrbitError } from './errors.js';
import { decodeMsgpack } from './serialize/msgpack.js';
import type { MutationArgs, OrbitEnvelope } from './types.js';
import { byteLength, isRecord } from './utils.js';

const decoder = new TextDecoder();

/** Default maximum envelope size: 10 MiB, per the protocol spec. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Validate and normalize a raw envelope value.
 *
 * Runs on every `execute` call, so envelopes built by hand get the same
 * guarantees as envelopes read from the wire.
 */
export function validateEnvelope(value: unknown): OrbitEnvelope {
  if (!isRecord(value)) {
    throw new OrbitError(ErrorCode.INVALID_QUERY, 'Envelope must be a JSON object');
  }

  const { query, do: action, args, return: returnQuery, cache } = value;

  if (typeof query !== 'string' && typeof action !== 'string') {
    throw new OrbitError(
      ErrorCode.INVALID_QUERY,
      "Envelope must contain a 'query' string or a 'do' action",
    );
  }
  if (typeof query === 'string' && typeof action === 'string') {
    throw new OrbitError(ErrorCode.INVALID_QUERY, "Envelope cannot contain both 'query' and 'do'");
  }

  const envelope: OrbitEnvelope = {};
  if (typeof query === 'string') envelope.query = query;
  if (typeof action === 'string') envelope.do = action;

  if (args !== undefined) {
    if (!isRecord(args)) {
      throw new OrbitError(ErrorCode.INVALID_QUERY, "'args' must be an object");
    }
    envelope.args = args as MutationArgs;
  }
  if (returnQuery !== undefined) {
    if (typeof returnQuery !== 'string') {
      throw new OrbitError(ErrorCode.INVALID_QUERY, "'return' must be a string");
    }
    envelope.return = returnQuery;
  }
  if (cache !== undefined) {
    if (typeof cache !== 'string') {
      throw new OrbitError(ErrorCode.INVALID_QUERY, "'cache' must be a string");
    }
    envelope.cache = cache;
  }

  return envelope;
}

/** Parse a raw JSON body into a validated envelope (single source of truth). */
function parseEnvelopeJson(parse: () => unknown): OrbitEnvelope {
  let parsed: unknown;
  try {
    parsed = parse();
  } catch {
    throw new OrbitError(ErrorCode.INVALID_QUERY, 'Envelope is not valid JSON');
  }
  return validateEnvelope(parsed);
}

/**
 * Read and validate an envelope from raw request bytes, enforcing the
 * configured payload size limit before any parsing work happens.
 *
 * Hot path: uses the known byte length directly (no re-encoding of the
 * decoded string) and decodes the body exactly once.
 */
export function readEnvelopeBytes(bytes: Uint8Array, maxBytes: number): OrbitEnvelope {
  if (bytes.byteLength > maxBytes) {
    throw new OrbitError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      'Request payload exceeds the configured limit',
      {
        details: { maxBytes, received: bytes.byteLength },
      },
    );
  }
  return parseEnvelopeJson(() => JSON.parse(decoder.decode(bytes)));
}

/**
 * Read and validate an envelope from a raw request body, enforcing the
 * configured payload size limit before any parsing work happens.
 */
export function readEnvelope(body: string, maxBytes: number): OrbitEnvelope {
  const size = byteLength(body);
  if (size > maxBytes) {
    throw new OrbitError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      'Request payload exceeds the configured limit',
      {
        details: { maxBytes, received: size },
      },
    );
  }
  return parseEnvelopeJson(() => JSON.parse(body));
}

/**
 * Read and validate an envelope from a MessagePack request body, enforcing the
 * configured payload size limit. Clients may POST envelopes as `application/x-msgpack`.
 */
export function readMsgpackEnvelope(bytes: Uint8Array, maxBytes: number): OrbitEnvelope {
  if (bytes.byteLength > maxBytes) {
    throw new OrbitError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      'Request payload exceeds the configured limit',
      {
        details: { maxBytes, received: bytes.byteLength },
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = decodeMsgpack(bytes);
  } catch {
    throw new OrbitError(ErrorCode.INVALID_QUERY, 'Envelope is not valid MessagePack');
  }

  return validateEnvelope(parsed);
}
