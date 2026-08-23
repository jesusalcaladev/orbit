import { parseCacheSpec, parseOQS } from '@orbit/core';
import type { QueryNode } from '@orbit/core';

/**
 * The vanilla client-side query cache (spec §8).
 *
 * The server's cache plugin echoes `invalidates` after every mutation "so
 * client-side caches can evict too" — this is that cache. It mirrors the
 * server-side semantics at client scale:
 *
 * - Entries are keyed by the exact query string.
 * - A TTL comes from the same spec grammar the server speaks (`'ttl=300'`),
 *   parsed by the core's own `parseCacheSpec`.
 * - Every entry is indexed by **all** entities its query tree touches (root
 *   AND relations), so eviction is entity-precise: a `user.update` evicts
 *   cached `user` queries while `reviews` queries survive.
 * - `invalidate(targets)` accepts entity names (`['user']`) or exact keys
 *   ({@link QueryCache.keyFor}) — exactly what the server's echo carries.
 *
 * Transport-free by design: it stores what the network returned and never
 * fetches. `OrbitClient` wires it in when constructed with a `cache` option.
 */
export class QueryCache {
  /** Derive the exact key for a query string (the identity used on the wire). */
  static keyFor(query: string): string {
    return query;
  }

  readonly #entries = new Map<string, { data: unknown; expiresAt: number; entities: string[] }>();
  readonly #maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 200;
  }

  /** The cached data for a query, or `undefined` on a miss (or expired entry). */
  get(query: string): { data: unknown } | undefined {
    const entry = this.#entries.get(QueryCache.keyFor(query));
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(QueryCache.keyFor(query));
      return undefined;
    }
    // LRU touch: re-insert so Map iteration order tracks recency.
    this.#entries.delete(QueryCache.keyFor(query));
    this.#entries.set(QueryCache.keyFor(query), entry);
    return { data: entry.data };
  }

  /**
   * Store a successful query result. `spec` is the request's cache spec
   * (`'ttl=300'`); entries without a TTL never expire client-side but still
   * participate in invalidation.
   */
  set(query: string, response: { data: unknown }, spec?: string): void {
    const entities = entitiesOf(query);
    // A query that cannot be parsed has no entity index — it could never be
    // evicted precisely, so never store it (execute() rejects these first).
    if (entities.length === 0) return;
    const key = QueryCache.keyFor(query);
    const ttlSeconds = spec !== undefined ? safeTtl(spec) : undefined;
    this.#entries.set(key, {
      data: response.data,
      expiresAt:
        ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER,
      entities,
    });
    // LRU cap: drop the least-recently-used entry (Map order = recency).
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      /* v8 ignore next 3 — size > 0 guarantees a first key. */
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /**
   * Evict entries touched by the given targets — entity names or exact keys,
   * in any mix (this is the shape of the server's `invalidates` echo).
   */
  invalidate(targets: string[]): void {
    for (const target of targets) {
      if (typeof target !== 'string' || target === '') continue;
      // Exact key match first…
      if (this.#entries.delete(target)) continue;
      // …then entity match: every query whose tree touches this entity.
      for (const [key, entry] of this.#entries) {
        if (entry.entities.includes(target)) this.#entries.delete(key);
      }
    }
  }

  /** Evict everything. */
  clear(): void {
    this.#entries.clear();
  }

  /** How many entries are currently held. */
  get size(): number {
    return this.#entries.size;
  }
}

/** Parse a cache spec into a positive TTL in seconds (undefined otherwise). */
function safeTtl(spec: string): number | undefined {
  try {
    const parsed = parseCacheSpec(spec);
    return parsed.ttl !== undefined && parsed.ttl > 0 ? parsed.ttl : undefined;
  } catch {
    return undefined; // an unparseable spec simply never caches by time
  }
}

/** Every entity the query tree touches — root first, then each relation. Empty when unparseable. */
function entitiesOf(query: string): string[] {
  const out: string[] = [];
  let root: QueryNode;
  try {
    root = parseOQS(query);
  } catch {
    return out;
  }
  const walk = (node: QueryNode): void => {
    if (!out.includes(node.entity)) out.push(node.entity);
    for (const relation of Object.values(node.relations)) walk(relation);
  };
  walk(root);
  return out;
}
