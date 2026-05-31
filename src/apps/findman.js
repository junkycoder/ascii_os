// findman.js — "Findman Dick": a Feynman-flavored rebrand of the Finder app.
//
// Named for Richard Phillips Feynman ("Dick" == Richard). File tree + text
// editor, Ctrl+S to save, "+ mount local…", picks up globalThis.__aciiOpenFile.
//
// Adds over the classic Finder:
//   - Feynman theming: app id 'findman', label "Findman Dick", ASCII icon,
//     an about box (full name + quote), and Feynman quotes in the empty state.
//   - DRAFTS: every edit is auto-backed-up (debounced) to the shared drafts
//     store; reopening a file with a newer draft restores it; a real save
//     clears the draft.
//   - VIM (opt-in via user.prefs.vimEnabled): onKey routes through a vim engine
//     when enabled, with a mode/status line. :w saves, :q closes. F9 / leader+v
//     toggles the pref.
//
// Coords passed to render(ctx) are LOCAL to the window content.

import { signal } from '../signals.js';
import { createFS } from '../fs.js';
import { createDrafts } from '../drafts.js';
import { createVim } from '../vim.js';
import { createUser } from '../user.js';
import { langForPath, highlight, roleColor } from '../syntax.js';
import { createMarkdownView } from '../markdown.js';

const SAVE_FLASH_MS = 1000;

// ── Feynman flavor ─────────────────────────────────────────────────────
export const APP_ID = 'findman';
export const APP_LABEL = 'Findman Dick';
// Compact ASCII icon (atom-ish — "Dick" was a physicist).
export const APP_ICON = '(e-)';
const FULL_NAME = 'Richard Phillips Feynman';

const FEYNMAN_QUOTES = [
  'What I cannot create, I do not understand.',
  'I would rather have questions that can\'t be answered than answers that can\'t be questioned.',
  'The first principle is that you must not fool yourself — and you are the easiest person to fool.',
  'Study hard what interests you the most in the most undisciplined, irreverent and original manner possible.',
  'Nobody ever figures out what life is all about, and it doesn\'t matter.',
];
// Deterministic-ish pick at app construction so the empty state is stable
// during a session (no Math.random churn each frame).
function pickQuote() {
  const t = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  return FEYNMAN_QUOTES[Math.abs((t / 1000) | 0) % FEYNMAN_QUOTES.length];
}

// ── Shared singletons ──────────────────────────────────────────────────
function getFS(win) {
  if (win && win.fs) return win.fs;
  if (!globalThis.__aciiFS) globalThis.__aciiFS = createFS();
  return globalThis.__aciiFS;
}
const drafts = globalThis.__aciiDrafts ||= createDrafts();
const user = globalThis.__aciiUser ||= createUser();

// ── Path helpers ───────────────────────────────────────────────────────
function parentOf(path) {
  if (!path || path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
function joinPath(a, b) {
  if (a === '/') return '/' + b;
  return a + '/' + b;
}

// ── Binary detection ───────────────────────────────────────────────────
const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'acii', 'html', 'htm', 'css', 'js', 'mjs', 'ts',
  'xml', 'svg', 'csv', 'tsv', 'yaml', 'yml', 'log', 'sh', 'py', 'rs',
  'go', 'c', 'h', 'cpp', 'java', 'rb', 'lua', 'toml', 'ini', 'conf'
]);
function isTextPath(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return true;
  return TEXT_EXT.has(path.slice(i + 1).toLowerCase());
}

export function createApp(initialCtx, win) {
  const fs = getFS(win);
  const sessionQuote = pickQuote();

  // ── Tree state ─────────────────────────────────────────────────────
  const expanded = new Set(['/']);
  let selectedPath = '/docs/README.md';     // the cursor / lead row
  let treeScroll = 0;

  // ── Multi-selection (for bulk actions) ─────────────────────────────
  // `selected` holds the EXTRA marked paths beyond the single cursor; it is
  // empty during ordinary single-row navigation and only fills up via
  // Shift/Cmd+click, Shift+arrows, Cmd+A, spacebar, or a marquee drag.
  const selected = new Set();
  let selAnchorIdx = -1;                     // anchor for Shift-range extends

  // Marquee (rubber-band) drag-select. Coords are LOCAL to the window content
  // (same space as render), so the box can be drawn directly. `base` is the
  // selection snapshot at drag start (for additive Cmd-drag).
  let drag = null;
  let suppressClick = false;                 // eat the click that trails a drag

  // ── Editor state ───────────────────────────────────────────────────
  let editorPath = null;
  let editorLines = [''];
  let editorBinarySize = -1;
  let editorLoadError = null;
  let editorRow = 0;
  let editorCol = 0;
  let editorScrollY = 0;
  let editorDirty = false;

  // Syntax-highlight cache: re-tokenize only when the buffer text or language
  // changes. rows = Array<Array<{text, role}>> (one entry per source line).
  let hlCache = { text: null, lang: null, rows: null };
  function highlightRows(text, lang) {
    if (!lang) return null;
    if (hlCache.text === text && hlCache.lang === lang) return hlCache.rows;
    const rows = highlight(text, lang);
    hlCache = { text, lang, rows };
    return rows;
  }
  // Markdown preview (classic mode renders .md styled like the web via the
  // shared markdown view; vim mode shows raw source with md highlighting).
  let mdView = null;
  let mdViewSource = null;
  function ensureMdView(source) {
    if (!mdView) { mdView = createMarkdownView({ source, w: 1, h: 1 }); mdViewSource = source; }
    else if (mdViewSource !== source) { mdView.setSource(source); mdViewSource = source; }
    return mdView;
  }
  function mdPreviewActive() {
    return !vim && editorPath && editorBinarySize < 0 && !editorLoadError
      && langForPath(editorPath) === 'md';
  }
  // A clipped, offset drawing surface so the markdown view (which draws from
  // 0,0) renders inside the editor's inner rect.
  function offsetCtx(ctx, ox, oy, w, h) {
    const clip = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    return {
      width: w, height: h, theme: ctx.theme, fps: ctx.fps, mode: ctx.mode,
      put(x, y, ch, st) { if (clip(x, y)) ctx.put(ox + x, oy + y, ch, st); },
      text(x, y, s, st) {
        if (!s) return;
        for (let i = 0; i < s.length; i++) {
          const cx = x + i;
          if (cx < 0) continue; if (cx >= w) break; if (y < 0 || y >= h) break;
          ctx.put(ox + cx, oy + y, s[i], st);
        }
      },
      rect(x, y, rw, rh, st) {
        for (let dy = 0; dy < rh; dy++) for (let dx = 0; dx < rw; dx++)
          if (clip(x + dx, y + dy)) ctx.put(ox + x + dx, oy + y + dy, (st && st.ch) || ' ', st);
      },
      box(x, y, bw, bh, st) {
        const g = ctx.theme.peek().glyphs[(st && st.glyphSet) || 'border'];
        this.text(x, y, g.tl + g.h.repeat(Math.max(0, bw - 2)) + g.tr, st);
        this.text(x, y + bh - 1, g.bl + g.h.repeat(Math.max(0, bw - 2)) + g.br, st);
        for (let i = 1; i < bh - 1; i++) { this.put(x, y + i, g.v, st); this.put(x + bw - 1, y + i, g.v, st); }
      },
    };
  }

  // Draw a pre-tokenized line as colored spans, clipped to maxW columns.
  function drawSpans(ctx, x, y, spans, maxW, colors, bg) {
    let col = 0;
    for (const sp of spans) {
      if (col >= maxW) break;
      let t = sp.text;
      if (col + t.length > maxW) t = t.slice(0, maxW - col);
      if (t.length) ctx.text(x + col, y, t, { fg: roleColor(sp.role, colors), bg });
      col += sp.text.length;
    }
  }

  // A short transient notice shown in the status bar (e.g. "draft restored").
  let notice = '';
  let noticeTimer = null;
  function setNotice(msg) {
    notice = msg;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; noticeTimer = null; }, 2200);
  }

  // ── Drafts ─────────────────────────────────────────────────────────
  let draftTimer = null;
  function scheduleDraftSave() {
    if (!editorPath || editorBinarySize >= 0) return;
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      if (editorPath && editorBinarySize < 0) {
        drafts.save(editorPath, currentBufferText());
      }
    }, 350);
  }
  function flushDraftNow() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    if (editorPath && editorBinarySize < 0 && editorDirty) {
      drafts.save(editorPath, currentBufferText());
    }
  }
  function currentBufferText() {
    if (vim) return vim.getText();
    return editorLines.join('\n');
  }

  // ── Vim ────────────────────────────────────────────────────────────
  // `vim` is non-null only while the vim engine is active for the current
  // buffer. We (re)build it when the pref is on and a text file is loaded.
  let vim = null;
  function vimEnabled() { return !!user.prefs.vimEnabled.peek(); }

  function buildVim() {
    vim = createVim(editorLines.join('\n'));
    vim.onCommand = (cmd) => {
      // Recognized: w, q, wq, x, q!, w!
      const c = cmd.trim();
      if (c === 'w' || c === 'w!' || c === 'wq' || c === 'x' || c === 'wq!' || c === 'x!') {
        syncFromVim();
        saveEditor();
      }
      if (c === 'q' || c === 'q!' || c === 'wq' || c === 'x' || c === 'wq!' || c === 'x!') {
        // Close the window if the host gave us one.
        try { if (win && typeof win.close === 'function') win.close(); } catch {}
      }
      vim.clearPendingCommand();
    };
  }
  function teardownVim() {
    if (vim) syncFromVim();
    vim = null;
  }
  // Pull vim's buffer back into our editorLines (keeps save/draft paths uniform).
  function syncFromVim() {
    if (!vim) return;
    editorLines = vim.getText().split('\n');
    if (editorLines.length === 0) editorLines = [''];
    editorRow = Math.min(vim.cursor.y, editorLines.length - 1);
    editorCol = vim.cursor.x;
    clampCaret();
  }
  // Reconcile vim engine presence with the current pref + editor state.
  function reconcileVim() {
    const want = vimEnabled() && editorPath && editorBinarySize < 0 && !editorLoadError;
    if (want && !vim) {
      buildVim();
    } else if (!want && vim) {
      teardownVim();
    }
  }
  function toggleVim() {
    const next = !vimEnabled();
    user.prefs.vimEnabled.value = next;
    if (next) {
      reconcileVim();
      setNotice('vim ON — :w save · :q close · F9 off');
    } else {
      teardownVim();
      setNotice('vim OFF');
    }
  }

  // Re-render on user pref changes (e.g. vim toggled from Settings elsewhere).
  const unsubUser = user.subscribe(() => { reconcileVim(); });

  // ── Focus + UI ─────────────────────────────────────────────────────
  let focus = 'tree';
  let lastSavedAt = 0;
  const savedFlash = signal(false);
  let flashTimer = null;
  let showAbout = false;

  let visibleRows = [];

  let blinkOn = true;
  const blinkInterval = setInterval(() => { blinkOn = !blinkOn; }, 500);

  const unsubFS = fs.subscribe('/', () => {
    rebuildVisibleRows();
    if (editorPath && !editorDirty) {
      if (!fs.exists(editorPath)) {
        editorPath = null;
        editorLines = [''];
        editorBinarySize = -1;
        teardownVim();
      } else {
        loadFileIntoEditor(editorPath, /*silent*/ true);
      }
    }
  });

  // ── Tree building ──────────────────────────────────────────────────
  function rebuildVisibleRows() {
    const out = [];
    function walk(dirPath, depth) {
      let kids;
      try { kids = fs.list(dirPath); } catch { kids = []; }
      if (!Array.isArray(kids)) return;
      for (const k of kids) {
        const childPath = joinPath(dirPath, k.name);
        out.push({ path: childPath, name: k.name, type: k.type, depth });
        if (k.type === 'dir' && expanded.has(childPath)) {
          walk(childPath, depth + 1);
        }
      }
    }
    walk('/', 0);
    out.push({ path: '__mount__', name: '+ mount local…', type: 'action', depth: 0, isMountAction: true });
    visibleRows = out;
  }
  rebuildVisibleRows();

  // ── File loading (with draft restore) ──────────────────────────────
  function loadFileIntoEditor(path, silent = false) {
    editorLoadError = null;
    teardownVim();
    if (!fs.exists(path)) {
      editorPath = path;
      editorLines = [''];
      editorBinarySize = -1;
      editorLoadError = 'File not found';
      return;
    }
    const st = fs.stat(path);
    if (!st || st.type !== 'file') {
      editorPath = null;
      return;
    }
    if (!isTextPath(path)) {
      editorPath = path;
      editorBinarySize = st.size;
      editorLines = [''];
      if (!silent) { editorRow = 0; editorCol = 0; editorScrollY = 0; }
      editorDirty = false;
      return;
    }
    let text = '';
    try {
      const r = fs.readText(path);
      text = typeof r === 'string' ? r : '';
    } catch (e) {
      editorLoadError = String(e && e.message || e);
    }

    // Draft restore: if a draft exists and differs from disk, restore it and
    // mark dirty so the user can save it for real.
    let restored = false;
    if (!silent && drafts.has(path)) {
      const d = drafts.load(path);
      if (typeof d === 'string' && d !== text) {
        text = d;
        restored = true;
      } else if (typeof d === 'string' && d === text) {
        // Draft matches disk — nothing pending; clean it up.
        drafts.clear(path);
      }
    }

    editorPath = path;
    editorBinarySize = -1;
    editorLines = text.length === 0 ? [''] : text.split('\n');
    if (!silent) { editorRow = 0; editorCol = 0; editorScrollY = 0; }
    editorDirty = restored;
    clampCaret();
    if (restored) setNotice('draft restored — Ctrl+S to keep');
    reconcileVim();
  }

  function saveEditor() {
    if (vim) syncFromVim();
    if (!editorPath || editorBinarySize >= 0) return;
    try {
      fs.write(editorPath, editorLines.join('\n'));
      editorDirty = false;
      lastSavedAt = Date.now();
      drafts.clear(editorPath); // a real save supersedes the draft
      if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
      savedFlash.value = true;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { savedFlash.value = false; flashTimer = null; }, SAVE_FLASH_MS);
    } catch (e) {
      editorLoadError = String(e && e.message || e);
    }
  }

  // ── Caret helpers ──────────────────────────────────────────────────
  function clampCaret() {
    if (editorRow < 0) editorRow = 0;
    if (editorRow >= editorLines.length) editorRow = editorLines.length - 1;
    const len = editorLines[editorRow].length;
    if (editorCol < 0) editorCol = 0;
    if (editorCol > len) editorCol = len;
  }

  // ── Classic edit ops (used when vim is OFF) ────────────────────────
  function insertChar(ch) {
    if (editorBinarySize >= 0 || !editorPath) return;
    const line = editorLines[editorRow];
    editorLines[editorRow] = line.slice(0, editorCol) + ch + line.slice(editorCol);
    editorCol += ch.length;
    editorDirty = true;
    scheduleDraftSave();
  }
  function insertNewline() {
    if (editorBinarySize >= 0 || !editorPath) return;
    const line = editorLines[editorRow];
    editorLines[editorRow] = line.slice(0, editorCol);
    editorLines.splice(editorRow + 1, 0, line.slice(editorCol));
    editorRow++;
    editorCol = 0;
    editorDirty = true;
    scheduleDraftSave();
  }
  function backspace() {
    if (editorBinarySize >= 0 || !editorPath) return;
    if (editorCol > 0) {
      const line = editorLines[editorRow];
      editorLines[editorRow] = line.slice(0, editorCol - 1) + line.slice(editorCol);
      editorCol--;
      editorDirty = true;
      scheduleDraftSave();
    } else if (editorRow > 0) {
      const prev = editorLines[editorRow - 1];
      editorCol = prev.length;
      editorLines[editorRow - 1] = prev + editorLines[editorRow];
      editorLines.splice(editorRow, 1);
      editorRow--;
      editorDirty = true;
      scheduleDraftSave();
    }
  }

  // ── Tree navigation ────────────────────────────────────────────────
  function indexOfSelected() {
    for (let i = 0; i < visibleRows.length; i++) {
      if (visibleRows[i].path === selectedPath) return i;
    }
    return -1;
  }
  function selectByIndex(i) {
    if (i < 0 || i >= visibleRows.length) return;
    selectedPath = visibleRows[i].path;
  }
  function moveSelection(delta) {
    const i = indexOfSelected();
    if (i < 0) { selectByIndex(0); return; }
    let next = i + delta;
    if (next < 0) next = 0;
    if (next >= visibleRows.length) next = visibleRows.length - 1;
    selectByIndex(next);
  }

  // ── Multi-selection helpers ────────────────────────────────────────
  function clearMulti() { selected.clear(); selAnchorIdx = -1; }
  function selectableAt(i) {
    const r = visibleRows[i];
    return r && !r.isMountAction ? r : null;
  }
  // Move the cursor; plain navigation drops any multi-selection, Shift extends.
  function moveCursor(delta, extend) {
    if (extend) { extendSelection(delta); return; }
    clearMulti();
    moveSelection(delta);
  }
  function toggleAt(i) {
    const r = selectableAt(i);
    if (!r) return;
    if (selected.has(r.path)) selected.delete(r.path);
    else selected.add(r.path);
    selectedPath = r.path;
    selAnchorIdx = i;
  }
  // Replace (or, if additive, augment) the selection with the anchor..to band.
  function rangeSelect(fromIdx, toIdx, additive) {
    if (!additive) selected.clear();
    const a = Math.min(fromIdx, toIdx), b = Math.max(fromIdx, toIdx);
    for (let i = a; i <= b; i++) {
      const r = selectableAt(i);
      if (r) selected.add(r.path);
    }
    const lead = selectableAt(toIdx);
    if (lead) selectedPath = lead.path;
  }
  function extendSelection(delta) {
    const cur = indexOfSelected();
    let anchor = selAnchorIdx;
    if (anchor < 0) { anchor = cur < 0 ? 0 : cur; }
    let next = (cur < 0 ? 0 : cur) + delta;
    if (next < 0) next = 0;
    if (next >= visibleRows.length) next = visibleRows.length - 1;
    rangeSelect(anchor, next, false);
    selAnchorIdx = anchor;
  }
  function selectAllFiles() {
    selected.clear();
    for (let i = 0; i < visibleRows.length; i++) {
      const r = selectableAt(i);
      if (r) selected.add(r.path);
    }
    selAnchorIdx = 0;
  }

  // Translate the current marquee rectangle into a live selection: every
  // visible tree row whose screen line falls inside the band is marked.
  function updateMarqueeSelection() {
    if (!drag) return;
    const paneH = (initialCtx.height ?? 24) - 1;
    const lo = Math.min(drag.startY, drag.curY);
    const hi = Math.max(drag.startY, drag.curY);
    const next = drag.additive ? new Set(drag.base) : new Set();
    for (let i = 0; i < visibleRows.length; i++) {
      const screenY = 1 + (i - treeScroll);          // row 0 → content line 1
      if (screenY < 1 || screenY >= paneH - 1) continue;
      if (screenY >= lo && screenY <= hi) {
        const r = visibleRows[i];
        if (r && !r.isMountAction) next.add(r.path);
      }
    }
    selected.clear();
    for (const p of next) selected.add(p);
    // The cursor follows the row under the pointer's current Y.
    const ci = treeScroll + (drag.curY - 1);
    const lead = selectableAt(ci);
    if (lead) selectedPath = lead.path;
  }
  function selectedRow() {
    const i = indexOfSelected();
    return i < 0 ? null : visibleRows[i];
  }
  function activateSelection() {
    const r = selectedRow();
    if (!r) return;
    if (r.isMountAction) { tryMountLocal(); return; }
    if (r.type === 'dir') {
      if (expanded.has(r.path)) expanded.delete(r.path);
      else expanded.add(r.path);
      rebuildVisibleRows();
    } else if (r.type === 'file') {
      loadFileIntoEditor(r.path);
      focus = 'editor';
    }
  }
  function expandOrFocusEditor() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'dir' && !expanded.has(r.path)) {
      expanded.add(r.path);
      rebuildVisibleRows();
    } else if (r.type === 'file') {
      if (editorPath !== r.path) loadFileIntoEditor(r.path);
      focus = 'editor';
    }
  }
  function collapseOrParent() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'dir' && expanded.has(r.path)) {
      expanded.delete(r.path);
      rebuildVisibleRows();
      return;
    }
    const par = parentOf(r.path);
    if (par && par !== '/') {
      const idx = visibleRows.findIndex(v => v.path === par);
      if (idx >= 0) selectByIndex(idx);
    }
  }
  async function tryMountLocal() {
    if (!fs.canMountLocal || !fs.canMountLocal()) {
      editorLoadError = 'File System Access API unavailable in this browser.';
      return;
    }
    try {
      const at = '/mnt/local-' + Date.now().toString(36);
      await fs.mountLocal({ at });
      expanded.add(parentOf(at));
      expanded.add(at);
      rebuildVisibleRows();
    } catch (e) {
      editorLoadError = 'mount cancelled: ' + (e && e.message || e);
    }
  }

  function deleteSelected() {
    // Operate on the multi-selection when present, otherwise the cursor row.
    let targets;
    if (selected.size > 0) {
      targets = [...selected];
    } else {
      const r = selectedRow();
      if (!r || r.isMountAction) return;
      targets = [r.path];
    }
    targets = targets.filter(p => p && p !== '/' && fs.exists(p));
    if (targets.length === 0) return;
    const msg = targets.length === 1
      ? 'Delete ' + targets[0] + ' ?'
      : 'Delete ' + targets.length + ' items?';
    if (!window.confirm(msg)) return;
    // Deepest paths first so deleting a child never trips over a removed parent.
    targets.sort((a, b) => b.length - a.length);
    for (const p of targets) {
      try {
        fs.delete(p);
        if (editorPath === p) {
          editorPath = null;
          editorLines = [''];
          editorBinarySize = -1;
          editorDirty = false;
          teardownVim();
        }
        try { drafts.clear(p); } catch {}
      } catch (e) {
        editorLoadError = String(e && e.message || e);
      }
    }
    clearMulti();
    rebuildVisibleRows();
  }

  function parentDirOfSelection() {
    const r = selectedRow();
    if (!r || r.isMountAction) return '/';
    if (r.type === 'dir') return r.path;
    const i = r.path.lastIndexOf('/');
    return i <= 0 ? '/' : r.path.slice(0, i);
  }

  function uniquePath(dir, base, ext) {
    const sep = dir === '/' ? '' : '/';
    let n = 1;
    let p = `${dir}${sep}${base}${ext}`;
    while (fs.exists(p)) {
      n++;
      p = `${dir}${sep}${base}-${n}${ext}`;
    }
    return p;
  }

  function newFile() {
    const dir = parentDirOfSelection();
    const initial = uniquePath(dir, 'untitled', '.txt');
    const name = window.prompt('New file — path:', initial);
    if (!name) return;
    try {
      fs.write(name, '');
      rebuildVisibleRows();
      selectedPath = name;
      loadFileIntoEditor(name);
      focus = 'editor';
    } catch (e) { editorLoadError = String(e && e.message || e); }
  }

  function newFolder() {
    const dir = parentDirOfSelection();
    const initial = uniquePath(dir, 'folder', '');
    const name = window.prompt('New folder — path:', initial);
    if (!name) return;
    try {
      fs.mkdir(name);
      expanded.add(name);
      rebuildVisibleRows();
      selectedPath = name;
    } catch (e) { editorLoadError = String(e && e.message || e); }
  }

  function renameSelected() {
    const r = selectedRow();
    if (!r || r.isMountAction) return;
    const next = window.prompt('Rename to:', r.path);
    if (!next || next === r.path) return;
    try {
      fs.move(r.path, next);
      if (editorPath === r.path) editorPath = next;
      selectedPath = next;
      rebuildVisibleRows();
    } catch (e) { editorLoadError = String(e && e.message || e); }
  }

  // ── Rendering ──────────────────────────────────────────────────────
  function leftPaneWidth(W) {
    return Math.max(18, Math.min(34, Math.floor(W / 3)));
  }

  function renderTree(ctx, x0, y0, w, h) {
    const C = ctx.theme.peek().colors;
    const treeFocused = focus === 'tree';
    const borderColor = treeFocused ? C.borderFocus : C.border;

    ctx.box(x0, y0, w, h, { fg: borderColor });
    const title = ' files ';
    ctx.text(x0 + 2, y0, title, { fg: borderColor, bg: C.bg });

    const innerH = h - 2;
    const innerW = w - 2;
    if (innerH <= 0 || innerW <= 0) return;

    const selIdx = indexOfSelected();
    if (selIdx >= 0) {
      if (selIdx < treeScroll) treeScroll = selIdx;
      else if (selIdx >= treeScroll + innerH) treeScroll = selIdx - innerH + 1;
    }
    if (treeScroll < 0) treeScroll = 0;
    if (treeScroll > Math.max(0, visibleRows.length - innerH)) {
      treeScroll = Math.max(0, visibleRows.length - innerH);
    }

    for (let i = 0; i < innerH; i++) {
      const ri = treeScroll + i;
      if (ri >= visibleRows.length) break;
      const row = visibleRows[ri];
      const isCursor = row.path === selectedPath;
      const isMulti = selected.has(row.path);

      let glyph;
      if (row.isMountAction) glyph = ' ';
      else if (row.type === 'dir') glyph = expanded.has(row.path) ? '▾' : '▸';
      else glyph = '·';

      const indent = '  '.repeat(row.depth);
      const text = `${indent}${glyph} ${row.name}`;
      // Cursor wins the strongest paint; extra marquee/multi rows get a softer
      // theme-tinted band so a whole selection reads at a glance.
      let fg, bg;
      if (isCursor && treeFocused) { bg = C.accent; fg = C.bg; }
      else if (isCursor) { bg = C.border; fg = C.fg; }
      else if (isMulti) { bg = C.border; fg = treeFocused ? C.accent : C.fg; }
      else {
        bg = C.bg;
        fg = row.isMountAction ? C.accent : (row.type === 'dir' ? C.fg : C.fgDim);
      }
      const bold = (isCursor && treeFocused) || isMulti;

      ctx.rect(x0 + 1, y0 + 1 + i, innerW, 1, { ch: ' ', bg, fg });
      const visible = text.slice(0, innerW);
      ctx.text(x0 + 1, y0 + 1 + i, visible, { fg, bg, bold });

      if (isCursor && treeFocused) {
        ctx.put(x0 + w - 2, y0 + 1 + i, '◄', { fg, bg });
      } else if (isMulti) {
        ctx.put(x0 + w - 2, y0 + 1 + i, '•', { fg: C.accent, bg });
      }
    }

    // Marquee outline drawn on top of the rows it spans (theme-accent box).
    if (drag && drag.moved) {
      const clampX = (v) => Math.max(x0 + 1, Math.min(v, x0 + w - 2));
      const clampY = (v) => Math.max(y0 + 1, Math.min(v, y0 + h - 2));
      const mx1 = clampX(Math.min(drag.startX, drag.curX));
      const mx2 = clampX(Math.max(drag.startX, drag.curX));
      const my1 = clampY(Math.min(drag.startY, drag.curY));
      const my2 = clampY(Math.max(drag.startY, drag.curY));
      ctx.box(mx1, my1, mx2 - mx1 + 1, my2 - my1 + 1, {
        fg: C.borderFocus, glyphSet: 'borderRound',
      });
    }
  }

  function renderEditor(ctx, x0, y0, w, h) {
    const C = ctx.theme.peek().colors;
    const edFocused = focus === 'editor';
    const borderColor = edFocused ? C.borderFocus : C.border;
    ctx.box(x0, y0, w, h, { fg: borderColor });

    let title;
    if (editorPath) {
      const dot = editorDirty ? '● ' : '';
      title = ' ' + dot + editorPath + ' ';
    } else {
      title = ' (no file) ';
    }
    const maxTitle = Math.max(0, w - 4);
    ctx.text(x0 + 2, y0, title.slice(0, maxTitle), {
      fg: editorDirty ? C.warning : borderColor,
      bg: C.bg,
      bold: editorDirty,
    });

    // Vim-mode badge on the right side of the editor title bar.
    if (vim) {
      const badge = ' VIM ';
      const bx = x0 + w - badge.length - 1;
      if (bx > x0 + 2) ctx.text(bx, y0, badge, { fg: C.bg, bg: C.accent, bold: true });
    }

    const innerX = x0 + 1;
    const innerY = y0 + 1;
    const innerW = w - 2;
    const innerH = h - 2;
    if (innerH <= 0 || innerW <= 0) return;

    ctx.rect(innerX, innerY, innerW, innerH, { ch: ' ', bg: C.bg, fg: C.fg });

    if (editorLoadError) {
      ctx.text(innerX, innerY, ('error: ' + editorLoadError).slice(0, innerW), {
        fg: C.error, bg: C.bg,
      });
      return;
    }
    if (!editorPath) {
      // Feynman empty state.
      const hint = 'select a file in the tree (Enter / →)';
      ctx.text(innerX, innerY, hint.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      if (innerH >= 4) {
        const q = '“' + sessionQuote + '”';
        wrapText(ctx, q, innerX, innerY + 2, innerW, innerH - 3, C.link, C.bg);
        const sig = '— ' + FULL_NAME;
        ctx.text(innerX, innerY + innerH - 1, sig.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      }
      return;
    }
    if (editorBinarySize >= 0) {
      const msg = `binary, ${editorBinarySize} bytes`;
      ctx.text(innerX, innerY, msg.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      return;
    }

    // Source of truth for what we draw: vim buffer if active, else editorLines.
    const lines = vim ? vim.lines : editorLines;
    const curRow = vim ? vim.cursor.y : editorRow;
    const curCol = vim ? vim.cursor.x : editorCol;

    // Syntax highlighting by file extension (cached; re-tokenized on change).
    const lang = langForPath(editorPath);

    // Markdown in classic mode → styled, web-like preview (read-only, scrolls).
    // Switch to vim (F9) to edit the raw source with markdown highlighting.
    if (lang === 'md' && !vim) {
      const view = ensureMdView(lines.join('\n'));
      view.render(offsetCtx(ctx, innerX, innerY, innerW, innerH));
      return;
    }

    const hlRows = lang ? highlightRows(lines.join('\n'), lang) : null;

    if (curRow < editorScrollY) editorScrollY = curRow;
    else if (curRow >= editorScrollY + innerH) editorScrollY = curRow - innerH + 1;
    if (editorScrollY < 0) editorScrollY = 0;

    const maxLineWidth = Math.max(1, innerW - 1);
    const sel = vim ? vim.selection : null;
    for (let i = 0; i < innerH; i++) {
      const li = editorScrollY + i;
      if (li >= lines.length) break;
      const line = lines[li];
      let visible = line;
      let truncated = false;
      if (line.length > maxLineWidth) {
        visible = line.slice(0, maxLineWidth);
        truncated = true;
      }
      if (visible.length > 0) {
        if (hlRows && hlRows[li]) {
          drawSpans(ctx, innerX, innerY + i, hlRows[li], maxLineWidth, C, C.bg);
        } else {
          ctx.text(innerX, innerY + i, visible, { fg: C.fg, bg: C.bg });
        }
      }
      // Visual-mode selection highlight.
      if (sel) {
        const [s, eSel] = sel;
        if (li >= s.y && li <= eSel.y) {
          const from = li === s.y ? s.x : 0;
          const to = li === eSel.y ? eSel.x : line.length - 1;
          for (let cx = from; cx <= to && cx < maxLineWidth; cx++) {
            const ch = line[cx] || ' ';
            ctx.put(innerX + cx, innerY + i, ch, { fg: C.bg, bg: C.link });
          }
        }
      }
      if (truncated) {
        ctx.put(innerX + innerW - 1, innerY + i, '›', { fg: C.warning, bg: C.bg });
      }
    }

    // Caret.
    const insertMode = vim ? (vim.mode === 'insert') : true;
    if (edFocused) {
      const caretY = curRow - editorScrollY;
      if (caretY >= 0 && caretY < innerH) {
        const caretX = Math.min(curCol, maxLineWidth - 1);
        if (caretX >= 0) {
          const lineAtCaret = lines[curRow] || '';
          const underCh = lineAtCaret[curCol] || ' ';
          // Block caret in normal/visual, blinking thin caret in insert/classic.
          if (vim && !insertMode) {
            ctx.put(innerX + caretX, innerY + caretY, underCh, { fg: C.bg, bg: C.fg });
          } else if (blinkOn) {
            ctx.put(innerX + caretX, innerY + caretY, underCh, { fg: C.bg, bg: C.accent });
          } else {
            ctx.put(innerX + caretX, innerY + caretY, underCh, { fg: C.fg, bg: C.bg });
          }
        }
      }
    }
  }

  function renderStatus(ctx, y) {
    const C = ctx.theme.peek().colors;
    const W = ctx.width;
    ctx.rect(0, y, W, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });

    // Left: vim mode line takes priority when present, else path info.
    let left;
    let leftFg = C.fgDim;
    const vimStatus = vim ? vim.status() : '';
    if (vimStatus) {
      left = vimStatus;
      leftFg = C.accent;
    } else if (notice) {
      left = notice;
      leftFg = C.success;
    } else if (focus === 'tree' && selected.size > 1) {
      left = selected.size + ' selected · ⌫ delete · Esc clear';
      leftFg = C.accent;
    } else if (editorPath) {
      const st = fs.exists(editorPath) ? fs.stat(editorPath) : null;
      const size = st && st.type === 'file' ? st.size : 0;
      const dirtyTag = editorDirty ? ' [modified]' : '';
      const draftTag = drafts.has(editorPath) ? ' ✎draft' : '';
      left = `${editorPath} · ${size}B${dirtyTag}${draftTag}`;
    } else {
      const r = selectedRow();
      left = r ? r.path : '/';
    }
    ctx.text(0, y, left.slice(0, W), { fg: leftFg, bg: C.bg });

    const flashing = savedFlash.value;
    let right;
    if (flashing) {
      right = 'Saved';
    } else if (focus === 'tree') {
      right = 'drag/⇧↑↓ select · ⌘A all · N new · R rename · ⌫ del · ↵ open · ⇥ editor';
    } else if (vim) {
      right = ':w save · :q close · F9 vim off';
    } else {
      right = 'Ctrl+S save · F9 vim · ⇥ tree';
    }
    const rx = W - right.length;
    if (rx > left.length + 2) {
      ctx.text(rx, y, right, { fg: flashing ? C.accent : C.fgDim, bg: C.bg });
    }
  }

  // ── About box ──────────────────────────────────────────────────────
  function renderAbout(ctx) {
    const C = ctx.theme.peek().colors;
    const W = ctx.width, H = ctx.height;
    const bw = Math.min(W - 4, 52);
    const bh = Math.min(H - 2, 13);
    const bx = Math.floor((W - bw) / 2);
    const by = Math.floor((H - bh) / 2);

    ctx.rect(bx, by, bw, bh, { ch: ' ', bg: C.bg, fg: C.fg });
    ctx.box(bx, by, bw, bh, { fg: C.borderFocus, glyphSet: 'borderDouble' });
    ctx.text(bx + 2, by, ' About Findman Dick ', { fg: C.accent, bg: C.bg, bold: true });

    const cx = bx + 2;
    let yy = by + 2;
    const line = (s, fg, bold) => {
      ctx.text(cx, yy, String(s).slice(0, bw - 4), { fg: fg || C.fg, bg: C.bg, bold: !!bold });
      yy++;
    };
    line(APP_ICON + '  Findman Dick', C.accent, true);
    line(FULL_NAME, C.fg, false);
    yy++;
    line('A Feynman-flavored file finder + editor.', C.fgDim, false);
    yy++;
    wrapText(ctx, '“' + sessionQuote + '”', cx, yy, bw - 4, bh - (yy - by) - 2, C.link, C.bg);
    ctx.text(cx, by + bh - 2, 'Esc / Enter to close', { fg: C.fgDim, bg: C.bg });
  }

  // Word-wrap helper: draws `text` into a box, returns rows used.
  function wrapText(ctx, text, x, y, w, maxRows, fg, bg) {
    if (w <= 0 || maxRows <= 0) return 0;
    const words = String(text).split(/\s+/);
    let row = 0, cur = '';
    const flush = () => {
      if (row >= maxRows) return;
      ctx.text(x, y + row, cur.slice(0, w), { fg, bg });
      row++;
      cur = '';
    };
    for (const word of words) {
      if (cur.length === 0) { cur = word; continue; }
      if (cur.length + 1 + word.length <= w) cur += ' ' + word;
      else { flush(); cur = word; if (row >= maxRows) break; }
    }
    if (cur.length > 0 && row < maxRows) flush();
    return row;
  }

  // ── openFile handoff ───────────────────────────────────────────────
  function consumeOpenFileHint() {
    const p = globalThis.__aciiOpenFile;
    if (!p || !p.startsWith('/')) return;
    if (!fs.exists(p)) return;
    globalThis.__aciiOpenFile = null;
    let dir = p.slice(0, p.lastIndexOf('/')) || '/';
    while (dir && dir !== '/') {
      expanded.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
    }
    rebuildVisibleRows();
    selectedPath = p;
    loadFileIntoEditor(p);
    focus = 'editor';
  }

  // ── App interface ──────────────────────────────────────────────────
  return {
    render(ctx) {
      consumeOpenFileHint();
      const C = ctx.theme.peek().colors;
      const W = ctx.width;
      const H = ctx.height;
      if (W <= 4 || H <= 4) return;

      ctx.rect(0, 0, W, H, { ch: ' ', bg: C.bg, fg: C.fg });

      const lw = leftPaneWidth(W);
      const statusH = 1;
      const paneH = H - statusH;

      renderTree(ctx, 0, 0, lw, paneH);
      renderEditor(ctx, lw - 1, 0, W - (lw - 1), paneH);
      renderStatus(ctx, H - 1);

      if (showAbout) renderAbout(ctx);
    },

    onKey(e) {
      if (e.type !== 'down') return;
      const k = e.key;

      // About box modal swallows keys.
      if (showAbout) {
        if (k === 'Escape' || k === 'Enter') showAbout = false;
        return;
      }

      // Global: about (F1), toggle vim (F9). F9 chosen to avoid clobbering
      // editor letter keys / vim normal-mode bindings.
      if (k === 'F1') { showAbout = true; return; }
      if (k === 'F9') { toggleVim(); return; }

      // Global save (works regardless of vim).
      if ((e.ctrl || e.meta) && (e.code === 'KeyS' || k === 's' || k === 'S')) {
        saveEditor();
        return;
      }

      if (k === 'Tab' && (!vim || vim.mode === 'normal')) {
        focus = focus === 'tree' ? 'editor' : 'tree';
        return;
      }

      if (focus === 'tree') {
        // Select-all (Cmd/Ctrl+A) and clear (Esc) for the multi-selection.
        if ((e.ctrl || e.meta) && (e.code === 'KeyA' || k === 'a' || k === 'A')) {
          selectAllFiles(); return;
        }
        if (k === 'Escape' && selected.size > 0) { clearMulti(); return; }
        // Spacebar toggles the cursor row's membership in the selection.
        if (k === ' ' || e.code === 'Space') {
          const i = indexOfSelected();
          if (i >= 0) toggleAt(i);
          return;
        }
        if (k === 'ArrowUp') { moveCursor(-1, e.shift); return; }
        if (k === 'ArrowDown') { moveCursor(1, e.shift); return; }
        if (k === 'PageUp') { moveCursor(-8, e.shift); return; }
        if (k === 'PageDown') { moveCursor(8, e.shift); return; }
        if (k === 'Home') { clearMulti(); selectByIndex(0); return; }
        if (k === 'End') { clearMulti(); selectByIndex(visibleRows.length - 1); return; }
        if (k === 'ArrowRight') { clearMulti(); expandOrFocusEditor(); return; }
        if (k === 'ArrowLeft') { clearMulti(); collapseOrParent(); return; }
        if (k === 'Enter') { activateSelection(); return; }
        if (k === 'Delete' || k === 'Backspace') { deleteSelected(); return; }
        if (e.code === 'KeyN' || k === 'n' || k === 'N') {
          if (e.shift) newFolder(); else newFile();
          return;
        }
        if (k === 'F2' || e.code === 'KeyR' || k === 'r' || k === 'R') { renameSelected(); return; }
        return;
      }

      // ── Editor focus ──
      // Markdown preview (classic .md): keys scroll the styled view; switch to
      // vim (F9, handled above) to edit the raw source.
      if (mdPreviewActive()) {
        if (mdView && mdView.onKey) mdView.onKey(e);
        return;
      }
      if (vim) {
        // Route everything through the vim engine. It returns true when it
        // consumed the key. We mark dirty + schedule a draft when the buffer
        // text changed.
        const before = vim.getText();
        const consumed = vim.feed(e);
        const after = vim.getText();
        if (after !== before) {
          editorDirty = true;
          // keep editorLines roughly in sync for status size + drafts
          editorLines = after.split('\n');
          scheduleDraftSave();
        }
        // Esc in normal mode with nothing else: allow leaving to tree via Tab only.
        return;
      }

      // Classic editor (vim OFF).
      if (k === 'ArrowLeft') {
        if (editorCol > 0) editorCol--;
        else if (editorRow > 0) { editorRow--; editorCol = editorLines[editorRow].length; }
        return;
      }
      if (k === 'ArrowRight') {
        if (editorCol < editorLines[editorRow].length) editorCol++;
        else if (editorRow < editorLines.length - 1) { editorRow++; editorCol = 0; }
        return;
      }
      if (k === 'ArrowUp') {
        if (editorRow > 0) { editorRow--; clampCaret(); }
        else { focus = 'tree'; }
        return;
      }
      if (k === 'ArrowDown') {
        if (editorRow < editorLines.length - 1) { editorRow++; clampCaret(); }
        return;
      }
      if (k === 'Home') { editorCol = 0; return; }
      if (k === 'End') { editorCol = editorLines[editorRow].length; return; }
      if (k === 'PageUp') {
        editorRow = Math.max(0, editorRow - Math.max(1, (initialCtx?.height ?? 10) - 4));
        clampCaret();
        return;
      }
      if (k === 'PageDown') {
        editorRow = Math.min(editorLines.length - 1, editorRow + Math.max(1, (initialCtx?.height ?? 10) - 4));
        clampCaret();
        return;
      }
      if (k === 'Enter') { insertNewline(); return; }
      if (k === 'Backspace') { backspace(); return; }
      if (k === 'Tab') { insertChar('  '); return; }
      if (!e.ctrl && !e.meta && typeof k === 'string' && k.length === 1) {
        insertChar(k);
      }
    },

    onMouse(e) {
      if (showAbout) {
        if (e.type === 'click' || e.type === 'mousedown') showAbout = false;
        return;
      }
      // Wheel over the markdown preview scrolls the styled view.
      if (e.type === 'wheel') {
        if (mdPreviewActive() && mdView) {
          if (mdView.onMouse) mdView.onMouse(e);
          else if (mdView.scroll) mdView.scroll(e.lines || 0);
        }
        return;
      }
      const W = initialCtx.width;
      const H = initialCtx.height;
      const lw = leftPaneWidth(W);
      const paneH = H - 1;
      const inTree = (x, y) => x >= 0 && x < lw && y >= 1 && y < paneH - 1;
      const mod = (ev) => !!(ev.raw && (ev.raw.metaKey || ev.raw.ctrlKey));
      const shiftDown = (ev) => !!(ev.raw && ev.raw.shiftKey);

      // ── Marquee / modifier selection in the tree pane ──────────────
      if (e.type === 'mousedown' && (e.button === 0 || e.button == null) && inTree(e.x, e.y)) {
        focus = 'tree';
        const rowIdx = treeScroll + (e.y - 1);
        if (shiftDown(e) && selAnchorIdx >= 0 && rowIdx < visibleRows.length) {
          rangeSelect(selAnchorIdx, rowIdx, mod(e));
          suppressClick = true;
          return;
        }
        if (mod(e) && rowIdx < visibleRows.length) {
          toggleAt(rowIdx);
          suppressClick = true;
          return;
        }
        // Otherwise begin a candidate drag; a real move turns it into a marquee,
        // a release without movement falls through to the plain click below.
        drag = { startX: e.x, startY: e.y, curX: e.x, curY: e.y, moved: false, additive: false, base: new Set(selected) };
        return;
      }
      if (e.type === 'mousemove' && drag) {
        drag.curX = e.x; drag.curY = e.y;
        if (Math.abs(e.x - drag.startX) + Math.abs(e.y - drag.startY) >= 1) drag.moved = true;
        if (drag.moved) updateMarqueeSelection();
        return;
      }
      if (e.type === 'mouseup') {
        if (drag) {
          if (drag.moved) { updateMarqueeSelection(); suppressClick = true; selAnchorIdx = indexOfSelected(); }
          drag = null;
        }
        return;
      }

      if (e.type !== 'click' && e.type !== 'dblclick') return;
      // The click that trails a drag / modifier-select must not activate.
      if (suppressClick) { suppressClick = false; return; }

      if (inTree(e.x, e.y)) {
        focus = 'tree';
        const rowIdx = treeScroll + (e.y - 1);
        if (rowIdx >= 0 && rowIdx < visibleRows.length) {
          clearMulti();
          selectByIndex(rowIdx);
          selAnchorIdx = rowIdx;
          if (e.type === 'dblclick' || e.type === 'click') {
            activateSelection();
          }
        }
        return;
      }

      if (e.x >= lw - 1 && e.x < W && e.y >= 1 && e.y < paneH - 1) {
        focus = 'editor';
        if (!editorPath || editorBinarySize >= 0) return;
        const innerX = lw;
        const innerY = 1;
        const innerH = paneH - 2;
        const localY = e.y - innerY;
        if (localY < 0 || localY >= innerH) return;
        const lines = vim ? vim.lines : editorLines;
        const targetRow = editorScrollY + localY;
        if (targetRow >= lines.length) {
          const lastRow = lines.length - 1;
          const lastCol = lines[lastRow].length;
          if (vim) { vim.cursor.y = lastRow; vim.cursor.x = lastCol; }
          else { editorRow = lastRow; editorCol = lastCol; }
          return;
        }
        const col = Math.max(0, Math.min(e.x - innerX, lines[targetRow].length));
        if (vim) { vim.cursor.y = targetRow; vim.cursor.x = col; }
        else { editorRow = targetRow; editorCol = col; }
      }
    },

    onTouch(e) {
      if (e.type === 'longpress') {
        // Long-press a tree row to toggle it in the multi-selection.
        const W = initialCtx.width, H = initialCtx.height;
        const lw = leftPaneWidth(W), paneH = H - 1;
        if (e.x >= 0 && e.x < lw && e.y >= 1 && e.y < paneH - 1) {
          focus = 'tree';
          const rowIdx = treeScroll + (e.y - 1);
          if (rowIdx >= 0 && rowIdx < visibleRows.length) toggleAt(rowIdx);
        }
        return;
      }
      if (e.type === 'tap') {
        this.onMouse({ type: 'click', x: e.x, y: e.y });
      } else if (e.type === 'doubletap') {
        this.onMouse({ type: 'dblclick', x: e.x, y: e.y });
      } else if (e.type === 'move' && e.sy) {
        // Drag tracks the finger 1:1 (content follows finger). Route to whatever
        // surface is active: tree selection, markdown preview, or the editor.
        const step = e.sy; // cells moved this frame (down > 0)
        if (focus === 'tree') {
          moveSelection(-step);
        } else if (mdPreviewActive() && mdView) {
          if (mdView.scroll) mdView.scroll(-step);
        } else {
          const lines = vim ? vim.lines : editorLines;
          const ny = Math.max(0, Math.min(lines.length - 1, (vim ? vim.cursor.y : editorRow) - step));
          if (vim) { vim.cursor.y = ny; } else { editorRow = ny; clampCaret(); }
        }
      }
    },

    onContextMenu(e) {
      // Right-click anywhere opens the about box (lightweight menu surface).
      showAbout = true;
    },

    destroy() {
      // Persist any in-flight edits both to the real FS (as Finder did) and to
      // the draft store, so nothing is lost.
      if (vim) syncFromVim();
      if (editorDirty && editorPath && editorBinarySize < 0) {
        try { fs.write(editorPath, editorLines.join('\n')); } catch {}
        try { drafts.clear(editorPath); } catch {}
      }
      flushDraftNow();
      try { drafts.flush(); } catch {}
      if (draftTimer) clearTimeout(draftTimer);
      if (noticeTimer) clearTimeout(noticeTimer);
      if (flashTimer) clearTimeout(flashTimer);
      if (blinkInterval) clearInterval(blinkInterval);
      if (typeof unsubFS === 'function') unsubFS();
      if (typeof unsubUser === 'function') unsubUser();
    },
  };
}
