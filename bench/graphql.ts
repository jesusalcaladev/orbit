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
import { buildSchema, defaultFieldResolver, execute, graphql, parse, validate } from 'graphql';
import { buildDeepNest, buildFeed, users } from './fixtures.ts';
import { gzip, measure, measureThroughput, pct } from './measure.ts';

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
