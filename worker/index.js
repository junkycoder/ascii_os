// FakanOS — edge worker.
//
// Serves the zero-build vanilla ES-module shell via the static ASSETS binding,
// plus:
//   • /api/auth/*            email + magic-link sign-in (Cloudflare KV + Resend)
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

// ── File share (Durable Object) ─────────────────────────────────────
// Small files (text + small images/audio) live inside the DO; anything bigger
// is meant to go peer-to-peer over the WebRTC tunnel the DO only *signals* for.
const SHARE_CODE_LEN = 8;               // unguessable room code length
const SHARE_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no look-alikes
const SHARE_MAX_FILE = 256 * 1024;      // 256 KiB per file kept in the DO
const SHARE_MAX_TOTAL = 8 * 1024 * 1024; // 8 MiB total per room (soft cap)

// ── Collaborative desktop (Durable Object) ──────────────────────────
// A "room" is one owner's shared desktop, keyed by the owner's user id. People
// are added by email invite (a magic link carrying the room); on verify they
// join the room and boot into it. The CollabRoom DO holds the member list and
// the live presence (who's here + cursors) over a WebSocket.
const COLLAB_INVITE_TTL = 60 * 60 * 24 * 7; // invite link valid 7 days, single use

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/auth/')) return handleAuth(request, env, url);
    if (path.startsWith('/api/share/')) return handleShare(request, env, url);
    if (path.startsWith('/api/collab/')) return handleCollab(request, env, url);
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
  if (route === 'peek' && request.method === 'POST') return authPeek(request, env);
  if (route === 'me' && request.method === 'GET') return authMe(request, env);
  return json({ error: 'not found' }, 404);
}

async function readJSON(request) {
  try { return await request.json(); } catch { return null; }
}

// Resolve a Bearer session token → the stored session record, or null.
function bearer(request) {
  const a = request.headers.get('authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}
async function sessionFor(env, sid) {
  if (!sid) return null;
  const raw = await env.AUTH.get('session:' + sid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// POST /api/auth/peek { token } → inspect a magic/invite token WITHOUT consuming
// it, so the client can decide whether to show a "pick a nickname" step. The
// token holder is the person the link was emailed to, so it's fine to tell them
// whether their address already has an account.
async function authPeek(request, env) {
  const body = await readJSON(request);
  const token = String((body && body.token) || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);
  const raw = await env.AUTH.get('magic:' + token);
  if (!raw) return json({ ok: true, valid: false });
  let m; try { m = JSON.parse(raw); } catch { return json({ ok: true, valid: false }); }
  const exists = !!(await env.AUTH.get('user:' + m.email));
  return json({
    ok: true, valid: true,
    invite: !!m.room,
    email: m.email,
    exists,
    nick: m.username || null,
    invitedBy: m.invitedBy || null,
  });
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

// POST /api/auth/verify { token, nick? } → consume the magic link, upsert the
// user, issue a long-lived session. For invite links the magic record carries a
// `room` (+ rights): we record the membership and return the room so the client
// boots into it. "Registration only if new": a nick (from the invite or this
// request) seeds a BRAND-NEW account only — an existing user keeps their name.
async function authVerify(request, env) {
  const body = await readJSON(request);
  const token = String((body && body.token) || '').trim();
  const nick = String((body && body.nick) || '').trim().slice(0, 16);
  if (!token) return json({ error: 'missing token' }, 400);

  const raw = await env.AUTH.get('magic:' + token);
  if (!raw) return json({ error: 'link expired or already used' }, 400);
  await env.AUTH.delete('magic:' + token);   // single use

  let m; try { m = JSON.parse(raw); } catch { return json({ error: 'bad token' }, 400); }
  const email = m.email;
  const id = 'u-' + (await sha256hex(email)).slice(0, 16);
  const isInvite = !!m.room;

  // Upsert the user record (keep created-at).
  const userKey = 'user:' + email;
  let user;
  const existing = await env.AUTH.get(userKey);
  if (existing) {
    try { user = JSON.parse(existing); } catch { user = null; }
  }
  if (!user) {
    // New account → register with the chosen nick (request nick wins, then the
    // invite-suggested nick, then the email local part).
    user = { id, email, username: (nick || m.username || email.split('@')[0]).slice(0, 16), createdAt: Date.now() };
  } else {
    user.id = id;
    // Existing account: don't re-register. Only a normal (non-invite) sign-in
    // that supplies a username may refresh the display name.
    if (m.username && !isInvite) user.username = m.username;
  }
  await env.AUTH.put(userKey, JSON.stringify(user));

  // Invite → join the owner's collaborative room and remember it on the session.
  let room = null, rights = null;
  if (isInvite && env.COLLAB) {
    room = m.room;
    rights = m.rights === 'read' ? 'read' : 'write';
    try {
      const stub = env.COLLAB.get(env.COLLAB.idFromName(room));
      await stub.fetch('https://collab/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: room, userId: id, nick: user.username, rights }),
      });
    } catch (_) { /* presence still works; membership best-effort */ }
  }

  const sid = randToken();
  await env.AUTH.put('session:' + sid, JSON.stringify({ id, email, username: user.username, room, rights }), { expirationTtl: SESSION_TTL });

  return json({ token: sid, user: { id, email, name: user.username }, room, rights });
}

// GET /api/auth/me  (Authorization: Bearer <sid>) → { user, room, rights } or 401.
async function authMe(request, env) {
  const s = await sessionFor(env, bearer(request));
  if (!s) return json({ error: 'invalid session' }, 401);
  return json({ user: { id: s.id, email: s.email, name: s.username }, room: s.room || null, rights: s.rights || null });
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

// ── /api/collab/* — collaborative desktop (Durable Object) ──────────
// Routing model (a room is one owner's desktop, keyed by the owner's user id):
//   POST /api/collab/invite              → owner invites an email (Bearer auth)
//   GET  /api/collab/<room>/members?t=…  → member list (session token)
//   GET  /api/collab/<room>/ws?t=…       → live presence (who's here + cursors)
async function handleCollab(request, env, url) {
  if (!env.COLLAB) return json({ error: 'collab not configured' }, 500);

  const rest = url.pathname.slice('/api/collab/'.length);
  if (rest === 'invite' && request.method === 'POST') return collabInvite(request, env, url);

  const slash = rest.indexOf('/');
  const room = slash < 0 ? rest : rest.slice(0, slash);
  const action = slash < 0 ? '' : rest.slice(slash + 1);
  if (!room || !action) return json({ error: 'not found' }, 404);

  // Identify the caller from the session token in ?t= (WebSocket can't send an
  // Authorization header). The DO renders presence from this identity.
  const sid = url.searchParams.get('t') || bearer(request);
  const sess = await sessionFor(env, sid);
  if (!sess) return json({ error: 'unauthorized' }, 401);

  // Pass the verified identity to the DO via query params (robust across the
  // WebSocket upgrade — no header mutation on the forwarded request).
  const doUrl = new URL('https://collab/' + action);
  for (const [k, v] of url.searchParams) doUrl.searchParams.set(k, v);
  doUrl.searchParams.set('uid', sess.id);
  doUrl.searchParams.set('nick', sess.username || '');
  doUrl.searchParams.set('owner', room);
  const stub = env.COLLAB.get(env.COLLAB.idFromName(room));
  return stub.fetch(new Request(doUrl.toString(), request));
}

// POST /api/collab/invite { email, nick?, rights? } (Bearer <session>) → email a
// magic link that joins the caller's room. Only the owner can invite to it.
async function collabInvite(request, env, url) {
  const sess = await sessionFor(env, bearer(request));
  if (!sess) return json({ error: 'sign in to invite' }, 401);

  const body = await readJSON(request);
  const email = String((body && body.email) || '').trim().toLowerCase();
  const nick = String((body && body.nick) || '').trim().slice(0, 16);
  const rights = (body && body.rights) === 'read' ? 'read' : 'write';
  if (!isEmail(email)) return json({ error: 'invalid email' }, 400);

  const room = sess.id; // the owner's room IS their user id
  const token = randToken();
  await env.AUTH.put('magic:' + token, JSON.stringify({
    email, username: nick || undefined, room, rights, invitedBy: sess.username || '',
  }), { expirationTtl: COLLAB_INVITE_TTL });

  const origin = env.APP_URL || new URL(request.url).origin;
  const link = origin.replace(/\/$/, '') + '/auth?token=' + token;
  try {
    await sendInviteEmail(env, email, link, sess.username || 'someone');
  } catch (e) {
    return json({ error: 'could not send invite: ' + (e && e.message || e) }, 502);
  }
  return json({ ok: true });
}

// The CollabRoom Durable Object — one instance per owner's desktop. Holds the
// member list (persisted) and the live presence: who is connected and where
// their cursor is. Presence is ephemeral (in-memory + WS), the roster persists.
export class CollabRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cursors = new Map(); // userId -> { x, y }  (ephemeral)
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const action = parts[0] || '';
    if (action === 'join') return this.join(request);
    if (action === 'members') return this.members();
    if (action === 'ws') return this.handleWs(request);
    if (action === 'fs') return this.handleFs(parts[1] || '', request, url);
    return json({ error: 'not found' }, 404);
  }

  async join(request) {
    const b = await request.json().catch(() => null);
    if (!b || !b.userId) return json({ error: 'bad join' }, 400);
    if (b.owner && !(await this.state.storage.get('owner'))) {
      await this.state.storage.put('owner', b.owner);
    }
    await this.state.storage.put('member:' + b.userId, {
      userId: b.userId, nick: b.nick || 'guest',
      rights: b.rights === 'read' ? 'read' : 'write',
      joinedAt: Date.now(),
    });
    return json({ ok: true });
  }

  async members() {
    const owner = (await this.state.storage.get('owner')) || null;
    const map = await this.state.storage.list({ prefix: 'member:' });
    const members = [];
    for (const v of map.values()) members.push({ ...v, role: v.userId === owner ? 'owner' : 'host' });
    return json({ owner, members });
  }

  // Live presence socket. The worker has stamped the verified identity onto the
  // request headers; we attach it to the socket and broadcast the roster.
  async handleWs(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const q = new URL(request.url).searchParams;
    const userId = q.get('uid') || '';
    const nick = (q.get('nick') || '') || 'guest';
    const owner = q.get('owner') || (await this.state.storage.get('owner')) || '';
    if (owner && !(await this.state.storage.get('owner'))) await this.state.storage.put('owner', owner);
    const role = userId === owner ? 'owner' : 'host';
    const rights = await this.rightsOf(userId, owner);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, nick, role });
    server.send(JSON.stringify({ type: 'hello', you: { userId, nick, role, rights }, roster: this.roster() }));
    this.broadcastExcept(userId, { type: 'roster', roster: this.roster() });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Can this user write the shared desktop? The owner always; a host only if
  // their invite granted write rights.
  async rightsOf(userId, owner) {
    if (userId && userId === owner) return 'write';
    const m = await this.state.storage.get('member:' + userId);
    return (m && m.rights === 'write') ? 'write' : 'read';
  }

  // ── Shared desktop FS (two-way; owner's /desktop ⇄ /room/<owner>/) ──
  //   GET    fs/manifest          → { files:[{path,name,mime,size,mtime,hash}] }
  //   GET    fs/file?path=        → bytes (text as string, binary as ArrayBuffer)
  //   PUT    fs/file?path=        → store + broadcast (write rights required)
  //   DELETE fs/file?path=        → remove + broadcast (write rights required)
  async handleFs(sub, request, url) {
    const uid = url.searchParams.get('uid') || '';
    const owner = url.searchParams.get('owner') || (await this.state.storage.get('owner')) || '';
    if (sub === 'manifest') return this.fsManifest();
    if (sub === 'file') {
      const path = url.searchParams.get('path') || '';
      if (request.method === 'GET') return this.fsGet(path);
      const canWrite = (await this.rightsOf(uid, owner)) === 'write';
      if (!canWrite) return json({ error: 'read-only' }, 403);
      if (request.method === 'PUT') return this.fsPut(path, request);
      if (request.method === 'DELETE') return this.fsDelete(path);
    }
    return json({ error: 'not found' }, 404);
  }

  async fsManifest() {
    const map = await this.state.storage.list({ prefix: 'f:' });
    const files = [];
    for (const v of map.values()) files.push({ path: v.path, name: v.name, mime: v.mime, size: v.size, mtime: v.mtime, hash: v.hash });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return json({ files });
  }

  async fsGet(path) {
    if (!path) return json({ error: 'no path' }, 400);
    const f = await this.state.storage.get('f:' + path);
    if (!f) return json({ error: 'not found' }, 404);
    return new Response(f.data, { headers: { 'content-type': f.mime || 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  async fsPut(path, request) {
    if (!path || path.length > 1024) return json({ error: 'bad path' }, 400);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > SHARE_MAX_FILE) return json({ error: 'file too large', max: SHARE_MAX_FILE }, 413);
    const mime = request.headers.get('content-type') || 'application/octet-stream';
    const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('svg');
    const mtime = Number(request.headers.get('x-mtime')) || Date.now();
    const hash = request.headers.get('x-hash') || '';
    const existing = await this.state.storage.get('f:' + path);
    const meta = { path, name: path.split('/').pop(), mime, size: buf.byteLength, mtime, hash };
    const data = isText ? new TextDecoder().decode(buf) : buf;
    await this.state.storage.put('f:' + path, { ...meta, data });
    this.broadcast({ type: 'fs', op: existing ? 'updated' : 'added', file: meta });
    return json({ ok: true, file: meta });
  }

  async fsDelete(path) {
    if (!path) return json({ error: 'no path' }, 400);
    const had = await this.state.storage.delete('f:' + path);
    if (had) this.broadcast({ type: 'fs', op: 'deleted', path });
    return json({ ok: true });
  }

  roster() {
    const seen = new Map();
    for (const ws of this.state.getWebSockets()) {
      let a; try { a = ws.deserializeAttachment(); } catch { a = null; }
      if (!a || !a.userId) continue;
      const cur = this.cursors.get(a.userId);
      seen.set(a.userId, { userId: a.userId, nick: a.nick, role: a.role, x: cur ? cur.x : null, y: cur ? cur.y : null });
    }
    return [...seen.values()];
  }

  async webSocketMessage(ws, message) {
    let m; try { m = JSON.parse(message); } catch { return; }
    let a; try { a = ws.deserializeAttachment(); } catch { a = null; }
    if (!a) return;
    if (m.type === 'cursor') {
      this.cursors.set(a.userId, { x: m.x, y: m.y });
      this.broadcastExcept(a.userId, { type: 'cursor', userId: a.userId, nick: a.nick, role: a.role, x: m.x, y: m.y });
    }
  }

  webSocketClose(ws) {
    let a; try { a = ws.deserializeAttachment(); } catch { a = null; }
    if (a) { this.cursors.delete(a.userId); this.broadcast({ type: 'roster', roster: this.roster() }); }
  }
  webSocketError(ws) { this.webSocketClose(ws); }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) { try { ws.send(s); } catch {} }
  }
  broadcastExcept(userId, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      let a; try { a = ws.deserializeAttachment(); } catch { a = null; }
      if (!a || a.userId !== userId) { try { ws.send(s); } catch {} }
    }
  }
}

// Invite email (Resend) — tells the recipient who invited them into a desktop.
async function sendInviteEmail(env, email, link, inviter) {
  if (!env.RESEND_API_KEY) throw new Error('mail not configured');
  const from = env.MAIL_FROM || 'FakanOS <login@fakan.cz>';
  const who = String(inviter || 'someone').slice(0, 40);
  const subject = who + ' invited you to a FakanOS desktop';
  const text =
    who + ' invited you to share a desktop on FakanOS.\n\n' +
    'Open this link to join (valid 7 days):\n' + link + '\n\n' +
    'If this seems unexpected, you can ignore this email.';
  const html =
    '<div style="font-family:ui-monospace,Menlo,monospace;background:#0d0d0d;color:#ddd;padding:32px">' +
    '<div style="color:#00ff88;font-size:20px;font-weight:bold;letter-spacing:2px">F a k a n O S</div>' +
    '<p style="color:#bbb"><b>' + who + '</b> invited you to share a desktop. Open the link to join — you can pick a nickname on the way in.</p>' +
    '<p><a href="' + link + '" style="display:inline-block;background:#00ff88;color:#0d0d0d;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Join the desktop →</a></p>' +
    '<p style="color:#777;font-size:12px;word-break:break-all">' + link + '</p>' +
    '<p style="color:#555;font-size:12px">If this seems unexpected, ignore this email.</p>' +
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
