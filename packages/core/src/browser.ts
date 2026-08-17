/**
 * Browser-safe entry of `@orbit/core` — the full public API except the
 * Node-only realtime transport (`realtime/server.ts` runs on `node:http`,
 * `realtime/frames.ts` uses `node:crypto`).
 *
 * A browser loading `@orbit/core` (via an import map, e.g. the web demos)
 * must not fetch those modules — a static re-export of `realtime/server.js`
 * would pull `node:` specifiers that fail CORS. Everything here runs on any
 * runtime: engine, errors, envelope, codecs, negotiation, plugins, adapters
 * and the runtime-agnostic realtime pieces (`SubscriptionHub` and
 * `createSessionDriver`, shared with the Cloudflare Workers transport).
 *
 * Keep this file in sync with `index.ts` — it is the same list minus the
 * two Node-only modules above. Exposed as `@orbit/core/browser`.
 */
export { Orbit, createOrbit, JSON_CONTENT_TYPE } from './engine.js';
export type { OrbitConfig, OrbitHandler } from './engine.js';

export { encodeMsgpack, decodeMsgpack } from './serialize/msgpack.js';
export {
  negotiateFormat,
  wantsGzip,
  MSGPACK_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
} from './serialize/negotiate.js';
export type { OrbitFormat } from './serialize/negotiate.js';

export { parseOQS, DEFAULT_MAX_DEPTH } from './parser.js';
export type { ParseOptions } from './parser.js';

export { OrbitError, ErrorCode, ErrorStatus, isOrbitError, toOrbitError } from './errors.js';
export type { OrbitErrorCode, OrbitErrorOptions } from './errors.js';

export {
  validateEnvelope,
  readEnvelope,
  readEnvelopeBytes,
  readMsgpackEnvelope,
  DEFAULT_MAX_PAYLOAD_BYTES,
} from './envelope.js';

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

export { AdapterRegistry } from './adapters/registry.js';
export { memoryAdapter } from './adapters/memory.js';
export type { MemoryAdapterDefinition } from './adapters/memory.js';
export type { DataAdapter, AdapterRegistryLike } from './adapters/types.js';

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

// Realtime — the runtime-agnostic pieces only (server/frames are Node-only;
// see the file header).
export { SubscriptionHub, RESUME_LOG_MAX } from './realtime/hub.js';
export type { RealtimeSubscription } from './realtime/hub.js';
export { createSessionDriver } from './realtime/driver.js';
export type { RealtimeSessionDriver, SessionSend, SessionDriverHooks } from './realtime/driver.js';

export { isRecord, isSerializedPayload, byteLength, fnv1a, fnv1a64 } from './utils.js';
