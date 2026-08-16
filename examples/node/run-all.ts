/**
 * Run every example back-to-back. Each example is self-contained and also
 * works standalone.
 *
 * Run:  node examples/node/run-all.ts   (after `npm run build`)
 */
import { main as hello } from './fundamentals/01-hello.ts';
import { main as blog } from './relations/02-blog-relations.ts';
import { main as auth } from './authentication/03-auth-plugin.ts';
import { main as adapters } from './adapters/04-adapter-custom.ts';
import { main as msgpack } from './serialization/05-msgpack.ts';
import { main as streaming } from './streaming/06-streaming-sse.ts';
import { main as serializer } from './serialization/07-serializer-custom.ts';
import { main as realtime } from './streaming/08-realtime.ts';
import { main as speed } from './performance/09-speed.ts';
import { main as expressDemo } from './frameworks/10-express.ts';
import { main as honoDemo } from './frameworks/11-hono.ts';
import { main as workersDemo } from './frameworks/12-cloudflare-workers.ts';
import { main as stackMongo } from './stack/13-fullstack-mongo.ts';

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
  { name: '10 · book API on express', run: expressDemo },
  { name: '11 · book API on hono', run: honoDemo },
  { name: '12 · book API on workers', run: workersDemo },
  { name: '13 · full-stack: mongo + redis + auth + rate-limit', run: stackMongo },
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

// The imported realtime examples run undici's WebSocket client in-process;
// its socket handles stay alive after a clean close (a Node platform
// behavior, not an Orbit leak). Flush the summary and exit explicitly so the
// harness always completes — preserving the exit code set by a failing
// example (process.exitCode is 1 on failure).
process.stdout.write('\nAll examples done.\n', () => process.exit(process.exitCode));
