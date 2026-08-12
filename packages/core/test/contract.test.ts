import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  ErrorStatus,
  HOOK_ORDER,
  JSON_CONTENT_TYPE,
  createOrbit,
  memoryAdapter,
  parseOQS,
  validateEnvelope,
} from '../src/index.js';
import { OrbitError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// The frozen protocol contract (spec.md §3 / §5 / §6 / §9 / §11).
//
// If a shape asserted here changes, it is a BREAKING protocol change: the
// spec requires a major version bump, never a silent tweak. When the contract
// evolves, update spec.md AND this file in the same change.
// ---------------------------------------------------------------------------

const FROZEN_ERROR_CODES = [
  'ORBIT_INVALID_QUERY',
  'ORBIT_ENTITY_UNREGISTERED',
  'ORBIT_FILTER_INVALID',
  'ORBIT_PERMISSION_DENIED',
  'ORBIT_MAX_DEPTH_EXCEEDED',
  'ORBIT_PAYLOAD_TOO_LARGE',
  'ORBIT_MUTATION_FAILED',
  'ORBIT_SUBSCRIPTION_FAILED',
  'ORBIT_INTERNAL',
] as const;

const FROZEN_ERROR_STATUS: Record<string, number> = {
  ORBIT_INVALID_QUERY: 400,
  ORBIT_ENTITY_UNREGISTERED: 404,
  ORBIT_FILTER_INVALID: 400,
  ORBIT_PERMISSION_DENIED: 403,
  ORBIT_MAX_DEPTH_EXCEEDED: 400,
  ORBIT_PAYLOAD_TOO_LARGE: 413,
  ORBIT_MUTATION_FAILED: 500,
  ORBIT_SUBSCRIPTION_FAILED: 500,
  ORBIT_INTERNAL: 500,
};

const FROZEN_HOOK_ORDER = [
  'onBeforeParse',
  'onAfterParse',
  'onBeforeResolve',
  'onBeforeExecute',
  'onAfterResolve',
  'onBeforeSerialize',
  'onError',
] as const;

describe('contract: error codes & wire shape', () => {
  it('exposes exactly the frozen error codes', () => {
    expect(Object.values(ErrorCode)).toEqual([...FROZEN_ERROR_CODES]);
  });

  it('maps every frozen code to its frozen HTTP status', () => {
    for (const code of FROZEN_ERROR_CODES) {
      expect(ErrorStatus[code]).toBe(FROZEN_ERROR_STATUS[code]);
    }
  });

  it('serializes errors to the frozen wire shape { error: { code, message } }', () => {
    const error = new OrbitError(ErrorCode.ENTITY_UNREGISTERED, 'No adapter', {
      details: { entity: 'user' },
    });
    expect(error.toJSON()).toEqual({
      error: {
        code: 'ORBIT_ENTITY_UNREGISTERED',
        message: 'No adapter',
        details: { entity: 'user' },
      },
    });
  });
});

describe('contract: envelope rules (spec §3)', () => {
  it('requires exactly one of query/do', () => {
    expect(() => validateEnvelope({})).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    expect(() => validateEnvelope({ query: 'a', do: 'b' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    expect(validateEnvelope({ query: 'a' })).toEqual({ query: 'a' });
    expect(validateEnvelope({ do: 'a.b' })).toEqual({ do: 'a.b' });
  });

  it('types args/return/cache strictly and drops unknown fields', () => {
    expect(() => validateEnvelope({ query: 'a', args: 'nope' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    expect(() => validateEnvelope({ query: 'a', return: 42 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    expect(() => validateEnvelope({ query: 'a', cache: 300 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
    expect(validateEnvelope({ query: 'a', extra: true })).toEqual({ query: 'a' });
  });
});

describe('contract: parsed query tree (spec §11)', () => {
  it('parses to the frozen QueryNode shape', () => {
    const node = parseOQS('user(id="1") { name, posts { title } }');
    expect(node).toEqual({
      entity: 'user',
      filters: { id: '1' },
      fields: ['name'],
      relations: {
        posts: { entity: 'posts', filters: {}, fields: ['title'], relations: {}, origin: 'client' },
      },
      origin: 'client',
    });
  });

  it('stamps client queries with origin "client" and supports the mutate origin', () => {
    expect(parseOQS('user { id }').origin).toBe('client');
    expect(parseOQS('user { id }', { origin: 'mutate' }).origin).toBe('mutate');
  });
});

describe('contract: mutation return re-queries (spec §5)', () => {
  it('stamps return nodes with origin "mutate" through the full pipeline', async () => {
    const origins: string[] = [];
    const orbit = createOrbit({
      adapters: memoryAdapter([
        {
          entity: 'user',
          resolve: ({ id }) => ({ id: id ?? '1', name: 'Ana' }),
          mutate: () => ({ id: '1' }),
        },
      ]),
      plugins: [
        {
          name: 'origin-spy',
          hooks: {
            onAfterParse({ parsed }) {
              origins.push(parsed.origin);
            },
          },
        },
      ],
    });
    await orbit.execute({ do: 'user.update', args: {}, return: 'user { id }' });
    expect(origins).toEqual(['mutate']);
  });
});

describe('contract: plugin pipeline order (spec §11)', () => {
  it('keeps the frozen hook order', () => {
    expect(HOOK_ORDER).toEqual([...FROZEN_HOOK_ORDER]);
  });
});

describe('contract: DataAdapter surface (spec §9)', () => {
  it('memoryAdapter implements the frozen surface (resolve/batch/mutate always)', () => {
    const adapter = memoryAdapter([{ entity: 'user', resolve: () => ({}) }])[0]!;
    expect(adapter.entity).toBe('user');
    expect(typeof adapter.resolve).toBe('function');
    expect(typeof adapter.batch).toBe('function');
    // The reference adapter always exposes `mutate` — it rejects mutations
    // with ORBIT_MUTATION_FAILED unless a handler is defined.
    expect(typeof adapter.mutate).toBe('function');
    expect(adapter.subscribe).toBeUndefined();
  });

  it('forwards mutate/subscribe when defined', () => {
    const adapter = memoryAdapter([
      {
        entity: 'user',
        resolve: () => ({}),
        mutate: () => ({ id: '1' }),
        subscribe: () => () => {},
      },
    ])[0]!;
    expect(typeof adapter.mutate).toBe('function');
    expect(typeof adapter.subscribe).toBe('function');
  });
});

describe('contract: execute result shape (spec §6)', () => {
  it('returns the frozen OrbitResult shape for a query', async () => {
    const orbit = createOrbit({
      adapters: memoryAdapter([{ entity: 'user', resolve: () => ({ name: 'Ana' }) }]),
    });
    const result = await orbit.execute({ query: 'user { name }' });
    expect(result).toEqual({
      status: 200,
      data: { name: 'Ana' },
      fromCache: false,
      contentType: JSON_CONTENT_TYPE,
    });
  });
});
