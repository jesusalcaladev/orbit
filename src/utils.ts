import type { SerializedPayload } from './types.js';

/** Narrow a runtime value to a plain object (not array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detect the contract returned by plugins that serialize to a non-JSON format. */
export function isSerializedPayload(value: unknown): value is SerializedPayload {
  if (!isRecord(value)) return false;
  if (typeof value.contentType !== 'string') return false;
  return typeof value.body === 'string' || value.body instanceof Uint8Array;
}

/** Byte length of a string in UTF-8, without allocating extra buffers. */
const encoder = new TextEncoder();
export function byteLength(input: string): number {
  return encoder.encode(input).byteLength;
}

/** FNV-1a 32-bit hash → base36 string. Stable across platforms and runs. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
