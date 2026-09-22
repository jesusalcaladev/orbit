/**
 * A zero-dependency MessagePack codec.
 *
 * Implements the subset needed by the protocol: nil, booleans, integers
 * (fixint/int8–64/uint8–64), floats (32/64), strings, binary, arrays and maps.
 * Objects are encoded with JSON semantics — `undefined` values are omitted,
 * so `{ data, fromCache, invalidates }` round-trips exactly like JSON.
 *
 * Integers beyond 2^53 lose precision on decode (they become JS `number`);
 * `bigint` inputs are encoded losslessly as 64-bit integers but still decode
 * to `number` — send `string` values if you need lossless 64-bit round-trips.
 */

import { setOwn } from '../utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Growable byte writer. The whole encode is a single scratch buffer that
 * grows geometrically; `encodeMsgpack` slices out the exact result at the
 * end. This removes the old O(N)-pushes + O(N)-flatten pattern entirely:
 * writing a 70k-item payload is now one amortized-linear pass with zero
 * per-value allocations (the previous per-byte `number[]` spreading made a
 * 70k encode cost >100 ms and flaked the 5 s test timeout under CI load).
 */
class ByteWriter {
  private buf: Uint8Array = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  len = 0;

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  /** Reserve `n` bytes and return the write offset. */
  claim(n: number): number {
    this.ensure(n);
    const at = this.len;
    this.len += n;
    return at;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len] = b;
    this.len += 1;
  }

  /** Big-endian writes at a previously claimed offset. */
  setUint8(at: number, v: number): void {
    this.view.setUint8(at, v);
  }

  setUint16(at: number, v: number): void {
    this.view.setUint16(at, v, false);
  }

  setUint32(at: number, v: number): void {
    this.view.setUint32(at, v, false);
  }

  setInt16(at: number, v: number): void {
    this.view.setInt16(at, v, false);
  }

  setInt32(at: number, v: number): void {
    this.view.setInt32(at, v, false);
  }

  setBigUint64(at: number, v: bigint): void {
    this.view.setBigUint64(at, v, false);
  }

  setBigInt64(at: number, v: bigint): void {
    this.view.setBigInt64(at, v, false);
  }

  setFloat64(at: number, v: number): void {
    this.view.setFloat64(at, v, false);
  }

  /** Copy raw bytes (UTF-8 payloads, bin payloads) at the write position. */
  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Write an ASCII-only string's char codes at a previously claimed offset. */
  writeAscii(at: number, s: string): void {
    for (let i = 0; i < s.length; i += 1) this.buf[at + i] = s.charCodeAt(i);
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len) as Uint8Array<ArrayBuffer>;
  }
}

/** Encode a JSON-compatible value into MessagePack bytes. */
export function encodeMsgpack(value: unknown): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  write(value, w);
  return w.finish();
}

/**
 * One writer, one growing scratch buffer — never one number per byte. The
 * previous codec spread byte payloads into `number[]` slots
 * (`out.push([...bytes])`), making an N-item payload cost O(N) pushes plus an
 * O(N) element-wise flatten; a 70k-item encode cost >100 ms and flaked the
 * suite's 5 s timeout under CI load. Everything is now written in place into
 * `ByteWriter`'s geometrically growing buffer.
 */
function write(value: unknown, w: ByteWriter): void {
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      w.byte(0xc0); // nil
      return;
    case 'boolean':
      w.byte(value ? 0xc3 : 0xc2);
      return;
    case 'number':
      writeNumber(value, w);
      return;
    case 'bigint':
      writeBigInt(value, w);
      return;
    case 'string':
      writeString(value, w);
      return;
    case 'object':
      if (value === null) {
        w.byte(0xc0);
        return;
      }
      if (value instanceof Uint8Array) {
        writeBin(value, w);
        return;
      }
      if (Array.isArray(value)) {
        writeArray(value, w);
        return;
      }
      writeMap(value as Record<string, unknown>, w);
  }
}

function writeNumber(n: number, w: ByteWriter): void {
  if (Number.isInteger(n)) {
    if (n >= -32 && n <= 127) {
      // positive/negative fixint — `n + 256` maps negatives into 0..255.
      w.byte(n < 0 ? n + 256 : n);
      return;
    }
    if (n >= 0) {
      if (n <= 0xff) {
        const at = w.claim(2);
        w.setUint8(at, 0xcc);
        w.setUint8(at + 1, n);
      } else if (n <= 0xffff) {
        const at = w.claim(3);
        w.setUint8(at, 0xcd);
        w.setUint16(at + 1, n);
      } else if (n <= 0xffff_ffff) {
        const at = w.claim(5);
        w.setUint8(at, 0xce);
        w.setUint32(at + 1, n);
      } else {
        const at = w.claim(9);
        w.setUint8(at, 0xcf);
        w.setBigUint64(at + 1, BigInt(Math.trunc(n)));
      }
      return;
    }
    if (n >= -128) {
      const at = w.claim(2);
      w.setUint8(at, 0xd0);
      w.setUint8(at + 1, n & 0xff);
    } else if (n >= -32768) {
      const at = w.claim(3);
      w.setUint8(at, 0xd1);
      w.setInt16(at + 1, n);
    } else if (n >= -2_147_483_648) {
      const at = w.claim(5);
      w.setUint8(at, 0xd2);
      w.setInt32(at + 1, n);
    } else {
      const at = w.claim(9);
      w.setUint8(at, 0xd3);
      w.setBigInt64(at + 1, BigInt(Math.trunc(n)));
    }
    return; // without this, negative ints would fall through to float64
  }
  // float64
  const at = w.claim(9);
  w.setUint8(at, 0xcb);
  w.setFloat64(at + 1, n);
}

function writeBigInt(n: bigint, w: ByteWriter): void {
  const at = w.claim(9);
  if (n >= 0n) {
    w.setUint8(at, 0xcf);
    w.setBigUint64(at + 1, n);
  } else {
    w.setUint8(at, 0xd3);
    w.setBigInt64(at + 1, n);
  }
}

function writeString(s: string, w: ByteWriter): void {
  // ASCII fast path: map keys and short ASCII values dominate real payloads,
  // and TextEncoder.encode's fixed per-call overhead showed up as ~1.4 s to
  // encode a 70k-key map. Char-code writing skips the encoder and its
  // per-call allocation entirely; multi-byte text still routes through
  // TextEncoder below.
  let ascii = true;
  const n = s.length;
  for (let i = 0; i < n; i += 1) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    if (n <= 31) {
      const at = w.claim(1 + n);
      w.setUint8(at, 0xa0 | n);
      w.writeAscii(at + 1, s);
      return;
    }
    if (n <= 0xff) {
      const at = w.claim(2 + n);
      w.setUint8(at, 0xd9);
      w.setUint8(at + 1, n);
      w.writeAscii(at + 2, s);
      return;
    }
    if (n <= 0xffff) {
      const at = w.claim(3 + n);
      w.setUint8(at, 0xda);
      w.setUint16(at + 1, n);
      w.writeAscii(at + 3, s);
      return;
    }
    const at = w.claim(5 + n);
    w.setUint8(at, 0xdb);
    w.setUint32(at + 1, n);
    w.writeAscii(at + 5, s);
    return;
  }
  const bytes = encoder.encode(s);
  const len = bytes.length;
  if (len <= 31) {
    // Hot path for short strings (object keys, small values): claim the
    // header byte and append the payload in one pass.
    const at = w.claim(1);
    w.setUint8(at, 0xa0 | len);
    w.raw(bytes);
    return;
  }
  if (len <= 0xff) {
    const at = w.claim(2);
    w.setUint8(at, 0xd9);
    w.setUint8(at + 1, len);
  } else if (len <= 0xffff) {
    const at = w.claim(3);
    w.setUint8(at, 0xda);
    w.setUint16(at + 1, len);
  } else {
    const at = w.claim(5);
    w.setUint8(at, 0xdb);
    w.setUint32(at + 1, len);
  }
  w.raw(bytes);
}

function writeBin(bytes: Uint8Array, w: ByteWriter): void {
  const len = bytes.length;
  if (len <= 0xff) {
    const at = w.claim(2);
    w.setUint8(at, 0xc4);
    w.setUint8(at + 1, len);
  } else if (len <= 0xffff) {
    const at = w.claim(3);
    w.setUint8(at, 0xc5);
    w.setUint16(at + 1, len);
  } else {
    const at = w.claim(5);
    w.setUint8(at, 0xc6);
    w.setUint32(at + 1, len);
  }
  w.raw(bytes);
}

function writeArray(arr: unknown[], w: ByteWriter): void {
  const len = arr.length;
  if (len <= 15) w.byte(0x90 | len);
  else if (len <= 0xffff) {
    const at = w.claim(3);
    w.setUint8(at, 0xdc);
    w.setUint16(at + 1, len);
  } else {
    const at = w.claim(5);
    w.setUint8(at, 0xdd);
    w.setUint32(at + 1, len);
  }
  for (let i = 0; i < arr.length; i += 1) {
    const item = arr[i];
    // Inline fixint fast path — large numeric arrays (ids, sensor rows) are
    // the dominant big-payload shape; skipping the `write` dispatch per item
    // keeps encoding linear and cheap even under coverage instrumentation.
    if (typeof item === 'number' && Number.isInteger(item) && item >= -32 && item <= 127) {
      w.byte(item < 0 ? item + 256 : item);
    } else {
      write(item, w);
    }
  }
}

function writeMap(map: Record<string, unknown>, w: ByteWriter): void {
  const entries = Object.entries(map).filter(([, value]) => value !== undefined);
  const len = entries.length;
  if (len <= 15) w.byte(0x80 | len);
  else if (len <= 0xffff) {
    const at = w.claim(3);
    w.setUint8(at, 0xde);
    w.setUint16(at + 1, len);
  } else {
    const at = w.claim(5);
    w.setUint8(at, 0xdf);
    w.setUint32(at + 1, len);
  }
  for (const [key, value] of entries) {
    writeString(key, w);
    // Same inline fixint fast path as `writeArray` (large flat maps).
    if (typeof value === 'number' && Number.isInteger(value) && value >= -32 && value <= 127) {
      w.byte(value < 0 ? value + 256 : value);
    } else {
      write(value, w);
    }
  }
}

/** Decode MessagePack bytes into a JSON-compatible value. */
export function decodeMsgpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const fail = (): never => {
    throw new Error(`Invalid MessagePack near byte ${pos}`);
  };
  const u8 = (): number => {
    if (pos >= bytes.byteLength) fail();
    return view.getUint8(pos++);
  };
  const read = (len: number): number => {
    let value = 0;
    for (let i = 0; i < len; i += 1) value = value * 256 + u8();
    return value;
  };
  // Bounds check before a raw DataView read (floats, big ints, fixed-width
  // ints). A truncated payload must fail with the codec's own error — never
  // a RangeError from the DataView (fuzz-caught: `0xca` alone is 1 byte).
  const need = (len: number): void => {
    if (pos + len > bytes.byteLength) fail();
  };
  const readBytes = (len: number): Uint8Array => {
    if (pos + len > bytes.byteLength) fail();
    const slice = bytes.slice(pos, pos + len);
    pos += len;
    return slice;
  };
  const readString = (len: number): string => {
    if (pos + len > bytes.byteLength) fail();
    const end = pos + len;
    // ASCII fast path: one scan pass, then char-code assembly — skips the
    // slice copy and the per-call TextDecoder overhead, which dominated
    // decoding of key-heavy maps (70k keys → 70k decoder calls). Non-ASCII
    // bytes bail out to the decoder untouched.
    let ascii = true;
    for (let i = pos; i < end; i += 1) {
      if (bytes[i]! > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      let s = '';
      if (len <= 32) {
        for (let i = pos; i < end; i += 1) s += String.fromCharCode(bytes[i]!);
      } else {
        for (let i = pos; i < end; i += 1024) {
          s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 1024, end)));
        }
      }
      pos = end;
      return s;
    }
    const slice = bytes.slice(pos, end);
    pos = end;
    return decoder.decode(slice);
  };

  const readArray = (len: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < len; i += 1) out.push(readValue());
    return out;
  };

  const readMap = (len: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < len; i += 1) {
      const key = readValue();
      // Own property: a map key of `__proto__` from the wire must stay data,
      // not rewrite the decoded object's prototype (see utils#setOwn).
      setOwn(out, String(key), readValue());
    }
    return out;
  };

  // Nesting-depth cap (P0 fuzz hardening): a crafted payload of deeply
  // nested arrays/maps — e.g. 100k `0x91` fixarrays, ~100 KB of bytes —
  // would otherwise recurse until the JS call stack blows (RangeError).
  // A tiny hostile body must fail with a normal codec error, not crash.
  const MAX_NESTING = 512;
  let depth = 0;

  function readValue(): unknown {
    depth += 1;
    if (depth > MAX_NESTING) {
      depth -= 1;
      fail();
    }
    try {
      const b = u8();
      if (b <= 0x7f) return b; // positive fixint
      if (b >= 0xe0) return b - 256; // negative fixint
      if (b >= 0xa0 && b <= 0xbf) return readString(b & 0x1f); // fixstr
      if (b >= 0x90 && b <= 0x9f) return readArray(b & 0x0f); // fixarray
      if (b >= 0x80 && b <= 0x8f) return readMap(b & 0x0f); // fixmap

      switch (b) {
        case 0xc0:
          return null;
        case 0xc2:
          return false;
        case 0xc3:
          return true;
        case 0xc4:
          return readBytes(read(1)); // bin8
        case 0xc5:
          return readBytes(read(2)); // bin16
        case 0xc6:
          return readBytes(read(4)); // bin32
        case 0xca: {
          need(4);
          const value = view.getFloat32(pos, false);
          pos += 4;
          return value;
        }
        case 0xcb: {
          need(8);
          const value = view.getFloat64(pos, false);
          pos += 8;
          return value;
        }
        case 0xcc:
          return read(1); // uint8
        case 0xcd:
          return read(2); // uint16
        case 0xce:
          return read(4); // uint32
        case 0xcf: {
          need(8);
          const value = view.getBigUint64(pos, false);
          pos += 8;
          return Number(value);
        }
        case 0xd0: {
          need(1);
          const value = view.getInt8(pos);
          pos += 1;
          return value;
        }
        case 0xd1: {
          need(2);
          const value = view.getInt16(pos, false);
          pos += 2;
          return value;
        }
        case 0xd2: {
          need(4);
          const value = view.getInt32(pos, false);
          pos += 4;
          return value;
        }
        case 0xd3: {
          need(8);
          const value = view.getBigInt64(pos, false);
          pos += 8;
          return Number(value);
        }
        case 0xd9:
          return readString(read(1)); // str8
        case 0xda:
          return readString(read(2)); // str16
        case 0xdb:
          return readString(read(4)); // str32
        case 0xdc:
          return readArray(read(2)); // array16
        case 0xdd:
          return readArray(read(4)); // array32
        case 0xde:
          return readMap(read(2)); // map16
        case 0xdf:
          return readMap(read(4)); // map32
        default:
          // Extension types (0xc7–0xc9, 0xd4–0xd8) are not part of the protocol.
          throw new Error(`Unsupported MessagePack type 0x${b.toString(16)}`);
      }
    } finally {
      depth -= 1;
    }
  }

  const value = readValue();
  if (pos !== bytes.byteLength) {
    throw new Error(`Trailing bytes in MessagePack payload (${bytes.byteLength - pos} left)`);
  }
  return value;
}
