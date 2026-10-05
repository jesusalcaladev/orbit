import { describe, expect, it } from 'vitest';
import { createCorsPlugin } from '../src/index.js';
import { makeOrbit, request } from './helpers.js';

describe('createCorsPlugin — allowlist', () => {
  it('reflects an allowed origin and marks the response origin-dependent', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: ['https://app.example'] }));
    const response = await orbit.handler(
      request('POST', { origin: 'https://app.example' }, { query: 'user { name }' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    // The allow-origin value is per-origin, so shared caches must key on it.
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('omits the allow-origin header for a rejected origin (browser blocks it)', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: ['https://app.example'] }));
    const response = await orbit.handler(
      request('POST', { origin: 'https://evil.example' }, { query: 'user { name }' }),
    );
    // A CORS rejection is not an application error: the request still succeeds.
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts a single origin string and a wildcard', async () => {
    const single = makeOrbit(createCorsPlugin({ origins: 'https://one.example' }));
    const one = await single.handler(
      request('POST', { origin: 'https://one.example' }, { query: 'user { name }' }),
    );
    expect(one.headers.get('access-control-allow-origin')).toBe('https://one.example');

    const any = makeOrbit(createCorsPlugin({ origins: '*' }));
    const wildcard = await any.handler(
      request('POST', { origin: 'https://anything.example' }, { query: 'user { name }' }),
    );
    expect(wildcard.headers.get('access-control-allow-origin')).toBe('*');
    // Nothing origin-specific, so no need to vary on it.
    expect(wildcard.headers.get('vary')?.toLowerCase() ?? '').not.toContain('origin');
  });

  it('accepts a predicate and ignores an absent Origin', async () => {
    const orbit = makeOrbit(createCorsPlugin({ origins: (origin) => origin.endsWith('.example') }));
    const ok = await orbit.handler(
      request('POST', { origin: 'https://a.example' }, { query: 'user { name }' }),
    );
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://a.example');

    // No Origin header (same-origin or a non-browser client): nothing to allow.
    const none = await orbit.handler(request('POST', {}, { query: 'user { name }' }));
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('defaults to a wildcard when no origins are configured', () => {
    expect(createCorsPlugin().isAllowed('https://any.example')).toBe(true);
  });
});
