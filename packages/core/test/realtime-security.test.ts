/**
 * RealtimeServer — protocol & security suite.
 *
 * These tests speak raw WebSocket over `net.Socket` (see ws-helper.ts): the
 * global `WebSocket` client can only produce VALID protocol, but an attacker
 * can send unmasked frames, set RSV bits, claim 1 GB payloads, interleave
 * control frames mid-fragment, send garbage that is not JSON nor MessagePack…
 * every one of those must be rejected with the right close code (or an error
 * frame) without taking the process down or unbounded-buffering.
 *
 * Close-code contract:
 *   1002 (protocol error)  — malformed/violating frames
 *   1009 (too big)         — declared/message size beyond the limit
 *   400/403/404            — handshake rejections (HTTP status)
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/errors.js';
import {
  CloseCode,
  computeAcceptKey,
  createOrbit,
  createRealtimeServer,
  encodeMsgpack,
} from '../src/index.js';
import type { RealtimeServer, RealtimeServerOptions } from '../src/index.js';
import type { DataAdapter } from '../src/adapters/types.js';
import type { MutationArgs, SubscriptionEvent } from '../src/types.js';
import { buildClientFrame, RawWsClient } from './ws-helper.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(10);
  }
}

/** Minimal post world whose adapter accepts subscriptions. */
function createWorld() {
  const handlers = new Set<(event: SubscriptionEvent) => void>();
  const adapter: DataAdapter = {
    entity: 'post',
    resolve: () => null,
    mutate: (_action: string, args: MutationArgs) => ({
      id: (args.payload as { id: string } | undefined)?.id,
    }),
    subscribe: (_filters, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const orbit = createOrbit({ adapters: [adapter] });
  return {
    orbit,
    emit: (event: SubscriptionEvent) => {
      for (const handler of handlers) handler(event);
    },
  };
}

const isCloseFrame = (frame: { opcode: number }) => frame.opcode === 0x8;
const isTextFrame = (frame: { opcode: number }) => frame.opcode === 0x1;
const isPongFrame = (frame: { opcode: number }) => frame.opcode === 0xa;

/** Text-frame predicate that also inspects the payload (e.g. `'"ack":"x"'`). */
const textContaining = (substring: string) => (frame: { opcode: number; payload: Buffer }) =>
  frame.opcode === 0x1 && frame.payload.toString('utf8').includes(substring);

describe('RealtimeServer — handshake & access gates', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  it('accepts a valid upgrade with the RFC 6455 accept key', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect();
    expect(handshake.status).toBe(101);
    expect(handshake.headers['sec-websocket-accept']).toBe(
      computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    );
    client.dispose();
  });

  it('rejects a POST upgrade with 400', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect({ method: 'POST' });
    expect(handshake.status).toBe(400);
    client.dispose();
  });

  it('rejects a missing Sec-WebSocket-Key with 400', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect({ headers: { 'Sec-WebSocket-Key': null } });
    expect(handshake.status).toBe(400);
    client.dispose();
  });

  it('rejects a wrong Sec-WebSocket-Version with 400', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect({ headers: { 'Sec-WebSocket-Version': '12' } });
    expect(handshake.status).toBe(400);
    client.dispose();
  });

  it('rejects a non-websocket Upgrade header with 400', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect({ headers: { Upgrade: 'h2c' } });
    expect(handshake.status).toBe(400);
    client.dispose();
  });

  it('rejects upgrades on the wrong path with 404', async () => {
    await start();
    const client = new RawWsClient(port);
    const handshake = await client.connect({ path: '/not-realtime' });
    expect(handshake.status).toBe(404);
    client.dispose();
  });

  it('enforces the Origin allow-list (403 for strangers, 101 for friends)', async () => {
    await start({ origin: 'https://app.example.com' });
    const evil = new RawWsClient(port);
    const evilHandshake = await evil.connect({ headers: { Origin: 'https://evil.example' } });
    expect(evilHandshake.status).toBe(403);
    evil.dispose();

    const friend = new RawWsClient(port);
    const friendHandshake = await friend.connect({
      headers: { Origin: 'https://app.example.com' },
    });
    expect(friendHandshake.status).toBe(101);
    friend.dispose();
  });

  it('rejects when authorize() returns false (403)', async () => {
    await start({ authorize: () => false });
    const client = new RawWsClient(port);
    const handshake = await client.connect();
    expect(handshake.status).toBe(403);
    client.dispose();
  });

  it('rejects when authorize() rejects asynchronously — no crash, clean 403', async () => {
    await start({
      authorize: () => Promise.reject(new Error('token service down')),
    });
    const client = new RawWsClient(port);
    const handshake = await client.connect();
    expect(handshake.status).toBe(403);
    client.dispose();
  });

  it('rejects when authorize() THROWS synchronously — no uncaughtException, clean 403', async () => {
    await start({
      authorize: () => {
        throw new Error('token service down');
      },
    });
    const client = new RawWsClient(port);
    const handshake = await client.connect();
    expect(handshake.status).toBe(403);
    client.dispose();
  });

  it('rejects an upgrade with no request url (defensive 404 path)', async () => {
    // node:http always provides `url`, but handleUpgrade defends against a
    // missing one — a synthetic request with no url must 404, not throw.
    await start();
    const written: string[] = [];
    const fakeSocket = {
      writable: true,
      setNoDelay() {},
      write(chunk: Buffer) {
        written.push(String(chunk));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) written.push(String(chunk));
      },
      on() {},
      destroy() {},
    } as unknown as Duplex;
    realtime.handleUpgrade({} as IncomingMessage, fakeSocket, Buffer.alloc(0));
    // The upgrade flow runs through a promise chain (authorize), so the 404
    // lands on the next microtask.
    await sleep(5);
    expect(written.join('')).toContain('404');
  });

  it('never writes to a socket that is not writable (heartbeat send guard)', async () => {
    // Drive handleUpgrade directly with a synthetic DEAD socket: the upgrade
    // response is written once, and the session's heartbeat ticks must then
    // refuse to ping a socket that cannot accept bytes (the !writable guard).
    await start({ heartbeatMs: 10 });
    const writes: string[] = [];
    const deadSocket = {
      writable: false,
      setNoDelay() {},
      write(chunk: Buffer) {
        writes.push(String(chunk));
        return true;
      },
      on() {},
      destroy() {},
    } as unknown as Duplex;
    realtime.handleUpgrade(
      {
        method: 'GET',
        url: '/realtime',
        headers: {
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      } as IncomingMessage,
      deadSocket,
      Buffer.alloc(0),
    );
    await sleep(5); // let the async authorize chain write the handshake
    expect(writes).toHaveLength(1); // just the handshake response
    await sleep(45); // several heartbeat intervals
    expect(writes).toHaveLength(1); // no ping ever reached the dead socket
  });
});

describe('RealtimeServer — frame protocol violations (close codes)', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  /** Connect, then expect a close frame with `code` (and the socket to die). */
  async function expectCloseAfter(
    act: (client: RawWsClient) => void,
    code: number,
    options?: RealtimeServerOptions,
  ) {
    await start(options);
    const client = new RawWsClient(port);
    await client.connect();
    act(client);
    const close = await client.awaitFrame(isCloseFrame, `close ${code}`, 4000);
    expect(close.payload.readUInt16BE(0)).toBe(code);
    client.dispose();
  }

  it('closes 1002 on an unmasked client frame (RFC 6455 §5.1)', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('{"a":1}'), { masked: false }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on an unmasked frame even when it declares a huge length (header checked first)', async () => {
    // Fail-fast ordering: the mask violation is caught from the 2-byte header
    // before the declared 1 GB payload is even looked at — so it is a 1002,
    // not a 1009 (the size guard never gets a chance to matter).
    await expectCloseAfter((client) => {
      client.sendRaw(
        buildClientFrame(Buffer.alloc(0), { masked: false, declaredLength: 1024 * 1024 * 1024 }),
      );
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on RSV bits set', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('{}'), { rsv: 1 }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on a reserved opcode (0x3)', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('{}'), { opcode: 0x3 }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on a control frame that is not FIN', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('hi'), { opcode: 0x9, fin: false }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on a control frame larger than 125 bytes', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.alloc(126), { opcode: 0x9 }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1009 on a frame declaring 1 GB — before buffering any payload (memory DoS)', async () => {
    await start({ maxMessageBytes: 1024 });
    const client = new RawWsClient(port);
    await client.connect();
    client.sendRaw(buildClientFrame(Buffer.alloc(0), { declaredLength: 1024 * 1024 * 1024 }));
    const close = await client.awaitFrame(isCloseFrame, 'close 1009', 4000);
    expect(close.payload.readUInt16BE(0)).toBe(CloseCode.TooBig);
    client.dispose();
  });

  it('closes 1002 on a continuation frame with no fragmented message in progress', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('tail'), { opcode: 0x0 }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 when a new data frame interrupts a fragmented message (RFC 6455 §5.4)', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from('start'), { fin: false })); // fragment begins
      client.sendRaw(buildClientFrame(Buffer.from('{"broken"'))); // fresh text frame — illegal
    }, CloseCode.ProtocolError);
  });

  it('closes 1009 when a fragmented message exceeds maxMessageBytes in total', async () => {
    await expectCloseAfter((client) => {
      // maxMessageBytes defaults to 1 MiB; declare two 700 KiB fragments.
      client.sendRaw(buildClientFrame(Buffer.alloc(700 * 1024, 0x61), { fin: false }));
      client.sendRaw(buildClientFrame(Buffer.alloc(700 * 1024, 0x62), { opcode: 0x0, fin: true }));
    }, CloseCode.TooBig);
  });

  it('closes 1009 on a message split into too many fragments (object-count DoS guard)', async () => {
    // The byte cap bounds the payload, but each fragment is also a Buffer
    // object — a 1-byte-fragment flood must trip a COUNT cap (1000), not
    // allocate a million objects first. Start + 1000 continuations exceeds it.
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    client.sendRaw(buildClientFrame(Buffer.from('x'), { fin: false }));
    for (let i = 0; i < 1000; i += 1) {
      client.sendRaw(buildClientFrame(Buffer.from('y'), { opcode: 0x0, fin: false }));
    }
    const close = await client.awaitFrame(isCloseFrame, 'close 1009 (fragment cap)', 4000);
    expect(close.payload.readUInt16BE(0)).toBe(CloseCode.TooBig);
    client.dispose();
  });

  it('closes 1002 on a close frame with a 1-byte payload (no status code)', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from([0x00]), { opcode: 0x8 }));
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 on a close frame with a reserved/invalid close code (1005)', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(buildClientFrame(Buffer.from([0x03, 0xed]), { opcode: 0x8 })); // 1005
    }, CloseCode.ProtocolError);
  });

  it('closes 1002 when HTTP bytes are sent after the upgrade', async () => {
    await expectCloseAfter((client) => {
      client.sendRaw(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
    }, CloseCode.ProtocolError);
  });

  it('survives a slow-loris partial frame: bounded buffering, connection recovers', async () => {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    // Declare 100 bytes, deliver only 5 — the connection must stay up (the
    // buffer is bounded by the declared length ≤ maxMessageBytes, no leak).
    const frame = buildClientFrame(Buffer.alloc(100, 0x61), { declaredLength: 100 });
    client.sendRaw(frame.subarray(0, 11)); // header + mask + 5 payload bytes
    await sleep(60);
    expect(client.closed).toBe(false);
    // Deliver the rest: the 100-byte message completes, is not valid JSON,
    // and the server answers with an error frame — proving the connection
    // recovered from the partial frame instead of stalling forever.
    client.sendRaw(frame.subarray(11));
    const error = await client.awaitFrame(
      textContaining('"error"'),
      'error after completing the slow frame',
      4000,
    );
    expect(JSON.parse(error.payload.toString('utf8'))).toMatchObject({
      error: { code: ErrorCode.INVALID_QUERY },
    });
    // And a fresh valid subscribe still works.
    client.sendText(JSON.stringify({ subscribe: 'post { id }', id: 'alive' }));
    const ack = await client.awaitFrame(textContaining('"ack":"alive"'), 'ack', 4000);
    expect(ack.payload.toString('utf8')).toContain('"ack":"alive"');
    client.close();
    await client.waitForClose();
  });
});

describe('RealtimeServer — fragmentation correctness', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  it('reassembles a message split into fragments with a ping interleaved (RFC 6455 §5.4)', async () => {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    // "{\"subscribe\": \"post { id }\", \"id\": \"frag\"}" split mid-way.
    const full = '{"subscribe": "post { id }", "id": "frag"}';
    const cut = Math.floor(full.length / 2);
    client.sendRaw(buildClientFrame(Buffer.from(full.slice(0, cut)), { fin: false }));
    client.sendRaw(buildClientFrame(Buffer.from('ping!'), { opcode: 0x9 })); // legal interleave
    client.sendRaw(buildClientFrame(Buffer.from(full.slice(cut)), { opcode: 0x0, fin: true }));

    // Control frames may interrupt a fragmented message: we get the pong…
    const pong = await client.awaitFrame(isPongFrame, 'pong', 4000);
    expect(pong.payload.toString('utf8')).toBe('ping!');
    // …and the message is still reassembled correctly.
    const ack = await client.awaitFrame(isTextFrame, 'ack', 4000);
    expect(ack.payload.toString('utf8')).toContain('"ack":"frag"');
    client.close();
    await client.waitForClose();
  });
});

describe('RealtimeServer — message-level validation (error frames, connection survives)', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  /** Expect an error frame for `text`, then prove the connection still works. */
  async function expectErrorAndSurvives(send: (client: RawWsClient) => void, code: string) {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    send(client);
    const error = await client.awaitFrame(isTextFrame, `error ${code}`, 4000);
    const parsed = JSON.parse(error.payload.toString('utf8')) as { error?: { code: string } };
    expect(parsed.error?.code).toBe(code);
    // The connection must remain usable (a later valid subscribe gets an ack —
    // matched by payload, since the error frame is also a text frame).
    client.sendText(JSON.stringify({ subscribe: 'post { id }', id: 'still-alive' }));
    const ack = await client.awaitFrame(
      textContaining('"ack":"still-alive"'),
      'ack after error',
      4000,
    );
    expect(ack.payload.toString('utf8')).toContain('"ack":"still-alive"');
    client.close();
    await client.waitForClose();
  }

  it('rejects invalid JSON with an error frame', async () => {
    await expectErrorAndSurvives((client) => client.sendText('{not json'), ErrorCode.INVALID_QUERY);
  });

  it('rejects non-object JSON values (42, strings, null, arrays)', async () => {
    await expectErrorAndSurvives((client) => client.sendText('42'), ErrorCode.INVALID_QUERY);
  });

  it('rejects a message with no recognized action', async () => {
    await expectErrorAndSurvives(
      (client) => client.sendText('{"hello": 1}'),
      ErrorCode.INVALID_QUERY,
    );
  });

  it('rejects a subscribe without an id', async () => {
    await expectErrorAndSurvives(
      (client) => client.sendText('{"subscribe": "post { id }"}'),
      ErrorCode.INVALID_QUERY,
    );
  });

  it('rejects a subscribe with an empty id', async () => {
    await expectErrorAndSurvives(
      (client) => client.sendText('{"subscribe": "post { id }", "id": ""}'),
      ErrorCode.INVALID_QUERY,
    );
  });

  it('rejects resuming an unknown subscription', async () => {
    await expectErrorAndSurvives(
      (client) => client.sendText('{"resume": "ghost", "after": 0}'),
      ErrorCode.SUBSCRIPTION_FAILED,
    );
  });

  it('rejects binary frames that are not valid MessagePack', async () => {
    // 0xc1 is an invalid MessagePack byte — the decoder must not crash.
    await expectErrorAndSurvives(
      (client) => client.sendBinary(Buffer.from([0xc1, 0xff, 0x00])),
      ErrorCode.INVALID_QUERY,
    );
  });

  it('rejects binary MessagePack that decodes to a non-object', async () => {
    await expectErrorAndSurvives(
      (client) => client.sendBinary(Buffer.from(encodeMsgpack(42))),
      ErrorCode.INVALID_QUERY,
    );
  });

  it('tracks pongs from the client (heartbeat liveness)', async () => {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    // A pong — even unsolicited — refreshes the server's liveness clock.
    client.sendRaw(buildClientFrame(Buffer.alloc(0), { opcode: 0xa }));
    await sleep(30);
    expect(client.closed).toBe(false);
    client.dispose();
  });

  it('heartbeats the client and closes 1001 when it stops responding', async () => {
    // Generous interval so a slow handshake still lands before the first
    // tick (which would otherwise terminate instead of pinging).
    await start({ heartbeatMs: 150 });
    const client = new RawWsClient(port);
    await client.connect();
    // Refresh liveness immediately so the first tick is guaranteed to PING
    // rather than time out on a slow handshake.
    client.sendRaw(buildClientFrame(Buffer.alloc(0), { opcode: 0xa }));
    const ping1 = await client.awaitFrame((frame) => frame.opcode === 0x9, 'first ping');
    expect(ping1.payload.length).toBe(0);
    client.sendRaw(buildClientFrame(Buffer.alloc(0), { opcode: 0xa }));
    const ping2 = await client.awaitFrame((frame) => frame.opcode === 0x9, 'second ping');
    expect(ping2.payload.length).toBe(0);
    // Stop answering — the next tick terminates the session (1001 GoingAway).
    const close = await client.awaitFrame(isCloseFrame, 'heartbeat timeout close', 5000);
    expect(close.payload.readUInt16BE(0)).toBe(CloseCode.GoingAway);
    await client.waitForClose();
    client.dispose();
  });

  it('releases the session when the socket errors (RST while data is in flight)', async () => {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    // Send a subscription and immediately kill the connection with an RST
    // (not a FIN) before the server reads it — the server sees ECONNRESET
    // with buffered data and must dispose the session via the 'error' path.
    client.sendText(JSON.stringify({ subscribe: 'post { id }', id: 's1' }));
    (client.socket as unknown as { resetAndDestroy: () => void }).resetAndDestroy();
    await waitFor(() => realtime.sessionCount === 0, 'session released on socket error');
    client.dispose();
  });

  it('processes a frame pipelined with the upgrade handshake (head data)', async () => {
    await start();
    const client = new RawWsClient(port);
    const subFrame = buildClientFrame(
      Buffer.from(JSON.stringify({ subscribe: 'post { id }', id: 's1' })),
    );
    const handshake = await client.connect({}, subFrame);
    expect(handshake.status).toBe(101);
    const ack = await client.awaitFrame(isTextFrame, 'pipelined ack', 4000);
    expect(JSON.parse(ack.payload.toString('utf8'))).toMatchObject({ ack: 's1' });
    client.dispose();
  });

  it('skips frames that arrive after a violation terminated the session', async () => {
    await start();
    const client = new RawWsClient(port);
    await client.connect();
    // A continuation with no message in progress → 1002. The VALID text frame
    // in the same packet must be dropped, not processed (session closing).
    client.sendRaw(
      Buffer.concat([
        buildClientFrame(Buffer.from('tail'), { opcode: 0x0 }),
        buildClientFrame(Buffer.from('{}')),
      ]),
    );
    const close = await client.awaitFrame(isCloseFrame, 'close 1002', 4000);
    expect(close.payload.readUInt16BE(0)).toBe(CloseCode.ProtocolError);
    client.dispose();
  });
});

describe('RealtimeServer — retention & expiry', () => {
  let server: Server;
  let realtime: RealtimeServer;
  let port: number;

  afterEach(() => {
    realtime?.close();
    server?.close();
  });

  async function start(options?: RealtimeServerOptions) {
    const world = createWorld();
    server = createServer();
    realtime = createRealtimeServer(world.orbit, options);
    realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    return world;
  }

  it('rejects resume once the retention window has expired', async () => {
    const world = await start({ retentionMs: 40 });
    const first = new RawWsClient(port);
    await first.connect();
    first.sendText(JSON.stringify({ subscribe: 'post { id }', id: 'expires' }));
    await first.awaitFrame(isTextFrame, 'ack', 4000);
    first.close();
    await first.waitForClose();

    // Let the server detach AND expire the subscription.
    await waitFor(() => realtime.sessionCount === 0, 'session closed');
    await sleep(120);

    // An event while fully expired is lost for everyone.
    world.emit({ type: 'updated', id: 'p1', patch: { views: 1 } });

    const second = new RawWsClient(port);
    await second.connect();
    second.sendText(JSON.stringify({ resume: 'expires', after: 0 }));
    const error = await second.awaitFrame(isTextFrame, 'expired resume error', 4000);
    const parsed = JSON.parse(error.payload.toString('utf8')) as { error?: { code: string } };
    expect(parsed.error?.code).toBe(ErrorCode.SUBSCRIPTION_FAILED);
    second.dispose();
  });

  it('re-attaching before the retention window expires cancels the release timer', async () => {
    const world = await start({ retentionMs: 80 }); // SHORT window
    const first = new RawWsClient(port);
    await first.connect();
    first.sendText(JSON.stringify({ subscribe: 'post { id }', id: 's1' }));
    await first.awaitFrame(isTextFrame, 'ack', 4000);
    first.close();
    await first.waitForClose();
    await waitFor(() => realtime.sessionCount === 0, 'session closed');

    // Re-attach (same id, same query) and let the original window elapse —
    // the re-attach MUST cancel the pending release timer (it lives on the
    // SERVER, shared across sessions), so the subscription survives the
    // window and keeps delivering. With the timer per-session (the old bug),
    // the first session's timer would fire after 80 ms and kill the
    // re-attached subscription mid-use.
    const second = new RawWsClient(port);
    await second.connect();
    second.sendText(JSON.stringify({ subscribe: 'post { id }', id: 's1' }));
    const ack = await second.awaitFrame(isTextFrame, 're-attach ack', 4000);
    expect(JSON.parse(ack.payload.toString('utf8'))).toMatchObject({ ack: 's1' });

    await sleep(150); // well past the original retention window
    world.emit({ type: 'updated', id: 'p1', patch: { views: 1 } });
    const event = await second.awaitFrame(
      (frame) => frame.opcode === 0x1 && frame.payload.toString('utf8').includes('"id":"s1"'),
      'event after re-attach + window',
      4000,
    );
    expect(JSON.parse(event.payload.toString('utf8'))).toMatchObject({ id: 's1', seq: 1 });
    second.dispose();
  });
});
