import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  FrameDecoder,
  FrameTooLargeError,
  Opcode,
  closeFrame,
  computeAcceptKey,
  encodeFrame,
  upgradeResponse,
} from '../src/realtime/frames.js';

/** Build a masked client frame (as a real browser/undici client would send). */
function clientFrame(opcode: number, payload: string | Buffer, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i]! ^= mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

describe('handshake', () => {
  it('computes the RFC 6455 Sec-WebSocket-Accept test vector', () => {
    // The vector from RFC 6455 §1.3.
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('builds a complete 101 response', () => {
    const raw = upgradeResponse('dGhlIHNhbXBsZSBub25jZQ==');
    expect(raw).toContain('HTTP/1.1 101 Switching Protocols');
    expect(raw).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('encodeFrame', () => {
  it('uses 7-bit length for short payloads', () => {
    const frame = encodeFrame(Opcode.Text, Buffer.from('hello'));
    expect([...frame]).toEqual([0x81, 5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('uses 16-bit length for medium payloads', () => {
    const frame = encodeFrame(Opcode.Text, Buffer.alloc(300, 0x61));
    expect(frame[0]).toBe(0x81);
    expect(frame[1]).toBe(126);
    expect(frame.readUInt16BE(2)).toBe(300);
    expect(frame.length).toBe(4 + 300);
  });

  it('uses 64-bit length for large payloads', () => {
    const frame = encodeFrame(Opcode.Binary, Buffer.alloc(70_000, 0x62));
    expect(frame[0]).toBe(0x82);
    expect(frame[1]).toBe(127);
    expect(frame.readBigUInt64BE(2)).toBe(70_000n);
    expect(frame.length).toBe(10 + 70_000);
  });

  it('encodes close frames with a status code', () => {
    const frame = closeFrame(CloseCode.Normal, 'bye');
    expect(frame[0]).toBe(0x88);
    expect(frame.readUInt16BE(2)).toBe(1000);
    expect(frame.subarray(4).toString('utf8')).toBe('bye');
  });
});

describe('FrameDecoder', () => {
  it('decodes a masked text frame', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(clientFrame(Opcode.Text, 'Hello'));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(Opcode.Text);
    expect(frames[0]!.fin).toBe(true);
    expect(frames[0]!.payload.toString('utf8')).toBe('Hello');
  });

  it('decodes frames split across arbitrary chunk boundaries', () => {
    const raw = Buffer.concat([clientFrame(Opcode.Text, 'first'), clientFrame(Opcode.Text, 'second')]);
    const decoder = new FrameDecoder();
    const frames: ReturnType<FrameDecoder['push']>[number][] = [];
    for (let i = 0; i < raw.length; i += 1) {
      frames.push(...decoder.push(raw.subarray(i, i + 1)));
    }
    expect(frames.map((f) => f.payload.toString('utf8'))).toEqual(['first', 'second']);
  });

  it('decodes 16-bit and 64-bit masked lengths', () => {
    const decoder = new FrameDecoder();
    const medium = decoder.push(clientFrame(Opcode.Binary, Buffer.alloc(300, 7)));
    expect(medium[0]!.payload.length).toBe(300);
    const large = decoder.push(clientFrame(Opcode.Binary, Buffer.alloc(70_000, 9)));
    expect(large[0]!.payload.length).toBe(70_000);
    expect(large[0]!.payload[0]).toBe(9);
  });

  it('decodes ping/pong/close control frames', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      Buffer.concat([
        clientFrame(Opcode.Ping, 'hi'),
        clientFrame(Opcode.Pong, 'ok'),
        clientFrame(Opcode.Close, Buffer.from([0x03, 0xe8])),
      ]),
    );
    expect(frames.map((f) => f.opcode)).toEqual([Opcode.Ping, Opcode.Pong, Opcode.Close]);
    expect(frames[2]!.payload.readUInt16BE(0)).toBe(1000);
  });

  it('throws on unmasked client frames', () => {
    const decoder = new FrameDecoder();
    const unmasked = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(() => decoder.push(unmasked)).toThrow();
  });

  it('throws on RSV bits set', () => {
    const decoder = new FrameDecoder();
    const rsv = Buffer.from([0xc1, 0x80, 1, 2, 3, 4, 0]);
    expect(() => decoder.push(rsv)).toThrow(/RSV/);
  });

  it('throws on control frames larger than 125 bytes', () => {
    const decoder = new FrameDecoder();
    const bigPing = clientFrame(Opcode.Ping, Buffer.alloc(126));
    expect(() => decoder.push(bigPing)).toThrow(/Control frames/);
  });

  it('rejects frames whose declared length exceeds the limit (memory DoS guard)', () => {
    const decoder = new FrameDecoder(1024);
    // Declares 70_000 bytes but sends none — rejected before any buffering.
    const declared = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
    expect(() => decoder.push(declared)).toThrowError(FrameTooLargeError);
  });

  it('accepts frames at or under the limit', () => {
    const decoder = new FrameDecoder(1024);
    const frames = decoder.push(clientFrame(Opcode.Text, 'x'.repeat(1024)));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(1024);
  });

  it('keeps partial frames buffered', () => {
    const decoder = new FrameDecoder();
    const raw = clientFrame(Opcode.Text, 'Hello');
    const first = decoder.push(raw.subarray(0, 3)); // only part of the header
    expect(first).toHaveLength(0);
    const rest = decoder.push(raw.subarray(3));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.payload.toString('utf8')).toBe('Hello');
  });
});
