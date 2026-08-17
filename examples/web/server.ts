/**
 * Orbit — web demos server.
 *
 * One process serves the whole interactive showcase (open http://localhost:4321):
 *
 *   /orbit          → the Orbit handler (JSON + multipart uploads)
 *   /realtime       → Orbit's zero-dependency WebSocket transport
 *   /graphql        → graphql-js over HTTP (the A/B competition)
 *   /graphql-ws     → graphql-ws subscriptions (the A/B competition)
 *   /uploads/*      → files uploaded through the file-image demo
 *   /*              → the HTML/CSS/JS demos (examples/web)
 *
 * The two protocols share the SAME in-memory world (the chat message bus),
 * so the orbit-vs-graphql demo races them honestly.
 *
 * Run:  npm run web   (builds first, then serves on http://localhost:4321)
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
import {
  ErrorCode,
  OrbitError,
  createCachePlugin,
  createOrbit,
  createRealtimeServer,
} from '@orbit/core';
import type {
  DataAdapter,
  Filters,
  MutationArgs,
  MutationResult,
  OrbitContext,
  OrbitPlugin,
  SubscriptionEvent,
} from '@orbit/core';
import { buildSchema, execute, graphql, subscribe } from 'graphql';

// ---------------------------------------------------------------------------
// Shared world
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  author: string;
  text: string;
  ts: number;
  /** Client-generated correlation id, echoed back so round-trips can be measured. */
  clientId?: string;
}

interface User {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
  token?: string;
}

interface Post {
  id: string;
  authorId: string;
  authorName?: string;
  text: string;
  likes: number;
  likedBy: string[];
  ts: number;
}

interface Image {
  id: string;
  filename: string;
  size: number;
  type: string;
  ts: number;
}

let messageSeq = 0;
const messages: ChatMessage[] = [];
const chatHandlers = new Set<(event: SubscriptionEvent) => void>();
const emitChat = (event: SubscriptionEvent) => {
  for (const handler of chatHandlers) handler(event);
};

const users: User[] = [
  {
    id: '1',
    username: 'ada',
    name: 'Ada',
    passwordHash: hashPassword('orbit'),
  },
  {
    id: '2',
    username: 'grace',
    name: 'Grace',
    passwordHash: hashPassword('orbit'),
  },
];

let postSeq = 0;
const posts: Post[] = [
  {
    id: 'p1',
    authorId: '1',
    text: 'First post! Orbit serves the whole graph in one round-trip. 🚀',
    likes: 12,
    likedBy: ['2'],
    ts: Date.now() - 3_600_000,
  },
  {
    id: 'p2',
    authorId: '2',
    text: 'The N+1 fix is a contract, not magic: same-entity siblings batch into one call.',
    likes: 8,
    likedBy: ['1'],
    ts: Date.now() - 2_400_000,
  },
];

let imageSeq = 0;
const images: Image[] = [];
const UPLOADS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'uploads');

/** The stored file name for an image — server-side single source of truth. */
function storedUrl(image: Image): string {
  return `/uploads/${image.id}${extname(image.filename) || '.bin'}`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Orbit: adapters + auth plugin + engine + realtime
// ---------------------------------------------------------------------------

const chatAdapter: DataAdapter = {
  entity: 'chat',
  resolve: (filters: Filters) => {
    if (filters.id) return messages.find((m) => m.id === filters.id);
    if (filters.author) return messages.filter((m) => m.author === filters.author);
    return messages;
  },
  mutate: (action: string, args: MutationArgs): MutationResult => {
    if (action === 'send') {
      const payload = (args.payload ?? {}) as {
        author?: string;
        text?: string;
        clientId?: string;
      };
      const message: ChatMessage = {
        id: String(++messageSeq),
        author: payload.author || 'anon',
        text: payload.text ?? '',
        ts: Date.now(),
        ...(payload.clientId ? { clientId: payload.clientId } : {}),
      };
      messages.push(message);
      emitChat({ type: 'created', id: message.id, data: message, patch: { ...message } });
      return { id: message.id };
    }
    if (action === 'clear') {
      messages.length = 0;
      // Both protocols hear the reset; clients refetch history on this event.
      emitChat({ type: 'deleted', id: 'all', data: null, patch: {} });
      return { id: 'all' };
    }
    throw new Error(`unknown chat action '${action}'`);
  },
  subscribe: (_filters: Filters, handler: (event: SubscriptionEvent) => void) => {
    chatHandlers.add(handler);
    return () => chatHandlers.delete(handler);
  },
};

const userAdapter: DataAdapter = {
  entity: 'user',
  resolve: (filters: Filters, ctx: OrbitContext) => {
    if (filters.me === 'true') {
      const caller = ctx.state?.caller as User | undefined;
      if (!caller) {
        throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Login required');
      }
      return { id: caller.id, username: caller.username, name: caller.name };
    }
    if (filters.id) {
      const user = users.find((u) => u.id === filters.id);
      if (!user) return null;
      return { id: user.id, username: user.username, name: user.name };
    }
    return users.map((u) => ({ id: u.id, username: u.username, name: u.name }));
  },
  mutate: (action: string, args: MutationArgs, ctx: OrbitContext): MutationResult => {
    const { filter, payload } = args;
    if (action === 'register') {
      const { username, name, password } = (payload ?? {}) as Record<string, string>;
      if (!username || !password) {
        throw new OrbitError(ErrorCode.FILTER_INVALID, 'username and password are required');
      }
      if (users.some((u) => u.username === username)) {
        throw new OrbitError(ErrorCode.FILTER_INVALID, `username '${username}' is taken`);
      }
      const user: User = {
        id: String(users.length + 1),
        username,
        name: name || username,
        passwordHash: hashPassword(password),
      };
      users.push(user);
      const token = issueToken(user);
      return { id: user.id, token };
    }
    if (action === 'login') {
      const { username, password } = (filter ?? {}) as Record<string, string>;
      const user = users.find((u) => u.username === username);
      if (!user || !verifyPassword(password ?? '', user.passwordHash)) {
        throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Invalid credentials');
      }
      return { id: user.id, token: issueToken(user) };
    }
    if (action === 'logout') {
      const caller = ctx.state?.caller as User | undefined;
      if (caller?.token) {
        const user = users.find((u) => u.id === caller.id);
        if (user) delete user.token;
      }
      return { id: caller?.id };
    }
    throw new Error(`unknown user action '${action}'`);
  },
};

function issueToken(user: User): string {
  const token = `orbit-${randomBytes(24).toString('hex')}`;
  user.token = token;
  return token;
}

/** Resolves the `author { … }` relation of a post (a role-shaped adapter). */
const authorAdapter: DataAdapter = {
  entity: 'author',
  resolve: (_filters: Filters, ctx: OrbitContext) => {
    const post = ctx.parent?.data as Post | undefined;
    if (!post) return null;
    const user = users.find((u) => u.id === post.authorId);
    if (user) return { id: user.id, username: user.username, name: user.name };
    // Guest authors: the post carries its display name.
    return post.authorName ? { id: post.authorId, name: post.authorName } : null;
  },
};

const postAdapter: DataAdapter = {
  entity: 'posts',
  resolve: (filters: Filters, ctx: OrbitContext) => {
    let list = posts;
    if (ctx.parent) {
      const parentId = (ctx.parent.data as { id?: string } | undefined)?.id;
      if (parentId) list = list.filter((p) => p.authorId === parentId);
    }
    if (filters.id) return list.find((p) => p.id === filters.id) ?? null;
    if (filters.authorId) list = list.filter((p) => p.authorId === filters.authorId);
    return list;
  },
  mutate: (action: string, args: MutationArgs, ctx: OrbitContext): MutationResult => {
    const caller = ctx.state?.caller as User | undefined;
    const payload = (args.payload ?? {}) as Record<string, string>;
    if (action === 'create') {
      // Public demo: guests may post with a display name; a logged-in caller
      // (x-orbit-token header) is used when present.
      const post: Post = {
        id: `p${++postSeq}`,
        authorId: caller?.id ?? 'guest',
        ...(caller ? {} : { authorName: payload.authorName?.trim() || 'guest' }),
        text: payload.text ?? '',
        likes: 0,
        likedBy: [],
        ts: Date.now(),
      };
      posts.unshift(post);
      return { id: post.id };
    }
    if (action === 'like') {
      const post = posts.find((p) => p.id === args.filter?.id);
      if (!post) throw new OrbitError(ErrorCode.FILTER_INVALID, 'Post not found');
      const voter = caller?.id ?? `guest-${payload.fingerprint ?? 'anon'}`;
      const liked = post.likedBy.includes(voter);
      if (liked) {
        post.likedBy = post.likedBy.filter((id) => id !== voter);
        post.likes -= 1;
      } else {
        post.likedBy.push(voter);
        post.likes += 1;
      }
      return { id: post.id, likes: post.likes, liked: !liked };
    }
    if (action === 'clear') {
      posts.length = 0;
      return { id: 'all' };
    }
    throw new Error(`unknown post action '${action}'`);
  },
};

const imageAdapter: DataAdapter = {
  entity: 'image',
  resolve: (filters: Filters) => {
    const withUrl = (image: Image) => ({
      id: image.id,
      filename: image.filename,
      size: image.size,
      type: image.type,
      url: storedUrl(image),
    });
    if (filters.id) {
      const image = images.find((i) => i.id === filters.id);
      return image ? withUrl(image) : null;
    }
    return [...images].reverse().map(withUrl);
  },
  mutate: async (
    action: string,
    args: MutationArgs,
    ctx: OrbitContext,
  ): Promise<MutationResult> => {
    if (action === 'upload') {
      const file = ctx.files?.upload;
      if (!file) {
        throw new OrbitError(ErrorCode.FILTER_INVALID, 'No file in field "upload" (multipart)');
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const image: Image = {
        id: `img${++imageSeq}`,
        filename: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        ts: Date.now(),
      };
      const filePath = join(UPLOADS_DIR, storedUrl(image).slice('/uploads/'.length));
      await mkdir(UPLOADS_DIR, { recursive: true });
      await writeFile(filePath, buffer);
      images.push(image);
      return { id: image.id, url: storedUrl(image), size: buffer.byteLength };
    }
    if (action === 'remove') {
      const image = images.find((i) => i.id === args.filter?.id);
      if (image) images.splice(images.indexOf(image), 1);
      return { id: args.filter?.id };
    }
    throw new Error(`unknown image action '${action}'`);
  },
};

// ---------------------------------------------------------------------------
// TikTok world: clips — the relational feed + realtime likes + cache demo
// ---------------------------------------------------------------------------

interface ClipComment {
  id: string;
  author: string;
  text: string;
  ts: number;
}

interface Clip {
  id: string;
  creatorId: string;
  creatorName: string;
  handle: string;
  caption: string;
  emoji: string;
  likes: number;
  likedBy: string[];
  comments: ClipComment[];
  ts: number;
}

let clipSeq = 0;
let commentSeq = 0;
const clips: Clip[] = [
  {
    id: 'c1',
    creatorId: '1',
    creatorName: 'Ada',
    handle: '@ada',
    caption: 'Ship it — the whole graph in one round-trip. 🚀',
    emoji: '🎬',
    likes: 42,
    likedBy: ['2', 'guest-demo'],
    comments: [
      { id: 'm1', author: 'grace', text: 'the N+1 fix hits different', ts: Date.now() - 300_000 },
      {
        id: 'm2',
        author: 'linus',
        text: '5 queries instead of 1,112 — insanity',
        ts: Date.now() - 120_000,
      },
    ],
    ts: Date.now() - 3_000_000,
  },
  {
    id: 'c2',
    creatorId: '2',
    creatorName: 'Grace',
    handle: '@grace',
    caption: 'Summit day. No signal, no problem — the feed replayed 500 patches on resume. 🏔️',
    emoji: '🏔️',
    likes: 28,
    likedBy: ['1'],
    comments: [
      {
        id: 'm3',
        author: 'maria',
        text: 'delta sync is the killer feature',
        ts: Date.now() - 900_000,
      },
    ],
    ts: Date.now() - 1_800_000,
  },
  {
    id: 'c3',
    creatorId: 'guest',
    creatorName: 'Linus',
    handle: '@linus',
    caption: 'Cache with entity eviction: like something, the next cold hit knows. 🍜',
    emoji: '🍜',
    likes: 15,
    likedBy: ['1', '2'],
    comments: [],
    ts: Date.now() - 600_000,
  },
  {
    id: 'c4',
    creatorId: 'guest',
    creatorName: 'María',
    handle: '@maria',
    caption: 'One WebSocket, every tab hears the like instantly. 🎹',
    emoji: '🎹',
    likes: 9,
    likedBy: [],
    comments: [],
    ts: Date.now() - 120_000,
  },
];

const clipHandlers = new Set<(event: SubscriptionEvent) => void>();
const emitClip = (event: SubscriptionEvent) => {
  for (const handler of clipHandlers) handler(event);
};

const clipsAdapter: DataAdapter = {
  entity: 'clips',
  resolve: (filters: Filters) => {
    if (filters.id) return clips.find((c) => c.id === filters.id) ?? null;
    if (filters.creatorId) return clips.filter((c) => c.creatorId === filters.creatorId);
    // Newest first — a feed, not an archive.
    return [...clips].reverse();
  },
  mutate: (action: string, args: MutationArgs, ctx: OrbitContext): MutationResult => {
    const caller = ctx.state?.caller as User | undefined;
    const payload = (args.payload ?? {}) as Record<string, string>;
    if (action === 'create') {
      const creatorName = payload.creatorName?.trim() || 'guest';
      const clip: Clip = {
        id: `c${++clipSeq}`,
        creatorId: caller?.id ?? 'guest',
        creatorName,
        handle: payload.handle?.trim()
          ? `@${payload.handle.trim().replace(/^@/, '')}`
          : `@${creatorName.toLowerCase().replace(/\s+/g, '_')}`,
        caption: payload.caption ?? '',
        emoji: payload.emoji ?? '🎬',
        likes: 0,
        likedBy: [],
        comments: [],
        ts: Date.now(),
      };
      clips.unshift(clip);
      emitClip({ type: 'created', id: clip.id, data: clip, patch: { ...clip } });
      return { id: clip.id };
    }
    if (action === 'like') {
      const clip = clips.find((c) => c.id === args.filter?.id);
      if (!clip) throw new OrbitError(ErrorCode.FILTER_INVALID, 'Clip not found');
      const voter = caller?.id ?? `guest-${payload.fingerprint ?? 'anon'}`;
      const liked = clip.likedBy.includes(voter);
      if (liked) {
        clip.likedBy = clip.likedBy.filter((v) => v !== voter);
        clip.likes -= 1;
      } else {
        clip.likedBy.push(voter);
        clip.likes += 1;
      }
      emitClip({
        type: 'updated',
        id: clip.id,
        data: clip,
        patch: { id: clip.id, likes: clip.likes, likedBy: clip.likedBy },
      });
      return { id: clip.id, likes: clip.likes, liked: !liked };
    }
    if (action === 'comment') {
      const clip = clips.find((c) => c.id === args.filter?.id);
      if (!clip) throw new OrbitError(ErrorCode.FILTER_INVALID, 'Clip not found');
      const comment: ClipComment = {
        id: `m${++commentSeq}`,
        author: (payload.author ?? '').trim() || 'anon',
        text: payload.text ?? '',
        ts: Date.now(),
      };
      clip.comments.push(comment);
      emitClip({
        type: 'updated',
        id: clip.id,
        data: clip,
        patch: { id: clip.id, comments: clip.comments },
      });
      return { id: clip.id, commentId: comment.id };
    }
    throw new Error(`unknown clips action '${action}'`);
  },
  subscribe: (_filters: Filters, handler: (event: SubscriptionEvent) => void) => {
    clipHandlers.add(handler);
    return () => clipHandlers.delete(handler);
  },
};

/** Resolves the `creator { … }` relation of a clip (a role-shaped adapter). */
const creatorAdapter: DataAdapter = {
  entity: 'creator',
  resolve: (_filters: Filters, ctx: OrbitContext) => {
    const clip = ctx.parent?.data as Clip | undefined;
    if (!clip) return null;
    return { id: clip.creatorId, name: clip.creatorName, handle: clip.handle };
  },
};

/** Resolves the `comments { … }` relation of a clip (a role-shaped adapter). */
const commentsAdapter: DataAdapter = {
  entity: 'comments',
  resolve: (_filters: Filters, ctx: OrbitContext) => {
    const clip = ctx.parent?.data as Clip | undefined;
    if (!clip) return null;
    return clip.comments;
  },
};

/** Reads `x-orbit-token` and stamps `ctx.state.caller` for the pipeline. */
function authPlugin(): OrbitPlugin {
  return {
    name: 'web-auth',
    hooks: {
      onBeforeParse({ ctx }) {
        const token = ctx.headers?.get('x-orbit-token');
        if (!token) return;
        const user = users.find((u) => u.token === token);
        if (user) (ctx.state ??= {}).caller = user;
      },
      // Gate protected queries in the hook pipeline itself.
      onBeforeResolve({ parsed, ctx }) {
        if (parsed.entity === 'user' && parsed.filters.me === 'true' && !ctx.state?.caller) {
          throw new OrbitError(ErrorCode.PERMISSION_DENIED, 'Login required');
        }
      },
    },
  };
}

const orbit = createOrbit({
  adapters: [
    chatAdapter,
    userAdapter,
    postAdapter,
    authorAdapter,
    imageAdapter,
    clipsAdapter,
    creatorAdapter,
    commentsAdapter,
  ],
  plugins: [createCachePlugin(), authPlugin()],
});

const realtime = createRealtimeServer(orbit, { path: '/realtime' });

// ---------------------------------------------------------------------------
// GraphQL: the honest A/B competition on the SAME chat bus
// ---------------------------------------------------------------------------

const schema = buildSchema(`
  type Message {
    id: ID!
    author: String!
    text: String!
    ts: Float!
    clientId: String
  }

  type Query {
    messages: [Message!]!
  }

  type Mutation {
    sendMessage(author: String!, text: String!, clientId: String): Message!
  }

  type Subscription {
    messageSent: Message!
  }
`); /**
 * AsyncIterator over the shared chat bus (feeds graphql-js `subscribe`).
 *
 * graphql-js runs the subscription root resolver ONCE to obtain the source
 * stream, then runs it AGAIN for every event with `source = event`. With a
 * plain root function the second pass sees `source.messageSent === undefined`
 * and rejects the payload — so each emitted value is wrapped as
 * `{ messageSent: message }` (the standard pubsub payload-wrapper pattern),
 * which the default field resolver unwraps for the event payload.
 */
function chatIterator(): AsyncIterable<{ messageSent: ChatMessage }> {
  type ChatPayload = { messageSent: ChatMessage };
  let resolveNext: ((message: ChatPayload) => void) | undefined;
  const queue: ChatPayload[] = [];
  const handler = (event: SubscriptionEvent) => {
    const message = event.data as ChatMessage;
    const wrapped = { messageSent: message };
    if (resolveNext) {
      resolveNext(wrapped);
      resolveNext = undefined;
    } else {
      queue.push(wrapped);
    }
  };
  chatHandlers.add(handler);
  return {
    [Symbol.asyncIterator](): AsyncIterator<ChatPayload> {
      return {
        next: async (): Promise<IteratorResult<ChatPayload>> => {
          const value =
            queue.length > 0
              ? queue.shift()
              : await new Promise<ChatPayload>((r) => {
                  resolveNext = r;
                });
          return { value: value!, done: false };
        },
        return: async (): Promise<IteratorResult<ChatPayload>> => {
          chatHandlers.delete(handler);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const rootValue = {
  messages: () => messages,
  sendMessage: ({
    author,
    text,
    clientId,
  }: {
    author: string;
    text: string;
    clientId?: string;
  }) => {
    const message: ChatMessage = {
      id: String(++messageSeq),
      author: author || 'anon',
      text: text ?? '',
      ts: Date.now(),
      ...(clientId ? { clientId } : {}),
    };
    messages.push(message);
    emitChat({ type: 'created', id: message.id, data: message, patch: { ...message } });
    return message;
  },
};

const wsServer = new WebSocketServer({ noServer: true });
// biome-ignore lint/correctness/useHookAtTopLevel: graphql-ws's `useServer` is not a React hook.
useServer(
  {
    schema,
    execute,
    subscribe,
    // graphql-ws v6 keys `roots` by operation type (lowercase) — this is the
    // rootValue handed to graphql-js's `subscribe` for the subscription.
    roots: {
      subscription: { messageSent: () => chatIterator() },
    },
  },
  wsServer,
);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(WEB_DIR, '..', '..');
/** Built ESM directories served under /vendor for the demo import maps. */
const VENDOR_PACKAGES: Record<string, string> = {
  '@orbit/client': 'packages/client/dist',
  '@orbit/core': 'packages/core/dist',
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Bundle a React demo (`.jsx`) on the fly: esbuild resolves the workspace
 * packages from the root node_modules and inlines react + @orbit/react.
 * `@orbit/core` is aliased to its browser barrel — the same redirect the
 * import maps use — so the Node-only realtime transport never ships to the
 * browser. Returns the ESM text (with an inline sourcemap).
 */
async function bundleJsx(filePath: string): Promise<string> {
  const result = await build({
    entryPoints: [filePath],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'browser',
    target: ['es2020'],
    sourcemap: 'inline',
    write: false,
    logLevel: 'silent',
    alias: {
      '@orbit/core': resolve(ROOT_DIR, 'packages/core/dist/browser.js'),
    },
  });
  return result.outputFiles?.[0]?.text ?? '';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    // Orbit handler: JSON envelopes + multipart uploads.
    if (req.method === 'POST' && url.pathname === '/orbit') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const request = new Request(`http://${req.headers.host ?? 'localhost'}/orbit`, {
        method: 'POST',
        headers: {
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(req.headers['x-orbit-token']
            ? { 'x-orbit-token': req.headers['x-orbit-token'] as string }
            : {}),
        },
        body,
      });
      const response = await orbit.handler(request);
      // The engine never emits an x-orbit-cache-key header — cache keys are
      // opaque server-side hashes and the fromCache flag travels in the body.
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      res.end(await response.text());
      return;
    }

    // Auth: token-issuing routes (the engine echoes only { success, id } for
    // mutations by contract, so the app — which owns the world — reads the
    // freshly issued token back and hands it to the browser).
    if (
      req.method === 'POST' &&
      (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register')
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { username, password, name } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        username?: string;
        password?: string;
        name?: string;
      };
      const isLogin = url.pathname === '/api/auth/login';
      const result = await orbit.execute({
        do: isLogin ? 'user.login' : 'user.register',
        args: isLogin
          ? { filter: { username: username ?? '', password: password ?? '' } }
          : { payload: { username: username ?? '', password: password ?? '', name } },
      });
      const id = (result.data as { id?: string } | undefined)?.id;
      const user = users.find((u) => u.id === id);
      if (result.status >= 400 || !user) {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: 'ORBIT_AUTH_FAILED', message: 'Invalid credentials' } }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: user.id,
          username: user.username,
          name: user.name,
          token: user.token,
        }),
      );
      return;
    }

    // GraphQL over HTTP.
    if (req.method === 'POST' && url.pathname === '/graphql') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const result = await graphql({
        schema,
        source: query ?? '',
        rootValue,
        variableValues: variables,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Vendor: the built ESM of the workspace packages, served for the import
    // maps in the demo HTML. The demos stay bundler-free — the map points
    // `@orbit/client` / `@orbit/core` at these files, which resolve their own
    // relative imports the same way.
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      // Scoped packages: the specifier is '@scope/name/file', so the first
      // two segments identify the package and the rest is the file.
      const segments = decodeURIComponent(url.pathname.slice('/vendor/'.length)).split('/');
      const pkg = segments.slice(0, 2).join('/');
      const rest = segments.length > 2 ? segments.slice(2).join('/') : 'index.js';
      const distDir = VENDOR_PACKAGES[pkg];
      if (!distDir) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 — unknown vendor package');
        return;
      }
      const filePath = normalize(resolve(ROOT_DIR, distDir, rest));
      if (!filePath.startsWith(resolve(ROOT_DIR, distDir)) || !existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 — not found. Did you run `npm run build` first?');
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(data);
      return;
    }

    // Uploaded files.
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const safe = resolve(WEB_DIR, `.${url.pathname}`);
      if (!safe.startsWith(UPLOADS_DIR) || !existsSync(safe)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const data = await readFile(safe);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(safe).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(data);
      return;
    }

    // Static demos. React demos (`.jsx`) are bundled on the fly with esbuild
    // so the showcase needs no build step — `npm run web` is enough.
    if (req.method === 'GET') {
      let requested = url.pathname === '/' ? '/index.html' : url.pathname;
      if (requested.endsWith('/')) requested += 'index.html';
      const filePath = normalize(join(WEB_DIR, requested));
      if (!filePath.startsWith(WEB_DIR) || !existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 — not found. Is this the web demos server? (npm run web)');
        return;
      }
      const isJsx = extname(filePath).toLowerCase() === '.jsx';
      if (isJsx) {
        let output: string;
        try {
          output = await bundleJsx(filePath);
        } catch (bundleError) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`500 — esbuild failed: ${(bundleError as Error).message}`);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(output);
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(data);
      return;
    }

    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Method not allowed');
  } catch (error) {
    // Log the real cause server-side; never echo internal details (which may
    // embed secrets) to the client — the wire carries the generic shape.
    console.error('[orbit:web] unhandled error:', error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'ORBIT_INTERNAL', message: 'Internal server error' } }),
    );
  }
});

server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path === '/realtime') {
    realtime.handleUpgrade(request, socket, head);
  } else if (path === '/graphql-ws') {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  } else {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  }
});

const PORT = Number(process.env.PORT ?? 4321);
server.listen(PORT, () => {
  console.log(`🛰  Orbit web demos → http://localhost:${PORT}`);
  console.log(`    /realtime  Orbit WebSocket   |  /graphql-ws  GraphQL subscriptions`);
  console.log(`    /orbit     Orbit handler     |  /graphql     graphql-js HTTP`);
  console.log('    open the index to browse all demos (chat, uploads, posts, auth, A/B).');
});
