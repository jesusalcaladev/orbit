/**
 * Workers-native WebSocket transport (spec §10) — the Cloudflare sibling of
 * the Node transport that ships in `@orbit/core`.
 *
 * Node and Workers expose different socket APIs, so this transport is built
 * against a minimal structural interface (`WsSocket` — accept/send/close/
 * events) that the Workers `WebSocket` satisfies and tests can fake. The
 * runtime-agnostic `SubscriptionHub` from the core does the real work: one
 * adapter `subscribe` hook per (entity, filters), per-subscription sequence
 * numbers, and resume replay. The frame contract is identical to the Node
 * transport:
 *
 * ```jsonc
 * // client →
 * { "subscribe": "user(id=\"1\") { name }", "id": "sub-1" }
 * { "unsubscribe": "sub-1" }
 * { "resume": "sub-1", "after": 42 }
 * { "query": "user(id=\"1\") { name }", "id": "req-1" }      // envelope request
 * { "do": "user.update", "args": { "filter": { "id": "1" }, "payload": { "name": "Ana" } }, "id": "req-2" }
 * // server →
 * { "ack": "sub-1" }
 * { "id": "sub-1", "seq": 43, "event": { "type": "updated", "id": "1", "patch": { "name": "Ana" } } }
 * { "unsubscribed": "sub-1" }
 * { "resumed": "sub-1", "after": 42 }
 * { "id": "req-1", "status": 200, "data": { "name": "Ana" } }
 * { "error": { "code": "…", "message": "…" } }
 * ```
 *
 * Lifecycle differences from Node (honest, per-runtime):
 * - **No retention window.** A closed socket releases its adapter hooks
 *   immediately. Cross-connection `resume` would require Durable Objects —
 *   listed as future work; `resume` within the same connection (re-attaching
 *   a subscription) works through the hub.
 * - **No application heartbeats.** Cloudflare keeps the connection alive and
 *   detects dead peers at the platform level; there is no ping-frame API.
 */
import {
  ErrorCode,
  SubscriptionHub,
  createSessionDriver,
  decodeMsgpack,
  encodeMsgpack,
  toOrbitError,
} from '@orbit/core';
import type { Orbit } from '@orbit/core';

/** Default maximum incoming message size (bytes). */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/** The subset of the Workers WebSocket API this transport drives. */
export interface WsSocket {
  /** Accept the WebSocket after the 101 upgrade. */
  accept(): void;
  /** Send a text (string) or binary (ArrayBuffer) message. */
  send(data: string | ArrayBuffer): void;
  /** Close the socket (and fire the 'close' event). */
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message' | 'close', listener: (event: WsEvent) => void): void;
}

/** The message/close event fields this transport reads. */
export interface WsEvent {
  /** Message payload: string (JSON) or ArrayBuffer (MessagePack). */
  data?: unknown;
  /** Close code (on 'close' events). */
  code?: number;
  /** Close reason (on 'close' events). */
  reason?: string;
}

export interface RealtimeSessionOptions {
  /** Message wire format. Defaults to `'json'`. */
  serialize?: 'json' | 'msgpack';
  /** Max incoming message size in bytes. Defaults to 1 MiB. */
  maxMessageBytes?: number;
}

/** A live realtime session — call `close()` to release every subscription. */
export interface RealtimeSession {
  close(): void;
}

/**
 * Drive one WebSocket session against the Orbit engine: subscription control
 * frames AND `{ query }` / `{ do }` envelope requests, multiplexed on one
 * connection. `server.accept()` is called here; `handleWebSocket` performs
 * the 101 upgrade and hands over the server side of the pair.
 */ export function createRealtimeSession(
  server: WsSocket,
  orbit: Orbit,
  options: RealtimeSessionOptions = {},
): RealtimeSession {
  const hub = new SubscriptionHub(orbit);
  const serialize = options.serialize ?? 'json';
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  let closed = false;

  server.accept();

  const send = (message: Record<string, unknown>): void => {
    if (closed) return;
    try {
      if (serialize === 'msgpack') {
        // Copy onto a fresh ArrayBuffer — Workers `send()` takes one.
        const bytes = encodeMsgpack(message);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        server.send(copy.buffer);
      } else {
        server.send(JSON.stringify(message));
      }
    } catch {
      // Socket closed mid-write — the close event will clean up.
    }
  };

  const encodeError = (error: unknown): void => {
    const orbitError = toOrbitError(error);
    send({ error: orbitError.toJSON().error });
  };

  // The frame-level protocol (subscribe/ack, unsubscribe, resume, and the
  // `{ query }` / `{ do }` envelope request/response) lives in the core's
  // runtime-agnostic session driver — the exact same code the Node transport
  // drives, so the frame contract cannot drift between runtimes.
  const driver = createSessionDriver(orbit, hub, send);

  server.addEventListener('message', (event) => {
    if (closed) return;
    const data = event.data;
    let message: unknown;
    if (typeof data === 'string') {
      // Enforce the byte cap before parsing — a giant text frame is the same
      // DoS the Node transport defends against.
      if (new TextEncoder().encode(data).byteLength > maxMessageBytes) {
        send({ error: { code: ErrorCode.INVALID_QUERY, message: 'Message is too large' } });
        return;
      }
      try {
        message = JSON.parse(data);
      } catch {
        send({
          error: {
            code: ErrorCode.INVALID_QUERY,
            message: 'Message is not valid JSON/MessagePack',
          },
        });
        return;
      }
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > maxMessageBytes) {
        send({ error: { code: ErrorCode.INVALID_QUERY, message: 'Message is too large' } });
        return;
      }
      try {
        message = decodeMsgpack(new Uint8Array(data));
      } catch {
        send({
          error: {
            code: ErrorCode.INVALID_QUERY,
            message: 'Message is not valid JSON/MessagePack',
          },
        });
        return;
      }
    } else {
      send({ error: { code: ErrorCode.INVALID_QUERY, message: 'Message must be text or bytes' } });
      return;
    }
    driver.dispatch(message).catch(encodeError);
  });

  server.addEventListener('close', () => close());

  function close(): void {
    if (closed) return;
    closed = true;
    // Release every subscription immediately (no retention window on
    // Workers — a closed socket releases its adapter hooks right away).
    driver.releaseAll();
    hub.close();
  }

  return { close };
}
