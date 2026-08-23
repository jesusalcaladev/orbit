import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@orbit/core';
import { OrbitNetworkError, createClient } from '../src/index.js';
import { buildFormData } from '../src/multipart.js';
import { hangingFetch, jsonRes, mockFetch } from './helpers.js';

describe('multipart — buildFormData', () => {
  it('puts the JSON envelope in the envelope field and one field per file', () => {
    const file = new File(['avatar-bytes'], 'me.png', { type: 'image/png' });
    const form = buildFormData(
      { do: 'user.uploadAvatar', args: { filter: { id: '1' } } },
      { avatar: file },
    );

    expect(form.get('envelope')).toBe(
      JSON.stringify({ do: 'user.uploadAvatar', args: { filter: { id: '1' } } }),
    );
    const avatar = form.get('avatar');
    expect(avatar).toBeInstanceOf(File);
    expect((avatar as File).name).toBe('me.png');
    expect((avatar as File).type).toBe('image/png');
  });

  it('rejects query envelopes without touching the network', () => {
    expect(() => buildFormData({ query: 'user { id }' }, {})).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });
});

describe('multipart — client.upload', () => {
  it('POSTs a multipart form with the envelope and files, and parses the reply', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { success: true, id: '1' } }));
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });

    const res = await client.upload(
      'user.uploadAvatar',
      { filter: { id: '1' } },
      { avatar: new File(['x'], 'me.png') },
      { return: 'user(id="1") { name }' },
    );
    expect(res.data).toEqual({ success: true, id: '1' });

    expect(capture[0]!.init.method).toBe('POST');
    expect(capture[0]!.init.body).toBeInstanceOf(FormData);
    const form = capture[0]!.init.body as FormData;
    expect(JSON.parse(String(form.get('envelope')))).toEqual({
      do: 'user.uploadAvatar',
      args: { filter: { id: '1' } },
      return: 'user(id="1") { name }',
    });
    expect(form.get('avatar')).toBeInstanceOf(File);
    // The client does NOT set content-type for FormData bodies — fetch appends
    // the multipart boundary itself (covered end-to-end in server.test.ts).
    expect((capture[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('negotiates a MessagePack response', async () => {
    const { fetchImpl, capture } = mockFetch(() => jsonRes({ data: { ok: true } }));
    const client = createClient({ baseUrl: '/orbit', format: 'msgpack', fetch: fetchImpl });
    await client.upload('user.uploadAvatar', {}, { avatar: new File(['x'], 'me.png') });
    expect(capture[0]!.init.headers).toMatchObject({ accept: 'application/x-msgpack' });
  });

  it('maps a non-2xx multipart reply to OrbitError', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonRes(
        { error: { code: ErrorCode.FILTER_INVALID, message: 'No file in field "upload"' } },
        400,
      ),
    );
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    try {
      await client.upload('user.uploadAvatar', {}, { avatar: new File(['x'], 'me.png') });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.FILTER_INVALID, status: 400 });
    }
  });

  it('throws OrbitNetworkError for a non-2xx reply that is not an Orbit error', async () => {
    const { fetchImpl } = mockFetch(() => jsonRes({ data: 'not-an-error' }, 500));
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(
      client.upload('user.uploadAvatar', {}, { avatar: new File(['x'], 'me.png') }),
    ).rejects.toBeInstanceOf(OrbitNetworkError);
  });

  it('releases the timeout resources when the request itself fails', async () => {
    const { fetchImpl } = mockFetch(hangingFetch);
    const client = createClient({ baseUrl: '/orbit', fetch: fetchImpl });
    await expect(
      client.upload(
        'user.uploadAvatar',
        {},
        { avatar: new File(['x'], 'me.png') },
        { timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts after timeoutMs even when the upload BODY stalls', async () => {
    const stalledFetch: typeof fetch = (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
    const client = createClient({ baseUrl: '/orbit', fetch: stalledFetch });
    await expect(
      client.upload(
        'user.uploadAvatar',
        {},
        { avatar: new File(['x'], 'me.png') },
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
