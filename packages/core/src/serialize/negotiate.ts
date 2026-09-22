/** The wire formats Orbit can speak, negotiated from the `Accept` header. */
export type OrbitFormat = 'json' | 'msgpack' | 'sse';

export const MSGPACK_CONTENT_TYPE = 'application/x-msgpack';
export const SSE_CONTENT_TYPE = 'text/event-stream';

interface AcceptEntry {
  type: string;
  q: number;
}

/** One `accept-encoding` entry: a codec name and its q-value. */
interface EncodingEntry {
  name: string;
  q: number;
}

function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header) return [];
  return header.split(',').map((part) => {
    const [rawType, ...params] = part.trim().split(';');
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    // `split()` always yields at least one element, so `rawType` is defined.
    return { type: rawType!.trim().toLowerCase(), q };
  });
}

/**
 * Negotiate the response format from an `Accept` header (q-values supported).
 *
 * - `application/x-msgpack` → `'msgpack'`
 * - `text/event-stream` → `'sse'` (progressive streaming of the graph)
 * - `application/json` (or no `Accept` header at all) → `'json'`
 *
 * Explicit types win over the wildcard; among ties the most specific format wins.
 */
export function negotiateFormat(header: string | null | undefined): OrbitFormat {
  // Fast path: the overwhelming majority of requests accept plain JSON. Only
  // headers mentioning a binary/streaming format or a wildcard need the full
  // q-value machinery — anything else resolves to JSON either way.
  const lower = header?.toLowerCase() ?? '';
  if (
    lower.length > 0 &&
    !lower.includes('msgpack') &&
    !lower.includes('event-stream') &&
    !lower.includes('*')
  ) {
    return 'json';
  }

  const entries = parseAccept(header).filter((entry) => entry.q > 0);

  // Explicit types win. Wildcards are conservative:
  // - `text/*` → SSE (a client narrowing to text formats wants them)
  // - `application/*`, `*/*` → JSON (the default wire format — never serve an
  //   exotic binary format to a client that merely said "everything")
  const pick = (type: string) => entries.find((entry) => entry.type === type);
  const textWildcard = entries.find((entry) => entry.type === 'text/*');
  const jsonWildcard = entries.find(
    (entry) => entry.type === '*/*' || entry.type === 'application/*',
  );
  const candidates = [
    { format: 'msgpack' as const, entry: pick('application/x-msgpack'), rank: 3 },
    { format: 'sse' as const, entry: pick('text/event-stream') ?? textWildcard, rank: 2 },
    { format: 'json' as const, entry: pick('application/json') ?? jsonWildcard, rank: 1 },
  ].filter(
    (c): c is { format: OrbitFormat; entry: AcceptEntry; rank: number } => c.entry !== undefined,
  );

  if (candidates.length === 0) return 'json';

  candidates.sort((a, b) => {
    if (a.entry.q !== b.entry.q) return b.entry.q - a.entry.q;
    return b.rank - a.rank;
  });

  return candidates[0]!.format;
}

/** True when the client accepts `gzip` (and not with `q=0`). */
export function wantsGzip(header: string | null | undefined): boolean {
  return parseEncodingEntries(header).some(
    (entry) => (entry.name === 'gzip' || entry.name === '*') && entry.q > 0,
  );
}

/** Response compression codecs Orbit can apply (`content-encoding` values). */
export type OrbitEncoding = 'br' | 'gzip';

/** Which codecs the runtime can actually produce (see `handler`). */
export interface EncodingSupport {
  /** `CompressionStream('br')` is available on this runtime. */
  brotli: boolean;
}

/**
 * Preference order when the client's q-values tie: smaller output wins, so
 * Brotli (typically 15-20 % smaller than gzip on JSON) is tried first.
 */
const ENCODING_PREFERENCE: OrbitEncoding[] = ['br', 'gzip'];

function parseEncodingEntries(header: string | null | undefined): EncodingEntry[] {
  if (!header) return [];
  return header.split(',').map((part) => {
    const [rawName, ...params] = part.trim().split(';');
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q' && value !== undefined) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    // `split()` always yields at least one element, so `rawName` is defined.
    return { name: rawName!.trim().toLowerCase(), q };
  });
}

/**
 * Negotiate the response `content-encoding` from an `accept-encoding` header.
 *
 * - The client's q-values decide first (`gzip;q=1, br;q=0.5` → gzip);
 *   ties break toward the smaller codec (`br` before `gzip`).
 * - `*` expands to every codec the `supported` argument reports — so a
 *   `*`-only header gets gzip on a runtime without Brotli.
 * - A codec the runtime cannot produce (`supported.brotli === false`) and one
 *   the client disabled with `q=0` are both skipped.
 *
 * Returns `null` when no codec is acceptable AND supported — the caller then
 * serves the body uncompressed rather than lying with a `content-encoding`.
 */
export function negotiateEncoding(
  header: string | null | undefined,
  supported: EncodingSupport = { brotli: false },
): OrbitEncoding | null {
  const allowed = ENCODING_PREFERENCE.filter((codec) => codec !== 'br' || supported.brotli);
  let best: OrbitEncoding | null = null;
  let bestQ = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const entry of parseEncodingEntries(header)) {
    if (entry.q <= 0) continue;
    // `*` means "any of the remaining codecs" — expand it to the supported set.
    const names = entry.name === '*' ? allowed : [entry.name as OrbitEncoding];
    for (const name of names) {
      const rank = allowed.indexOf(name);
      if (rank === -1) continue; // unknown codec, or Brotli on a runtime without it
      if (entry.q > bestQ || (entry.q === bestQ && rank < bestRank)) {
        best = name;
        bestQ = entry.q;
        bestRank = rank;
      }
    }
  }
  return best;
}
