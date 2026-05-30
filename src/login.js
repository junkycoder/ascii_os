// acii_os login screen — pick an account, enter a password, or create one.
//
// Renders straight into the engine grid (like the shell) and owns its own
// input handlers while active. Call onLogin(user) fires once on success; the
// boot flow then tears the login down and starts the shell for that user.
//
//   const login = createLogin(engine, { onLogin(user){…} });
//   // …later, before booting the shell:
//   login.destroy();
//
// Layout is recomputed every frame from cols/rows and stashed so the mouse /
// touch handlers can hit-test the same tiles the renderer drew.

import * as users from './users.js';

const TILE_W = 10;
const TILE_BOX_H = 4;
const SLOT_W = TILE_W + 2;   // tile + 1-cell gutter each side overlap
const SLOT_H = TILE_BOX_H + 2; // box + label row + gap

export function createLogin(engine, opts = {}) {
  const onLogin = opts.onLogin || (() => {});

  let people = users.list();          // [{id,name,glyph,color,hasPassword}]
  let sel = pickInitial();            // index into tiles (people.length == "new")
  let password = '';
  let error = '';
  let done = false;
  let layout = null;                  // last computed layout for hit-testing

  function tiles() { return people.length + 1; }   // +1 for the "new" tile
  function isNewTile(i) { return i === people.length; }
  function selUser() { return isNewTile(sel) ? null : people[sel]; }

  function pickInitial() {
    // Prefer the last session's user if it is still around.
    const s = users.getSession();
    if (s) {
      const i = people.findIndex(u => u.id === s.id);
      if (i >= 0) return i;
    }
    return people.length ? 0 : 0;
  }

  function refresh() { people = users.list(); }

  // ── layout ──────────────────────────────────────────────────────
  function computeLayout() {
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();
    const list = tiles();

    const panelW = Math.min(cols - 2, Math.max(40, 12 + 4));
    const innerW = Math.min(cols - 2, Math.max(panelW, 42));
    const W = Math.min(cols - 2, Math.max(44, innerW));
    const perRow = Math.max(1, Math.floor((W - 2) / SLOT_W));
    const tileRows = Math.max(1, Math.ceil(list / perRow));

    const selHasPw = !isNewTile(sel) && people[sel] && people[sel].hasPassword;

    // Vertical content plan (rows inside the panel):
    //   title(1) gap(1) [tiles] gap(1) pw(1) gap(1) button(1) gap(1) hint(1)
    const tilesH = tileRows * SLOT_H;
    const innerH = 1 + 1 + tilesH + 1 + 1 + 1 + 1 + 1 + 1;
    const H = innerH + 2; // borders

    const px = Math.max(0, Math.floor((cols - W) / 2));
    const py = Math.max(0, Math.floor((rows - H) / 2));

    // Tile grid origin, centered horizontally inside the panel.
    const gridW = perRow * SLOT_W;
    const gx = px + Math.max(1, Math.floor((W - gridW) / 2));
    const titleY = py + 1;
    const gy = titleY + 2;

    const tileRects = [];
    for (let i = 0; i < list; i++) {
      const r = Math.floor(i / perRow);
      const cInRow = i % perRow;
      // center the (possibly short) last row
      const inThisRow = Math.min(perRow, list - r * perRow);
      const rowW = inThisRow * SLOT_W;
      const rowX = px + Math.max(1, Math.floor((W - rowW) / 2));
      const x = rowX + cInRow * SLOT_W + 1;
      const y = gy + r * SLOT_H;
      tileRects.push({ x, y, w: TILE_W, h: TILE_BOX_H + 1, index: i });
    }

    const pwY = gy + tilesH + 1;
    const btnY = pwY + 2;
    const hintY = btnY + 2;

    const btnLabel = isNewTile(sel) ? '[ Create account ]'
      : (selHasPw ? '[ Unlock ]' : '[ Log in ]');
    const btnX = px + Math.max(1, Math.floor((W - btnLabel.length) / 2));

    return {
      px, py, W, H, titleY,
      tiles: tileRects,
      pwY, pwX: px + 2, pwW: W - 4, selHasPw,
      btn: { x: btnX, y: btnY, w: btnLabel.length, label: btnLabel },
      hintY,
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
    // Dim backdrop fill.
    engine.rect(0, 0, cols, rows, { ch: ' ', fg: c.fg, bg: c.bg });
    // Faint pattern so it doesn't read as a flat void.
    for (let y = 0; y < rows; y += 3) {
      for (let x = 0; x < cols; x += 4) engine.put(x, y, '·', { fg: c.border });
    }

    const L = layout = computeLayout();

    // Panel
    engine.rect(L.px, L.py, L.W, L.H, { ch: ' ', fg: c.fg, bg: c.bg });
    engine.box(L.px, L.py, L.W, L.H, { fg: c.border, glyphSet: 'borderDouble' });

    // Title
    const title = 'a c i i _ o s';
    engine.text(L.px + Math.floor((L.W - title.length) / 2), L.titleY, title,
      { fg: c.accent, bold: true });

    // Tiles
    for (const r of L.tiles) {
      const isSel = r.index === sel;
      const isNew = isNewTile(r.index);
      const u = isNew ? null : people[r.index];
      const bd = isSel ? c.borderFocus : c.border;
      const face = isSel ? c.bg : c.bg;
      drawTile(r.x, r.y, isNew ? '+' : (u.glyph || '☺'),
        isNew ? c.fgDim : (c[u.color] || c.accent), bd, face, isSel);
      const label = isNew ? 'new' : (u.name || u.id);
      const lbl = label.length > TILE_W ? label.slice(0, TILE_W - 1) + '…' : label;
      const lx = r.x + Math.max(0, Math.floor((TILE_W - lbl.length) / 2));
      engine.text(lx, r.y + TILE_BOX_H, lbl, { fg: isSel ? c.fg : c.fgDim, bold: isSel });
      if (u && u.hasPassword) engine.put(r.x + TILE_W - 1, r.y, '🔒', { fg: c.fgDim });
    }

    // Password / status row
    const u = selUser();
    if (isNewTile(sel)) {
      centerText(L, L.pwY, 'create a new account', c.fgDim);
    } else if (L.selHasPw) {
      const masked = '•'.repeat(Math.min(password.length, L.pwW - 12));
      const field = 'password: ' + (masked || '_');
      engine.text(L.pwX, L.pwY, field.slice(0, L.pwW), { fg: c.fg });
    } else {
      centerText(L, L.pwY, 'no password — press Enter', c.fgDim);
    }

    // Error (overrides hint colour line just below pw if present)
    // Button
    const onBtn = false;
    engine.text(L.btn.x, L.btn.y, L.btn.label, { fg: c.accent, bold: true });

    // Hint / error
    if (error) {
      centerText(L, L.hintY, '✗ ' + error, c.error);
    } else {
      const hint = '←→ select · Enter confirm · type password · Del removes';
      centerText(L, L.hintY, hint.slice(0, L.W - 2), c.fgDim);
    }
  }

  function centerText(L, y, str, fg, bold) {
    const s = str.length > L.W - 2 ? str.slice(0, L.W - 2) : str;
    engine.text(L.px + Math.floor((L.W - s.length) / 2), y, s, { fg, bold });
  }

  function drawTile(x, y, glyph, glyphFg, borderFg, faceBg, sel) {
    const g = engine.theme.peek().glyphs[sel ? 'borderRound' : 'border'];
    const inner = TILE_W - 2;
    engine.text(x, y, g.tl + g.h.repeat(inner) + g.tr, { fg: borderFg, bold: sel });
    for (let r = 1; r < TILE_BOX_H - 1; r++) {
      engine.put(x, y + r, g.v, { fg: borderFg });
      engine.text(x + 1, y + r, ' '.repeat(inner), { fg: borderFg, bg: faceBg });
      engine.put(x + TILE_W - 1, y + r, g.v, { fg: borderFg });
    }
    engine.text(x, y + TILE_BOX_H - 1, g.bl + g.h.repeat(inner) + g.br, { fg: borderFg, bold: sel });
    const gx = x + Math.floor((TILE_W - 1) / 2);
    const gy = y + Math.floor(TILE_BOX_H / 2);
    engine.put(gx, gy, glyph, { fg: glyphFg, bg: faceBg, bold: true });
  }

  // ── actions ─────────────────────────────────────────────────────
  function moveSel(d) {
    const n = tiles();
    sel = (sel + d + n) % n;
    password = '';
    error = '';
  }

  function submit() {
    if (done) return;
    if (isNewTile(sel)) { createFlow(); return; }
    const u = people[sel];
    if (!u) return;
    if (u.hasPassword && !users.verify(u.id, password)) {
      error = 'wrong password';
      password = '';
      return;
    }
    finishLogin(u);
  }

  function finishLogin(u) {
    done = true;
    users.setSession(u.id);
    try { onLogin(u); } catch (e) { console.error('onLogin', e); }
  }

  function createFlow() {
    const name = window.prompt('Jméno nového uživatele:', '');
    if (name == null) return;
    const trimmed = String(name).trim();
    if (!trimmed) return;
    const pw = window.prompt('Heslo (nech prázdné pro účet bez hesla):', '');
    if (pw == null) return; // cancelled
    const created = users.create({ name: trimmed, password: pw || null });
    refresh();
    const i = people.findIndex(p => p.id === created.id);
    sel = i >= 0 ? i : 0;
    password = '';
    error = '';
  }

  function deleteFlow() {
    if (isNewTile(sel)) return;
    const u = people[sel];
    if (!u) return;
    if (users.count() <= 1) { error = 'cannot remove the last account'; return; }
    const ok = window.confirm(`Opravdu smazat uživatele "${u.name}" včetně jeho dat?`);
    if (!ok) return;
    users.remove(u.id);
    refresh();
    sel = Math.min(sel, people.length); // clamp (stay valid, may land on "new")
    if (sel > people.length) sel = people.length;
    if (sel >= tiles()) sel = 0;
    password = '';
    error = '';
  }

  // ── input ───────────────────────────────────────────────────────
  function onKey(e) {
    if (done || e.type !== 'down') return;
    const k = e.key;
    if (k === 'ArrowLeft') { moveSel(-1); e.raw?.preventDefault?.(); return; }
    if (k === 'ArrowRight' || k === 'Tab') {
      moveSel(k === 'Tab' && e.shift ? -1 : 1); e.raw?.preventDefault?.(); return;
    }
    if (k === 'ArrowUp') { moveSel(-1); e.raw?.preventDefault?.(); return; }
    if (k === 'ArrowDown') { moveSel(1); e.raw?.preventDefault?.(); return; }
    if (k === 'Enter') { e.raw?.preventDefault?.(); submit(); return; }
    if (k === 'Delete') { e.raw?.preventDefault?.(); deleteFlow(); return; }
    if (k === 'Backspace') {
      if (!isNewTile(sel) && people[sel]?.hasPassword) {
        password = password.slice(0, -1); error = '';
      }
      e.raw?.preventDefault?.();
      return;
    }
    // Typed password char (printable, no modifiers).
    if (k && k.length === 1 && !e.ctrl && !e.meta && !e.alt) {
      if (!isNewTile(sel) && people[sel]?.hasPassword) {
        password += k; error = '';
      }
    }
  }

  function hitTile(x, y) {
    if (!layout) return -1;
    for (const r of layout.tiles) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.index;
    }
    return -1;
  }
  function hitButton(x, y) {
    const b = layout?.btn;
    return b && y === b.y && x >= b.x && x < b.x + b.w;
  }

  function onMouse(e) {
    if (done) return;
    if (e.type === 'mousedown' || e.type === 'click') {
      const ti = hitTile(e.x, e.y);
      if (ti >= 0) {
        if (ti === sel && e.type === 'click') { submit(); return; }
        sel = ti; password = ''; error = '';
        return;
      }
      if (hitButton(e.x, e.y)) { submit(); return; }
    }
    if (e.type === 'dblclick') {
      const ti = hitTile(e.x, e.y);
      if (ti >= 0) { sel = ti; submit(); }
    }
  }

  function onTouch(e) {
    if (done) return;
    if (e.type === 'tap' || e.type === 'doubletap') {
      const ti = hitTile(e.x, e.y);
      if (ti >= 0) {
        if (ti === sel || e.type === 'doubletap') { sel = ti; submit(); }
        else { sel = ti; password = ''; error = ''; }
        return;
      }
      if (hitButton(e.x, e.y)) submit();
    }
  }

  // Wire engine handlers; keep the unsubscribers for destroy().
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

  return { render, destroy };
}
