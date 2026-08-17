import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCachePlugin, createOrbit, ErrorCode, memoryAdapter, OrbitError } from '@orbit/core';
import type { Orbit, OrbitHandler, OrbitPlugin } from '@orbit/core';
import { createClient } from '../src/index.js';

/**
 * Bridge a node:http server to the engine's fetch-compatible handler: read the
 * IncomingMessage into bytes, rebuild a web `Request`, run the pipeline, and
 * write the `Response` back over the socket. The client then talks to it with
 * the real global fetch — a genuine end-to-end HTTP round trip.
 */
async function serve(handler: OrbitHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    // Hop-by-hop headers are for the wire, not for a constructed Request.
    for (const hop of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
      headers.delete(hop);
    }

    const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
      method: req.method ?? 'GET',
      headers,
      body: body.byteLength > 0 ? body : undefined,
    });
    const response = await handler(request);
    res.writeHead(response.status, [...response.headers.entries()]);
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/orbit`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeWorld(options: { cache?: boolean; capture?: Record<string, string | null> } = {}) {
  const users = [
    { id: '1', name: 'Ana' },
    { id: '2', name: 'Bruno' },
  ];
  const plugins: OrbitPlugin[] = [];
  if (options.cache) plugins.push(createCachePlugin());
  if (options.capture) {
    const capture = options.capture;
    plugins.push({
      name: 'header-log',
      hooks: {
        onBeforeResolve: ({ ctx }) => {
          for (const key of Object.keys(capture)) {
            capture[key] = ctx.headers?.get(key) ?? null;
          }
        },
      },
    });
  }
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => (id ? users.find((u) => u.id === id) : users),
        mutate: (action, { payload }) => {
          if (action === 'update') Object.assign(users[0]!, payload ?? {});
          return { id: users[0]!.id, invalidates: ['cache:user:1'] };
        },
      },
    ]),
    plugins,
  });
}

describe('@orbit/client — real server (node:http + Orbit handler)', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(orbit: Orbit): Promise<string> {
    // Bind: `handler` is a class method touching private fields, so it must
    // be called with its instance (`this`).
    server = await serve((request) => orbit.handler(request));
    return server.url;
  }

  it('queries over real HTTP (JSON)', async () => {
    const url = await start(makeWorld());
    const client = createClient({ baseUrl: url });

    const res = await client.query('user(id="1") { name }');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ name: 'Ana' });
  });

  it('queries over real HTTP with MessagePack end-to-end', async () => {
    const capture: Record<string, string | null> = { accept: null };
    const url = await start(makeWorld({ capture }));
    const client = createClient({ baseUrl: url, format: 'msgpack' });

    const res = await client.query('user(id="2") { name }');
    expect(res.data).toEqual({ name: 'Bruno' });
    // The server really negotiated MessagePack: the client's Accept header
    // arrived as application/x-msgpack and the response round-tripped as such.
    expect(capture.accept).toBe('application/x-msgpack');
  });

  it('maps a real 404 to OrbitError', async () => {
    const url = await start(makeWorld());
    const client = createClient({ baseUrl: url });

    try {
      await client.query('ghost { id }');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      const err = error as OrbitError;
      expect(err.code).toBe(ErrorCode.ENTITY_UNREGISTERED);
      expect(err.status).toBe(404);
      expect(err.details).toEqual({ entity: 'ghost' });
    }
  });

  it('mutates with a return re-query and surfaces invalidates', async () => {
    const url = await start(makeWorld());
    const client = createClient({ baseUrl: url });

    const res = await client.mutate(
      'user.update',
      { filter: { id: '1' }, payload: { name: 'Ana P.' } },
      { return: 'user(id="1") { name }' },
    );
    expect(res.data).toEqual({ name: 'Ana P.' });
    expect(res.invalidates).toEqual(['cache:user:1']);

    // The mutation really landed: a fresh query sees the new name.
    const fresh = await client.query('user(id="1") { name }');
    expect(fresh.data).toEqual({ name: 'Ana P.' });
  });

  it('requests gzip over real HTTP (server sees accept-encoding)', async () => {
    const capture: Record<string, string | null> = { 'accept-encoding': null };
    const url = await start(makeWorld({ capture }));
    const client = createClient({ baseUrl: url });

    const res = await client.query('user { name }');
    expect(res.data).toEqual([{ name: 'Ana' }, { name: 'Bruno' }]);
    expect(capture['accept-encoding']).toContain('gzip');
  });

  it('honors the envelope cache spec (fromCache on the second hit)', async () => {
    const url = await start(makeWorld({ cache: true }));
    const client = createClient({ baseUrl: url });

    const first = await client.query('user(id="1") { name }', { cache: 'ttl=60' });
    expect(first.fromCache).toBeUndefined();
    expect(first.data).toEqual({ name: 'Ana' });

    const second = await client.query('user(id="1") { name }', { cache: 'ttl=60' });
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual({ name: 'Ana' });
  });

  it('streams SSE end-to-end and marks cache hits on the done frame', async () => {
    const url = await start(makeWorld({ cache: true }));
    const client = createClient({ baseUrl: url });

    const collect = async (): Promise<Array<{ level: number | 'done'; data: unknown }>> => {
      const frames: Array<{ level: number | 'done'; data: unknown }> = [];
      for await (const frame of client.stream('user(id="1") { name }', { cache: 'ttl=60' })) {
        frames.push(frame);
      }
      return frames;
    };

    const first = await collect();
    expect(first[0]).toEqual({ level: 0, data: { name: 'Ana' } });
    expect(first.at(-1)).toEqual({ level: 'done', data: { name: 'Ana' } });

    const second = await collect();
    expect(second.at(-1)).toMatchObject({
      level: 'done',
      data: { name: 'Ana' },
      fromCache: true,
    });
  });

  it('uploads a file over real HTTP (multipart → ctx.files)', async () => {
    const uploaded: Array<{ name: string; size: number }> = [];
    const orbit = createOrbit({
      adapters: [
        {
          entity: 'file',
          resolve: () => uploaded,
          mutate: (action, _args, ctx) => {
            if (action === 'upload') {
              const file = ctx.files?.upload;
              if (!file) {
                throw new OrbitError(ErrorCode.FILTER_INVALID, 'No file in field "upload"');
              }
              uploaded.push({ name: file.name, size: file.size });
              return { id: String(uploaded.length) };
            }
            throw new Error(`unknown action '${action}'`);
          },
        },
      ],
    });
    const url = await start(orbit);
    const client = createClient({ baseUrl: url });

    const res = await client.upload(
      'file.upload',
      { filter: { id: '1' } },
      { upload: new File(['hello orbit'], 'note.txt', { type: 'text/plain' }) },
    );
    expect(res.data).toEqual({ success: true, id: '1' });

    // The file really landed in ctx.files and is queryable afterwards.
    const list = await client.query('file { name, size }');
    expect(list.data).toEqual([{ name: 'note.txt', size: 11 }]);
  });
});
