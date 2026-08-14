import { chatHistory, esc, orbit, orbitSocket, timeOf, toast } from '../shared.js';

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const chat = document.getElementById('chat');
const connPill = document.getElementById('conn-pill');
const countEl = document.getElementById('count');

// ---- state ----

let loaded = false; // history loaded at least once
const seen = new Set(); // rendered message ids (dedupe)
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
  const empty = chat.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML =
    '<div class="msg-system">💬</div>No messages yet. Say hello — every tab gets it instantly.';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function clearFeed() {
  chat.innerHTML = '';
  renderEmpty();
}

function addMessage(message, { mine = false } = {}) {
  if (!message || message.id == null || seen.has(String(message.id))) return null;
  seen.add(String(message.id));

  // Remove empty state once a real message lands
  const empty = chat.querySelector('.empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `message${mine ? ' message--own' : ''}`;
  const initial = (message.author || '?').slice(0, 1).toUpperCase();
  row.innerHTML = `
    <div class="avatar" style="background: ${colorOf(message.author)}">${esc(initial)}</div>
    <div class="bubble">
      <div class="author">${esc(message.author)}</div>
      <div class="text">${esc(message.text)}</div>
      <div class="timestamp">${timeOf(message.ts)}</div>
    </div>`;
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  countEl.textContent = String(seen.size);
  return row;
}

function system(line) {
  const el = document.createElement('div');
  el.className = 'message--system';
  el.textContent = line;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

// ---- connection status ----

function setStatus(state) {
  const map = {
    connecting: ['connecting…', 'warn'],
    live: ['live', 'live'],
    reconnecting: ['reconnecting…', 'err'],
  };
  const [label, cls] = map[state] ?? ['…', ''];
  connPill.className = `pill ${cls}`;
  connPill.textContent = label;
}

// ---- history ----

async function loadHistory() {
  try {
    const messages = await chatHistory();
    loaded = true;
    seen.clear();
    clearFeed();
    for (const message of messages) addMessage(message);
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
    if (!loaded || kind === 'subscribe') loadHistory();
    else if (seq > 0) {
      system('reconnected — caught up on missed messages');
    }
  },
  onEvent: (event) => {
    if (event.type === 'deleted') {
      loadHistory();
      return;
    }
    const message = event.data;
    if (!message) return;
    const isMine = pending.has(message.clientId);
    if (isMine) pending.delete(message.clientId);
    addMessage(message, { mine: isMine });
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
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- wiring ----

sendBtn.addEventListener('click', send);
clearBtn.addEventListener('click', clearRoom);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});

// ---- first paint ----

setStatus('connecting');
renderEmpty();

// Initialize inputs after first render
setTimeout(() => nameInput.focus(), 100);
