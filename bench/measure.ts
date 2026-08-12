/**
 * Shared timing helpers for the benchmark suite.
 *
 * Both the Orbit scenarios (run.ts) and the real-GraphQL head-to-head
 * (graphql.ts) use the same clock, the same percentile math and the same
 * throughput discipline — every op is awaited before the next starts, so the
 * numbers measure completed work, not pipelined microtasks.
 */

export function now(): number {
  return performance.now();
}

export function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

export async function measure(
  fn: () => Promise<unknown> | unknown,
  samples: number,
): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = now();
    await fn();
    times.push(now() - start);
  }
  return times.sort((a, b) => a - b);
}

/**
 * Honest throughput: every op is awaited before the next starts, so the
 * measurement reflects completed work (unawaited loops pipeline microtasks
 * and inflate the number). Warm-up first, then measure `samples` ops.
 */
export async function measureThroughput(
  fn: () => unknown,
  samples: number,
  warmup = 300,
): Promise<number> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const start = now();
  for (let i = 0; i < samples; i += 1) await fn();
  return samples / ((now() - start) / 1000);
}

/** gzip a byte payload via the web-standard CompressionStream. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
