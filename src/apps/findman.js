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
  let selectedPath = '/docs/README.md';
  let treeScroll = 0;

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
    const r = selectedRow();
    if (!r || r.isMountAction) return;
    if (!window.confirm('Delete ' + r.path + ' ?')) return;
    try {
      fs.delete(r.path);
      if (editorPath === r.path) {
        editorPath = null;
        editorLines = [''];
        editorBinarySize = -1;
        editorDirty = false;
        drafts.clear(r.path);
        teardownVim();
      }
      rebuildVisibleRows();
    } catch (e) {
      editorLoadError = String(e && e.message || e);
    }
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
      const isSel = row.path === selectedPath;

      let glyph;
      if (row.isMountAction) glyph = ' ';
      else if (row.type === 'dir') glyph = expanded.has(row.path) ? '▾' : '▸';
      else glyph = '·';

      const indent = '  '.repeat(row.depth);
      const text = `${indent}${glyph} ${row.name}`;
      const fg = isSel
        ? (treeFocused ? C.bg : C.fg)
        : (row.isMountAction ? C.accent : (row.type === 'dir' ? C.fg : C.fgDim));
      const bg = isSel ? (treeFocused ? C.accent : C.border) : C.bg;

      ctx.rect(x0 + 1, y0 + 1 + i, innerW, 1, { ch: ' ', bg, fg });
      const visible = text.slice(0, innerW);
      ctx.text(x0 + 1, y0 + 1 + i, visible, { fg, bg, bold: isSel && treeFocused });

      if (isSel && treeFocused) {
        ctx.put(x0 + w - 2, y0 + 1 + i, '◄', { fg, bg });
      }
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
      right = 'N new · ⇧N folder · R rename · ⌫ del · ↵ open · ⇥ editor · F1 about';
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
        if (k === 'ArrowUp') { moveSelection(-1); return; }
        if (k === 'ArrowDown') { moveSelection(1); return; }
        if (k === 'PageUp') { moveSelection(-8); return; }
        if (k === 'PageDown') { moveSelection(8); return; }
        if (k === 'Home') { selectByIndex(0); return; }
        if (k === 'End') { selectByIndex(visibleRows.length - 1); return; }
        if (k === 'ArrowRight') { expandOrFocusEditor(); return; }
        if (k === 'ArrowLeft') { collapseOrParent(); return; }
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
      if (e.type !== 'click' && e.type !== 'mousedown' && e.type !== 'dblclick') return;
      const W = initialCtx.width;
      const H = initialCtx.height;
      const lw = leftPaneWidth(W);
      const paneH = H - 1;

      if (e.x >= 0 && e.x < lw && e.y >= 1 && e.y < paneH - 1) {
        focus = 'tree';
        const rowIdx = treeScroll + (e.y - 1);
        if (rowIdx >= 0 && rowIdx < visibleRows.length) {
          selectByIndex(rowIdx);
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
      if (e.type === 'tap') {
        this.onMouse({ type: 'click', x: e.x, y: e.y });
      } else if (e.type === 'doubletap') {
        this.onMouse({ type: 'dblclick', x: e.x, y: e.y });
      } else if (e.type === 'swipe') {
        if (focus === 'tree') {
          if (e.dir === 'up') moveSelection(3);
          else if (e.dir === 'down') moveSelection(-3);
        } else {
          const lines = vim ? vim.lines : editorLines;
          if (e.dir === 'up') {
            const ny = Math.min(lines.length - 1, (vim ? vim.cursor.y : editorRow) + 3);
            if (vim) { vim.cursor.y = ny; } else { editorRow = ny; clampCaret(); }
          } else if (e.dir === 'down') {
            const ny = Math.max(0, (vim ? vim.cursor.y : editorRow) - 3);
            if (vim) { vim.cursor.y = ny; } else { editorRow = ny; clampCaret(); }
          }
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
