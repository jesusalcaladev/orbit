import { describe, expect, it } from 'vitest';
import { createOrbit, JSON_CONTENT_TYPE, memoryAdapter } from '../src/index.js';
import type { OrbitConfig } from '../src/index.js';

const users = [{ id: '1', name: 'Ana' }];

function makeOrbit(plugins: OrbitConfig['plugins'] = []) {
  return createOrbit({
    adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => users.find((u) => u.id === id) }]),
    plugins,
  });
}

describe('serialization', () => {
  it('defaults to JSON with the standard content type', async () => {
    const orbit = makeOrbit();
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.contentType).toBe(JSON_CONTENT_TYPE);
  });

  it('lets a plugin serialize to a string payload', async () => {
    const orbit = makeOrbit([
      {
        name: 'msgpack-ish',
        hooks: {
          onBeforeSerialize: ({ data }) => ({
            body: JSON.stringify(data),
            contentType: 'application/x-msgpack',
          }),
        },
      },
    ]);
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.contentType).toBe('application/x-msgpack');
    expect(result.body).toBe('{"name":"Ana"}');
    expect(result.data).toBeUndefined();
  });

  it('lets a plugin serialize to a binary payload', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const orbit = makeOrbit([
      {
        name: 'binary',
        hooks: {
          onBeforeSerialize: () => ({ body: bytes, contentType: 'application/octet-stream' }),
        },
      },
    ]);
    const result = await orbit.execute({ query: 'user(id="1")' });
    expect(result.contentType).toBe('application/octet-stream');
    expect(result.body).toBe(bytes);
  });

  it('chains multiple onBeforeSerialize transforms in order', async () => {
    const orbit = makeOrbit([
      { name: 'a', hooks: { onBeforeSerialize: ({ data }) => ({ tagged: data }) } },
      { name: 'b', hooks: { onBeforeSerialize: ({ data }) => ({ double: data }) } },
    ]);
    const result = await orbit.execute({ query: 'user(id="1") { name }' });
    expect(result.data).toEqual({ double: { tagged: { name: 'Ana' } } });
  });

  it('passes the payload through the handler without re-stringifying', async () => {
    const orbit = makeOrbit([
      {
        name: 'csv',
        hooks: {
          onBeforeSerialize: ({ data }) => ({
            body: Object.entries(data as Record<string, unknown>)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(';'),
            contentType: 'text/csv',
          }),
        },
      },
    ]);
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'user(id="1") { name }' }),
    });
    const response = await orbit.handler(request);
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(await response.text()).toBe('name=Ana');
  });
});
