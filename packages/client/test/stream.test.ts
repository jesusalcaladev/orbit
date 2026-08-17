import { describe, expect, it } from 'vitest';
import { ErrorCode, OrbitError } from '@orbit/core';
import { OrbitNetworkError, createClient } from '../src/index.js';
import { parseSseFrame } from '../src/stream.js';
import { hangingFetch, mockFetch } from './helpers.js';

/** One SSE frame: `data: {json}\n\n`. */
const sseText = (...frames: string[]) => frames.map((frame) => `data: ${frame}\n\n`).join('');

/** An SSE response; `hangAfter` frames makes the stream hang on the next pull. */
function sseResponse(
  frames: string[],
  options: { hangAfter?: number; gzip?: boolean; status?: number } = {},
): Response {
  const encoder = new TextEncoder();
  let pulls = 0;
  let release: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const index = pulls++;
      if (index < frames.length) {
        controller.enqueue(encoder.encode(`data: ${frames[index]}\n\n`));
        return;
      }
      if (options.hangAfter === undefined || index < options.hangAfter) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    cancel() {
      release?.();
    },
  });
  const headers: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (options.gzip) headers['content-encoding'] = 'gzip';
  const body = options.gzip
    ? stream.pipeThrough(
        new CompressionStream('gzip') as unknown as {
          readable: ReadableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        },
      )
    : stream;
  return new Response(body, { status: options.status ?? 200, headers });
}

async function collect(iterable: AsyncIterable<{ level: number | 'done'; data: unknown }>) {
  const out: Array<{ level: number | 'done'; data: unknown }> = [];
  for await (const frame of iterable) out.push(frame);
  return out;
}

async function _waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('stream — SSE parser', () => {
  it('parses data: lines (single and multi-line, CRLF, comments)', () => {
    expect(parseSseFrame('data: {"level":0,"data":{"x":1}}')).toEqual({
      level: 0,
      data: { x: 1 },
    });
    // Multiple data: lines join with '\n' (SSE spec) — two JSON objects joined
    // is not valid JSON, so it yields nothing.
    expect(parseSseFrame('data: {"a":1}\ndata: {"b":2}')).toBeUndefined();
    // A trailing CR (CRLF frames) is tolerated by JSON.parse.
    expect(parseSseFrame('data: {"a":1}\r')).toEqual({ a: 1 });
    expect(parseSseFrame(': comment\ndata: {"level":"done","data":null}')).toEqual({
      level: 'done',
      data: null,
    });
    expect(parseSseFrame('event: custom\ndata: {"level":1}')).toEqual({ level: 1 });
    expect(parseSseFrame('data: not json')).toBeUndefined();
    expect(parseSseFrame('nothing here')).toBeUndefined();
  });

  it('returns undefined for valid JSON that is not an object', () => {
    expect(parseSseFrame('data: 42')).toBeUndefined();
    expect(parseSseFrame('data: "text"')).toBeUndefined();
    expect(parseSseFrame('data: [1, 2]')).toBeUndefined();
  });

  it('yields the graph level by level, ending after the done frame', async () => {
    const { fetchImpl, capture } = mockFetch(() =>
      sseResponse([
        JSON.stringify({ level: 0, data: { name: 'Ana' } }),
        JSON.stringify({ level: 1, data: { name: 'Ana', posts: [{ title: 'A' }] } }),
        JSON.stringify({ level: 'done', data: { name: 'Ana', posts: [{ title: 'A' }] } }),
      ]),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });

    const frames = await collect(client.stream('user(id="1") { posts { title } }'));
    expect(frames).toEqual([
      { level: 0, data: { name: 'Ana' } },
      { level: 1, data: { name: 'Ana', posts: [{ title: 'A' }] } },
      { level: 'done', data: { name: 'Ana', posts: [{ title: 'A' }] } },
    ]);

    // The wire: accept text/event-stream, body is the JSON envelope.
    expect(capture[0]!.init.headers).toMatchObject({
      accept: 'text/event-stream',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(capture[0]!.init.body))).toEqual({
      query: 'user(id="1") { posts { title } }',
    });
  });

  it('carries fromCache/contentType on the done frame', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        JSON.stringify({
          level: 'done',
          data: 'name:Ana',
          fromCache: true,
          contentType: 'text/csv',
        }),
      ]),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const frames = await collect(client.stream('user(id="1") { name }'));
    expect(frames).toEqual([
      { level: 'done', data: 'name:Ana', fromCache: true, contentType: 'text/csv' },
    ]);
  });

  it('sends MessagePack envelopes over SSE', async () => {
    const { fetchImpl, capture } = mockFetch(() =>
      sseResponse([JSON.stringify({ level: 'done', data: null })]),
    );
    const client = createClient({ baseUrl: '/orbit', format: 'msgpack', fetch: fetchImpl });
    await collect(client.stream('user { id }'));
    expect(capture[0]!.init.headers).toMatchObject({
      accept: 'text/event-stream',
      'content-type': 'application/x-msgpack',
    });
    expect(capture[0]!.init.body).toBeInstanceOf(Uint8Array);
  });

  it('throws OrbitError on a mid-stream error frame', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        JSON.stringify({
          error: {
            code: ErrorCode.ENTITY_UNREGISTERED,
            message: "No adapter for 'ghost'",
            details: { entity: 'ghost' },
          },
        }),
      ]),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await collect(client.stream('ghost { id }'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      expect((error as OrbitError).code).toBe(ErrorCode.ENTITY_UNREGISTERED);
      expect((error as OrbitError).details).toEqual({ entity: 'ghost' });
    }
  });

  it('throws OrbitError for a non-200 error response', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse(
        [JSON.stringify({ error: { code: ErrorCode.ENTITY_UNREGISTERED, message: 'nope' } })],
        { status: 404 },
      ),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await collect(client.stream('ghost { id }'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrbitError);
      expect((error as OrbitError).code).toBe(ErrorCode.ENTITY_UNREGISTERED);
      expect((error as OrbitError).status).toBe(404);
    }
  });

  it('throws OrbitNetworkError for a non-200 response that is not an Orbit error', async () => {
    const { fetchImpl } = mockFetch(() => new Response('oops', { status: 500 }));
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(collect(client.stream('user { id }'))).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('wraps a failing body read on an error response', async () => {
    const exploding = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream exploded');
      },
    });
    const { fetchImpl } = mockFetch(
      () =>
        new Response(exploding, {
          status: 500,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(collect(client.stream('user { id }'))).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('handles a response with a null body', async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    expect(await collect(client.stream('user { id }'))).toEqual([]);
  });

  it('handles a gzip header on an empty body', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(new Blob([]).stream(), {
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
        }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    expect(await collect(client.stream('user { id }'))).toEqual([]);
  });

  it('aborts a gzip-header pass-through stream mid-read', async () => {
    const encoder = new TextEncoder();
    let release: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(sseText(JSON.stringify({ level: 0, data: {} }))));
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      cancel() {
        release?.();
      },
    });
    const { fetchImpl } = mockFetch(
      () =>
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
        }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    const iterator = client
      .stream('user { id }', {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts mid-stream: cancels the read and throws AbortError', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([JSON.stringify({ level: 0, data: { name: 'Ana' } })], { hangAfter: 1 }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();

    const seen: unknown[] = [];
    const iterator = client
      .stream('user { id }', { signal: controller.signal })
      [Symbol.asyncIterator]();
    seen.push((await iterator.next()).value);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([{ level: 0, data: { name: 'Ana' } }]);
  });

  it('aborts after timeoutMs on a stream that never ends', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([JSON.stringify({ level: 0, data: {} })], { hangAfter: 1 }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const seen: unknown[] = [];
    const iterator = client.stream('user { id }', { timeoutMs: 50 })[Symbol.asyncIterator]();
    seen.push((await iterator.next()).value);
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });

  it('decompresses gzip-compressed SSE streams', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([JSON.stringify({ level: 'done', data: { ok: true } })], { gzip: true }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const frames = await collect(client.stream('user { id }'));
    expect(frames).toEqual([{ level: 'done', data: { ok: true } }]);
  });

  it('passes through a gzip header on already-decoded bytes (undici quirk)', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(sseText(JSON.stringify({ level: 'done', data: { ok: true } })), {
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
        }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const frames = await collect(client.stream('user { id }'));
    expect(frames).toEqual([{ level: 'done', data: { ok: true } }]);
  });

  it('propagates the fetch rejection for a failing network call', async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(collect(client.stream('user { id }'))).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('cleans up on early return (consumer stops iterating)', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        JSON.stringify({ level: 0, data: { name: 'Ana' } }),
        JSON.stringify({ level: 1, data: { name: 'Ana', posts: [] } }),
        JSON.stringify({ level: 'done', data: { name: 'Ana', posts: [] } }),
      ]),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const iterator = client.stream('user { id }')[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ level: 0, data: { name: 'Ana' } });
    await iterator.return?.(undefined);
    // The rest of the stream is never read — and the generator must be done.
    const next = await iterator.next();
    expect(next.done).toBe(true);
  });

  it('delivers the trailing frame without a final blank line', async () => {
    const { fetchImpl } = mockFetch(() => {
      const body = new Blob([`data: ${JSON.stringify({ level: 'done', data: null })}`]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const frames = await collect(client.stream('user { id }'));
    expect(frames).toEqual([{ level: 'done', data: null }]);
  });

  it('ignores a trailing frame that is not a stream event', async () => {
    const { fetchImpl } = mockFetch(() => {
      const body = new Blob([`data: ${JSON.stringify({ level: 'bogus', data: null })}`]);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    expect(await collect(client.stream('user { id }'))).toEqual([]);
  });

  it('aborts while the request is still in flight', async () => {
    const fetchImpl: typeof fetch = async (url, init) => hangingFetch(String(url), init ?? {});
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    const iterator = client
      .stream('user { id }', {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    // First next() starts the generator and suspends it inside the pending
    // fetch — only then can the abort fire before the body reader exists.
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts with a DOMException when the signal reason is not an Error', async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([JSON.stringify({ level: 0, data: {} })], { hangAfter: 1 }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const controller = new AbortController();
    const iterator = client
      .stream('user { id }', {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort('stream cancelled');
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('skips comment and non-JSON frames mid-stream', async () => {
    const body =
      ': keepalive\n\n' +
      sseText(JSON.stringify({ level: 0, data: { name: 'Ana' } })) +
      'data: not-json\n\n' +
      sseText(JSON.stringify({ level: 'done', data: { name: 'Ana' } }));
    const { fetchImpl } = mockFetch(
      () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    expect(await collect(client.stream('user { id }'))).toEqual([
      { level: 0, data: { name: 'Ana' } },
      { level: 'done', data: { name: 'Ana' } },
    ]);
  });

  it('skips frames that do not speak the level contract', async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          sseText(JSON.stringify({ foo: 1 }), JSON.stringify({ level: 'done', data: null })),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    expect(await collect(client.stream('user { id }'))).toEqual([{ level: 'done', data: null }]);
  });

  it('throws OrbitError on a trailing error frame without a final blank line', async () => {
    const body = `data: ${JSON.stringify({
      error: { code: ErrorCode.ENTITY_UNREGISTERED, message: 'gone' },
    })}`;
    const { fetchImpl } = mockFetch(
      () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(collect(client.stream('ghost { id }'))).rejects.toMatchObject({
      code: ErrorCode.ENTITY_UNREGISTERED,
    });
  });

  it('handles frames split across chunks', async () => {
    const encoder = new TextEncoder();
    const text = sseText(
      JSON.stringify({ level: 0, data: { name: 'Ana' } }),
      JSON.stringify({ level: 'done', data: { name: 'Ana' } }),
    );
    // Split the body into single-byte chunks to stress the frame boundary logic.
    const bytes = encoder.encode(text);
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(index, index + 1));
        index += 1;
      },
    });
    const { fetchImpl } = mockFetch(
      () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    const frames = await collect(client.stream('user(id="1") { name }'));
    expect(frames).toEqual([
      { level: 0, data: { name: 'Ana' } },
      { level: 'done', data: { name: 'Ana' } },
    ]);
  });
});

describe('stream — real server (SSE negotiation end-to-end)', () => {
  it('streams from a real Orbit server', async () => {
    const { createServer } = await import('node:http');
    const { memoryAdapter, createOrbit } = await import('@orbit/core');
    const users = [{ id: '1', name: 'Ana' }];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) },
      ]),
    });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
      }
      for (const hop of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
        headers.delete(hop);
      }
      const response = await orbit.handler(
        new Request('http://localhost/orbit', {
          method: 'POST',
          headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.writeHead(response.status, [...response.headers.entries()]);
      for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
        res.write(chunk);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const client = createClient({ baseUrl: `http://127.0.0.1:${port}/orbit` });
      const frames = await collect(client.stream('user(id="1") { name }'));
      expect(frames.at(-1)).toEqual({ level: 'done', data: { name: 'Ana' } });
      expect(frames[0]).toEqual({ level: 0, data: { name: 'Ana' } });
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
