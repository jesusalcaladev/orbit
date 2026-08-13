/**
 * The WebSocket transport for realtime subscriptions (spec §10).
 *
 * A `RealtimeServer` plugs into a `node:http` server via `attach()` and turns
 * an `Upgrade` on its path into an Orbit realtime session. Sessions speak the
 * frozen protocol frames:
 *
 * ```jsonc
 * // client →
 * { "subscribe": "user(id=\"1\") { name }", "id": "sub-1" }
 * { "unsubscribe": "sub-1" }
 * { "resume": "sub-1", "after": 42 }
 * // server →
 * { "ack": "sub-1" }
 * { "id": "sub-1", "seq": 43, "event": { "type": "updated", "id": "1", "patch": { "name": "Ana" } } }
 * { "unsubscribed": "sub-1" }
 * { "error": { "code": "…", "message": "…" } }
 * ```
 *
 * Frames are JSON by default, or MessagePack when `serialize: 'msgpack'`.
 * The transport is Node-specific (`node:http`); the `SubscriptionHub` it uses
 * is runtime-agnostic.
 */
import type { Server, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { validateEnvelope } from '../envelope.js';
import { ErrorCode, OrbitError, toOrbitError } from '../errors.js';
import type { Orbit } from '../engine.js';
import { decodeMsgpack, encodeMsgpack } from '../serialize/msgpack.js';
import { isRecord } from '../utils.js';
import {
  CloseCode,
  FrameDecoder,
  FrameTooLargeError,
  Opcode,
  closeFrame,
  encodeFrame,
  upgradeResponse,
} from './frames.js';
import type { Frame } from './frames.js';
import { SubscriptionHub } from './hub.js';

export interface RealtimeServerOptions {
  /** Upgrade path. Defaults to `/realtime`. */
  path?: string;
  /** Max incoming message size in bytes. Defaults to 1 MiB. */
  maxMessageBytes?: number;
  /** Server ping interval in ms. Defaults to 30_000. */
  heartbeatMs?: number;
  /**
   * How long a subscription survives its socket after a disconnect, giving
   * the client time to reconnect and `resume`. Defaults to 60_000 ms.
   */
  retentionMs?: number;
  /** Message wire format. Defaults to `'json'`. */
  serialize?: 'json' | 'msgpack';
  /** Optional request-time authorization gate (e.g. token validation). */
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Optional allowed Origin header(s) — rejected otherwise. */
  origin?: string | string[];
}

const DEFAULT_PATH = '/realtime';
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RETENTION_MS = 60_000;

/**
 * The most continuation fragments one message may be split into. The byte cap
 * bounds the PAYLOAD, but each fragment is also a Buffer object — without a
 * count cap, a 1-byte-fragment flood would allocate millions of objects long
 * before the byte cap trips (object-count memory DoS).
 */
const MAX_FRAGMENT_COUNT = 1000;

export class RealtimeServer {
  readonly #hub: SubscriptionHub;
  readonly #orbit: Orbit;
  readonly #options: Required<
    Pick<
      RealtimeServerOptions,
      'path' | 'maxMessageBytes' | 'heartbeatMs' | 'serialize' | 'retentionMs'
    >
  >;
  readonly #authorize?: RealtimeServerOptions['authorize'];
  readonly #origins?: Set<string>;
  readonly #sessions = new Set<Session>();

  constructor(orbit: Orbit, options: RealtimeServerOptions = {}) {
    this.#hub = new SubscriptionHub(orbit);
    this.#orbit = orbit;
    this.#options = {
      path: options.path ?? DEFAULT_PATH,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      serialize: options.serialize ?? 'json',
    };
    this.#authorize = options.authorize;
    this.#origins = options.origin === undefined ? undefined : new Set([options.origin].flat());
  }

  /** Access to the underlying hub (monitoring, programmatic fan-out). */
  get hub(): SubscriptionHub {
    return this.#hub;
  }

  /** Number of live WebSocket sessions. */
  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Wire this server to a `node:http` server's Upgrade events. */
  attach(httpServer: Server): void {
    httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  /**
   * Handle an HTTP Upgrade directly (also useful with frameworks that expose
   * their own upgrade event).
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== this.#options.path) {
      // end() flushes the status line before closing — a real HTTP client
      // must always receive the rejection, never a silent RST.
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (
      request.method !== 'GET' ||
      (request.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
      typeof key !== 'string' ||
      version !== '13'
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    if (this.#origins !== undefined) {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !this.#origins.has(origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
    }

    // authorize may THROW synchronously or reject asynchronously — both mean
    // "deny", never a crash (an uncaught throw would take down the process)
    // and never a hanging handshake (an unhandled rejection would leak the
    // socket open). Invoke it inside the promise so both paths funnel into
    // the same rejection handler.
    Promise.resolve()
      .then(() => (this.#authorize ? this.#authorize(request) : true))
      .then(
        (allowed) => {
          if (!allowed) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
          }
          // WebSocket traffic is many small frames — disable Nagle so a burst
          // (fan-out, resume replay) is not held back by delayed-ACK waits.
          (socket as Socket).setNoDelay(true);
          socket.write(upgradeResponse(key));
          const session = new Session(socket, this.#orbit, this.#hub, this.#options);
          this.#sessions.add(session);
          socket.on('data', (chunk) => session.onData(chunk));
          socket.on('close', () => {
            session.dispose();
            this.#sessions.delete(session);
          });
          socket.on('error', () => {
            session.dispose();
            this.#sessions.delete(session);
          });
          if (head.length > 0) session.onData(head);
        },
        () => {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        },
      );
  }

  /**
   * Close every session and release every shared subscription.
   *
   * Sessions are TERMINATED, not just disposed: each one receives a close
   * frame and its socket is ended. Disposing alone would leave the upgraded
   * TCP connections open, so a following `http.Server.close()` would wait on
   * them forever and the process would never exit.
   */
  close(): void {
    for (const session of this.#sessions) session.shutdown();
    this.#sessions.clear();
    this.#hub.close();
  }
}

interface SessionOptions {
  maxMessageBytes: number;
  heartbeatMs: number;
  retentionMs: number;
  serialize: 'json' | 'msgpack';
}

class Session {
  readonly #socket: Duplex;
  readonly #orbit: Orbit;
  readonly #hub: SubscriptionHub;
  readonly #options: SessionOptions;
  readonly #decoder: FrameDecoder;
  readonly #clientSubs = new Map<
    string,
    { sub: { unsubscribe(): void }; onEvent: (seq: number, event: unknown) => void }
  >();
  readonly #heartbeat: NodeJS.Timeout;
  readonly #retention = new Map<string, NodeJS.Timeout>();
  #fragment?: { opcode: number; chunks: Buffer[]; total: number; count: number };
  #lastPong = Date.now();
  #closing = false;

  constructor(socket: Duplex, orbit: Orbit, hub: SubscriptionHub, options: SessionOptions) {
    this.#socket = socket;
    this.#orbit = orbit;
    this.#hub = hub;
    this.#options = options;
    this.#decoder = new FrameDecoder(options.maxMessageBytes);
    this.#heartbeat = setInterval(() => this.#tickHeartbeat(), options.heartbeatMs);
    this.#heartbeat.unref();
  }

  onData(chunk: Buffer): void {
    if (this.#closing) return;
    let frames: Frame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      // A declared length beyond the limit is a 1009; anything else is a 1002.
      const code = error instanceof FrameTooLargeError ? CloseCode.TooBig : CloseCode.ProtocolError;
      this.#terminate(
        code,
        error instanceof FrameTooLargeError ? 'frame too large' : 'invalid frame',
      );
      return;
    }
    for (const frame of frames) this.#onFrame(frame);
  }

  dispose(): void {
    if (this.#closing) return;
    this.#closing = true;
    clearInterval(this.#heartbeat);
    // Detach every subscription and give the client a retention window to
    // reconnect + resume; the shared adapter hook stays alive meanwhile so
    // the event log keeps growing (spec §10 resume / benchmark B6).
    for (const clientId of this.#clientSubs.keys()) this.#scheduleRelease(clientId);
    this.#clientSubs.clear();
  }

  /**
   * Server-initiated shutdown: close frame + dispose + socket end. Used by
   * `RealtimeServer.close()` so the process can exit cleanly.
   */
  shutdown(): void {
    this.#terminate(CloseCode.GoingAway, 'server shutdown');
  }

  #scheduleRelease(clientId: string): void {
    this.#hub.detach(clientId);
    const timer = setTimeout(() => {
      this.#retention.delete(clientId);
      this.#hub.unsubscribe(clientId);
    }, this.#options.retentionMs);
    timer.unref();
    this.#retention.set(clientId, timer);
  }

  #cancelRelease(clientId: string): void {
    const timer = this.#retention.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.#retention.delete(clientId);
    }
  }

  #onFrame(frame: Frame): void {
    if (this.#closing) return;
    switch (frame.opcode) {
      case Opcode.Close: {
        // RFC 6455 §5.5.1: a close frame carries zero or two+ bytes (code +
        // optional reason). A 1-byte payload or a reserved/invalid code is a
        // protocol error, not a graceful shutdown.
        const { payload } = frame;
        if (payload.length === 1) {
          this.#terminate(CloseCode.ProtocolError, 'invalid close frame payload');
          return;
        }
        if (payload.length >= 2) {
          const code = payload.readUInt16BE(0);
          if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
            this.#terminate(CloseCode.ProtocolError, 'invalid close code');
            return;
          }
        }
        // Echo the close, THEN stop the session (send must not be suppressed).
        // destroy() (not end()) after the frame: Node keeps an upgraded socket
        // half-open after end() — its handle stays alive and the process never
        // exits, even when the client has already gone (verified empirically).
        // Frame delivery is best-effort: on a backed-up connection destroy()
        // can drop the queued frame (the client would see 1006) — the accepted
        // trade-off for a guaranteed process exit; end() hangs instead.
        this.#send(closeFrame(CloseCode.Normal));
        this.dispose();
        this.#socket.destroy();
        return;
      }
      case Opcode.Ping:
        this.#send(encodeFrame(Opcode.Pong, frame.payload));
        return;
      case Opcode.Pong:
        this.#lastPong = Date.now();
        return;
      case Opcode.Text:
      case Opcode.Binary:
        if (this.#fragment !== undefined) {
          // RFC 6455 §5.4: while a fragmented message is in progress only
          // continuation frames are legal — a fresh data frame (with or
          // without FIN) is a protocol error. Previously this silently
          // discarded the in-flight message (a correctness + DoS hole).
          this.#terminate(CloseCode.ProtocolError, 'new data frame while message is fragmented');
          return;
        }
        if (!frame.fin) {
          // Start a fragmented message; the running total is bounded as it grows.
          if (frame.payload.length > this.#options.maxMessageBytes) {
            this.#terminate(CloseCode.TooBig, 'message too large');
            return;
          }
          this.#fragment = {
            opcode: frame.opcode,
            chunks: [frame.payload],
            total: frame.payload.length,
            count: 1,
          };
          return;
        }
        this.#handleMessage(frame.opcode, frame.payload);
        return;
      case Opcode.Continuation: {
        if (!this.#fragment) {
          this.#terminate(CloseCode.ProtocolError, 'unexpected continuation frame');
          return;
        }
        if (this.#fragment.count >= MAX_FRAGMENT_COUNT) {
          this.#terminate(CloseCode.TooBig, 'too many fragments');
          return;
        }
        const total = this.#fragment.total + frame.payload.length;
        if (total > this.#options.maxMessageBytes) {
          this.#terminate(CloseCode.TooBig, 'message too large');
          return;
        }
        this.#fragment.chunks.push(frame.payload);
        this.#fragment.total = total;
        this.#fragment.count += 1;
        if (frame.fin) {
          const { opcode, chunks } = this.#fragment;
          this.#fragment = undefined;
          this.#handleMessage(opcode, Buffer.concat(chunks));
        }
        return;
      }
      default:
        this.#terminate(CloseCode.ProtocolError, `unknown opcode ${frame.opcode}`);
    }
  }

  #handleMessage(opcode: number, payload: Buffer): void {
    if (payload.length > this.#options.maxMessageBytes) {
      this.#terminate(CloseCode.TooBig, 'message too large');
      return;
    }
    let message: unknown;
    try {
      message =
        opcode === Opcode.Binary
          ? decodeMsgpack(new Uint8Array(payload))
          : JSON.parse(payload.toString('utf8'));
    } catch {
      this.#send(
        this.#encode({
          error: {
            code: ErrorCode.INVALID_QUERY,
            message: 'Message is not valid JSON/MessagePack',
          },
        }),
      );
      return;
    }
    // #dispatch is async — `{ query }` / `{ do }` envelopes execute on the
    // engine (spec §10 request/response). Subscription-control rejections
    // keep the exact same `{ error }` wire shape as before.
    this.#dispatch(message).catch((error) => {
      const orbitError = toOrbitError(error);
      this.#send(this.#encode({ error: orbitError.toJSON().error }));
    });
  }

  async #dispatch(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      throw new OrbitError(ErrorCode.INVALID_QUERY, 'Realtime message must be a JSON object');
    }

    // Envelope request/response: a frame carrying `query` or `do` (even an
    // invalid-typed one — let the envelope validator say so) is executed
    // through the full engine pipeline, and the reply mirrors the HTTP JSON
    // payload. The correlation `id` rides OUTSIDE the envelope: the frozen
    // envelope (spec §3) drops unknown fields, so `id` is read here and
    // echoed back verbatim.
    if ('query' in message || 'do' in message) {
      await this.#executeEnvelope(message);
      return;
    }

    if (typeof message.subscribe === 'string') {
      const clientId = message.id;
      if (typeof clientId !== 'string' || clientId.length === 0) {
        throw new OrbitError(ErrorCode.INVALID_QUERY, "'id' is required for subscribe");
      }
      if (this.#clientSubs.has(clientId)) {
        throw new OrbitError(
          ErrorCode.SUBSCRIPTION_FAILED,
          `A subscription '${clientId}' already exists`,
        );
      }
      const onEvent = (seq: number, event: unknown) =>
        this.#send(this.#encode({ id: clientId, seq, event }));
      const sub = this.#hub.subscribe(message.subscribe, clientId, onEvent);
      this.#clientSubs.set(clientId, { sub, onEvent });
      this.#cancelRelease(clientId);
      this.#send(this.#encode({ ack: clientId }));
      return;
    }

    if (typeof message.unsubscribe === 'string') {
      const clientId = message.unsubscribe;
      const entry = this.#clientSubs.get(clientId);
      if (entry) {
        entry.sub.unsubscribe();
        this.#clientSubs.delete(clientId);
      }
      this.#send(this.#encode({ unsubscribed: clientId }));
      return;
    }

    if (typeof message.resume === 'string') {
      const clientId = message.resume;
      const entry = this.#clientSubs.get(clientId);
      if (entry) {
        // Same live session — just replay.
        const after =
          typeof message.after === 'number' && Number.isFinite(message.after) ? message.after : 0;
        this.#hub.resume(clientId, after, entry.onEvent);
        this.#send(this.#encode({ resumed: clientId, after }));
        return;
      }
      // Reconnect: re-attach a retained subscription and replay the gap.
      const onEvent = (seq: number, event: unknown) =>
        this.#send(this.#encode({ id: clientId, seq, event }));
      const after =
        typeof message.after === 'number' && Number.isFinite(message.after) ? message.after : 0;
      const sub = this.#hub.resume(clientId, after, onEvent);
      if (!sub) {
        throw new OrbitError(
          ErrorCode.SUBSCRIPTION_FAILED,
          `Unknown or expired subscription '${clientId}' — re-subscribe to start over`,
        );
      }
      this.#clientSubs.set(clientId, { sub, onEvent });
      this.#cancelRelease(clientId);
      this.#send(this.#encode({ resumed: clientId, after }));
      return;
    }

    throw new OrbitError(
      ErrorCode.INVALID_QUERY,
      "Message must contain 'subscribe', 'unsubscribe', 'resume', 'query' or 'do'",
    );
  }

  /**
   * Execute a `{ query }` / `{ do }` envelope over the socket and reply with
   * the same payload the HTTP handler serves — `{ id?, status, data,
   * fromCache?, invalidates? }`, or `{ id?, status, error }` on failure.
   * The envelope is validated and executed exactly like HTTP: `query` XOR
   * `do`, `args`/`return`/`cache` semantics, depth limits, and the FULL
   * plugin pipeline (auth gates, caching, error translation) all apply.
   */
  async #executeEnvelope(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : undefined;
    try {
      // validateEnvelope is the exact validator the HTTP path uses: it
      // rejects bad shapes, strips unknown fields (including the correlation
      // `id`), and enforces the `query` XOR `do` rule — identical semantics,
      // one source of truth. Validation failures carry the `id` too.
      const envelope = validateEnvelope(message);
      const result = await this.#orbit.execute(envelope);
      this.#send(
        this.#encode({
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
        }),
      );
    } catch (error) {
      const orbitError = toOrbitError(error);
      this.#send(
        this.#encode({
          ...(id !== undefined ? { id } : {}),
          status: orbitError.status,
          error: orbitError.toJSON().error,
        }),
      );
    }
  }

  #tickHeartbeat(): void {
    if (this.#closing) return;
    // No pong since the previous ping → the client is gone.
    if (Date.now() - this.#lastPong > this.#options.heartbeatMs) {
      this.#terminate(CloseCode.GoingAway, 'heartbeat timeout');
      return;
    }
    this.#send(encodeFrame(Opcode.Ping, Buffer.alloc(0)));
  }

  #terminate(code: number, reason: string): void {
    try {
      this.#send(closeFrame(code, reason));
    } catch {
      // Socket already gone — nothing to send.
    }
    this.dispose();
    // destroy() after the close frame: end() leaves the connection half-open
    // (see the comment in the Close-frame case above).
    this.#socket.destroy();
  }

  #send(data: Buffer): void {
    if (this.#closing || !this.#socket.writable) return;
    try {
      this.#socket.write(data);
    } catch {
      // Socket closed mid-write.
    }
  }

  #encode(message: Record<string, unknown>): Buffer {
    if (this.#options.serialize === 'msgpack') {
      return encodeFrame(Opcode.Binary, encodeMsgpack(message));
    }
    return encodeFrame(Opcode.Text, Buffer.from(JSON.stringify(message)));
  }
}

/** Create a realtime server for an Orbit engine. */
export function createRealtimeServer(
  orbit: Orbit,
  options?: RealtimeServerOptions,
): RealtimeServer {
  return new RealtimeServer(orbit, options);
}
