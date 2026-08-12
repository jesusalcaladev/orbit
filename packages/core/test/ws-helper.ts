/**
 * A raw WebSocket client over `net.Socket` for protocol-level security tests.
 *
 * The public `WebSocket` (undici) only speaks *valid* protocol — it cannot send
 * an unmasked frame, set RSV bits, send a reserved opcode, or declare a 1 GB
 * payload it never delivers. Security tests need a client that can BREAK the
 * protocol on purpose, so this helper builds frames byte-by-byte (RFC 6455
 * §5.2) and parses the server's responses the same way.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';

export interface FrameOptions {
  /** FIN bit. Defaults to true. */
  fin?: boolean;
  /** RSV bits to set (0–7). Any nonzero value is a protocol violation. */
  rsv?: number;
  /** Raw opcode byte (defaults to text, 0x1). */
  opcode?: number;
  /** Whether to mask the payload. The server REQUIRES client frames masked. */
  masked?: boolean;
  /** 4-byte mask key (defaults to [1, 2, 3, 4]). */
  maskKey?: Buffer;
  /**
   * Declared-length override: claim a frame of this size without sending its
   * bytes (tests the server's memory-DoS guard).
   */
  declaredLength?: number;
}

/** Build a client → server frame with optional protocol violations. */
export function buildClientFrame(payload: Buffer, options: FrameOptions = {}): Buffer {
  const fin = options.fin ?? true;
  const rsv = options.rsv ?? 0;
  const opcode = options.opcode ?? 0x1;
  const masked = options.masked ?? true;
  const maskKey = options.maskKey ?? Buffer.from([1, 2, 3, 4]);
  const declared = options.declaredLength ?? payload.length;

  const b0 = (fin ? 0x80 : 0) | ((rsv & 0x7) << 4) | (opcode & 0x0f);
  let header: Buffer;
  if (declared < 126) {
    header = Buffer.from([b0, (masked ? 0x80 : 0) | declared]);
  } else if (declared <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(declared, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(declared), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);

  const maskedPayload = Buffer.from(payload);
  for (let i = 0; i < maskedPayload.length; i += 1) maskedPayload[i]! ^= maskKey[i % 4]!;
  return Buffer.concat([header, maskKey, maskedPayload]);
}

/** A complete server → client frame (server frames are never masked). */
export interface ServerFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

export interface HandshakeResult {
  /** HTTP status of the upgrade attempt (0 if the socket closed with no response). */
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface ConnectOptions {
  /** Upgrade path. Defaults to `/realtime`. */
  path?: string;
  /** HTTP method. Defaults to `GET` (the only legal one for an upgrade). */
  method?: string;
  /**
   * Extra/override request headers. Pass `null` as a value to REMOVE a default
   * header (e.g. test a missing `Sec-WebSocket-Key`).
   */
  headers?: Record<string, string | null>;
}

interface Waiter {
  predicate: (frame: ServerFrame) => boolean;
  resolve: (frame: ServerFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RawWsClient {
  readonly socket: Socket;
  /** Every complete frame the server sent (in order). */
  readonly frames: ServerFrame[] = [];

  #buffer: Buffer = Buffer.alloc(0);
  #handshakeDone = false;
  #closeCode?: number;
  #closeReason = '';
  #closed = false;
  #resolveHandshake: (result: HandshakeResult) => void = () => {};
  #waiters: Waiter[] = [];

  constructor(port: number, host = '127.0.0.1') {
    this.socket = connect({ port, host });
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('close', () => {
      this.#closed = true;
      if (!this.#handshakeDone) {
        this.#handshakeDone = true;
        this.#resolveHandshake({ status: 0, statusText: '', headers: {} });
      }
    });
    // ECONNRESET is expected when the server kills a violating connection.
    this.socket.on('error', () => {});
  }

  /** Perform the HTTP Upgrade handshake and wait for the server's response. */
  connect(options: ConnectOptions = {}): Promise<HandshakeResult> {
    const path = options.path ?? '/realtime';
    const method = options.method ?? 'GET';
    const defaults: Record<string, string | null> = {
      Host: 'localhost',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...options.headers,
    };
    const lines = [`${method} ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(defaults)) {
      if (value !== null) lines.push(`${name}: ${value}`);
    }
    this.socket.write(lines.concat(['', '']).join('\r\n'));
    return new Promise<HandshakeResult>((resolve) => {
      this.#resolveHandshake = resolve;
    });
  }

  /** Close code from the server's close frame (if any). */
  get closeCode(): number | undefined {
    return this.#closeCode;
  }

  /** Reason string from the server's close frame (if any). */
  get closeReason(): string {
    return this.#closeReason;
  }

  get closed(): boolean {
    return this.#closed;
  }

  sendText(text: string): void {
    this.socket.write(buildClientFrame(Buffer.from(text), { opcode: 0x1 }));
  }

  sendBinary(payload: Buffer): void {
    this.socket.write(buildClientFrame(payload, { opcode: 0x2 }));
  }

  /** Send raw frame bytes (already-built, possibly malformed). */
  sendRaw(frame: Buffer): void {
    this.socket.write(frame);
  }

  /** Send a graceful close frame with a status code and optional reason. */
  close(code = 1000, reason = ''): void {
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(buildClientFrame(payload, { opcode: 0x8 }));
  }

  /**
   * Resolve with the next frame matching `predicate` (checked against frames
   * that already arrived too). Rejects after `timeoutMs`.
   */
  awaitFrame(
    predicate: (frame: ServerFrame) => boolean,
    label: string,
    timeoutMs = 3000,
  ): Promise<ServerFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(new Error(`Timed out (${timeoutMs} ms) waiting for: ${label}`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /** Resolve when the underlying socket closes (server terminated the connection). */
  waitForClose(timeoutMs = 3000): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out (${timeoutMs} ms) waiting for socket close`)),
        timeoutMs,
      );
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  dispose(): void {
    this.socket.destroy();
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    // Parse the handshake response first (it ends at the first \r\n\r\n).
    if (!this.#handshakeDone) {
      const idx = this.#buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this.#buffer.subarray(0, idx).toString('utf8');
      this.#buffer = this.#buffer.subarray(idx + 4);
      this.#handshakeDone = true;

      const [statusLine = '', ...headerLines] = head.split('\r\n');
      const match = /^HTTP\/1\.1 (\d{3})\s?(.*)$/.exec(statusLine);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      this.#resolveHandshake({
        status: match ? Number(match[1]) : 0,
        statusText: match?.[2] ?? '',
        headers,
      });
    }

    this.#parseFrames();
  }

  #parseFrames(): void {
    for (;;) {
      if (this.#buffer.length < 2) return;
      const b0 = this.#buffer[0]!;
      const b1 = this.#buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buffer.length < offset + length) return;

      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      const frame: ServerFrame = { opcode, fin, payload };
      this.frames.push(frame);
      if (opcode === 0x8 && payload.length >= 2) {
        this.#closeCode = payload.readUInt16BE(0);
        this.#closeReason = payload.subarray(2).toString('utf8');
      }
      for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.#waiters[i]!;
        if (waiter.predicate(frame)) {
          clearTimeout(waiter.timer);
          this.#waiters.splice(i, 1);
          waiter.resolve(frame);
        }
      }
    }
  }
}
