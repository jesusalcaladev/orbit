/**
 * @orbit/postgres — a PostgreSQL `DataAdapter` for @orbit/core.
 *
 * Translates Orbit's verbatim string filters into parameterized SQL (`WHERE`
 * clauses are built from `$n` placeholders — never string interpolation), so
 * client-controlled values can only ever travel as bind parameters. Identifier
 * positions (table, columns) are validated against a strict charset and quoted,
 * so they can never be injected through a filter key either.
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { Pool } from 'pg';
 * import { createPostgresAdapter } from '@orbit/postgres';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const orbit = createOrbit({
 *   adapters: [
 *     createPostgresAdapter({
 *       entity: 'user',
 *       client: pool,
 *       table: 'users',
 *       idColumn: 'user_id',
 *       columns: { name: 'full_name' }, // OQS field/filter/payload → SQL column
 *     }),
 *   ],
 * });
 * ```
 *
 * Behavior notes:
 * - An `id` filter resolves to a single record (`null` when missing); any
 *   other filter set resolves to an array.
 * - `limit` is validated (integer, 1..maxLimit) and emitted as `LIMIT`.
 * - `cursor` is not supported by default — it throws `ORBIT_FILTER_INVALID`;
 *   keyset pagination is app-specific, so a custom adapter/resolver owns it.
 * - `batch` groups sibling requests that share a filter shape into one query
 *   using `IN (...)` lists (the N+1 fix) and regroups rows by request.
 */
import { ErrorCode, OrbitError, isRecord } from '@orbit/core';
import type {
  BatchRequest,
  DataAdapter,
  Filters,
  MutationArgs,
  MutationResult,
  OrbitContext,
} from '@orbit/core';

/** One row, keyed by column name — `pg` returns exactly this shape. */
export type PostgresRow = Record<string, unknown>;

/** The result of a `query` call — the only part of `pg` the adapter reads. */
export interface PostgresQueryResult {
  rows: PostgresRow[];
}

/**
 * The minimal client surface the adapter needs. `pg`'s `Pool`/`PoolClient`/
 * `Client` satisfy it out of the box; inject any client with a `query(text,
 * values)` method.
 */
export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

/** Operators available for filter translation. */
export type PostgresFilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like';

/** Per-filter-key translation rules. */
export interface PostgresFilterSpec {
  /** SQL column for this filter key. Defaults to `columns[key] ?? key`. */
  column?: string;
  /** Comparison operator. Defaults to `eq`. */
  operator?: PostgresFilterOperator;
}

/** The three built-in mutation verbs (custom actions alias to one of these). */
export type PostgresMutationVerb = 'create' | 'update' | 'delete';

export interface PostgresAdapterOptions {
  /** Entity name this adapter serves — must match query roots and relations. */
  entity: string;
  /** A connected `pg`-compatible client (see {@link PostgresClient}). */
  client: PostgresClient;
  /** SQL table name. Defaults to `entity`. */
  table?: string;
  /** SQL primary-key column. Defaults to `id`. */
  idColumn?: string;
  /**
   * OQS name → SQL column name, used for filters, mutation payloads and
   * result aliasing. When omitted, names are assumed to match the columns
   * (identity). Rows are always fetched with `SELECT *` and re-keyed here;
   * the core projects requested fields server-side, so unrequested columns
   * never reach the wire.
   */
  columns?: Record<string, string>;
  /** Per-filter-key column/operator overrides (equality by default). */
  filters?: Record<string, PostgresFilterSpec>;
  /**
   * When resolving a relation under a parent record, scope with
   * `WHERE <parentKey> = parent.id`. For example, `posts` under `user` with
   * `parentKey: 'author_id'`.
   */
  parentKey?: string;
  /** Upper bound for the reserved `limit` filter. Defaults to 1000. */
  maxLimit?: number;
  /** Custom action name → built-in verb, e.g. `{ archive: 'update' }`. */
  mutations?: Record<string, PostgresMutationVerb>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const OPERATOR_SQL: Record<PostgresFilterOperator, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
};

const DEFAULT_VERBS: Record<string, PostgresMutationVerb> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
};

const DEFAULT_MAX_LIMIT = 1000;

/** Quote a (validated) identifier, handling `schema.table` and reserved words. */
function quoteIdent(name: string): string {
  return name
    .split('.')
    .map((segment) => `"${segment}"`)
    .join('.');
}

/** Fail fast on a config typo — a developer error, not a client error. */
function assertIdent(name: string, what: string): void {
  if (!IDENT.test(name)) {
    throw new Error(`@orbit/postgres: invalid ${what} identifier ${JSON.stringify(name)}`);
  }
}

/** Filter-column validation is client-triggered, so it is a protocol error. */
function assertFilterColumn(column: string, key: string): void {
  if (!IDENT.test(column)) {
    throw new OrbitError(ErrorCode.FILTER_INVALID, `Invalid filter column for '${key}'`, {
      details: { filter: key },
    });
  }
}

/** Coerce an unknown row value into `MutationResult.id`. */
function toId(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function parentIdOf(parent: OrbitContext['parent']): unknown {
  return isRecord(parent?.data) ? parent.data.id : undefined;
}

function mutationFailed(message: string, details?: Record<string, unknown>): OrbitError {
  return new OrbitError(ErrorCode.MUTATION_FAILED, message, { details });
}

interface Predicate {
  column: string;
  operator: PostgresFilterOperator;
}

interface Plan {
  predicates: Predicate[];
  /** Bind values aligned with `predicates`, in order. */
  values: unknown[];
  /** True when the query had an `id` filter (single-record result). */
  single: boolean;
  hasLimit: boolean;
  hasCursor: boolean;
}

interface Config {
  entity: string;
  client: PostgresClient;
  table: string;
  idColumn: string;
  columns: Record<string, string>;
  filters: Record<string, PostgresFilterSpec>;
  parentKey?: string;
  maxLimit: number;
  mutations: Record<string, PostgresMutationVerb>;
}

/**
 * Translate a filter set + parent context into an ordered predicate/value
 * plan. Reserved `limit`/`cursor` are surfaced as flags (they are not SQL
 * predicates); every other key maps to a column and operator.
 */
function planFilters(filters: Filters, ctx: OrbitContext, config: Config): Plan {
  const predicates: Predicate[] = [];
  const values: unknown[] = [];
  let single = false;
  let hasLimit = false;
  let hasCursor = false;

  for (const [key, value] of Object.entries(filters)) {
    if (key === 'limit') {
      hasLimit = true;
      continue;
    }
    if (key === 'cursor') {
      hasCursor = true;
      continue;
    }

    let column: string;
    let operator: PostgresFilterOperator;
    if (key === 'id') {
      column = config.idColumn;
      operator = 'eq';
      single = true;
    } else {
      const spec = config.filters[key];
      column = spec?.column ?? config.columns[key] ?? key;
      operator = spec?.operator ?? 'eq';
    }

    assertFilterColumn(column, key);
    predicates.push({ column, operator });
    values.push(value);
  }

  if (ctx.parent && config.parentKey) {
    const parentId = parentIdOf(ctx.parent);
    if (parentId !== undefined) {
      predicates.push({ column: config.parentKey, operator: 'eq' });
      values.push(parentId);
    }
  }

  return { predicates, values, single, hasLimit, hasCursor };
}

/** Re-key a raw row: OQS aliases for mapped columns, plus `id` for the PK. */
function remapRow(
  row: PostgresRow,
  columns: Record<string, string>,
  idColumn: string,
): PostgresRow {
  const out: PostgresRow = { ...row };
  for (const [field, column] of Object.entries(columns)) {
    if (column in row) out[field] = row[column];
  }
  if (idColumn in row && !('id' in row)) out.id = row[idColumn];
  return out;
}

function readLimit(raw: string | undefined, maxLimit: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
    throw new OrbitError(ErrorCode.FILTER_INVALID, `Invalid 'limit' filter`, {
      details: { limit: raw, max: maxLimit },
    });
  }
  return parsed;
}

function cursorUnsupported(): OrbitError {
  return new OrbitError(
    ErrorCode.FILTER_INVALID,
    "The 'cursor' filter is not supported by @orbit/postgres",
    { details: { filter: 'cursor' } },
  );
}

/** Map a payload key to its column (identity by default). */
function payloadColumn(key: string, columns: Record<string, string>): string {
  const column = columns[key] ?? key;
  if (!IDENT.test(column)) {
    throw mutationFailed(`Invalid column for payload key '${key}'`, { key });
  }
  return column;
}

/** Build a PostgreSQL `DataAdapter`. */
export function createPostgresAdapter(options: PostgresAdapterOptions): DataAdapter {
  const config: Config = {
    entity: options.entity,
    client: options.client,
    table: options.table ?? options.entity,
    idColumn: options.idColumn ?? 'id',
    columns: options.columns ?? {},
    filters: options.filters ?? {},
    parentKey: options.parentKey,
    maxLimit: options.maxLimit ?? DEFAULT_MAX_LIMIT,
    mutations: options.mutations ?? {},
  };

  // Developer-facing config validation (plain errors, fail fast at startup).
  assertIdent(config.table, 'table');
  assertIdent(config.idColumn, 'idColumn');
  if (config.parentKey) assertIdent(config.parentKey, 'parentKey');
  for (const column of Object.values(config.columns)) assertIdent(column, 'column');
  for (const [key, spec] of Object.entries(config.filters)) {
    if (spec.column) assertIdent(spec.column, `filters.${key}.column`);
  }

  const adapter: DataAdapter = {
    entity: config.entity,

    async resolve(filters: Filters, ctx: OrbitContext): Promise<unknown> {
      const plan = planFilters(filters, ctx, config);
      if (plan.hasCursor) throw cursorUnsupported();

      const params = [...plan.values];
      const where = plan.predicates.map((predicate, index) => {
        return `${quoteIdent(predicate.column)} ${OPERATOR_SQL[predicate.operator]} $${index + 1}`;
      });

      let limitSql = '';
      const limit = readLimit(filters.limit, config.maxLimit);
      if (limit !== undefined) {
        limitSql = ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }

      const sql = `SELECT * FROM ${quoteIdent(config.table)}${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      }${limitSql}`;

      const result = await config.client.query(sql, params);
      const rows = result.rows.map((row) => remapRow(row, config.columns, config.idColumn));

      if (plan.single) return rows[0] ?? null;
      return rows;
    },

    async batch(requests: BatchRequest[], ctx: OrbitContext): Promise<unknown[]> {
      const plans = requests.map((request) =>
        planFilters(request.filters, { ...ctx, parent: request.parent }, config),
      );

      // IN-clause batching only holds for equality predicates without
      // limit/cursor; anything else falls back to per-request resolves (still
      // correct, just N round-trips for that level).
      const batchable = plans.every(
        (plan) =>
          !plan.hasLimit &&
          !plan.hasCursor &&
          plan.predicates.every((predicate) => predicate.operator === 'eq'),
      );
      if (!batchable) {
        return Promise.all(
          requests.map((request) =>
            adapter.resolve(request.filters, { ...ctx, parent: request.parent }),
          ),
        );
      }

      // Group by predicate-column shape (operator is always `eq` here).
      const groups = new Map<string, number[]>();
      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i]!;
        const shape = plan.predicates.map((predicate) => predicate.column).join('\u0000');
        const indexes = groups.get(shape) ?? [];
        indexes.push(i);
        groups.set(shape, indexes);
      }

      const results: unknown[] = new Array<unknown>(plans.length);
      for (const indexes of groups.values()) {
        const first = plans[indexes[0]!]!;
        const columns = first.predicates.map((predicate) => predicate.column);
        const params: unknown[] = [];

        const inClauses = columns.map((column) => {
          const start = params.length;
          for (const i of indexes) {
            const plan = plans[i]!;
            const valueIndex = plan.predicates.findIndex(
              (predicate) => predicate.column === column,
            );
            params.push(plan.values[valueIndex]);
          }
          const placeholders = Array.from(
            { length: indexes.length },
            (_, offset) => `$${start + offset + 1}`,
          ).join(', ');
          return `${quoteIdent(column)} IN (${placeholders})`;
        });

        const sql = `SELECT * FROM ${quoteIdent(config.table)} WHERE ${inClauses.join(' AND ')}`;
        const { rows } = await config.client.query(sql, params);

        const buckets = new Map<string, PostgresRow[]>();
        for (const row of rows) {
          const key = columns.map((column) => String(row[column])).join('\u0000');
          const bucket = buckets.get(key) ?? [];
          bucket.push(row);
          buckets.set(key, bucket);
        }

        for (const i of indexes) {
          const plan = plans[i]!;
          const key = plan.values.map((value) => String(value)).join('\u0000');
          const matched = (buckets.get(key) ?? []).map((row) =>
            remapRow(row, config.columns, config.idColumn),
          );
          results[i] = plan.single ? (matched[0] ?? null) : matched;
        }
      }

      return results;
    },

    async mutate(action: string, args: MutationArgs, _ctx: OrbitContext): Promise<MutationResult> {
      const verb = config.mutations[action] ?? DEFAULT_VERBS[action];
      if (!verb) {
        throw mutationFailed(`Unknown mutation '${action}'`, { action });
      }

      const filter = args.filter ?? {};
      const payload = args.payload ?? {};

      if (verb === 'create') {
        const entries = Object.entries(payload);
        if (entries.length === 0) throw mutationFailed('create requires a payload');

        const columns = entries.map(([key]) => payloadColumn(key, config.columns));
        const values = entries.map(([, value]) => value);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        const sql = `INSERT INTO ${quoteIdent(config.table)} (${columns
          .map(quoteIdent)
          .join(', ')}) VALUES (${placeholders}) RETURNING *`;

        const { rows } = await config.client.query(sql, values);
        return { id: toId(rows[0]?.[config.idColumn]), invalidates: [config.entity] };
      }

      if (verb === 'update') {
        const id = filter.id;
        if (id === undefined) throw mutationFailed('update requires filter.id');

        const entries = Object.entries(payload).filter(([key]) => key !== 'id');
        if (entries.length === 0) throw mutationFailed('update requires a payload');

        const sets = entries.map(([key], index) => {
          return `${quoteIdent(payloadColumn(key, config.columns))} = $${index + 1}`;
        });
        const values = [...entries.map(([, value]) => value), id];
        const sql = `UPDATE ${quoteIdent(config.table)} SET ${sets.join(', ')} WHERE ${quoteIdent(
          config.idColumn,
        )} = $${values.length} RETURNING *`;

        await config.client.query(sql, values);
        return { id: toId(id), invalidates: [config.entity] };
      }

      // delete
      const id = filter.id;
      if (id === undefined) throw mutationFailed('delete requires filter.id');
      const sql = `DELETE FROM ${quoteIdent(config.table)} WHERE ${quoteIdent(
        config.idColumn,
      )} = $1 RETURNING ${quoteIdent(config.idColumn)} AS "id"`;

      const { rows } = await config.client.query(sql, [id]);
      return { id: toId(rows[0]?.id ?? id), invalidates: [config.entity] };
    },
  };

  return adapter;
}
