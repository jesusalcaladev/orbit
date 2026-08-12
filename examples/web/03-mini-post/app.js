import { esc, fmtMs, orbit, toast } from '../shared.js';

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

async function refresh(animate = true) {
  const t0 = performance.now();
  const { data } = await orbit({ query: QUERY });
  lastEl.textContent = fmtMs(performance.now() - t0);
  lastEl.classList.add('good');
  countEl.textContent = String((data ?? []).length);

  const rows = new Map();
  feed.innerHTML = '';
  for (const post of data ?? []) {
    const el = document.createElement('div');
    el.className = 'post';
    const guest = post.author.id === 'guest';
    el.innerHTML = `
      <div class="top">
        <div class="who">${esc(post.author.name)}</div>
        ${guest ? '<span class="guest">guest</span>' : ''}
        <div class="when">${new Date(post.ts).toLocaleTimeString()}</div>
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
    await orbit({
      do: 'posts.create',
      args: {
        payload: { text, authorName: nameInput.value.trim() || 'guest' },
      },
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
    const { data } = await orbit({
      do: 'posts.like',
      args: {
        filter: { id: button.dataset.id },
        payload: { fingerprint },
      },
    });
    const { liked, likes } = data;
    button.innerHTML = `${liked ? '♥' : '♡'} <span>${likes}</span>`;
    button.classList.toggle('liked', liked);
  } catch (error) {
    toast(error.message, true);
  }
});

refresh(false).catch((error) => toast(error.message, true));
