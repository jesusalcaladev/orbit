import { esc, fmtBytes, fmtMs, statsOf } from '../shared.js';

const nameInput = document.getElementById('name');
const textInput = document.getElementById('text');
const raceBtn = document.getElementById('race');
const benchBtn = document.getElementById('bench');
const clearBtn = document.getElementById('clear');
const roundsInput = document.getElementById('rounds');
const orbitFeed = document.getElementById('orbit-feed');
const gqlFeed = document.getElementById('gql-feed');
const orbitStatus = document.getElementById('orbit-status');
const gqlStatus = document.getElementById('gql-status');
const winnerEl = document.getElementById('winner');
const orbitPayload = document.getElementById('orbit-payload');
const gqlPayload = document.getElementById('gql-payload');
const progressEl = document.getElementById('progress');
const scoresEl = document.getElementById('scores');
const chartEl = document.getElementById('chart');

let clientSeq = 0;
const nextClientId = () => `b${++clientSeq}`;
const BENCH_PREFIX = 'bench-';
const nextBenchId = () => `${BENCH_PREFIX}${++clientSeq}`;

// Round-trip correlation per side: clientId → t0. An event settles its side.
const orbitPending = new Map();
const gqlPending = new Map();
const orbitSamples = [];
const gqlSamples = [];
let benchmarkRounds = 0;
let settled = 0;
let benchDone = false;

function markFeed(feed, message, latency) {
  if (message.text.startsWith('[bench]')) return; // bench traffic stays in the stats
  const el = document.createElement('div');
  el.className = 'mini';
  el.innerHTML = `
    <span class="m-who">${esc(message.author)}:</span> ${esc(message.text)}
    ${latency !== undefined ? `<span class="m-rt">${fmtMs(latency)}</span>` : ''}`;
  feed.appendChild(el);
  while (feed.children.length > 80) feed.removeChild(feed.firstChild);
}

function settle(samples, pending, clientId) {
  const t0 = pending.get(clientId);
  if (t0 === undefined) return;
  pending.delete(clientId);
  const latency = performance.now() - t0;
  samples.push(latency);
  // Benchmark progress counts ONLY bench traffic, so a "Send to both"
  // pressed mid-benchmark can't complete or skew the batch early.
  if (benchmarkRounds > 0 && !benchDone && clientId.startsWith(BENCH_PREFIX)) {
    settled += 1;
    progressEl.textContent = `${settled}/${benchmarkRounds * 2}`;
    if (settled >= benchmarkRounds * 2) finishBench();
  }
}

// ---- Orbit side ----
const orbitSocket = new WebSocket(`ws://${location.host}/realtime`);
orbitSocket.onopen = () => {
  orbitSocket.send(
    JSON.stringify({ subscribe: 'chat { id, author, text, ts, clientId }', id: 'feed' }),
  );
  orbitStatus.textContent = 'live';
};
orbitSocket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && message.event) {
    const data = message.event.data ?? {};
    settle(orbitSamples, orbitPending, data.clientId);
    const latency = data.clientId ? lastLatency(orbitSamples) : undefined;
    markFeed(orbitFeed, data, latency);
  } else if (message.error) {
    orbitStatus.textContent = `${message.error.code}`;
  }
};

async function orbitSend(clientId, text) {
  orbitPending.set(clientId, performance.now());
  const res = await fetch('/orbit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      do: 'chat.send',
      args: { payload: { author: nameInput.value.trim() || 'anon', text, clientId } },
    }),
  });
  orbitPayload.textContent = fmtBytes(Number(res.headers.get('content-length')) || 0);
  return res;
}

// ---- GraphQL side (raw graphql-ws protocol, no bundler) ----
const gqlWs = new WebSocket(`ws://${location.host}/graphql-ws`, 'graphql-transport-ws');
const GQL_SUB_ID = '1';
gqlWs.onopen = () => {
  gqlWs.send(JSON.stringify({ type: 'connection_init' }));
};
gqlWs.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type === 'connection_ack') {
    // Protocol order: subscribe only after the server acknowledged the init.
    gqlWs.send(
      JSON.stringify({
        type: 'subscribe',
        id: GQL_SUB_ID,
        payload: {
          query: 'subscription { messageSent { id author text ts clientId } }',
        },
      }),
    );
    gqlStatus.textContent = 'live';
  } else if (frame.type === 'next' && frame.id === GQL_SUB_ID) {
    const data = frame.payload.data.messageSent;
    settle(gqlSamples, gqlPending, data.clientId);
    const latency = data.clientId ? lastLatency(gqlSamples) : undefined;
    markFeed(gqlFeed, data, latency);
  } else if (frame.type === 'error') {
    gqlStatus.textContent = 'error';
  }
};

async function gqlSend(clientId, text) {
  gqlPending.set(clientId, performance.now());
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'mutation ($author: String!, $text: String!, $clientId: String) { sendMessage(author: $author, text: $text, clientId: $clientId) { id } }',
      variables: { author: nameInput.value.trim() || 'anon', text, clientId },
    }),
  });
  gqlPayload.textContent = fmtBytes(Number(res.headers.get('content-length')) || 0);
  return res;
}

function lastLatency(samples) {
  return samples.length > 0 ? samples[samples.length - 1] : undefined;
}

// ---- Actions ----

async function race() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  const clientId = nextClientId();
  await Promise.all([orbitSend(clientId, text), gqlSend(clientId, text)]);
}

raceBtn.addEventListener('click', race);
textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') race();
});

function finishBench() {
  benchDone = true;
  progressEl.textContent = 'done';
  renderStats();
  benchBtn.disabled = false;
}

async function benchmark() {
  const rounds = Math.min(200, Math.max(1, Number(roundsInput.value) || 40));
  benchmarkRounds = rounds;
  settled = 0;
  benchDone = false;
  orbitSamples.length = 0;
  gqlSamples.length = 0;
  progressEl.textContent = `0/${rounds * 2}`;
  benchBtn.disabled = true;
  for (let i = 0; i < rounds; i += 1) {
    const clientId = nextBenchId();
    const text = `[bench] #${i + 1}`;
    // Simultaneous: both sends fire in the same tick.
    void orbitSend(clientId, text).catch(() => {});
    void gqlSend(clientId, text).catch(() => {});
  }
  // Never deadlock: if events go missing (a reconnect, a dropped frame),
  // report what we have and release the UI after a hard timeout.
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
}

benchBtn.addEventListener('click', benchmark);
clearBtn.addEventListener('click', () => {
  orbitFeed.innerHTML = '';
  gqlFeed.innerHTML = '';
  orbitSamples.length = 0;
  gqlSamples.length = 0;
  renderStats();
});

// ---- Results ----

function renderStats() {
  const orbitStats = statsOf(orbitSamples);
  const gqlStats = statsOf(gqlSamples);
  const winner =
    gqlStats.n > 0 && (orbitStats.n === 0 || orbitStats.avg <= gqlStats.avg) ? 'Orbit' : 'GraphQL';

  if (orbitStats.n > 0 && gqlStats.n > 0) {
    const ratio = gqlStats.avg / Math.max(0.001, orbitStats.avg);
    winnerEl.textContent = `${winner} · ${ratio >= 1 ? `${ratio.toFixed(1)}× faster` : 'ahead'}`;
    winnerEl.classList.add('good');
    progressEl.textContent = 'done';
  }

  const rows = [
    ['samples', orbitStats.n, gqlStats.n],
    ['min', orbitStats.min, gqlStats.min],
    ['avg', orbitStats.avg, gqlStats.avg],
    ['p50', orbitStats.p50, gqlStats.p50],
    ['p95', orbitStats.p95, gqlStats.p95],
    ['p99', orbitStats.p99, gqlStats.p99],
    ['max', orbitStats.max, gqlStats.max],
  ];
  scoresEl.innerHTML = `
    <thead>
      <tr><th>metric</th><th style="color: var(--accent)">Orbit</th><th style="color: var(--accent-2)">graphql-js</th><th>×</th></tr>
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

  drawChart([
    { label: 'p50', orbit: orbitStats.p50, gql: gqlStats.p50 },
    { label: 'p95', orbit: orbitStats.p95, gql: gqlStats.p95 },
    { label: 'p99', orbit: orbitStats.p99, gql: gqlStats.p99 },
    { label: 'max', orbit: orbitStats.max, gql: gqlStats.max },
  ]);
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
      <rect x="${cx - barW - 4}" y="${padT + innerH - scale(group.orbit)}" width="${barW}" height="${scale(group.orbit)}" rx="3" fill="#6ee7b7" opacity="0.9"/>
      <rect x="${cx + 4}" y="${padT + innerH - scale(group.gql)}" width="${barW}" height="${scale(group.gql)}" rx="3" fill="#38bdf8" opacity="0.9"/>
      <text x="${cx - barW / 2 - 4}" y="${padT + innerH - scale(group.orbit) - 4}" text-anchor="middle" class="bar-label">${fmtMs(group.orbit)}</text>
      <text x="${cx + barW / 2 + 4}" y="${padT + innerH - scale(group.gql) - 4}" text-anchor="middle" class="bar-label">${fmtMs(group.gql)}</text>`;
  });

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Orbit vs GraphQL latency">
      ${bars}
      <text x="${padL + innerW / 2}" y="${height - 6}" text-anchor="middle" class="axis-label">
        ● Orbit (${fmtMs(maxValue)} scale)   ● graphql-js — lower is better
      </text>
    </svg>`;
}

// ---- Init ----
orbitPayload.textContent = '—';
gqlPayload.textContent = '—';
