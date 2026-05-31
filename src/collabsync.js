// collabsync.js — two-way shared-desktop file sync over the CollabRoom DO.
//
// Glue between the shared `fs` and a collab client. The owner's /desktop is the
// canonical tree; it's mirrored into the room and shown to joiners under
// /room/<owner>/. Writes flow both ways (a host with write rights edits their
// /room/<owner>/ copy → DO → broadcast → owner applies into /desktop, and vice
// versa). Last-write-wins; conflicts are not merged (phase 4 / CRDT territory).
//
// Loop avoidance: a `shadow` map holds the last-synced hash per relative path.
// We only push when the local hash differs from the shadow; applying a remote
// change updates the shadow BEFORE touching the FS, so the resulting change
// notification reconciles to a no-op.
//
// Not pure (it reads/writes the FS) — that's why it lives apart from the
// transport-only collab.js. No engine/DOM though.

import { isSafeRel } from './pathsafe.js';

const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'acii', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'xml',
  'svg', 'csv', 'tsv', 'yaml', 'yml', 'log', 'sh', 'py', 'toml', 'ini', 'conf',
]);
const MIME = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  html: 'text/html', htm: 'text/html', xml: 'text/xml', svg: 'image/svg+xml',
  csv: 'text/csv', acii: 'text/plain', log: 'text/plain', sh: 'text/x-sh',
  py: 'text/x-python', yaml: 'text/yaml', yml: 'text/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
function extOf(p) { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i + 1).toLowerCase(); }
function mimeFor(p) { const e = extOf(p); return MIME[e] || (TEXT_EXT.has(e) ? 'text/plain' : 'application/octet-stream'); }
function djb2(buf) {
  const u = new Uint8Array(buf);
  let h = 5381;
  for (let i = 0; i < u.length; i++) h = ((h * 33) ^ u[i]) >>> 0;
  return h.toString(16);
}

export function createDesktopSync({ fs, client, room, token, isOwner, canWrite }) {
  const localRoot = isOwner ? '/desktop' : '/room/' + room;
  const shadow = new Map();  // rel -> { hash, mtime }
  let applying = 0;          // >0 while applying a remote change (suppress push)
  let pushTimer = null;
  let unsub = null;
  let stopped = false;

  const joinRel = (rel) => localRoot + '/' + rel;
  const relOf = (path) => path.slice(localRoot.length + 1);

  function ensureRoot() { try { fs.mkdir(localRoot); } catch {} }

  // Flat list of file paths under localRoot.
  function localFiles() {
    const out = [];
    (function walk(p) {
      let st; try { st = fs.stat(p); } catch { st = null; }
      if (!st) return;
      if (st.type === 'file') { out.push(p); return; }
      for (const e of fs.list(p)) walk(p === '/' ? '/' + e.name : p + '/' + e.name);
    })(localRoot);
    return out;
  }

  async function pushOne(rel) {
    const full = joinRel(rel);
    const buf = await fs.readBytesAsync(full);
    const h = djb2(buf);
    const prev = shadow.get(rel);
    if (prev && prev.hash === h) return;                  // unchanged → skip
    const st = fs.stat(full) || {};
    await client.fsPush(room, token, rel, buf, { mime: mimeFor(rel), mtime: st.mtime || Date.now(), hash: h });
    shadow.set(rel, { hash: h, mtime: st.mtime || Date.now() });
  }

  // Make the room match our local tree: push new/changed files, delete the ones
  // we previously synced but that are gone locally.
  async function reconcile() {
    if (!canWrite || stopped) return;
    const seen = new Set();
    for (const path of localFiles()) {
      const rel = relOf(path);
      seen.add(rel);
      try { await pushOne(rel); } catch (_) { /* keep going; retried on next change */ }
    }
    for (const rel of [...shadow.keys()]) {
      if (!seen.has(rel)) {
        try { await client.fsDelete(room, token, rel); } catch {}
        shadow.delete(rel);
      }
    }
  }

  function scheduleReconcile() {
    if (!canWrite || stopped) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; if (applying === 0) reconcile(); }, 300);
  }

  // Apply a remote fs event into the local tree (shadow first → loop-safe).
  async function onRemote(evt) {
    if (stopped || !evt) return;
    applying++;
    try {
      if (evt.op === 'deleted') {
        if (!isSafeRel(evt.path)) return;       // reject traversal from a hostile peer
        shadow.delete(evt.path);
        try { fs.delete(joinRel(evt.path)); } catch {}
      } else if (evt.file) {
        const rel = evt.file.path;
        if (!isSafeRel(rel)) return;            // never let `../` escape the room mount
        const { bytes } = await client.fsPull(room, token, rel);
        shadow.set(rel, { hash: djb2(bytes), mtime: evt.file.mtime });
        fs.write(joinRel(rel), new Uint8Array(bytes));
      }
    } catch (_) { /* transient; a later event or reconcile heals it */ }
    finally { applying--; }
  }

  async function start() {
    ensureRoot();
    let man = null;
    try { man = await client.fsManifest(room, token); } catch {}
    if (isOwner) {
      // Owner is the source of truth. Seed the shadow from the room's current
      // hashes so unchanged files aren't re-uploaded, then push the local tree.
      if (man) for (const f of man.files) shadow.set(f.path, { hash: f.hash || null, mtime: f.mtime });
      await reconcile();
    } else if (man) {
      // Joiner: pull the owner's desktop into /room/<owner>/.
      for (const f of man.files) await onRemote({ op: 'added', file: f });
    }
    // Live local edits → push (only if allowed to write).
    if (canWrite) unsub = fs.subscribe(localRoot, scheduleReconcile);
  }

  function destroy() {
    stopped = true;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (unsub) { try { unsub(); } catch {} unsub = null; }
  }

  return { start, onRemote, destroy, localRoot };
}
