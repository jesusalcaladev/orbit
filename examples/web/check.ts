/**
 * Scripted smoke check for the web demos server (examples/web/server.ts).
 *
 * Verifies what the browser demos depend on after the @orbit/client
 * migration: the /vendor import-map files resolve, every demo page serves,
 * and a client round-trip works over HTTP and the realtime socket.
 *
 * Run:  node examples/web/server.ts &   (after `npm run build`)
 *       node examples/web/check.ts
 */
import { createClient } from '@orbit/client';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
const BASE = `http://127.0.0.1:${PORT}`;

const pages = [
  '/',
  '/chat-realtime/',
  '/twitter-post/',
  '/03-mini-post/',
  '/04-mini-auth/',
  '/05-orbit-vs-graphql/',
];

const vendorFiles = [
  '/vendor/@orbit/client/index.js',
  '/vendor/@orbit/client/client.js',
  '/vendor/@orbit/client/stream.js',
  '/vendor/@orbit/client/realtime.js',
  '/vendor/@orbit/core/index.js',
];

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { redirect: 'manual' });
}

console.log(`\n@orbit/client migration check — ${BASE}\n`);

for (const path of pages) {
  const res = await get(path);
  const body = await res.text();
  check(`page ${path}`, res.status === 200 && body.includes('<!doctype html>'), String(res.status));
}

for (const file of vendorFiles) {
  const res = await get(file);
  const body = await res.text();
  check(`vendor ${file}`, res.status === 200 && body.trim().length > 0, String(res.status));
}

// Import-map wiring: the served HTML must map @orbit/client to /vendor.
const chatHtml = await (await get('/chat-realtime/')).text();
check(
  'import map in HTML',
  chatHtml.includes('"@orbit/client"') && chatHtml.includes('/vendor/@orbit/client/index.js'),
);

// A real client round-trip against the demo server.
const client = createClient({ baseUrl: `${BASE}/orbit` });
const { data } = await client.query('chat { id, author, text, ts }');
check('client.query over HTTP', Array.isArray(data), JSON.stringify(data).slice(0, 60));

// Realtime: subscribe, then mutate through the socket and receive the event.
// The mutation only fires after the server acked the subscription — an emit
// before the adapter hook attaches would be lost.
const event = await new Promise<unknown>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('realtime event timeout')), 5000);
  client.subscribe(
    'chat { id, author, text, ts }',
    (e) => {
      clearTimeout(timer);
      resolve(e);
    },
    {
      onAck: () => {
        client
          .socket()
          .request({
            do: 'chat.send',
            args: { payload: { author: 'check', text: 'smoke', clientId: 'check-1' } },
          })
          .catch(reject);
      },
    },
  );
});
check(
  'client realtime round-trip',
  (event as { data?: unknown }).data !== undefined,
  JSON.stringify(event).slice(0, 80),
);
client.close();

console.log(failures === 0 ? '\n✔ web demos check passed\n' : `\n✘ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
