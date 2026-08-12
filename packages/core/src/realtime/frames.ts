/**
 * RFC 6455 — the WebSocket protocol, hand-rolled to honor the zero-dependency
 * mandate. Server side only: the HTTP Upgrade handshake, frame encoding
 * (unmasked, server → client) and incremental frame decoding (masked,
 * client → server), plus ping/pong/close control frames.
 *
 * We implement exactly what the protocol requires of a server: clients MUST
 * mask their frames (enforced), control frames MUST be FIN and ≤ 125 bytes
 * (enforced), and fragmented messages are reassembled by the session.
 */
import { createHash } from 'node:crypto';

/** The magic GUID every Sec-WebSocket-Accept is derived from (RFC 6455 §4.2.2). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** WebSocket frame opcodes (RFC 6455 §5.2). */
export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

/** Well-known close codes (RFC 6455 §7.4.1). */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  Unsupported: 1003,
  PolicyViolation: 1008,
  TooBig: 1009,
  Internal: 1011,
} as const;

/**
 * Compute the `Sec-WebSocket-Accept` value for an Upgrade handshake
 * (RFC 6455 §4.2.2): SHA-1 of `key + GUID`, base64-encoded.
 */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey + WS_GUID)
    .digest('base64');
}

/** The raw HTTP 101 response for a valid Upgrade request. */
export function upgradeResponse(secWebSocketKey: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${computeAcceptKey(secWebSocketKey)}`,
    '\r\n',
  ].join('\r\n');
}

/**
 * Encode a single server → client frame (always FIN, never masked —
 * RFC 6455 §5.1 requires masking only of client frames).
 */
export function encodeFrame(opcode: number, payload: Uint8Array | Buffer): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload instanceof Buffer ? payload : Buffer.from(payload)]);
}

/** A close frame carrying a status code and optional reason. */
export function closeFrame(code: number, reason = ''): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  if (reason.length > 0) payload.write(reason, 2);
  return encodeFrame(Opcode.Close, payload);
}

/** A decoded (and unmasked) frame from the client. */
export interface Frame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

/**
 * Thrown when a frame's declared length exceeds the decoder's limit. The
 * session maps this to a 1009 close BEFORE the payload is buffered, so a
 * malicious client can't force unbounded memory usage.
 */
export class FrameTooLargeError extends Error {
  constructor(declared: number, limit: number) {
    super(`Frame declares ${declared} bytes (limit ${limit})`);
    this.name = 'FrameTooLargeError';
  }
}

/**
 * Incremental frame decoder for client → server traffic.
 *
 * Socket `data` events rarely align with frame boundaries, so `push` buffers
 * partial data and yields every complete frame it can read. Throws on
 * protocol violations (unmasked client frames, RSV bits set, oversized or
 * non-FIN control frames) — the session turns those into a 1002 close.
 */
export class FrameDecoder {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  readonly #maxFrameSize: number;

  /** `maxFrameSize` bounds a single frame's declared length (memory DoS guard). */
  constructor(maxFrameSize = 16 * 1024 * 1024) {
    this.#maxFrameSize = maxFrameSize;
  }

  push(chunk: Buffer): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.#tryRead();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  #tryRead(): Frame | undefined {
    const buf = this.#buffer;
    if (buf.length < 2) return undefined;

    const fin = (buf[0]! & 0x80) !== 0;
    const rsv = buf[0]! & 0x70;
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let length = buf[1]! & 0x7f;
    let offset = 2;

    // Validate everything the 2-byte header already tells us BEFORE waiting
    // for the payload — a violating frame is rejected instantly, so an
    // attacker cannot force buffering by pairing a violation with a large
    // declared length (fail-fast beats bounded-buffering).
    if (rsv !== 0) throw new Error('RSV bits must be zero');
    if (!masked) throw new Error('Client frames must be masked (RFC 6455 §5.1)');
    if (opcode >= Opcode.Close && (length > 125 || !fin)) {
      // A control frame uses the 7-bit length directly: 126/127-coded frames
      // are ≥ 126 bytes, so `length > 125` catches extended lengths too.
      throw new Error('Control frames must be FIN and ≤ 125 bytes');
    }

    if (length === 126) {
      if (buf.length < 4) return undefined;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Frame payload exceeds the safe integer range');
      }
      length = Number(big);
      offset = 10;
    }

    if (length > this.#maxFrameSize) throw new FrameTooLargeError(length, this.#maxFrameSize);

    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) return undefined;

    const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
    offset += maskLength;
    // Copy (not a view) — unmasking mutates the payload in place.
    const payload = Buffer.allocUnsafe(length);
    buf.copy(payload, 0, offset, offset + length);
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
    }
    this.#buffer = buf.subarray(offset + length);
    return { opcode, fin, payload };
  }
}
