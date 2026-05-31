// apps/feedback.js — public feedback board.
//
// Anyone can read the board; only a signed-in account with a verified email
// (i.e. NOT a guest) can post. Posting hits POST /api/feedback with the session
// bearer token; the worker stores the note, strips the contact email from the
// public list, and emails the author a thank-you. Reading hits GET
// /api/feedback/list.
//
// Form fields: category · message · contact (prefilled from the account) ·
// auto-attached context (build host, theme, responsive mode, platform).
// Coords from the WM are LOCAL to the window content area.

import { getSession } from '../auth.js';

const CATEGORIES = ['bug', 'idea', 'praise', 'other'];

// What the worker tags onto a post so we know where it came from. No real
// build version exists (zero-build) — use the serving host as the marker.
function gatherContext(ctx) {
  let theme = '', mode = '', platform = '', version = '';
  try { theme = ctx.theme.peek().name || ''; } catch {}
  try { mode = (globalThis.engine && globalThis.engine.mode && globalThis.engine.mode.peek()) || ''; } catch {}
  try { platform = (navigator.userAgent || '').slice(0, 80); } catch {}
  try { version = location.host || ''; } catch {}
  return { version, theme, mode, platform };
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); return d + 'd ago';
}

function catColor(cat, C) {
  return cat === 'bug' ? C.error
    : cat === 'idea' ? C.accent
    : cat === 'praise' ? C.success
    : C.fgDim;
}

// Greedy word-wrap into lines no wider than `w`.
function wrap(text, w) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) { line = word; }
      else if ((line + ' ' + word).length <= w) { line += ' ' + word; }
      else { out.push(line); line = word; }
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
  }
  return out;
}

export function createApp(initialCtx, win) {
  const session = getSession();
  const me = session && session.user;
  // Guests carry no server token — only a real verified-email account may post.
  const canPost = !!(session && session.token && !session.guest);

  let mode = 'list';          // 'list' | 'compose'
  let items = [];             // public feedback items (newest first)
  let sel = 0;                // selected item index in the list
  let scroll = 0;             // first visible list row
  let status = '';
  let busy = false;
  let loaded = false;

  // Compose form state.
  let cat = 1;                            // index into CATEGORIES (default 'idea')
  let textLines = [''];                   // message buffer
  let tr = 0, tc = 0;                     // caret row/col in the message
  let contact = (me && me.email) || '';   // editable, prefilled
  let field = 'text';                     // 'category' | 'text' | 'contact'

  function setStatus(s) { status = s || ''; }

  // ── network ──────────────────────────────────────────────────────
  async function load() {
    busy = true; setStatus('loading board…');
    try {
      const res = await fetch('/api/feedback/list');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      items = Array.isArray(data.items) ? data.items : [];
      if (sel >= items.length) sel = Math.max(0, items.length - 1);
      setStatus(items.length + ' message' + (items.length === 1 ? '' : 's'));
    } catch (e) {
      setStatus('could not load board: ' + e.message);
    } finally { busy = false; }
  }

  async function submit(ctx) {
    const text = textLines.join('\n').trim();
    if (!text) { setStatus('write a message first'); field = 'text'; return; }
    if (!canPost) { setStatus('sign in with a verified email to post'); return; }
    busy = true; setStatus('sending…');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
        body: JSON.stringify({
          text,
          category: CATEGORIES[cat],
          contact,
          context: gatherContext(ctx),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      // Optimistic: drop the fresh item on top, reset the form, back to the list.
      if (data.item) items.unshift(data.item);
      textLines = ['']; tr = 0; tc = 0;
      mode = 'list'; sel = 0; scroll = 0;
      setStatus('thanks! check your inbox for a confirmation');
      load();
    } catch (e) {
      setStatus('send failed: ' + e.message);
    } finally { busy = false; }
  }

  // ── message editor ops ───────────────────────────────────────────
  function insertChar(ch) {
    const ln = textLines[tr];
    textLines[tr] = ln.slice(0, tc) + ch + ln.slice(tc);
    tc += ch.length;
  }
  function insertNewline() {
    const ln = textLines[tr];
    const tail = ln.slice(tc);
    textLines[tr] = ln.slice(0, tc);
    textLines.splice(tr + 1, 0, tail);
    tr++; tc = 0;
  }
  function backspace() {
    if (tc > 0) {
      const ln = textLines[tr];
      textLines[tr] = ln.slice(0, tc - 1) + ln.slice(tc);
      tc--;
    } else if (tr > 0) {
      const prev = textLines[tr - 1];
      tc = prev.length;
      textLines[tr - 1] = prev + textLines[tr];
      textLines.splice(tr, 1);
      tr--;
    }
  }
  function clampCaret() {
    if (tr < 0) tr = 0;
    if (tr >= textLines.length) tr = textLines.length - 1;
    if (tc > textLines[tr].length) tc = textLines[tr].length;
    if (tc < 0) tc = 0;
  }

  // ── render ───────────────────────────────────────────────────────
  function render(ctx) {
    if (!loaded) { loaded = true; load(); }
    const C = ctx.theme.peek().colors;
    const W = ctx.width, H = ctx.height;
    if (W <= 0 || H <= 0) return;
    ctx.rect(0, 0, W, H, { ch: ' ', bg: C.bg, fg: C.fg });

    ctx.text(0, 0, ' Feedback ', { fg: C.accent, bold: true, bg: C.bg });
    if (mode === 'list') {
      const right = canPost ? '[N] new  [R] refresh' : 'sign in to post';
      ctx.text(Math.max(11, W - right.length), 0, right.slice(0, W), { fg: C.fgDim, bg: C.bg });
      renderList(ctx, C, W, H);
    } else {
      const right = '[Tab] field  [^Enter] send  [Esc] cancel';
      ctx.text(Math.max(11, W - right.length), 0, right.slice(0, W), { fg: C.fgDim, bg: C.bg });
      renderCompose(ctx, C, W, H);
    }

    // Status line.
    const y = H - 1;
    ctx.rect(0, y, W, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });
    if (status) ctx.text(0, y, status.slice(0, W), { fg: busy ? C.warning : C.fgDim, bg: C.bg });
  }

  function renderList(ctx, C, W, H) {
    const top = 2;
    // Reserve a detail pane (4 rows) + status line at the bottom.
    const detailH = 4;
    const listH = Math.max(1, H - top - detailH - 1);

    if (items.length === 0) {
      const msg = busy ? 'loading…' : 'no feedback yet — be the first to post.';
      ctx.text(2, top, msg.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });
    } else {
      if (sel < scroll) scroll = sel;
      else if (sel >= scroll + listH) scroll = sel - listH + 1;
      if (scroll < 0) scroll = 0;

      for (let i = 0; i < listH; i++) {
        const idx = scroll + i;
        if (idx >= items.length) break;
        const it = items[idx];
        const on = idx === sel;
        const yy = top + i;
        if (on) ctx.rect(0, yy, W, 1, { ch: ' ', bg: C.accent, fg: C.bg });
        const badge = '[' + it.category + ']';
        const head = badge + ' ' + (it.name || 'user');
        const time = ago(it.createdAt);
        // one-line preview of the message after the head
        const firstLine = String(it.text || '').split('\n')[0];
        const previewRoom = Math.max(0, W - 2 - head.length - 1 - time.length - 2);
        const preview = previewRoom > 2 ? '  ' + firstLine.slice(0, previewRoom) : '';
        ctx.text(1, yy, badge, { fg: on ? C.bg : catColor(it.category, C), bg: on ? C.accent : C.bg, bold: true });
        ctx.text(1 + badge.length + 1, yy, (it.name || 'user') + preview, { fg: on ? C.bg : C.fg, bg: on ? C.accent : C.bg });
        ctx.text(Math.max(0, W - time.length - 1), yy, time, { fg: on ? C.bg : C.fgDim, bg: on ? C.accent : C.bg });
      }
    }

    // Detail pane — full text + context of the selected item.
    const dTop = H - 1 - detailH;
    ctx.rect(0, dTop, W, 1, { ch: '─', bg: C.bg, fg: C.border });
    const it = items[sel];
    if (it) {
      const lines = wrap(it.text, W - 2).slice(0, detailH - 2);
      for (let i = 0; i < lines.length; i++) {
        ctx.text(1, dTop + 1 + i, lines[i].slice(0, W - 2), { fg: C.fg, bg: C.bg });
      }
      const c = it.context || {};
      const ctxLine = [c.theme, c.mode, c.platform].filter(Boolean).join(' · ');
      if (ctxLine) ctx.text(1, dTop + detailH - 1, ctxLine.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });
    }
  }

  function renderCompose(ctx, C, W, H) {
    if (!canPost) {
      const lines = [
        'You need a signed-in account with a verified email to post.',
        '',
        'Guests can read the board but not post. Log out and sign in',
        'with the email magic-link to share feedback.',
      ];
      let y = 2;
      for (const l of lines) ctx.text(2, y++, l.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });
      return;
    }

    // Category row.
    const onCat = field === 'category';
    ctx.text(2, 2, 'Category:', { fg: onCat ? C.accent : C.fgDim, bg: C.bg, bold: onCat });
    let cx = 12;
    for (let i = 0; i < CATEGORIES.length; i++) {
      const name = CATEGORIES[i];
      const picked = i === cat;
      const label = picked ? '[' + name + ']' : ' ' + name + ' ';
      ctx.text(cx, 2, label, {
        fg: picked ? catColor(name, C) : C.fgDim,
        bg: C.bg,
        bold: picked,
      });
      cx += label.length + 1;
    }
    if (onCat) ctx.text(2, 3, '←/→ to change'.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });

    // Message editor.
    const onText = field === 'text';
    ctx.text(2, 5, 'Message:', { fg: onText ? C.accent : C.fgDim, bg: C.bg, bold: onText });
    const edTop = 6;
    const edH = Math.max(1, H - edTop - 4);
    ctx.box(1, edTop - 1, W - 2, edH + 2, {
      fg: onText ? C.borderFocus : C.border, bg: C.bg, glyphSet: 'border',
    });
    for (let i = 0; i < edH; i++) {
      const ln = textLines[i];
      if (ln === undefined) break;
      ctx.text(2, edTop + i, ln.slice(0, W - 4), { fg: C.fg, bg: C.bg });
    }
    if (onText && tr < edH) {
      const cxp = Math.min(tc, W - 5);
      const under = (textLines[tr] || '')[tc] || ' ';
      ctx.put(2 + cxp, edTop + tr, under, { fg: C.bg, bg: C.accent });
    }

    // Contact row (one line above the status line).
    const onContact = field === 'contact';
    const cy = H - 2;
    ctx.text(2, cy, 'Reply to:', { fg: onContact ? C.accent : C.fgDim, bg: C.bg, bold: onContact });
    const cval = contact || '(none)';
    ctx.text(12, cy, cval.slice(0, W - 13), { fg: contact ? C.fg : C.fgDim, bg: C.bg });
    if (onContact) ctx.put(Math.min(12 + contact.length, W - 2), cy, '_', { fg: C.accent, bg: C.bg });
  }

  // ── input ────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.type !== 'down') return;
    const k = e.key;

    if (mode === 'list') {
      if (e.code === 'KeyN' && canPost) { mode = 'compose'; field = 'text'; setStatus(''); return; }
      if (e.code === 'KeyR') { load(); return; }
      if (k === 'ArrowUp') { if (sel > 0) sel--; return; }
      if (k === 'ArrowDown') { if (sel < items.length - 1) sel++; return; }
      if (k === 'PageUp') { sel = Math.max(0, sel - 5); return; }
      if (k === 'PageDown') { sel = Math.min(items.length - 1, sel + 5); return; }
      return;
    }

    // compose mode
    if (k === 'Escape') { mode = 'list'; setStatus(''); return; }
    // Ctrl/Cmd+Enter sends from any field.
    if (k === 'Enter' && (e.ctrl || e.meta)) { submit(initialCtx); return; }
    if (k === 'Tab') {
      const order = ['category', 'text', 'contact'];
      const i = order.indexOf(field);
      field = order[(i + (e.shift ? order.length - 1 : 1)) % order.length];
      return;
    }
    if (!canPost) return;

    if (field === 'category') {
      if (k === 'ArrowLeft') { cat = (cat + CATEGORIES.length - 1) % CATEGORIES.length; return; }
      if (k === 'ArrowRight') { cat = (cat + 1) % CATEGORIES.length; return; }
      return;
    }

    if (field === 'contact') {
      if (k === 'Backspace') { contact = contact.slice(0, -1); return; }
      if (!e.ctrl && !e.meta && typeof k === 'string' && k.length === 1) contact += k;
      return;
    }

    // field === 'text' — message editor
    if (k === 'ArrowLeft') { if (tc > 0) tc--; else if (tr > 0) { tr--; tc = textLines[tr].length; } return; }
    if (k === 'ArrowRight') { if (tc < textLines[tr].length) tc++; else if (tr < textLines.length - 1) { tr++; tc = 0; } return; }
    if (k === 'ArrowUp') { if (tr > 0) { tr--; clampCaret(); } return; }
    if (k === 'ArrowDown') { if (tr < textLines.length - 1) { tr++; clampCaret(); } return; }
    if (k === 'Home') { tc = 0; return; }
    if (k === 'End') { tc = textLines[tr].length; return; }
    if (k === 'Enter') { insertNewline(); return; }
    if (k === 'Backspace') { backspace(); return; }
    if (!e.ctrl && !e.meta && typeof k === 'string' && k.length === 1) insertChar(k);
  }

  function onMouse(e) {
    if (e.type !== 'click' && e.type !== 'dblclick') return;
    if (mode !== 'list') return;
    const idx = scroll + (e.y - 2);
    if (idx >= 0 && idx < items.length) sel = idx;
  }

  function onTouch(e) {
    if (e.type === 'tap') onMouse({ type: 'click', x: e.x, y: e.y });
  }

  function destroy() {}

  return { render, onKey, onMouse, onTouch, destroy };
}
