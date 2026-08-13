import { chatHistory, esc, fmtMs, orbit, orbitSocket, statsOf, timeOf, toast } from '../shared.js';

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const feed = document.getElementById('feed');
const connEl = document.getElementById('conn');
const connDot = document.getElementById('conn-dot');
const connPill = document.getElementById('conn-pill');
const feedHint = document.getElementById('feed-hint');
const lastEl = document.getElementById('last');
const avgEl = document.getElementById('avg');
const p95El = document.getElementById('p95');
const countEl = document.getElementById('count');

// ---- state ----

let loaded = false; // history loaded at least once
const seen = new Set(); // rendered message ids (dedupe)
const samples = []; // round-trip latencies (mine), capped
const colors = new Map();
const palette = ['#6ee7b7', '#38bdf8', '#a78bfa', '#f5b544', '#f15d6c', '#f472b6', '#34d399'];

function colorOf(author) {
  if (!colors.has(author)) {
    let hash = 0;
    for (const ch of author) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    colors.set(author, palette[hash % palette.length]);
  }
  return colors.get(author);
}

// ---- rendering ----

function renderEmpty() {
  if (feed.children.length === 0) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML =
      '<div class="big">💬</div>No messages yet.<br />Say hello — every tab gets it instantly.';
    feed.appendChild(el);
  }
}

function clearFeed() {
  feed.innerHTML = '';
  renderEmpty();
}

function addMessage(message, { mine = false, latency } = {}) {
  if (!message || message.id == null || seen.has(String(message.id))) return null;
  seen.add(String(message.id));
  // Drop the empty-state placeholder once a real message lands.
  const empty = feed.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `msg${mine ? ' mine' : ''}`;
  const initial = (message.author || '?').slice(0, 1).toUpperCase();
  row.innerHTML = `
    <div class="avatar" style="background: ${colorOf(message.author)}">${esc(initial)}</div>
    <div class="bubble">
      <div class="who">${esc(message.author)}</div>
      <div class="text">${esc(message.text)}</div>
      <div class="when">
        <span>${timeOf(message.ts)}</span>
        ${latency !== undefined ? `<span class="rt">↺ ${fmtMs(latency)}</span>` : ''}
      </div>
    </div>`;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
  countEl.textContent = String(seen.size);
  return row;
}

function system(line) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = line;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ---- latency stats ----

function pushLatency(ms) {
  samples.push(ms);
  if (samples.length > 200) samples.shift();
  lastEl.textContent = fmtMs(ms);
  lastEl.classList.add('good');
  const s = statsOf(samples);
  avgEl.textContent = fmtMs(s.avg);
  p95El.textContent = fmtMs(s.p95);
}

// ---- connection status ----

function setStatus(state) {
  const map = {
    connecting: ['connecting…', 'warn'],
    live: ['live', 'live'],
    reconnecting: ['reconnecting…', 'err'],
  };
  const [label, cls] = map[state] ?? ['…', ''];
  connEl.textContent = label;
  connEl.className = cls ? `v ${cls}` : 'v';
  connDot.className = `dot ${cls}`;
  connPill.className = `pill ${cls}`;
  connPill.textContent = label;
  feedHint.textContent = state === 'live' ? 'live' : 'reconnecting…';
}

// ---- history ----

async function loadHistory() {
  try {
    const messages = await chatHistory();
    loaded = true;
    seen.clear();
    clearFeed();
    for (const message of messages) addMessage(message);
    if (messages.length > 0)
      system(`joined — ${messages.length} message${messages.length === 1 ? '' : 's'} in the room`);
    countEl.textContent = String(seen.size);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- socket ----

// Round-trip correlation: client-generated id → the event that echoes it.
const pending = new Map();
let nextClientId = 1;

void orbitSocket({
  subscribe: 'chat { id, author, text, ts, clientId }',
  onStatus: (state) => setStatus(state),
  onAck: (_id, kind, seq) => {
    // First connect, or a fresh subscribe after the resume window expired:
    // history is the source of truth. Resume reconnects replay the gap.
    if (!loaded || kind === 'subscribe') loadHistory();
    else if (seq > 0) {
      system('reconnected — caught up on missed messages');
      feedHint.textContent = 'live';
    }
  },
  onEvent: (event) => {
    // The bus was cleared — refetch the (now empty) history.
    if (event.type === 'deleted') {
      loadHistory();
      return;
    }
    const message = event.data;
    if (!message) return;
    const isMine = pending.has(message.clientId);
    let latency;
    if (isMine) {
      const t0 = pending.get(message.clientId);
      pending.delete(message.clientId);
      latency = performance.now() - t0;
      pushLatency(latency);
    }
    addMessage(message, { mine: isMine, latency });
  },
  onError: (error) => toast(`${error.code}: ${error.message}`, true),
});

// ---- actions ----

async function send() {
  const text = textInput.value.trim();
  if (!text) return;
  const clientId = `c${nextClientId++}`;
  pending.set(clientId, performance.now());
  textInput.value = '';
  textInput.focus();
  try {
    await orbit({
      do: 'chat.send',
      args: { payload: { author: nameInput.value.trim() || 'anon', text, clientId } },
    });
  } catch (error) {
    pending.delete(clientId);
    toast(error.message, true);
  }
}

async function clearRoom() {
  try {
    await orbit({ do: 'chat.clear', args: {} });
    seen.clear();
    clearFeed();
    countEl.textContent = '0';
    samples.length = 0;
    lastEl.textContent = '—';
    avgEl.textContent = '—';
    p95El.textContent = '—';
  } catch (error) {
    toast(error.message, true);
  }
}

sendBtn.addEventListener('click', send);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});
clearBtn.addEventListener('click', clearRoom);

// First paint: empty-state + connection is handled by the socket callbacks.
setStatus('connecting');
renderEmpty();
