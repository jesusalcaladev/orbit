import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, createOrbit, decodeMsgpack, encodeMsgpack, memoryAdapter, validateEnvelope } from '../src/index.js';
import { ErrorCode } from '../src/errors.js';

// ---------------------------------------------------------------------------
// MessagePack: every encoding family, encode + decode
// ---------------------------------------------------------------------------

describe('msgpack coverage — encode families', () => {
  it('encodes bigint as uint64/int64', () => {
    expect(encodeMsgpack(5n)).toEqual(new Uint8Array([0xcf, 0, 0, 0, 0, 0, 0, 0, 5]));
    expect(encodeMsgpack(-5n)).toEqual(new Uint8Array([0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfb]));
    // round-trips
    expect(decodeMsgpack(encodeMsgpack(2n ** 63n - 1n))).toBe(Number(2n ** 63n - 1n));
  });

  it('encodes negative int16 and int64 ranges', () => {
    expect([...encodeMsgpack(-1000)]).toEqual([0xd1, ...[-1000 >> 8 & 0xff, -1000 & 0xff]]);
    expect(encodeMsgpack(-1000).byteLength).toBe(3);
    expect(decodeMsgpack(encodeMsgpack(-1000))).toBe(-1000);
    const bigNeg = -(2 ** 40);
    expect(encodeMsgpack(bigNeg)[0]).toBe(0xd3); // int64
    expect(decodeMsgpack(encodeMsgpack(bigNeg))).toBe(bigNeg);
  });

  it('encodes uint32 (0xce) and decodes it', () => {
    const value = 4_000_000_000;
    const bytes = encodeMsgpack(value);
    expect(bytes[0]).toBe(0xce);
    expect(decodeMsgpack(bytes)).toBe(value);
  });

  it('encodes str16 and str32', () => {
    const s16 = 'x'.repeat(300);
    const b16 = encodeMsgpack(s16);
    expect(b16[0]).toBe(0xda);
    expect(decodeMsgpack(b16)).toBe(s16);

    const s32 = 'y'.repeat(70_000);
    const b32 = encodeMsgpack(s32);
    expect(b32[0]).toBe(0xdb);
    expect(decodeMsgpack(b32)).toBe(s32);
  });

  it('encodes bin16 and bin32', () => {
    const bin16 = new Uint8Array(300).fill(7);
    const b16 = encodeMsgpack(bin16);
    expect(b16[0]).toBe(0xc5);
    const d16 = decodeMsgpack(b16) as Uint8Array;
    expect([...d16].every((x) => x === 7)).toBe(true);

    const bin32 = new Uint8Array(70_000).fill(9);
    const b32 = encodeMsgpack(bin32);
    expect(b32[0]).toBe(0xc6);
    expect((decodeMsgpack(b32) as Uint8Array).byteLength).toBe(70_000);
  });

  it('encodes array32 and map32', () => {
    const arr = Array.from({ length: 70_000 }, (_, i) => i % 256);
    const bArr = encodeMsgpack(arr);
    expect(bArr[0]).toBe(0xdd);
    expect(decodeMsgpack(bArr)).toEqual(arr);

    const map: Record<string, number> = {};
    for (let i = 0; i < 70_000; i += 1) map[`k${i}`] = i;
    const bMap = encodeMsgpack(map);
    expect(bMap[0]).toBe(0xdf);
    const decoded = decodeMsgpack(bMap) as Record<string, number>;
    expect(Object.keys(decoded)).toHaveLength(70_000);
  });
});

describe('msgpack coverage — decode families', () => {
  it('decodes float32 and false', () => {
    expect(decodeMsgpack(new Uint8Array([0xca, 0x3f, 0x80, 0x00, 0x00]))).toBeCloseTo(1, 5);
    expect(decodeMsgpack(new Uint8Array([0xc2]))).toBe(false);
  });

  it('decodes int16 and uint32', () => {
    expect(decodeMsgpack(new Uint8Array([0xd1, 0xfc, 0x18]))).toBe(-1000);
    expect(decodeMsgpack(encodeMsgpack(4_000_000_000))).toBe(4_000_000_000);
  });

  it('decodes str16, str32, bin16, bin32, array32, map32', () => {
    const s16 = encodeMsgpack('z'.repeat(300));
    expect(s16[0]).toBe(0xda);
    expect(decodeMsgpack(s16)).toBe('z'.repeat(300));

    const s32 = encodeMsgpack('w'.repeat(70_000));
    expect(decodeMsgpack(s32)).toBe('w'.repeat(70_000));

    const bin16 = encodeMsgpack(new Uint8Array(300).fill(1));
    expect((decodeMsgpack(bin16) as Uint8Array).byteLength).toBe(300);

    const arr32 = encodeMsgpack(Array.from({ length: 70_000 }, (_, i) => i));
    expect(decodeMsgpack(arr32)).toHaveLength(70_000);

    const map32 = encodeMsgpack(Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`m${i}`, i])));
    expect(Object.keys(decodeMsgpack(map32) as Record<string, unknown>)).toHaveLength(70_000);
  });
});

// ---------------------------------------------------------------------------
// Envelope validation edge cases
// ---------------------------------------------------------------------------

describe('envelope validation coverage', () => {
  it('rejects non-object args', () => {
    expect(() => validateEnvelope({ do: 'user.update', args: 'nope' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });

  it('rejects non-string return', () => {
    expect(() => validateEnvelope({ query: 'user { id }', return: 42 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });

  it('rejects non-string cache', () => {
    expect(() => validateEnvelope({ query: 'user { id }', cache: 300 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });

  it('rejects non-object envelopes', () => {
    expect(() => validateEnvelope('query')).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });
});

// ---------------------------------------------------------------------------
// AdapterRegistry edge cases
// ---------------------------------------------------------------------------

describe('AdapterRegistry coverage', () => {
  it('rejects malformed adapters', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.register({ entity: 'x' } as never)).toThrow(/entity|resolve/);
  });

  it('rejects duplicate entities', () => {
    const registry = new AdapterRegistry();
    const adapter = { entity: 'user', resolve: () => null };
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
  });

  it('lists adapters in registration order', () => {
    const registry = new AdapterRegistry();
    registry.register([{ entity: 'a', resolve: () => null }, { entity: 'b', resolve: () => null }]);
    expect(registry.list.map((a) => a.entity)).toEqual(['a', 'b']);
    expect(registry.get('a')).toBeDefined();
    expect(registry.get('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine edge cases
// ---------------------------------------------------------------------------

describe('engine coverage', () => {
  it('skips fields the adapter did not return (projection gap)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }]),
    });
    const result = await orbit.execute({ query: 'user { name, missing }' });
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('handles non-record items in projected arrays (relations skipped)', async () => {
    const orbit = createOrbit({
      adapters: [
        {
          entity: 'root',
          resolve: () => [null, { id: '1' }, 'text'],
        },
        {
          entity: 'child',
          resolve: () => [{ id: 'c' }],
        },
      ],
    });
    const result = await orbit.execute({ query: 'root { child { id } }' });
    // Only the record items get the relation attached; nulls and primitives pass
    // through. Unselected fields are projected away as usual.
    expect(result.data).toEqual([null, { child: [{ id: 'c' }] }, 'text']);
  });

  it('lets onBeforeParse rewrite the query to a different entity', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'user', resolve: () => ({ name: 'Ana' }) },
        { entity: 'profile', resolve: () => ({ name: 'Alias' }) },
      ]),
      plugins: [
        {
          name: 'alias',
          hooks: {
            onBeforeParse: ({ query }) => query.replace('profile', 'user'),
          },
        },
      ],
    });
    const result = await orbit.execute({ query: 'profile { name }' });
    expect(result.data).toEqual({ name: 'Ana' });
  });

  it('lets onAfterParse inject filters before resolution', async () => {
    const seen = vi.fn();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: (filters) => {
            seen(filters);
            return { id: filters.id, name: 'Ana' };
          },
        },
      ]),
      plugins: [
        {
          name: 'inject',
          hooks: {
            onAfterParse: ({ parsed }) => ({
              ...parsed,
              filters: { ...parsed.filters, id: 'forced' },
            }),
          },
        },
      ],
    });
    await orbit.execute({ query: 'user { name }' });
    expect(seen).toHaveBeenCalledWith({ id: 'forced' });
  });

  it('lets onBeforeSerialize decline (return undefined) and keep the data', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
      plugins: [
        {
          name: 'conditional',
          hooks: {
            onBeforeSerialize: ({ ctx }) => {
              if (ctx.headers?.get('x-format') !== 'fancy') return undefined;
              return { fancy: true };
            },
          },
        },
      ],
    });
    const plain = await orbit.execute({ query: 'user { name }' });
    expect(plain.data).toEqual({ name: 'Ana' });

    const fancy = await orbit.execute(
      { query: 'user { name }' },
      { headers: new Headers({ 'x-format': 'fancy' }) },
    );
    expect(fancy.data).toEqual({ fancy: true });
  });

  it('passes mutation results through when the adapter returns non-objects', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: () => null,
          mutate: () => 'just-a-string' as never,
        },
      ]),
    });
    const result = await orbit.execute({ do: 'user.update', args: {} });
    expect(result.data).toEqual({ success: true });
  });

  it('normalizes thrown values from plugins (non-Error)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
      plugins: [
        {
          name: 'throwing',
          hooks: {
            onBeforeResolve: () => {
              throw 'boom-string' as never;
            },
          },
        },
      ],
    });
    await expect(orbit.execute({ query: 'user { name }' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
  });
});

// ---------------------------------------------------------------------------
// Parse LRU cache (engine, zero plugins)
// ---------------------------------------------------------------------------

describe('parse cache', () => {
  it('serves repeated queries correctly (cache-hit path)', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => ({ id, name: 'Ana' }) }]),
    });
    const envelope = { query: 'user(id="1") { name }' };
    const first = await orbit.execute(envelope);
    const second = await orbit.execute(envelope);
    const third = await orbit.stream(envelope).next();
    expect(first.data).toEqual({ name: 'Ana' });
    expect(second.data).toEqual({ name: 'Ana' });
    expect(third.value.data).toEqual({ name: 'Ana' });
  });

  it('keys distinct queries separately and evicts beyond the LRU bound', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => ({ id: id ?? 'anon', name: 'Ana' }) }]),
    });
    for (let i = 0; i < 300; i += 1) {
      const result = await orbit.execute({ query: `user(id="${i}") { id }` });
      expect(result.data).toEqual({ id: String(i) });
    }
    // The first entry has been evicted; re-running it must still be correct.
    const again = await orbit.execute({ query: 'user(id="0") { id }' });
    expect(again.data).toEqual({ id: '0' });
  });

  it('never caches when plugins are mounted (no cross-request leaks)', async () => {
    const seen: Record<string, number> = {};
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: (filters) => {
            seen[filters.tenant ?? 'none'] = (seen[filters.tenant ?? 'none'] ?? 0) + 1;
            return { id: '1', tenant: filters.tenant };
          },
        },
      ]),
      plugins: [
        {
          name: 'tenant',
          hooks: {
            onAfterParse: ({ parsed, ctx }) => ({
              ...parsed,
              filters: { ...parsed.filters, tenant: (ctx.state?.tenant as string) ?? 'none' },
            }),
          },
        },
      ],
    });
    await orbit.execute({ query: 'user { id }' }, { state: { tenant: 'a' } });
    await orbit.execute({ query: 'user { id }' }, { state: { tenant: 'b' } });
    await orbit.execute({ query: 'user { id }' }, { state: { tenant: 'a' } });
    // Each tenant must be resolved fresh — the parse tree is never reused.
    expect(seen).toEqual({ a: 2, b: 1 });
  });

  it('caches mutation return queries under the mutate origin', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => ({ id: id ?? 'x', name: 'Ana' }),
          mutate: () => ({ id: '9' }),
        },
      ]),
    });
    const result = await orbit.execute({ do: 'user.update', args: {}, return: 'user(id="9") { id }' });
    expect(result.data).toEqual({ id: '9' });
  });
});
