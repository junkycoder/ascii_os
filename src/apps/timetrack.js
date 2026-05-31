// timetrack.js — New Fish time-tracking app.
//
// Three tabs:
//   Log      — quick-report time: description (#tags) + duration → POST entry.
//              Lists today's entries and the running daily total.
//   Summary  — daily + monthly totals and a per-tag breakdown with bars.
//   Settings — secret storage: New Fish email + API token (the token lives only
//              in localStorage via newfish.js; never hardcoded, never in git).
//
// Data is shared with the desktop widget through newfish.store, so logging here
// updates the widget and vice-versa. Coords passed to render(ctx) are LOCAL to
// the window content area (see CLAUDE.md app contract).
import * as nf from '../newfish.js';

const TABS = ['Log', 'Summary', 'Settings'];

// Flat focus ring across all tabs — Tab / Shift+Tab walks the whole app and
// switching to an item on another tab brings that tab forward.
const FOCUSABLES = [
  { tab: 0, kind: 'field',  id: 'desc' },
  { tab: 0, kind: 'field',  id: 'dur' },
  { tab: 0, kind: 'button', id: 'log' },
  { tab: 1, kind: 'button', id: 'scope' },
  { tab: 1, kind: 'button', id: 'refresh' },
  { tab: 2, kind: 'field',  id: 'email' },
  { tab: 2, kind: 'field',  id: 'token' },
  { tab: 2, kind: 'button', id: 'save' },
  { tab: 2, kind: 'button', id: 'test' },
  { tab: 2, kind: 'button', id: 'clear' },
];

const caretOn = () => (performance.now() % 1000) < 500;

export function createApp(initialCtx, win) {
  // ── Editable fields ──────────────────────────────────────────────────────
  const fields = {
    desc:  { value: '', caret: 0, secret: false, placeholder: 'what did you do? #tags' },
    dur:   { value: '25m', caret: 3, secret: false, placeholder: '25m / 1.5h' },
    email: { value: nf.getEmail(), caret: nf.getEmail().length, secret: false, placeholder: 'you@example.com' },
    token: { value: '', caret: 0, secret: true, placeholder: nf.hasCredentials() ? '•••••••• (saved)' : 'paste API token' },
  };

  // ── View state ───────────────────────────────────────────────────────────
  // Default to Settings when not connected (so the user sets a token first),
  // unless the widget asked us to jump straight to quick-log.
  let tab = nf.hasCredentials() ? 0 : 2;
  let focusIdx = FOCUSABLES.findIndex(f => f.tab === tab);
  let scope = 'today';          // Summary scope: 'today' | 'month'
  let listScroll = 0;           // scroll offset for entry lists
  let status = '';
  let statusKind = 'info';      // 'info' | 'error' | 'success'

  // Widget hand-off: open straight on Log with the description focused.
  if (globalThis.__aciiTimetrackQuickLog) {
    globalThis.__aciiTimetrackQuickLog = false;
    tab = 0;
    focusIdx = FOCUSABLES.findIndex(f => f.id === 'desc');
  }

  // First load: pull this month's entries if we have credentials and haven't synced.
  if (nf.hasCredentials() && nf.store.lastSync.peek() === 0) nf.refreshMonth();

  // Per-render layout hit zones for the mouse: [{kind,id,x,y,w,h}].
  let hits = [];

  function setStatus(msg, kind = 'info') { status = msg; statusKind = kind; }
  function focusId(id) {
    const i = FOCUSABLES.findIndex(f => f.id === id);
    if (i >= 0) { focusIdx = i; tab = FOCUSABLES[i].tab; }
  }
  function curFocus() { return FOCUSABLES[focusIdx]; }
  function moveFocus(delta) {
    focusIdx = (focusIdx + delta + FOCUSABLES.length) % FOCUSABLES.length;
    tab = curFocus().tab;
    listScroll = 0;
  }
  function switchTab(t) {
    tab = t;
    focusIdx = FOCUSABLES.findIndex(f => f.tab === t);
    listScroll = 0;
  }

  // ── Actions ────────────────────────────────────────────────────────────
  function doLog() {
    if (!nf.hasCredentials()) { setStatus('Set email + token in Settings first', 'error'); switchTab(2); return; }
    const dur = fields.dur.value.trim();
    if (nf.durationToMinutes(dur) <= 0) { setStatus('Enter a duration like 25m or 1.5h', 'error'); return; }
    const desc = fields.desc.value.trim();
    setStatus('Logging…', 'info');
    nf.createEntry({ startedAt: new Date(), description: desc, duration: dur })
      .then(() => {
        setStatus(`Logged ${nf.fmtMinutes(nf.durationToMinutes(dur))}${desc ? ' · ' + desc.slice(0, 24) : ''}`, 'success');
        fields.desc.value = ''; fields.desc.caret = 0;
        return nf.refreshMonth();
      })
      .catch((err) => setStatus('Log failed: ' + (err?.message || err), 'error'));
  }
  function doSave() {
    const email = fields.email.value.trim();
    const token = fields.token.value.trim();
    if (!email) { setStatus('Email is required', 'error'); return; }
    if (!token && !nf.hasCredentials()) { setStatus('Paste your API token', 'error'); return; }
    nf.setCredentials({ email, token: token || undefined });
    fields.token.value = ''; fields.token.caret = 0;
    fields.token.placeholder = '•••••••• (saved)';
    setStatus('Saved. Testing connection…', 'success');
    nf.protectedPing()
      .then(() => { setStatus('Connected ✓', 'success'); return nf.refreshMonth(); })
      .catch((err) => setStatus('Saved, but auth failed: ' + (err?.message || err), 'error'));
  }
  function doTest() {
    setStatus('Testing…', 'info');
    nf.protectedPing()
      .then(() => setStatus('Connected ✓', 'success'))
      .catch((err) => setStatus('Test failed: ' + (err?.message || err), 'error'));
  }
  function doClear() {
    nf.clearCredentials();
    fields.email.value = ''; fields.email.caret = 0;
    fields.token.value = ''; fields.token.caret = 0;
    fields.token.placeholder = 'paste API token';
    nf.store.entries.value = [];
    setStatus('Credentials cleared', 'info');
  }
  function doRefresh() {
    if (!nf.hasCredentials()) { setStatus('Not connected', 'error'); return; }
    setStatus('Refreshing…', 'info');
    nf.refreshMonth().then(() => setStatus('Refreshed', 'success'));
  }
  function activateId(id) {
    switch (id) {
      case 'log': doLog(); break;
      case 'scope': scope = scope === 'today' ? 'month' : 'today'; listScroll = 0; break;
      case 'refresh': doRefresh(); break;
      case 'save': doSave(); break;
      case 'test': doTest(); break;
      case 'clear': doClear(); break;
    }
  }

  // ── Clipboard ────────────────────────────────────────────────────────────
  // The engine renders into a DOM cell grid, so a field is NOT a native input —
  // browser Cmd/Ctrl+V/C never lands in it. Drive the system clipboard ourselves
  // for the focused field (used by both the keyboard shortcuts and the right-click
  // menu). Fields here are single-line, so collapse whitespace on paste.
  function pasteInto(f) {
    if (!f) return;
    if (!(navigator.clipboard && navigator.clipboard.readText)) {
      setStatus('Clipboard unavailable in this browser', 'error');
      return;
    }
    navigator.clipboard.readText().then((txt) => {
      if (!txt) return;
      const clean = txt.replace(/[\r\n\t]+/g, ' ').trim();
      const v = f.value, cur = f.caret;
      f.value = v.slice(0, cur) + clean + v.slice(cur);
      f.caret = cur + clean.length;
      setStatus('Pasted', 'info');
    }).catch(() => setStatus('Clipboard blocked — allow paste, or type it in', 'error'));
  }
  function copyFrom(f) {
    if (!f || !f.value) return;
    if (!(navigator.clipboard && navigator.clipboard.writeText)) {
      setStatus('Clipboard unavailable in this browser', 'error');
      return;
    }
    navigator.clipboard.writeText(f.value)
      .then(() => setStatus('Copied', 'info'))
      .catch(() => setStatus('Copy blocked', 'error'));
  }

  // ── Field editing ──────────────────────────────────────────────────────
  function editField(f, e) {
    const v = f.value, cur = f.caret;
    if (e.key === 'Backspace') { if (cur > 0) { f.value = v.slice(0, cur - 1) + v.slice(cur); f.caret = cur - 1; } return true; }
    if (e.key === 'Delete') { if (cur < v.length) { f.value = v.slice(0, cur) + v.slice(cur + 1); } return true; }
    if (e.key === 'ArrowLeft') { f.caret = Math.max(0, cur - 1); return true; }
    if (e.key === 'ArrowRight') { f.caret = Math.min(v.length, cur + 1); return true; }
    if (e.key === 'Home') { f.caret = 0; return true; }
    if (e.key === 'End') { f.caret = v.length; return true; }
    if (e.key && e.key.length === 1 && !e.ctrl && !e.meta) {
      f.value = v.slice(0, cur) + e.key + v.slice(cur); f.caret = cur + 1; return true;
    }
    return false;
  }

  // ── Drawing helpers ──────────────────────────────────────────────────────
  function drawField(ctx, x, y, w, c, f, focused) {
    if (w < 3) return;
    const inner = w - 2;
    const empty = f.value.length === 0;
    const disp = empty ? (f.placeholder || '') : (f.secret ? '•'.repeat(f.value.length) : f.value);
    let scroll = 0;
    if (f.caret > inner - 1) scroll = f.caret - (inner - 1);
    const visible = disp.slice(scroll, scroll + inner);
    const bfg = focused ? c.borderFocus : c.border;
    ctx.put(x, y, focused ? '▶' : '[', { fg: bfg, bold: focused });
    ctx.text(x + 1, y, ' '.repeat(inner), { fg: c.fg, bg: c.bg });
    ctx.text(x + 1, y, visible, { fg: empty ? c.fgDim : c.fg, bg: c.bg });
    ctx.put(x + w - 1, y, focused ? '◀' : ']', { fg: bfg, bold: focused });
    if (focused && caretOn()) {
      const cx = x + 1 + (f.caret - scroll);
      if (cx >= x + 1 && cx < x + 1 + inner) {
        const under = empty ? ' ' : (f.secret ? (f.value[f.caret] ? '•' : ' ') : (f.value[f.caret] || ' '));
        ctx.put(cx, y, under, { fg: c.bg, bg: c.accent });
      }
    }
    hits.push({ kind: 'field', id: fieldKey(f), x, y, w, h: 1 });
  }
  function fieldKey(f) {
    for (const k of Object.keys(fields)) if (fields[k] === f) return k;
    return '';
  }
  function drawButton(ctx, x, y, c, label, id, kind) {
    const focused = curFocus().id === id;
    let text, w;
    if (focused) { text = '▶ ' + label + ' ◀'; w = text.length; ctx.text(x, y, text, { fg: c.bg, bg: c.accent, bold: true }); }
    else { text = '[ ' + label + ' ]'; w = text.length; ctx.text(x, y, text, { fg: kind === 'danger' ? c.error : c.fg }); }
    hits.push({ kind: 'button', id, x, y, w, h: 1 });
    return w;
  }

  // ── Tab content renderers ────────────────────────────────────────────────
  function renderLog(ctx, c, W, H, y0) {
    let y = y0;
    ctx.text(0, y, 'Description', { fg: c.fgDim }); y++;
    drawField(ctx, 0, y, W, c, fields.desc, curFocus().id === 'desc'); y += 2;
    ctx.text(0, y, 'Duration', { fg: c.fgDim }); y++;
    const durW = Math.min(14, W - 16);
    drawField(ctx, 0, y, durW, c, fields.dur, curFocus().id === 'dur');
    drawButton(ctx, durW + 2, y, c, 'Log time', 'log');
    y += 2;
    ctx.text(0, y, '─'.repeat(W), { fg: c.border }); y++;
    const head = `Today: ${nf.fmtMinutes(nf.todayMinutes())}`;
    ctx.text(0, y, head, { fg: c.accent, bold: true });
    const n = todayEntries().length;
    const sub = `${n} ${n === 1 ? 'entry' : 'entries'}`;
    ctx.text(Math.max(head.length + 2, W - sub.length), y, sub, { fg: c.fgDim });
    y++;
    renderEntryList(ctx, c, W, H, y, todayEntries());
  }

  function renderSummary(ctx, c, W, H, y0) {
    let y = y0;
    const scopeLabel = scope === 'today' ? 'Scope: Today' : 'Scope: Month';
    const w1 = drawButton(ctx, 0, y, c, scopeLabel, 'scope');
    drawButton(ctx, w1 + 2, y, c, 'Refresh', 'refresh');
    y += 2;
    ctx.text(0, y, `Today: ${nf.fmtMinutes(nf.todayMinutes())}`, { fg: c.accent, bold: true });
    const monthStr = `Month: ${nf.fmtMinutes(nf.monthMinutes())}`;
    ctx.text(Math.max(20, W - monthStr.length), y, monthStr, { fg: c.accent, bold: true });
    y += 2;
    const ents = scopeEntries();
    ctx.text(0, y, scope === 'today' ? 'Today by tag' : 'Month by tag', { fg: c.fgDim });
    const tot = `Σ ${nf.fmtMinutes(nf.sumMinutes(ents))}`;
    ctx.text(Math.max(14, W - tot.length), y, tot, { fg: c.fg });
    y++;
    const byTag = nf.minutesByTag(ents);
    if (!byTag.length) { ctx.text(0, y, nf.store.error.peek() === 'no-credentials' ? '(connect in Settings)' : '(no entries)', { fg: c.fgDim }); return; }
    const max = byTag[0].minutes || 1;
    const labelW = Math.min(16, Math.max(...byTag.map(t => t.tag.length)) + 1);
    const barMax = Math.max(4, W - labelW - 9);
    const rows = Math.max(0, H - y - 1);
    for (let i = listScroll; i < byTag.length && (i - listScroll) < rows; i++) {
      const t = byTag[i];
      const tag = ('#' + t.tag).slice(0, labelW - 1);
      ctx.text(0, y, tag, { fg: t.tag === '(untagged)' ? c.fgDim : c.link });
      const fill = Math.round(barMax * (t.minutes / max));
      ctx.text(labelW, y, '█'.repeat(fill) + '░'.repeat(barMax - fill), { fg: c.accent });
      const dur = nf.fmtMinutes(t.minutes);
      ctx.text(W - dur.length, y, dur, { fg: c.fg });
      y++;
    }
  }

  function renderSettings(ctx, c, W, H, y0) {
    let y = y0;
    const acc = nf.account.peek();
    ctx.text(0, y, 'New Fish account', { fg: c.fgDim });
    const state = acc.hasToken ? '● connected' : '○ not connected';
    ctx.text(Math.max(18, W - state.length), y, state, { fg: acc.hasToken ? c.success : c.warning });
    y += 1;
    ctx.text(0, y, 'Email', { fg: c.fgDim }); y++;
    drawField(ctx, 0, y, W, c, fields.email, curFocus().id === 'email'); y += 2;
    ctx.text(0, y, 'API token  (new-fish.net → my account)', { fg: c.fgDim }); y++;
    drawField(ctx, 0, y, W, c, fields.token, curFocus().id === 'token'); y += 2;
    let bx = 0;
    bx += drawButton(ctx, bx, y, c, 'Save', 'save') + 2;
    bx += drawButton(ctx, bx, y, c, 'Test', 'test') + 2;
    drawButton(ctx, bx, y, c, 'Clear', 'clear', 'danger');
    y += 2;
    ctx.text(0, y, 'Token is stored only in this browser (localStorage),', { fg: c.fgDim }); y++;
    ctx.text(0, y, 'sent via a same-origin proxy. Never committed to git.', { fg: c.fgDim });
  }

  function renderEntryList(ctx, c, W, H, y0, ents) {
    const rows = Math.max(0, H - y0 - 1);
    if (!ents.length) {
      ctx.text(0, y0, nf.store.error.peek() === 'no-credentials' ? '(connect in Settings)'
        : nf.store.loading.peek() ? '(loading…)' : '(no entries today)', { fg: c.fgDim });
      return;
    }
    for (let i = listScroll; i < ents.length && (i - listScroll) < rows; i++) {
      const e = ents[i];
      const t = e.startedAt && !isNaN(e.startedAt)
        ? `${String(e.startedAt.getHours()).padStart(2, '0')}:${String(e.startedAt.getMinutes()).padStart(2, '0')}`
        : '--:--';
      const dur = nf.fmtMinutes(e.minutes).padStart(6);
      const prefix = `${t} ${dur}  `;
      ctx.text(0, y0, prefix, { fg: c.fgDim });
      ctx.text(prefix.length, y0, (e.description || '(no description)').slice(0, W - prefix.length), { fg: c.fg });
      y0++;
    }
  }

  // ── Entry selectors ────────────────────────────────────────────────────
  function todayEntries() {
    return nf.store.entries.peek()
      .filter(e => nf.isSameDay(e.startedAt))
      .sort((a, b) => (b.startedAt?.getTime?.() || 0) - (a.startedAt?.getTime?.() || 0));
  }
  function scopeEntries() {
    const all = nf.store.entries.peek();
    return scope === 'today' ? all.filter(e => nf.isSameDay(e.startedAt)) : all.filter(e => nf.isSameMonth(e.startedAt));
  }

  // ── Public interface ───────────────────────────────────────────────────
  return {
    render(ctx) {
      const c = ctx.theme.peek().colors;
      const W = ctx.width, H = ctx.height;
      if (W <= 0 || H <= 0) return;
      hits = [];
      ctx.rect(0, 0, W, H, { ch: ' ', bg: c.bg, fg: c.fg });

      // Tab bar
      let tx = 0;
      for (let i = 0; i < TABS.length; i++) {
        const label = ' ' + TABS[i] + ' ';
        const active = i === tab;
        ctx.text(tx, 0, label, active ? { fg: c.bg, bg: c.accent, bold: true } : { fg: c.fgDim });
        hits.push({ kind: 'tab', id: i, x: tx, y: 0, w: label.length, h: 1 });
        tx += label.length + 1;
      }
      ctx.text(0, 1, '─'.repeat(W), { fg: c.border });

      // Tab content
      if (tab === 0) renderLog(ctx, c, W, H, 2);
      else if (tab === 1) renderSummary(ctx, c, W, H, 2);
      else renderSettings(ctx, c, W, H, 2);

      // Status bar (bottom row)
      const sy = H - 1;
      ctx.rect(0, sy, W, 1, { ch: ' ', bg: c.bg, fg: c.fgDim });
      const sColor = statusKind === 'error' ? c.error : statusKind === 'success' ? c.success : c.fgDim;
      if (status) ctx.text(0, sy, status.slice(0, W - 10), { fg: sColor });
      const sync = nf.store.loading.peek() ? '…sync'
        : nf.store.lastSync.peek()
          ? new Date(nf.store.lastSync.peek()).toTimeString().slice(0, 5)
          : '—';
      ctx.text(W - sync.length, sy, sync, { fg: c.fgDim });
    },

    onKey(e) {
      if (e.type !== 'down') return;
      const k = e.key;
      // Focus ring. preventDefault so the browser doesn't tab focus out of the
      // grid (engine only preventDefaults arrows + space, not Tab).
      if (k === 'Tab') { e.raw?.preventDefault?.(); moveFocus(e.shift ? -1 : 1); return; }
      const cur = curFocus();

      // Clipboard on a focused text field (Cmd/Ctrl + V/C/X). The grid isn't a
      // native input, so these never reach the browser — handle them ourselves.
      // Use e.code (layout-independent) since Option+letter mangles e.key on mac.
      if (cur.kind === 'field' && (e.ctrl || e.meta) && !e.alt) {
        const f = fields[cur.id];
        if (e.code === 'KeyV') { e.raw?.preventDefault?.(); pasteInto(f); return; }
        if (e.code === 'KeyC') { e.raw?.preventDefault?.(); copyFrom(f); return; }
        if (e.code === 'KeyX') { e.raw?.preventDefault?.(); copyFrom(f); f.value = ''; f.caret = 0; return; }
      }

      // Enter: field-specific advance/submit, or activate a focused button.
      if (k === 'Enter') {
        if (cur.id === 'desc') { focusId('dur'); return; }
        if (cur.id === 'dur') { doLog(); return; }
        if (cur.id === 'email') { focusId('token'); return; }
        if (cur.id === 'token') { doSave(); return; }
        if (cur.kind === 'button') { activateId(cur.id); return; }
        return;
      }
      // Space activates a focused button (fields keep the space char).
      if (k === ' ' && cur.kind === 'button') { activateId(cur.id); return; }

      // Summary list scroll
      if (tab === 1 && (k === 'ArrowDown' || k === 'ArrowUp') && cur.kind === 'button') {
        listScroll = Math.max(0, listScroll + (k === 'ArrowDown' ? 1 : -1));
        return;
      }

      if (cur.kind === 'field') { editField(fields[cur.id], e); return; }
    },

    onMouse(e) {
      if (e.type === 'wheel') {
        listScroll = Math.max(0, listScroll + (e.deltaY > 0 ? 1 : -1));
        return;
      }
      if (e.type !== 'click' && e.type !== 'mousedown') return;
      for (const h of hits) {
        if (e.x >= h.x && e.x < h.x + h.w && e.y >= h.y && e.y < h.y + h.h) {
          if (h.kind === 'tab') { switchTab(h.id); return; }
          if (h.kind === 'field') {
            focusId(h.id);
            const f = fields[h.id];
            f.caret = Math.min(f.value.length, Math.max(0, e.x - h.x - 1));
            return;
          }
          if (h.kind === 'button') { focusId(h.id); activateId(h.id); return; }
        }
      }
    },

    onTouch(e) {
      if (e.type !== 'tap') return;
      this.onMouse({ type: 'click', x: e.x, y: e.y, button: 0 });
    },

    // Right-click (LOCAL coords) → focus the field under the cursor (or fall back
    // to the focused field) and offer clipboard actions. The shell renders the
    // returned { items } through its shared menu surface; null defers to the
    // desktop menu. Lets users paste an API token without a keyboard.
    onContextMenu(e) {
      let target = null;
      for (const h of hits) {
        if (h.kind === 'field' && e.x >= h.x && e.x < h.x + h.w && e.y >= h.y && e.y < h.y + h.h) {
          focusId(h.id); target = fields[h.id]; break;
        }
      }
      if (!target) { const cur = curFocus(); if (cur.kind === 'field') target = fields[cur.id]; }
      if (!target) return null;
      const items = [{ label: 'Paste', hotkey: 'V', onSelect: () => pasteInto(target) }];
      if (!target.secret && target.value) items.push({ label: 'Copy', hotkey: 'C', onSelect: () => copyFrom(target) });
      if (target.value) items.push({ label: 'Clear field', danger: true, onSelect: () => { target.value = ''; target.caret = 0; } });
      return { items };
    },

    destroy() {},
  };
}
