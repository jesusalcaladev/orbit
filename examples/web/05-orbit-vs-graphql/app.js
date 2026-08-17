import { createClient } from '@orbit/client';
import { esc, fmtBytes, fmtMs, statsOf } from '../shared.js';

const client = createClient({ baseUrl: '/orbit' });

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const raceBtn = document.getElementById('race');
const simBtn = document.getElementById('sim');
const benchBtn = document.getElementById('bench');
const clearBtn = document.getElementById('clear');
const roundsInput = document.getElementById('rounds');
const progressEl = document.getElementById('progress');
const winnerEl = document.getElementById('winner');
const orbitAvgEl = document.getElementById('orbit-avg');
const gqlAvgEl = document.getElementById('gql-avg');
const winsEl = document.getElementById('wins');
const orbitFeed = document.getElementById('orbit-feed');
const gqlFeed = document.getElementById('gql-feed');
const orbitStatus = document.getElementById('orbit-status');
const gqlStatus = document.getElementById('gql-status');
const orbitDot = document.getElementById('orbit-dot');
const gqlDot = document.getElementById('gql-dot');
const orbitCrown = document.getElementById('orbit-crown');
const gqlCrown = document.getElementById('gql-crown');
const orbitLast = document.getElementById('orbit-last');
const orbitAvg2 = document.getElementById('orbit-avg2');
const orbitP95 = document.getElementById('orbit-p95');
const orbitPayload = document.getElementById('orbit-payload');
const gqlLast = document.getElementById('gql-last');
const gqlAvg2 = document.getElementById('gql-avg2');
const gqlP95 = document.getElementById('gql-p95');
const gqlPayload = document.getElementById('gql-payload');
const barOrbit = document.getElementById('bar-orbit');
const barGql = document.getElementById('bar-gql');
const vsRatio = document.getElementById('vs-ratio');
const racelogEl = document.getElementById('racelog');
const scoresEl = document.getElementById('scores');
const chartEl = document.getElementById('chart');

// ---- state ----

let clientSeq = 0;
const nextClientId = () => `r${++clientSeq}`;

/** One race = one clientId fired at both protocols. */
const races = new Map();
const orbitSamples = [];
const gqlSamples = [];
const wins = { orbit: 0, gql: 0 };
const orbitBytes = [];
const gqlBytes = [];
const seenOrbit = new Set();
const seenGql = new Set();

let activeMode = null; // 'sim' | 'bench' | null
let simCount = 0;
let simTarget = 0;
let simTimer = null;
let benchTotal = 0;
let benchSettled = 0;
let benchDone = false;
let entriesSeen = 0;

const ORBIT_SUB = 'chat { id, author, text, ts, clientId }';
const GQL_SUB = 'subscription { messageSent { id author text ts clientId } }';
const GQL_MUT = `mutation ($author: String!, $text: String!, $clientId: String) {
  sendMessage(author: $author, text: $text, clientId: $clientId) { id }
}`;
const BENCH_PREFIX = '[bench]';
const FEED_CAP = 60;
const RACE_TIMEOUT_MS = 5000;

const SIM_LINES = [
  'hola from orbit 👋',
  'same bus, two protocols',
  'watch the latency tags',
  'lower is better 🏎️',
  'one round-trip per graph',
  'realtime on a contract',
  'p95 says it all',
  'no N+1, no resolver soup',
  'push, don’t poll 📡',
  'zero-dependency transport',
  'the adapter is the graph',
  'fan-out in microseconds',
];

// ---- sockets ----

function setStatus(side, state) {
  const dot = side === 'orbit' ? orbitDot : gqlDot;
  const status = side === 'orbit' ? orbitStatus : gqlStatus;
  const cls = state === 'live' ? 'live' : state === 'reconnecting' ? 'err' : 'warn';
  dot.className = `dot ${cls}`;
  status.textContent = state;
}

// Orbit side — the client reconnects automatically (subscribe → resume).
const orbitSub = client.subscribe(
  ORBIT_SUB,
  (event) => {
    const data = event.data;
    if (data) settle('orbit', data);
  },
  { id: 'ab-feed', onError: () => setStatus('orbit', 'error') },
);
orbitSub.onStatus((state) => setStatus('orbit', state));
orbitSub.onAck(() => setStatus('orbit', 'live'));

// GraphQL side — graphql-ws protocol with manual reconnect.
let gqlWs = null;
let gqlRetryDelay = 800;
const gqlClosed = false;

function connectGql() {
  if (gqlClosed) return;
  setStatus('gql', 'connecting');
  gqlWs = new WebSocket(`ws://${location.host}/graphql-ws`, 'graphql-transport-ws');
  gqlWs.onopen = () => gqlWs.send(JSON.stringify({ type: 'connection_init' }));
  gqlWs.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'connection_ack') {
      gqlRetryDelay = 800;
      gqlWs.send(JSON.stringify({ type: 'subscribe', id: '1', payload: { query: GQL_SUB } }));
      setStatus('gql', 'live');
    } else if (frame.type === 'next' && frame.id === '1') {
      const data = frame.payload.data?.messageSent;
      if (data) settle('gql', data);
    } else if (frame.type === 'error') {
      setStatus('gql', 'error');
    }
  };
  gqlWs.onclose = () => {
    if (gqlClosed) return;
    setStatus('gql', 'reconnecting');
    const delay = gqlRetryDelay;
    gqlRetryDelay = Math.min(gqlRetryDelay * 1.6, 5000);
    setTimeout(connectGql, delay);
  };
}
connectGql();

// ---- race mechanics ----

function raceEntry(clientId, text) {
  const entry = {
    clientId,
    t0: performance.now(),
    text,
    orbit: undefined,
    gql: undefined,
    done: false,
    winner: undefined,
  };
  races.set(clientId, entry);
  // A lost event must never wedge a simulation — drop the race after a while.
  entry.timer = setTimeout(() => {
    if (!entry.done) {
      entry.done = true;
      races.delete(clientId);
      if (activeMode === 'bench' && text.startsWith(BENCH_PREFIX)) bumpBenchProgress();
    }
  }, RACE_TIMEOUT_MS);
  return entry;
}

function settle(side, data) {
  const clientId = data.clientId;
  if (clientId == null) return;
  const entry = races.get(clientId);
  if (!entry || entry.done) return;
  const first = entry[side] === undefined;
  entry[side] = performance.now() - entry.t0;
  if (first) entry.winner = side;
  if (!entry.text.startsWith(BENCH_PREFIX)) {
    markFeed(side, data, entry[side], first ? '🏆' : '');
  }
  if (entry.orbit !== undefined && entry.gql !== undefined) finishRace(entry);
}

function finishRace(entry) {
  entry.done = true;
  races.delete(entry.clientId);
  clearTimeout(entry.timer);
  orbitSamples.push(entry.orbit);
  gqlSamples.push(entry.gql);
  if (orbitSamples.length > 300) orbitSamples.shift();
  if (gqlSamples.length > 300) gqlSamples.shift();
  wins[entry.winner] += 1;

  if (entry.text.startsWith(BENCH_PREFIX)) {
    bumpBenchProgress();
  } else {
    addRaceLog(entry);
  }
  updateStats();
}

function bumpBenchProgress() {
  if (activeMode !== 'bench' || benchDone) return;
  benchSettled += 1;
  progressEl.textContent = `${benchSettled}/${benchTotal}`;
  if (benchSettled >= benchTotal) finishBench();
}

// ---- sending ----

async function orbitSend(clientId, text) {
  const res = await fetch('/orbit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      do: 'chat.send',
      args: { payload: { author: nameInput.value.trim() || 'anon', text, clientId } },
    }),
  });
  const bytes = Number(res.headers.get('content-length')) || 0;
  if (bytes > 0) {
    orbitBytes.push(bytes);
    if (orbitBytes.length > 50) orbitBytes.shift();
  }
  return res;
}

async function gqlSend(clientId, text) {
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: GQL_MUT,
      variables: { author: nameInput.value.trim() || 'anon', text, clientId },
    }),
  });
  const bytes = Number(res.headers.get('content-length')) || 0;
  if (bytes > 0) {
    gqlBytes.push(bytes);
    if (gqlBytes.length > 50) gqlBytes.shift();
  }
  return res;
}

/** Fire one message at BOTH protocols in the same tick. */
async function race(text) {
  const clientId = nextClientId();
  raceEntry(clientId, text);
  await Promise.allSettled([orbitSend(clientId, text), gqlSend(clientId, text)]);
  updateStats();
}

// ---- rendering ----

function markFeed(side, message, latency, crown) {
  const feed = side === 'orbit' ? orbitFeed : gqlFeed;
  const seen = side === 'orbit' ? seenOrbit : seenGql;
  if (message.id == null || seen.has(String(message.id))) return;
  seen.add(String(message.id));
  const empty = feed.querySelector('.empty-feed');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'mini';
  el.innerHTML = `
    <span class="m-who">${esc(message.author)}:</span>
    <span class="m-text">${esc(message.text)}</span>
    ${latency !== undefined && latency !== null ? `<span class="m-rt">${fmtMs(latency)}</span>` : ''}
    ${crown ? '<span class="m-crown">🏆</span>' : ''}`;
  feed.appendChild(el);
  while (feed.children.length > FEED_CAP) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}
function addRaceLog(entry) {
  const empty = racelogEl.querySelector('.no-rows');
  if (empty) empty.remove();
  let table = racelogEl.querySelector('table');
  if (!table) {
    table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>round</th><th>message</th><th>A · orbit</th><th>B · graphql</th><th>winner</th></tr>
      </thead>`;
    racelogEl.appendChild(table);
    table.appendChild(document.createElement('tbody'));
  }
  const tbody = table.querySelector('tbody') ?? table.tBodies?.[0] ?? table;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mono">#${entriesSeen}</td>
    <td class="m" title="${esc(entry.text)}">${esc(entry.text)}</td>
    <td class="orbit-cell">${fmtMs(entry.orbit)}</td>
    <td class="gql-cell">${fmtMs(entry.gql)}</td>
    <td class="w ${entry.winner === 'orbit' ? 'o' : 'g'}">${entry.winner === 'orbit' ? 'A' : 'B'}</td>`;
  tbody.prepend(tr);
  while (tbody.children.length > 60) tbody.removeChild(tbody.lastChild);
  tr.scrollIntoView?.({ block: 'nearest' });
}

// ---- actions ----

async function sendBoth() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  entriesSeen += 1;
  await race(text);
}

raceBtn.addEventListener('click', sendBoth);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendBoth();
});

// ---- simulation ----

function pickSimLine() {
  return SIM_LINES[Math.floor(Math.random() * SIM_LINES.length)];
}

function stopSim() {
  activeMode = null;
  clearTimeout(simTimer);
  simBtn.textContent = '▶ Simulate realtime';
  simBtn.disabled = false;
  benchBtn.disabled = false;
  if (!benchDone) progressEl.textContent = 'idle';
}

async function stepSim() {
  if (activeMode !== 'sim') return;
  entriesSeen += 1;
  await race(pickSimLine());
  simCount += 1;
  progressEl.textContent = `sim ${simCount}/${simTarget}`;
  if (simCount >= simTarget) {
    stopSim();
    progressEl.textContent = 'sim done';
    return;
  }
  simTimer = setTimeout(stepSim, 450 + Math.random() * 750);
}

simBtn.addEventListener('click', () => {
  if (activeMode === 'sim') {
    stopSim();
    progressEl.textContent = 'sim stopped';
    return;
  }
  simTarget = Math.min(200, Math.max(1, Number(roundsInput.value) || 20));
  simCount = 0;
  activeMode = 'sim';
  benchBtn.disabled = true;
  simBtn.textContent = '■ Stop';
  progressEl.textContent = `sim 0/${simTarget}`;
  stepSim();
});

// ---- benchmark ----

function finishBench() {
  if (benchDone) return;
  benchDone = true;
  activeMode = null;
  progressEl.textContent = 'bench done';
  simBtn.disabled = false;
  benchBtn.disabled = false;
  updateStats();
}

benchBtn.addEventListener('click', async () => {
  const rounds = Math.min(200, Math.max(1, Number(roundsInput.value) || 40));
  activeMode = 'bench';
  benchTotal = rounds;
  benchSettled = 0;
  benchDone = false;
  simBtn.disabled = true;
  benchBtn.disabled = true;
  benchBtn.textContent = 'running…';
  progressEl.textContent = `0/${rounds}`;

  for (let i = 0; i < rounds; i += 1) {
    const clientId = nextClientId();
    raceEntry(clientId, `${BENCH_PREFIX} #${i + 1}`);
    void orbitSend(clientId, `${BENCH_PREFIX} #${i + 1}`).catch(() => {});
    void gqlSend(clientId, `${BENCH_PREFIX} #${i + 1}`).catch(() => {});
  }
  // Hard timeout so a dropped frame can never wedge the UI.
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (benchDone) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      finishBench();
      resolve();
    }, 15_000);
  });
  benchBtn.textContent = '⚡ Benchmark';
});

// ---- clear ----

clearBtn.addEventListener('click', async () => {
  stopSim();
  try {
    const res = await fetch('/orbit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'chat.clear', args: {} }),
    });
    await res.json();
  } catch {
    // Even if the clear call fails, wipe the local view.
  }
  resetView();
});

function resetView() {
  // Cancel any in-flight run so no callback flips the UI afterwards.
  benchDone = true;
  activeMode = null;
  clearTimeout(simTimer);
  simBtn.disabled = false;
  benchBtn.disabled = false;
  simBtn.textContent = '▶ Simulate realtime';
  benchBtn.textContent = '⚡ Benchmark';
  orbitFeed.innerHTML = '';
  gqlFeed.innerHTML = '';
  racelogEl.innerHTML = '<div class="no-rows">no races yet — send one above or hit simulate</div>';
  races.clear();
  orbitSamples.length = 0;
  gqlSamples.length = 0;
  wins.orbit = 0;
  wins.gql = 0;
  orbitBytes.length = 0;
  gqlBytes.length = 0;
  seenOrbit.clear();
  seenGql.clear();
  progressEl.textContent = 'idle';
  updateStats();
}

// ---- stats ----

function avgOf(samples) {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function updateStats() {
  const o = statsOf(orbitSamples);
  const g = statsOf(gqlSamples);
  const oAvg = avgOf(orbitSamples);
  const gAvg = avgOf(gqlSamples);
  const oBytes = avgOf(orbitBytes);
  const gBytes = avgOf(gqlBytes);

  // Winner banner (only when both sides have raced).
  if (o.n > 0 && g.n > 0) {
    const orbitWins = oAvg <= gAvg;
    const ratio = Math.max(oAvg, gAvg) / Math.max(0.001, Math.min(oAvg, gAvg));
    winnerEl.textContent = `${orbitWins ? 'A · Orbit' : 'B · graphql-js'} · ${ratio.toFixed(1)}× faster`;
    winnerEl.className = `v ${orbitWins ? 'good' : 'bad'}`;
  } else {
    winnerEl.textContent = '—';
    winnerEl.className = 'v';
  }
  orbitAvgEl.textContent = o.n > 0 ? fmtMs(o.avg) : '—';
  orbitAvgEl.className = `v${g.n > 0 && o.n > 0 && o.avg <= g.avg ? ' good' : ''}`;
  gqlAvgEl.textContent = g.n > 0 ? fmtMs(g.avg) : '—';
  gqlAvgEl.className = `v${o.n > 0 && g.n > 0 && g.avg < o.avg ? ' good' : ''}`;
  winsEl.textContent = `A ${wins.orbit} · B ${wins.gql}`;
  winsEl.className = 'v';

  // Side metrics.
  orbitLast.textContent = o.n > 0 ? fmtMs(lastOf(orbitSamples)) : '—';
  orbitAvg2.textContent = o.n > 0 ? fmtMs(o.avg) : '—';
  orbitP95.textContent = o.n > 0 ? fmtMs(o.p95) : '—';
  orbitPayload.textContent = oBytes > 0 ? fmtBytes(oBytes) : '—';
  gqlLast.textContent = g.n > 0 ? fmtMs(lastOf(gqlSamples)) : '—';
  gqlAvg2.textContent = g.n > 0 ? fmtMs(g.avg) : '—';
  gqlP95.textContent = g.n > 0 ? fmtMs(g.p95) : '—';
  gqlPayload.textContent = gBytes > 0 ? fmtBytes(gBytes) : '—';
  if (o.n > 0) orbitCrown.textContent = `${wins.orbit} 🏆`;
  else orbitCrown.textContent = '';
  if (g.n > 0) gqlCrown.textContent = `${wins.gql} 🏆`;
  else gqlCrown.textContent = '';

  // VS bars: share of total avg latency + a readable ratio.
  const total = oAvg + gAvg;
  if (total > 0) {
    barOrbit.style.width = `${(oAvg / total) * 100}%`;
    barGql.style.width = `${(gAvg / total) * 100}%`;
    if (oAvg > 0 && gAvg > 0) {
      const faster = oAvg <= gAvg ? 'A' : 'B';
      const ratio = Math.max(oAvg, gAvg) / Math.max(0.001, Math.min(oAvg, gAvg));
      vsRatio.textContent = `${faster} ${ratio.toFixed(1)}× faster`;
    } else {
      vsRatio.textContent = '—';
    }
  } else {
    barOrbit.style.width = '50%';
    barGql.style.width = '50%';
    vsRatio.textContent = '—';
  }

  renderTable(o, g);
  drawChart([
    { label: 'p50', orbit: o.p50, gql: g.p50 },
    { label: 'p95', orbit: o.p95, gql: g.p95 },
    { label: 'p99', orbit: o.p99, gql: g.p99 },
    { label: 'max', orbit: o.max, gql: g.max },
  ]);
}

function lastOf(samples) {
  return samples[samples.length - 1] ?? 0;
}

function renderTable(o, g) {
  const rows = [
    ['samples', o.n, g.n],
    ['min', o.min, g.min],
    ['avg', o.avg, g.avg],
    ['p50', o.p50, g.p50],
    ['p95', o.p95, g.p95],
    ['p99', o.p99, g.p99],
    ['max', o.max, g.max],
  ];
  scoresEl.innerHTML = `
    <thead>
      <tr><th>metric</th><th style="color: var(--accent)">A · orbit</th><th style="color: var(--accent-2)">B · graphql</th><th>×</th></tr>
    </thead>
    <tbody>
      ${rows
        .map(
          ([label, a, b]) => `
        <tr>
          <td>${label}</td>
          <td>${fmtMs(a)}</td>
          <td>${fmtMs(b)}</td>
          <td class="mono">${b > 0 && a > 0 ? (b / a).toFixed(2) : '—'}</td>
        </tr>`,
        )
        .join('')}
    </tbody>`;
}

function drawChart(groups) {
  const width = 640;
  const height = 230;
  const padL = 58;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const maxValue = Math.max(...groups.map((g) => Math.max(g.orbit, g.gql)), 1);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const groupW = innerW / groups.length;
  const barW = Math.min(46, groupW * 0.32);

  let bars = '';
  groups.forEach((group, gi) => {
    const cx = padL + groupW * gi + groupW / 2;
    const scale = (v) => (v / maxValue) * innerH;
    bars += `
      <text x="${cx}" y="${padT - 4}" text-anchor="middle" class="axis-label">${group.label}</text>
      <rect x="${cx - barW - 4}" y="${padT + innerH - scale(group.orbit)}" width="${barW}" height="${scale(group.orbit)}" rx="3" fill="#10a37f" opacity="0.9"/>
      <rect x="${cx + 4}" y="${padT + innerH - scale(group.gql)}" width="${barW}" height="${scale(group.gql)}" rx="3" fill="#e10098" opacity="0.9"/>
      <text x="${cx - barW / 2 - 4}" y="${padT + innerH - scale(group.orbit) - 4}" text-anchor="middle" class="bar-label">${fmtMs(group.orbit)}</text>
      <text x="${cx + barW / 2 + 4}" y="${padT + innerH - scale(group.gql) - 4}" text-anchor="middle" class="bar-label">${fmtMs(group.gql)}</text>`;
  });

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Orbit vs GraphQL latency">
      ${bars}
      <text x="${padL + innerW / 2}" y="${height - 6}" text-anchor="middle" class="axis-label">
        ● A · Orbit (${fmtMs(maxValue)} scale)   ● B · graphql-js — lower is better
      </text>
    </svg>`;
}

// ---- init ----

async function seedFeeds() {
  try {
    const { data } = await client.query('chat { id, author, text, ts, clientId }');
    const messages = Array.isArray(data) ? data : [];
    for (const message of messages) {
      markFeed('orbit', message, null, '');
      markFeed('gql', message, null, '');
    }
  } catch {
    // The sockets are the source of truth; a failed history load is fine.
  }
}

resetView();
seedFeeds();
setStatus('orbit', 'connecting');
setStatus('gql', 'connecting');
