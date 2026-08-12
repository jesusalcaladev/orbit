/**
 * 07 — A custom serializer (CSV)
 *
 * `onBeforeSerialize` is the last hook before the wire. Return a
 * `SerializedPayload` (`{ body, contentType }`) and the handler serves it
 * verbatim — this is how you'd add CSV, protobuf, XML, or any format without
 * touching the engine.
 *
 * Run:  node examples/07-serializer-custom.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit, memoryAdapter } from '@orbit/core';
import type { OrbitPlugin, SerializedPayload } from '@orbit/core';

const users = [
  { id: '1', name: 'Ana', email: 'ana@orbit.dev' },
  { id: '2', name: 'Bruno', email: 'bruno@orbit.dev' },
];

/** Render the projected result as CSV when the client asks for it. */
function csvPlugin(): OrbitPlugin {
  return {
    name: 'example-csv',
    hooks: {
      onBeforeSerialize({ data, node, ctx }) {
        if (ctx.headers?.get('accept') !== 'text/csv') return;
        const rows = Array.isArray(data) ? data : [data];
        const fields = node.fields;
        const lines = [
          fields.join(','),
          ...rows.map((row) =>
            fields.map((f) => String((row as Record<string, unknown>)[f] ?? '')).join(','),
          ),
        ];
        const payload: SerializedPayload = {
          body: lines.join('\n'),
          contentType: 'text/csv',
        };
        return payload;
      },
    },
  };
}

const orbit = createOrbit({
  adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
  plugins: [csvPlugin()],
});

export async function main(): Promise<void> {
  // Default Accept → JSON as usual.
  const json = await orbit.handler(
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user { id, name, email }' }),
    }),
  );
  console.log('json content-type:', json.headers.get('content-type'));
  console.log(await json.text());

  // Accept: text/csv → the plugin serializes the very same result as CSV.
  const csv = await orbit.handler(
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      body: JSON.stringify({ query: 'user { id, name, email }' }),
    }),
  );
  console.log('csv content-type:', csv.headers.get('content-type'));
  console.log(await csv.text());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
