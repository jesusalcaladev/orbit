# Examples

Everything you can run with Orbit, organized by where it runs.

```
examples/
├── node/                  headless console scripts (plain Node, no server to keep open)
│   ├── 01-hello.ts … 09-speed.ts     one protocol facet per file
│   ├── 10-express.ts                  the book API on Express
│   ├── 11-hono.ts                     the same book API on Hono
│   ├── 12-cloudflare-workers.ts       the same book API on Cloudflare Workers
│   ├── book/                          shared layered app (domain → engine → demo)
│   ├── run-all.ts                     runs 01–12 back to back
│   └── standalone-server.ts           zero-dependency node:http endpoint
└── web/                   interactive browser demos (one server, http://localhost:4321)
    ├── 01-chat/                       realtime chat over the WebSocket transport
    ├── 02-file-image/                 multipart file uploads
    ├── 03-mini-post/                  nested relations + mutations feed
    ├── 04-mini-auth/                  token auth through the plugin pipeline
    ├── 05-orbit-vs-graphql/           live A/B against graphql-js
    └── server.ts                      the demo server (Orbit + graphql-js, same world)
```

## Node — run headless

```bash
npm run build                    # once — examples import from dist/
node examples/node/01-hello.ts   # any single example
node examples/node/run-all.ts    # all twelve, back to back
```

`npm run examples` builds and runs the whole harness. Each file is
self-contained and prints its results — see `docs/examples.md` for the full
table of what each one demonstrates.

## Web — interactive

```bash
npm run web    # builds, then serves http://localhost:4321
```

One server hosts the real engine (`/orbit` + `/realtime`) and a real
graphql-js (`/graphql` + `/graphql-ws`) over the **same in-memory world**, so
the A/B lab races them honestly. All demos are vanilla HTML/CSS/JS — no
frameworks, no build step.

## Reference architecture

`examples/node/book/` is the layered book API that `10-express.ts`,
`11-hono.ts` and `12-cloudflare-workers.ts` serve — see
`examples/node/book/README.md` for the layering, authn/authz split and the
protocol walkthrough.
