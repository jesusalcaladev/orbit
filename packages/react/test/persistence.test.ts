import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalStorageAdapter, hydrateClient, persistClient } from '../src/persistence.js';
import type { StorageAdapter } from '../src/persistence.js';
import { fakeTransport, okResponse, reactClientOf } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal Storage-shaped object for stubbing the browser global. */
function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

function memoryAdapter(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('persistence', () => {
  it('persistClient writes a snapshot and hydrateClient restores it', async () => {
    const { transport } = fakeTransport();
    transport.query.mockResolvedValue(okResponse({ name: 'Ana' }));
    const client = reactClientOf(transport);
    await client.ensureQuery(['u'], 'user { name }');

    const adapter = memoryAdapter();
    await persistClient(client, adapter);
    const raw = await adapter.getItem('orbit-cache');
    expect(raw).toContain('"v":1');

    const restored = reactClientOf(fakeTransport().transport);
    expect(await hydrateClient(restored, adapter)).toBe(true);
    expect(restored.getQueryData(['u'])).toEqual({ name: 'Ana' });
  });

  it('hydrateClient returns false when nothing is stored or the payload is corrupt', async () => {
    const client = reactClientOf(fakeTransport().transport);
    const empty = memoryAdapter();
    expect(await hydrateClient(client, empty)).toBe(false);

    const corrupt = memoryAdapter();
    await corrupt.setItem('orbit-cache', '{not json');
    expect(await hydrateClient(client, corrupt)).toBe(false);
  });

  it('honours a custom storage key', async () => {
    const client = reactClientOf(fakeTransport().transport);
    const adapter = memoryAdapter();
    await persistClient(client, adapter, { key: 'my-app/orbit' });
    expect(await adapter.getItem('my-app/orbit')).toContain('"v":1');
    expect(await adapter.getItem('orbit-cache')).toBeNull();
    expect(await hydrateClient(client, adapter, { key: 'my-app/orbit' })).toBe(true);
  });

  describe('createLocalStorageAdapter', () => {
    it('defaults to the browser localStorage', async () => {
      vi.stubGlobal('localStorage', makeStorage());
      const adapter = createLocalStorageAdapter();
      await adapter.setItem('k', 'v');
      expect((globalThis.localStorage as Storage).getItem('k')).toBe('v');
      expect(adapter.getItem('k')).toBe('v');
      await adapter.removeItem('k');
      expect(adapter.getItem('k')).toBeNull();
    });

    it('uses an explicitly passed storage', async () => {
      const fake = makeStorage();
      const adapter = createLocalStorageAdapter(fake);
      await adapter.setItem('a', '1');
      expect(fake.getItem('a')).toBe('1');
    });

    it('throws a clear error when localStorage is unavailable', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(() => createLocalStorageAdapter()).toThrow(/localStorage/);
    });
  });
});
