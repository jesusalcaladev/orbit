import { ErrorCode, OrbitError } from './errors.js';
import type { Filters, NodeOrigin, QueryNode } from './types.js';

/** Default maximum relation nesting depth, per the protocol spec (> 10 fails). */
export const DEFAULT_MAX_DEPTH = 10;

export interface ParseOptions {
  /** Maximum relation nesting depth. Defaults to 10. */
  maxDepth?: number;
  /** Origin stamped on every node. Defaults to `'client'`. */
  origin?: NodeOrigin;
}

/** Escape sequences supported inside quoted string values. */
const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_\-.]/;
const BARE_STOP = /[\s,(){}="']/;

/**
 * Parse an OQS string into a pure `QueryNode` tree.
 *
 * Grammar (whitespace-insensitive):
 *
 * ```text
 * query  := entity [ "{" fields "}" ]
 * entity := IDENT [ "(" args ")" ]
 * args   := kv ( "," kv )*
 * kv     := IDENT "=" value
 * value  := STRING | BARE          # both passed verbatim to adapters
 * fields := item ( "," item )*
 * item   := IDENT [ "(" args ")" ] [ "{" fields "}" ]
 * ```
 *
 * Throws `ORBIT_INVALID_QUERY` on syntax errors and `ORBIT_MAX_DEPTH_EXCEEDED`
 * when the tree nests deeper than `maxDepth`.
 */
export function parseOQS(query: string, options: ParseOptions = {}): QueryNode {
  const parser = new Parser(query, options);
  return parser.parseRoot();
}

class Parser {
  private pos = 0;
  private readonly input: string;
  private readonly maxDepth: number;
  private readonly origin: NodeOrigin;

  constructor(input: string, options: ParseOptions) {
    this.input = input;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.origin = options.origin ?? 'client';
  }

  private fail(message: string): never {
    throw new OrbitError(ErrorCode.INVALID_QUERY, `${message} at position ${this.pos}`, {
      details: { position: this.pos, query: this.input },
    });
  }

  private skipWs(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos]!)) this.pos += 1;
  }

  private peek(): string {
    return this.input[this.pos] ?? '';
  }

  private readIdent(): string {
    if (!IDENT_START.test(this.peek())) {
      this.fail(`Expected an identifier but found '${this.peek() || 'end of input'}'`);
    }
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.input.length && IDENT_CHAR.test(this.input[this.pos]!)) this.pos += 1;
    return this.input.slice(start, this.pos);
  }

  parseRoot(): QueryNode {
    this.skipWs();
    if (this.pos >= this.input.length) {
      this.fail('Query is empty');
    }
    const node = this.parseNode(0);
    this.skipWs();
    if (this.pos < this.input.length) {
      this.fail(`Unexpected trailing input '${this.input.slice(this.pos)}'`);
    }
    return node;
  }

  /**
   * Parse an entity node. When `knownName` is passed (relation fields), the
   * identifier has already been consumed by the caller.
   */
  private parseNode(depth: number, knownName?: string): QueryNode {
    const entity = knownName ?? this.readIdent();
    const filters: Filters = {};
    const fields: string[] = [];
    const relations: Record<string, QueryNode> = {};

    this.skipWs();
    if (this.peek() === '(') this.parseArgs(filters);
    this.skipWs();

    if (this.peek() === '{') {
      this.pos += 1;
      this.skipWs();
      while (this.peek() !== '}') {
        if (this.pos >= this.input.length) {
          this.fail(`Unterminated '{' block for '${entity}'`);
        }
        const name = this.readIdent();
        this.skipWs();

        const isRelation = this.peek() === '(' || this.peek() === '{';
        if (isRelation) {
          const childDepth = depth + 1;
          if (childDepth > this.maxDepth) {
            throw new OrbitError(
              ErrorCode.MAX_DEPTH_EXCEEDED,
              `Maximum query depth of ${this.maxDepth} exceeded at '${name}'`,
              { details: { depth: childDepth, maxDepth: this.maxDepth, node: name } },
            );
          }
          relations[name] = this.parseNode(childDepth, name);
        } else {
          fields.push(name);
        }

        this.skipWs();
        if (this.peek() === ',') {
          this.pos += 1;
          this.skipWs();
        } else if (this.peek() !== '}') {
          this.fail(`Expected ',' or '}' after '${name}'`);
        }
      }
      this.pos += 1; // consume '}'
    }

    return { entity, filters, fields, relations, origin: this.origin };
  }

  private parseArgs(filters: Filters): void {
    this.pos += 1; // consume '('
    this.skipWs();
    while (this.peek() !== ')') {
      if (this.pos >= this.input.length) {
        this.fail("Unterminated '(' argument list");
      }
      const key = this.readIdent();
      this.skipWs();
      if (this.peek() !== '=') {
        this.fail(`Expected '=' after '${key}'`);
      }
      this.pos += 1;
      this.skipWs();
      filters[key] = this.readValue();
      this.skipWs();
      if (this.peek() === ',') {
        this.pos += 1;
        this.skipWs();
      } else if (this.peek() !== ')') {
        this.fail(`Expected ',' or ')' after '${key}="${filters[key]}"'`);
      }
    }
    this.pos += 1; // consume ')'
  }

  private readValue(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.readQuoted(ch);
    const start = this.pos;
    while (this.pos < this.input.length && !BARE_STOP.test(this.input[this.pos]!)) this.pos += 1;
    if (this.pos === start) {
      this.fail('Expected a value after "="');
    }
    return this.input.slice(start, this.pos);
  }

  private readQuoted(quote: string): string {
    this.pos += 1; // opening quote
    let out = '';
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.input[this.pos];
        if (esc === undefined) this.fail('Unterminated escape sequence');
        out += ESCAPES[esc] ?? esc;
        this.pos += 1;
      } else if (ch === quote) {
        this.pos += 1;
        return out;
      } else {
        out += ch;
        this.pos += 1;
      }
    }
    this.fail('Unterminated string literal');
  }
}
