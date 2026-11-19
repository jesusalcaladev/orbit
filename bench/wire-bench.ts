/**
 * B12 — round-trip wire bytes (request + response), with request compression.
 *
 * B4 measures a RESPONSE payload in isolation. Agents and mobile clients spend
 * bytes in both directions: they upload query text, filters and mutation
 * payloads, then download the graph. B12 sends two realistic envelopes through
 * the real `orbit.handler` — a bulk write (an agent importing content) and the
 * read that follows — and counts the bytes that actually leave and return:
 *
 *   - baseline:     JSON request, gzip JSON response (today's client default)
 *   - request gzip: gzip JSON request, gzip JSON response (`compressRequests`)
 *   - msgpack:      gzip MessagePack request, gzip MessagePack response
 *
 * The numbers are deterministic (fixed fixtures, no sampling): this measures
 * bytes, not time. B3/B8 measure the cost of the same paths in RPS.
 */
import { MSGPACK_CONTENT_TYPE, createOrbit, encodeMsgpack } from '@orbit/core';
import type { OrbitEnvelope } from '@orbit/core';
import { buildFeed } from './fixtures.ts';
import { gzip } from './measure.ts';

const encoder = new TextEncoder();

export interface WireConfig {
  format: 'json' | 'msgpack';
  /** Send the request body gzip-compressed. */
  compressRequest: boolean;
}

export interface WireBytes {
  inBytes: number;
  outBytes: number;
}

/**
 * POST one envelope through the REAL handler and count both directions.
 * `content-encoding` and `accept-encoding` are set exactly as the client sets
 * them, so the counts are the bytes the network would carry.
 */
export async function wireRoundTrip(
  orbit: ReturnType<typeof createOrbit>,
  envelope: OrbitEnvelope,
  config: WireConfig,
): Promise<WireBytes> {
  const contentType = config.format === 'msgpack' ? MSGPACK_CONTENT_TYPE : 'application/json';
  const raw =
    config.format === 'msgpack'
      ? encodeMsgpack(envelope)
      : encoder.encode(JSON.stringify(envelope));
  const body = config.compressRequest ? await gzip(raw) : raw;

  const response = await orbit.handler(
    new Request('https://bench.test/orbit', {
      method: 'POST',
      headers: {
        'content-type': contentType,
        accept: contentType,
        'accept-encoding': 'gzip',
        ...(config.compressRequest ? { 'content-encoding': 'gzip' } : {}),
      },
      body,
    }),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 200) {
    throw new Error(`B12 expected 200, got ${response.status}: ${new TextDecoder().decode(bytes)}`);
  }
  return { inBytes: body.byteLength, outBytes: bytes.byteLength };
}

export interface WireB12Result {
  /** Today's default round-trip: raw JSON request + gzip JSON response. */
  baselineKb: number;
  /** `compressRequests: true`: gzip JSON request + gzip JSON response. */
  compressedKb: number;
  /** Same, with MessagePack on both sides. */
  msgpackKb: number;
  /** The write request alone, raw vs gzipped, in KB. */
  writeRawKb: number;
  writeGzipKb: number;
  savedPct: number;
  competitionKb: number;
}

export async function wireB12(): Promise<WireB12Result> {
  const feed = buildFeed();
  const orbit = createOrbit({
    adapters: [
      {
        entity: 'feed',
        resolve: () => feed,
        mutate: () => ({ success: true }),
        // The bulk write re-queries nothing; keep the mutation a plain success.
      },
    ],
  });

  // An agent importing content: real prose, so gzip numbers are honest.
  const write: OrbitEnvelope = {
    do: 'feed.import',
    args: {
      payload: {
        posts: feed.slice(0, 8).map(({ id, title, body, tags }) => ({ id, title, body, tags })),
      },
    },
  };
  // The read that follows the write: the same feed, projected.
  const read: OrbitEnvelope = {
    query: 'feed(id="all") { id, title, body, tags, views, likes, createdAt }',
  };

  const total = async (config: WireConfig): Promise<WireBytes> => {
    const w = await wireRoundTrip(orbit, write, config);
    const r = await wireRoundTrip(orbit, read, config);
    return { inBytes: w.inBytes + r.inBytes, outBytes: w.outBytes + r.outBytes };
  };

  const baseline = await total({ format: 'json', compressRequest: false });
  const compressed = await total({ format: 'json', compressRequest: true });
  const msgpack = await total({ format: 'msgpack', compressRequest: true });
  const writeRaw = await wireRoundTrip(orbit, write, { format: 'json', compressRequest: false });
  const writeGzip = await wireRoundTrip(orbit, write, { format: 'json', compressRequest: true });

  const kb = (bytes: number) => bytes / 1024;
  const sum = (b: WireBytes) => b.inBytes + b.outBytes;
  const baselineKb = kb(sum(baseline));
  const compressedKb = kb(sum(compressed));

  console.log(
    `    baseline in/out: ${kb(baseline.inBytes).toFixed(1)}/${kb(baseline.outBytes).toFixed(1)} KB · request gzip in/out: ${kb(compressed.inBytes).toFixed(1)}/${kb(compressed.outBytes).toFixed(1)} KB · msgpack both ways: ${kb(sum(msgpack)).toFixed(1)} KB`,
  );

  return {
    baselineKb,
    compressedKb,
    msgpackKb: kb(sum(msgpack)),
    writeRawKb: kb(writeRaw.inBytes),
    writeGzipKb: kb(writeGzip.inBytes),
    savedPct: (1 - compressedKb / baselineKb) * 100,
    competitionKb: baselineKb,
  };
}
