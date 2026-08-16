# Examples

Everything you can run with Orbit, organized by where it runs and by concept.

```
examples/
├── node/                  headless console scripts (plain Node, no server to keep open)
│   ├── fundamentals/      # Basic Orbit setup & first steps
│   │   └── 01-hello.ts     one protocol facet: in-memory adapter, one query
│   ├── relations/         # Relations, batching & N+1 fix
│   │   └── 02-blog-relations.ts  user → posts → comments tree, batch resolves siblings
│   ├── authentication/    # Plugin-based authz & scoping
│   │   └── 03-auth-plugin.ts     onBeforeResolve / onBeforeExecute hooks for roles + scope
│   ├── adapters/          # Custom DataAdapter from scratch
│   │   └── 04-adapter-custom.ts  hand-written resolve/batch/mutate/subscribe contract
│   ├── serialization/     # Wire formats (MsgPack, custom serializers)
│   │   ├── 05-msgpack.ts       encode/decode MsgPack over the wire
│   │   └── 07-serializer-custom.ts onBeforeSerialize for CSV output
│   ├── streaming/         # Real-time: SSE + WebSocket subscriptions
│   │   ├── 06-streaming-sse.ts text/event-stream progressive rendering
│   │   └── 08-realtime.ts      WebSocket subscriptions with reconnect + resume
│   ├── performance/       # Live speed showcase & benchmarks
│   │   └── 09-speed.ts         engine core, deep graphs, payload sizes, realtime fan-out
│   ├── frameworks/        # Framework integrations (same book API, different server)
│   │   ├── 10-express.ts       the book API on Express
│   │   ├── 11-hono.ts          the same book API on Hono
│   │   └── 12-cloudflare-workers.ts the same book API on Cloudflare Workers
│   ├── stack/             # The full first-party stack on one engine
│   │   └── 13-fullstack-mongo.ts  MongoDB + Redis cache + distributed rate-limit + auth + logging
│   ├── book/              # Shared layered book API (domain → engine → demo)
│   │   ├── data.ts             → domain: entities + in-memory repository
│   │   ├── engine.ts           → application: Orbit engine, adapters, auth policy, timing, caching
│   │   ├── demo.ts             → book demo setup
│   │   └── README.md           layering, authn/authz split & protocol walkthrough
│   ├── run-all.ts           # runs 01–13 back to back
│   └── standalone-server.ts   # zero-dependency node:http endpoint
└── web/                   interactive browser demos (one server, http://localhost:4321)
    ├── chat-realtime/       realtime chat over WebSocket (OpenAI-style)
    ├── twitter-post/        post with optional image, like Twitter
    ├── 03-mini-post/        nested relations + mutations feed
    ├── 04-mini-auth/        token auth through the plugin pipeline
    ├── 05-orbit-vs-graphql/ live A/B against graphql-js
    ├── server.ts            the demo server (Orbit + graphql-js, same world)
    ├── shared.js            shared browser helpers
    ├── styles.css           shared base styles (OpenAI-inspired)
    └── uploads/             uploaded files directory
```

## Node — run headless

```bash
npm run build                    # once — examples import from dist/
node examples/node/fundamentals/01-hello.ts    # any single example
node examples/node/run-all.ts    # all examples, back to back
```

Each file is self-contained and prints its results — see `docs/examples.md` for the full table of what each one demonstrates.

## Web — interactive

```bash
npm run web    # builds, then serves http://localhost:4321
```

One server hosts the real engine (`/orbit` + `/realtime`) and a real graphql-js (`/graphql` + `/graphql-ws`) over the **same in-memory world**, so the A/B lab races them honestly. All demos are vanilla HTML/CSS/JS — no frameworks, no build step.

## Reference architecture

`examples/node/book/` is the layered book API that `10-express.ts`, `11-hono.ts` and `12-cloudflare-workers.ts` serve — see `examples/node/book/README.md` for the layering, authn/authz split and the protocol walkthrough.