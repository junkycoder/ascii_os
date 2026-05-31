// FakanOS auth — email + magic-link sign-in, session, per-user storage keys.
//
// Replaces the old local account store (users.js). Identity is the user's
// EMAIL; the edge worker (worker/index.js, backed by Cloudflare KV) issues a
// long-lived opaque session token in exchange for a single-use magic-link
// token delivered by email. Username is a display name chosen on first sign-in.
//
// No engine/DOM dependency — login.js renders the form, index.html boots the
// shell. Uses fetch + localStorage + Date.now at runtime (deliberate; fine in
// the browser, never imported by a Workflow script).
//
// localStorage:
//   acii.session.v3 -> { token, user, at }
//     user = { id, email, name, glyph, color }   (glyph/color derived here)
//
// "Remember the login for a long time": the session token carries a long TTL
// server-side; the client boots the shell immediately from the cached user and
// only revalidates in the background (offline → keep trusting the cache).

const SESSION_KEY = 'acii.session.v3';
const API = '/api/auth';

// Avatar palette — picked deterministically from the user id so the same
// account always gets the same chip glyph/color (no server round-trip needed).
const GLYPHS = ['☺', '★', '◆', '♦', '☻', '⚉', '✦', '❖', '▲', '●'];
const COLORS = ['accent', 'link', 'warning', 'success', 'error'];

function hashStr(s) {
  let h = 0x811c9dc5 >>> 0;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

// Normalize a raw server user into the shape the shell chip expects.
function decorate(user) {
  if (!user) return null;
  const email = String(user.email || '').trim();
  const id = user.id || ('u-' + hashStr(email).toString(16));
  const h = hashStr(id);
  const name = String(user.name || user.username || email.split('@')[0] || 'user').slice(0, 16);
  return {
    id,
    email,
    name,
    glyph: user.glyph || GLYPHS[h % GLYPHS.length],
    color: user.color || COLORS[h % COLORS.length],
  };
}

// ── session storage ───────────────────────────────────────────────
export function getSession() {
  let raw = null;
  try { raw = localStorage.getItem(SESSION_KEY); } catch {}
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    // A real session has a server token; a guest session has guest:true and no
    // token (local-only, never validated against the server).
    if (!s || !s.user || (!s.token && !s.guest)) return null;
    return { token: s.token || null, guest: !!s.guest, room: s.room || null, rights: s.rights || null, at: s.at, user: decorate(s.user) };
  } catch { return null; }
}

export function saveSession(token, user, room, rights) {
  const s = { token, guest: false, user: decorate(user), room: room || null, rights: rights || null, at: Date.now() };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  return s;
}

// Local guest sign-in — no email, no server round-trip. A stable 'guest' id
// gives it its own FS + desktop namespace; persisted like any session so a
// reload keeps the guest logged in until they log out.
export function signInGuest() {
  const user = decorate({ id: 'guest', email: '', name: 'guest' });
  const s = { token: null, guest: true, user, at: Date.now() };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  return { token: null, guest: true, at: s.at, user };
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ── network ───────────────────────────────────────────────────────
async function postJSON(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data || {};
}

// Ask the server to email a magic link. Resolves on accepted (does NOT mean the
// address exists — the server never leaks that). Throws on a bad request.
export function requestLink({ email, username, target } = {}) {
  return postJSON('/request', {
    email: String(email || '').trim().toLowerCase(),
    username: String(username || '').trim(),
    // 'app' → the worker tags the magic link with &target=app so the landing
    // page can bounce the token into the native app. Omitted for web sign-in.
    target: target === 'app' ? 'app' : undefined,
  });
}

// Inspect a magic/invite token WITHOUT consuming it — lets the boot flow decide
// whether to collect a nickname (new invited user) before verifying.
// → { valid, invite, email, exists, nick, invitedBy }
export async function peek(token) {
  return postJSON('/peek', { token: String(token || '') });
}

// Exchange a single-use magic-link token for a long-lived session. `nick` seeds
// a brand-new account only (existing users keep their name). Invite links carry
// a room server-side; we persist it on the session so boot enters that desktop.
export async function verify(token, nick) {
  const data = await postJSON('/verify', { token: String(token || ''), nick: String(nick || '') });
  if (!data.token || !data.user) throw new Error('bad verify response');
  return saveSession(data.token, data.user, data.room || null, data.rights || null);
}

// Revalidate the stored session against the server. Returns the (refreshed)
// session, or null if the server rejected the token (401 → signed out).
// Network error / offline → keep trusting the cached session (long-remember).
export async function refresh() {
  const s = getSession();
  if (!s) return null;
  if (s.guest || !s.token) return s;   // local guest → nothing to validate
  try {
    const res = await fetch(API + '/me', { headers: { authorization: 'Bearer ' + s.token } });
    if (res.status === 401) { clearSession(); return null; }
    if (!res.ok) return s;
    const data = await res.json().catch(() => null);
    if (data && data.user) return saveSession(s.token, data.user, data.room != null ? data.room : s.room, data.rights != null ? data.rights : s.rights);
    return s;
  } catch { return s; }
}

// ── magic-link token from the current URL (web) or a deeplink (iOS) ──
// Web link:  https://os.fakan.cz/auth?token=…
// Deeplink:  fakanos://auth?token=…   (and the universal-link form above)
export function tokenFromUrl(href) {
  try {
    const u = new URL(href || location.href);
    return u.searchParams.get('token') || null;
  } catch { return null; }
}

// Drop the token from the address bar once it's been consumed.
export function cleanUrl() {
  try { history.replaceState(null, '', '/'); } catch {}
}

// ── per-user storage keys (namespaced by server user id) ───────────
// Every account gets its own FS + desktop. (The old 'default' legacy-key
// special case is gone with the local account store.)
export function fsKey(user) {
  const id = typeof user === 'string' ? user : (user && user.id);
  return 'acii.fs.v1::' + id;
}
export function shellKey(user) {
  const id = typeof user === 'string' ? user : (user && user.id);
  return 'acii.shell.v2::' + id;
}
