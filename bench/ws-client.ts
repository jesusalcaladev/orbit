/**
 * Minimal raw WebSocket client over `net.Socket` for benchmarks.
 *
 * The global `WebSocket` (undici) does its own buffering and pooling, so a
 * benchmark using it measures the client as much as the server. This client
 * speaks RFC 6455 byte-for-byte (the same handshake + frame codec the server
 * implements) and lets the benchmark time what the server actually does:
 * upgrade handshakes, frame decoding, subscription fan-out, resume replay.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';

export interface BenchFrame {
  opcode: number;
  payload: Buffer;
}

export class BenchWsClient {
  readonly socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #handshakeDone = false;
  #received = 0;
  #onFrame?: (frame: BenchFrame) => void;
  #closed = false;
  #resolveReady: () => void = () => {};
  #rejectReady: (error: Error) => void = () => {};
  #waiters: Array<{ count: number; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(port: number, path = '/realtime', host = '127.0.0.1') {
    this.socket = connect({ port, host });
    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      this.#closed = true;
    });
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
  }

  #ready: Promise<void>;

  /** Perform the HTTP Upgrade handshake and wait for the 101. */
  async connect(): Promise<void> {
    this.socket.write(
      [
        'GET /realtime HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
    this.socket.setNoDelay(true); // WebSocket frames are small; don't let Nagle hold them
    await this.#ready;
  }

  /**
   * Resolve once `count` frames have been received in total (checked against
   * frames that already arrived too). Rejects after `timeoutMs`. The wait is
   * event-driven — no polling, so benchmark timing stays honest.
   */
  awaitFrames(count: number, label = `${count} frames`, timeoutMs = 5000): Promise<void> {
    if (this.#received >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  /** Number of complete frames received so far. */
  get received(): number {
    return this.#received;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Called with every complete server frame (ack, event, resumed, …). */
  set onFrame(fn: ((frame: BenchFrame) => void) | undefined) {
    this.#onFrame = fn;
  }

  subscribe(id: string, oqs: string): void {
    this.#sendText(JSON.stringify({ subscribe: oqs, id }));
  }

  resume(id: string, after: number): void {
    this.#sendText(JSON.stringify({ resume: id, after }));
  }

  /** Graceful close: close frame (1000), then let the server end the socket. */
  close(): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    this.socket.write(this.#frame(0x8, payload));
  }

  #sendText(text: string): void {
    this.socket.write(this.#frame(0x1, Buffer.from(text)));
  }

  /** A masked client frame (clients MUST mask, RFC 6455 §5.1). */
  #frame(opcode: number, payload: Buffer): Buffer {
    const mask = Buffer.from([1, 2, 3, 4]);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i]! ^= mask[i % 4]!;
    return Buffer.concat([header, mask, masked]);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    if (!this.#handshakeDone) {
      const idx = this.#buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this.#buffer.subarray(0, idx).toString('utf8');
      this.#buffer = this.#buffer.subarray(idx + 4);
      this.#handshakeDone = true;
      if (head.includes('101 Switching Protocols')) {
        this.#resolveReady();
      } else {
        this.#rejectReady(new Error(`handshake failed: ${head.split('\r\n')[0] ?? ''}`));
        return;
      }
    }

    for (;;) {
      if (this.#buffer.length < 2) break;
      const b0 = this.#buffer[0]!;
      const length7 = this.#buffer[1]! & 0x7f;
      let length = length7;
      let offset = 2;
      if (length7 === 126) {
        if (this.#buffer.length < 4) break;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length7 === 127) {
        if (this.#buffer.length < 10) break;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buffer.length < offset + length) break;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      this.#received += 1;
      this.#onFrame?.({ opcode: b0 & 0x0f, payload });
      for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.#waiters[i]!;
        if (this.#received >= waiter.count) {
          clearTimeout(waiter.timer);
          this.#waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    }
  }
}
