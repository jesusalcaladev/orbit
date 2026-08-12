import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/errors.js';
import { parseOQS } from '../src/parser.js';

describe('parseOQS — roots & filters', () => {
  it('parses a bare entity', () => {
    const node = parseOQS('user');
    expect(node).toEqual({ entity: 'user', filters: {}, fields: [], relations: {}, origin: 'client' });
  });

  it('parses a single quoted filter', () => {
    const node = parseOQS('user(id="123")');
    expect(node.entity).toBe('user');
    expect(node.filters).toEqual({ id: '123' });
  });

  it('passes bare values verbatim as strings', () => {
    const node = parseOQS('posts(id=42)');
    expect(node.filters).toEqual({ id: '42' });
  });

  it('accepts single-quoted values', () => {
    const node = parseOQS("user(id='123')");
    expect(node.filters).toEqual({ id: '123' });
  });

  it('parses multiple filters', () => {
    const node = parseOQS('posts(status="published",author="1")');
    expect(node.filters).toEqual({ status: 'published', author: '1' });
  });

  it('is whitespace-insensitive', () => {
    const node = parseOQS('  user ( id = "123" ,  name="Ana" )  ');
    expect(node.filters).toEqual({ id: '123', name: 'Ana' });
  });

  it('supports escapes inside quoted values', () => {
    const node = parseOQS('user(name="a\\"b\\\\c\\n")');
    expect(node.filters).toEqual({ name: 'a"b\\c\n' });
  });

  it('supports dashes and dots in identifiers', () => {
    const node = parseOQS('user { first-name, profile.image }');
    expect(node.fields).toEqual(['first-name', 'profile.image']);
  });

  it('keeps numeric-looking strings verbatim', () => {
    const node = parseOQS('user(id="00123")');
    expect(node.filters.id).toBe('00123');
  });
});

describe('parseOQS — fields & relations', () => {
  it('parses leaf fields', () => {
    const node = parseOQS('user { name, email }');
    expect(node.fields).toEqual(['name', 'email']);
    expect(node.relations).toEqual({});
  });

  it('parses nested relations with filters and fields', () => {
    const node = parseOQS('user(id="123") { name, posts(status="published") { title, views } }');
    expect(node.entity).toBe('user');
    expect(node.fields).toEqual(['name']);
    expect(node.relations.posts).toEqual({
      entity: 'posts',
      filters: { status: 'published' },
      fields: ['title', 'views'],
      relations: {},
      origin: 'client',
    });
  });

  it('parses relations without filters', () => {
    const node = parseOQS('user(id="1") { posts { title } }');
    expect(node.relations.posts?.filters).toEqual({});
  });

  it('parses relations without braces (args only)', () => {
    const node = parseOQS('user(id="1") { posts(status="draft") }');
    expect(node.relations.posts).toBeDefined();
    expect(node.relations.posts?.fields).toEqual([]);
  });

  it('parses deeply nested trees', () => {
    const node = parseOQS('a { b { c { d { e } } } }');
    const d = node.relations.b!.relations.c!.relations.d!;
    expect(d.entity).toBe('d');
    expect(d.fields).toEqual(['e']);
    expect(d.relations).toEqual({});
  });

  it('stamps the mutation origin when requested', () => {
    const node = parseOQS('user(id="1") { name }', { origin: 'mutate' });
    expect(node.origin).toBe('mutate');
    expect(node.relations).toEqual({});
  });
});

describe('parseOQS — errors', () => {
  it('rejects an empty query', () => {
    expect(() => parseOQS('')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects whitespace-only queries', () => {
    expect(() => parseOQS('   ')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects trailing garbage', () => {
    expect(() => parseOQS('user extra')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects an unterminated string literal', () => {
    expect(() => parseOQS('user(id="123)')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects an unterminated brace block', () => {
    expect(() => parseOQS('user { name, posts { title }')).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_QUERY }),
    );
  });

  it('rejects an unterminated argument list', () => {
    expect(() => parseOQS('user(id="1"')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects a missing "="', () => {
    expect(() => parseOQS('user(id "1")')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects a missing value', () => {
    expect(() => parseOQS('user(id=)')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('rejects an identifier starting with a digit', () => {
    expect(() => parseOQS('1user')).toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_QUERY }));
  });

  it('includes position details in the error', () => {
    try {
      parseOQS('user(id="1" ) extra');
      expect.unreachable('should have thrown');
    } catch (error) {
      const orbitError = error as { code: string; details: { position: number } };
      expect(orbitError.code).toBe(ErrorCode.INVALID_QUERY);
      expect(typeof orbitError.details.position).toBe('number');
    }
  });
});

describe('parseOQS — depth limits', () => {
  it('allows nesting up to the configured max depth', () => {
    const node = parseOQS('a { b { c { d } } }', { maxDepth: 3 });
    expect(node.relations.b?.relations.c).toBeDefined();
  });

  it('rejects nesting beyond the configured max depth', () => {
    // `e` nests as a relation at depth 4, above the configured maximum of 3.
    expect(() => parseOQS('a { b { c { d { e { f } } } } }', { maxDepth: 3 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_DEPTH_EXCEEDED }),
    );
  });

  it('defaults to a max depth of 10', () => {
    const deep = 'a{'.repeat(11) + 'b' + '}'.repeat(11); // deepest relation at depth 10
    expect(() => parseOQS(deep)).not.toThrow();
    const deeper = 'a{'.repeat(12) + 'b' + '}'.repeat(12); // deepest relation at depth 11
    expect(() => parseOQS(deeper)).toThrowError(
      expect.objectContaining({ code: ErrorCode.MAX_DEPTH_EXCEEDED }),
    );
  });
});
