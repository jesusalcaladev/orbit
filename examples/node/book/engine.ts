/**
 * Book API — application layer (framework-agnostic).
 *
 * Everything about the API's *behavior* lives here: the Orbit engine, its
 * adapters over the in-memory repository, the authorization policy, a timing
 * plugin, client-driven caching and the realtime subscription feed. Both
 * framework entries (`../10-express.ts` and `../11-hono.ts`) build on this
 * exact engine — one API, two hosts.
 *
 * Auth split (defense in depth):
 * - **Authentication** (who is calling) happens in the framework entry,
 *   which maps the `x-api-key` header to a caller via `identifyApiKey` and
 *   injects it as `ctx.state.caller`.
 * - **Authorization** (what they may do) happens here, in the engine:
 *   the policy plugin gates reads, the mutation adapters check roles.
 */
import {
  createCachePlugin,
  createOrbit,
  ErrorCode,
  memoryAdapter,
  OrbitError,
  type Orbit,
} from '@orbit/core';
import type { OrbitPlugin } from '@orbit/core';
import { BookRepository } from './data.ts';
import type { Author, Book, Review } from './data.ts';

/** Authenticated caller identity, attached by the framework's authn layer. */
export interface Caller {
  id: string;
  role: 'admin' | 'member';
}

/** The API keys the demo knows — `admin-123` and `ana-456`. */
const API_KEYS: Record<string, Caller> = {
  'admin-123': { id: 'admin', role: 'admin' },
  'ana-456': { id: 'ana', role: 'member' },
};

/** Framework-side authentication: map an `x-api-key` to a caller identity. */
export function identifyApiKey(key: string | null | undefined): Caller | null {
  if (!key) return null;
  return API_KEYS[key] ?? null;
}

/** Require an authenticated caller, or raise the protocol's 403. */
function requireCaller(ctx: { state?: Record<string, unknown> }): Caller {
  const caller = ctx.state?.caller as Caller | undefined;
  if (!caller) {
    throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Authentication required (x-api-key header)');
  }
  return caller;
}

/** Authorization policy for reads: entity `user` is only reachable when authenticated. */
function policyPlugin(): OrbitPlugin {
  return {
    name: 'book-policy',
    hooks: {
      onBeforeResolve({ parsed, ctx }) {
        if (parsed.entity === 'user' && !ctx.state?.caller) {
          throw new OrbitError(
            ErrorCode.PERMISSION_DENIED,
            "Querying 'user' requires an x-api-key header",
          );
        }
      },
    },
  };
}

/** Observability: log each query's wall time as the pipeline finishes. */
function timingPlugin(): OrbitPlugin {
  return {
    name: 'book-timing',
    hooks: {
      onBeforeResolve({ ctx }) {
        const state = (ctx.state ??= {});
        state.timing = performance.now();
      },
      onBeforeSerialize({ ctx }) {
        const state = ctx.state as { timing?: number };
        if (state.timing === undefined) return;
        const label = ctx.envelope?.query ?? ctx.envelope?.do ?? '?';
        console.log(
          `  [orbit:book] ${label.slice(0, 52).padEnd(52)} ${(performance.now() - state.timing).toFixed(2)} ms`,
        );
      },
    },
  };
}

/**
 * Build the book API engine.
 *
 * - Relations are resolved through `ctx.parent` (book → author, author →
 *   books, book → reviews) with the N+1 fix from `memoryAdapter.batch`.
 * - Mutations validate in the repository and are wrapped into protocol
 *   errors (`ORBIT_FILTER_INVALID`, `ORBIT_PERMISSION_DENIED`, …).
 * - Client-driven caching: the cache plugin is mounted explicitly. Clients
 *   opt a request in with `x-orbit-cache: ttl=60`. Server-side eviction is
 *   automatic and precise at the entity level (spec §8): the engine evicts
 *   every cached query that reads the mutated entity, and each adapter also
 *   returns `invalidates` naming the entities it changed — so a `books`
 *   mutation refetches `books` queries while the `reviews` cache survives.
 * - Realtime: `reviews` exposes a `subscribe` hook over the repository's
 *   change notifications, so a WebSocket subscription receives review
 *   creations as events (spec §10).
 */
export function buildBookOrbit(): Orbit {
  const repo = new BookRepository();
  const cache = createCachePlugin({ headerName: 'x-orbit-cache' });

  return createOrbit({
    plugins: [cache, policyPlugin(), timingPlugin()],
    adapters: memoryAdapter([
      {
        entity: 'authors',
        resolve: ({ id }, ctx) => {
          const parent = ctx.parent;
          if (parent) return repo.authorById((parent.data as Book).authorId) ?? null;
          if (id) return repo.authorById(id) ?? null;
          return repo.allAuthors();
        },
      },
      {
        entity: 'books',
        resolve: ({ id }, ctx) => {
          const parent = ctx.parent;
          if (parent) return repo.booksByAuthor((parent.data as Author).id);
          if (id) return repo.bookById(id) ?? null;
          return repo.allBooks();
        },
        async mutate(action, args, ctx) {
          const caller = requireCaller(ctx);
          if (action === 'create') {
            if (caller.role !== 'admin') {
              throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Only admins can add books');
            }
            const payload = (args.payload ?? {}) as {
              title?: unknown;
              year?: unknown;
              authorId?: unknown;
            };
            const book = repo.createBook({
              title: String(payload.title ?? ''),
              year: Number(payload.year),
              authorId: String(payload.authorId ?? ''),
            });
            // The engine auto-evicts 'books' entries anyway; naming it here is
            // explicit and self-documenting for the client-side cache too.
            return { id: book.id, invalidates: ['books'] };
          }
          if (action === 'remove') {
            if (caller.role !== 'admin') {
              throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Only admins can remove books');
            }
            const id = String(args.filter?.id ?? '');
            if (!repo.removeBook(id)) {
              throw new OrbitError(ErrorCode.FILTER_INVALID, `No book with id '${id}'`);
            }
            return { success: true, invalidates: ['books'] };
          }
          throw new OrbitError(ErrorCode.MUTATION_FAILED, `books.${action} is not supported`);
        },
      },
      {
        entity: 'reviews',
        resolve: ({ id }, ctx) => {
          const parent = ctx.parent;
          if (parent) return repo.reviewsByBook((parent.data as Book).id);
          if (id) return repo.reviewById(id) ?? null;
          return repo.allReviews();
        },
        async mutate(action, args, ctx) {
          requireCaller(ctx); // any authenticated member may review
          if (action === 'add') {
            const payload = (args.payload ?? {}) as {
              bookId?: unknown;
              rating?: unknown;
              text?: unknown;
            };
            try {
              const review: Review = repo.addReview({
                bookId: String(payload.bookId ?? ''),
                rating: Number(payload.rating),
                text: String(payload.text ?? ''),
              });
              // Ordering note: the realtime fan-out (domain listener → hub →
              // socket) happens synchronously inside addReview, and the
              // engine's entity eviction runs in the same synchronous block —
              // before the HTTP response flushes, so a subscriber re-querying
              // after the event can never hit a stale cached read.
              return { id: review.id, invalidates: ['reviews'] };
            } catch (error) {
              // Repository errors are domain messages — map onto the protocol.
              throw new OrbitError(
                ErrorCode.FILTER_INVALID,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          throw new OrbitError(ErrorCode.MUTATION_FAILED, `reviews.${action} is not supported`);
        },
        // Realtime: a WebSocket subscriber to `reviews` receives every new
        // review as a `{ type: 'created', id, data }` event. An optional
        // `bookId` filter scopes the feed, e.g. `reviews(bookId="b2")`.
        subscribe: (filters, handler) =>
          repo.onReviewAdded((review) => {
            if (filters.bookId !== undefined && review.bookId !== filters.bookId) return;
            handler({ type: 'created', id: review.id, data: review });
          }),
      },
      {
        entity: 'user',
        resolve: (_filters, ctx) => {
          // Defense in depth: the policy hook gates this first; never serve
          // identity without an authenticated caller.
          return requireCaller(ctx);
        },
      },
    ]),
  });
}
