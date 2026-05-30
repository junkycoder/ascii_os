// finder.js — file browser + text editor for acii_os.
// Left pane: collapsible tree of the virtual FS.
// Right pane: viewer / editor for the currently selected file.
//
// Coords passed to render(ctx) are LOCAL to the window content.
// Uses a shared FS singleton via globalThis.__aciiFS so all apps see the same tree.

import { signal, effect } from '../signals.js';
import { createFS } from '../fs.js';

const SAVE_FLASH_MS = 1000;

// ── Shared FS singleton ────────────────────────────────────────────────
function getFS(win) {
  if (win && win.fs) return win.fs;
  if (!globalThis.__aciiFS) globalThis.__aciiFS = createFS();
  return globalThis.__aciiFS;
}

// ── Path helpers (mirror fs.js style; we don't import internals) ───────
function parentOf(path) {
  if (!path || path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
function basename(path) {
  if (!path || path === '/') return '/';
  return path.slice(path.lastIndexOf('/') + 1);
}
function joinPath(a, b) {
  if (a === '/') return '/' + b;
  return a + '/' + b;
}

// ── Binary detection (same extension list as fs.js, kept local) ────────
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

  // ── Tree state ─────────────────────────────────────────────────────
  const expanded = new Set(['/']); // expanded dir paths
  let selectedPath = '/docs/README.md';
  let treeScroll = 0;

  // ── Editor state ───────────────────────────────────────────────────
  let editorPath = null;        // path of file currently loaded
  let editorLines = [''];       // string[]
  let editorBinarySize = -1;    // >=0 means binary, value is size in bytes
  let editorLoadError = null;
  let editorRow = 0;
  let editorCol = 0;
  let editorScrollY = 0;
  let editorDirty = false;

  // ── Focus + UI ─────────────────────────────────────────────────────
  let focus = 'tree'; // 'tree' | 'editor'
  let lastSavedAt = 0;
  const savedFlash = signal(false);
  let flashTimer = null;

  // Cached flat view of the tree for navigation/click.
  // Each entry: { path, name, type, depth, isMountAction }
  let visibleRows = [];

  // Caret blink — repaint signal piggybacks on render loop.
  let blinkOn = true;
  const blinkInterval = setInterval(() => { blinkOn = !blinkOn; }, 500);

  // React to FS changes — rebuild tree, and reload editor if backing file changed.
  const unsubFS = fs.subscribe('/', () => {
    rebuildVisibleRows();
    // If editor's file vanished or changed on disk, refresh quietly when not dirty.
    if (editorPath && !editorDirty) {
      if (!fs.exists(editorPath)) {
        editorPath = null;
        editorLines = [''];
        editorBinarySize = -1;
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
      // list() can return a Promise for pure mount paths — guard.
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
    // Append the special action row.
    out.push({ path: '__mount__', name: '+ mount local…', type: 'action', depth: 0, isMountAction: true });
    visibleRows = out;
    // Keep selectedPath valid; if it points at something no longer visible,
    // we still keep it (it might be inside a collapsed folder), but clamp scroll.
  }
  rebuildVisibleRows();

  // ── File loading ───────────────────────────────────────────────────
  function loadFileIntoEditor(path, silent = false) {
    editorLoadError = null;
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
    editorPath = path;
    editorBinarySize = -1;
    editorLines = text.length === 0 ? [''] : text.split('\n');
    if (!silent) { editorRow = 0; editorCol = 0; editorScrollY = 0; }
    editorDirty = false;
    clampCaret();
  }

  function saveEditor() {
    if (!editorPath || editorBinarySize >= 0) return;
    try {
      fs.write(editorPath, editorLines.join('\n'));
      editorDirty = false;
      lastSavedAt = Date.now();
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

  // ── Edit ops ───────────────────────────────────────────────────────
  function insertChar(ch) {
    if (editorBinarySize >= 0 || !editorPath) return;
    const line = editorLines[editorRow];
    editorLines[editorRow] = line.slice(0, editorCol) + ch + line.slice(editorCol);
    editorCol += ch.length;
    editorDirty = true;
  }
  function insertNewline() {
    if (editorBinarySize >= 0 || !editorPath) return;
    const line = editorLines[editorRow];
    editorLines[editorRow] = line.slice(0, editorCol);
    editorLines.splice(editorRow + 1, 0, line.slice(editorCol));
    editorRow++;
    editorCol = 0;
    editorDirty = true;
  }
  function backspace() {
    if (editorBinarySize >= 0 || !editorPath) return;
    if (editorCol > 0) {
      const line = editorLines[editorRow];
      editorLines[editorRow] = line.slice(0, editorCol - 1) + line.slice(editorCol);
      editorCol--;
      editorDirty = true;
    } else if (editorRow > 0) {
      const prev = editorLines[editorRow - 1];
      editorCol = prev.length;
      editorLines[editorRow - 1] = prev + editorLines[editorRow];
      editorLines.splice(editorRow, 1);
      editorRow--;
      editorDirty = true;
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
    if (i < 0) {
      selectByIndex(0);
      return;
    }
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
    if (r.isMountAction) {
      tryMountLocal();
      return;
    }
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
    // Jump to parent dir row if present.
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
      }
      rebuildVisibleRows();
    } catch (e) {
      editorLoadError = String(e && e.message || e);
    }
  }

  // Parent directory of the current selection (or '/' if at root).
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
    const name = window.prompt('Nový soubor — cesta:', initial);
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
    const name = window.prompt('Nová složka — cesta:', initial);
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
    const next = window.prompt('Přejmenovat na:', r.path);
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
    // ~1/3 of width, clamped to a sensible band.
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

    // Adjust scroll so selection stays visible.
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

      // Paint the row's background across the inner width first.
      ctx.rect(x0 + 1, y0 + 1 + i, innerW, 1, { ch: ' ', bg, fg });
      const visible = text.slice(0, innerW);
      ctx.text(x0 + 1, y0 + 1 + i, visible, { fg, bg, bold: isSel && treeFocused });

      // Selection marker on the right when focused.
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

    // Title: path + modified indicator.
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

    const innerX = x0 + 1;
    const innerY = y0 + 1;
    const innerW = w - 2;
    const innerH = h - 2;
    if (innerH <= 0 || innerW <= 0) return;

    // Background wash.
    ctx.rect(innerX, innerY, innerW, innerH, { ch: ' ', bg: C.bg, fg: C.fg });

    if (editorLoadError) {
      ctx.text(innerX, innerY, ('error: ' + editorLoadError).slice(0, innerW), {
        fg: C.error, bg: C.bg,
      });
      return;
    }
    if (!editorPath) {
      const hint = 'select a file in the tree (Enter / →)';
      ctx.text(innerX, innerY, hint.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      return;
    }
    if (editorBinarySize >= 0) {
      const msg = `binary, ${editorBinarySize} bytes`;
      ctx.text(innerX, innerY, msg.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      return;
    }

    // Keep caret visible.
    if (editorRow < editorScrollY) editorScrollY = editorRow;
    else if (editorRow >= editorScrollY + innerH) editorScrollY = editorRow - innerH + 1;
    if (editorScrollY < 0) editorScrollY = 0;

    const maxLineWidth = Math.max(1, innerW - 1);
    for (let i = 0; i < innerH; i++) {
      const li = editorScrollY + i;
      if (li >= editorLines.length) break;
      const line = editorLines[li];
      let visible = line;
      let truncated = false;
      if (line.length > maxLineWidth) {
        visible = line.slice(0, maxLineWidth);
        truncated = true;
      }
      if (visible.length > 0) {
        ctx.text(innerX, innerY + i, visible, { fg: C.fg, bg: C.bg });
      }
      if (truncated) {
        ctx.put(innerX + innerW - 1, innerY + i, '›', { fg: C.warning, bg: C.bg });
      }
    }

    // Caret.
    if (edFocused) {
      const caretY = editorRow - editorScrollY;
      if (caretY >= 0 && caretY < innerH) {
        const caretX = Math.min(editorCol, maxLineWidth - 1);
        if (caretX >= 0) {
          const lineAtCaret = editorLines[editorRow] || '';
          const underCh = lineAtCaret[editorCol] || ' ';
          if (blinkOn) {
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
    let left;
    if (editorPath) {
      const st = fs.exists(editorPath) ? fs.stat(editorPath) : null;
      const size = st && st.type === 'file' ? st.size : 0;
      const dirtyTag = editorDirty ? ' [modified]' : '';
      left = `${editorPath} · ${size}B${dirtyTag}`;
    } else {
      const r = selectedRow();
      left = r ? r.path : '/';
    }
    ctx.text(0, y, left.slice(0, W), { fg: C.fgDim, bg: C.bg });

    const flashing = savedFlash.value;
    const right = flashing
      ? 'Saved'
      : (focus === 'tree'
          ? 'N new · ⇧N folder · R rename · ⌫ del · ↵ open · ⇥ editor'
          : 'Ctrl+S save · ⇥ tree');
    const rx = W - right.length;
    if (rx > left.length + 2) {
      ctx.text(rx, y, right, { fg: flashing ? C.accent : C.fgDim, bg: C.bg });
    }
  }

  // Pick up shell openFile hint — fires when shell.openFile() routes a file
  // path here. Sets selection + loads into editor.
  function consumeOpenFileHint() {
    const p = globalThis.__aciiOpenFile;
    if (!p || !p.startsWith('/')) return;
    if (!fs.exists(p)) return;
    globalThis.__aciiOpenFile = null;
    // Expand parent folders so the row is visible.
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
    },

    onKey(e) {
      if (e.type !== 'down') return;
      const k = e.key;

      // Global shortcuts.
      if ((e.ctrl || e.meta) && (k === 's' || k === 'S')) {
        saveEditor();
        return;
      }
      if (k === 'Tab') {
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
        // File ops in tree:
        if (k === 'n' || k === 'N') {
          if (e.shift) newFolder(); else newFile();
          return;
        }
        if (k === 'F2' || k === 'r' || k === 'R') { renameSelected(); return; }
        return;
      }

      // Editor focus
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
      if (e.type !== 'click' && e.type !== 'mousedown' && e.type !== 'dblclick') return;
      const W = initialCtx.width;
      const H = initialCtx.height;
      const lw = leftPaneWidth(W);
      const paneH = H - 1;

      // Tree pane click.
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

      // Editor pane click.
      if (e.x >= lw - 1 && e.x < W && e.y >= 1 && e.y < paneH - 1) {
        focus = 'editor';
        if (!editorPath || editorBinarySize >= 0) return;
        const innerX = lw;     // first editable column (inside border)
        const innerY = 1;
        const innerH = paneH - 2;
        const localY = e.y - innerY;
        if (localY < 0 || localY >= innerH) return;
        const targetRow = editorScrollY + localY;
        if (targetRow >= editorLines.length) {
          editorRow = editorLines.length - 1;
          editorCol = editorLines[editorRow].length;
          return;
        }
        editorRow = targetRow;
        editorCol = Math.max(0, Math.min(e.x - innerX, editorLines[editorRow].length));
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
          if (e.dir === 'up') { editorRow = Math.min(editorLines.length - 1, editorRow + 3); clampCaret(); }
          else if (e.dir === 'down') { editorRow = Math.max(0, editorRow - 3); clampCaret(); }
        }
      }
    },

    destroy() {
      if (editorDirty && editorPath && editorBinarySize < 0) {
        try { fs.write(editorPath, editorLines.join('\n')); } catch {}
      }
      if (flashTimer) clearTimeout(flashTimer);
      if (blinkInterval) clearInterval(blinkInterval);
      if (typeof unsubFS === 'function') unsubFS();
    },
  };
}
