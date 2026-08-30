import type { SerializedPayload } from './types.js';

/** Narrow a runtime value to a plain object (not array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Define an OWN property on a plain object, bypassing the `__proto__` setter.
 *
 * Adapter filters, parsed relation maps and decoded msgpack maps all receive
 * attacker-controlled keys (`user(__proto__="x")`, a map key `__proto__`, …).
 * A plain `obj[key] = value` assignment with `__proto__` silently rewrites the
 * object's prototype instead of creating an own key — prototype pollution. An
 * own property keeps the value verbatim, exactly what the contract promises
 * for verbatim filters, and never touches `Object.prototype`.
 */
export function setOwn<T extends object>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
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

/**
 * Double FNV-1a 32-bit (two different offset bases) → 64-bit base36 string.
 *
 * Used for cache keys: a single 32-bit hash collides at ~65k entries
 * (birthday bound), which makes an intentional cache-poisoning collision
 * feasible. Two independent 32-bit passes raise the bound to ~4 billion
 * entries — collision-safe for any realistic store, still dependency-free
 * and deterministic across platforms.
 */
export function fnv1a64(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x84222325;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code;
    b = Math.imul(b, 0x01000193);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * Generate a short, collision-resistant request trace id for log/error
 * correlation across the pipeline. Uses Web Crypto when available (all modern
 * browsers + Node >= 19); falls back to a time-random hybrid on runtimes without
 * `globalThis.crypto.randomUUID`, staying dependency-free.
 */
export function traceId(): string {
  const crypto = globalThis.crypto;
  if (crypto !== undefined && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${(Date.now() >>> 0).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
