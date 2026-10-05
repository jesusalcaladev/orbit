import { ErrorCode, OrbitError, isRecord, validateEnvelope } from '@orbit/core';
import type { OrbitEnvelope, OrbitErrorCode, SubscriptionEvent } from '@orbit/core';
import { OrbitNetworkError } from './errors.js';
import type { RealtimeStatus, SocketClient, SocketReply, SocketRequestOptions } from './types.js';

/** Reconnect backoff delays in ms (bounded; the last value repeats). */
const RETRY_DELAYS = [500, 1200, 2500, 5000];
const CONNECT_TIMEOUT_MS = 10_000;

export interface SubscribeOptions {
  /**
   * Names the subscription on the server (echoed in `ack`/events). Defaults
   * to an id unique to this client instance (`sub-<token>-1`, …) — the
   * server's hub is shared across connections, so two clients both defaulting
   * to `sub-1` would collide. Pass an explicit id to control resume ids.
   */
  id?: string;
  /** Called for subscription-control errors (e.g. a denied subscribe). */
  onError?: (error: OrbitError) => void;
  /** Called once the server established the subscription (`ack`/`resumed`). */
  onAck?: (id: string, kind: 'subscribe' | 'resume', seq: number) => void;
  /**
   * Called when the event stream is detected to have a hole (spec §10).
   *
   * Event sequence numbers are dense, so receiving `seq > cursor + 1` proves
   * events were missed — the server's retention window rolled over, or the
   * subscription was re-established from scratch. Orbit applies the patch
   * anyway (it is valid data) but the local state now has a silent hole, so
   * this fires with the missed range and the app should **refetch** the query.
   */
  onGap?: (gap: SubscriptionGap) => void;
}

/**
 * A detected hole in a subscription's event stream: the events with sequence
 * numbers in `(from, to]` were never delivered.
 */
export interface SubscriptionGap {
  /** The last sequence number applied before the hole (the resume cursor). */
  from: number;
  /**
   * The last missed sequence number — one before the event actually received.
   * Omitted when the extent is unknown: a rejected resume means the server
   * dropped an unbounded range (its retention window rolled over), so only the
   * boundary is knowable.
   */
  to?: number;
}

/** A live subscription; the handle the caller holds to control it. */
export interface SubscriptionHandle {
  /** The subscription id (the `id` of `subscribe`/`resume` frames). */
  readonly id: string;
  /** The last applied server `seq` — the resume cursor. */
  readonly seq: number;
  /** Unsubscribe and close the shared socket when no subscriptions remain. */
  close(): void;
  /** Watch the socket state; called immediately with the current state. */
  onStatus(cb: (status: RealtimeStatus) => void): void;
  /** Watch subscription-control errors (e.g. a denied subscribe). */
  onError(cb: (error: OrbitError) => void): void;
  /** Watch the server's subscription confirmation (`ack`/`resumed`). */
  onAck(cb: (id: string, kind: 'subscribe' | 'resume', seq: number) => void): void;
  /**
   * Watch for holes in the event stream. When it fires, refetch the
   * subscription's query — the local state missed one or more events.
   */
  onGap(cb: (gap: SubscriptionGap) => void): void;
}

interface SubEntry {
  query: string;
  seq: number;
  attached: boolean;
  handler: (event: SubscriptionEvent, meta: { seq: number }) => void;
  onErrors: Set<(error: OrbitError) => void>;
  statusCbs: Set<(status: RealtimeStatus) => void>;
  ackCbs: Set<(id: string, kind: 'subscribe' | 'resume', seq: number) => void>;
  gapCbs: Set<(gap: SubscriptionGap) => void>;
}

interface PendingRequest {
  resolve: (reply: SocketReply) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: () => void;
}

/**
 * The multiplexed realtime transport (spec §10): all subscriptions of one
 * client share a single WebSocket. Reconnects automatically with bounded
 * exponential backoff and `resume`s from the last `seq` (the server replays the
 * gap from its retention log).
 *
 * Resume is only ever honoured when the server can prove the replay is
 * complete. If its retention window rolled over, the server rejects the resume
 * (`ORBIT_SUBSCRIPTION_FAILED`) and this client falls back to a fresh
 * subscribe. Either way the local state may be missing events, so a gap is
 * reported through `onGap` (subscribe option or handle) — **refetch the query
 * when it fires.** A gapless stream keeps `seq` dense and never reports one.
 */
export class RealtimeClient {
  readonly #url: string;
  readonly #WebSocket: typeof WebSocket;
  readonly #subs = new Map<string, SubEntry>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #instanceId: string;
  #socket: WebSocket | null = null;
  #connecting = false;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempts = 0;
  #status: RealtimeStatus = 'closed';
  #subSeq = 0;
  #requestSeq = 0;
  #openResolvers = new Set<() => void>();

  constructor(url: string, WebSocketImpl: typeof WebSocket) {
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    // Default subscription ids are shared with the server's hub namespace,
    // which spans ALL connections (retention + resume re-attach by id from
    // any session). A per-instance token keeps two tabs/clients from both
    // defaulting to `sub-1` and colliding server-side.
    this.#instanceId = Math.random().toString(36).slice(2, 10);
  }

  get status(): RealtimeStatus {
    return this.#status;
  }

  /** How many subscriptions are currently attached to the shared socket. */
  get subscriptionCount(): number {
    return this.#subs.size;
  }

  /** Envelope request/response over the shared socket (spec §10). */
  get socket(): SocketClient {
    return {
      request: (envelope, options) => this.request(envelope, options),
    };
  }

  subscribe(
    query: string,
    handler: (event: SubscriptionEvent, meta: { seq: number }) => void,
    options: SubscribeOptions = {},
  ): SubscriptionHandle {
    if (this.#closed) throw new OrbitNetworkError('Client is closed');
    const id = options.id ?? `sub-${this.#instanceId}-${++this.#subSeq}`;
    if (this.#subs.has(id)) {
      throw new OrbitError(ErrorCode.SUBSCRIPTION_FAILED, `A subscription '${id}' already exists`);
    }
    const entry: SubEntry = {
      query,
      seq: 0,
      attached: false,
      handler,
      onErrors: new Set(),
      statusCbs: new Set(),
      ackCbs: new Set(),
      gapCbs: new Set(),
    };
    this.#subs.set(id, entry);
    if (options.onError !== undefined) entry.onErrors.add(options.onError);
    if (options.onAck !== undefined) entry.ackCbs.add(options.onAck);
    if (options.onGap !== undefined) entry.gapCbs.add(options.onGap);

    // Attach as soon as the socket is (re)connected; if it is already open,
    // send the subscribe immediately.
    this.#connect();
    if (this.#isOpen(this.#socket)) {
      this.#sendFrame(this.#socket, this.#initialFrame(id, entry));
    }

    const handle: SubscriptionHandle = {
      get id() {
        return id;
      },
      get seq() {
        return entry.seq;
      },
      close: () => this.#unsubscribe(id),
      onStatus: (cb) => {
        entry.statusCbs.add(cb);
        cb(this.#status);
      },
      onError: (cb) => {
        entry.onErrors.add(cb);
      },
      onAck: (cb) => {
        entry.ackCbs.add(cb);
      },
      onGap: (cb) => {
        entry.gapCbs.add(cb);
      },
    };
    return handle;
  }

  async request(envelope: OrbitEnvelope, options: SocketRequestOptions = {}): Promise<SocketReply> {
    const validated = validateEnvelope(envelope);
    await this.#ensureOpen();
    const socket = this.#socket;
    if (socket === null) throw new OrbitNetworkError('Realtime socket is not connected');
    const id = `req-${++this.#requestSeq}`;
    const { signal, timeoutMs } = options;
    return new Promise<SocketReply>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        /* v8 ignore next — a settle is single-threaded; the guard defends
           against re-entrant resolve/reject (timer + reply racing). */
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const cleanup = () => {
        const entry = this.#pending.get(id);
        if (entry?.cleanup === cleanup) {
          this.#pending.delete(id);
          // Clear the timer BEFORE deleting — a pending timer must not fire
          // after the request settled (it would no-op, but would keep the
          // event loop alive for its duration).
          if (entry.timer !== undefined) clearTimeout(entry.timer);
        }
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        settle(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
      };
      const pending: PendingRequest = {
        resolve: (replyValue) => settle(() => resolve(replyValue)),
        reject: (error) => settle(() => reject(error)),
        timer: undefined,
        cleanup,
      };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          pending.reject(new OrbitNetworkError('Socket request timed out'));
        }, timeoutMs);
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, pending);
      this.#sendFrame(socket, { ...validated, id });
    });
  }

  /** Close every subscription and the socket. Idempotent and terminal. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    for (const id of this.#subs.keys()) this.#unsubscribe(id, false);
    this.#subs.clear();
    this.#rejectPending(new OrbitNetworkError('Socket closed'));
    if (this.#socket !== null) {
      try {
        this.#socket.close();
      } catch {
        // Already closed.
      }
      this.#socket = null;
    }
    this.#setStatus('closed');
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  #connect(): void {
    if (this.#closed || this.#connecting || this.#socket !== null) return;
    this.#connecting = true;
    this.#setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new this.#WebSocket(this.#url);
    } catch {
      this.#connecting = false;
      this.#scheduleReconnect();
      return;
    }
    this.#socket = ws;
    ws.onopen = () => {
      this.#connecting = false;
      this.#attempts = 0;
      this.#setStatus('live');
      const openResolvers = [...this.#openResolvers];
      this.#openResolvers.clear();
      for (const resolver of openResolvers) resolver();
      // (Re)attach every subscription — `resume` after the first attach so
      // missed events replay from the server's retention log.
      for (const [id, entry] of this.#subs) {
        this.#sendFrame(ws, this.#initialFrame(id, entry));
      }
    };
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onclose = () => {
      this.#connecting = false;
      this.#socket = null;
      if (this.#closed) {
        this.#setStatus('closed');
        return;
      }
      // Idle close (the last subscription was removed): nothing to reconnect.
      if (this.#subs.size === 0) {
        this.#setStatus('closed');
        return;
      }
      // A network drop: fail in-flight socket requests, then reconnect.
      this.#rejectPending(new OrbitNetworkError('Socket closed'));
      this.#setStatus('reconnecting');
      this.#scheduleReconnect();
    };
    ws.onerror = () => {
      // The close event always follows; nothing to do here.
    };
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null || this.#connecting) return;
    const delay = RETRY_DELAYS[Math.min(this.#attempts, RETRY_DELAYS.length - 1)];
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  async #ensureOpen(): Promise<void> {
    if (this.#isOpen(this.#socket)) return;
    if (this.#closed) throw new OrbitNetworkError('Client is closed');
    this.#connect();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let resolver: () => void;
      // Both arms below re-check `settled` defensively: the resolver is removed
      // from `#openResolvers` and the timer is cleared on the first settle, so
      // in practice neither can fire twice. The guard makes that an invariant
      // of the code rather than of every caller's bookkeeping, and keeps a
      // late duplicate settle from rejecting an already-resolved promise.
      const timer = setTimeout(() => {
        /* v8 ignore next — see above: the timer is cleared on the first settle */
        if (settled) return;
        settled = true;
        this.#openResolvers.delete(resolver);
        reject(new OrbitNetworkError('Realtime socket did not connect'));
      }, CONNECT_TIMEOUT_MS);
      resolver = () => {
        /* v8 ignore next — see above: removed from the set on the first settle */
        if (settled) return;
        settled = true;
        this.#openResolvers.delete(resolver);
        clearTimeout(timer);
        resolve();
      };
      this.#openResolvers.add(resolver);
    });
  }

  #initialFrame(id: string, entry: SubEntry): Record<string, unknown> {
    if (entry.attached) {
      // The extra `id` is additive: the driver ignores it on resume, but the
      // server echoes it on the `ORBIT_SUBSCRIPTION_FAILED` error frame, so
      // the client can correlate the failure to this subscription and fall
      // back to a fresh subscribe.
      return { resume: id, after: entry.seq, id };
    }
    return { subscribe: entry.query, id };
  }

  #isOpen(ws: WebSocket | null): boolean {
    return ws !== null && ws.readyState === this.#WebSocket.OPEN;
  }

  #sendFrame(ws: WebSocket | null, frame: Record<string, unknown>): void {
    /* v8 ignore next — every call site pre-checks isOpen; kept for safety. */
    if (ws !== null && ws.readyState === this.#WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  #unsubscribe(id: string, send = true): void {
    if (!this.#subs.has(id)) return;
    this.#subs.delete(id);
    const socket = this.#socket;
    if (send && this.#isOpen(socket)) {
      this.#sendFrame(socket, { unsubscribe: id });
    }
    if (this.#subs.size === 0 && socket !== null) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  #setStatus(status: RealtimeStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const entry of this.#subs.values()) {
      for (const cb of entry.statusCbs) cb(status);
    }
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  #onMessage(raw: unknown): void {
    let message: unknown;
    try {
      /* v8 ignore next — the server always sends text frames; kept for
         runtimes that deliver Blob/ArrayBuffer payloads. */
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    // Envelope request/response (spec §10): `{ id, status, data|error, … }`.
    if (typeof message.id === 'string' && typeof message.status === 'number') {
      this.#settleRequest(message);
      return;
    }

    if (isRecord(message.error)) {
      this.#onErrorFrame(message);
      return;
    }

    // An event: `{ id, seq, event }`.
    if (typeof message.id === 'string' && isRecord(message.event)) {
      const entry = this.#subs.get(message.id);
      if (entry === undefined) return;
      if (typeof message.seq === 'number' && message.seq > entry.seq) {
        // Sequence numbers are dense, so a jump means the events in between
        // were never delivered. The patch itself is valid, but applying it
        // over a hole leaves silently stale state — surface the missed range
        // so the app can refetch. (`seq === entry.seq + 1` is the normal,
        // gapless case and stays silent.)
        if (message.seq > entry.seq + 1) {
          const gap: SubscriptionGap = { from: entry.seq, to: message.seq - 1 };
          for (const cb of entry.gapCbs) cb(gap);
        }
        entry.seq = message.seq;
      }
      entry.handler(message.event as unknown as SubscriptionEvent, {
        seq: typeof message.seq === 'number' ? message.seq : entry.seq,
      });
      return;
    }

    if (typeof message.ack === 'string') {
      const entry = this.#subs.get(message.ack);
      if (entry !== undefined) {
        entry.attached = true;
        // A fresh `subscribe` creates a NEW server-side subscriber whose
        // sequence restarts at 1. Keeping the old cursor here would leave it
        // permanently ahead of the server, so the next reconnect would ask to
        // resume from a seq the server never reached — and silently receive
        // nothing, forever. Reset to 0 and let `onGap` flag the discontinuity.
        entry.seq = 0;
        for (const cb of entry.ackCbs) cb(message.ack, 'subscribe', entry.seq);
      }
      return;
    }
    if (typeof message.resumed === 'string') {
      const entry = this.#subs.get(message.resumed);
      if (entry !== undefined) {
        entry.attached = true;
        for (const cb of entry.ackCbs) cb(message.resumed, 'resume', entry.seq);
      }
      return;
    }
    if (typeof message.unsubscribed === 'string') {
      const entry = this.#subs.get(message.unsubscribed);
      if (entry !== undefined) entry.attached = false;
    }
  }

  #settleRequest(message: Record<string, unknown>): void {
    /* v8 ignore start — callers guarantee a string id before dispatching
       (the dispatcher checks `typeof message.id === 'string'` first). */
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id === undefined) return;
    /* v8 ignore stop */
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    const status = typeof message.status === 'number' ? message.status : 500;
    if (message.error !== undefined) {
      pending.reject(errorFromWire(message.error, status));
      return;
    }
    pending.resolve({
      status,
      data: message.data,
      ...(message.fromCache === true ? { fromCache: true } : {}),
      ...(Array.isArray(message.invalidates) ? { invalidates: message.invalidates } : {}),
      ...(typeof message.contentType === 'string' ? { contentType: message.contentType } : {}),
    });
  }

  #onErrorFrame(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : undefined;
    // Envelope-request failures carry the correlation id — settle the pending.
    if (id !== undefined && this.#pending.has(id)) {
      this.#settleRequest(message);
      return;
    }
    if (id === undefined) return;
    const entry = this.#subs.get(id);
    if (entry === undefined) return;
    const error = errorFromWire(message.error, undefined);
    // A failed `resume` (retention expired) is a normal recovery path: fall
    // back to a fresh subscribe on the same socket, silently.
    if (entry.attached && error.code === ErrorCode.SUBSCRIPTION_FAILED) {
      entry.attached = false;
      // The server could not replay the window we asked for, so events were
      // lost for good. Tell the app before re-subscribing: the fresh subscribe
      // restarts the sequence at 1, which would otherwise look perfectly
      // contiguous and hide the hole.
      for (const cb of entry.gapCbs) cb({ from: entry.seq });
      const socket = this.#socket;
      /* v8 ignore next — the error frame arrived on this socket, so it is
         open; the guard defends against a mid-frame close. */
      if (this.#isOpen(socket)) {
        this.#sendFrame(socket, { subscribe: entry.query, id });
      }
      return;
    }
    for (const cb of entry.onErrors) cb(error);
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function errorFromWire(errorField: unknown, status: number | undefined): OrbitError {
  const record = isRecord(errorField) ? errorField : {};
  const { code, message, details } = record;
  return new OrbitError(
    typeof code === 'string' ? (code as OrbitErrorCode) : ErrorCode.INTERNAL,
    typeof message === 'string' ? message : 'Orbit request failed',
    {
      ...(status !== undefined ? { status } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  );
}
