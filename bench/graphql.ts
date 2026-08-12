/**
 * Real GraphQL head-to-head for the benchmark suite.
 *
 * The Orbit side (run.ts) resolves fixtures through the `@orbit/core` engine;
 * this module resolves the SAME fixtures through graphql-js (v17) — parse +
 * validate + execute, the way a real GraphQL server runs. Both sides share
 * `bench/fixtures.ts` and `bench/measure.ts`, so the comparison measures
 * engines, not fixture differences.
 *
 * graphql-js is a devDependency of the BENCH HARNESS only. `@orbit/core`
 * keeps its zero-runtime-dependency contract.
 *
 * Fairness notes:
 * - B1/B3: two GraphQL numbers are reported. `naive` runs the full
 *   `graphql()` pipeline (parse + validate + execute) on every call — what a
 *   bare GraphQL server pays per request. `cached` pre-parses and pre-validates
 *   the document once (production servers — Apollo, yoga, etc. — cache parsed
 *   documents), which is the apples-to-apples equivalent of Orbit's parse LRU.
 * - B2: resolver invocations are counted (each is a data round-trip in a
 *   naive server). The spec's 1111 is the classic no-DataLoader N+1 figure;
 *   here it is MEASURED, not assumed.
 */
import DataLoader from 'dataloader';
import { buildSchema, defaultFieldResolver, execute, graphql, parse, validate } from 'graphql';
import { buildDeepNest, buildFeed, users } from './fixtures.ts';
import { gzip, measure, measureThroughput, now, pct } from './measure.ts';

// CI smoke mode: shared runners are not a benchmark machine — the deep nest is
// the most expensive scenario, so cut its sample count like every other one.
const isCI = process.env.CI === 'true';
const B9_ITERATIONS = isCI ? 40 : 200;

// ---------------------------------------------------------------------------
// B1 / B3 — Simple query: user by id
// ---------------------------------------------------------------------------

const simpleSchema = buildSchema(`
  type User {
    id: ID!
    name: String!
    email: String!
  }
  type Query {
    user(id: ID!): User
  }
`);

const simpleSource = 'query { user(id: "1") { name email } }';

const simpleRoot = {
  user: ({ id }: { id: string }) => users.find((u) => u.id === id) ?? null,
};

/**
 * B1 — P99 latency, two honest numbers like B3:
 *   naive  — full `graphql()` pipeline (parse + validate + execute) per op
 *   cached — pre-parsed + pre-validated document, executed per op (the
 *            production-server equivalent of Orbit's parse LRU)
 */
export async function graphqlB1(): Promise<{ ms: number; cachedMs: number }> {
  const document = parse(simpleSource);
  const validationErrors = validate(simpleSchema, document);
  if (validationErrors.length > 0) {
    throw new Error(`GraphQL B1 document invalid: ${validationErrors[0]!.message}`);
  }

  // Warm up (JIT + lazy schema init).
  const warm = await graphql({ schema: simpleSchema, source: simpleSource, rootValue: simpleRoot });
  if (warm.errors && warm.errors.length > 0) {
    throw new Error(`GraphQL B1 failed: ${warm.errors[0]!.message}`);
  }

  const naiveTimes = await measure(
    () => graphql({ schema: simpleSchema, source: simpleSource, rootValue: simpleRoot }),
    2000,
  );
  const cachedTimes = await measure(
    () => execute({ schema: simpleSchema, document, rootValue: simpleRoot }),
    2000,
  );
  return { ms: pct(naiveTimes, 99), cachedMs: pct(cachedTimes, 99) };
}

/**
 * B3 — Throughput, two honest numbers:
 *   naive  — full graphql() pipeline every op (bare server cost)
 *   cached — pre-parsed + pre-validated document, executed every op
 *            (production-server behavior; Orbit's parse LRU equivalent)
 */
export async function graphqlB3(): Promise<{ rpsNaive: number; rpsCached: number }> {
  const document = parse(simpleSource);
  const validationErrors = validate(simpleSchema, document);
  if (validationErrors.length > 0) {
    throw new Error(`GraphQL B3 document invalid: ${validationErrors[0]!.message}`);
  }
  const warm = await graphql({ schema: simpleSchema, source: simpleSource, rootValue: simpleRoot });
  if (warm.errors && warm.errors.length > 0) {
    throw new Error(`GraphQL B3 failed: ${warm.errors[0]!.message}`);
  }
  // The naive pipeline is slow (~1.4k RPS) — 2,000 samples is >6× the warmup
  // and keeps the harness under ~2 s for this number.
  const rpsNaive = Math.round(
    await measureThroughput(
      () => graphql({ schema: simpleSchema, source: simpleSource, rootValue: simpleRoot }),
      2000,
    ),
  );
  const rpsCached = Math.round(
    await measureThroughput(
      () => execute({ schema: simpleSchema, document, rootValue: simpleRoot }),
      30000,
    ),
  );
  return { rpsNaive, rpsCached };
}

// ---------------------------------------------------------------------------
// B2 — Deep nest (5 levels): count real resolver invocations
// ---------------------------------------------------------------------------

const nestSchema = buildSchema(`
  type User {
    id: ID!
    name: String!
    posts: [Post!]!
  }
  type Post {
    id: ID!
    title: String!
    comments: [Comment!]!
  }
  type Comment {
    id: ID!
    text: String!
    likes: [Like!]!
  }
  type Like {
    id: ID!
    emoji: String!
    likedBy: [Liker!]!
  }
  type Liker {
    id: ID!
    name: String!
  }
  type Query {
    user(id: ID!): User
  }
`);

const nestSource =
  'query { user(id: "1") { name posts { title comments { text likes { emoji likedBy { name } } } } } }';

/**
 * B2 — count every resolver invocation for the 5-level graph (naive N+1 server).
 *
 * `rootValue` only supplies the ROOT query fields in graphql-js; per-type field
 * resolvers (User.posts, Post.comments, …) are routed through `fieldResolver`,
 * which dispatches on the field name to the same resolver map — so each
 * field access models one data round-trip, exactly like a hand-written server.
 */
export async function graphqlB2(): Promise<{ resolverCalls: number }> {
  const { posts, comments, likes, likedBy } = buildDeepNest();
  const calls = { count: 0 };

  // Each resolver models one data round-trip. Root field `user` receives the
  // query args; per-type fields receive the parent object.
  const resolvers = {
    user: (_source: unknown, { id }: { id: string }) => {
      calls.count += 1;
      return users.find((u) => u.id === id) ?? null;
    },
    posts: (parent: { id: string }) => {
      calls.count += 1;
      return posts.filter((p) => p.authorId === parent.id);
    },
    comments: (parent: { id: string }) => {
      calls.count += 1;
      return comments.filter((c) => c.postId === parent.id);
    },
    likes: (parent: { id: string }) => {
      calls.count += 1;
      return likes.filter((l) => l.commentId === parent.id);
    },
    likedBy: (parent: { id: string }) => {
      calls.count += 1;
      return likedBy.filter((l) => l.likeId === parent.id);
    },
  };

  const result = await graphql({
    schema: nestSchema,
    source: nestSource,
    rootValue: resolvers,
    // Dispatch every field (root and per-type) through the resolver map;
    // leaf fields without a resolver read the property (default resolution).
    fieldResolver: (source, args, context, info) => {
      const resolver = resolvers[info.fieldName as keyof typeof resolvers];
      return typeof resolver === 'function'
        ? (resolver as (s: unknown, a: unknown) => unknown)(source, args)
        : defaultFieldResolver(source, args, context, info);
    },
  });
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL B2 failed: ${result.errors[0]!.message}`);
  }
  return { resolverCalls: calls.count };
}

// ---------------------------------------------------------------------------
// B9 — Deep nest with DataLoader: the N+1 fix, honestly measured
//
// B2 counts the naive N+1 (1,112 resolver calls). B9 measures the fix: the
// same 5-level graph through graphql-js + DataLoader, which batches sibling
// keys per level — exactly the per-level batching Orbit's contract guarantees
// — and counts the resulting DB calls. Then it measures warm-repeat latency:
// DataLoader caches WITHIN one request only (fresh loaders per request, the
// production setup), so every request still pays the 5 DB batches; Orbit with
// its cache plugin replays warm requests from memory at 0 DB calls.
// ---------------------------------------------------------------------------

const nestDocument = parse(nestSource);

/**
 * B9 — deep nest with DataLoader.
 *
 * Fresh DataLoaders per request (the correct production setup: a shared
 * loader would leak cross-request caching). `calls` counts batchFn
 * invocations — one DB batch per level, the same 5-call floor as Orbit.
 * Latency is P99 over repeated executions of a pre-parsed document.
 */
export async function graphqlB9(): Promise<{ ms: number; callsPerRequest: number }> {
  const { posts, comments, likes, likedBy } = buildDeepNest();
  const validationErrors = validate(nestSchema, nestDocument);
  if (validationErrors.length > 0) {
    throw new Error(`GraphQL B9 document invalid: ${validationErrors[0]!.message}`);
  }

  const makeExecutable = () => {
    const calls = { count: 0 };
    // Batchers model one DB batch per level (WHERE … IN (:keys)), exactly
    // like an adapter's `batch()`.
    const postsLoader = new DataLoader(async (authorIds: readonly string[]) => {
      calls.count += 1;
      return authorIds.map((id) => posts.filter((p) => p.authorId === id));
    });
    const commentsLoader = new DataLoader(async (postIds: readonly string[]) => {
      calls.count += 1;
      return postIds.map((id) => comments.filter((c) => c.postId === id));
    });
    const likesLoader = new DataLoader(async (commentIds: readonly string[]) => {
      calls.count += 1;
      return commentIds.map((id) => likes.filter((l) => l.commentId === id));
    });
    const likedByLoader = new DataLoader(async (likeIds: readonly string[]) => {
      calls.count += 1;
      return likeIds.map((id) => likedBy.filter((l) => l.likeId === id));
    });

    const resolvers = {
      user: (_source: unknown, { id }: { id: string }) => {
        calls.count += 1; // one root lookup
        return users.find((u) => u.id === id) ?? null;
      },
      posts: (parent: { id: string }) => postsLoader.load(parent.id),
      comments: (parent: { id: string }) => commentsLoader.load(parent.id),
      likes: (parent: { id: string }) => likesLoader.load(parent.id),
      likedBy: (parent: { id: string }) => likedByLoader.load(parent.id),
    };

    return {
      calls,
      run: () =>
        execute({
          schema: nestSchema,
          document: nestDocument,
          rootValue: resolvers,
          fieldResolver: (source, args, context, info) => {
            const resolver = resolvers[info.fieldName as keyof typeof resolvers];
            return typeof resolver === 'function'
              ? (resolver as (s: unknown, a: unknown) => unknown)(source, args)
              : defaultFieldResolver(source, args, context, info);
          },
        }),
    };
  };

  // Warm up (JIT + lazy schema init), then measure repeated executions.
  const warm = makeExecutable();
  const warmResult = await warm.run();
  if (warmResult.errors && warmResult.errors.length > 0) {
    throw new Error(`GraphQL B9 failed: ${warmResult.errors[0]!.message}`);
  }

  const times: number[] = [];
  let totalCalls = 0;
  for (let i = 0; i < B9_ITERATIONS; i += 1) {
    const { calls, run } = makeExecutable();
    const start = now();
    const result = await run();
    times.push(now() - start);
    totalCalls += calls.count;
    if (result.errors && result.errors.length > 0) {
      throw new Error(`GraphQL B9 failed: ${result.errors[0]!.message}`);
    }
  }
  times.sort((a, b) => a - b);
  return { ms: pct(times, 99), callsPerRequest: totalCalls / B9_ITERATIONS };
}

// ---------------------------------------------------------------------------
// B4 — Payload size: the 20-post feed through a real GraphQL response
// ---------------------------------------------------------------------------

const feedSchema = buildSchema(`
  type Author {
    id: ID!
    name: String!
    avatar: String!
    bio: String!
  }
  type FeedComment {
    id: ID!
    text: String!
    by: Author!
  }
  type FeedPost {
    id: ID!
    title: String!
    author: Author!
    body: String!
    tags: [String!]!
    views: Int!
    likes: Int!
    comments: [FeedComment!]!
    createdAt: String!
  }
  type Query {
    feed: [FeedPost!]!
  }
`);

const feedSource = `
  query {
    feed {
      id title body views likes createdAt tags
      author { id name avatar bio }
      comments { id text by { id name } }
    }
  }
`;

/** B4 — serialize a real graphql-js response for the same 20-post feed. */
export async function graphqlB4(): Promise<{ jsonKb: number; gzipKb: number }> {
  const feed = buildFeed();
  const result = await graphql({
    schema: feedSchema,
    source: feedSource,
    rootValue: { feed: () => feed },
  });
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL B4 failed: ${result.errors[0]!.message}`);
  }
  const json = new TextEncoder().encode(JSON.stringify(result));
  const compressed = await gzip(json);
  return { jsonKb: json.byteLength / 1024, gzipKb: compressed.byteLength / 1024 };
}
