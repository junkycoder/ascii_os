// pathsafe.js — relative-path validation shared by the FS sync glue and the
// edge worker. Pure, zero-dependency, no DOM / no Node API, so it bundles into
// the Cloudflare worker (worker/index.js imports it) AND runs in the browser
// (collabsync.js / share.js import it).
//
// Untrusted relative paths arrive from two directions: a CollabRoom/ShareRoom
// broadcast (`evt.file.path`) and a manifest pulled on join. A hostile peer can
// craft `../../desktop/evil` to escape the room mount and overwrite another
// peer's /desktop or /apps. `isSafeRel` is the single chokepoint that rejects
// any path that isn't a plain, forward-only, relative path.

// A safe relative path: a non-empty string ≤ 1024 chars, no leading slash
// (would make it absolute), and every `/`-separated segment is non-empty, not
// `.` or `..`, and free of control characters. A trailing slash is rejected too
// (it yields a trailing empty segment).
export function isSafeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
  if (rel[0] === '/') return false;
  const segs = rel.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) return false; // control chars
    }
  }
  return true;
}
