// apps/gitdesk.js — "Git Desk", a GitHub-Desktop-style client for the
// virtual git engine (src/git.js) over the shared virtual FS.
//
// Layout (floating window, LOCAL coords):
//   ┌ branch bar ────────────────────────────────────┐  ← repo + branch + ⎇ menu
//   │ [Changes] [History]                              │  ← tabs
//   ├──────────────┬──────────────────────────────────┤
//   │ file list    │ diff / commit detail             │
//   │ (stage ☑/☐)  │                                  │
//   ├──────────────┴──────────────────────────────────┤
//   │ commit message + [ Commit N file(s) ]            │  ← Changes tab only
//   └──────────────────────────────────────────────────┘
//
// Mirrors the app contract from CLAUDE.md: createApp(initialCtx, win) →
// { render, onKey, onMouse, onTouch, destroy }. The shell routes input; coords
// are local to the content area. We read theme colors from ctx.theme.peek().
//
// The git engine is a shared singleton (like fs/user/drafts) so the desktop
// widget, taskbar, terminal and this app all see the same repos:
//   const git = globalThis.__aciiGit ||= createGit(fs);

import { createFS } from '../fs.js';
import { createGit } from '../git.js';

const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });
const git = globalThis.__aciiGit ||= createGit(fs);

export function createApp(initialCtx, win) {
  // ── view state ───────────────────────────────────────────────────
  let tab = 'changes';            // 'changes' | 'history'
  let repo = git.activeRepo.peek() || (git.listRepos()[0] || null);
  let selChange = 0;              // index into the flattened change rows
  let selCommit = 0;              // index into the log
  let commitMsg = '';             // commit message buffer
  let editingMsg = false;         // is the message box focused for typing?
  let scroll = 0;                 // diff scroll offset
  let listScroll = 0;             // file-list scroll offset
  let branchMenu = null;          // { items:[{label,action}], sel } when open
  let toast = null;               // { text, kind, until }

  // Pick up a path handed off by the shell ("open repo here").
  function adoptHandoff() {
    const p = globalThis.__aciiGitRepo;
    if (p) {
      globalThis.__aciiGitRepo = null;
      const r = git.repoFor(p);
      if (r) { repo = r; git.setActive(r); }
    }
  }
  adoptHandoff();
  if (repo) git.setActive(repo);

  function note(text, kind = 'info') {
    toast = { text, kind, until: performance.now() + 2600 };
  }

  // ── derived data (recomputed each render; the FS/git are cheap) ──
  function snapshot() {
    if (!repo || !git.isRepo(repo)) { repo = git.listRepos()[0] || null; }
    if (!repo) return null;
    const st = git.status(repo);
    const rows = [
      ...st.staged.map(e => ({ ...e, staged: true })),
      ...st.unstaged.map(e => ({ ...e, staged: false })),
    ];
    return { st, rows };
  }

  function currentChange(rows) {
    if (!rows.length) return null;
    if (selChange >= rows.length) selChange = rows.length - 1;
    if (selChange < 0) selChange = 0;
    return rows[selChange];
  }

  // ── rendering ────────────────────────────────────────────────────
  function render(ctx) {
    adoptHandoff();
    const c = ctx.theme.peek().colors;
    const W = ctx.width, H = ctx.height;
    if (W < 8 || H < 6) { ctx.text(0, 0, 'git', { fg: c.fgDim }); return; }
    ctx.rect(0, 0, W, H, { ch: ' ', bg: c.bg });

    if (toast && performance.now() > toast.until) toast = null;

    // Re-resolve the active repo each frame so a repo created elsewhere (shell
    // context menu, terminal `git init`) is picked up without reopening.
    if (!repo || !git.isRepo(repo)) {
      repo = git.activeRepo.peek() || git.listRepos()[0] || null;
      if (repo) git.setActive(repo);
    }

    if (!repo) { renderNoRepo(ctx, c, W, H); return; }
    const snap = snapshot();
    if (!snap) { renderNoRepo(ctx, c, W, H); return; }

    renderBranchBar(ctx, c, W, snap.st);
    renderTabs(ctx, c, W);

    const bodyTop = 2;
    const bodyBottom = tab === 'changes' ? H - 4 : H - 1;  // commit box reserves 3 rows
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    if (tab === 'changes') {
      renderChanges(ctx, c, W, bodyTop, bodyH, snap);
      renderCommitBox(ctx, c, W, H, snap.st);
    } else {
      renderHistory(ctx, c, W, bodyTop, bodyH);
    }

    if (toast) renderToast(ctx, c, W, H);
    if (branchMenu) renderBranchMenu(ctx, c, W, H);
  }

  function renderNoRepo(ctx, c, W, H) {
    const lines = [
      'No git repository here.',
      '',
      'A repo is just a folder you have',
      'initialized. Pick one to start tracking',
      'changes, commits and branches.',
      '',
      '[ Initialize a repo… ]',
    ];
    const top = Math.max(0, Math.floor((H - lines.length) / 2));
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      const x = Math.max(0, Math.floor((W - s.length) / 2));
      const isBtn = s.startsWith('[');
      ctx.text(x, top + i, s, { fg: isBtn ? c.accent : (s.startsWith('No') ? c.warning : c.fgDim), bold: isBtn });
    }
    _initBtn = { y: top + lines.length - 1, x: Math.max(0, Math.floor((W - lines[lines.length - 1].length) / 2)), w: lines[lines.length - 1].length };
  }
  let _initBtn = null;

  function renderBranchBar(ctx, c, W, st) {
    ctx.rect(0, 0, W, 1, { ch: ' ', bg: c.border });
    const name = repo.split('/').pop() || repo;
    const left = ` ${name} `;
    ctx.text(0, 0, left, { fg: c.bg, bg: c.accent, bold: true });
    // Branch chip (click → branch menu): ⎇ branch ▾
    const dirty = st.clean ? '' : ` ●${st.changeCount}`;
    const chip = ` ⎇ ${st.branch}${dirty} ▾ `;
    const bx = left.length + 1;
    ctx.text(bx, 0, chip, { fg: c.bg, bg: c.link, bold: true });
    _branchChip = { x: bx, w: chip.length };
    // Right: commit count.
    const meta = `${st.commitCount} commit${st.commitCount === 1 ? '' : 's'} `;
    ctx.text(Math.max(bx + chip.length + 1, W - meta.length), 0, meta, { fg: c.fgDim, bg: c.border });
  }
  let _branchChip = null;

  function renderTabs(ctx, c, W) {
    ctx.rect(0, 1, W, 1, { ch: ' ', bg: c.bg });
    const tabs = [['changes', 'Changes'], ['history', 'History']];
    let x = 1;
    _tabHits = [];
    for (const [id, label] of tabs) {
      const on = tab === id;
      const s = ` ${label} `;
      // Active tab gets an accent underline-style highlight; inactive is dim.
      ctx.text(x, 1, s, { fg: on ? c.accent : c.fgDim, bold: on });
      _tabHits.push({ id, x, w: s.length });
      x += s.length + 1;
    }
  }
  let _tabHits = [];

  // Split: left file list (≈40%), right diff.
  function splitX(W) { return Math.max(16, Math.min(34, Math.floor(W * 0.42))); }

  function renderChanges(ctx, c, W, top, h, snap) {
    const sx = splitX(W);
    const { rows } = snap;
    // vertical divider
    for (let y = top; y < top + h; y++) ctx.put(sx, y, ctx.theme.peek().glyphs.border.v, { fg: c.border });

    // ── left: file list with stage checkboxes ──
    if (!rows.length) {
      ctx.text(1, top, 'No changes.', { fg: c.success });
      ctx.text(1, top + 1, 'Working tree clean.', { fg: c.fgDim });
    } else {
      // group headers (Staged / Changes) interleaved with rows
      const visible = h;
      if (selChange < listScroll) listScroll = selChange;
      if (selChange >= listScroll + visible) listScroll = selChange - visible + 1;
      let prevStaged = null;
      let drawn = 0;
      for (let i = listScroll; i < rows.length && drawn < visible; i++) {
        const r = rows[i];
        const y = top + drawn;
        const isSel = i === selChange;
        if (isSel) ctx.rect(0, y, sx, 1, { ch: ' ', bg: c.border });
        const box = r.staged ? '☑' : '☐';
        const stCol = r.status === 'A' ? c.success : r.status === 'D' ? c.error : c.warning;
        ctx.text(1, y, box, { fg: r.staged ? c.success : c.fgDim, bold: true });
        ctx.put(3, y, r.status, { fg: stCol, bold: true });
        const name = r.path.length > sx - 6 ? '…' + r.path.slice(-(sx - 7)) : r.path;
        ctx.text(5, y, name, { fg: isSel ? c.fg : (r.staged ? c.fg : c.fgDim), bold: isSel });
        drawn++;
      }
    }

    // ── right: diff of the selected file ──
    const dx = sx + 1;
    const dw = W - dx;
    const cur = currentChange(rows);
    if (!cur) {
      ctx.text(dx + 1, top, 'select a file →'.slice(0, dw - 1), { fg: c.fgDim });
      return;
    }
    ctx.text(dx + 1, top, (cur.path).slice(0, dw - 2), { fg: c.accent, bold: true });
    const hunk = git.diff(repo, cur.path, cur.staged ? 'staged' : 'work');
    const maxScroll = Math.max(0, hunk.length - (h - 1));
    if (scroll > maxScroll) scroll = maxScroll;
    if (scroll < 0) scroll = 0;
    for (let i = 0; i < h - 1; i++) {
      const ln = hunk[scroll + i];
      const y = top + 1 + i;
      if (!ln) continue;
      const sign = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';
      const col = ln.type === 'add' ? c.success : ln.type === 'del' ? c.error : c.fgDim;
      ctx.put(dx + 1, y, sign, { fg: col, bold: ln.type !== 'ctx' });
      ctx.text(dx + 3, y, (ln.text || '').slice(0, dw - 4), { fg: ln.type === 'ctx' ? c.fgDim : c.fg });
    }
    if (hunk.length > h - 1) {
      const tag = `[${scroll + 1}-${Math.min(hunk.length, scroll + h - 1)}/${hunk.length}]`;
      ctx.text(Math.max(dx + 1, W - tag.length), top, tag, { fg: c.warning });
    }
  }

  function renderCommitBox(ctx, c, W, H, st) {
    const y0 = H - 3;
    for (let i = 0; i < W; i++) ctx.put(i, y0, ctx.theme.peek().glyphs.border.h, { fg: c.border });
    // message input
    const label = editingMsg ? '▍' : ' ';
    const placeholder = 'Summary (Enter to commit)';
    const shown = commitMsg || (editingMsg ? '' : placeholder);
    const msgCol = commitMsg ? c.fg : c.fgDim;
    ctx.text(1, y0 + 1, ('msg: ' + shown).slice(0, W - 18), { fg: msgCol });
    if (editingMsg) {
      const cx = Math.min(W - 19, 6 + commitMsg.length);
      ctx.put(cx, y0 + 1, '▍', { fg: c.accent, bold: true });
    }
    // commit button
    const n = st.staged.length;
    const btn = ` Commit ${n} file${n === 1 ? '' : 's'} `;
    const bx = W - btn.length - 1;
    const enabled = n > 0 && commitMsg.trim().length > 0;
    ctx.text(bx, y0 + 1, btn, { fg: enabled ? c.bg : c.fgDim, bg: enabled ? c.accent : c.border, bold: enabled });
    _commitBtn = { x: bx, y: y0 + 1, w: btn.length, enabled };
    _msgRow = y0 + 1;
    // stage-all / discard hints
    ctx.text(1, y0 + 2, 'Space stage · a all · d discard · b branch · c message'.slice(0, W - 1), { fg: c.fgDim });
  }
  let _commitBtn = null, _msgRow = -1;

  function renderHistory(ctx, c, W, top, h) {
    const log = git.log(repo);
    if (!log.length) { ctx.text(1, top, 'No commits yet.', { fg: c.fgDim }); return; }
    const sx = splitX(W);
    for (let y = top; y < top + h; y++) ctx.put(sx, y, ctx.theme.peek().glyphs.border.v, { fg: c.border });
    if (selCommit >= log.length) selCommit = log.length - 1;
    if (selCommit < 0) selCommit = 0;
    let start = 0;
    if (selCommit >= h) start = selCommit - h + 1;
    for (let i = 0; i < h && start + i < log.length; i++) {
      const cm = log[start + i];
      const y = top + i;
      const isSel = start + i === selCommit;
      if (isSel) ctx.rect(0, y, sx, 1, { ch: ' ', bg: c.border });
      ctx.text(1, y, cm.id.slice(0, 7), { fg: c.warning });
      ctx.text(9, y, (cm.message.split('\n')[0]).slice(0, sx - 10), { fg: isSel ? c.fg : c.fgDim, bold: isSel });
    }
    // detail of selected commit
    const dx = sx + 1, dw = W - dx;
    const cm = log[selCommit];
    if (!cm) return;
    let y = top;
    ctx.text(dx + 1, y++, ('commit ' + cm.id).slice(0, dw - 1), { fg: c.warning, bold: true });
    ctx.text(dx + 1, y++, ('author ' + cm.author).slice(0, dw - 1), { fg: c.fgDim });
    ctx.text(dx + 1, y++, ('date   ' + new Date(cm.time).toLocaleString()).slice(0, dw - 1), { fg: c.fgDim });
    y++;
    const msgLines = cm.message.split('\n');
    for (const ml of msgLines) { if (y >= top + h) break; ctx.text(dx + 1, y++, ml.slice(0, dw - 1), { fg: c.fg }); }
    y++;
    if (y < top + h) {
      const files = Object.keys(cm.tree || {}).sort();
      ctx.text(dx + 1, y++, `${files.length} file(s):`, { fg: c.accent });
      for (const f of files) { if (y >= top + h) break; ctx.text(dx + 2, y++, f.slice(0, dw - 3), { fg: c.fgDim }); }
    }
  }

  function renderToast(ctx, c, W, H) {
    const s = ' ' + toast.text + ' ';
    const col = toast.kind === 'error' ? c.error : toast.kind === 'ok' ? c.success : c.accent;
    const x = Math.max(0, W - s.length - 1);
    ctx.text(x, tab === 'changes' ? H - 4 : H - 1, s, { fg: c.bg, bg: col, bold: true });
  }

  function renderBranchMenu(ctx, c, W, H) {
    const items = branchMenu.items;
    const mw = Math.min(W - 2, Math.max(16, ...items.map(i => i.label.length + 3)));
    const mh = items.length + 2;
    const mx = Math.min(_branchChip ? _branchChip.x : 2, W - mw - 1);
    const my = 1;
    ctx.rect(mx, my, mw, mh, { ch: ' ', bg: c.bg });
    ctx.box(mx, my, mw, mh, { fg: c.borderFocus, glyphSet: 'borderRound' });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const y = my + 1 + i;
      const sel = i === branchMenu.sel;
      if (sel) ctx.rect(mx + 1, y, mw - 2, 1, { ch: ' ', bg: c.border });
      ctx.text(mx + 1, y, (' ' + it.label).slice(0, mw - 2), { fg: it.action === 'new' ? c.accent : c.fg, bold: sel });
    }
    branchMenu._bounds = { x: mx, y: my, w: mw, h: mh };
  }

  // ── actions ──────────────────────────────────────────────────────
  function doStageToggle() {
    const snap = snapshot(); if (!snap) return;
    const cur = currentChange(snap.rows); if (!cur) return;
    if (cur.staged) git.unstage(repo, cur.path);
    else git.stage(repo, cur.path);
  }
  function doStageAll() { if (repo) { git.stageAll(repo); note('staged all', 'ok'); } }
  function doDiscard() {
    const snap = snapshot(); if (!snap) return;
    const cur = currentChange(snap.rows); if (!cur || cur.staged) { note('select an unstaged file', 'error'); return; }
    if (window.confirm(`Discard changes to ${cur.path}?`)) { git.discard(repo, cur.path); note('discarded', 'ok'); }
  }
  function doCommit() {
    if (!repo) return;
    try {
      const id = git.commit(repo, commitMsg);
      note('committed ' + id.slice(0, 7), 'ok');
      commitMsg = ''; editingMsg = false; scroll = 0;
    } catch (err) { note(err.message || String(err), 'error'); }
  }
  function openBranchMenu() {
    if (!repo) return;
    const { list } = git.branches(repo);
    const items = list.map(b => ({ label: (b.current ? '● ' : '  ') + b.name, action: 'checkout', name: b.name }));
    items.push({ label: '+ New branch…', action: 'new' });
    branchMenu = { items, sel: Math.max(0, list.findIndex(b => b.current)) };
  }
  function chooseBranchItem(it) {
    branchMenu = null;
    if (!it) return;
    if (it.action === 'new') {
      const name = window.prompt('New branch name:', '');
      if (!name) return;
      try { git.createBranch(repo, name, { checkout: true }); note('switched to ' + name, 'ok'); }
      catch (err) { note(err.message, 'error'); }
      return;
    }
    if (it.action === 'checkout') {
      const snap = snapshot();
      if (snap && !snap.st.clean && !window.confirm('Switch branches? Uncommitted working-tree changes will be overwritten by the target branch.')) return;
      try { git.checkout(repo, it.name); note('on ' + it.name, 'ok'); selChange = 0; scroll = 0; }
      catch (err) { note(err.message, 'error'); }
    }
  }
  function doInit() {
    // Initialize the active desktop folder, falling back to /desktop, else /.
    const target = '/desktop';
    try {
      git.init(target);
      repo = target; git.setActive(repo);
      note('initialized repo at ' + target, 'ok');
    } catch (err) { note(err.message, 'error'); }
  }

  // ── input ────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.type !== 'down') return;
    const k = e.key;

    // Branch menu captures keys while open.
    if (branchMenu) {
      if (k === 'Escape') { branchMenu = null; return; }
      if (k === 'ArrowDown') { branchMenu.sel = (branchMenu.sel + 1) % branchMenu.items.length; return; }
      if (k === 'ArrowUp') { branchMenu.sel = (branchMenu.sel - 1 + branchMenu.items.length) % branchMenu.items.length; return; }
      if (k === 'Enter') { chooseBranchItem(branchMenu.items[branchMenu.sel]); return; }
      return;
    }

    // Message editing mode swallows printable keys.
    if (editingMsg) {
      if (k === 'Escape') { editingMsg = false; return; }
      if (k === 'Enter') { doCommit(); return; }
      if (k === 'Backspace') { commitMsg = commitMsg.slice(0, -1); return; }
      if (k.length === 1 && !e.ctrl && !e.meta) { commitMsg += k; return; }
      return;
    }

    if (!repo) {
      if (k === 'Enter' || k === ' ') doInit();
      return;
    }

    if (k === 'Tab') { tab = tab === 'changes' ? 'history' : 'changes'; return; }
    if (k === 'ArrowUp') { if (tab === 'changes') { selChange = Math.max(0, selChange - 1); scroll = 0; } else selCommit = Math.max(0, selCommit - 1); return; }
    if (k === 'ArrowDown') { if (tab === 'changes') { selChange++; scroll = 0; } else selCommit++; return; }
    if (k === 'PageDown') { scroll += 5; return; }
    if (k === 'PageUp') { scroll = Math.max(0, scroll - 5); return; }

    if (tab !== 'changes') return;
    if (k === ' ') { doStageToggle(); return; }
    if (k === 'a' || k === 'A') { doStageAll(); return; }
    if (k === 'd' || k === 'D') { doDiscard(); return; }
    if (k === 'b' || k === 'B') { openBranchMenu(); return; }
    if (k === 'c' || k === 'C') { editingMsg = true; return; }
    if (k === 'Enter') { if (_commitBtn?.enabled) doCommit(); else editingMsg = true; return; }
  }

  function onMouse(e) {
    if (e.type === 'wheel') { scroll = Math.max(0, scroll + (e.deltaY > 0 ? 2 : -2)); return; }
    if (e.type !== 'click' && e.type !== 'mousedown') return;
    const W = win?.w?.peek ? win.w.peek() - 2 : 80; // not used directly; we hit-test from stored coords

    // Branch menu open: click selects or closes.
    if (branchMenu && branchMenu._bounds) {
      const b = branchMenu._bounds;
      if (e.x >= b.x && e.x < b.x + b.w && e.y > b.y && e.y < b.y + b.h - 1) {
        const idx = e.y - (b.y + 1);
        if (idx >= 0 && idx < branchMenu.items.length) { chooseBranchItem(branchMenu.items[idx]); return; }
      }
      branchMenu = null;
      return;
    }

    if (!repo) {
      if (_initBtn && e.y === _initBtn.y && e.x >= _initBtn.x && e.x < _initBtn.x + _initBtn.w) doInit();
      return;
    }

    // Branch chip on row 0.
    if (e.y === 0 && _branchChip && e.x >= _branchChip.x && e.x < _branchChip.x + _branchChip.w) { openBranchMenu(); return; }
    // Tabs on row 1.
    if (e.y === 1) {
      for (const t of _tabHits) if (e.x >= t.x && e.x < t.x + t.w) { tab = t.id; return; }
    }
    if (tab === 'changes') {
      // commit button / message row
      if (_commitBtn && e.y === _commitBtn.y) {
        if (e.x >= _commitBtn.x && e.x < _commitBtn.x + _commitBtn.w) { if (_commitBtn.enabled) doCommit(); return; }
        editingMsg = true; return;
      }
      // file list rows (left of split, body area rows 2..)
      const snap = snapshot();
      if (snap && e.y >= 2) {
        const idx = listScroll + (e.y - 2);
        if (idx >= 0 && idx < snap.rows.length) {
          if (idx === selChange) { doStageToggle(); }  // second click toggles stage
          else { selChange = idx; scroll = 0; }
          return;
        }
      }
    } else {
      // history list rows
      if (e.y >= 2) {
        const log = git.log(repo);
        let start = 0; const h = 9999;
        const idx = start + (e.y - 2);
        if (idx >= 0 && idx < log.length) selCommit = idx;
      }
    }
  }

  function onTouch(e) {
    if (e.type === 'tap') onMouse({ type: 'click', x: e.x, y: e.y, button: 0 });
    else if (e.type === 'swipe') { if (e.dir === 'up') scroll += 3; else if (e.dir === 'down') scroll = Math.max(0, scroll - 3); }
    else if (e.type === 'doubletap') doStageToggle();
  }

  function destroy() { /* no owned timers/listeners */ }

  return { render, onKey, onMouse, onTouch, destroy };
}
