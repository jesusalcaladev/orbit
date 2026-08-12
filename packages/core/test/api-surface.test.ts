import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

// ---------------------------------------------------------------------------
// The FROZEN public API surface (spec.md §3 / §13).
//
// `src/index.ts` is the ONLY public entry point of @orbit/core. This test
// pins every export name in it. If a name is renamed, removed or added here,
// the test fails: changing the surface is a BREAKING contract change and
// requires a conscious decision (major version bump + spec update), never a
// silent tweak. When the surface evolves, update spec.md §13 AND this list
// in the same change.
// ---------------------------------------------------------------------------

// Type-only exports (erased at build time; pinned from source, exact set).
const FROZEN_TYPE_EXPORTS = [
  'OrbitConfig',
  'OrbitHandler',
  'OrbitFormat',
  'ParseOptions',
  'OrbitErrorCode',
  'OrbitErrorOptions',
  'CachePlugin',
  'CachePluginOptions',
  'CacheSpec',
  'CacheStore',
  'CacheEntry',
  'MemoryCacheStoreOptions',
  'OrbitPlugin',
  'OrbitHooks',
  'ShortCircuit',
  'BeforeParseInput',
  'AfterParseInput',
  'BeforeResolveInput',
  'BeforeExecuteInput',
  'BeforeExecuteAdjustment',
  'AfterResolveInput',
  'BeforeSerializeInput',
  'ErrorInput',
  'MemoryAdapterDefinition',
  'DataAdapter',
  'AdapterRegistryLike',
  'Filters',
  'NodeOrigin',
  'QueryNode',
  'MutationArgs',
  'OrbitEnvelope',
  'OrbitContext',
  'ParentContext',
  'BatchRequest',
  'MutationResult',
  'SerializedPayload',
  'SubscriptionEvent',
  'OrbitResult',
  'OrbitStreamEvent',
  'OrbitEngineLike',
  'RealtimeServerOptions',
  'RealtimeSubscription',
  'Frame',
] as const;

// Exports that exist and must keep existing (rename or removal = breaking).
const FROZEN_EXPORTS = [
  // Engine
  'Orbit',
  'createOrbit',
  'JSON_CONTENT_TYPE',
  // Serialization & negotiation
  'encodeMsgpack',
  'decodeMsgpack',
  'negotiateFormat',
  'wantsGzip',
  'MSGPACK_CONTENT_TYPE',
  'SSE_CONTENT_TYPE',
  // Query language
  'parseOQS',
  'DEFAULT_MAX_DEPTH',
  // Errors
  'OrbitError',
  'ErrorCode',
  'ErrorStatus',
  'isOrbitError',
  'toOrbitError',
  // Envelope
  'validateEnvelope',
  'readEnvelope',
  'readEnvelopeBytes',
  'readMsgpackEnvelope',
  'DEFAULT_MAX_PAYLOAD_BYTES',
  // Plugins
  'PluginRegistry',
  'createCachePlugin',
  'parseCacheSpec',
  'createMemoryCacheStore',
  'isShortCircuit',
  'HOOK_ORDER',
  // Adapters
  'AdapterRegistry',
  'memoryAdapter',
  // Realtime
  'createRealtimeServer',
  'RealtimeServer',
  'SubscriptionHub',
  'RESUME_LOG_MAX',
  'computeAcceptKey',
  'encodeFrame',
  'FrameDecoder',
  'FrameTooLargeError',
  'CloseCode',
  'closeFrame',
  'upgradeResponse',
  // Utils
  'isRecord',
  'isSerializedPayload',
  'byteLength',
  'fnv1a',
  'fnv1a64',
] as const;

describe('contract: public API surface (spec §13)', () => {
  it('exposes exactly the frozen export names — no additions, no removals', () => {
    const exported = Object.keys(api).sort();
    const frozen = [...FROZEN_EXPORTS].sort();
    // Intent: additions to the public surface are additive extensions and are
    // allowed only as part of a deliberate, documented change — the test
    // lists them as an exact set so the diff is always visible and reviewed.
    expect(exported).toEqual(frozen);
  });

  it('exposes exactly the frozen type-only exports', async () => {
    // Type-only exports do not appear at runtime; pin them from the source so
    // the type surface cannot drift silently either. The check extracts the
    // `export type { … }` blocks with a regex (word-boundary, so `Frame` does
    // not match `FrameDecoder`) and compares the EXACT set — both directions:
    // a removed OR added type export fails. (Types are erased at build time,
    // so this is a source-level guard, not a runtime one.)
    const { readFileSync } = await import('node:fs');
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const blocks = indexSource.match(/export\s+type\s+\{([^}]*)\}/g) ?? [];
    const exportedTypes = blocks
      .flatMap((block) => [...block.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]!))
      .filter((name) => !['export', 'type'].includes(name));
    expect(exportedTypes.sort()).toEqual([...FROZEN_TYPE_EXPORTS].sort());
  });
});
