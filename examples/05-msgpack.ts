/**
 * 05 — MessagePack over the wire
 *
 * Orbit speaks three formats, negotiated from the `Accept` header. Send the
 * envelope as MessagePack (`content-type: application/x-msgpack`), ask for
 * a MessagePack response (`accept: application/x-msgpack`), and decode it
 * with the built-in zero-dependency codec.
 *
 * Run:  node examples/05-msgpack.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import {
  createOrbit,
  decodeMsgpack,
  encodeMsgpack,
  memoryAdapter,
  MSGPACK_CONTENT_TYPE,
} from '@orbit/core';

const users = [{ id: '1', name: 'Ana', email: 'ana@orbit.dev' }];

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => (id ? users.find((u) => u.id === id) : users) },
  ]),
});

export async function main(): Promise<void> {
  // Envelope as MessagePack bytes (compare sizes against the JSON below).
  const envelopeBytes = encodeMsgpack({ query: 'user(id="1") { name, email }' });
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify({ query: 'user(id="1") { name, email }' }),
  );
  console.log(
    `envelope size — msgpack: ${envelopeBytes.byteLength}B, json: ${jsonBytes.byteLength}B`,
  );

  const response = await orbit.handler(
    new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': MSGPACK_CONTENT_TYPE, accept: MSGPACK_CONTENT_TYPE },
      body: envelopeBytes,
    }),
  );

  console.log('response content-type:', response.headers.get('content-type'));
  const payload = decodeMsgpack(new Uint8Array(await response.arrayBuffer()));
  console.log('decoded payload:', JSON.stringify(payload));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
