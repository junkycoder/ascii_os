// FakanOS — edge worker.
//
// Serves the zero-build vanilla ES-module shell via the static ASSETS binding,
// plus:
//   • /api/auth/*            email + magic-link sign-in (Cloudflare KV + Resend)
//   • /api/feedback/*        public feedback board (verified-email post + email ack)
//   • /api/share/*           Durable-Object file share (local→DO→locals) + WS
//                            live sync + WebRTC signaling relay (tunnel)
//   • /auth                  universal-link landing → serves the SPA shell
//   • /.well-known/apple-app-site-association   iOS associated-domains manifest
//   • /api/newfish/*         same-origin proxy for the New Fish time-tracker API
//
// Bindings / config (see wrangler.jsonc):
//   env.AUTH            KV namespace — keys user:<email> / magic:<tok> / session:<sid>
//   env.SHARE           Durable Object namespace — class ShareRoom (one per code)
//   env.MAIL_FROM       verified Resend sender, e.g. "FakanOS <login@fakan.cz>"
//   env.APP_URL         public origin for the magic link, e.g. https://os.fakan.cz
//   env.IOS_TEAM_ID     Apple Team ID for the AASA appID (set when known)
//   env.RESEND_API_KEY  secret — `wrangler secret put RESEND_API_KEY`

const NEWFISH_PREFIX = '/api/newfish/';
const NEWFISH_UPSTREAM = 'https://new-fish.net/api/v0/';

const IOS_APP_ID = 'cz.fakan.os';
const MAGIC_TTL = 900;                  // magic link valid 15 min, single use
const SESSION_TTL = 60 * 60 * 24 * 365; // remember the login ~1 year
const REQUEST_THROTTLE = 60;            // min seconds between link requests / email (KV TTL floor)

// ── Feedback board ──────────────────────────────────────────────────
// A single public board: anyone can read, only a signed-in (verified-email)
// account can post. Stored as one capped JSON blob in the AUTH KV namespace —
// volume is low, so one read/write per call beats per-item key fan-out. Author
// contact emails are kept server-side (never returned in the public list).
const FEEDBACK_KEY = 'feedback:v1';
const FEEDBACK_MAX = 200;               // keep the most recent N on the board
const FEEDBACK_TEXT_MAX = 2000;
const FEEDBACK_POST_THROTTLE = 20;      // min seconds between posts per account
const FEEDBACK_CATEGORIES = ['bug', 'idea', 'praise', 'other'];

// ── File share (Durable Object) ─────────────────────────────────────
// Small files (text + small images/audio) live inside the DO; anything bigger
// is meant to go peer-to-peer over the WebRTC tunnel the DO only *signals* for.
const SHARE_CODE_LEN = 8;               // unguessable room code length
const SHARE_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no look-alikes
const SHARE_MAX_FILE = 256 * 1024;      // 256 KiB per file kept in the DO
const SHARE_MAX_TOTAL = 8 * 1024 * 1024; // 8 MiB total per room (soft cap)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url);
    if (path === '/api/feedback' || path.startsWith('/api/feedback/')) return handleFeedback(request, env, url);
    if (path.startsWith('/api/share/')) return handleShare(request, env, url);
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
  const target = String((body && body.target) || '').trim();
  if (!isEmail(email)) return json({ error: 'invalid email' }, 400);
  if (username.length < 2) return json({ error: 'invalid username' }, 400);

  // Light per-email throttle so the endpoint can't be used to spam an inbox.
  const rlKey = 'rl:' + email;
  if (await env.AUTH.get(rlKey)) return json({ error: 'please wait before requesting another link' }, 429);

  const token = randToken();
  await env.AUTH.put('magic:' + token, JSON.stringify({ email, username }), { expirationTtl: MAGIC_TTL });
  await env.AUTH.put(rlKey, '1', { expirationTtl: REQUEST_THROTTLE });

  const origin = env.APP_URL || new URL(request.url).origin;
  // Requested from the native app → tag the link so the landing page hands the
  // token to the app via the fakanos:// scheme if the universal link misses.
  let link = origin.replace(/\/$/, '') + '/auth?token=' + token;
  if (target === 'app') link += '&target=app';

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

// Resolve the bearer session token → its stored payload { id, email, username },
// or null. Shared by /api/auth/me and the feedback post (which requires a real,
// verified-email account — a guest never carries a server session token).
async function sessionUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const sid = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!sid) return null;
  const raw = await env.AUTH.get('session:' + sid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// GET /api/auth/me  (Authorization: Bearer <sid>) → { user } or 401.
async function authMe(request, env) {
  const s = await sessionUser(request, env);
  if (!s) return json({ error: 'invalid session' }, 401);
  return json({ user: { id: s.id, email: s.email, name: s.username } });
}

// Send the magic link via Resend (https://resend.com). Requires a verified
// sender domain (fakan.cz) + RESEND_API_KEY secret.
async function sendMagicEmail(env, email, link) {
  if (!env.RESEND_API_KEY) throw new Error('mail not configured');
  const from = env.MAIL_FROM || 'FakanOS <login@fakan.cz>';
  const subject = 'Your FakanOS sign-in link';
  const text =
    'Sign in to FakanOS\n\n' +
    'Open this link to finish signing in (valid 15 minutes):\n' + link + '\n\n' +
    'If you did not request this, you can ignore this email.';
  const html =
    '<div style="font-family:ui-monospace,Menlo,monospace;background:#0d0d0d;color:#ddd;padding:32px">' +
    '<div style="color:#00ff88;font-size:20px;font-weight:bold;letter-spacing:2px">F a k a n O S</div>' +
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

// ── /api/feedback/* — public feedback board ─────────────────────────
//   GET  /api/feedback        (or /list) → { items }  (public; no emails)
//   POST /api/feedback        (Bearer session) → { ok, item }  (verified email)
async function handleFeedback(request, env, url) {
  if (!env.AUTH) return json({ error: 'feedback not configured' }, 500);
  const route = url.pathname.slice('/api/feedback'.length).replace(/^\//, '');
  if (request.method === 'GET' && (route === '' || route === 'list')) return feedbackList(env);
  if (request.method === 'POST' && (route === '' || route === 'new')) return feedbackPost(request, env);
  return json({ error: 'not found' }, 404);
}

async function readFeedback(env) {
  const raw = await env.AUTH.get(FEEDBACK_KEY);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Public board read — strip the private contact email from every item.
async function feedbackList(env) {
  const items = await readFeedback(env);
  const pub = items.map(({ contact, ...rest }) => rest);
  return json({ items: pub });
}

// Keep only short, known-shape context strings (don't trust the client blob).
function sanitizeContext(c) {
  if (!c || typeof c !== 'object') return null;
  const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));
  return {
    version: clip(c.version, 32),
    theme: clip(c.theme, 24),
    mode: clip(c.mode, 16),
    platform: clip(c.platform, 80),
  };
}

async function feedbackPost(request, env) {
  const s = await sessionUser(request, env);
  if (!s || !isEmail(s.email)) {
    return json({ error: 'sign in with a verified email to post feedback' }, 401);
  }

  const body = await readJSON(request);
  let text = String((body && body.text) || '').trim();
  if (!text) return json({ error: 'feedback text is required' }, 400);
  if (text.length > FEEDBACK_TEXT_MAX) text = text.slice(0, FEEDBACK_TEXT_MAX);

  let category = String((body && body.category) || 'other').trim().toLowerCase();
  if (!FEEDBACK_CATEGORIES.includes(category)) category = 'other';

  const rawContact = String((body && body.contact) || '').trim().toLowerCase();
  const contact = isEmail(rawContact) ? rawContact : s.email;

  // Per-account throttle so one signed-in user can't flood the board.
  const rlKey = 'fbrl:' + s.id;
  if (await env.AUTH.get(rlKey)) return json({ error: 'please wait a moment before posting again' }, 429);
  await env.AUTH.put(rlKey, '1', { expirationTtl: FEEDBACK_POST_THROTTLE });

  const item = {
    id: randToken().slice(0, 12),
    userId: s.id,
    name: String(s.username || s.email.split('@')[0] || 'user').slice(0, 24),
    category,
    text,
    contact,
    context: sanitizeContext(body && body.context),
    createdAt: Date.now(),
  };

  const items = await readFeedback(env);
  items.unshift(item);
  if (items.length > FEEDBACK_MAX) items.length = FEEDBACK_MAX;
  await env.AUTH.put(FEEDBACK_KEY, JSON.stringify(items));

  // Friendly acknowledgement to the author — best-effort, never blocks the post.
  try { await sendFeedbackEmail(env, contact, item); } catch {}

  const { contact: _omit, ...pub } = item;
  return json({ ok: true, item: pub });
}

// "We'll send them a nice email" — a themed thank-you echoing their note.
async function sendFeedbackEmail(env, email, item) {
  if (!env.RESEND_API_KEY || !isEmail(email)) return;
  const from = env.MAIL_FROM || 'FakanOS <login@fakan.cz>';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const subject = 'Thanks for your FakanOS feedback';
  const text =
    'Thanks for the feedback!\n\n' +
    'We logged your ' + item.category + ' note on the FakanOS board:\n\n' +
    '"' + item.text + '"\n\n' +
    'We read every message and may follow up at this address.\n\n— FakanOS';
  const html =
    '<div style="font-family:ui-monospace,Menlo,monospace;background:#0d0d0d;color:#ddd;padding:32px">' +
    '<div style="color:#00ff88;font-size:20px;font-weight:bold;letter-spacing:2px">F a k a n O S</div>' +
    '<p style="color:#bbb">Thanks for your feedback — we logged your <b>' + esc(item.category) + '</b> note on the board.</p>' +
    '<blockquote style="border-left:3px solid #00ff88;margin:16px 0;padding:8px 16px;color:#ddd;white-space:pre-wrap">' + esc(item.text) + '</blockquote>' +
    '<p style="color:#777;font-size:12px">We read every message and may follow up at this address.</p>' +
    '<p style="color:#555;font-size:12px">— FakanOS</p>' +
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

// ── /api/share/* — Durable-Object file share ────────────────────────
// Routing model (the room code is the capability — "unlisted"):
//   POST   /api/share/new                     → mint a fresh room code
//   GET    /api/share/<code>/manifest         → list file metadata + room info
//   GET    /api/share/<code>/file?path=<p>    → download one file
//   PUT    /api/share/<code>/file?path=<p>    → upload one file (source local)
//   DELETE /api/share/<code>/file?path=<p>    → remove one file
//   GET    /api/share/<code>/ws  (Upgrade)    → live sync events + signaling
// Everything past the code is forwarded to the per-code Durable Object, which
// owns the storage + the open WebSockets.
async function handleShare(request, env, url) {
  if (!env.SHARE) return json({ error: 'share not configured' }, 500);

  const rest = url.pathname.slice('/api/share/'.length);
  if (rest === 'new' && request.method === 'POST') {
    return json({ code: shareCode() });
  }

  const slash = rest.indexOf('/');
  const code = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const action = slash < 0 ? '' : rest.slice(slash + 1);
  if (!isShareCode(code)) return json({ error: 'bad code' }, 400);
  if (!action) return json({ error: 'no action' }, 404);

  // Address the one Durable Object for this code; forward the rest verbatim so
  // the DO can route on `action` and read ?path= / the WebSocket upgrade.
  const id = env.SHARE.idFromName(code);
  const stub = env.SHARE.get(id);
  const doUrl = 'https://share/' + action + url.search;
  return stub.fetch(new Request(doUrl, request));
}

function shareCode() {
  const a = new Uint8Array(SHARE_CODE_LEN);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += SHARE_CODE_ALPHABET[a[i] % SHARE_CODE_ALPHABET.length];
  return s;
}
function isShareCode(s) {
  return typeof s === 'string' && s.length >= 4 && s.length <= 16 && /^[a-z0-9]+$/.test(s);
}

// The ShareRoom Durable Object — one instance per room code. Holds the shared
// files (small enough to live in DO storage) and the set of connected peers,
// broadcasting add/update/delete events and relaying WebRTC signaling so the
// "locals" can open a peer-to-peer tunnel for files too big to keep here.
export class ShareRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').filter(Boolean)[0] || '';
    const path = url.searchParams.get('path') || '';

    if (action === 'ws') return this.handleWs(request);
    if (action === 'manifest') return this.manifest();
    if (action === 'file') {
      if (request.method === 'GET') return this.getFile(path);
      if (request.method === 'PUT') return this.putFile(path, request);
      if (request.method === 'DELETE') return this.delFile(path);
    }
    return json({ error: 'not found' }, 404);
  }

  // ── files ──────────────────────────────────────────────────────
  async manifest() {
    const map = await this.state.storage.list({ prefix: 'file:' });
    const files = [];
    let total = 0;
    for (const v of map.values()) {
      total += v.size || 0;
      files.push({ path: v.path, name: v.name, mime: v.mime, size: v.size, mtime: v.mtime });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const created = (await this.state.storage.get('created')) || null;
    return json({ files, total, created, peers: this.peerIds().length });
  }

  async getFile(path) {
    if (!path) return json({ error: 'no path' }, 400);
    const f = await this.state.storage.get('file:' + path);
    if (!f) return json({ error: 'not found' }, 404);
    // data is a string (text) or an ArrayBuffer (binary) — both valid bodies.
    return new Response(f.data, {
      headers: { 'content-type': f.mime || 'application/octet-stream', 'cache-control': 'no-store' },
    });
  }

  async putFile(path, request) {
    if (!path || path.length > 1024) return json({ error: 'bad path' }, 400);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > SHARE_MAX_FILE) {
      return json({ error: 'file too large for share; use the tunnel', max: SHARE_MAX_FILE }, 413);
    }
    const mime = request.headers.get('content-type') || 'application/octet-stream';
    const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('svg');

    // Enforce a soft total cap so one room can't grow without bound.
    const existing = await this.state.storage.get('file:' + path);
    const map = await this.state.storage.list({ prefix: 'file:' });
    let total = 0;
    for (const v of map.values()) total += v.size || 0;
    total -= (existing && existing.size) || 0;
    if (total + buf.byteLength > SHARE_MAX_TOTAL) {
      return json({ error: 'share is full', max: SHARE_MAX_TOTAL }, 413);
    }

    const mtime = Number(request.headers.get('x-mtime')) || Date.now();
    const meta = { path, name: path.split('/').pop(), mime, size: buf.byteLength, mtime };
    // Store text as a string (smaller + lets getFile serve it directly); binary
    // as the raw ArrayBuffer (DO storage structured-clones both).
    const data = isText ? new TextDecoder().decode(buf) : buf;
    await this.state.storage.put('file:' + path, { ...meta, data });
    if (!(await this.state.storage.get('created'))) {
      await this.state.storage.put('created', Date.now());
    }
    this.broadcast({ type: existing ? 'updated' : 'added', file: meta });
    return json({ ok: true, file: meta });
  }

  async delFile(path) {
    if (!path) return json({ error: 'no path' }, 400);
    const had = await this.state.storage.delete('file:' + path);
    if (had) this.broadcast({ type: 'deleted', path });
    return json({ ok: true });
  }

  // ── WebSocket: live sync + WebRTC signaling relay ──────────────
  async handleWs(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // Hibernatable accept — the runtime can evict the DO between messages and
    // still keep the socket; getWebSockets() rehydrates them on wake.
    this.state.acceptWebSocket(server);
    const peerId = randToken().slice(0, 12);
    server.serializeAttachment({ peerId });
    server.send(JSON.stringify({ type: 'hello', peerId, peers: this.peerIds().filter((p) => p !== peerId) }));
    this.broadcastExcept(peerId, { type: 'peer-join', peerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  peerIds() {
    return this.state.getWebSockets()
      .map((ws) => { try { return (ws.deserializeAttachment() || {}).peerId; } catch { return null; } })
      .filter(Boolean);
  }

  async webSocketMessage(ws, message) {
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const from = (() => { try { return (ws.deserializeAttachment() || {}).peerId; } catch { return null; } })();
    // Relay WebRTC signaling (offer/answer/ice) to the targeted peer only.
    if (m && m.type === 'signal' && m.to) {
      const out = JSON.stringify({ type: 'signal', from, signal: m.signal });
      for (const sock of this.state.getWebSockets()) {
        let pid; try { pid = (sock.deserializeAttachment() || {}).peerId; } catch { pid = null; }
        if (pid === m.to) { try { sock.send(out); } catch {} }
      }
    }
  }

  webSocketClose(ws) {
    let pid; try { pid = (ws.deserializeAttachment() || {}).peerId; } catch { pid = null; }
    if (pid) this.broadcastExcept(pid, { type: 'peer-leave', peerId: pid });
  }
  webSocketError(ws) { this.webSocketClose(ws); }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) { try { ws.send(s); } catch {} }
  }
  broadcastExcept(peerId, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      let pid; try { pid = (ws.deserializeAttachment() || {}).peerId; } catch { pid = null; }
      if (pid !== peerId) { try { ws.send(s); } catch {} }
    }
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
