// newfish.js — New Fish (new-fish.net) time-tracker API client + secret storage.
//
// New Fish exposes a simple JSON REST API but sends NO CORS headers and its
// OPTIONS preflight 404s, so the browser cannot call it cross-origin directly.
// We therefore talk to a SAME-ORIGIN proxy at `/api/newfish/*` which forwards
// to `https://new-fish.net/api/v0/*` and relays the auth headers. The proxy
// lives in the Cloudflare worker (prod, worker/index.js) and in the python dev
// server (.claude/devserver.py) so it works both locally and deployed.
//
// Auth: every request carries `X-Auth-Email` + `X-Auth-Token` headers. The
// token is a SECRET the user generates on their New Fish "my account" page and
// pastes into the app UI. We never hardcode it; it lives only in localStorage
// (see the secret-storage section). localStorage is NOT encrypted — that is an
// inherent limit of a zero-dependency, no-backend browser app.
//
// API (from new-fish.net/help):
//   GET    /ping/ping.json                    → {"ping":"pong"}            (no auth)
//   GET    /ping/protected_ping.json          → {"ping":"protected pong"}  (auth test)
//   GET    /time_entries.json[?period=…|date_from=…&date_until=…|fulltext=…]
//   POST   /time_entries.json   body {"time_entry":{started_at,description,duration}}
//   DELETE /time_entries/:id.json

import { signal } from './signals.js';

// Same-origin proxy base. Maps `/api/newfish/X` → `https://new-fish.net/api/v0/X`.
const BASE = '/api/newfish';

const CRED_KEY = 'acii.newfish.v1';

// ── Secret storage (email + token) ─────────────────────────────────────────
// Kept in module scope; mirrored to localStorage. The reactive `account` signal
// exposes ONLY the email + a hasToken flag — never the raw token — so UI can
// react to credential changes without the secret leaking into render state.
function loadCreds() {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return { email: o.email || '', token: o.token || '' };
  } catch { return {}; }
}
let creds = loadCreds();

export const account = signal({ email: creds.email || '', hasToken: !!creds.token });

function publishAccount() {
  account.value = { email: creds.email || '', hasToken: !!creds.token };
}

export function setCredentials({ email, token }) {
  creds = {
    email: (email == null ? creds.email : String(email)).trim(),
    // Empty token string means "keep existing" only when email-only edits land;
    // callers that want to clear should use clearCredentials().
    token: (token == null || token === '') ? creds.token : String(token).trim(),
  };
  try { localStorage.setItem(CRED_KEY, JSON.stringify(creds)); } catch {}
  publishAccount();
}

export function clearCredentials() {
  creds = {};
  try { localStorage.removeItem(CRED_KEY); } catch {}
  publishAccount();
}

export function getEmail() { return creds.email || ''; }
export function hasCredentials() { return !!(creds.email && creds.token); }

function authHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Auth-Email': creds.email || '',
    'X-Auth-Token': creds.token || '',
  };
}

// ── Low-level request ───────────────────────────────────────────────────────
// Returns parsed JSON on 2xx. Throws an Error with a `.status` on failure so
// the UI can show "401 — bad token" vs. a network/proxy error distinctly.
async function req(path, { method = 'GET', body, auth = true } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: auth ? authHeaders() : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error('network: ' + (e?.message || e));
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(
      res.status === 401 ? 'unauthorized (401) — check email + token'
      : `http ${res.status}`,
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Endpoints ───────────────────────────────────────────────────────────────
export function ping() { return req('/ping/ping.json', { auth: false }); }
export function protectedPing() { return req('/ping/protected_ping.json'); }

// Fetch entries. opts: { period, dateFrom, dateUntil, fulltext }.
// `period` is a New Fish keyword (e.g. 'last_month'); date_from/until are
// 'YYYY-MM-DD'. Returns a normalized array of entries (see normalizeEntry).
export async function listEntries(opts = {}) {
  const q = new URLSearchParams();
  if (opts.period) q.set('period', opts.period);
  if (opts.dateFrom) q.set('date_from', opts.dateFrom);
  if (opts.dateUntil) q.set('date_until', opts.dateUntil);
  if (opts.fulltext) q.set('fulltext', opts.fulltext);
  const qs = q.toString();
  const data = await req('/time_entries.json' + (qs ? '?' + qs : ''));
  return extractEntries(data).map(normalizeEntry);
}

// Create an entry. `startedAt` is a Date or ISO string, `description` may carry
// #tags (parsed server-side), `duration` a New Fish duration string ('5m','1.5h').
export function createEntry({ startedAt, description, duration }) {
  const started_at = startedAt instanceof Date
    ? startedAt.toISOString()
    : (startedAt || new Date().toISOString());
  return req('/time_entries.json', {
    method: 'POST',
    body: { time_entry: { started_at, description: description || '', duration } },
  });
}

export function deleteEntry(id) {
  return req(`/time_entries/${encodeURIComponent(id)}.json`, { method: 'DELETE' });
}

// ── Response shaping ─────────────────────────────────────────────────────────
// The list endpoint's exact JSON shape isn't documented, so accept the common
// Rails variants: a bare array, {time_entries:[…]}, or {data:[…]}.
function extractEntries(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.time_entries)) return data.time_entries;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.entries)) return data.entries;
  return [];
}

// Normalize one raw entry into { id, startedAt(Date|null), description, minutes, tags[] }.
// Field names + duration encoding are guessed conservatively and tolerate
// several shapes; revisit once a real token reveals the true payload.
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return { id: null, startedAt: null, description: '', minutes: 0, tags: [] };
  const startedRaw = e.started_at ?? e.startedAt ?? e.start ?? e.date ?? null;
  const startedAt = startedRaw ? new Date(startedRaw) : null;
  const description = String(e.description ?? e.desc ?? e.text ?? '');
  const minutes = durationToMinutes(e.duration ?? e.duration_in_minutes ?? e.minutes ?? e.length);
  const tags = Array.isArray(e.tags)
    ? e.tags.map(t => String(t).replace(/^#/, ''))
    : parseTags(description);
  return { id: e.id ?? e.uuid ?? null, startedAt, description, minutes, tags, raw: e };
}

export function parseTags(description) {
  const out = [];
  const re = /#([\p{L}\p{N}_\-]+)/gu;
  let m;
  while ((m = re.exec(String(description || '')))) out.push(m[1]);
  return out;
}

// ── Duration handling ────────────────────────────────────────────────────────
// Convert a duration value into minutes. Accepts:
//   - strings with units: "5m", "1.5h", "90s", "1h30m", "2h 15m"
//   - bare numeric strings / numbers: treated as SECONDS (Rails/ActiveSupport
//     ::Duration serializes to seconds). Tweak NUMERIC_UNIT if real data differs.
const NUMERIC_UNIT = 'seconds'; // 'seconds' | 'minutes'
export function durationToMinutes(d) {
  if (d == null) return 0;
  if (typeof d === 'number') return numericToMinutes(d);
  const s = String(d).trim();
  if (s === '') return 0;
  // Pure number (optionally decimal) with no unit letters.
  if (/^-?\d+(\.\d+)?$/.test(s)) return numericToMinutes(parseFloat(s));
  // Unit-tagged: sum all <number><unit> groups (h/m/s, case-insensitive).
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|hour|hours|m|min|mins|minute|minutes|s|sec|secs|seconds)/gi;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u[0] === 'h') total += n * 60;
    else if (u[0] === 's') total += n / 60;
    else total += n; // minutes
  }
  return matched ? total : 0;
}
function numericToMinutes(n) {
  if (!isFinite(n)) return 0;
  return NUMERIC_UNIT === 'seconds' ? n / 60 : n;
}

// Format minutes for display: "1h 05m", "45m", "0m".
export function fmtMinutes(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h > 0) return `${h}h ${String(r).padStart(2, '0')}m`;
  return `${r}m`;
}

// ── Local date helpers (summaries are computed in the user's local timezone) ──
export function isSameDay(date, ref = new Date()) {
  if (!(date instanceof Date) || isNaN(date)) return false;
  return date.getFullYear() === ref.getFullYear()
    && date.getMonth() === ref.getMonth()
    && date.getDate() === ref.getDate();
}
export function isSameMonth(date, ref = new Date()) {
  if (!(date instanceof Date) || isNaN(date)) return false;
  return date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth();
}

// Sum minutes over entries matching a predicate.
export function sumMinutes(entries, pred = () => true) {
  let t = 0;
  for (const e of entries) if (pred(e)) t += e.minutes || 0;
  return t;
}

// Aggregate minutes per tag over the given entries → sorted [{tag, minutes}] desc.
// Entries with no tags fold into a synthetic '(untagged)' bucket.
export function minutesByTag(entries) {
  const map = new Map();
  for (const e of entries) {
    const tags = e.tags && e.tags.length ? e.tags : ['(untagged)'];
    for (const t of tags) map.set(t, (map.get(t) || 0) + (e.minutes || 0));
  }
  return [...map.entries()]
    .map(([tag, minutes]) => ({ tag, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
}

// 'YYYY-MM-DD' for a Date in LOCAL time (for date_from/date_until params).
export function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// ── Shared reactive store ─────────────────────────────────────────────────
// Both the widget and the app read this so they stay in sync off a single
// fetch. `entries` holds the current calendar month (covers today's + the
// month's summaries). Refreshes are de-duplicated and (for the widget's
// per-frame calls) throttled via maybeRefresh().
export const store = {
  entries: signal([]),    // normalized entries for the current month
  lastSync: signal(0),    // ms epoch of last successful sync (0 = never)
  loading: signal(false),
  error: signal(''),      // last error message ('' when ok), or 'no-credentials'
};

let _inflight = null;
export function refreshMonth() {
  if (!hasCredentials()) { store.error.value = 'no-credentials'; return Promise.resolve(); }
  if (_inflight) return _inflight;
  store.loading.value = true;
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  _inflight = listEntries({ dateFrom: localISODate(first), dateUntil: localISODate(now) })
    .then((list) => {
      store.entries.value = list;
      store.lastSync.value = Date.now();
      store.error.value = '';
    })
    .catch((err) => { store.error.value = err?.message || String(err); })
    .finally(() => { store.loading.value = false; _inflight = null; });
  return _inflight;
}

// Throttled refresh for hot paths (widget render loop). Refreshes at most once
// per `minAgeMs` and never while a fetch is in flight.
export function maybeRefresh(minAgeMs = 60000) {
  if (_inflight || store.loading.peek()) return;
  if (!hasCredentials()) return;
  if (Date.now() - store.lastSync.peek() < minAgeMs && store.lastSync.peek() !== 0) return;
  refreshMonth();
}

// Convenience selectors over the store's current entries.
export function todayMinutes() { return sumMinutes(store.entries.peek(), (e) => isSameDay(e.startedAt)); }
export function monthMinutes() { return sumMinutes(store.entries.peek(), (e) => isSameMonth(e.startedAt)); }
