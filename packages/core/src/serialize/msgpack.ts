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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a JSON-compatible value into MessagePack bytes. */
export function encodeMsgpack(value: unknown): Uint8Array<ArrayBuffer> {
  const chunks: number[][] = [];
  write(value, chunks);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function write(value: unknown, out: number[][]): void {
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      out.push([0xc0]); // nil
      return;
    case 'boolean':
      out.push(value ? [0xc3] : [0xc2]);
      return;
    case 'number':
      writeNumber(value, out);
      return;
    case 'bigint':
      writeBigInt(value, out);
      return;
    case 'string':
      writeString(value, out);
      return;
    case 'object':
      if (value === null) {
        out.push([0xc0]);
        return;
      }
      if (value instanceof Uint8Array) {
        writeBin(value, out);
        return;
      }
      if (Array.isArray(value)) {
        writeArray(value, out);
        return;
      }
      writeMap(value as Record<string, unknown>, out);
  }
}

function writeNumber(n: number, out: number[][]): void {
  if (Number.isInteger(n)) {
    if (n >= -32 && n <= 127) {
      out.push([n < 0 ? n + 256 : n]); // positive/negative fixint
      return;
    }
    if (n >= 0) {
      if (n <= 0xff) out.push([0xcc, n]);
      else if (n <= 0xffff) out.push([0xcd, n >> 8, n & 0xff]);
      else if (n <= 0xffff_ffff) {
        out.push([0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
      } else {
        out.push([0xcf, ...u64Bytes(n)]);
      }
      return;
    }
    if (n >= -128) out.push([0xd0, n & 0xff]);
    else if (n >= -32768) out.push([0xd1, (n >> 8) & 0xff, n & 0xff]);
    else if (n >= -2_147_483_648) {
      out.push([0xd2, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
    } else {
      out.push([0xd3, ...i64Bytes(n)]);
    }
    return; // without this, negative ints would fall through to float64
  }
  // float64
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  out.push([0xcb, ...new Uint8Array(view.buffer)]);
}

function writeBigInt(n: bigint, out: number[][]): void {
  const view = new DataView(new ArrayBuffer(8));
  if (n >= 0n) {
    view.setBigUint64(0, n);
    out.push([0xcf, ...new Uint8Array(view.buffer)]);
  } else {
    view.setBigInt64(0, n);
    out.push([0xd3, ...new Uint8Array(view.buffer)]);
  }
}

function writeString(s: string, out: number[][]): void {
  const bytes = encoder.encode(s);
  const len = bytes.length;
  if (len <= 31) out.push([0xa0 | len]);
  else if (len <= 0xff) out.push([0xd9, len]);
  else if (len <= 0xffff) out.push([0xda, len >> 8, len & 0xff]);
  else out.push([0xdb, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  out.push([...bytes]);
}

function writeBin(bytes: Uint8Array, out: number[][]): void {
  const len = bytes.length;
  if (len <= 0xff) out.push([0xc4, len]);
  else if (len <= 0xffff) out.push([0xc5, len >> 8, len & 0xff]);
  else out.push([0xc6, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  out.push([...bytes]);
}

function writeArray(arr: unknown[], out: number[][]): void {
  const len = arr.length;
  if (len <= 15) out.push([0x90 | len]);
  else if (len <= 0xffff) out.push([0xdc, len >> 8, len & 0xff]);
  else out.push([0xdd, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  for (const item of arr) write(item, out);
}

function writeMap(map: Record<string, unknown>, out: number[][]): void {
  const entries = Object.entries(map).filter(([, value]) => value !== undefined);
  const len = entries.length;
  if (len <= 15) out.push([0x80 | len]);
  else if (len <= 0xffff) out.push([0xde, len >> 8, len & 0xff]);
  else out.push([0xdf, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  for (const [key, value] of entries) {
    writeString(key, out);
    write(value, out);
  }
}

function u64Bytes(n: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(Math.trunc(n)));
  return [...new Uint8Array(view.buffer)];
}

function i64Bytes(n: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigInt64(0, BigInt(Math.trunc(n)));
  return [...new Uint8Array(view.buffer)];
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
  const readBytes = (len: number): Uint8Array => {
    if (pos + len > bytes.byteLength) fail();
    const slice = bytes.slice(pos, pos + len);
    pos += len;
    return slice;
  };
  const readString = (len: number): string => decoder.decode(readBytes(len));

  const readArray = (len: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < len; i += 1) out.push(readValue());
    return out;
  };

  const readMap = (len: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < len; i += 1) {
      const key = readValue();
      out[String(key)] = readValue();
    }
    return out;
  };

  function readValue(): unknown {
    const b = u8();
    if (b <= 0x7f) return b; // positive fixint
    if (b >= 0xe0) return b - 256; // negative fixint
    if (b >= 0xa0 && b <= 0xbf) return readString(b & 0x1f); // fixstr
    if (b >= 0x90 && b <= 0x9f) return readArray(b & 0x0f); // fixarray
    if (b >= 0x80 && b <= 0x8f) return readMap(b & 0x0f); // fixmap

    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return readBytes(read(1)); // bin8
      case 0xc5: return readBytes(read(2)); // bin16
      case 0xc6: return readBytes(read(4)); // bin32
      case 0xca: {
        const value = view.getFloat32(pos, false);
        pos += 4;
        return value;
      }
      case 0xcb: {
        const value = view.getFloat64(pos, false);
        pos += 8;
        return value;
      }
      case 0xcc: return read(1); // uint8
      case 0xcd: return read(2); // uint16
      case 0xce: return read(4); // uint32
      case 0xcf: {
        const value = view.getBigUint64(pos, false);
        pos += 8;
        return Number(value);
      }
      case 0xd0: {
        const value = view.getInt8(pos);
        pos += 1;
        return value;
      }
      case 0xd1: {
        const value = view.getInt16(pos, false);
        pos += 2;
        return value;
      }
      case 0xd2: {
        const value = view.getInt32(pos, false);
        pos += 4;
        return value;
      }
      case 0xd3: {
        const value = view.getBigInt64(pos, false);
        pos += 8;
        return Number(value);
      }
      case 0xd9: return readString(read(1)); // str8
      case 0xda: return readString(read(2)); // str16
      case 0xdb: return readString(read(4)); // str32
      case 0xdc: return readArray(read(2)); // array16
      case 0xdd: return readArray(read(4)); // array32
      case 0xde: return readMap(read(2)); // map16
      case 0xdf: return readMap(read(4)); // map32
      default:
        // Extension types (0xc7–0xc9, 0xd4–0xd8) are not part of the protocol.
        throw new Error(`Unsupported MessagePack type 0x${b.toString(16)}`);
    }
  }

  const value = readValue();
  if (pos !== bytes.byteLength) {
    throw new Error(`Trailing bytes in MessagePack payload (${bytes.byteLength - pos} left)`);
  }
  return value;
}
