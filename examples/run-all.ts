/**
 * Run every example back-to-back. Each example is self-contained and also
 * works standalone.
 *
 * Run:  node examples/run-all.ts   (after `npm run build`)
 */
import { main as hello } from './01-hello.ts';
import { main as blog } from './02-blog-relations.ts';
import { main as auth } from './03-auth-plugin.ts';
import { main as adapters } from './04-adapter-custom.ts';
import { main as msgpack } from './05-msgpack.ts';
import { main as streaming } from './06-streaming-sse.ts';
import { main as serializer } from './07-serializer-custom.ts';
import { main as realtime } from './08-realtime.ts';
import { main as speed } from './09-speed.ts';

const runs: Array<{ name: string; run: () => Promise<void> }> = [
  { name: '01 · hello', run: hello },
  { name: '02 · relations & batching', run: blog },
  { name: '03 · auth plugin', run: auth },
  { name: '04 · adapter by hand', run: adapters },
  { name: '05 · msgpack', run: msgpack },
  { name: '06 · SSE streaming', run: streaming },
  { name: '07 · custom serializer', run: serializer },
  { name: '08 · realtime (ws)', run: realtime },
  { name: '09 · speed showcase', run: speed },
];

for (const { name, run } of runs) {
  const started = Date.now();
  console.log(`\n── ${name} ─${'─'.repeat(Math.max(0, 34 - name.length))}`);
  try {
    await run();
    console.log(`✔ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`✘ ${name} failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
    break;
  }
}

console.log('\nAll examples done.');
