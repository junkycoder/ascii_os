// FakanOS login screen — email + username, magic-link sign-in.
//
// Renders straight into the engine grid (like the shell) and owns its own
// input handlers while active. The flow:
//
//   1. user types email + username, hits [ Send magic link ]
//   2. createLogin POSTs /api/auth/request → server emails a one-time link
//   3. screen flips to a "check your inbox" state
//   4. the user opens the link (web tab or, on iOS, the app via universal link)
//      → index.html / mobile.js extract the token and call login.signIn(token)
//   5. on success onLogin(session.user) fires; the boot flow starts the shell
//
//   const login = createLogin(engine, { onLogin(user){…} });
//   // a token arriving out of band (URL / deeplink):
//   await login.signIn(token);
//   // …later, before booting the shell:
//   login.destroy();
//
// Layout is recomputed every frame from cols/rows and stashed so the mouse /
// touch handlers can hit-test the same tiles the renderer drew.

import * as auth from './auth.js';
import { createKeyboard } from './keyboard.js';
import userPrefs from './user.js';

const FIELD_EMAIL = 0;
const FIELD_NAME = 1;
const FIELD_BTN = 2;
const FIELD_GUEST = 3;
const FIELD_COUNT = 4;

function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim()); }

export function createLogin(engine, opts = {}) {
  const onLogin = opts.onLogin || (() => {});

  let email = '';
  let username = '';
  let focus = FIELD_EMAIL;
  let phase = 'form';          // 'form' | 'sending' | 'sent' | 'verifying'
  let error = '';
  let done = false;
  let layout = null;

  // On-screen keyboard (touch) — without it there's no way to type the email /
  // username on a phone. Shown during the 'form' phase whenever the pref is on.
  // Taller (2-row) keys on touch devices so they're comfortable to tap;
  // desktop/tv keep slim 1-row keys.
  const kbRowHeight = () => {
    const m = engine.mode.peek();
    return (m === 'desktop' || m === 'tv') ? 1 : 2;
  };
  const keyboard = createKeyboard({ rowHeight: kbRowHeight });
  function keyboardEnabled() { try { return !!userPrefs.get('keyboardEnabled'); } catch { return false; } }
  function keyboardVisible() { return !done && phase === 'form' && keyboardEnabled(); }
  function keyboardRows() { return keyboardVisible() ? keyboard.layout(engine.cols.peek()).height + 1 : 0; }

  // ── layout ──────────────────────────────────────────────────────
  function computeLayout() {
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();

    const W = Math.min(cols - 2, Math.max(44, Math.min(54, cols - 4)));
    // Vertical plan inside the panel:
    //   title(1) gap(1) blurb(1) gap(1) email-lbl(1) email(1) gap(1)
    //   name-lbl(1) name(1) gap(1) button(1) gap(1) guest(1) gap(1) hint(1)
    const innerH = 15;
    const H = innerH + 2;

    const px = Math.max(0, Math.floor((cols - W) / 2));
    // Lift the panel above the on-screen keyboard so they never overlap.
    const py = Math.max(0, Math.floor((rows - keyboardRows() - H) / 2));

    const x = px + 3;
    const fieldW = W - 6;
    let y = py + 1;
    const titleY = y; y += 2;
    const blurbY = y; y += 2;
    const emailLblY = y; y += 1;
    const emailY = y; y += 2;
    const nameLblY = y; y += 1;
    const nameY = y; y += 2;
    const btnY = y; y += 2;
    const guestY = y; y += 2;
    const hintY = y;

    return {
      px, py, W, H, titleY, blurbY,
      emailLblY, emailY, nameLblY, nameY,
      x, fieldW,
      btnY, guestY, hintY,
    };
  }

  // ── render ──────────────────────────────────────────────────────
  function render() {
    if (done) return;
    const t = engine.theme.peek();
    const c = t.colors;
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();

    engine.clear();
    engine.rect(0, 0, cols, rows, { ch: ' ', fg: c.fg, bg: c.bg });
    for (let yy = 0; yy < rows; yy += 3) {
      for (let xx = 0; xx < cols; xx += 4) engine.put(xx, yy, '·', { fg: c.border });
    }

    const L = layout = computeLayout();

    engine.rect(L.px, L.py, L.W, L.H, { ch: ' ', fg: c.fg, bg: c.bg });
    engine.box(L.px, L.py, L.W, L.H, { fg: c.border, glyphSet: 'borderDouble' });

    const title = 'F a k a n O S';
    engine.text(L.px + Math.floor((L.W - title.length) / 2), L.titleY, title, { fg: c.accent, bold: true });

    if (phase === 'sent') return renderSent(L, c);
    if (phase === 'verifying') return renderBusy(L, c, 'signing you in…');

    centerText(L, L.blurbY, 'sign in with your email — we\'ll send a magic link', c.fgDim);

    // Email field
    engine.text(L.x, L.emailLblY, 'email', { fg: focus === FIELD_EMAIL ? c.accent : c.fgDim, bold: focus === FIELD_EMAIL });
    drawField(L, L.emailY, email, focus === FIELD_EMAIL, c, 'you@example.com');

    // Username field
    engine.text(L.x, L.nameLblY, 'username', { fg: focus === FIELD_NAME ? c.accent : c.fgDim, bold: focus === FIELD_NAME });
    drawField(L, L.nameY, username, focus === FIELD_NAME, c, 'display name');

    // Button
    const busy = phase === 'sending';
    const label = busy ? '[ sending… ]' : '[ Send magic link ]';
    const bx = L.px + Math.floor((L.W - label.length) / 2);
    engine.text(bx, L.btnY, label, { fg: focus === FIELD_BTN && !busy ? c.bg : c.accent, bg: focus === FIELD_BTN && !busy ? c.accent : undefined, bold: true });
    layout.btn = { x: bx, y: L.btnY, w: label.length };

    drawGuest(L, c);

    if (error) centerText(L, L.hintY, '✗ ' + error, c.error);
    else centerText(L, L.hintY, 'Tab switch · Enter send · type to edit', c.fgDim);

    renderKeyboard();
  }

  // The guest button is shared by the form and the "sent" screen — a no-email,
  // local-only sign-in.
  function drawGuest(L, c) {
    const label = '· continue as guest ·';
    const gx = L.px + Math.floor((L.W - label.length) / 2);
    const foc = focus === FIELD_GUEST;
    engine.text(gx, L.guestY, label, { fg: foc ? c.bg : c.link, bg: foc ? c.link : undefined, bold: foc });
    layout.guestBtn = { x: gx, y: L.guestY, w: label.length };
  }

  function renderSent(L, c) {
    centerText(L, L.blurbY, '✓ link sent', c.success, true);
    centerText(L, L.emailLblY + 1, 'check your inbox at', c.fgDim);
    centerText(L, L.emailY, email, c.fg, true);
    centerText(L, L.nameY, 'open the link to finish signing in', c.fgDim);
    const label = '[ use a different email ]';
    const bx = L.px + Math.floor((L.W - label.length) / 2);
    engine.text(bx, L.btnY, label, { fg: c.link });
    layout.btn = { x: bx, y: L.btnY, w: label.length };
    drawGuest(L, c);
    if (error) centerText(L, L.hintY, '✗ ' + error, c.error);
  }

  function renderBusy(L, c, msg) {
    centerText(L, L.blurbY + 2, msg, c.accent, true);
    layout.btn = null;
  }

  function drawField(L, y, value, active, c, placeholder) {
    const bd = active ? c.borderFocus : c.border;
    engine.text(L.x, y, '[', { fg: bd });
    engine.text(L.x + L.fieldW - 1, y, ']', { fg: bd });
    const inner = L.fieldW - 2;
    const ix = L.x + 1;
    engine.text(ix, y, ' '.repeat(inner), { fg: c.fg });
    if (!value && !active) {
      engine.text(ix, y, placeholder.slice(0, inner), { fg: c.fgDim });
    } else {
      let shown = value;
      if (shown.length > inner - (active ? 1 : 0)) shown = shown.slice(shown.length - (inner - (active ? 1 : 0)));
      engine.text(ix, y, shown, { fg: c.fg });
      if (active) engine.put(ix + Math.min(shown.length, inner - 1), y, '_', { fg: c.accent, bold: true });
    }
  }

  function centerText(L, y, str, fg, bold) {
    const s = str.length > L.W - 2 ? str.slice(0, L.W - 2) : str;
    engine.text(L.px + Math.floor((L.W - s.length) / 2), y, s, { fg, bold });
  }

  // ── on-screen keyboard (render + tap routing) ───────────────────
  function renderKeyboard() {
    if (!keyboardVisible()) return;
    const cols = engine.cols.peek();
    const lay = keyboard.layout(cols);
    const top = engine.rows.peek() - 1 - lay.height; // 1-row comfort gutter below
    if (top < 0) return;
    const c = engine.theme.peek().colors;
    engine.rect(0, top, cols, lay.height, { ch: ' ', bg: c.bg });
    // Key faces fill the row height; with >1 row tall keys we leave the bottom
    // row as background so adjacent rows read as separate keys.
    const rh = lay.rowHeight || 1;
    const faceH = rh > 1 ? rh - 1 : 1;
    for (const row of lay.rows) {
      const ry = top + row.y;
      for (const key of row.keys) {
        const on = key.active;
        const face = on ? c.accent : c.border;
        const fg = on ? c.bg : c.fg;
        engine.rect(key.x, ry, key.w, faceH, { ch: ' ', bg: face });
        const label = String(key.label).slice(0, key.w);
        const lx = key.x + Math.max(0, Math.floor((key.w - label.length) / 2));
        const ly = ry + Math.floor((faceH - 1) / 2);
        engine.text(lx, ly, label, { fg, bg: face, bold: on });
      }
    }
  }
  // A tap/click in the keyboard band → press → feed the synthetic key events
  // straight into onKey (reuses all the field-editing logic). Returns true when
  // the event was inside the band (so the caller stops processing it).
  function handleKeyboardPress(x, y) {
    if (!keyboardVisible()) return false;
    const lay = keyboard.layout(engine.cols.peek());
    const top = engine.rows.peek() - 1 - lay.height;
    if (top < 0 || y < top || y >= top + lay.height) return false;
    const id = keyboard.hitTest(x, y - top);
    if (id) {
      const intent = keyboard.press(id);
      if (intent?.kind === 'key') for (const ev of intent.events) onKey(ev);
      // 'mod' / 'layer' just mutate keyboard state; the next frame re-renders it.
    }
    return true; // swallow taps in the band even on a gap between keys
  }

  // ── actions ─────────────────────────────────────────────────────
  function resetForm() {
    phase = 'form'; error = ''; focus = FIELD_EMAIL;
  }

  async function submit() {
    if (done || phase === 'sending' || phase === 'verifying') return;
    if (phase === 'sent') { resetForm(); return; }
    if (!isEmail(email)) { error = 'enter a valid email'; focus = FIELD_EMAIL; return; }
    if (username.trim().length < 2) { error = 'pick a username (2+ chars)'; focus = FIELD_NAME; return; }
    error = '';
    phase = 'sending';
    try {
      await auth.requestLink({ email, username });
      phase = 'sent';
    } catch (e) {
      phase = 'form';
      error = (e && e.message) || 'could not send link';
    }
  }

  // Exchange a magic-link token for a session (called by index.html / mobile.js
  // when a token arrives via the URL or an iOS deeplink). Resolves to the user
  // on success; surfaces an error on the login screen otherwise.
  async function signIn(token) {
    if (done) return null;
    error = '';
    phase = 'verifying';
    try {
      const session = await auth.verify(token);
      finishLogin(session.user);
      return session.user;
    } catch (e) {
      phase = 'form';
      error = (e && e.message) || 'link expired — request a new one';
      return null;
    }
  }

  function finishLogin(user) {
    done = true;
    try { onLogin(user); } catch (e) { console.error('onLogin', e); }
  }

  // No-email, local-only sign-in. Boots straight into a 'guest' namespace.
  function doGuest() {
    if (done || phase === 'verifying') return;
    const session = auth.signInGuest();
    finishLogin(session.user);
  }

  // ── input ───────────────────────────────────────────────────────
  function focusField() { return focus === FIELD_EMAIL ? 'email' : focus === FIELD_NAME ? 'username' : null; }

  function moveFocus(d) {
    if (phase === 'verifying') return;
    // On the "sent" screen only the [different email] / guest buttons matter.
    if (phase === 'sent') { focus = focus === FIELD_GUEST ? FIELD_BTN : FIELD_GUEST; error = ''; return; }
    focus = (focus + d + FIELD_COUNT) % FIELD_COUNT;
    error = '';
  }

  function onKey(e) {
    if (done || e.type !== 'down') return;
    const k = e.key;
    if (k === 'Tab') { moveFocus(e.shift ? -1 : 1); e.raw?.preventDefault?.(); return; }
    if (k === 'ArrowDown') { moveFocus(1); e.raw?.preventDefault?.(); return; }
    if (k === 'ArrowUp') { moveFocus(-1); e.raw?.preventDefault?.(); return; }
    if (k === 'Enter') {
      e.raw?.preventDefault?.();
      if (focus === FIELD_GUEST) doGuest(); else submit();
      return;
    }
    if (k === 'Backspace') {
      const f = focusField();
      if (f === 'email') email = email.slice(0, -1);
      else if (f === 'username') username = username.slice(0, -1);
      error = '';
      e.raw?.preventDefault?.();
      return;
    }
    // Printable char into the focused field. Allow Alt/Option: on a macOS CZ
    // keyboard '@' is Option+ě (Option+2) — altKey is set but e.key is the
    // resolved symbol, so we must accept it. ctrl/meta stay blocked (shortcuts).
    if (k && k.length === 1 && !e.ctrl && !e.meta) {
      const f = focusField();
      if (f === 'email') email += k;
      else if (f === 'username') username += k;
      error = '';
    }
  }

  function hitField(x, y) {
    if (!layout) return -1;
    if (y === layout.emailY && x >= layout.x && x < layout.x + layout.fieldW) return FIELD_EMAIL;
    if (y === layout.nameY && x >= layout.x && x < layout.x + layout.fieldW) return FIELD_NAME;
    return -1;
  }
  function hitButton(x, y) {
    const b = layout?.btn;
    return b && y === b.y && x >= b.x && x < b.x + b.w;
  }
  function hitGuest(x, y) {
    const b = layout?.guestBtn;
    return b && y === b.y && x >= b.x && x < b.x + b.w;
  }

  function onPointer(x, y) {
    const fi = hitField(x, y);
    if (fi >= 0) { focus = fi; error = ''; return; }
    if (hitGuest(x, y)) { doGuest(); return; }
    if (hitButton(x, y)) submit();
  }

  function onMouse(e) {
    if (done) return;
    if ((e.type === 'mousedown' || e.type === 'click') && handleKeyboardPress(e.x, e.y)) return;
    if (e.type === 'mousedown' || e.type === 'click') onPointer(e.x, e.y);
  }

  function onTouch(e) {
    if (done) return;
    if (e.type === 'tap' && handleKeyboardPress(e.x, e.y)) return;
    if (e.type === 'tap' || e.type === 'doubletap') onPointer(e.x, e.y);
  }

  const offs = [
    engine.onFrame(() => render()),
    engine.onKey(onKey),
    engine.onMouse(onMouse),
    engine.onTouch(onTouch),
  ];

  function destroy() {
    done = true;
    for (const off of offs) { try { off(); } catch {} }
  }

  return { render, destroy, signIn };
}
