import { describe, expect, it } from 'vitest';
import { createOrbit, decodeMsgpack, encodeMsgpack, memoryAdapter } from '../src/index.js';
import type { OrbitStreamEvent } from '../src/index.js';
import { ErrorCode } from '../src/errors.js';

const users = [{ id: '1', name: 'Ana' }, { id: '2', name: 'Bruno' }];
const posts = [
  { id: 'p1', authorId: '1', title: 'First' },
  { id: 'p2', authorId: '1', title: 'Second' },
];

function makeOrbit() {
  return createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: ({ id }) => {
          if (id) return users.find((u) => u.id === id);
          return users;
        },
      },
      {
        entity: 'posts',
        resolve: (_filters, ctx) => {
          const parent = ctx.parent;
          if (parent) return posts.filter((p) => p.authorId === (parent.data as { id: string }).id);
          return posts;
        },
      },
    ]),
  });
}

function request(envelope: unknown, init: RequestInit = {}): Request {
  const { headers: extraHeaders, ...rest } = init;
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [key, value] of new Headers(extraHeaders).entries()) headers.set(key, value);
  return new Request('http://localhost/orbit', {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
    ...rest,
  });
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('handler — Accept negotiation', () => {
  it('serves JSON by default', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(request({ query: 'user(id="1") { name }' }));
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ data: { name: 'Ana' } });
  });

  it('serves MessagePack when Accept: application/x-msgpack', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'user(id="1") { name, posts { title } }' }, { headers: { accept: 'application/x-msgpack' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-msgpack');
    const body = decodeMsgpack(new Uint8Array(await response.arrayBuffer())) as {
      data: { name: string; posts: { title: string }[] };
    };
    expect(body.data.name).toBe('Ana');
    expect(body.data.posts).toHaveLength(2);
  });

  it('respects q-values between json and msgpack', async () => {
    const orbit = makeOrbit();
    const msgpack = await orbit.handler(
      request({ query: 'user(id="1") { name }' }, { headers: { accept: 'application/json;q=0.5, application/x-msgpack;q=0.8' } }),
    );
    expect(msgpack.headers.get('content-type')).toBe('application/x-msgpack');

    const json = await orbit.handler(
      request({ query: 'user(id="1") { name }' }, { headers: { accept: 'application/x-msgpack;q=0.5, application/json;q=0.9' } }),
    );
    expect(json.headers.get('content-type')).toContain('application/json');
  });

  it('serves msgpack errors with the negotiated format', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'ghost { id }' }, { headers: { accept: 'application/x-msgpack' } }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/x-msgpack');
    const body = decodeMsgpack(new Uint8Array(await response.arrayBuffer())) as {
      error: { code: string };
    };
    expect(body.error.code).toBe(ErrorCode.ENTITY_UNREGISTERED);
  });
});

describe('handler — gzip', () => {
  it('compresses JSON when Accept-Encoding: gzip', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'user { name }' }, { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const inflated = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(await response.arrayBuffer()))));
    expect(inflated.data).toEqual([{ name: 'Ana' }, { name: 'Bruno' }]);
  });

  it('compresses msgpack payloads too', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'user(id="1") { name }' }, { headers: { accept: 'application/x-msgpack', 'accept-encoding': 'gzip' } }),
    );
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const inflated = decodeMsgpack(await gunzip(new Uint8Array(await response.arrayBuffer()))) as {
      data: { name: string };
    };
    expect(inflated.data.name).toBe('Ana');
  });

  it('serves uncompressed when gzip is not requested', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(request({ query: 'user(id="1") { name }' }));
    expect(response.headers.get('content-encoding')).toBeNull();
  });
});

describe('handler — MessagePack envelopes', () => {
  it('accepts envelopes encoded as application/x-msgpack', async () => {
    const orbit = makeOrbit();
    const envelope = encodeMsgpack({ query: 'user(id="2") { name }' });
    const response = await orbit.handler(
      new Request('http://localhost/orbit', {
        method: 'POST',
        headers: { 'content-type': 'application/x-msgpack', accept: 'application/json' },
        body: envelope,
      }),
    );
    expect(await response.json()).toEqual({ data: { name: 'Bruno' } });
  });
});

describe('handler — SSE streaming', () => {
  it('streams the graph level by level as text/event-stream', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'user(id="1") { name, posts { title } }' }, { headers: { accept: 'text/event-stream' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events: OrbitStreamEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
        if (data) events.push(JSON.parse(data));
      }
    }

    expect(events.map((e) => e.level)).toEqual([0, 1, 'done']);
    expect(events[0]!.data).toEqual({ name: 'Ana' });
    expect((events[1]!.data as { posts: unknown[] }).posts).toHaveLength(2);
    expect((events[2]!.data as { posts: unknown[] }).posts).toHaveLength(2);
  });

  it('emits mid-stream errors as SSE frames (status stays 200 once streaming)', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'ghost { id }' }, { headers: { accept: 'text/event-stream' } }),
    );
    // Streaming starts before the entity is resolved, so the error becomes an
    // SSE frame — pre-stream errors (e.g. oversized payloads) keep real statuses.
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('data: ');
    expect(text).toContain('ORBIT_ENTITY_UNREGISTERED');
  });

  it('fails query syntax errors with a real 400 before the stream commits', async () => {
    const orbit = makeOrbit();
    const response = await orbit.handler(
      request({ query: 'user(id="1' }, { headers: { accept: 'text/event-stream' } }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('ORBIT_INVALID_QUERY');
  });

  it('compresses plugin payloads when gzip is requested', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => users }]),
      plugins: [
        {
          name: 'csv',
          hooks: {
            onBeforeSerialize: ({ data }) => ({
              body: (data as unknown[]).map((u) => (u as { name: string }).name).join('\n'),
              contentType: 'text/csv',
            }),
          },
        },
      ],
    });
    const response = await orbit.handler(
      request(
        { query: 'user { name }' },
        { headers: { accept: 'text/csv', 'accept-encoding': 'gzip' } },
      ),
    );
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const inflated = new TextDecoder().decode(await gunzip(new Uint8Array(await response.arrayBuffer())));
    expect(inflated).toBe('Ana\nBruno');
  });
});
