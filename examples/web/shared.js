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

/** Fetch the whole chat history (insertion order, oldest first). */
export async function chatHistory() {
  const { data } = await orbit({ query: 'chat { id, author, text, ts, clientId }' });
  return Array.isArray(data) ? data : [];
}

/**
 * Open the Orbit realtime socket with automatic reconnect + resume.
 *
 * - First connect sends `subscribe`; every reconnect sends `resume` with the
 *   last seen `seq`, so missed events are replayed from the retention log.
 * - If the retention window expired, the server answers ORBIT_SUBSCRIPTION_FAILED
 *   and we transparently fall back to a fresh `subscribe`.
 * - `onStatus` reports 'connecting' | 'live' | 'reconnecting'.
 *
 * Returns `{ send, close }`.
 */
export function orbitSocket({ subscribe, onEvent, onAck, onError, onStatus, subId = 'feed' }) {
  const retry = [500, 1200, 2500, 5000];
  let ws = null;
  let lastSeq = 0;
  let closed = false;
  let everSubscribed = false;
  let attempts = 0;
  let reconnectTimer = null;

  const scheduleReconnect = () => {
    // One reconnect at a time — a second trigger (e.g. onclose right after an
    // error) must not spin up a duplicate socket.
    if (reconnectTimer !== null) return;
    const delay = retry[Math.min(attempts, retry.length - 1)] ?? 5000;
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect() {
    if (closed) return;
    onStatus?.('connecting');
    ws = new WebSocket(`ws://${location.host}/realtime`);
    ws.onopen = () => {
      attempts = 0;
      onStatus?.('live');
      const frame = everSubscribed ? { resume: subId, after: lastSeq } : { subscribe, id: subId };
      everSubscribed = true;
      ws.send(JSON.stringify(frame));
    };
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.error) {
        // `resume` hit an expired/unknown subscription — drop the dead socket
        // and start over with a fresh subscribe.
        if (everSubscribed && message.error.code === 'ORBIT_SUBSCRIPTION_FAILED') {
          everSubscribed = false;
          ws?.close();
          scheduleReconnect();
          return;
        }
        onError?.(message.error);
      } else if (message.id && message.event) {
        if (typeof message.seq === 'number' && message.seq > lastSeq) lastSeq = message.seq;
        onEvent?.(message.event, message.seq);
      } else if (message.ack || message.resumed) {
        const kind = message.resumed !== undefined ? 'resume' : 'subscribe';
        onAck?.(message.ack ?? message.resumed, kind, lastSeq);
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus?.('reconnecting');
      scheduleReconnect();
    };
  }

  connect();

  return {
    send: (frame) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
        return true;
      }
      return false;
    },
    close: () => {
      closed = true;
      ws?.close();
    },
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

/** HH:MM:SS for a timestamp. */
export function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
