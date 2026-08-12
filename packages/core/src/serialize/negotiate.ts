/** The wire formats Orbit can speak, negotiated from the `Accept` header. */
export type OrbitFormat = 'json' | 'msgpack' | 'sse';

export const MSGPACK_CONTENT_TYPE = 'application/x-msgpack';
export const SSE_CONTENT_TYPE = 'text/event-stream';

interface AcceptEntry {
  type: string;
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
    return { type: (rawType ?? '').trim().toLowerCase(), q };
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
  if (lower.length > 0 && !lower.includes('msgpack') && !lower.includes('event-stream') && !lower.includes('*')) {
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
  ].filter((c): c is { format: OrbitFormat; entry: AcceptEntry; rank: number } => c.entry !== undefined);

  if (candidates.length === 0) return 'json';

  candidates.sort((a, b) => {
    if (a.entry.q !== b.entry.q) return b.entry.q - a.entry.q;
    return b.rank - a.rank;
  });

  return candidates[0]!.format;
}

/** True when the client accepts `gzip` (and not with `q=0`). */
export function wantsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if ((name ?? '').trim().toLowerCase() !== 'gzip') return false;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q' && Number(value) === 0) return false;
    }
    return true;
  });
}
