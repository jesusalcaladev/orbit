import { OrbitError } from '@orbit/core';
import type { OrbitEnvelope } from '@orbit/core';
import { ErrorCode, MSGPACK_CONTENT_TYPE } from '@orbit/core';
import { JSON_CONTENT_TYPE } from './http.js';

import { OrbitNetworkError, orbitErrorFromWire } from './errors.js';
import { decodeBody, effectiveSignal, parseSuccess, readBodyBytes, sendRequest } from './http.js';
import type { HttpDeps } from './http.js';
import type { ClientFormat, OrbitResponse } from './types.js';

export type UploadFiles = Record<string, Blob | File>;

export interface UploadRequest {
  form: FormData;
  format: ClientFormat;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * POST a multipart/form-data upload (spec §7 / docs/server.md): the JSON
 * `envelope` field carries the mutation, one field per file lands in
 * `ctx.files` inside `mutate`. Responses negotiate normally (JSON or
 * MessagePack per `Accept`).
 */
export async function postFormData(deps: HttpDeps, request: UploadRequest): Promise<OrbitResponse> {
  const accept = request.format === 'msgpack' ? MSGPACK_CONTENT_TYPE : JSON_CONTENT_TYPE;
  const { signal, cleanup } = effectiveSignal(request.signal, request.timeoutMs);
  let res: Response;
  try {
    // No content-type header: fetch appends the multipart boundary itself.
    res = await sendRequest(deps, {
      body: request.form,
      accept,
      headers: request.headers,
      signal,
    });
  } finally {
    cleanup();
  }
  const bytes = await readBodyBytes(res, deps.decompress);
  const payload = decodeBody(bytes, res.headers, res.status);
  if (res.ok) return parseSuccess(res, payload);
  // Same wire error contract as any other request (spec §6).
  const orbitError = orbitErrorFromWire(payload, res.status);
  if (orbitError) throw orbitError;
  throw new OrbitNetworkError(`Orbit request failed with HTTP ${res.status}`, {
    status: res.status,
  });
}

/**
 * Build the multipart form for an upload: the JSON `envelope` field plus one
 * field per file. File uploads are mutations only — a query envelope is
 * rejected client-side before any network I/O.
 */
export function buildFormData(envelope: OrbitEnvelope, files: UploadFiles): FormData {
  if (envelope.do === undefined) {
    throw new OrbitError(
      ErrorCode.INVALID_QUERY,
      "File uploads require a 'do' envelope (mutations only)",
    );
  }
  const form = new FormData();
  form.set('envelope', JSON.stringify(envelope));
  for (const [name, file] of Object.entries(files)) {
    form.set(name, file);
  }
  return form;
}
