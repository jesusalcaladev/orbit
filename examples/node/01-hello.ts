/**
 * 01 — Hello, Orbit
 *
 * The smallest possible Orbit setup: one in-memory adapter, one query.
 * `execute()` returns the projected graph, exactly what the HTTP handler
 * would have serialized.
 *
 * Run:  node examples/node/01-hello.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit, memoryAdapter } from '@orbit/core';

interface User {
  id: string;
  name: string;
  email: string;
}

const users: User[] = [
  { id: '1', name: 'Ana', email: 'ana@orbit.dev' },
  { id: '2', name: 'Bruno', email: 'bruno@orbit.dev' },
];

const orbit = createOrbit({
  adapters: memoryAdapter([
    {
      entity: 'user',
      resolve: ({ id }) => {
        if (id) return users.find((u) => u.id === id);
        return users;
      },
    },
  ]),
});

export async function main(): Promise<void> {
  // One record, projected down to the requested fields.
  const one = await orbit.execute({ query: 'user(id="1") { name, email }' });
  console.log('single user:', JSON.stringify(one.data));

  // No filter → the adapter decides (here: everything).
  const all = await orbit.execute({ query: 'user { id, name }' });
  console.log('all users:  ', JSON.stringify(all.data));

  // Unknown entities fail with the standard error contract.
  try {
    await orbit.execute({ query: 'ghost(id="1") { id }' });
  } catch (error) {
    console.log('error:      ', error instanceof Error ? error.message : String(error));
  }
}

// Run directly when this file is the entry point (so `run-all.ts` can import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
