/**
 * Orbit web demos — shared browser helpers.
 */

/** POST an envelope to the Orbit handler and return the parsed JSON. */
export async function orbit(envelope, options = {}) {
  const { headers = {}, token } = options;
  const res = await fetch('/orbit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-orbit-token': token } : {}),
      ...headers,
    },
    body: JSON.stringify(envelope),
  });
  const body = await res.json();
  if (body.error) {
    const error = new Error(body.error.message ?? 'Orbit error');
    error.code = body.error.code;
    error.status = res.status;
    throw error;
  }
  return body;
}

/** Open the Orbit realtime socket and subscribe; returns { ws, send, close }. */
export function orbitSocket({ subscribe, onEvent, onAck, onError }) {
  const ws = new WebSocket(`ws://${location.host}/realtime`);
  ws.onopen = () => {
    if (subscribe) {
      ws.send(JSON.stringify({ subscribe, id: 'feed' }));
    }
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.error) {
      onError?.(message.error);
    } else if (message.id && message.event) {
      onEvent?.(message.event, message.seq);
    } else if (message.ack) {
      onAck?.(message.ack);
    }
  };
  return {
    ws,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => ws.close(),
  };
}

/** Format a millisecond duration for display. */
export function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  return `${Math.round(ms * 1000)} µs`;
}

/** Format a byte count. */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Percentile of a sorted number array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export function statsOf(samples) {
  if (samples.length === 0) {
    return { n: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** A tiny toast. */
export function toast(message, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

/** Escape HTML in user-provided text before injecting into the DOM. */
export function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}
