/**
 * The React demo: @orbit/react over the same clips world as the TikTok feed.
 *
 * The server bundles this .jsx on the fly with esbuild (see server.ts), so the
 * demo needs no build step — react + @orbit/react resolve from the workspace.
 *
 *   useOrbitQuery        → the relational feed, TTL cache (fresh/stale)
 *   useOrbitMutation     → like/create, entity invalidation + refetch
 *   useOrbitSubscription → live clip updates over the WebSocket
 *   <OrbitDevtools />    → the cross-platform panel (web primitives here)
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  createReactClient,
  OrbitProvider,
  useOrbitMutation,
  useOrbitQuery,
  useOrbitSubscription,
} from '@orbit/react';
import { OrbitDevtools } from '@orbit/react/devtools';

const client = createReactClient({
  baseUrl: '/orbit',
  defaultTtl: 15_000,
  defaultStale: 30_000,
});

const FEED_QUERY = 'clips { id, caption, emoji, likes, creator { name }, comments { id } }';
const LIVE_QUERY = 'clips { id, likes }';

function Feed() {
  const { data, status, isFetching, fromCache, isStale, refetch } = useOrbitQuery(
    ['clips', 'feed'],
    FEED_QUERY,
    { ttl: 15_000 },
  );
  // Live likes: the WS event for a clip re-renders its card in every tab —
  // the feed query stays cached; only the counter moves in realtime.
  const [liveLikes, setLiveLikes] = useState({});
  useOrbitSubscription(['clips', 'live'], LIVE_QUERY, {
    id: 'react-clips-live',
    onEvent: (event) => {
      const clip = event.data;
      if (clip && typeof clip.likes === 'number') {
        setLiveLikes((prev) => ({ ...prev, [clip.id]: clip.likes }));
      }
    },
  });
  const clips = Array.isArray(data) ? data : [];

  const refresh = () => {
    // The mutation already evicted the feed (entity invalidation); pull it
    // back so the user sees the fresh graph immediately.
    void refetch();
  };

  return (
    <div className="feed" data-testid="react-feed">
      <Composer onPosted={refresh} />
      <div className="stats">
        <div className="stat">
          <div className="k">Query status</div>
          <div className="v" data-testid="feed-status">{status}{isStale ? ' · stale' : ''}</div>
        </div>
        <div className="stat">
          <div className="k">Cache</div>
          <div className="v" data-testid="feed-cache">
            {fromCache ? 'fromCache' : 'cold'}{isFetching ? ' · fetching' : ''}
          </div>
        </div>
        <div className="stat">
          <div className="k">Clips</div>
          <div className="v">{clips.length}</div>
        </div>
      </div>
      <button id="refetch" className="ghost" onClick={refresh}>
        ⟳ refetch (bypass cache)
      </button>
      {clips.map((clip) => (
        <ClipCard key={clip.id} clip={clip} likes={liveLikes[clip.id] ?? clip.likes} onChanged={refresh} />
      ))}
    </div>
  );
}

function ClipCard({ clip, likes, onChanged }) {
  const like = useOrbitMutation({ do: 'clips.like' }, { invalidate: ['clips', 'feed'] });
  const liked = like.isSuccess || like.isPending;
  return (
    <div className="clip" data-testid={`clip-${clip.id}`}>
      <div className="clip-emoji">{clip.emoji}</div>
      <div className="clip-body">
        <div className="clip-caption">{clip.caption}</div>
        <div className="clip-meta">
          {clip.creator?.name ?? 'guest'} · {clip.comments?.length ?? 0} comments
        </div>
      </div>
      <button
        type="button"
        className={`like ${liked ? 'liked' : ''}`}
        data-testid={`like-${clip.id}`}
        disabled={like.isPending}
        onClick={() => {
          void like
            .mutateAsync({ filter: { id: clip.id } })
            .then(onChanged)
            .catch(() => undefined);
        }}
      >
        ♥ {likes}
      </button>
    </div>
  );
}

function Composer({ onPosted }) {
  const create = useOrbitMutation({ do: 'clips.create' }, { invalidate: ['clips', 'feed'] });
  const onSubmit = (event) => {
    event.preventDefault();
    const caption = document.getElementById('caption');
    const name = document.getElementById('name');
    if (!caption.value.trim()) return;
    void create
      .mutateAsync({
        payload: { creatorName: name.value.trim() || 'guest', caption: caption.value.trim() },
      })
      .then(() => {
        caption.value = '';
        onPosted();
      })
      .catch(() => undefined);
  };
  return (
    <form className="panel composer" onSubmit={onSubmit}>
      <div className="row">
        <label>
          <span>Your name</span>
          <input id="name" type="text" defaultValue="Ada" maxLength={24} />
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          <span>Caption</span>
          <input
            id="caption"
            type="text"
            placeholder="What is the vibe?"
            autoComplete="off"
          />
        </label>
        <button type="submit" id="post" disabled={create.isPending} style={{ alignSelf: 'flex-end' }}>
          {create.isPending ? 'Posting…' : 'Post clip'}
        </button>
      </div>
      {create.isError ? <div className="toast-error">{create.error?.message}</div> : null}
    </form>
  );
}

function LiveBadge() {
  const { status, count } = useOrbitSubscription(['clips', 'live'], LIVE_QUERY, {
    id: 'react-clips-live-badge',
  });
  return (
    <div className="live" data-testid="live-badge">
      <span className={`dot ${status === 'live' ? 'on' : ''}`} /> {status} · {count} events
    </div>
  );
}

function App() {
  return (
    <>
      <div className="demo-head-row">
        <LiveBadge />
      </div>
      <Feed />
      <OrbitDevtools client={client} initialOpen={false} position="bottom-right" />
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <OrbitProvider client={client}>
    <App />
  </OrbitProvider>,
);
