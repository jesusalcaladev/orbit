import { ErrorCode, createOrbit, memoryAdapter, OrbitError } from '@orbit/core';
import { describe, expect, it, vi } from 'vitest';
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

  it('default logger emits the compact one-line format for a resolved query', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const orbit = createOrbit({
        adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
        plugins: [createLoggingPlugin()],
      });
      await orbit.execute({ query: 'user { name }' });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('[orbit]');
      expect(line).toContain('query');
      expect(line).toContain('200');
      expect(line).toContain('user { name }');
    } finally {
      log.mockRestore();
    }
  });

  it('default logger includes the error code on failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const orbit = createOrbit({
        adapters: memoryAdapter([]),
        plugins: [createLoggingPlugin()],
      });
      await orbit.execute({ query: 'ghost { id }' }).catch(() => {});
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain(ErrorCode.ENTITY_UNREGISTERED);
      expect(line).toContain('404');
    } finally {
      log.mockRestore();
    }
  });

  it('does not log failures that happen before the pipeline stamps a start (no timing)', async () => {
    const entries: LogEntry[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => null }]),
      plugins: [createLoggingPlugin({ logger: (e) => entries.push(e) })],
    });

    // Envelope validation fails BEFORE onBeforeParse runs — there is no
    // timing to report, so the plugin stays silent.
    await expect(orbit.execute({} as never)).rejects.toBeDefined();
    expect(entries).toHaveLength(0);
  });

  it('stays silent on direct hook calls without pipeline timing (defensive)', async () => {
    // The hooks are part of the public OrbitPlugin surface — a direct call
    // (tests, custom pipelines) must not crash or invent timing.
    const entries: LogEntry[] = [];
    const plugin = createLoggingPlugin({ logger: (e) => entries.push(e) });

    // onError with no stamped start → no entry.
    await plugin.hooks.onError?.({
      error: new OrbitError(ErrorCode.INTERNAL, 'boom', { status: 500 }),
      ctx: {} as import('@orbit/core').OrbitContext,
    });
    expect(entries).toHaveLength(0);

    // onBeforeParse with an envelope carrying neither do nor query → the
    // label falls back to '?'.
    const bare = { envelope: {} } as import('@orbit/core').OrbitContext;
    plugin.hooks.onBeforeParse?.({ query: 'x', ctx: bare });

    // A mutation timing reaching onBeforeSerialize is skipped (mutations run
    // no serialize hook — spec §5) and never logged.
    const mutation = { envelope: { do: 'todo.create' } } as import('@orbit/core').OrbitContext;
    plugin.hooks.onBeforeParse?.({ query: 'x', ctx: mutation });
    plugin.hooks.onBeforeSerialize?.({
      data: null,
      node: {} as import('@orbit/core').QueryNode,
      ctx: mutation,
    });
    expect(entries).toHaveLength(0);
  });
});
