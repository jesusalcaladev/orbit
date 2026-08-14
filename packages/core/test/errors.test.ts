import { describe, expect, it } from 'vitest';
import { ErrorCode, ErrorStatus, OrbitError, toOrbitError } from '../src/errors.js';

describe('OrbitError', () => {
  it('carries code, message and status', () => {
    const error = new OrbitError(ErrorCode.ENTITY_UNREGISTERED, 'No adapter for "user"');
    expect(error.name).toBe('OrbitError');
    expect(error.code).toBe('ORBIT_ENTITY_UNREGISTERED');
    expect(error.message).toBe('No adapter for "user"');
    expect(error.status).toBe(404);
    expect(error).toBeInstanceOf(Error);
  });

  it('maps every standard code to an HTTP status', () => {
    expect(ErrorStatus[ErrorCode.INVALID_QUERY]).toBe(400);
    expect(ErrorStatus[ErrorCode.ENTITY_UNREGISTERED]).toBe(404);
    expect(ErrorStatus[ErrorCode.FILTER_INVALID]).toBe(400);
    expect(ErrorStatus[ErrorCode.PERMISSION_DENIED]).toBe(403);
    expect(ErrorStatus[ErrorCode.MAX_DEPTH_EXCEEDED]).toBe(400);
    expect(ErrorStatus[ErrorCode.PAYLOAD_TOO_LARGE]).toBe(413);
    expect(ErrorStatus[ErrorCode.MUTATION_FAILED]).toBe(500);
    expect(ErrorStatus[ErrorCode.INTERNAL]).toBe(500);
  });

  it('allows overriding the status', () => {
    const error = new OrbitError(ErrorCode.INTERNAL, 'oops', { status: 503 });
    expect(error.status).toBe(503);
  });

  it('serializes to the wire shape', () => {
    const error = new OrbitError(ErrorCode.INVALID_QUERY, 'bad query', {
      details: { position: 3 },
    });
    expect(error.toJSON()).toEqual({
      error: { code: 'ORBIT_INVALID_QUERY', message: 'bad query', details: { position: 3 } },
    });
  });

  it('omits details when absent', () => {
    const error = new OrbitError(ErrorCode.INTERNAL, 'x');
    expect(error.toJSON()).toEqual({ error: { code: 'ORBIT_INTERNAL', message: 'x' } });
  });

  it('preserves the cause chain', () => {
    const cause = new Error('root cause');
    const error = new OrbitError(ErrorCode.MUTATION_FAILED, 'boom', { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('toOrbitError', () => {
  it('passes OrbitErrors through unchanged', () => {
    const original = new OrbitError(ErrorCode.FILTER_INVALID, 'bad uuid');
    expect(toOrbitError(original)).toBe(original);
  });

  it('wraps plain Errors as a sanitized ORBIT_INTERNAL', () => {
    const error = toOrbitError(new Error('db blew up'));
    expect(error.code).toBe(ErrorCode.INTERNAL);
    // The internal message never reaches the wire — it may embed secrets
    // (tokens, connection strings). The original rides as `cause` for logs.
    expect(error.message).toBe('Internal server error');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('db blew up');
  });

  it('never leaks the original message through the wire shape', () => {
    const error = toOrbitError(new Error('token=secret-123 leaked'));
    expect(JSON.stringify(error.toJSON())).not.toContain('secret-123');
  });

  it('wraps non-Error values', () => {
    const error = toOrbitError('weird');
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.message).toBe('Internal server error');
    expect(error.cause).toBe('weird');
  });

  it('wraps undefined/null', () => {
    expect(toOrbitError(undefined).code).toBe(ErrorCode.INTERNAL);
    expect(toOrbitError(null).code).toBe(ErrorCode.INTERNAL);
  });
});
