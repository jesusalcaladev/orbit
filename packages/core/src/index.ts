/**
 * @orbit/core — a thin, zero-dependency contract layer that transports
 * intent from client to server.
 *
 * ```ts
 * import { createOrbit, memoryAdapter, createCachePlugin } from '@orbit/core';
 *
 * const orbit = createOrbit({
 *   adapters: memoryAdapter([{ entity: 'user', resolve: ({ id }) => users.find(u => u.id === id) }]),
 *   plugins: [createCachePlugin()],
 * });
 * ```
 */

// Engine
export { Orbit, createOrbit, JSON_CONTENT_TYPE } from './engine.js';
export type { OrbitConfig, OrbitHandler } from './engine.js';

// Serialization & negotiation
export { encodeMsgpack, decodeMsgpack } from './serialize/msgpack.js';
export { negotiateFormat, wantsGzip, MSGPACK_CONTENT_TYPE, SSE_CONTENT_TYPE } from './serialize/negotiate.js';
export type { OrbitFormat } from './serialize/negotiate.js';

// Query language
export { parseOQS, DEFAULT_MAX_DEPTH } from './parser.js';
export type { ParseOptions } from './parser.js';

// Errors
export { OrbitError, ErrorCode, ErrorStatus, isOrbitError, toOrbitError } from './errors.js';
export type { OrbitErrorCode, OrbitErrorOptions } from './errors.js';

// Envelope
export {
  validateEnvelope,
  readEnvelope,
  readEnvelopeBytes,
  readMsgpackEnvelope,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from './envelope.js';

// Plugins
export { PluginRegistry } from './plugins/registry.js';
export { createCachePlugin, parseCacheSpec, createMemoryCacheStore } from './plugins/cache.js';
export type {
  CachePlugin,
  CachePluginOptions,
  CacheSpec,
  CacheStore,
  CacheEntry,
  MemoryCacheStoreOptions,
} from './plugins/cache.js';
export type {
  OrbitPlugin,
  OrbitHooks,
  ShortCircuit,
  BeforeParseInput,
  AfterParseInput,
  BeforeResolveInput,
  BeforeExecuteInput,
  BeforeExecuteAdjustment,
  AfterResolveInput,
  BeforeSerializeInput,
  ErrorInput,
} from './plugins/types.js';
export { isShortCircuit, HOOK_ORDER } from './plugins/types.js';

// Adapters
export { AdapterRegistry } from './adapters/registry.js';
export { memoryAdapter } from './adapters/memory.js';
export type { MemoryAdapterDefinition } from './adapters/memory.js';
export type { DataAdapter, AdapterRegistryLike } from './adapters/types.js';

// Core types
export type {
  Filters,
  NodeOrigin,
  QueryNode,
  MutationArgs,
  OrbitEnvelope,
  OrbitContext,
  ParentContext,
  BatchRequest,
  MutationResult,
  SerializedPayload,
  SubscriptionEvent,
  OrbitResult,
  OrbitStreamEvent,
  OrbitEngineLike,
} from './types.js';

// Realtime (WebSocket transport — Node)
export { createRealtimeServer, RealtimeServer } from './realtime/server.js';
export type { RealtimeServerOptions } from './realtime/server.js';
export { SubscriptionHub, RESUME_LOG_MAX } from './realtime/hub.js';
export type { RealtimeSubscription } from './realtime/hub.js';
export {
  computeAcceptKey,
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError,
  CloseCode,
  closeFrame,
  upgradeResponse,
} from './realtime/frames.js';
export type { Frame } from './realtime/frames.js';

// Utils
export { isRecord, isSerializedPayload, byteLength, fnv1a } from './utils.js';
