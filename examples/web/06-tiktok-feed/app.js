/**
 * 06 · TikTok-style feed — the relational + realtime + cache demo.
 *
 * One query pulls the whole feed — clips, their creators and their comments —
 * through the adapter contract in a single round-trip. Likes and comments are
 * mutations; the server broadcasts the updated clip over the WebSocket and
 * every tab re-renders the card from the event (no refetch). The feed query
 * carries `cache: 'ttl=15'`; a like invalidates the `clips` entity, so the
 * next reload is cold and sees the new count (entity eviction, not cache-flush).
 */
import { createClient } from '@orbit/client';
import { esc, fmtMs, toast } from '../shared.js';

const client = createClient({ baseUrl: '/orbit' });

const FEED_QUERY =
  'clips { id, caption, emoji, likes, likedBy, ts, creator { name, handle }, comments { id, author, text, ts } }';

const feedEl = document.getElementById('feed');
const countEl = document.getElementById('count');
const lastEl = document.getElementById('last');
const cacheEl = document.getElementById('cache');
const eventsEl = document.getElementById('events');
const connPill = document.getElementById('conn-pill');
const nameInput = document.getElementById('name');
const emojiSelect = document.getElementById('emoji');
const captionInput = document.getElementById('caption');
const postBtn = document.getElementById('post');
const reloadBtn = document.getElementById('reload');

// ---- guest identity (per-browser, so likes are stable across reloads) ----

let fingerprint = localStorage.getItem('tiktok-fp');
if (!fingerprint) {
  fingerprint = Math.random().toString(36).slice(2, 10);
  localStorage.setItem('tiktok-fp', fingerprint);
}

// ---- state ----

const byId = new Map(); // clip id -> rendered card element
let eventCount = 0;
const palette = ['#6ee7b7', '#38bdf8', '#a78bfa', '#f5b544', '#f15d6c', '#f472b6', '#34d399'];

function colorOf(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Normalize a clip into the view shape. Query results already carry
 * `creator`/`comments` (resolved through the adapter contract); realtime
 * events carry the raw record (`creatorName`/`handle`), so both render the
 * same card.
 */
function viewOf(clip) {
  return {
    id: clip.id,
    caption: clip.caption,
    emoji: clip.emoji,
    likes: clip.likes,
    likedBy: clip.likedBy ?? [],
    ts: clip.ts,
    creator: clip.creator ?? {
      name: clip.creatorName ?? 'guest',
      handle: clip.handle ?? '',
    },
    comments: clip.comments ?? [],
  };
}

// ---- rendering ----

function commentRow(comment) {
  return `<div class="comment">
    <span class="comment-who">${esc(comment.author)}</span>
    <span class="comment-text">${esc(comment.text)}</span>
  </div>`;
}

function renderClip(clip) {
  const liked = clip.likedBy.includes(fingerprint);
  const el = document.createElement('article');
  el.className = 'clip';
  el.dataset.id = clip.id;
  el.innerHTML = `
    <div class="tile">${esc(clip.emoji)}</div>
    <div class="clip-body">
      <div class="creator">
        <div class="avatar" style="background: ${colorOf(clip.creator.name)}">
          ${esc(clip.creator.name.slice(0, 1).toUpperCase())}
        </div>
        <div class="meta">
          <div class="name">${esc(clip.creator.name)} <span class="handle">${esc(clip.creator.handle)}</span></div>
          <div class="when">${timeAgo(clip.ts)}</div>
        </div>
      </div>
      <p class="caption">${esc(clip.caption)}</p>
      <div class="actions">
        <button class="like${liked ? ' liked' : ''}" data-id="${esc(clip.id)}">${liked ? '♥' : '♡'} ${clip.likes}</button>
        <button class="cmts" data-id="${esc(clip.id)}">💬 ${clip.comments.length}</button>
      </div>
      ${clip.comments.length ? `<div class="comments">${clip.comments.map(commentRow).join('')}</div>` : ''}
    </div>`;
  el.querySelector('.like').addEventListener('click', () => like(clip.id));
  return el;
}

function upsert(clip, { prepend = false } = {}) {
  const fresh = renderClip(clip);
  const existing = byId.get(clip.id);
  if (existing) {
    existing.replaceWith(fresh);
  } else if (prepend) {
    feedEl.prepend(fresh);
  } else {
    feedEl.appendChild(fresh);
  }
  byId.set(clip.id, fresh);
  countEl.textContent = String(byId.size);
}

function renderEmpty() {
  feedEl.innerHTML = '<div class="empty-posts">No clips yet — post the first one. 🎬</div>';
}

// ---- connection status ----

function setStatus(state) {
  const map = {
    connecting: ['connecting…', 'warn'],
    live: ['live', 'live'],
    reconnecting: ['reconnecting…', 'err'],
  };
  const [label, cls] = map[state] ?? ['…', ''];
  connPill.className = `v pill ${cls}`;
  connPill.textContent = label;
}

// ---- feed (cache: 'ttl=15' — reloads hit the server cache until a mutation
//      invalidates the `clips` entity) ----

async function loadFeed() {
  const t0 = performance.now();
  try {
    const { data, fromCache } = await client.query(FEED_QUERY, { cache: 'ttl=15' });
    const ms = performance.now() - t0;
    lastEl.textContent = fmtMs(ms);
    cacheEl.textContent = fromCache ? 'warm ♻' : 'cold';
    cacheEl.classList.toggle('warm', fromCache);
    const list = Array.isArray(data) ? data : [];
    byId.clear();
    feedEl.innerHTML = '';
    if (list.length === 0) renderEmpty();
    for (const clip of list) upsert(viewOf(clip));
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- realtime: every like/comment/create is a live event; the card
//      re-renders from the event payload (no refetch, no optimistic guess) ----

const sub = client.subscribe(
  FEED_QUERY,
  (event) => {
    const clip = event.data;
    if (!clip?.id) return;
    eventCount += 1;
    eventsEl.textContent = String(eventCount);
    upsert(viewOf(clip), { prepend: event.type === 'created' });
  },
  { onError: (error) => toast(`${error.code}: ${error.message}`, true) },
);
sub.onStatus((state) => setStatus(state));

// ---- actions ----

async function like(id) {
  try {
    await client.mutate('clips.like', {
      filter: { id },
      payload: { fingerprint },
    });
  } catch (error) {
    toast(error.message, true);
  }
}

async function postClip() {
  const caption = captionInput.value.trim();
  if (!caption) {
    toast('Write a caption first', true);
    return;
  }
  try {
    await client.mutate('clips.create', {
      payload: {
        creatorName: nameInput.value.trim() || 'guest',
        caption,
        emoji: emojiSelect.value,
      },
    });
    captionInput.value = '';
    captionInput.focus();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- wiring ----

postBtn.addEventListener('click', postClip);
reloadBtn.addEventListener('click', loadFeed);
captionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') postClip();
});

// ---- first paint ----

setStatus('connecting');
loadFeed();
