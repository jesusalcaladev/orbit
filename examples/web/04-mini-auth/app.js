import { orbit, toast } from '../shared.js';

const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login');
const registerBtn = document.getElementById('register');
const logoutBtn = document.getElementById('logout');
const sessionEl = document.getElementById('session');
const meEl = document.getElementById('me');
const withToken = document.getElementById('with-token');
const withoutToken = document.getElementById('without-token');
const copyTokenBtn = document.getElementById('copy-token');

let token = localStorage.getItem('orbit-token') ?? '';
let username = localStorage.getItem('orbit-username') ?? '';

function render() {
  if (token) {
    sessionEl.textContent = `in as ${username}`;
    sessionEl.className = 'v good';
    logoutBtn.disabled = false;
    copyTokenBtn.disabled = false;
  } else {
    sessionEl.textContent = '—';
    sessionEl.className = 'v';
    logoutBtn.disabled = true;
    copyTokenBtn.disabled = true;
  }
}

async function auth(path, { body, expectToken }) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error || !json.token) {
    throw new Error(json.error?.message ?? 'Auth failed');
  }
  if (expectToken) {
    token = json.token;
    username = json.username;
    localStorage.setItem('orbit-token', token);
    localStorage.setItem('orbit-username', username);
  }
  render();
}

loginBtn.addEventListener('click', async () => {
  try {
    await auth('/api/auth/login', {
      body: { username: usernameInput.value, password: passwordInput.value },
      expectToken: true,
    });
    toast(`Welcome back, ${username}`);
    await probe();
  } catch (error) {
    toast(error.message, true);
  }
});

registerBtn.addEventListener('click', async () => {
  try {
    await auth('/api/auth/register', {
      body: { username: usernameInput.value, password: passwordInput.value },
      expectToken: true,
    });
    toast(`Registered as ${username}`);
    await probe();
  } catch (error) {
    toast(error.message, true);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await orbit({ do: 'user.logout', args: {} }, { token });
  } catch {
    // The token is wiped client-side either way.
  }
  token = '';
  username = '';
  localStorage.removeItem('orbit-token');
  localStorage.removeItem('orbit-username');
  render();
  toast('Logged out');
  await probe();
});

copyTokenBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(token);
    toast('Token copied to clipboard');
  } catch {
    toast('Could not copy — select it manually', true);
  }
});

async function probe() {
  // With the token: the plugin stamps ctx.state.caller, the query resolves.
  try {
    const { data } = await orbit({ query: 'user(me="true") { name }' }, { token });
    meEl.textContent = data?.name ?? '?';
    meEl.classList.add('good');
    withToken.textContent = JSON.stringify(data, null, 2);
    withToken.classList.remove('err');
  } catch (error) {
    meEl.textContent = '—';
    meEl.classList.remove('good');
    withToken.textContent = `${error.code}: ${error.message}`;
    withToken.classList.add('err');
  }

  // Without the token: ORBIT_PERMISSION_DENIED from the onBeforeResolve hook.
  try {
    await orbit({ query: 'user(me="true") { name }' });
    withoutToken.textContent = 'resolved?! (should be blocked)';
    withoutToken.classList.add('err');
  } catch (error) {
    withoutToken.textContent = `${error.code}: ${error.message}`;
    withoutToken.classList.add('err');
  }
}

render();
probe().catch(() => {});
