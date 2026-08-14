/**
 * @orbit/mongo — a MongoDB `DataAdapter` for @orbit/core.
 *
 * Translates Orbit's verbatim string filters into MongoDB **match
 * documents** (`{ field: value }`, `{ field: { $gt: value } }`, …) over an
 * injected `mongodb` client. Field names are validated against a strict
 * charset — a key can never start with `$` or contain `.` — so a malicious
 * filter or payload key cannot smuggle operator syntax into a query
 * document, and payload values are walked recursively so a value that is an
 * object can never be interpreted as an operator either (MongoDB's
 * equivalent of SQL parameterization).
 *
 * ```ts
 * import { createOrbit } from '@orbit/core';
 * import { MongoClient, ObjectId } from 'mongodb';
 * import { createMongoAdapter } from '@orbit/mongo';
 *
 * const client = new MongoClient(process.env.MONGODB_URI!);
 * await client.connect();
 * const db = client.db('app');
 *
 * const orbit = createOrbit({
 *   adapters: [
 *     createMongoAdapter({
 *       entity: 'user',
 *       client: db,
 *       collection: 'users',
 *       columns: { name: 'full_name' }, // OQS field/filter/payload → document field
 *       // Stored ids are ObjectIds — convert at the adapter boundary.
 *       toId: (id) => new ObjectId(id),
 *       fromId: (id) => (id instanceof ObjectId ? id.toHexString() : String(id)),
 *     }),
 *   ],
 * });
 * ```
 *
 * Behavior notes:
 * - An `id` filter resolves to a single record (`null` when missing); any
 *   other filter set resolves to an array. The `id` filter maps to the
 *   configured `idField` (`_id` by default) and its value passes through
 *   `toId` (default: identity — the driver itself coerces a 24-hex string
 *   for `_id`).
 * - `limit` is validated (integer, 1..maxLimit) and emitted as a `find`
 *   option; `cursor` is not supported by default and throws
 *   `ORBIT_FILTER_INVALID`.
 * - `batch` groups sibling requests that share a filter shape into one
 *   `{ field: { $in: [...] } }` query (the N+1 fix) and regroups rows by
 *   request.
 * - Read results alias the stored id under `id` (via `fromId`) and re-key
 *   mapped columns, so the core's field projection finds your OQS names.
 *   The `id` alias always reflects the primary key — a document field named
 *   `id` is overridden (MongoDB's primary key is `_id`, any other `id` is
 *   business data; keep business ids under a different name).
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

/** A stored document — `_id` is the MongoDB primary key (or the configured `idField`). */
export type MongoDocument = Record<string, unknown>;

/** The result of a `find().toArray()` call. */
export interface MongoFindResult {
  toArray(): Promise<MongoDocument[]>;
}

/**
 * The minimal collection surface the adapter needs. The `mongodb` driver's
 * `Collection` satisfies it out of the box; inject any object with these
 * four methods.
 */
export interface MongoCollection {
  find(filter: Record<string, unknown>, options?: { limit?: number }): MongoFindResult;
  insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount?: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
}

/**
 * The minimal database surface the adapter needs. The `mongodb` driver's
 * `Db` satisfies it out of the box (`db.collection('users')`).
 */
export interface MongoDbLike {
  collection(name: string): MongoCollection;
}

/** Operators available for filter translation. */
export type MongoFilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'regex';

/** Per-filter-key translation rules. */
export interface MongoFilterSpec {
  /** Document field for this filter key. Defaults to `columns[key] ?? key`. */
  field?: string;
  /** Comparison operator. Defaults to `eq`. */
  operator?: MongoFilterOperator;
}

/** The three built-in mutation verbs (custom actions alias to one of these). */
export type MongoMutationVerb = 'create' | 'update' | 'delete';

export interface MongoAdapterOptions {
  /** Entity name this adapter serves — must match query roots and relations. */
  entity: string;
  /** A connected `mongodb`-compatible client (see {@link MongoDbLike}). */
  client: MongoDbLike;
  /** Collection name. Defaults to `entity`. */
  collection?: string;
  /** Primary-key field. Defaults to `_id`. */
  idField?: string;
  /**
   * OQS name → document field, used for filters, mutation payloads and
   * result aliasing. When omitted, names are assumed to match the fields
   * (identity). Documents are returned whole; the core projects requested
   * fields server-side, so unrequested fields never reach the wire.
   */
  columns?: Record<string, string>;
  /** Per-filter-key field/operator overrides (equality by default). */
  filters?: Record<string, MongoFilterSpec>;
  /**
   * When resolving a relation under a parent record, scope with
   * `{ <parentKey>: parent.id }`. For example, `posts` under `user` with
   * `parentKey: 'author_id'`.
   */
  parentKey?: string;
  /** Upper bound for the reserved `limit` filter. Defaults to 1000. */
  maxLimit?: number;
  /** Custom action name → built-in verb, e.g. `{ archive: 'update' }`. */
  mutations?: Record<string, MongoMutationVerb>;
  /**
   * Convert a client-facing id (`filter.id`, a payload `id`, or a parent
   * record's `id`) into the stored id value. Defaults to identity — with
   * string-stored ids nothing is needed, and the driver itself coerces a
   * 24-hex string for `_id`. Pass `(id) => new ObjectId(id)` when ids are
   * ObjectIds. Must be the inverse of `fromId`.
   */
  toId?: (id: string | number) => unknown;
  /**
   * Convert a stored id back into a client-facing id (used for the `id`
   * result alias and mutation results). Defaults to identity for
   * strings/numbers and `String(value)` for anything else (an ObjectId
   * becomes its hex string). Must be the inverse of `toId`.
   */
  fromId?: (stored: unknown) => string | number | undefined;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_VERBS: Record<string, MongoMutationVerb> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
};

const DEFAULT_MAX_LIMIT = 1000;

/** Fail fast on a config typo — a developer error, not a client error. */
function assertField(name: string, what: string): void {
  if (name === '_id' && what === 'idField') return;
  if (!FIELD.test(name)) {
    throw new Error(`@orbit/mongo: invalid ${what} ${JSON.stringify(name)}`);
  }
}

/** Filter-field validation is client-triggered, so it is a protocol error. */
function assertFilterField(field: string, key: string): void {
  if (!FIELD.test(field)) {
    throw new OrbitError(ErrorCode.FILTER_INVALID, `Invalid filter field for '${key}'`, {
      details: { filter: key },
    });
  }
}

function filterInvalid(message: string, details?: Record<string, unknown>): OrbitError {
  return new OrbitError(ErrorCode.FILTER_INVALID, message, { details });
}

function mutationFailed(message: string, details?: Record<string, unknown>): OrbitError {
  return new OrbitError(ErrorCode.MUTATION_FAILED, message, { details });
}

/** Coerce an unknown stored id into a client-facing `MutationResult.id`. */
function defaultFromId(stored: unknown): string | number | undefined {
  if (typeof stored === 'string' || typeof stored === 'number') return stored;
  if (stored === null || stored === undefined) return undefined;
  return String(stored);
}

function parentIdOf(parent: OrbitContext['parent']): string | number | undefined {
  const id = isRecord(parent?.data) ? parent.data.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

interface Predicate {
  field: string;
  operator: MongoFilterOperator;
}

interface Plan {
  predicates: Predicate[];
  /** Values aligned with `predicates`, in order. */
  values: unknown[];
  /** True when the query had an `id` filter (single-record result). */
  single: boolean;
  hasLimit: boolean;
  hasCursor: boolean;
}

interface Config {
  entity: string;
  client: MongoDbLike;
  collection: string;
  idField: string;
  columns: Record<string, string>;
  filters: Record<string, MongoFilterSpec>;
  parentKey?: string;
  maxLimit: number;
  mutations: Record<string, MongoMutationVerb>;
  toId: (id: string | number) => unknown;
  fromId: (stored: unknown) => string | number | undefined;
}

/**
 * Translate a filter set + parent context into an ordered predicate/value
 * plan. Reserved `limit`/`cursor` are surfaced as flags (they are not match
 * predicates); every other key maps to a field and operator.
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

    let field: string;
    let operator: MongoFilterOperator;
    if (key === 'id') {
      field = config.idField;
      operator = 'eq';
      single = true;
    } else {
      const spec = config.filters[key];
      field = spec?.field ?? config.columns[key] ?? key;
      operator = spec?.operator ?? 'eq';
    }

    assertFilterField(field, key);
    predicates.push({ field, operator });
    values.push(key === 'id' ? config.toId(value) : value);
  }

  if (ctx.parent && config.parentKey) {
    const parentId = parentIdOf(ctx.parent);
    if (parentId !== undefined) {
      predicates.push({ field: config.parentKey, operator: 'eq' });
      values.push(config.toId(parentId));
    }
  }

  return { predicates, values, single, hasLimit, hasCursor };
}

/** Build the match document for a plan. Plain values for `eq`, operators for the rest. */
function buildMatch(plan: Plan): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  for (let i = 0; i < plan.predicates.length; i += 1) {
    const predicate = plan.predicates[i]!;
    const value = plan.values[i];
    switch (predicate.operator) {
      case 'eq':
        match[predicate.field] = value;
        break;
      case 'ne':
        match[predicate.field] = { $ne: value };
        break;
      case 'gt':
        match[predicate.field] = { $gt: value };
        break;
      case 'gte':
        match[predicate.field] = { $gte: value };
        break;
      case 'lt':
        match[predicate.field] = { $lt: value };
        break;
      case 'lte':
        match[predicate.field] = { $lte: value };
        break;
      case 'regex': {
        try {
          match[predicate.field] = { $regex: new RegExp(String(value)) };
        } catch {
          throw filterInvalid(`Invalid regex pattern for '${predicate.field}'`, {
            filter: predicate.field,
          });
        }
        break;
      }
    }
  }
  return match;
}

/** Re-key a raw document: OQS aliases for mapped columns, plus `id` for the PK. */
function remapDoc(doc: MongoDocument, config: Config): MongoDocument {
  const out: MongoDocument = { ...doc };
  for (const [field, mapped] of Object.entries(config.columns)) {
    if (mapped in doc) out[field] = doc[mapped];
  }
  if (config.idField in doc) out.id = config.fromId(doc[config.idField]);
  return out;
}

function readLimit(raw: string | undefined, maxLimit: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
    throw filterInvalid(`Invalid 'limit' filter`, { limit: raw, max: maxLimit });
  }
  return parsed;
}

function cursorUnsupported(): OrbitError {
  return filterInvalid("The 'cursor' filter is not supported by @orbit/mongo", {
    filter: 'cursor',
  });
}

/** Map a payload key to its field (identity by default). */
function payloadField(key: string, columns: Record<string, string>): string {
  const field = columns[key] ?? key;
  if (!FIELD.test(field)) {
    throw mutationFailed(`Invalid field for payload key '${key}'`, { key });
  }
  return field;
}

/**
 * Reject values that could be interpreted as query operators once nested in
 * a document: any key starting with `$` or containing `.` anywhere in the
 * payload tree makes the whole mutation fail. This is the Mongo counterpart
 * of SQL parameterization — a client object value can never smuggle
 * operator syntax into a query document.
 */
function assertSafeValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, path);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) {
      throw mutationFailed(`Unsafe document key '${key}' in payload`, {
        key,
        path,
      });
    }
    assertSafeValue(value[key], `${path}.${key}`);
  }
}

/** Build a MongoDB `DataAdapter`. */
export function createMongoAdapter(options: MongoAdapterOptions): DataAdapter {
  const config: Config = {
    entity: options.entity,
    client: options.client,
    collection: options.collection ?? options.entity,
    idField: options.idField ?? '_id',
    columns: options.columns ?? {},
    filters: options.filters ?? {},
    parentKey: options.parentKey,
    maxLimit: options.maxLimit ?? DEFAULT_MAX_LIMIT,
    mutations: options.mutations ?? {},
    toId: options.toId ?? ((id) => id),
    fromId: options.fromId ?? defaultFromId,
  };

  // Developer-facing config validation (plain errors, fail fast at startup).
  assertField(config.collection, 'collection');
  assertField(config.idField, 'idField');
  if (config.parentKey) assertField(config.parentKey, 'parentKey');
  for (const field of Object.values(config.columns)) assertField(field, 'column');
  for (const [key, spec] of Object.entries(config.filters)) {
    if (spec.field) assertField(spec.field, `filters.${key}.field`);
  }

  const adapter: DataAdapter = {
    entity: config.entity,

    async resolve(filters: Filters, ctx: OrbitContext): Promise<unknown> {
      const plan = planFilters(filters, ctx, config);
      if (plan.hasCursor) throw cursorUnsupported();

      const match = buildMatch(plan);
      const limit = readLimit(filters.limit, config.maxLimit);
      const cursor =
        limit === undefined
          ? config.client.collection(config.collection).find(match)
          : config.client.collection(config.collection).find(match, { limit });

      const docs = await cursor.toArray();
      const rows = docs.map((doc) => remapDoc(doc, config));

      if (plan.single) return rows[0] ?? null;
      return rows;
    },

    async batch(requests: BatchRequest[], ctx: OrbitContext): Promise<unknown[]> {
      const plans = requests.map((request) =>
        planFilters(request.filters, { ...ctx, parent: request.parent }, config),
      );

      // `$in` batching only holds for equality predicates without
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

      // Group by predicate-field shape (operator is always `eq` here).
      const groups = new Map<string, number[]>();
      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i]!;
        const shape = plan.predicates.map((predicate) => predicate.field).join('\u0000');
        const indexes = groups.get(shape) ?? [];
        indexes.push(i);
        groups.set(shape, indexes);
      }

      const results: unknown[] = new Array<unknown>(plans.length);
      for (const indexes of groups.values()) {
        const first = plans[indexes[0]!]!;
        const fields = first.predicates.map((predicate) => predicate.field);
        const match: Record<string, unknown> = {};

        for (const field of fields) {
          const list = indexes.map((i) => {
            const plan = plans[i]!;
            const valueIndex = plan.predicates.findIndex((predicate) => predicate.field === field);
            return plan.values[valueIndex];
          });
          match[field] = { $in: list };
        }

        const docs = await config.client.collection(config.collection).find(match).toArray();

        const buckets = new Map<string, MongoDocument[]>();
        for (const doc of docs) {
          const key = fields.map((field) => String(doc[field])).join('\u0000');
          const bucket = buckets.get(key) ?? [];
          bucket.push(doc);
          buckets.set(key, bucket);
        }

        for (const i of indexes) {
          const plan = plans[i]!;
          const key = plan.values.map((value) => String(value)).join('\u0000');
          const matched = (buckets.get(key) ?? []).map((doc) => remapDoc(doc, config));
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
      const collection = config.client.collection(config.collection);

      if (verb === 'create') {
        const entries = Object.entries(payload);
        if (entries.length === 0) throw mutationFailed('create requires a payload');

        const doc: Record<string, unknown> = {};
        for (const [key, value] of entries) {
          if (key === 'id') {
            doc[config.idField] = config.toId(value as string | number);
            continue;
          }
          const field = payloadField(key, config.columns);
          doc[field] = value;
        }
        assertSafeValue(doc, '$');

        const { insertedId } = await collection.insertOne(doc);
        return { id: config.fromId(insertedId), invalidates: [config.entity] };
      }

      if (verb === 'update') {
        const id = filter.id;
        if (id === undefined) throw mutationFailed('update requires filter.id');

        const entries = Object.entries(payload).filter(([key]) => key !== 'id');
        if (entries.length === 0) throw mutationFailed('update requires a payload');

        const set: Record<string, unknown> = {};
        for (const [key, value] of entries) {
          const field = payloadField(key, config.columns);
          set[field] = value;
        }
        assertSafeValue(set, '$set');

        await collection.updateOne({ [config.idField]: config.toId(id) }, { $set: set });
        return { id: config.fromId(config.toId(id)), invalidates: [config.entity] };
      }

      // delete
      const id = filter.id;
      if (id === undefined) throw mutationFailed('delete requires filter.id');

      await collection.deleteOne({ [config.idField]: config.toId(id) });
      return { id: config.fromId(config.toId(id)), invalidates: [config.entity] };
    },
  };

  return adapter;
}
