/**
 * Core package weight — the honest bundle-size story.
 *
 * Measures what a client/server actually downloads for the protocol core:
 *   - total JS bytes across packages/core/dist (all modules),
 *   - the same bytes gzipped (the wire cost of a CDN/npm tarball),
 *   - source lines, for the "zero-dependency" claim.
 * And the same two byte numbers for graphql-js (the dependency GraphQL
 * servers must ship), so "zero-dependency and ~5% of the size" is measured,
 * not assumed.
 *
 * Run: npm run size   (builds the core first)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from './measure.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js') || full.endsWith('.mjs')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function measure(dir: string): { bytes: number; gzipBytes: number; files: number } {
  const files = jsFiles(dir);
  const buffers = files.map((f) => readFileSync(f));
  const bytes = buffers.reduce((sum, b) => sum + b.length, 0);
  const combined = Buffer.concat(buffers);
  return { bytes, gzipBytes: combined.length, files: files.length };
}

const coreDist = join(root, 'packages/core/dist');
const graphqlDir = join(root, 'node_modules/graphql');
const core = measure(coreDist);
const graphql = measure(graphqlDir);

// gzip the combined JS bytes (the tarball/CDN transfer cost).
const gz = (input: Buffer): Promise<number> =>
  gzip(new Uint8Array(input)).then((b) => b.byteLength);

const coreGzip = await gz(Buffer.concat(jsFiles(coreDist).map((f) => readFileSync(f))));
const gqlGzip = await gz(Buffer.concat(jsFiles(graphqlDir).map((f) => readFileSync(f))));

const fmt = (n: number) => (n / 1024).toFixed(1);
const ratio = (a: number, b: number) => (b / a).toFixed(1);

console.log('Core package weight (built dist)');
console.log('--------------------------------');
console.log(
  `@orbit/core  ${fmt(core.bytes).padStart(8)} KB raw · ${fmt(coreGzip).padStart(6)} KB gzip · ${core.files} files`,
);
console.log(
  `graphql-js   ${fmt(graphql.bytes).padStart(8)} KB raw · ${fmt(gqlGzip).padStart(6)} KB gzip · ${graphql.files} files`,
);
console.log(
  `ratio        ${ratio(core.bytes, graphql.bytes).padStart(7)}× raw   · ${ratio(coreGzip, gqlGzip).padStart(5)}× gzip`,
);
console.log(
  `source       ${countLines(join(root, 'packages/core/src')).toLocaleString('en-US')} lines of TS (zero runtime deps)`,
);

function countLines(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      total += countLines(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      total += readFileSync(full, 'utf8').split('\n').length;
    }
  }
  return total;
}
