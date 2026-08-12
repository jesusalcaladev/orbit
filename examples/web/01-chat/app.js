import { esc, fmtMs, orbit, orbitSocket, toast } from '../shared.js';

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const sendBtn = document.getElementById('send');
const feed = document.getElementById('feed');
const connEl = document.getElementById('conn');
const lastEl = document.getElementById('last');
const countEl = document.getElementById('count');

let count = 0;
const colors = new Map();
const palette = ['#6ee7b7', '#38bdf8', '#a78bfa', '#fbbf24', '#f87171', '#f472b6', '#34d399'];

function colorOf(author) {
  if (!colors.has(author)) {
    let hash = 0;
    for (const ch of author) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    colors.set(author, palette[hash % palette.length]);
  }
  return colors.get(author);
}

function addMessage(message, mine) {
  const row = document.createElement('div');
  row.className = `msg${mine ? ' mine' : ''}`;
  const initial = (message.author || '?').slice(0, 1).toUpperCase();
  row.innerHTML = `
    <div class="avatar" style="background: ${colorOf(message.author)}">${esc(initial)}</div>
    <div class="bubble">
      <div class="who">${esc(message.author)}</div>
      <div>${esc(message.text)}</div>
      <div class="when">${new Date(message.ts).toLocaleTimeString()}
        ${mine ? `<span class="rt" data-rt></span>` : ''}
      </div>
    </div>`;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
  count += 1;
  countEl.textContent = String(count);
  if (mine) {
    row.dataset.clientId = message.clientId ?? '';
    return row;
  }
  return null;
}

// Round-trip correlation: client-generated id → the event that echoes it.
const pending = new Map();
let nextClientId = 1;

// The socket lives for the whole page session (onopen/onmessage below).
void orbitSocket({
  subscribe: 'chat { id, author, text, ts, clientId }',
  onAck: () => {
    connEl.textContent = 'live';
    connEl.classList.add('good');
  },
  onEvent: (event) => {
    const message = event.data;
    if (!message) return;
    const isMine = pending.has(message.clientId);
    if (isMine) {
      const t0 = pending.get(message.clientId);
      pending.delete(message.clientId);
      const roundTrip = performance.now() - t0;
      lastEl.textContent = fmtMs(roundTrip);
      lastEl.classList.add('good');
      const row = addMessage(message, true);
      if (row) {
        const rt = row.querySelector('[data-rt]');
        if (rt) rt.textContent = `round-trip ${fmtMs(roundTrip)}`;
      }
    } else {
      addMessage(message, false);
    }
  },
  onError: (error) => toast(`${error.code}: ${error.message}`, true),
});

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

sendBtn.addEventListener('click', send);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});
