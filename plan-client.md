# Plan: paquete @orbit/react — cliente React & React Native (versión ampliada)

Resumen ejecutivo

Crear `@orbit/react`, el cliente oficial y de referencia para Orbit en aplicaciones React y React Native. Objetivo: ser el cliente más sencillo, robusto y completo del ecosistema — enfocarse en ergonomía, rendimiento (caching, streaming), compatibilidad con el protocolo (MessagePack, gzip, SSE/WebSocket) y experiencia de desarrollador (DX: TypeScript, hooks, toolings, ejemplos). El paquete debe facilitar migraciones desde React Query y ofrecer capacidades avanzadas (SSR, rehidratación, prefetch, persistencia opcional).

Visión de producto

- Experiencia Hooks-first + API imperativa (similar a React Query) para lectura, mutación, invalidación y prefetch.
- Cache declarativa: TTL + stale-while-revalidate, invalidación impulsada por el protocolo (invalidates), y persistencia opcional por entorno (AsyncStorage/IndexedDB/localStorage).
- Streaming y realtime nativos del protocolo — soporte para renderizar datos parciales tan pronto como llegan.
- Opera con estricta compatibilidad a @orbit/core: reusar spec, errores y contratos.
- Documentación y ejemplos de producción (web + React Native), benchmarks objetivo frente a alternativas.

Diferenciadores clave (cómo supera a otros paquetes)

- Integración nativa con el protocolo: MessagePack/gzip, streaming SSE/WS y soporte para resume/replay en realtime.
- API familiar a React Query para adopción rápida, pero ligera y específica para Orbit (menor bundle, cero dependencias runtime externas).
- Primeras clases para React Native: AsyncStorage-backed persistence, WebSocket móviles con reconexión y optimizaciones de payload.
- Herramientas de DX: dehydrate/hydrate para SSR, devtools hook (opcional), y ejemplos listos para producción.

API pública propuesta (resumen)

- Provider y cliente
  - <OrbitProvider client={orbitClient}>{children}</OrbitProvider>
  - const client = new OrbitClient({ baseUrl, headers?, transport?, serializer? })

- Hooks
  - useOrbitQuery(key, queryString, options)
  - useOrbitMutation(mutationSpec, options)
  - useOrbitSubscription(key, subscriptionSpec, options)
  - useOrbitClient() // hook para acceder API imperativa

- API imperativa (client)
  - client.get(queryString, options)
  - client.prefetch(key, queryString, options)
  - client.invalidate(key | predicate)
  - client.setQueryData(key, data)
  - client.getQueryData(key)
  - client.dehydrate() / client.hydrate(serialized)

Ejemplos de uso (ideales para README)

- Hook básico
  - const { data, error, isLoading } = useOrbitQuery(['user','123'], 'user(id="123") { name, posts { id,title } }', { ttl:300 });

- Mutation
  - const mutation = useOrbitMutation({ do: 'user.update' }, { onSuccess: () => client.invalidate('user') });

Cache y consistencia

- Estrategia: in-memory LRU con TTL + stale-while-revalidate. Cada consulta tiene una clave derivada del `key` y `queryString`.
- Invalidación: recibir `invalidates` desde mutaciones/adapter y exponer `client.invalidate` para uso manual.
- Persistencia: adapters: AsyncStorage (RN), localStorage (web), IndexedDB (futura). Persistencia opt-in.
- SSR: `dehydrate()` devuelve snapshot serializable; `hydrate()` lo restaura en el cliente.

React Native: requisitos y adaptaciones

- Dependencias runtime: opcional `@react-native-async-storage/async-storage` detectada en tiempo de ejecución.
- WebSocket: reconexión exponible con backoff y resume token si el adapter lo soporta.
- Polyfills: MessagePack y fetch si entorno lo requiere (documentar cómo habilitar). No forzar en bundle.

Milestones y entregables (sprint-oriented)

M1 (1–2 semanas) — Esqueleto y OrbitClient básico
- Crear package `packages/react` con scripts, CI básico y README
- Implementar OrbitClient: fetch envelope, JSON + MessagePack negotiation, error mapping
- Tests unitarios mínimos

M2 (2–3 semanas) — Hooks y cache in-memory
- Implementar useOrbitQuery, useOrbitMutation, useOrbitSubscription
- Cache in-memory con TTL/stale, API imperativa (get/prefetch/invalidate)
- Unit tests para hooks + cache

M3 (2 semanas) — SSR, dehydrate/hydrate y persistence
- Implementar dehydrate/hydrate
- AsyncStorage/localStorage adapters + opt-in persistence
- Examples: Next.js SSR example + simple RN example

M4 (2 semanas) — Realtime + streaming + RN polish
- WebSocket subscription wrapper con resume/replay
- SSE/streaming render helper para hooks
- RN-specific reconnection + docs

M5 (1 semana) — Docs, benchmarks, CI & release
- Documentación completa, migration guide, benchmarks vs GraphQL/React Query on equivalent workloads
- CI updates (build/test lint), package metadata and release checklist

Criterios de aceptación

- API pública documentada y tipada (TypeScript). Exports ESM + .d.ts
- Test coverage razonable en core (query hooks, cache, client)
- Ejemplos reproducibles (web SSR, web client, RN sample) con instrucciones
- Benchmarks publicados en docs mostrando latencia y payload favorables
- CI pasa en PRs con build+test

Métricas objetivo (benchmarks)

- Tiempo al primer byte para simple root query ≤ 10 ms overhead vs core handler
- Payload y gzip/msgpack: tamaño neto ≤ competing libs when serialized
- Cache hit ratio objetivo: configurable; default TTL behavior documentado

Riesgos y mitigaciones

- RN networking/compatibility: documentar fallbacks y probar en simulador; modularizar adaptadores.
- Bundle size: mantener núcleo ligero, publicar `@orbit/react` con peerDependency a `@orbit/core` y evitar grandes polyfills por defecto.
- Consistencia de cache: invalidates automatic en base a entidades; documentar límites (no semantic eviction).

Estrategia de lanzamiento y colaboración

- Hacer PRs pequeños y revisables por milestone. Cada PR cubre: implementación + tests + README + ejemplo mínimo.
- Etiquetado semver: empezar 0.1.0, publicar canary/alpha para feedback.
- Añadir sección CONTRIBUTING.md dentro del paquete para estándares de código, pruebas y benchmarks.

Checklist de lanzamiento

- [ ] Tests y lint pasan en CI
- [ ] README con quickstart y API
- [ ] Ejemplos listos y verificados
- [ ] Benchmarks reproducibles y documentación
- [ ] Changelog inicial y metadata para npm

Siguientes pasos inmediatos

1. Confirmar el plan (ya lo has editado — gracias).
2. Crear el esqueleto `packages/react` + package.json + tsconfig + export en pnpm-workspace.
3. Implementar M1 (OrbitClient básico) y abrir PR.

Contacto

Si das OK, creo el paquete `packages/react` y el primer TODO lo marco como "in_progress" y comienzo M1. ¿Procedo con la creación del esqueleto ahora?