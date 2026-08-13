/**
 * 03 — A real plugin: authentication & authorization
 *
 * Plugins are the "brains" of Orbit. This one hooks `onBeforeResolve` to
 * reject requests whose caller lacks the right role, and `onAfterParse` to
 * inject the caller's scope into the query filters — no adapter changes.
 *
 * Run:  node examples/node/03-auth-plugin.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit, ErrorCode, memoryAdapter, OrbitError } from '@orbit/core';
import type { OrbitPlugin } from '@orbit/core';

interface User {
  id: string;
  name: string;
  role: 'admin' | 'viewer';
}

const users: User[] = [
  { id: '1', name: 'Ana', role: 'admin' },
  { id: '2', name: 'Bruno', role: 'viewer' },
];

/** Require `x-api-key`; only the admin key may list private fields. */
function authPlugin(): OrbitPlugin {
  return {
    name: 'example-auth',
    hooks: {
      // Enrich the context before anything resolves.
      onBeforeParse({ query, ctx }) {
        const key = ctx.headers?.get('x-api-key');
        if (!key) {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Missing x-api-key header');
        }
        const state = (ctx.state ??= {});
        state.caller = { key, role: key === 'secret-admin' ? 'admin' : 'viewer' };
        return query;
      },
      // Reject the request before any adapter runs.
      onBeforeResolve({ parsed, ctx }) {
        const caller = ctx.state?.caller as { role: string } | undefined;
        if (parsed.entity === 'user' && caller?.role !== 'admin') {
          throw new OrbitError(
            ErrorCode.PERMISSION_DENIED,
            `Role '${caller?.role}' cannot query users`,
          );
        }
      },
      // Scope relation filters: viewers only ever see themselves.
      onBeforeExecute({ entity, filters, ctx }) {
        const caller = ctx.state?.caller as { key: string; role: string } | undefined;
        if (entity === 'user' && caller?.role === 'viewer') {
          return { filters: { ...filters, id: caller.key.slice(-1) } };
        }
      },
    },
  };
}

const orbit = createOrbit({
  adapters: memoryAdapter([
    { entity: 'user', resolve: ({ id }) => (id ? users.find((u) => u.id === id) : users) },
  ]),
  plugins: [authPlugin()],
});

export async function main(): Promise<void> {
  const headers = new Headers({ 'x-api-key': 'secret-admin' });
  const admin = await orbit.execute({ query: 'user { id, name }' }, { headers });
  console.log('admin sees:', JSON.stringify(admin.data));

  // A viewer key → the auth hook rejects the request.
  try {
    await orbit.execute(
      { query: 'user { id, name }' },
      { headers: new Headers({ 'x-api-key': 'viewer-key' }) },
    );
  } catch (error) {
    console.log('viewer blocked:', error instanceof OrbitError ? error.message : String(error));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
