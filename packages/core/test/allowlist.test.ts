import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, createOrbit, createQueryAllowlistPlugin, memoryAdapter } from '../src/index.js';

/**
 * The query allowlist plugin (spec §12): production hardening for an
 * intent-first protocol — the server decides which queries it will run at all.
 */

const KNOWN = 'user(id="1") { name }';

function world(queries: string[], extra: Record<string, unknown> = {}) {
  const resolve = vi.fn(() => ({ id: '1', name: 'Ana' }));
  const mutate = vi.fn(() => ({ id: '1' }));
  const orbit = createOrbit({
    adapters: memoryAdapter([
      { entity: 'user', resolve, mutate },
      { entity: 'post', resolve: () => ({ id: 'p1' }), mutate },
    ]),
    plugins: [createQueryAllowlistPlugin({ queries, ...extra })],
  });
  return { orbit, resolve, mutate };
}

describe('createQueryAllowlistPlugin', () => {
  it("does not let a mutation's `return` re-query bypass the read allowlist", async () => {
    // The re-query is a server-initiated READ: it must pass the read policy
    // even though the envelope is a mutation.
    const { orbit } = world([KNOWN]);
    await expect(
      orbit.execute({ do: 'user.update', args: {}, return: 'user { name, secret }' }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it('still serves a `return` re-query that IS allowlisted', async () => {
    const { orbit, resolve } = world([KNOWN]);
    const result = await orbit.execute({ do: 'user.update', args: {}, return: KNOWN });
    expect(result.status).toBe(200);
    expect(resolve).toHaveBeenCalled();
  });

  it('runs an allowlisted query and never reaches the parser for a miss', async () => {
    const { orbit, resolve } = world([KNOWN]);
    const ok = await orbit.execute({ query: KNOWN });
    expect(ok.status).toBe(200);
    expect(resolve).toHaveBeenCalled();

    // `execute` rejects with the plugin's error (it does not convert to a
    // response); the `handler` is what maps an error to a 403 body.
    await expect(orbit.execute({ query: 'user(id="1") { secret }' })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      status: 403,
    });

    const response = await orbit.handler(
      new Request('https://x.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'user(id="1") { secret }' }),
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('reports a miss by digest, never by query text', async () => {
    const { orbit } = world([KNOWN]);
    // The rejection carries the query's digest and never its text: the query
    // can hold caller-controlled values, and an error body reaches the client
    // and the logs.
    await expect(orbit.execute({ query: 'user(id="2") { password }' })).rejects.toSatisfy(
      (error: unknown) => {
        const details = (error as { details: { digest: string } }).details;
        expect(details.digest).toMatch(/^[0-9a-z]+$/);
        expect(JSON.stringify((error as { details: unknown }).details)).not.toContain('password');
        return true;
      },
    );
  });

  it('matches on digest so a persisted query id needs no query text', async () => {
    // Same list, different whitespace-free but equivalent text is NOT matched
    // literally — the digest mode is what lets a client ship an id.
    const { orbit } = world([KNOWN]);
    const audit = vi.fn();
    const auditOrbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }) }]),
      plugins: [createQueryAllowlistPlugin({ queries: [KNOWN], enforce: false, onMiss: audit })],
    });
    await auditOrbit.execute({ query: 'user(id="9") { name }' });
    expect(audit).toHaveBeenCalledWith('user(id="9") { name }', expect.any(String));
    await expect(orbit.execute({ query: KNOWN })).resolves.toMatchObject({ status: 200 });
  });

  it('runs in audit mode: misses are reported but still served', async () => {
    const misses: string[] = [];
    const resolve = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          enforce: false,
          onMiss: (q) => misses.push(q),
        }),
      ],
    });
    const result = await orbit.execute({ query: 'user(id="7") { name }' });
    // Audit mode observes what strict policy WOULD reject, without breaking
    // the request — the safe way to roll this out.
    expect(result.status).toBe(200);
    expect(misses).toEqual(['user(id="7") { name }']);
  });

  it('does not govern mutations unless `mutations` is provided', async () => {
    // The default must never turn "allowlist my reads" into "deny all writes".
    const { orbit, mutate } = world([KNOWN]);
    // `do` carries no OQS string, so without an explicit `mutations` list this
    // plugin must stay out of the write path entirely.
    const written = await orbit.execute({ do: 'user.update', args: { payload: { name: 'B' } } });
    expect(written.status).toBe(200);
    expect(mutate).toHaveBeenCalled();
  });

  it('gates mutations when `mutations` is provided', async () => {
    const resolve = vi.fn(() => ({ id: '1' }));
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve, mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
        }),
      ],
    });

    expect((await orbit.execute({ do: 'user.update', args: {} })).status).toBe(200);

    await expect(orbit.execute({ do: 'user.delete', args: {} })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
      // Rejections identify by digest only — the action/query text can hold
      // caller-controlled values and travels to the client and the logs.
      details: { digest: expect.any(String), allowed: 1 },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('gates every op of a batch, not just the first', async () => {
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [createQueryAllowlistPlugin({ queries: [KNOWN], mutations: ['user.update'] })],
    });
    // The second op is not allowlisted -> the batch is refused before any op
    // runs, so a partially-applied batch cannot slip through.
    await expect(
      orbit.execute({
        ops: [
          { do: 'user.update', args: {} },
          { do: 'user.destroy', args: {} },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('audits rejected mutations in audit mode without blocking them', async () => {
    const misses: string[] = [];
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
          enforce: false,
          onMiss: (subject) => misses.push(subject),
        }),
      ],
    });
    // Audit mode must observe the writes it would have blocked, then let them
    // through — the way to see a policy's blast radius before enforcing it.
    expect((await orbit.execute({ do: 'user.delete', args: {} })).status).toBe(200);
    expect(misses).toEqual(['user.delete']);

    const queryMiss: string[] = [];
    const auditOrbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
          enforce: false,
          onMiss: (subject) => queryMiss.push(subject),
        }),
      ],
    });
    expect((await auditOrbit.execute({ query: 'user(id="3") { name }' })).status).toBe(200);
    expect(queryMiss).toEqual(['user(id="3") { name }']);
  });

  it('audits every op of a batch, not just the first', async () => {
    // Audit mode over a batch must report EACH rejected action — otherwise a
    // rollout would show one miss for a batch that contained two.
    const misses: string[] = [];
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
          enforce: false,
          onMiss: (subject) => misses.push(subject),
        }),
      ],
    });
    const result = await orbit.execute({
      ops: [
        { do: 'user.delete', args: {} },
        { do: 'user.update', args: {} },
      ],
    });
    expect(result.status).toBe(200);
    // Only the un-allowlisted action is reported; the allowed one passes.
    expect(misses).toEqual(['user.delete']);
  });

  it('tolerates an envelope carrying a non-string action', () => {
    // Defensive: `actionsOf` walks the envelope's declared actions, and a
    // hand-built (or JS-authored) envelope can hold a malformed op. The plugin
    // must not throw a TypeError on it — a policy gate that crashes is worse
    // than one that passes, and `validateEnvelope` is what rejects such input.
    const gate = createQueryAllowlistPlugin({ queries: [KNOWN], mutations: ['user.update'] });
    const envelope = { do: 'user.update', ops: [{ do: 42 as unknown as string }] };
    expect(() =>
      gate.hooks.onBeforeParse?.({ query: 'user.update', ctx: { envelope } }),
    ).not.toThrow();
    // With no envelope there are no declared actions, so the same string is
    // judged as a READ — and denied, since it is not in the query allowlist.
    // Malformed input must never make the gate lenient.
    expect(() => gate.hooks.onBeforeParse?.({ query: 'user.update', ctx: {} })).toThrowError(
      expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
    );
  });

  it('reports each distinct miss once per request, across both gates', async () => {
    // A batch is checked by the pre-flight AND again per op. The counter a
    // rollout watches must count REQUESTS-with-a-miss, not gate invocations.
    const misses: string[] = [];
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
          enforce: false,
          onMiss: (subject) => misses.push(subject),
        }),
      ],
    });
    await orbit.execute({
      ops: [
        { do: 'user.delete', args: {} },
        { do: 'user.delete', args: {} },
      ],
    });
    // Same action twice in one request -> reported once.
    expect(misses).toEqual(['user.delete']);

    // A SECOND request is a separate event and is reported again.
    await orbit.execute({ do: 'user.delete', args: {} });
    expect(misses).toEqual(['user.delete', 'user.delete']);
  });

  it('audits a rejected single `do` in audit mode', async () => {
    const misses: string[] = [];
    const mutate = vi.fn(() => ({ id: '1' }));
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1' }), mutate }]),
      plugins: [
        createQueryAllowlistPlugin({
          queries: [KNOWN],
          mutations: ['user.update'],
          enforce: false,
          onMiss: (subject) => misses.push(subject),
        }),
      ],
    });
    expect((await orbit.execute({ do: 'user.destroy', args: {} })).status).toBe(200);
    expect(misses).toEqual(['user.destroy']);
  });

  it('ignores a query whose only difference is whitespace it cannot match', async () => {
    const { orbit } = world([KNOWN]);
    // Literal comparison: a near-miss is a miss, not a lenient pass.
    await expect(orbit.execute({ query: 'user(id="1"){name}' })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
  });
});
