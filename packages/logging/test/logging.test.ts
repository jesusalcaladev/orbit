import { ErrorCode, createOrbit, memoryAdapter, OrbitError } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { createLoggingPlugin } from '../src/index.js';
import type { LogEntry } from '../src/index.js';

function fakeClock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('createLoggingPlugin', () => {
  it('logs a resolved query with its duration and 200 status', async () => {
    const entries: LogEntry[] = [];
    const clock = fakeClock();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          async resolve() {
            clock.advance(12);
            return { id: '1', name: 'Ana' };
          },
        },
      ]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e), now: clock.now })],
    });

    await orbit.execute({ query: 'user { name }' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operation: 'query', status: 200, label: 'user { name }' });
    expect(entries[0]!.durationMs).toBeCloseTo(12, 5);
    expect(entries[0]!.error).toBeUndefined();
  });

  it('logs a query failure with its error code and status', async () => {
    const entries: LogEntry[] = [];
    const clock = fakeClock();
    const orbit = createOrbit({
      adapters: memoryAdapter([]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e), now: clock.now })],
    });

    await expect(orbit.execute({ query: 'nope { x }' })).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: 'query',
      status: 404,
      error: { code: ErrorCode.ENTITY_UNREGISTERED },
    });
  });

  it('logs a mutation failure with operation "mutation"', async () => {
    const entries: LogEntry[] = [];
    const clock = fakeClock();
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'todo',
          resolve: () => null,
          mutate: () => {
            throw new OrbitError(ErrorCode.MUTATION_FAILED, 'Mutation failed');
          },
        },
      ]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e), now: clock.now })],
    });

    await expect(orbit.execute({ do: 'todo.create' })).rejects.toMatchObject({
      code: ErrorCode.MUTATION_FAILED,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: 'mutation',
      status: 500,
      error: { code: ErrorCode.MUTATION_FAILED },
    });
  });

  it('does not time a successful mutation (no serialize hook — documented)', async () => {
    const entries: LogEntry[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'todo', resolve: () => null, mutate: () => ({ id: '1' }) },
      ]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e) })],
    });

    await orbit.execute({ do: 'todo.create' });

    expect(entries).toHaveLength(0);
  });

  it('truncates long labels to maxLabelLength', async () => {
    const entries: LogEntry[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => null }]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e), maxLabelLength: 8 })],
    });

    await orbit.execute({ query: 'user(id="very-long-identifier") { name }' });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toHaveLength(8);
    expect(entries[0]!.label.endsWith('…')).toBe(true);
  });
});
