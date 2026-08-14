import { esc, orbit, toast } from '../shared.js';

const textInput = document.getElementById('text');
const fileInput = document.getElementById('file');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const timeline = document.getElementById('timeline');
const statusEl = document.getElementById('status');
const connPill = document.getElementById('conn-pill');
const countEl = document.getElementById('count');

// ---- state ----

const seen = new Set();

// ---- rendering ----

function renderEmpty() {
  const empty = timeline.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML = '<div class="msg-system">💬</div>No posts yet. Share something!';
  timeline.appendChild(el);
  timeline.scrollTop = timeline.scrollHeight;
}

function clearFeed() {
  timeline.innerHTML = '';
  renderEmpty();
}

function addPost(post) {
  if (!post || seen.has(String(post.id))) return null;
  seen.add(String(post.id));

  const empty = timeline.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'post-row';
  const isGuest = !post.authorId || post.authorId.startsWith('guest');
  const authorName = isGuest ? post.authorName || 'Anon' : post.authorName || post.authorId;
  const avatarColor = isGuest ? '#6366f1' : '#10a37f';
  const initial = authorName.slice(0, 1).toUpperCase();

  row.innerHTML = `
    <div class="post-avatar" style="color: ${avatarColor}">${esc(initial)}</div>
    <div class="post-content">
      <div class="post-header">
        <div class="post-author">${esc(authorName)}</div>
        <div class="post-time">${timeOfAgo(post.ts)}</div>
      </div>
      ${post.text ? `<p class="post-text">${esc(post.text)}</p>` : ''}
    </div>`;
  timeline.appendChild(row);
  timeline.scrollTop = timeline.scrollHeight;
  countEl.textContent = String(seen.size);
  return row;
}

function timeOfAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// ---- connection status ----

function setStatus(state) {
  const map = {
    connecting: ['connecting…', 'warn'],
    live: ['live', 'live'],
    reconnecting: ['reconnecting…', 'err'],
  };
  const [label, cls] = map[state] ?? ['…', ''];
  statusEl.textContent = label;
  connPill.className = `pill ${cls}`;
  connPill.textContent = label;
}

// ---- history ----

async function loadHistory() {
  try {
    const { data } = await orbit({ query: 'posts { id, text, authorName, authorId, ts }' });
    seen.clear();
    clearFeed();
    const posts = Array.isArray(data) ? data : [];
    for (const post of posts) addPost(post);
    system(`${posts.length} post${posts.length === 1 ? '' : 's'} shared`);
    countEl.textContent = String(seen.size);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- socket ----

void orbitSocket({
  subscribe: 'posts { id, text, authorName, authorId, ts }',
  onStatus: (state) => setStatus(state),
  onEvent: (event) => {
    if (event.type === 'deleted') {
      loadHistory();
      return;
    }
    const post = event.data;
    if (!post) return;
    addPost(post);
  },
  onError: (error) => toast(`${error.code}: ${error.message}`, true),
});

// ---- actions ----

async function send() {
  const text = textInput.value.trim();
  const file = fileInput.files[0];
  textInput.value = '';
  fileInput.value = '';
  textInput.focus();

  // Always create a text post if there's text
  if (text) {
    try {
      await orbit({
        do: 'posts.create',
        args: { payload: { text } },
      });
      await loadHistory();
    } catch (error) {
      toast(error.message, true);
    }
  }
  // If there's a file but no text, just upload the image
  else if (file) {
    try {
      const success = await uploadFile(file);
      if (success) {
        // After upload, reload to show any realtime events
        await loadHistory();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }
  // If there's nothing, show a toast
  else {
    toast('Enter text or select a file to post', true);
  }
}

async function uploadFile(file) {
  if (!file.type.startsWith('image/')) {
    toast(`'${file.name}' is not an image`, true);
    return false;
  }

  const form = new FormData();
  form.set('envelope', JSON.stringify({ do: 'image.upload', args: {} }));
  form.set('upload', file);

  try {
    const res = await fetch('/orbit', { method: 'POST', body: form });
    const body = await res.json();
    if (body.error) {
      toast(`${body.error.code}: ${body.error.message}`, true);
      return false;
    }
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

async function clearRoom() {
  try {
    await orbit({ do: 'posts.clear', args: {} });
    seen.clear();
    clearFeed();
    countEl.textContent = '0';
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- wiring ----

const attachBtn = document.getElementById('attach');

sendBtn.addEventListener('click', send);
clearBtn.addEventListener('click', clearRoom);
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) send();
});

// ---- first paint ----

setStatus('connecting');
renderEmpty();

setTimeout(() => textInput.focus(), 100);
