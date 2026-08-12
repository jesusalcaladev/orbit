import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '../src/index.js';
import { ErrorCode } from '../src/errors.js';

describe('memoryAdapter', () => {
  it('builds one adapter per definition', () => {
    const adapters = memoryAdapter([
      { entity: 'a', resolve: () => 1 },
      { entity: 'b', resolve: () => 2 },
    ]);
    expect(adapters).toHaveLength(2);
    expect(adapters[0]!.entity).toBe('a');
    expect(adapters[1]!.entity).toBe('b');
  });

  it('delegates resolve calls and merges parent context in batch', async () => {
    const resolve = vi.fn((filters: Record<string, string>, ctx: { parent?: unknown }) => ({
      ...filters,
      parent: ctx.parent,
    }));
    const adapters = memoryAdapter([{ entity: 'x', resolve }]);
    const adapter = adapters[0]!;

    await adapter.resolve({ id: '1' }, {});
    expect(resolve).toHaveBeenCalledWith({ id: '1' }, {});

    const results = await adapter.batch!(
      [
        { filters: { id: '1' }, parent: { entity: 'a', data: {} } },
        { filters: { id: '2' }, parent: { entity: 'a', data: {} } },
      ],
      {},
    );
    expect(results).toHaveLength(2);
    expect(resolve).toHaveBeenLastCalledWith({ id: '2' }, { parent: { entity: 'a', data: {} } });
  });

  it('throws ORBIT_MUTATION_FAILED without a mutate handler', async () => {
    const adapters = memoryAdapter([{ entity: 'x', resolve: () => null }]);
    await expect(adapters[0]!.mutate!('update', {}, {})).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });
  });

  it('delegates mutations when provided', async () => {
    const mutate = vi.fn(() => ({ id: '1' }));
    const adapters = memoryAdapter([{ entity: 'x', resolve: () => null, mutate }]);
    const result = await adapters[0]!.mutate!('update', { filter: { id: '1' } }, {});
    expect(result).toEqual({ id: '1' });
    expect(mutate).toHaveBeenCalledWith('update', { filter: { id: '1' } }, {});
  });

  it('delegates subscribe and returns an unsubscribe', async () => {
    const subscribe = vi.fn(() => () => undefined);
    const adapters = memoryAdapter([{ entity: 'x', resolve: () => null, subscribe }]);
    const adapter = adapters[0]!;
    const handler = () => undefined;
    const unsubscribe = adapter.subscribe!({}, handler);
    expect(subscribe).toHaveBeenCalledWith({}, handler);
    expect(typeof unsubscribe).toBe('function');
  });

  it('omits subscribe when the definition has none', () => {
    const adapters = memoryAdapter([{ entity: 'x', resolve: () => null }]);
    expect(adapters[0]!.subscribe).toBeUndefined();
  });
});
