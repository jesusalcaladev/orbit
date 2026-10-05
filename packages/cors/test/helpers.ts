import { createOrbit, memoryAdapter } from '@orbit/core';
import type { CorsPlugin } from '../src/index.js';

/** An Orbit engine with one adapter, so CORS hooks run through the real pipeline. */
export function makeOrbit(plugin: CorsPlugin) {
  return createOrbit({
    adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ id: '1', name: 'Ana' }) }]),
    plugins: [plugin],
  });
}

/** Build a request for the Orbit handler. */
export function request(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Request {
  return new Request('http://localhost/orbit', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
