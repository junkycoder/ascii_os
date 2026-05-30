// acii_os — edge worker.
//
// Serves the zero-build vanilla ES-module shell via the static ASSETS binding,
// plus:
//   • /api/auth/*            email + magic-link sign-in (Cloudflare KV + Resend)
//   • /auth                  universal-link landing → serves the SPA shell
//   • /.well-known/apple-app-site-association   iOS associated-domains manifest
//   • /api/newfish/*         same-origin proxy for the New Fish time-tracker API
//
// Bindings / config (see wrangler.jsonc):
//   env.AUTH            KV namespace — keys user:<email> / magic:<tok> / session:<sid>
//   env.MAIL_FROM       verified Resend sender, e.g. "acii_os <login@fakan.cz>"
//   env.APP_URL         public origin for the magic link, e.g. https://os.fakan.cz
//   env.IOS_TEAM_ID     Apple Team ID for the AASA appID (set when known)
//   env.RESEND_API_KEY  secret — `wrangler secret put RESEND_API_KEY`

const NEWFISH_PREFIX = '/api/newfish/';
const NEWFISH_UPSTREAM = 'https://new-fish.net/api/v0/';

const IOS_APP_ID = 'cz.fakan.os';
const MAGIC_TTL = 900;                  // magic link valid 15 min, single use
const SESSION_TTL = 60 * 60 * 24 * 365; // remember the login ~1 year
const REQUEST_THROTTLE = 60;            // min seconds between link requests / email (KV TTL floor)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url);
    if (path === '/.well-known/apple-app-site-association') return aasa(env);
    if (path === '/auth') return serveApp(request, env);          // universal-link landing
    if (path.startsWith(NEWFISH_PREFIX)) return proxyNewfish(request, url);

    return env.ASSETS.fetch(request);
  },
};

// ── helpers ────────────────────────────────────────────────────────
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function randToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return hex(a);
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return hex(new Uint8Array(buf));
}
function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim()); }

// The SPA lives at "/"; serve it for the universal-link landing path too.
function serveApp(request, env) {
  const u = new URL(request.url);
  u.pathname = '/';
  return env.ASSETS.fetch(new Request(u.toString(), request));
}

// ── /api/auth/* ─────────────────────────────────────────────────────
async function handleAuth(request, env, url) {
  const route = url.pathname.slice('/api/auth/'.length);

  if (!env.AUTH) return json({ error: 'auth not configured' }, 500);

  if (route === 'request' && request.method === 'POST') return authRequest(request, env);
  if (route === 'verify' && request.method === 'POST') return authVerify(request, env);
  if (route === 'me' && request.method === 'GET') return authMe(request, env);
  return json({ error: 'not found' }, 404);
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

// POST /api/auth/request { email, username } → email a one-time magic link.
// Always responds { ok:true } once accepted; never leaks whether the address
// already has an account.
async function authRequest(request, env) {
  const body = await readJSON(request);
  const email = String((body && body.email) || '').trim().toLowerCase();
  const username = String((body && body.username) || '').trim().slice(0, 16);
  if (!isEmail(email)) return json({ error: 'invalid email' }, 400);
  if (username.length < 2) return json({ error: 'invalid username' }, 400);

  // Light per-email throttle so the endpoint can't be used to spam an inbox.
  const rlKey = 'rl:' + email;
  if (await env.AUTH.get(rlKey)) return json({ error: 'please wait before requesting another link' }, 429);

  const token = randToken();
  await env.AUTH.put('magic:' + token, JSON.stringify({ email, username }), { expirationTtl: MAGIC_TTL });
  await env.AUTH.put(rlKey, '1', { expirationTtl: REQUEST_THROTTLE });

  const origin = env.APP_URL || new URL(request.url).origin;
  const link = origin.replace(/\/$/, '') + '/auth?token=' + token;

  try {
    await sendMagicEmail(env, email, link);
  } catch (e) {
    return json({ error: 'could not send email: ' + (e && e.message || e) }, 502);
  }
  return json({ ok: true });
}

// POST /api/auth/verify { token } → consume the magic link, upsert the user,
// issue a long-lived session. { token, user }.
async function authVerify(request, env) {
  const body = await readJSON(request);
  const token = String((body && body.token) || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);

  const raw = await env.AUTH.get('magic:' + token);
  if (!raw) return json({ error: 'link expired or already used' }, 400);
  await env.AUTH.delete('magic:' + token);   // single use

  let m; try { m = JSON.parse(raw); } catch { return json({ error: 'bad token' }, 400); }
  const email = m.email;
  const id = 'u-' + (await sha256hex(email)).slice(0, 16);

  // Upsert the user record (keep created-at; refresh username if provided).
  const userKey = 'user:' + email;
  let user;
  const existing = await env.AUTH.get(userKey);
  if (existing) {
    try { user = JSON.parse(existing); } catch { user = null; }
  }
  if (!user) user = { id, email, username: m.username || email.split('@')[0], createdAt: Date.now() };
  else { user.id = id; if (m.username) user.username = m.username; }
  await env.AUTH.put(userKey, JSON.stringify(user));

  const sid = randToken();
  await env.AUTH.put('session:' + sid, JSON.stringify({ id, email, username: user.username }), { expirationTtl: SESSION_TTL });

  return json({ token: sid, user: { id, email, name: user.username } });
}

// GET /api/auth/me  (Authorization: Bearer <sid>) → { user } or 401.
async function authMe(request, env) {
  const auth = request.headers.get('authorization') || '';
  const sid = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!sid) return json({ error: 'no session' }, 401);
  const raw = await env.AUTH.get('session:' + sid);
  if (!raw) return json({ error: 'invalid session' }, 401);
  let s; try { s = JSON.parse(raw); } catch { return json({ error: 'invalid session' }, 401); }
  return json({ user: { id: s.id, email: s.email, name: s.username } });
}

// Send the magic link via Resend (https://resend.com). Requires a verified
// sender domain (fakan.cz) + RESEND_API_KEY secret.
async function sendMagicEmail(env, email, link) {
  if (!env.RESEND_API_KEY) throw new Error('mail not configured');
  const from = env.MAIL_FROM || 'acii_os <login@fakan.cz>';
  const subject = 'Your acii_os sign-in link';
  const text =
    'Sign in to acii_os\n\n' +
    'Open this link to finish signing in (valid 15 minutes):\n' + link + '\n\n' +
    'If you did not request this, you can ignore this email.';
  const html =
    '<div style="font-family:ui-monospace,Menlo,monospace;background:#0d0d0d;color:#ddd;padding:32px">' +
    '<div style="color:#00ff88;font-size:20px;font-weight:bold;letter-spacing:2px">a c i i _ o s</div>' +
    '<p style="color:#bbb">Open the link below to finish signing in. It is valid for 15 minutes and can be used once.</p>' +
    '<p><a href="' + link + '" style="display:inline-block;background:#00ff88;color:#0d0d0d;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Sign in →</a></p>' +
    '<p style="color:#777;font-size:12px;word-break:break-all">' + link + '</p>' +
    '<p style="color:#555;font-size:12px">If you did not request this, ignore this email.</p>' +
    '</div>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject, text, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('resend ' + res.status + ' ' + detail.slice(0, 200));
  }
}

// ── iOS associated-domains manifest ─────────────────────────────────
// Tells iOS that os.fakan.cz/auth* should open the cz.fakan.os app. Apple
// fetches this over TLS at install/update; needs the real Apple Team ID.
function aasa(env) {
  const teamId = env.IOS_TEAM_ID || '';
  const appID = teamId ? teamId + '.' + IOS_APP_ID : IOS_APP_ID;
  const body = {
    applinks: {
      apps: [],
      details: [
        { appID, paths: ['/auth', '/auth*'] },
        { appIDs: [appID], components: [{ '/': '/auth*' }] },
      ],
    },
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ── New Fish time-tracker proxy (unchanged) ─────────────────────────
async function proxyNewfish(request, url) {
  const rest = url.pathname.slice(NEWFISH_PREFIX.length);
  const target = NEWFISH_UPSTREAM + rest + url.search;

  const headers = new Headers();
  for (const h of ['x-auth-email', 'x-auth-token', 'content-type', 'accept']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  const init = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
  }

  const body = await upstream.arrayBuffer();
  const respHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) respHeaders.set('content-type', ct);
  respHeaders.set('cache-control', 'no-store');
  return new Response(body, { status: upstream.status, headers: respHeaders });
}
