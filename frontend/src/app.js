'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
// Token is stored in localStorage so it survives page reloads.
// In production, HttpOnly cookies are safer (not accessible from JS).
let authToken = localStorage.getItem('authToken');

// ─── View management ─────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Feedback message ─────────────────────────────────────────────────────────
function showMessage(text, type = 'info') {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = `message ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'message'; }, 4000);
}

// ─── API helper ──────────────────────────────────────────────────────────────
// All requests go to /api/* on the same origin.
// nginx proxies /api/* → backend:3000.
// The WAF inspects every request before nginx ever sees it.
async function api(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function register(e) {
  e.preventDefault();
  const email    = document.getElementById('reg-email').value;
  const username = document.getElementById('reg-username').value;
  const password = document.getElementById('reg-password').value;

  try {
    await api('POST', '/auth/register', { email, username, password });
    showMessage('Account created! Please login.', 'success');
    showView('login-view');
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

async function login(e) {
  e.preventDefault();
  const email    = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const data = await api('POST', '/auth/login', { email, password });
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    loadDashboard();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

async function loadDashboard() {
  try {
    const data = await api('GET', '/me');
    const u = data.user;
    // textContent (et non innerHTML) : un username contenant du HTML n'est jamais interprété
    const info = document.getElementById('user-info');
    info.replaceChildren();
    for (const [label, value] of [
      ['ID', u.id],
      ['Username', u.username],
      ['Email', u.email],
      ['Joined', new Date(u.created_at).toLocaleDateString()],
    ]) {
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `${label}: `;
      p.append(strong, String(value));
      info.append(p);
    }
    showView('dashboard-view');
  } catch {
    // Token expired or invalid — back to login
    logout();
  }
}

function logout() {
  authToken = null;
  localStorage.removeItem('authToken');
  showView('login-view');
}

// ─── WAF Test Panel ───────────────────────────────────────────────────────────
// Sends requests with known attack payloads to the /api/health endpoint.
// ModSecurity should intercept them and return 403 before they reach the backend.
// Check WAF logs with: docker logs <waf-container> -f
const WAF_TESTS = {
  sqli:  '/health?id=1%27%20OR%20%271%27%3D%271',       // ' OR '1'='1
  xss:   '/health?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E', // <script>alert(1)</script>
  path:  '/health?file=../../../../etc/passwd',
  cmd:   '/health?cmd=%3Bls+-la',                        // ;ls -la
  clean: '/health',                                       // should return 200
};

async function testWAF(type) {
  const resultEl = document.getElementById('waf-result');
  resultEl.textContent = 'Sending request...';
  resultEl.className = 'waf-result';

  try {
    const res = await fetch(`/api${WAF_TESTS[type]}`);
    const label = type === 'clean' ? '✓ Clean' : `✗ Attack (${type})`;
    resultEl.textContent = `${label} → ${res.status} ${res.statusText}`;

    if (res.status === 403) {
      resultEl.className = 'waf-result blocked';
    } else if (res.ok) {
      resultEl.className = 'waf-result allowed';
    }
  } catch (err) {
    resultEl.textContent = `Network error: ${err.message}`;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  // Wire up form submissions
  document.getElementById('register-form').addEventListener('submit', register);
  document.getElementById('login-form').addEventListener('submit', login);
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Wire up view switches
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    showView('register-view');
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    showView('login-view');
  });

  // Au retour de GitHub, le backend redirige vers /?token=XXXX ou /?error=XXXX
  const urlParams = new URLSearchParams(window.location.search);
  const oauthToken = urlParams.get('token'); // JWT généré par le backend après l'OAuth
  const oauthError = urlParams.get('error'); // code d'erreur si l'OAuth a échoué

  if (oauthToken) {
    // Même stockage que pour un login email/mot de passe
    authToken = oauthToken;
    localStorage.setItem('authToken', authToken);
    // Retire le token de l'URL (historique, rechargement)
    window.history.replaceState({}, '', '/');
    loadDashboard();
  } else if (oauthError) {
    showView('login-view');
    showMessage(`OAuth error: ${oauthError}`, 'error');
  } else if (authToken) {
    loadDashboard();
  } else {
    showView('login-view');
  }
});
