# Plan: paquete `@orbit/client` — cliente vanilla, framework-agnóstico (capa de transporte)

Resumen ejecutivo

Crear `@orbit/client`, el cliente **vanilla** de Orbit: una capa de transporte
pura, sin framework y sin estado, que solo sabe hablar el protocolo — fetch
del envelope, negociación de contenido (JSON/MessagePack), gzip, streaming SSE,
WebSocket realtime (suscribir/resumir) y subida de archivos multipart.

Es **la base sobre la que se construye `@orbit/react`**: el plan de
`plan-client.md` se reordena para que el cliente React *envuelva* este paquete
por detrás y no contenga ni un solo `fetch` ni parsing de protocolo. También
reemplaza el helper a mano `examples/web/shared.js` (`orbit()` + `orbitSocket()`),
que hoy duplica esta lógica en cada demo.

Lo que **sí** hace: peticiones HTTP, WebSocket, serialización, errores, abort,
streaming, multipart.

Lo que **no** hace (a propósito): cache, hooks, estado, SSR. Eso vive en capas
superiores (`@orbit/react`, o un futuro `@orbit/cache`). La frase guía:
*"solo las partes de fetch"*.

---

## Visión de producto

- **Transport-only.** Envía `{ query }` / `{ do }` envelopes y devuelve
  respuestas tipadas (`data`, `fromCache`, `invalidates`, `status`). Cero cache,
  cero suscripciones de estado — el cliente React añade eso encima.
- **Cero dependencias runtime.** Única dependencia: `@orbit/core`
  (`workspace:*`), reusando sus contratos congelados: `OrbitEnvelope`,
  `ErrorCode`, `OrbitError`, `encodeMsgpack`/`decodeMsgpack`, `negotiateFormat`,
  `wantsGzip`, content types.
- **Funciona en todos lados.** Browser, Node ≥20, React Native, Cloudflare
  Workers. Primitivas inyectables (`fetch`, `WebSocket`, `decompress`) para
  entornos sin alguna de ellas.
- **Formaliza lo que ya existe.** El código probado en batalla de
  `examples/web/shared.js` (reconnect + resume + fallback por
  `ORBIT_SUBSCRIPTION_FAILED`) se convierte en la implementación de referencia
  del cliente realtime.

## Principios de diseño

| Principio | Decisión |
| --- | --- |
| Una sola forma de hablar el protocolo | `client.execute(envelope, opts)` es el núcleo; `query`/`mutate`/`upload` son azúcar. |
| Contratos de `@orbit/core` reusados, nunca duplicados | Envelope validado con `validateEnvelope` antes de enviar (fail-fast en cliente); errores de la wire → instancias de `OrbitError` (mismo `code`/`status`/`details`). |
| Sin estado | El cliente no guarda datos. Devuelve `fromCache`/`invalidates` como metadata para que la capa superior decida. |
| Entorno agnóstico | `fetch`/`WebSocket`/`decompress` inyectables, con defaults de `globalThis`. Sin polyfills forzados en el bundle. |
| Abort de primera clase | `AbortSignal` + `timeoutMs` en cada petición; `ctx.signal` del lado servidor ya lo soporta (spec §11). |
| Frames WS en JSON para v1 | MessagePack sobre el socket queda como mejora futura (additiva, no bloqueante). |

## Relación con `@orbit/react` (la capa que viene después)

`plan-client.md` se ajusta así:

```
@orbit/react            hooks, cache in-memory (TTL/SWR), invalidate,
                        dehydrate/hydrate, SSR
        │  usa por detrás (única dependencia de transporte)
        ▼
@orbit/client           fetch envelope, JSON/msgpack, gzip, SSE, WS realtime,
                        multipart, errores — ESTE PLAN
```

- El `OrbitClient` de `plan-client.md` pasa a ser un *wrapper* del
  `OrbitClient` vanilla: misma clase base, mismo constructor
  (`new OrbitClient({ baseUrl, headers?, ... })`), y React añade cache e
  invalidación encima.
- Los hooks llaman a `client.query()` / `client.mutate()` /
  `client.stream()` / `client.subscribe()`; nada de fetch dentro de
  `@orbit/react`.
- El milestone M1 de `plan-client.md` ("OrbitClient básico: fetch envelope,
  JSON + MessagePack negotiation, error mapping") **se mueve a este plan** —
  react empieza directamente en hooks + cache.

## API pública propuesta

```ts
// Creación
const client = createClient({ baseUrl: '/orbit', headers: { 'x-orbit-token': token } });
// o, equivalente (clase exportada, compatible con plan-client.md):
const client = new OrbitClient({ baseUrl: '/orbit', format: 'json' });

interface OrbitClientOptions {
  baseUrl: string;                          // p. ej. '/orbit' o 'https://api.example.com/orbit'
  headers?: Record<string, string>;         // cabeceras por defecto (función permitida para tokens dinámicos)
  format?: 'json' | 'msgpack';              // formato del request body y Accept; default 'json'
  gzip?: boolean;                           // Accept-Encoding: gzip; default true
  fetch?: typeof fetch;                     // inyectable (Node <18, tests, mocks)
  WebSocket?: typeof WebSocket;             // inyectable (Node 20 sin --experimental-websocket, RN)
  decompress?: (body: ReadableStream<Uint8Array>) => Promise<Uint8Array>; // inyectable (RN)
}

// Peticiones
client.query(query, options?): Promise<OrbitResponse>;                  // { query }
client.mutate(action, args, options?): Promise<OrbitResponse>;          // { do, args, return? }
client.execute(envelope, options?): Promise<OrbitResponse>;             // envelope completo, validado
client.stream(query, options?): AsyncIterable<OrbitStreamEvent>;        // SSE, nivel a nivel
client.subscribe(query, handler, options?): SubscriptionHandle;         // WebSocket realtime
client.upload(action, args, files, options?): Promise<OrbitResponse>;   // multipart/form-data
client.close(): void;                                                   // cierra sockets, libera recursos

interface RequestOptions {
  signal?: AbortSignal;             // cancelación
  timeoutMs?: number;               // abort automático (AbortSignal.timeout internamente)
  format?: 'json' | 'msgpack';      // override por petición
  headers?: Record<string, string>; // merge sobre los del cliente
  cache?: string;                   // spec opcional, p. ej. 'ttl=300, stale=60'
  return?: string;                  // re-query de una mutación
}

interface OrbitResponse<T = unknown> {
  data: T;
  fromCache?: boolean;
  invalidates?: string[];
  status: number;
  headers: Headers;
  raw: Response;                    // escape hatch
}

interface OrbitStreamEvent {
  level: number | 'done';
  data: unknown;
  fromCache?: boolean;
  contentType?: string;
}

// Realtime
client.subscribe('posts(status="live") { id, title }', (event, meta) => {
  // event: SubscriptionEvent (de @orbit/core) — { type, id?, data?, patch? }
  // meta:  { seq }
}, { id: 'feed' });

interface SubscriptionHandle {
  id: string;
  seq: number;                      // último seq aplicado (para resume)
  close(): void;                    // unsubscribe + cierre del socket si no quedan subs
  onStatus(cb: (s: 'connecting' | 'live' | 'reconnecting' | 'closed') => void): void;
}
```

Errores (contrato único con el spec §6):

| Caso | Tipo lanzado |
| --- | --- |
| Respuesta no-2xx con body de error JSON | `OrbitError` (de `@orbit/core`): `code`, `status`, `message`, `details`. `isOrbitError(err)` funciona. |
| Falla de red / parseo del body / timeout | `OrbitNetworkError extends Error`, con `cause` y `status` si hay respuesta. |
| Envelope inválido en cliente | `OrbitError` (`ORBIT_INVALID_QUERY`) lanzado por `validateEnvelope` antes de tocar la red. |

## Detalles de transporte (spec §7)

- **Request body:** `application/json` por defecto; `application/x-msgpack`
  (con `encodeMsgpack` de core) cuando `format: 'msgpack'`.
- **Accept:** derivado de `format` — `application/json`,
  `application/x-msgpack`, o `text/event-stream` (para `stream()`).
- **gzip:** `Accept-Encoding: gzip`; respuesta con `content-encoding: gzip` se
  descomprime con `DecompressionStream` (o el `decompress` inyectado).
- **SSE (`stream()`):** parser propio sin dependencias de los frames
  `data: {...}`; emite `{ level, data }` por frame, cierra con
  `level: 'done'`; respeta `signal` (aborta la lectura, no solo el fetch).
- **Multipart (`upload()`):** `FormData` con campo `envelope` (JSON) + un campo
  por archivo; solo para envelopes `do`. Bounds: `maxPayloadBytes` y
  `maxMultipartFields` son del servidor; el cliente solo documenta el límite.
- **WebSocket realtime:** frames JSON — `{ subscribe, id }`,
  `{ unsubscribe }`, `{ resume, after }`; eventos `{ id, seq, event }`; ack
  `{ ack }` / `{ resumed }`; heartbeats del servidor cada 30 s (spec §10).
  - Reconnect automático con backoff exponencial (`[500, 1200, 2500, 5000]`),
    single-socket por sub, y **fallback a `subscribe` fresco** cuando un
    `resume` responde `ORBIT_SUBSCRIPTION_FAILED` (lógica ya validada en
    `shared.js`).
  - Los sockets se comparten entre suscripciones del mismo `client`
    (multiplexado): `close()` de la última sub cierra el socket.
  - `{ query }` / `{ do }` sobre el socket (spec §10, con `id` de correlación
    fuera del envelope congelado) → método `client.socket().request(envelope)`.

## Estructura del paquete

```
packages/client/
  package.json          # name: "@orbit/client", dependency: @orbit/core (workspace:*)
  tsconfig.json         # igual que core (strict, NodeNext, noEmit)
  tsconfig.build.json   # igual que core (outDir dist, declarations)
  vitest.config.ts      # igual que core (coverage v8, umbrales)
  README.md
  src/
    index.ts            # barrel de exports
    client.ts           # OrbitClient + createClient (orquesta http/stream/realtime/upload)
    types.ts            # OrbitClientOptions, RequestOptions, OrbitResponse, ...
    errors.ts           # OrbitNetworkError, errorFromResponse (mapea wire → OrbitError)
    http.ts             # execute() — fetch, negotiate, gzip, msgpack, abort
    stream.ts           # parser SSE → AsyncIterable<OrbitStreamEvent>
    multipart.ts        # buildFormData(envelope, files) para upload()
    realtime.ts         # RealtimeClient — socket compartido, reconnect, resume
  test/
    client.test.ts      # API + integración con un servidor real (node:http)
    http.test.ts        # JSON/msgpack/gzip/errores/abort/timeout (fetch mock + real)
    stream.test.ts      # SSE nivel a nivel, done, abort mid-stream
    realtime.test.ts    # subscribe/ack, evento+seq, resume, fallback SUBSCRIPTION_FAILED
    multipart.test.ts   # FormData bien formado, reject envelope sin do
```

## Milestones y entregables

**M0 (medio día) — Esqueleto**
- Crear `packages/client` (package.json, tsconfigs, vitest.config, README stub).
- `pnpm-workspace.yaml` ya cubre `packages/*` — sin cambios.
- `pnpm install` y verificar que `pnpm -r run build` lo incluye.

**M1 (1 semana) — Núcleo HTTP**
- `OrbitClient` + `execute`/`query`/`mutate`: envelope JSON y MessagePack,
  validación client-side con `validateEnvelope`, mapeo de errores, `signal` +
  `timeoutMs`, headers, `gzip`.
- Tests: fetch mock + servidor real (node:http), incl. `fromCache`/`invalidates`
  del body y error contract.

**M2 (3–4 días) — Streaming SSE + multipart**
- `stream()` con parser SSE propio; `upload()` con FormData.
- Tests: TTFB de primer frame, `done`, abort mid-stream; multipart válido y
  rechazo de `query` en multipart.

**M3 (1 semana) — Realtime WebSocket**
- `subscribe()`/`unsubscribe()`/`resume` con reconnect + backoff + fallback
  `ORBIT_SUBSCRIPTION_FAILED`; multiplexado de subs por socket;
  `socket().request()` para envelopes sobre WS.
- Tests contra el `createRealtimeServer` de `@orbit/core` (el servidor ya
  existe y está probado — el cliente solo tiene que hablarle bien).

**M4 (3–4 días) — Polish, compatibilidad y adopción**
- Compatibilidad: RN (decompress inyectable, `WebSocket` nativo), Workers,
  Node 20 (`WebSocket` inyectable). Documentación en `docs/client.md`.
- Migrar `examples/web/shared.js` y el demo del book a `@orbit/client`
  (probar que los demos existentes siguen funcionando).
- README con quickstart + mini benchmark de overhead vs `fetch` crudo.

## Criterios de aceptación

- [ ] API pública tipada (TypeScript), exports ESM + `.d.ts`, `sideEffects: false`.
- [ ] Cero dependencias runtime fuera de `@orbit/core`.
- [ ] Tests: HTTP (JSON/msgpack/gzip/errores/abort), SSE, realtime
      (reconnect/resume/fallback), multipart — con umbrales de coverage como core.
- [ ] Los demos web existentes migrados a `@orbit/client` y pasando.
- [ ] `pnpm typecheck` y `pnpm test` verdes en el monorepo.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| React Native sin `DecompressionStream`/`CompressionStream` | `decompress` inyectable; documentar polyfill; gzip opt-out por cliente. |
| Node 20: `WebSocket` global no estable | Inyectar implementación (`ws` como devDependency para tests) o exigir `--experimental-websocket`; documentado. |
| Duplicación con `shared.js` durante la migración | Migración incremental demo por demo; `shared.js` se elimina al final (M4). |
| Desviación del contrato de frames WS | Tests contra el `createRealtimeServer` real de `@orbit/core`, no contra mocks. |
| Overhead del cliente vs fetch crudo | `execute()` es un solo fetch + parse; sin capas intermedias. Benchmark en M4. |

## Estrategia de lanzamiento y colaboración

- PRs pequeños por milestone: implementación + tests + README, como el resto
  del monorepo.
- Semver: empezar `0.1.0`; canary/alpha para feedback antes de que `@orbit/react`
  dependa de él (la API del cliente vanilla es el contrato que React asume).
- El API de transporte del cliente vanilla se considera **semiestable** desde M1:
  `@orbit/react` (plan-client.md) se construye sobre él, así que los cambios
  breaking después de M1 requieren bump mayor.

## Checklist de lanzamiento

- [ ] Tests y lint pasan en CI
- [ ] README con quickstart y API completa
- [ ] Demos migrados y verificados
- [ ] `docs/client.md` con transporte, compatibilidad de entornos y límites
- [ ] Changelog inicial y metadata para npm

## Siguientes pasos inmediatos

1. Confirmar este plan (y ajustar `plan-client.md` para que react *envuelva*
   este cliente en vez de implementar fetch).
2. M0: crear el esqueleto `packages/client` y abrir PR.
3. M1: `OrbitClient` + `execute` (JSON/msgpack/errores/abort) y abrir PR.

Si das OK, arranco con M0 (esqueleto del paquete) y sigo con M1.
