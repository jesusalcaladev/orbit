import { describe, expect, it } from 'vitest';
import { createOrbit, memoryAdapter } from '../src/index.js';
import { ErrorCode } from '../src/errors.js';
import type { MutationArgs } from '../src/types.js';

// ---------------------------------------------------------------------------
// File uploads (multipart/form-data → ctx.files)
//
// The frozen envelope contract is untouched: uploads are a TRANSPORT feature.
// The handler parses the multipart body, validates the `envelope` field
// exactly like any other envelope, and delivers File values in ctx.files
// (never in envelope fields). Adapters read them from `mutate(action, args,
// ctx)`; plugins see them on ctx.
// ---------------------------------------------------------------------------

function uploadOrbit(options: { maxPayloadBytes?: number; maxMultipartFields?: number } = {}) {
  const received: { args: MutationArgs; files: Record<string, File> | undefined }[] = [];
  const orbit = createOrbit({
    adapters: memoryAdapter([
      {
        entity: 'user',
        resolve: () => ({ id: '1', name: 'Ana' }),
        mutate: (action, args, ctx) => {
          if (action === 'uploadAvatar') {
            // Capture what the adapter sees: args verbatim + ctx.files.
            received.push({ args, files: ctx.files });
          }
          return { id: '1' };
        },
      },
    ]),
    ...options,
  });
  return { orbit, received };
}

function multipartRequest(envelope: unknown, files: Array<[string, File]>): Request {
  const form = new FormData();
  form.set('envelope', JSON.stringify(envelope));
  for (const [name, file] of files) form.set(name, file, file.name);
  return new Request('http://localhost/orbit', { method: 'POST', body: form });
}

describe('file uploads — multipart handler', () => {
  it('delivers uploaded files to the adapter via ctx.files', async () => {
    const { orbit, received } = uploadOrbit();
    const avatar = new File([new Uint8Array([1, 2, 3, 4])], 'me.png', {
      type: 'image/png',
    });
    const response = await orbit.handler(
      multipartRequest({ do: 'user.uploadAvatar', args: { id: '1' } }, [['avatar', avatar]]),
    );
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.args).toEqual({ id: '1' });
    const file = received[0]!.files?.avatar;
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe('me.png');
    expect(file!.type).toBe('image/png');
    expect(file!.size).toBe(4);
    expect(await response.json()).toEqual({ data: { success: true, id: '1' } });
  });

  it('supports multiple files and non-file-free envelopes', async () => {
    const { orbit, received } = uploadOrbit();
    const a = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' });
    const b = new File([new Uint8Array([2, 2])], 'b.bin', { type: 'application/octet-stream' });
    await orbit.handler(
      multipartRequest({ do: 'user.uploadAvatar' }, [
        ['one', a],
        ['two', b],
      ]),
    );
    expect(Object.keys(received[0]!.files ?? {})).toEqual(['one', 'two']);
    const one = received[0]!.files?.one;
    const two = received[0]!.files?.two;
    expect(one?.name).toBe('a.txt');
    expect(two?.name).toBe('b.bin');
  });

  it('keeps the envelope contract untouched (args pass verbatim)', async () => {
    const { orbit, received } = uploadOrbit();
    await orbit.handler(
      multipartRequest(
        { do: 'user.uploadAvatar', args: { filter: { id: '7' }, payload: { kind: 'x' } } },
        [['avatar', new File(['z'], 'z.png')]],
      ),
    );
    expect(received[0]!.args).toEqual({ filter: { id: '7' }, payload: { kind: 'x' } });
  });

  it('rejects a missing envelope field', async () => {
    const { orbit } = uploadOrbit();
    const form = new FormData();
    form.set('avatar', new File(['x'], 'x.png'), 'x.png');
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('rejects an invalid envelope JSON field', async () => {
    const { orbit } = uploadOrbit();
    const form = new FormData();
    form.set('envelope', '{not json');
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('rejects a valid-JSON envelope field that fails envelope validation', async () => {
    // JSON.parse succeeds but validateEnvelope rejects (neither `query` nor
    // `do`) — the OrbitError must be rethrown as-is, not wrapped as a plain
    // JSON parse failure (engine keeps the precise code either way).
    const { orbit } = uploadOrbit();
    const form = new FormData();
    form.set('envelope', JSON.stringify({}));
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('rejects non-file fields other than envelope', async () => {
    const { orbit } = uploadOrbit();
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'user.uploadAvatar' }));
    form.set('note', 'this is not a file');
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ErrorCode.INVALID_QUERY);
  });

  it('enforces maxPayloadBytes on the whole multipart body (413)', async () => {
    const { orbit } = uploadOrbit({ maxPayloadBytes: 200 });
    const big = new File([new Uint8Array(512)], 'big.bin');
    const response = await orbit.handler(
      multipartRequest({ do: 'user.uploadAvatar' }, [['file', big]]),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('enforces the limit via content-length pre-check (413)', async () => {
    const { orbit } = uploadOrbit({ maxPayloadBytes: 100 });
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'user.uploadAvatar' }));
    form.set('file', new File([new Uint8Array(1024)], 'big.bin'), 'big.bin');
    // Simulate a large declared upload (as a proxy would forward it): the
    // handler rejects on the header BEFORE buffering the multipart body.
    const request = new Request('http://localhost/orbit', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----orbit-test',
        'content-length': '999999',
      },
      body: '',
    });
    const response = await orbit.handler(request);
    expect(response.status).toBe(413);
  });

  it('caps the number of multipart fields (default 64)', async () => {
    const { orbit } = uploadOrbit();
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'user.uploadAvatar' }));
    // 65 fields beyond the envelope → over the default cap.
    for (let i = 0; i < 65; i += 1) {
      form.set(`f${i}`, new File(['x'], `f${i}.bin`), `f${i}.bin`);
    }
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe(ErrorCode.INVALID_QUERY);
    expect(body.error.details.maxFields).toBe(64);
  });

  it('respects a custom maxMultipartFields cap', async () => {
    const { orbit, received } = uploadOrbit({ maxMultipartFields: 2 });
    // At the cap (envelope + 1 file): allowed.
    let form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'user.uploadAvatar' }));
    form.set('one', new File(['a'], 'a.bin'), 'a.bin');
    let response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);

    // Over the cap (envelope + 2 files): rejected.
    form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'user.uploadAvatar' }));
    form.set('one', new File(['a'], 'a.bin'), 'a.bin');
    form.set('two', new File(['b'], 'b.bin'), 'b.bin');
    response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.details.maxFields).toBe(2);
  });

  it('serves queries with SSE negotiation for multipart too', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }]),
    });
    const form = new FormData();
    form.set('envelope', JSON.stringify({ query: 'user { name }' }));
    const response = await orbit.handler(
      new Request('http://localhost/orbit', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('"name":"Ana"');
  });
});

describe('file uploads — programmatic execute', () => {
  it('passes ctx.files through execute', async () => {
    const { orbit, received } = uploadOrbit();
    const avatar = new File(['hello'], 'hi.txt', { type: 'text/plain' });
    const result = await orbit.execute(
      { do: 'user.uploadAvatar', args: { id: '1' } },
      { files: { avatar } },
    );
    expect(result.data).toEqual({ success: true, id: '1' });
    expect(received[0]!.files?.avatar?.size).toBe(5);
  });

  it('exposes ctx.files to plugins', async () => {
    let seen: Record<string, File> | undefined;
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({}) }]),
      plugins: [
        {
          name: 'file-spy',
          hooks: {
            // Query hooks receive the full ctx (mutations only call
            // adapter.mutate — no pipeline), so observe via a query.
            onBeforeResolve({ ctx }) {
              seen = ctx.files;
            },
          },
        },
      ],
    });
    const file = new File(['data'], 'd.bin');
    await orbit.execute({ query: 'user { id }' }, { files: { upload: file } });
    expect(seen?.upload).toBe(file);
  });
});

describe('file uploads — errors', () => {
  it('surfaces adapter mutation errors with their codes', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([
        { entity: 'user', resolve: () => ({}), mutate: () => ({ id: '1' }) },
      ]),
    });
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'ghost.update' }));
    const response = await orbit.handler(
      new Request('http://localhost/orbit', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe(ErrorCode.ENTITY_UNREGISTERED);
  });
});
