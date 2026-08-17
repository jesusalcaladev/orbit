/**
 * Optional cache persistence.
 *
 * The storage contract is exactly the `AsyncStorage` interface, so the
 * `@react-native-async-storage/async-storage` module works as-is on React
 * Native, and `localStorage`/`sessionStorage` on the web. Injection keeps
 * this package dependency-free: nothing is imported at runtime.
 *
 * The only `JSON.stringify`/`JSON.parse` in this package happens here — the
 * persisted cache snapshot. Server responses are never touched (transport
 * lives in `@orbit/client`).
 */
import type { OrbitReactClient } from './client.js';
import type { DehydratedCache } from './types.js';

/** The AsyncStorage-compatible surface this package can persist through. */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

const DEFAULT_STORAGE_KEY = 'orbit-cache';

function defaultStorage(): Storage | null {
  /* v8 ignore next 3 — browser-only global; SSR environments may lack it. */
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/** A StorageAdapter over the web `Storage` interface (localStorage default). */
export function createLocalStorageAdapter(storage?: Storage): StorageAdapter {
  const store = storage ?? defaultStorage();
  if (store === null) {
    throw new Error(
      'localStorage is unavailable in this environment — pass a storage object explicitly',
    );
  }
  return {
    getItem: (key) => store.getItem(key),
    setItem: (key, value) => {
      store.setItem(key, value);
    },
    removeItem: (key) => {
      store.removeItem(key);
    },
  };
}

export interface PersistOptions {
  /** Storage key; default `orbit-cache`. */
  key?: string;
}

/** Serialize the cache and write it through the adapter. */
export async function persistClient(
  client: OrbitReactClient,
  adapter: StorageAdapter,
  options: PersistOptions = {},
): Promise<void> {
  const snapshot = client.dehydrate();
  await adapter.setItem(options.key ?? DEFAULT_STORAGE_KEY, JSON.stringify(snapshot));
}

/**
 * Read a persisted snapshot back into the cache. Returns `false` when nothing
 * is stored or the payload is corrupt — callers fall back to a cold start.
 */
export async function hydrateClient(
  client: OrbitReactClient,
  adapter: StorageAdapter,
  options: PersistOptions = {},
): Promise<boolean> {
  const raw = await adapter.getItem(options.key ?? DEFAULT_STORAGE_KEY);
  if (raw === null) return false;
  try {
    const snapshot = JSON.parse(raw) as DehydratedCache;
    client.hydrate(snapshot);
    return true;
  } catch {
    return false;
  }
}
