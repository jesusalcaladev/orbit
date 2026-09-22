import { fnv1a64Bytes } from '../utils.js';

/**
 * A WEAK ETag for a response body.
 *
 * Weak (`W/`) because Orbit answers the same resource with several byte-level
 * representations — identity, gzip and Brotli — and the validator is computed
 * from the *uncompressed* bytes, before `content-encoding` is applied. A strong
 * validator would claim byte equality across those representations, which is
 * false. `Vary: accept-encoding` still lets caches key the encoded variants
 * apart, and `If-None-Match` is a weak comparison by definition (RFC 9110 §8.8.3).
 *
 * The digest is the byte-oriented double FNV-1a already used for cache keys, so
 * the engine stays zero-dependency and the validator is deterministic across
 * platforms and processes.
 */
export function etagFor(bytes: Uint8Array): string {
  return `W/"${fnv1a64Bytes(bytes)}"`;
}

/**
 * Weak comparison between an `if-none-match` header and an entity-tag.
 *
 * Handles the three shapes a client may send: a single tag, a comma-separated
 * list (the first match wins) and `*` (any current representation matches). The
 * `W/` prefix is stripped from both sides — weak comparison ignores it.
 */
export function etagMatches(header: string, etag: string): boolean {
  const target = stripWeak(etag);
  return header.split(',').some((part) => {
    const candidate = part.trim();
    if (candidate === '*') return true;
    return stripWeak(candidate) === target;
  });
}

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}
