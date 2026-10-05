import { describe, expect, it } from 'vitest';
import { createCorsPlugin } from '../src/index.js';
import { makeOrbit, request } from './helpers.js';

describe('createCorsPlugin — credentials, exposed headers, preflight', () => {
  it('stamps credentials and exposed headers', async () => {
    const orbit = makeOrbit(
      createCorsPlugin({
        origins: ['https://app.example'],
        credentials: true,
        exposeHeaders: ['x-orbit-trace', 'etag'],
      }),
    );
    const response = await orbit.handler(
      request('POST', { origin: 'https://app.example' }, { query: 'user { name }' }),
    );
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-expose-headers')).toBe('x-orbit-trace, etag');
  });

  it('rejects credentials combined with a wildcard origin', () => {
    // Browsers refuse `*` with credentials; failing loudly beats a silent
    // no-op that only shows up as a mysterious browser error.
    expect(() => createCorsPlugin({ origins: '*', credentials: true })).toThrow(/credentials/);
  });

  it('answers a preflight with the advertised method, header and max-age contract', async () => {
    const orbit = makeOrbit(
      createCorsPlugin({
        origins: ['https://app.example'],
        methods: ['GET', 'POST'],
        headers: ['content-type', 'x-orbit-query'],
        maxAge: 600,
      }),
    );
    const response = await orbit.handler(
      request('OPTIONS', {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'content-type, x-orbit-query',
    );
    expect(response.headers.get('access-control-max-age')).toBe('600');
  });

  it('reflects the requested headers and defaults the rest', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: '*' }));
    const response = await orbit.handler(
      request('OPTIONS', {
        origin: 'https://a.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-custom',
      }),
    );
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, x-custom');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('access-control-max-age')).toBe('600');
  });

  it('never advertises allow-headers on a preflight without requested headers', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: '*' }));
    const response = await orbit.handler(
      request('OPTIONS', {
        origin: 'https://a.example',
        'access-control-request-method': 'GET',
      }),
    );
    expect(response.headers.get('access-control-allow-headers')).toBeNull();
  });

  it('denies a preflight from a disallowed origin without failing the request', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: ['https://app.example'] }));
    const response = await orbit.handler(
      request('OPTIONS', {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
    // It still varies on origin, so a cache can't leak the allowlist decision.
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });
});
