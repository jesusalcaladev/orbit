# Plan: paquete @orbit/react — hooks & cache para React / React Native (sobre @orbit/client)

Resumen ejecutivo

Crear `@orbit/react`, el cliente oficial de Orbit para aplicaciones React y
React Native. **No habla el protocolo**: todo el transporte — fetch del
envelope, negociación JSON/MessagePack, gzip, errores, abort/timeout, y más
tarde SSE y WebSocket — vive en `@orbit/client`, que este paquete envuelve por
detrás. `@orbit/react` añade la capa que falta sobre el transporte: **hooks y
cache declarativa** (TTL + stale-while-revalidate, invalidación, prefetch,
SSR con dehydrate/hydrate, persistencia opcional).

Estado: el M1 de `@orbit/client` (núcleo HTTP) ya está entregado — este plan
se apoya en él y no duplica nada de transporte.

Vista de capas

```
@orbit/react            hooks (useOrbitQuery/Mutation/Subscription), cache
                        in-memory (TTL/SWR), invalidate/prefetch,
                        dehydrate/hydrate, persistence, SSR
        │  depende de
        ▼
@orbit/client           transporte vanilla: fetch envelope, JSON/msgpack,
                        gzip, errores, abort (✅ M1) — SSE/WS/multipart (M2–M3)
        │  depende de
        ▼
@orbit/core             spec, errores, codecs, contratos congelados (✅)
```

Visión de producto

- Experiencia Hooks-first + API imperativa (similar a React Query) para
  lectura, mutación, invalidación y prefetch.
- Cache declarativa: TTL + stale-while-revalidate, invalidación impulsada por
  el protocolo (`invalidates` de las respuestas), y persistencia opcional por
  entorno (AsyncStorage/IndexedDB/localStorage).
- Streaming y realtime del protocolo expuestos a React: `stream()` y
  `subscribe()` de `@orbit/client` alimentan hooks que renderizan datos
  parciales tan pronto llegan.
- **Cero transporte en este paquete**: sin `fetch`, sin `Headers`, sin
  parsing, sin negociación, sin manejo de errores de red — todo eso se delega
  a `@orbit/client`. Un hook solo llama `client.query()` / `client.mutate()` /
  `client.stream()` / `client.subscribe()`.
- Documentación y ejemplos de producción (web + React Native), benchmarks
  objetivo frente a alternativas.

Diferenciadores clave (cómo supera a otros paquetes)

- Integración nativa con el protocolo vía `@orbit/client`: MessagePack/gzip,
  streaming SSE/WS y resume/replay en realtime, con un solo contrato de
  errores (`OrbitError` de `@orbit/core`).
- API familiar a React Query para adopción rápida, pero ligera y específica
  para Orbit (menor bundle, cero dependencias runtime externas).
- Primeras clases para React Native: AsyncStorage-backed persistence sobre un
  transporte que ya resuelve gzip inyectable y WebSocket inyectable.
- Herramientas de DX: dehydrate/hydrate para SSR, devtools hook (opcional), y
  ejemplos listos para producción.

Dependencias

| Paquete | Tipo | Rol |
| --- | --- | --- |
| `@orbit/client` | `dependencies` (workspace) | Todo el transporte: `query`/`mutate`/`execute`, y en su M2/M3 `stream`/`subscribe`/`upload`. |
| `@orbit/core` | `peerDependencies` | Tipos del protocolo (`OrbitEnvelope`, `OrbitError`, `SubscriptionEvent`) re-exportados para comodidad del consumidor. |
| `@react-native-async-storage/async-storage` | opcional, detectada en runtime | Persistencia en React Native. |

API pública propuesta (resumen)

- Provider y cliente
  - `<OrbitProvider client={orbitClient}>{children}</OrbitProvider>`
  - `const client = new OrbitClient({ baseUrl, headers?, format?, gzip?, fetch?, decompress? })`
    — **la clase `OrbitClient` es la de `@orbit/client`**, re-exportada aquí.
    `@orbit/react` la envuelve (composición o extensión) para añadirle cache
    e invalidación sin cambiar su contrato de transporte.

- Hooks
  - `useOrbitQuery(key, queryString, options)`
  - `useOrbitMutation(mutationSpec, options)`
  - `useOrbitSubscription(key, subscriptionSpec, options)`
  - `useOrbitClient()` // hook para acceder a la API imperativa

- API imperativa — capa cache (construida sobre `client.query`/`client.mutate`)
  - `client.prefetch(key, queryString, options)`
  - `client.invalidate(key | predicate)`
  - `client.setQueryData(key, data)`
  - `client.getQueryData(key)`
  - `client.dehydrate() / client.hydrate(serialized)`

> Renombrado respecto a la versión anterior del plan: `client.get(...)` pasa a
> ser `client.query(...)` (el nombre del transporte vanilla, ya implementado).
> `mutate`/`execute` también vienen del vanilla sin cambios.

Ejemplos de uso (ideales para README)

- Hook básico
  - `const { data, error, isLoading } = useOrbitQuery(['user','123'], 'user(id="123") { name, posts { id,title } }', { ttl:300 });`

- Mutation
  - `const mutation = useOrbitMutation({ do: 'user.update' }, { onSuccess: () => client.invalidate('user') });`

Detrás de cada hook hay exactamente una llamada al transporte:

```ts
// dentro de useOrbitQuery (esquemático)
const res = await client.query(queryString, { cache: spec, signal });
cache.set(key, res.data, res.fromCache, res.invalidates);
```

Cache y consistencia

- Estrategia: in-memory LRU con TTL + stale-while-revalidate. Cada consulta
  tiene una clave derivada del `key` y `queryString`.
- Invalidación: `res.invalidates` de `@orbit/client` (spec §6/§8) alimenta la
  evicción automática; `client.invalidate` para uso manual. La respuesta trae
  `fromCache` para que el hook sepa si el dato vino del cache del servidor.
- Persistencia: adapters — AsyncStorage (RN), localStorage (web), IndexedDB
  (futura). Opt-in.
- SSR: `dehydrate()` devuelve snapshot serializable; `hydrate()` lo restaura
  en el cliente. La cache de `@orbit/react` es la única que se serializa — el
  transporte vanilla no guarda estado.

React Native: requisitos y adaptaciones

- El transporte ya lo resuelve `@orbit/client` (gzip inyectable,
  WebSocket inyectable, msgpack desde `@orbit/core`) — `@orbit/react` no
  toca red ni polyfills.
- Persistencia: `@react-native-async-storage/async-storage` opcional,
  detectada en tiempo de ejecución.
- Realtime móvil: reconexión con backoff y resume por `seq` vienen del
  `subscribe()` de `@orbit/client` (M3 del vanilla); el hook solo escucha.

Milestones y entregables (sprint-oriented)

M1 (1 semana) — Esqueleto y wrapper del cliente vanilla
- Crear package `packages/react` con scripts, tsconfig, vitest y README
- `OrbitClient` de `@orbit/client` re-exportado + wrapper con opciones de
  cache (TTL default, stale) — **sin ningún fetch/negociación/parsing**
- `<OrbitProvider>` + `useOrbitClient()` con tests mínimos
- Dependencia `@orbit/client` declarada en package.json

M2 (2–3 semanas) — Hooks y cache in-memory
- Implementar `useOrbitQuery`, `useOrbitMutation`, `useOrbitSubscription`
  (esta última consume `client.subscribe` cuando el vanilla lo tenga; antes,
  polling/fallback documentado)
- Cache in-memory con TTL/stale, API imperativa (`query`/`prefetch`/`invalidate`/`setQueryData`/`getQueryData`)
- Unit tests para hooks + cache

M3 (2 semanas) — SSR, dehydrate/hydrate y persistence
- Implementar dehydrate/hydrate
- AsyncStorage/localStorage adapters + opt-in persistence
- Examples: Next.js SSR example + simple RN example

M4 (2 semanas) — Realtime + streaming + RN polish
- Wrapper de hooks sobre `client.subscribe` (resume/replay) y `client.stream`
  (render parcial) — **requiere el M2/M3 de `@orbit/client`** (SSE y
  WebSocket); si no están listos, este milestone se pospone en el orden
- RN-specific reconnection + docs

M5 (1 semana) — Docs, benchmarks, CI & release
- Documentación completa, migration guide, benchmarks vs GraphQL/React Query
  on equivalent workloads
- CI updates (build/test/lint), package metadata and release checklist

Criterios de aceptación

- API pública documentada y tipada (TypeScript). Exports ESM + .d.ts
- **Cero transporte en `@orbit/react`**: `grep` por `fetch(`/`Headers`/
  `JSON.parse` de respuestas da vacío fuera de tests — todo viaja por
  `@orbit/client`
- Test coverage razonable en hooks + cache (umbrales 100% como el resto del
  monorepo)
- Ejemplos reproducibles (web SSR, web client, RN sample) con instrucciones
- Benchmarks publicados en docs mostrando latencia y payload favorables
- CI pasa en PRs con build+test

Métricas objetivo (benchmarks)

- Overhead del wrapper vs `@orbit/client` desnudo: ≤ 5 ms por consulta cacheada
  (el vanilla ya mide su propio overhead vs fetch crudo en su M4)
- Payload y gzip/msgpack: heredados del transporte — el paquete React no
  añade bytes en la wire
- Cache hit ratio objetivo: configurable; default TTL behavior documentado

Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Duplicar transporte (fetch/errores/negociación) en el paquete React | Criterio de aceptación con grep; el wrapper solo compone `@orbit/client`. |
| Dependencia del orden de milestones del vanilla (SSE/WS en M2/M3) | M2 de React funciona con query/mutate (ya listos); realtime/streaming se mueven a M4 y se posponen si el vanilla no está listo. |
| Bundle size | `@orbit/react` solo añade hooks + cache; `@orbit/client` y `@orbit/core` son cero-dependencias. Evitar polyfills por defecto (inyección como en el vanilla). |
| Consistencia de cache | `invalidates` automático en base a entidades; documentar límites (no semantic eviction). |

Estrategia de lanzamiento y colaboración

- PRs pequeños y revisables por milestone. Cada PR cubre: implementación +
  tests + README + ejemplo mínimo.
- Etiquetado semver: empezar 0.1.0, publicar canary/alpha para feedback.
- La API del wrapper de cliente (constructor + métodos imperativos) se
  considera semiestable desde M1: es el contrato que los hooks asumen.
- CONTRIBUTING.md dentro del paquete para estándares de código, pruebas y
  benchmarks.

Checklist de lanzamiento

- [ ] Tests y lint pasan en CI
- [ ] README con quickstart y API
- [ ] Ejemplos listos y verificados
- [ ] Benchmarks reproducibles y documentación
- [ ] Changelog inicial y metadata para npm

Siguientes pasos inmediatos

1. Este plan está alineado con el layering: `@orbit/client` ya entrega su M1
   (núcleo HTTP, tests mock + servidor real, coverage 100%).
2. Crear el esqueleto `packages/react` (package.json + tsconfig + vitest +
   README stub), con `@orbit/client` como dependency.
3. Implementar M1 de este plan (wrapper del cliente + Provider) y abrir PR.

Contacto

Si das OK, creo el paquete `packages/react` y comienzo el M1 de este plan
(wrapper del `OrbitClient` vanilla + `<OrbitProvider>`). ¿Procedo?
