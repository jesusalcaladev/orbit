export interface Capture {
  url: string;
  init: RequestInit;
}

/** A fetch impl that records every call and delegates to `respond`. */
export function mockFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; capture: Capture[] } {
  const capture: Capture[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    capture.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  };
  return { fetchImpl, capture };
}

/** A JSON response with the right content-type. */
export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch that never resolves until its signal aborts — mimics undici, which
 * rejects with an `AbortError` DOMException the moment the signal fires.
 */
export function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException('Aborted', 'AbortError'));
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener('abort', fail, { once: true });
  });
}

/** gzip bytes via the web-standard CompressionStream. */
export async function gzipBytes(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
