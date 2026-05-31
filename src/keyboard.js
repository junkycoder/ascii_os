// FakanOS on-screen keyboard — a pure-logic touch keyboard engine.
//
// Renders NOTHING and imports no engine/DOM (like vim.js / keymap.js). It owns
// the layouts, the sticky-modifier + layer state, geometry for a given grid
// width, hit-testing, and turns a key press into an INTENT the shell executes:
// synthetic key events ({ type, key, code, ctrl, shift, alt, meta }) to feed the
// focused app's onKey, a layer switch, a modifier toggle, or a hide request.
//
// See KEYBOARD.md for the full spec. The shell (host) draws the layout returned
// by layout(cols) into the bottom strip of the grid and routes touch/mouse in
// that region through hitTest() + press().
//
// Public API:
//   const kb = createKeyboard()
//   kb.layout(cols)        -> { cols, rowHeight, height, rows:[{ y, keys:[…] }] }
//                             (also cached for hitTest)
//   kb.hitTest(x, y)       -> keyId | null      (local coords inside the panel)
//   kb.press(keyId)        -> intent | null     (see INTENTS below)
//   kb.state()             -> { layer, mods, pressedId }
//   kb.reset()
//
// INTENTS returned by press():
//   { kind:'key',   events:[downEvt, upEvt], repeatable }   // send to focused app
//   { kind:'mod' }                                          // a modifier toggled
//   { kind:'layer', layer }                                 // active layer changed
//   { kind:'hide' }                                         // user tapped ▾
//   null                                                    // unknown key id

// ── Key codes for the symbol keys (best-effort physical codes) ──────
// Letters/digits get derived codes (KeyA / Digit1). Other glyphs map here so a
// keyboard press can still drive code-based shortcuts; apps that read e.key are
// covered regardless. Unknown glyphs fall back to '' (key-only matching).
const SYMBOL_CODE = {
  '-': 'Minus', '=': 'Equal', '/': 'Slash', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period',
  '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote',
};

// Digit row 1..0 with their shifted symbols (only used if a digit is shifted).
const DIGIT_SHIFT = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
                      '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' };

// A char key: id = `c:<base>`. `base` is the unshifted glyph.
const ch = (base, units = 1) => ({ id: 'c:' + base, base, kind: 'char', units });
// A special (named) key.
const sp = (id, label, key, code, units = 1, opts = {}) =>
  ({ id, label, kind: 'special', key, code, units, ...opts });
// A sticky modifier key.
const mod = (which, label, units = 1) => ({ id: 'm:' + which, which, label, kind: 'mod', units });
// A layer switch.
const lyr = (target, label, units = 1) => ({ id: 'l:' + target, target, label, kind: 'layer', units });

// ── Layouts ─────────────────────────────────────────────────────────
// Each layer is an array of rows; each row is an array of key descriptors.
// `units` is the relative width weight used by layout() to fill the grid.
const SPACE = sp('sp:space', '␣', ' ', 'Space', 5);
const BKSP  = sp('sp:bksp', '⌫', 'Backspace', 'Backspace', 2, { repeatable: true });
const ENTER = sp('sp:enter', '⏎', 'Enter', 'Enter', 2);

const LAYERS = {
  letters: [
    'qwertyuiop'.split('').map(c => ch(c)),
    'asdfghjkl'.split('').map(c => ch(c)),
    [mod('shift', '⇧', 2), ...'zxcvbnm'.split('').map(c => ch(c)), BKSP],
    [lyr('symbols', '123', 2), lyr('ctrl', '^', 1), SPACE, ch('.'), ENTER],
  ],
  symbols: [
    '1234567890'.split('').map(c => ch(c)),
    '-_/:;()$&@"'.split('').map(c => ch(c)),
    [lyr('ctrl', '^', 2), ...".,?!'".split('').map(c => ch(c)), BKSP],
    [lyr('letters', 'ABC', 2), SPACE, ENTER],
  ],
  // Modifier / navigation layer for Terminal + vim (Findman).
  ctrl: [
    [sp('sp:esc', 'Esc', 'Escape', 'Escape', 2), sp('sp:tab', '⇥', 'Tab', 'Tab', 2),
     mod('ctrl', 'Ctrl', 2), mod('alt', 'Alt', 2)],
    [sp('sp:left', '←', 'ArrowLeft', 'ArrowLeft', 1, { repeatable: true }),
     sp('sp:down', '↓', 'ArrowDown', 'ArrowDown', 1, { repeatable: true }),
     sp('sp:up', '↑', 'ArrowUp', 'ArrowUp', 1, { repeatable: true }),
     sp('sp:right', '→', 'ArrowRight', 'ArrowRight', 1, { repeatable: true }),
     BKSP, ENTER],
    [lyr('letters', 'ABC', 2), SPACE],
  ],
};

// Sticky modifier cycle: off → once → lock → off.
const NEXT_STICKY = { off: 'once', once: 'lock', lock: 'off' };

export function createKeyboard(opts = {}) {
  let layer = 'letters';
  const mods = { shift: 'off', ctrl: 'off', alt: 'off' };
  let pressedId = null;        // last-pressed key id (for a brief highlight)
  let pressedAt = 0;
  const lastTap = { shift: 0, ctrl: 0, alt: 0 }; // for double-tap → lock detection
  const DBL_MS = 300;

  // Cached geometry from the most recent layout() call (used by hitTest()).
  let cache = { cols: 0, rowHeight: 1, height: 0, rows: [] };

  const now = () => (typeof Date !== 'undefined' && Date.now ? Date.now() : 0);

  // ── Geometry ──────────────────────────────────────────────────────
  // Lay the active layer's rows across `cols`, filling the full width. Keys are
  // `rowHeight` rows tall (default 1). Returns positioned key rects and caches
  // them for hitTest(). `y` is row-relative to the panel top.
  function layout(cols) {
    const rowHeight = Math.max(1, opts.rowHeight || 1);
    const gap = cols >= 30 ? 1 : 0; // 1-cell gaps when there's room
    const def = LAYERS[layer] || LAYERS.letters;
    const rows = [];
    def.forEach((rowDef, ri) => {
      const totalUnits = rowDef.reduce((s, k) => s + (k.units || 1), 0);
      const gaps = (rowDef.length - 1) * gap;
      const usable = Math.max(0, cols - gaps);
      const unit = usable / totalUnits;
      const keys = [];
      let cx = 0;
      rowDef.forEach((k, ki) => {
        const last = ki === rowDef.length - 1;
        const w = last ? Math.max(1, cols - cx)
                       : Math.max(1, Math.round((k.units || 1) * unit));
        keys.push({
          id: k.id,
          x: cx,
          w: Math.min(w, cols - cx),
          label: keyLabel(k),
          kind: k.kind,
          active: keyActive(k),
        });
        cx += w + gap;
      });
      rows.push({ y: ri * rowHeight, keys });
    });
    cache = { cols, rowHeight, height: def.length * rowHeight, rows };
    return cache;
  }

  // Display label for a key in the current state (shift affects letters).
  function keyLabel(k) {
    if (k.kind === 'char') {
      if (/^[a-z]$/.test(k.base)) {
        return (mods.shift !== 'off') ? k.base.toUpperCase() : k.base;
      }
      return k.base;
    }
    return k.label;
  }

  // Highlight flag: pressed char, armed/locked modifiers, the active-layer chip.
  function keyActive(k) {
    if (k.kind === 'mod') return mods[k.which] !== 'off';
    if (k.id === pressedId) return true;
    return false;
  }

  // ── Hit testing ───────────────────────────────────────────────────
  function hitTest(x, y) {
    if (y < 0 || y >= cache.height) return null;
    const rh = cache.rowHeight || 1;
    const row = cache.rows[Math.floor(y / rh)];
    if (!row) return null;
    for (const k of row.keys) {
      if (x >= k.x && x < k.x + k.w) return k.id;
    }
    return null;
  }

  // ── Press → intent ────────────────────────────────────────────────
  function findKey(id) {
    for (const rowDef of (LAYERS[layer] || [])) {
      for (const k of rowDef) if (k.id === id) return k;
    }
    return null;
  }

  function press(id) {
    const k = findKey(id);
    if (!k) return null;

    if (k.kind === 'layer') {
      layer = k.target;
      pressedId = null;
      return { kind: 'layer', layer };
    }
    if (k.kind === 'mod') {
      cycleMod(k.which);
      return { kind: 'mod' };
    }

    // A character or special key → emit a down+up pair with current modifiers.
    pressedId = id;
    pressedAt = now();
    const events = buildEvents(k);
    consumeOneShotMods();
    return { kind: 'key', events, repeatable: !!k.repeatable };
  }

  function cycleMod(which) {
    const t = now();
    const isDbl = t - lastTap[which] < DBL_MS;
    lastTap[which] = t;
    // Double-tap from any state → lock; otherwise advance off→once→lock→off.
    mods[which] = isDbl ? 'lock' : NEXT_STICKY[mods[which]];
    pressedId = null;
  }

  // After a real key, drop one-shot ('once') modifiers; keep locked ones.
  function consumeOneShotMods() {
    for (const m of Object.keys(mods)) if (mods[m] === 'once') mods[m] = 'off';
  }

  function activeMods() {
    return {
      shift: mods.shift !== 'off',
      ctrl: mods.ctrl !== 'off',
      alt: mods.alt !== 'off',
      meta: false,
    };
  }

  // Build the [down, up] event pair for a char/special key.
  function buildEvents(k) {
    const m = activeMods();
    let key, code;
    if (k.kind === 'special') {
      key = k.key; code = k.code;
    } else { // char
      const base = k.base;
      if (/^[a-z]$/.test(base)) {
        code = 'Key' + base.toUpperCase();
        key = m.shift ? base.toUpperCase() : base;
      } else if (/^[0-9]$/.test(base)) {
        code = 'Digit' + base;
        key = m.shift ? (DIGIT_SHIFT[base] || base) : base;
      } else {
        code = SYMBOL_CODE[base] || '';
        key = base;
      }
    }
    const base = { key, code, ctrl: m.ctrl, shift: m.shift, alt: m.alt, meta: m.meta };
    return [{ type: 'down', ...base }, { type: 'up', ...base }];
  }

  // ── Introspection ─────────────────────────────────────────────────
  function state() {
    return { layer, mods: { ...mods }, pressedId };
  }
  function reset() {
    layer = 'letters';
    mods.shift = mods.ctrl = mods.alt = 'off';
    pressedId = null;
  }
  // Let the host clear the transient pressed-key highlight after a tick.
  function clearPressed() { pressedId = null; }

  return { layout, hitTest, press, state, reset, clearPressed,
           get layer() { return layer; } };
}
