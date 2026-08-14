/**
 * Runtime-agnostic realtime session driver (spec §10): the frame-level
 * protocol — subscribe/ack, unsubscribe, resume replay, and the `{ query }` /
 * `{ do }` envelope request/response — driven by a plain `send` callback.
 *
 * The Node transport (`realtime/server.ts`) and the Cloudflare Workers
 * transport (`@orbit/cloudflare-workers`) both delegate here, so the frozen
 * frame contract lives in ONE place and cannot drift between runtimes.
 * Transport concerns stay out: frame encoding, socket APIs, retention
 * windows and heartbeats are the transports' jobs.
 *
 * ```jsonc
 * // client →                       // server →
 * { "subscribe": "user { name }", "id": "sub-1" }   → { "ack": "sub-1" }
 * { "unsubscribe": "sub-1" }                        → { "unsubscribed": "sub-1" }
 * { "resume": "sub-1", "after": 42 }                → { "resumed": "sub-1", "after": 42 }
 * { "query": "user { name }", "id": "req-1" }       → { "id": "req-1", "status": 200, "data": … }
 * { "do": "user.update", …, "id": "req-2" }         → { "id": "req-2", "status": 200, "data": … }
 * ```
 */
import { validateEnvelope } from '../envelope.js';
import { ErrorCode, OrbitError, toOrbitError } from '../errors.js';
import type { Orbit } from '../engine.js';
import type { OrbitContext, SubscriptionEvent } from '../types.js';
import { isRecord } from '../utils.js';
import type { SubscriptionHub } from './hub.js';

/** Deliver one reply frame; each transport encodes it (JSON/msgpack frames). */
export type SessionSend = (message: Record<string, unknown>) => void;

/** Transport hooks the driver calls as subscriptions attach. */
export interface SessionDriverHooks {
  /**
   * The session's auth context (spec §10): the object returned by the
   * transport's `authorize` gate. Merged into every `{ query }`/`{ do }`
   * envelope execution (so `ctx.state.caller` reaches `mutate` and the auth
   * pipeline) and passed to the subscription gates. Defaults to `{}`.
   */
  ctx?: OrbitContext;
  /**
   * Called after a client subscription is (re)attached — a retention-aware
   * transport (Node) cancels the pending release timer here.
   */
  onAttach?(clientId: string): void;
}

/** The shared session surface both transports drive. */
export interface RealtimeSessionDriver {
  /**
   * Handle one decoded client message. Control-frame rejections THROW (the
   * transport sends the `{ error }` frame); envelope executions never throw —
   * their replies carry `{ id, status, data|error }`.
   */
  dispatch(message: unknown): Promise<void>;
  /** Ids of the subscriptions this connection asked for. */
  activeIds(): string[];
  /** Unsubscribe every tracked subscription immediately (socket closed). */
  releaseAll(): void;
  /** Drop tracking without unsubscribing (a retention window takes over). */
  clear(): void;
}

/**
 * Build a session driver over a hub.
 *
 * The driver owns the per-connection subscription bookkeeping (so a client
 * can subscribe/unsubscribe/resume on one socket) while the hub owns the
 * shared adapter hooks and the resume logs. `send` is called for every reply
 * frame; `hooks.onAttach` lets a retention-aware transport cancel its pending
 * release timer when a subscription is re-attached before expiry.
 */
export function createSessionDriver(
  orbit: Orbit,
  hub: SubscriptionHub,
  send: SessionSend,
  hooks: SessionDriverHooks = {},
): RealtimeSessionDriver {
  const clientSubs = new Map<
    string,
    { onEvent: (seq: number, event: SubscriptionEvent) => void }
  >();

  /**
   * Execute a `{ query }` / `{ do }` envelope over the socket and reply with
   * the same payload the HTTP handler serves — `{ id?, status, data,
   * fromCache?, invalidates? }`, or `{ id?, status, error }` on failure.
   * The envelope is validated and executed exactly like HTTP: `query` XOR
   * `do`, `args`/`return`/`cache` semantics, depth limits, and the FULL
   * plugin pipeline (auth gates, caching, error translation) all apply.
   * The correlation `id` rides OUTSIDE the frozen envelope (spec §3 drops
   * unknown fields) and is echoed verbatim on success AND failure.
   */
  async function executeEnvelope(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : undefined;
    try {
      // validateEnvelope is the exact validator the HTTP path uses: it
      // rejects bad shapes, strips unknown fields (including the correlation
      // `id`), and enforces the `query` XOR `do` rule — identical semantics,
      // one source of truth. Validation failures carry the `id` too.
      const envelope = validateEnvelope(message);
      // The session's auth context (from `authorize`) rides into the engine,
      // so socket envelopes hit the same identity-stamped pipeline as HTTP.
      const result = await orbit.execute(envelope, { ...(hooks.ctx ?? {}) });
      send({
        ...(id !== undefined ? { id } : {}),
        status: result.status,
        // Plugin-serialized string payloads ride as `data` (with their
        // `contentType`, so the client knows the format); binary payloads
        // and SSE streaming stay HTTP-only — they cannot round-trip a JSON
        // frame faithfully, so `data` is null for them.
        data:
          result.body !== undefined && typeof result.body === 'string'
            ? result.body
            : (result.data ?? null),
        ...(result.body !== undefined && typeof result.body === 'string'
          ? { contentType: result.contentType }
          : {}),
        ...(result.fromCache ? { fromCache: true } : {}),
        ...(result.invalidates ? { invalidates: result.invalidates } : {}),
      });
    } catch (error) {
      const orbitError = toOrbitError(error);
      send({
        ...(id !== undefined ? { id } : {}),
        status: orbitError.status,
        error: orbitError.toJSON().error,
      });
    }
  }

  return {
    async dispatch(message: unknown): Promise<void> {
      if (!isRecord(message)) {
        throw new OrbitError(ErrorCode.INVALID_QUERY, 'Realtime message must be a JSON object');
      }

      // Envelope request/response: a frame carrying `query` or `do` (even an
      // invalid-typed one — let the envelope validator say so) is executed
      // through the full engine pipeline, and the reply mirrors the HTTP JSON
      // payload (spec §10 request/response).
      if ('query' in message || 'do' in message) {
        await executeEnvelope(message);
        return;
      }

      if (typeof message.subscribe === 'string') {
        const clientId = message.id;
        if (typeof clientId !== 'string' || clientId.length === 0) {
          throw new OrbitError(ErrorCode.INVALID_QUERY, "'id' is required for subscribe");
        }
        if (clientSubs.has(clientId)) {
          throw new OrbitError(
            ErrorCode.SUBSCRIPTION_FAILED,
            `A subscription '${clientId}' already exists`,
          );
        }
        const onEvent = (seq: number, event: SubscriptionEvent) =>
          send({ id: clientId, seq, event });
        // Subscription gates run the query pipeline with the session ctx:
        // auth plugins that deny a query throw here, rejecting the
        // subscription (e.g. ORBIT_PERMISSION_DENIED) before any adapter
        // hook is registered (spec §10).
        await hub.authorizedSubscribe(message.subscribe, clientId, onEvent, hooks.ctx ?? {});
        clientSubs.set(clientId, { onEvent });
        hooks.onAttach?.(clientId);
        send({ ack: clientId });
        return;
      }

      if (typeof message.unsubscribe === 'string') {
        const clientId = message.unsubscribe;
        if (clientSubs.delete(clientId)) hub.unsubscribe(clientId);
        send({ unsubscribed: clientId });
        return;
      }

      if (typeof message.resume === 'string') {
        const clientId = message.resume;
        const after =
          typeof message.after === 'number' && Number.isFinite(message.after) ? message.after : 0;
        const entry = clientSubs.get(clientId);
        if (entry) {
          // Same live session — just replay the gap (seq > after).
          hub.resume(clientId, after, entry.onEvent);
          send({ resumed: clientId, after });
          return;
        }
        // Reconnect: re-attach a retained subscription and replay the gap.
        const onEvent = (seq: number, event: SubscriptionEvent) =>
          send({ id: clientId, seq, event });
        const sub = hub.resume(clientId, after, onEvent);
        if (!sub) {
          throw new OrbitError(
            ErrorCode.SUBSCRIPTION_FAILED,
            `Unknown or expired subscription '${clientId}' — re-subscribe to start over`,
          );
        }
        clientSubs.set(clientId, { onEvent });
        hooks.onAttach?.(clientId);
        send({ resumed: clientId, after });
        return;
      }

      throw new OrbitError(
        ErrorCode.INVALID_QUERY,
        "Message must contain 'subscribe', 'unsubscribe', 'resume', 'query' or 'do'",
      );
    },

    activeIds: () => [...clientSubs.keys()],

    releaseAll: () => {
      for (const clientId of clientSubs.keys()) hub.unsubscribe(clientId);
      clientSubs.clear();
    },

    clear: () => {
      clientSubs.clear();
    },
  };
}
