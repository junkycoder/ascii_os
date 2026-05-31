// git.js — a tiny simulated git, layered over the virtual FS (fs.js).
//
// FakanOS has no real git (zero deps, no backend). This module gives any
// folder in the virtual FS a "repo" identity and the core git mental model:
// HEAD → a branch → a chain of commits, plus a two-stage working area
// (working tree vs. staging index). It's intentionally a *simulation* — file
// contents are snapshotted into commits in full (the FS is tiny) rather than
// hashed into a packfile — but the semantics (stage / unstage / commit /
// branch / checkout / diff / log / status) behave the way you'd expect.
//
// Storage: each repo keeps its state JSON in `<repo>/.git/state.json`, written
// through the shared FS — so it persists per-user for free (the FS is already
// namespaced by account) and travels with the folder. Anything under `.git/`
// is invisible to status / tracking.
//
// Design mirrors the other "engine" modules: it owns no DOM, takes an `fs`
// instance, and exposes reactive `signal`s (`changes`, `activeRepo`) so the
// shell widget, the taskbar, and the gitdesk app all re-render on mutation.
//
// API (all repo-scoped calls take the repo root path):
//   isRepo(path) · repoFor(path) · listRepos()
//   init(path)
//   status(repo) · diff(repo, rel)
//   stage / unstage / stageAll / unstageAll / discard(repo, rel?)
//   commit(repo, message, author?) · log(repo)
//   branches(repo) · createBranch(repo, name, {checkout}) · checkout(repo, name)
//   setActive(path) · activeRepo (signal) · changes (signal)

import { signal } from './signals.js';

const GIT_DIR = '.git';
const STATE_FILE = '.git/state.json';
const DEFAULT_BRANCH = 'main';

// --- path helpers (repo-relative ⇄ absolute) ------------------------------
function norm(p) {
  if (!p || p === '/') return '/';
  if (p[0] !== '/') p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}
function rel(repo, abs) {
  repo = norm(repo); abs = norm(abs);
  if (abs === repo) return '';
  return abs.slice(repo.length + 1);
}
function abs(repo, r) {
  return norm(repo + '/' + r);
}

// A short, stable-ish commit id from its content (djb2 → hex). Not a real
// SHA-1, but it looks the part and is deterministic given the inputs.
function shortId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  // mix a second pass for a touch more spread
  let h2 = 52711;
  for (let i = str.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + str.charCodeAt(i)) | 0;
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return (hex(h) + hex(h2)).slice(0, 12);
}

// --- a compact LCS line diff (working vs. a base snapshot) ----------------
// Returns [{ type:'ctx'|'add'|'del', text }] suitable for a unified-ish view.
function diffLines(oldText, newText) {
  const a = (oldText == null ? '' : String(oldText)).split('\n');
  const b = (newText == null ? '' : String(newText)).split('\n');
  // LCS table (rows = a, cols = b). Files here are small; O(n·m) is fine.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i++] }); }
  while (j < m) { out.push({ type: 'add', text: b[j++] }); }
  return out;
}

export function createGit(fs) {
  if (!fs) throw new Error('createGit(fs): an fs instance is required');

  const changes = signal(0);
  const activeRepo = signal(null);
  // In-memory cache of parsed state per repo, keyed by repo root. Kept in sync
  // with the on-disk state.json; reloaded if missing.
  const cache = new Map();

  function bump() { changes.value = changes.value + 1; }

  // --- state load / save -------------------------------------------------
  function freshState() {
    return {
      version: 1,
      head: DEFAULT_BRANCH,        // current branch name
      branches: { [DEFAULT_BRANCH]: null }, // name -> commitId | null
      commits: {},                 // id -> { id, parent, message, author, time, tree }
      index: {},                   // staged tree: relPath -> content
      seq: 0,                       // monotonic counter feeding commit ids
    };
  }

  function loadState(repo) {
    repo = norm(repo);
    if (cache.has(repo)) return cache.get(repo);
    const sp = abs(repo, STATE_FILE);
    let st = null;
    try {
      if (fs.exists(sp)) st = JSON.parse(fs.readText(sp));
    } catch { st = null; }
    if (!st || st.version !== 1) st = freshState();
    cache.set(repo, st);
    return st;
  }

  function saveState(repo, st) {
    repo = norm(repo);
    cache.set(repo, st);
    fs.mkdir(abs(repo, GIT_DIR));
    fs.write(abs(repo, STATE_FILE), JSON.stringify(st));
  }

  // --- working-tree walk (excludes .git, files only, repo-relative) ------
  function workingFiles(repo) {
    repo = norm(repo);
    const out = {}; // relPath -> content
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.list(dir); } catch { return; }
      for (const e of entries) {
        const childAbs = norm(dir + '/' + e.name);
        const r = rel(repo, childAbs);
        if (r === GIT_DIR || r.startsWith(GIT_DIR + '/')) continue; // skip .git
        if (e.type === 'dir') walk(childAbs);
        else {
          let content = '';
          try { content = fs.readText(childAbs); } catch { content = ''; }
          out[r] = content;
        }
      }
    };
    walk(repo);
    return out;
  }

  function treeOf(st, commitId) {
    if (!commitId) return {};
    const c = st.commits[commitId];
    return c ? (c.tree || {}) : {};
  }
  function headTree(st) {
    return treeOf(st, st.branches[st.head]);
  }

  // --- repo discovery ----------------------------------------------------
  function isRepo(path) {
    path = norm(path);
    return fs.exists(abs(path, GIT_DIR));
  }

  // Nearest ancestor (or self) that is a repo root, else null.
  function repoFor(path) {
    let p = norm(path);
    // If `path` is a file, start from it; we walk up by directory boundaries.
    while (true) {
      if (isRepo(p)) return p;
      if (p === '/') return null;
      const i = p.lastIndexOf('/');
      p = i === 0 ? '/' : p.slice(0, i);
    }
  }

  // Scan the whole FS for `.git` dirs → repo roots.
  function listRepos() {
    const repos = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.list(dir); } catch { return; }
      for (const e of entries) {
        if (e.type !== 'dir') continue;
        const childAbs = norm(dir + '/' + e.name);
        if (e.name === GIT_DIR) { repos.push(norm(dir)); continue; }
        walk(childAbs);
      }
    };
    walk('/');
    return repos;
  }

  // --- init --------------------------------------------------------------
  function init(path) {
    path = norm(path);
    if (path === '/') throw new Error('Refusing to init a repo at /');
    if (!fs.exists(path)) fs.mkdir(path);
    if (isRepo(path)) return loadState(path); // already a repo
    const st = freshState();
    saveState(path, st);
    if (!activeRepo.peek()) activeRepo.value = path;
    bump();
    return st;
  }

  // --- clone -------------------------------------------------------------
  // Materialize an externally-fetched file set into `dest`, make it a repo, and
  // record the fetched tree as the initial commit so the working tree is clean
  // right after. `files` is [{ path, data }] with `data` anything fs.write
  // accepts (string | Uint8Array). The network fetch lives in the shell — this
  // stays FS-only, like the rest of the engine. Returns the repo root path.
  function clone(dest, files, { message } = {}) {
    dest = norm(dest);
    if (dest === '/') throw new Error('Refusing to clone into /');
    fs.mkdir(dest);
    for (const f of files || []) {
      if (!f || !f.path) continue;
      const r = String(f.path).replace(/^\/+/, '');
      if (!r || r === GIT_DIR || r.startsWith(GIT_DIR + '/')) continue; // never overwrite .git
      try { fs.write(abs(dest, r), f.data); } catch {}
    }
    init(dest);
    stageAll(dest);
    try { commit(dest, message || ('Clone into ' + dest)); } catch {} // empty repo → no commit
    setActive(dest);
    return dest;
  }

  // --- status ------------------------------------------------------------
  // Two-area model: head ⇄ index = "staged"; index ⇄ working = "unstaged".
  // Untracked = present in working, absent from both index and head.
  function status(repo) {
    repo = norm(repo);
    const st = loadState(repo);
    const work = workingFiles(repo);
    const head = headTree(st);
    const index = st.index || {};

    const staged = [];    // { path, status:'A'|'M'|'D' }
    const unstaged = [];  // { path, status:'A'|'M'|'D' }  (A here = untracked)

    const allStaged = new Set([...Object.keys(index), ...Object.keys(head)]);
    for (const p of allStaged) {
      const inIdx = p in index, inHead = p in head;
      if (inIdx && !inHead) staged.push({ path: p, status: 'A' });
      else if (!inIdx && inHead) staged.push({ path: p, status: 'D' });
      else if (inIdx && inHead && index[p] !== head[p]) staged.push({ path: p, status: 'M' });
    }

    const allWork = new Set([...Object.keys(work), ...Object.keys(index)]);
    for (const p of allWork) {
      const inWork = p in work, inIdx = p in index, inHead = p in head;
      if (inWork && !inIdx && !inHead) unstaged.push({ path: p, status: 'A' }); // untracked
      else if (inWork && inIdx && work[p] !== index[p]) unstaged.push({ path: p, status: 'M' });
      else if (!inWork && (inIdx || inHead)) unstaged.push({ path: p, status: 'D' });
    }

    staged.sort((a, b) => a.path.localeCompare(b.path));
    unstaged.sort((a, b) => a.path.localeCompare(b.path));

    return {
      repo,
      branch: st.head,
      detached: !st.head,
      staged,
      unstaged,
      clean: staged.length === 0 && unstaged.length === 0,
      changeCount: staged.length + unstaged.length,
      commitCount: countCommits(st),
      hasCommits: !!st.branches[st.head],
    };
  }

  function countCommits(st) {
    let id = st.branches[st.head], n = 0, guard = 0;
    while (id && guard++ < 10000) { n++; id = st.commits[id]?.parent || null; }
    return n;
  }

  // Diff a single file: HEAD/index base vs. working content. `which` selects
  // the base — 'work' (working vs index, default) or 'staged' (index vs head).
  function diff(repo, relPath, which = 'work') {
    repo = norm(repo);
    const st = loadState(repo);
    const work = workingFiles(repo);
    const head = headTree(st);
    const index = st.index || {};
    let oldText, newText;
    if (which === 'staged') { oldText = head[relPath] ?? ''; newText = index[relPath] ?? ''; }
    else { oldText = (relPath in index ? index[relPath] : head[relPath]) ?? ''; newText = work[relPath] ?? ''; }
    return diffLines(oldText, newText);
  }

  // --- staging -----------------------------------------------------------
  function stage(repo, relPath) {
    repo = norm(repo);
    const st = loadState(repo);
    const work = workingFiles(repo);
    if (relPath in work) st.index[relPath] = work[relPath]; // add / modify
    else delete st.index[relPath];                          // stage a deletion
    saveState(repo, st);
    bump();
  }
  function stageAll(repo) {
    repo = norm(repo);
    const st = loadState(repo);
    const work = workingFiles(repo);
    const next = {};
    for (const p of Object.keys(work)) next[p] = work[p];
    st.index = next; // staged tree == working tree (handles adds, mods, dels)
    saveState(repo, st);
    bump();
  }
  function unstage(repo, relPath) {
    repo = norm(repo);
    const st = loadState(repo);
    const head = headTree(st);
    if (relPath in head) st.index[relPath] = head[relPath]; // revert index to HEAD
    else delete st.index[relPath];
    saveState(repo, st);
    bump();
  }
  function unstageAll(repo) {
    repo = norm(repo);
    const st = loadState(repo);
    st.index = { ...headTree(st) };
    saveState(repo, st);
    bump();
  }

  // Discard working-tree changes for a file (revert to index, else HEAD,
  // else delete if untracked). No arg → discard *all* unstaged changes.
  function discard(repo, relPath) {
    repo = norm(repo);
    const st = loadState(repo);
    const head = headTree(st);
    const index = st.index || {};
    const restore = (p) => {
      const base = (p in index) ? index[p] : (p in head) ? head[p] : null;
      const ap = abs(repo, p);
      if (base == null) { if (fs.exists(ap)) { try { fs.delete(ap); } catch {} } }
      else { try { fs.write(ap, base); } catch {} }
    };
    if (relPath) restore(relPath);
    else {
      const s = status(repo);
      for (const e of s.unstaged) restore(e.path);
    }
    bump();
  }

  // --- commit ------------------------------------------------------------
  function commit(repo, message, author) {
    repo = norm(repo);
    const st = loadState(repo);
    const head = headTree(st);
    const index = st.index || {};
    // Nothing to commit if the index matches HEAD exactly.
    const keys = new Set([...Object.keys(index), ...Object.keys(head)]);
    let differs = false;
    for (const k of keys) if (index[k] !== head[k]) { differs = true; break; }
    if (!differs) throw new Error('nothing to commit (staging area clean)');
    if (!message || !message.trim()) throw new Error('aborting commit due to empty message');

    const parent = st.branches[st.head] || null;
    const time = Date.now();
    const seq = (st.seq = (st.seq || 0) + 1);
    const tree = { ...index };
    const id = shortId(message + '|' + parent + '|' + time + '|' + seq +
      '|' + Object.keys(tree).sort().join(','));
    st.commits[id] = {
      id, parent,
      message: message.trim(),
      author: author || 'you <you@fakan.os>',
      time, tree,
    };
    st.branches[st.head] = id;
    saveState(repo, st);
    bump();
    return id;
  }

  function log(repo) {
    repo = norm(repo);
    const st = loadState(repo);
    const out = [];
    let id = st.branches[st.head], guard = 0;
    while (id && guard++ < 10000) {
      const c = st.commits[id];
      if (!c) break;
      out.push(c);
      id = c.parent;
    }
    return out; // newest first
  }

  // --- branches ----------------------------------------------------------
  function branches(repo) {
    repo = norm(repo);
    const st = loadState(repo);
    const list = Object.keys(st.branches).sort().map((name) => ({
      name, head: st.branches[name], current: name === st.head,
    }));
    return { current: st.head, list };
  }

  function createBranch(repo, name, { checkout = false } = {}) {
    repo = norm(repo);
    name = String(name || '').trim();
    if (!name) throw new Error('branch name required');
    if (/[\s~^:?*\\]/.test(name)) throw new Error('invalid branch name');
    const st = loadState(repo);
    if (st.branches[name] != null || name in st.branches) {
      if (!checkout) throw new Error('branch already exists: ' + name);
    } else {
      st.branches[name] = st.branches[st.head] || null; // fork from current tip
    }
    if (checkout) st.head = name;
    saveState(repo, st);
    bump();
  }

  // Switch branches: move HEAD, then sync the working tree + index to the
  // target branch's commit tree (writes/updates tracked files, removes
  // tracked files not in the target). Uncommitted-change safety is the
  // caller's call — gitdesk confirms first.
  function checkout(repo, name) {
    repo = norm(repo);
    const st = loadState(repo);
    if (!(name in st.branches)) throw new Error('no such branch: ' + name);
    const targetTree = treeOf(st, st.branches[name]);
    const prevTracked = new Set(Object.keys(st.index || {}));
    // Write target tree into the working dir.
    for (const [p, content] of Object.entries(targetTree)) {
      try { fs.write(abs(repo, p), content); } catch {}
    }
    // Remove files that were tracked before but aren't in the target tree.
    for (const p of prevTracked) {
      if (!(p in targetTree)) {
        const ap = abs(repo, p);
        if (fs.exists(ap)) { try { fs.delete(ap); } catch {} }
      }
    }
    st.head = name;
    st.index = { ...targetTree };
    saveState(repo, st);
    bump();
  }

  // --- active repo -------------------------------------------------------
  function setActive(path) {
    const r = path ? repoFor(path) : null;
    activeRepo.value = r;
    bump();
    return r;
  }

  // Convenience for the widget / taskbar: status of the active repo (or the
  // first repo found), or null when there are no repos at all.
  function activeStatus() {
    let repo = activeRepo.peek();
    if (!repo || !isRepo(repo)) {
      const all = listRepos();
      repo = all[0] || null;
      if (repo && repo !== activeRepo.peek()) activeRepo.value = repo;
    }
    if (!repo) return null;
    try { return status(repo); } catch { return null; }
  }

  // Drop cached parse for a repo (e.g. after an external FS edit).
  function invalidate(repo) { cache.delete(norm(repo)); bump(); }

  return {
    changes,
    activeRepo,
    isRepo,
    repoFor,
    listRepos,
    init,
    clone,
    status,
    activeStatus,
    diff,
    stage, stageAll,
    unstage, unstageAll,
    discard,
    commit,
    log,
    branches,
    createBranch,
    checkout,
    setActive,
    invalidate,
  };
}
