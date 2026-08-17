/**
 * @orbit/client — the vanilla, framework-agnostic Orbit client.
 *
 * Transport layer only: fetch the envelope, negotiate JSON/MessagePack, gzip,
 * error mapping, abort/timeout, SSE streaming, multipart uploads and WebSocket
 * realtime. No cache, no hooks, no state — higher layers (@orbit/react) build
 * on top of this.
 *
 * ```ts
 * import { createClient } from '@orbit/client';
 *
 * const client = createClient({ baseUrl: '/orbit' });
 * const { data } = await client.query('user(id="1") { name }');
 * for await (const frame of client.stream('user(id="1") { posts { title } }')) {
 *   console.log(frame.level, frame.data);
 * }
 * ```
 */
export { OrbitClient, createClient } from './client.js';
export { OrbitNetworkError } from './errors.js';
export { RealtimeClient } from './realtime.js';
export type { SubscribeOptions, SubscriptionHandle } from './realtime.js';
// The client throws the same error contract as the server (@orbit/core) —
// re-exported so a client-only consumer needs a single import.
export { ErrorCode, OrbitError, isOrbitError } from '@orbit/core';
export type { OrbitStreamEvent, SubscriptionEvent } from '@orbit/core';
export type {
  ClientFormat,
  Decompress,
  OrbitClientOptions,
  OrbitResponse,
  RealtimeStatus,
  RequestOptions,
  SocketClient,
  SocketReply,
  SocketRequestOptions,
} from './types.js';
export type { UploadFiles } from './multipart.js';
