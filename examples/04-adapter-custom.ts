/**
 * 04 — Adapters: the full DataAdapter contract, written by hand
 *
 * An adapter is just an object with `resolve()`. Here we write one from
 * scratch against a Map — no `memoryAdapter` helper — and exercise the
 * complete frozen contract: `resolve`, `batch`, `mutate` and the realtime
 * `subscribe` hook. Everything you see is the whole contract; nothing is
 * hidden behind a framework.
 *
 * Run:  node examples/04-adapter-custom.ts   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url';
import { createOrbit } from '@orbit/core';
import type { DataAdapter, OrbitContext, SubscriptionEvent } from '@orbit/core';

interface Country {
  code: string;
  name: string;
  population: number;
}

const countries = new Map<string, Country>([
  ['mx', { code: 'mx', name: 'Mexico', population: 128_455_567 }],
  ['ar', { code: 'ar', name: 'Argentina', population: 45_376_763 }],
]);

/** A tiny zero-dependency event emitter — just a Set of handlers. */
function makeEmitter() {
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  return {
    emit(event: SubscriptionEvent) {
      for (const handler of handlers) handler(event);
    },
    on(handler: (event: SubscriptionEvent) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

const changes = makeEmitter();

// The whole contract, hand-written:
//   resolve   — answer a filter set
//   batch     — the N+1 fix: siblings collapse into one pass
//   mutate    — writes via the `do` envelope
//   subscribe — realtime: relay record changes to subscribers
const countryAdapter: DataAdapter = {
  entity: 'country',

  async resolve(filters, _ctx: OrbitContext) {
    if (filters.code) return countries.get(filters.code);
    return [...countries.values()];
  },

  // Every sibling request of this entity at one level becomes ONE call.
  async batch(requests) {
    return requests.map((r) => {
      const parent = r.parent?.data as { code: string } | undefined;
      if (parent) return countries.get(parent.code);
      return [...countries.values()];
    });
  },

  async mutate(action, args) {
    const { filter, payload } = args;
    const code = filter?.code;
    if (action === 'create' && code) {
      const country = payload as unknown as Country;
      countries.set(code, country);
      changes.emit({ type: 'created', id: code, data: country });
      return { id: code };
    }
    if (action === 'update' && code) {
      const country = countries.get(code);
      if (!country) throw new Error(`country '${code}' not found`);
      Object.assign(country, payload);
      changes.emit({
        type: 'updated',
        id: code,
        data: country,
        patch: payload as Record<string, unknown>,
      });
      return { id: code };
    }
    if (action === 'delete' && code) {
      countries.delete(code);
      changes.emit({ type: 'deleted', id: code });
      return { id: code };
    }
    throw new Error(`unknown action '${action}'`);
  },

  // Realtime. Entity-scoped by construction; an empty filter set means
  // "every record of this entity" — so there is no subscribeToEntity.
  subscribe(_filters, handler) {
    return changes.on(handler);
  },
};

export async function main(): Promise<void> {
  const orbit = createOrbit({ adapters: [countryAdapter] });

  const mexico = await orbit.execute({ query: 'country(code="mx") { name, population }' });
  console.log('resolve:      ', JSON.stringify(mexico.data));

  await orbit.execute({
    do: 'country.create',
    args: {
      filter: { code: 'br' },
      payload: { code: 'br', name: 'Brazil', population: 214_000_000 },
    },
  });
  const all = await orbit.execute({ query: 'country { code, name }' });
  console.log('after mutate: ', JSON.stringify(all.data));

  // Subscribe, then make a change and watch the event flow out.
  let seen = 0;
  const unsubscribe = countryAdapter.subscribe!({}, (event) => {
    seen += 1;
    console.log(`subscribe:    ${event.type} ${String(event.id)}`);
  });
  await orbit.execute({ do: 'country.delete', args: { filter: { code: 'ar' } } });
  unsubscribe();
  console.log(`events seen:  ${seen}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
