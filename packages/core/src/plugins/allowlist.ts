import { ErrorCode, OrbitError } from '../errors.js';
import type { OrbitContext, OrbitEnvelope } from '../types.js';
import { fnv1a64 } from '../utils.js';
import type { OrbitPlugin } from './types.js';

export interface QueryAllowlistOptions {
  /**
   * The queries this server is willing to execute — the production
   * counterpart to the OQS string the client sends.
   *
   * Two matching modes, both derived from this one list:
   *
   * - **exact** — the raw query text must be one of these strings (after
   *   whitespace-insensitive canonicalisation is NOT applied: the comparison
   *   is literal, so a client cannot smuggle a different query that merely
   *   looks similar).
   * - **digest** — the query's `fnv1a64` digest must be in the set, so the
   *   client may ship a *persisted query* (a query id it stores locally) and
   *   the server still recognises it without the allowlist leaking query text.
   *
   * Mutations (`do`/`ops`) are never matched and never run through this
   * plugin — an allowlist of read queries cannot express "and only these
   * writes", so writes are governed by the auth plugin instead. Set
   * `includeMutations` to opt writes in as well.
   */
  queries: readonly string[];
  /**
   * Allow mutation envelopes (`do` / `ops`) whose action matches one of
   * `mutations` (e.g. `'user.create'`). Default `false`: this plugin governs
   * read queries only, and a query allowlist silently authorizing writes would
   * be a footgun.
   */
  mutations?: readonly string[];
  /**
   * Enforce the allowlist instead of only recording misses. Default `true` —
   * a miss throws `ORBIT_PERMISSION_DENIED`. Set `false` to run in audit mode
   * (log/observe what a stricter policy *would* have rejected) by pairing it
   * with `onMiss`.
   */
  enforce?: boolean;
  /**
   * Called for every query that is not allowlisted, before the decision is
   * applied. Observability hook: ship the offending query to your logs, count
   * it, or alert. Called in both enforce and audit mode.
   */
  onMiss?: (query: string, digest: string) => void;
}

/** The query allowlist plugin's own options type (matches the plugin factory). */
export type QueryAllowlistPluginOptions = QueryAllowlistOptions;

/**
 * Restrict execution to a known set of queries (spec §12 — production
 * hardening).
 *
 * Orbit is intent-first: the server parses whatever OQS the client sends, so a
 * production deployment needs a way to say *these* queries and no others. This
 * plugin is that switch. It runs at `onBeforeParse` — the earliest point at
 * which the raw query string is known — so an unknown query never reaches the
 * parser, the adapters, or the database.
 *
 * ```ts
 * const orbit = createOrbit({
 *   adapters: [userAdapter],
 *   plugins: [
 *     createQueryAllowlistPlugin({
 *       queries: ['user(id="1") { name, posts { title } }'],
 *     }),
 *   ],
 * });
 * ```
 *
 * A miss throws `ORBIT_PERMISSION_DENIED` (403) with the query's digest in
 * `details` — never the query text, which may embed caller-supplied values.
 * Run with `enforce: false` + `onMiss` first to see what a stricter policy
 * would reject before turning it on.
 *
 * Additive (spec §12): an optional plugin over the existing hook surface — no
 * envelope field, error code or core behaviour changed. 🧪 Experimental.
 */
export function createQueryAllowlistPlugin(options: QueryAllowlistOptions): OrbitPlugin {
  const exact = new Set<string>();
  const digests = new Set<string>();
  for (const query of options.queries) {
    exact.add(query);
    digests.add(fnv1a64(query));
  }
  const mutations = new Set(options.mutations ?? []);
  const enforce = options.enforce !== false;

  const governMutations = options.mutations !== undefined;

  /**
   * Subjects already reported for the request in flight.
   *
   * A batch is checked twice by design: `onBeforeResolve` pre-flights every op
   * before the first one runs, and `onBeforeParse` then sees each op as it
   * executes. In enforce mode the pre-flight throws first, so the second check
   * never happens — but in AUDIT mode both run to completion and a rejected
   * action would be reported twice, inflating the counts a rollout is measuring.
   * The set is per-request scratch (`ctx.state`), never shared across requests.
   *
   * The key is namespaced and reserved-looking so it cannot collide with a
   * caller's own `ctx.state` slot (it is a string, not a symbol, so it also
   * survives the `Record<string, unknown>` type without a cast).
   */
  const REPORTED = 'orbit.allowlist.reported';

  const reported = (ctx: OrbitContext): Set<string> => {
    const state = (ctx.state ??= {});
    const existing = state[REPORTED];
    if (existing instanceof Set) return existing;
    const fresh = new Set<string>();
    state[REPORTED] = fresh;
    return fresh;
  };

  /** Report a miss once per request, whichever stage observes it first. */
  const reportMiss = (ctx: OrbitContext, subject: string, digest: string): void => {
    if (options.onMiss === undefined) return;
    if (reported(ctx).has(subject)) return;
    reported(ctx).add(subject);
    options.onMiss(subject, digest);
  };

  /** Every action this envelope declares (`do` plus every op in `ops`). */
  const actionsOf = (envelope: OrbitEnvelope | undefined): Set<string> => {
    const actions = new Set<string>();
    if (envelope === undefined) return actions;
    if (typeof envelope.do === 'string') actions.add(envelope.do);
    for (const op of envelope.ops ?? []) {
      if (typeof op?.do === 'string') actions.add(op.do);
    }
    return actions;
  };

  const deny = (
    ctx: OrbitContext,
    subject: string,
    digest: string,
    allowed: number,
    isAction: boolean,
  ): never => {
    reportMiss(ctx, subject, digest);
    throw new OrbitError(
      ErrorCode.PERMISSION_DENIED,
      isAction
        ? "Action is not in this server's allowlist"
        : "Query is not in this server's allowlist",
      // The digest, not the text: the rejected query can contain values the
      // caller controls, and an error body travels to the client and to logs.
      { details: { digest, allowed } },
    );
  };

  /** Validate a query string against the read allowlist. */
  const allowQuery = (ctx: OrbitContext, query: string): void => {
    const digest = fnv1a64(query);
    if (exact.has(query) || digests.has(digest)) return;
    if (!enforce) {
      reportMiss(ctx, query, digest);
      return;
    }
    deny(ctx, query, digest, exact.size + digests.size, false);
  };

  return {
    name: 'query-allowlist',
    hooks: {
      /**
       * The single gate, at the earliest point where the raw string is known.
       * A rejected query costs one hash and never allocates a tree, an adapter
       * call or a database round-trip.
       *
       * Mutations pass through here too — the engine runs `onBeforeParse` for
       * them with the ACTION as `query` (spec §11), and each op of an `ops`
       * batch runs the hook again. That makes this hook the natural place to
       * gate writes too, so there is a single decision point rather than two
       * that can drift.
       */
      /**
       * Pre-flight the WHOLE batch before any op runs.
       *
       * `ops` executes sequentially and fail-fast, so gating each action at
       * `onBeforeParse` would let op 1 commit and then reject op 2 — a
       * partially applied batch the caller believes was refused. Every action
       * is therefore checked up front, from `onBeforeResolve`, which the engine
       * reaches once for the envelope before the first op executes.
       */
      onBeforeResolve: !governMutations
        ? undefined
        : ({ ctx }) => {
            for (const action of actionsOf(ctx.envelope)) {
              if (mutations.has(action)) continue;
              const digest = fnv1a64(action);
              if (!enforce) {
                reportMiss(ctx, action, digest);
                continue;
              }
              deny(ctx, action, digest, mutations.size, true);
            }
          },

      onBeforeParse: ({ query, ctx }) => {
        // An action is exactly one of the envelope's declared actions. A
        // mutation's `return` re-query is a genuine read even inside a mutation
        // envelope, so it must fall through to the READ allowlist — not be
        // mistaken for an action, nor bypass the read policy.
        if (actionsOf(ctx.envelope).has(query)) {
          // Writes are not this plugin's business unless `mutations` was
          // configured — mounting it to restrict reads must never start
          // rejecting writes.
          if (!governMutations) return;
          if (mutations.has(query)) return;
          const digest = fnv1a64(query);
          if (!enforce) {
            reportMiss(ctx, query, digest);
            return;
          }
          deny(ctx, query, digest, mutations.size, true);
        }
        allowQuery(ctx, query);
      },
    },
  };
}
