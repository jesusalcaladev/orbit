import { createClient } from '@orbit/client';
import { esc, fmtMs, toast } from '../shared.js';

const client = createClient({ baseUrl: '/orbit' });

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const postBtn = document.getElementById('post');
const feed = document.getElementById('feed');
const lastEl = document.getElementById('last');
const countEl = document.getElementById('count');

// Stable per-browser guest fingerprint so toggling a like is consistent.
const fingerprint = localStorage.getItem('orbit-fp') ?? Math.random().toString(36).slice(2);
localStorage.setItem('orbit-fp', fingerprint);

const QUERY = 'posts { id, text, likes, author { name } }';

/** "just now", "4m ago", "2h ago", else a date. */
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

async function refresh(animate = true) {
  const t0 = performance.now();
  const { data } = await client.query(QUERY);
  lastEl.textContent = fmtMs(performance.now() - t0);
  lastEl.classList.add('good');
  const posts = data ?? [];
  countEl.textContent = String(posts.length);

  const rows = new Map();
  feed.innerHTML = '';
  if (posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-posts';
    empty.textContent = 'No posts yet — write the first one ✍️';
    feed.appendChild(empty);
  }
  for (const post of posts) {
    const el = document.createElement('div');
    el.className = 'post';
    const guest = post.author.id === 'guest';
    el.innerHTML = `
      <div class="top">
        <div class="who">${esc(post.author.name)}</div>
        ${guest ? '<span class="guest">guest</span>' : ''}
        <div class="when">${relTime(post.ts)}</div>
      </div>
      <div class="body">${esc(post.text)}</div>
      <button class="like" data-id="${esc(post.id)}">♡ <span>${post.likes}</span></button>`;
    feed.appendChild(el);
    rows.set(post.id, el);
    if (!animate) el.style.animation = 'none';
  }
  return rows;
}

postBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  try {
    await client.mutate('posts.create', {
      payload: { text, authorName: nameInput.value.trim() || 'guest' },
    });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
});

textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') postBtn.click();
});

feed.addEventListener('click', async (event) => {
  const button = event.target.closest('.like');
  if (!button) return;
  try {
    const { data } = await client.mutate('posts.like', {
      filter: { id: button.dataset.id },
      payload: { fingerprint },
    });
    const { liked, likes } = data;
    button.innerHTML = `${liked ? '♥' : '♡'} <span>${likes}</span>`;
    button.classList.toggle('liked', liked);
  } catch (error) {
    toast(error.message, true);
  }
});

refresh(false).catch((error) => toast(error.message, true));
