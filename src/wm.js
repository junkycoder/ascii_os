// wm.js — Window Manager for the acii_os engine.
//
// Manages a stack of overlapping windows with drag, resize, focus chain,
// maximize, close, and full mouse + touch + keyboard interaction.
//
// Usage:
//   import { createWindowManager } from './wm.js'
//   const wm = createWindowManager(engine)
//   const win = wm.addWindow({ title: 'hello', x: 4, y: 2, w: 30, h: 12,
//                              body: (ctx, win) => ctx.text(0, 0, 'hi') })
//   engine.onFrame(() => { engine.clear(); wm.render() })
//
// The WM owns all chrome (border, title bar, buttons) and clips the body to
// the inner rect via engine.subContext. Apps just draw into ctx in local coords.

import { signal, computed, effect } from './signals.js';

const MIN_W = 10;
const MIN_H = 4;

let _autoId = 0;

export function createWindowManager(engine, opts = {}) {
  // ── State ────────────────────────────────────────────────────────
  // Windows are stored in z-order: index 0 = bottom, last = top.
  // The top of the array is the focused window (when any are focusable).
  const windows = signal([]);
  const focused = signal(null);

  // Drag / resize state lives outside any window so it survives focus changes.
  // mode: null | 'drag' | 'resize'
  let drag = null;
  // drag shape when active: { win, mode, grabDX, grabDY, startW, startH }

  // ── Window factory ───────────────────────────────────────────────
  function addWindow(spec = {}) {
    const id = spec.id || `win-${++_autoId}`;
    const title = signal(spec.title ?? 'untitled');
    const x = signal(spec.x ?? 2);
    const y = signal(spec.y ?? 1);
    const w = signal(Math.max(MIN_W, spec.w ?? 30));
    const h = signal(Math.max(MIN_H, spec.h ?? 10));
    const maximized = signal(!!spec.maximized);
    const minimized = signal(!!spec.minimized);
    // Saved geometry for restore-after-maximize.
    let savedGeom = null;

    const win = {
      id,
      title, x, y, w, h, maximized, minimized,
      body: spec.body || (() => {}),
      onClose: spec.onClose || null,
      resizable: spec.resizable !== false,
      closable: spec.closable !== false,
      maximizable: spec.maximizable !== false,
      minimizable: spec.minimizable !== false,
      focusable: spec.focusable !== false,

      // computed lazily below so we can reference `win`
      focused: null,

      close() { removeWindow(win); },
      setTitle(s) { title.value = String(s); },
      focus() { bringToFront(win); },
      toggleMaximize() { toggleMaximize(win); },
      minimize() { minimize(win); },
      restore() { restoreWindow(win); },
    };

    win.focused = computed(() => focused.value === win);

    // Helpers attached to win so handlers can access without closure soup.
    win._saveGeom = () => {
      savedGeom = { x: x.peek(), y: y.peek(), w: w.peek(), h: h.peek() };
    };
    win._restoreGeom = () => {
      if (!savedGeom) return;
      x.value = savedGeom.x;
      y.value = savedGeom.y;
      w.value = savedGeom.w;
      h.value = savedGeom.h;
      savedGeom = null;
    };
    win._fitToScreen = () => {
      // After maximize, follow engine size.
      x.value = 0;
      y.value = 0;
      w.value = engine.cols.peek();
      h.value = engine.rows.peek();
    };

    // Insert at the top of the stack and focus.
    const list = windows.peek().slice();
    list.push(win);
    windows.value = list;
    if (win.focusable && !win.minimized.peek()) focused.value = win;

    return win;
  }

  function removeWindow(target) {
    const win = resolveWin(target);
    if (!win) return;
    try { win.onClose?.(win); } catch (e) { /* swallow — close is best-effort */ }
    const list = windows.peek().filter((w) => w !== win);
    windows.value = list;
    if (focused.peek() === win) {
      // Refocus next-top focusable, non-minimized window if any.
      const next = [...list].reverse()
        .find((w) => w.focusable && !w.minimized.peek()) || null;
      focused.value = next;
    }
  }

  function resolveWin(t) {
    if (!t) return null;
    if (typeof t === 'string') return windows.peek().find((w) => w.id === t) || null;
    return t;
  }

  function bringToFront(target) {
    const win = resolveWin(target);
    if (!win) return;
    // Bringing a window forward implicitly un-minimizes it.
    if (win.minimized.peek()) win.minimized.value = false;
    const list = windows.peek();
    if (list[list.length - 1] === win) {
      // Already top — just make sure focus is set.
      if (win.focusable) focused.value = win;
      return;
    }
    const next = list.filter((w) => w !== win);
    next.push(win);
    windows.value = next;
    if (win.focusable) focused.value = win;
  }

  // ── Minimize / restore ───────────────────────────────────────────
  // Minimize hides a window without destroying state: it's skipped by render,
  // hit-testing and focus cycling, but remains in `windows` so the taskbar can
  // still list it and offer a restore. Restore un-hides + raises + focuses.
  function minimize(target) {
    const win = resolveWin(target);
    if (!win || !win.minimizable) return;
    if (win.minimized.peek()) return;
    win.minimized.value = true;
    // If it was focused, hand focus to the next visible focusable window.
    if (focused.peek() === win) {
      const next = [...windows.peek()].reverse()
        .find((w) => w.focusable && !w.minimized.peek()) || null;
      focused.value = next;
    }
  }

  function restoreWindow(target) {
    const win = resolveWin(target);
    if (!win) return;
    // bringToFront clears the minimized flag and raises + focuses.
    bringToFront(win);
  }

  function isMinimized(target) {
    const win = resolveWin(target);
    return !!(win && win.minimized.peek());
  }

  // Taskbar chip toggle: minimize a visible/focused window, restore a hidden
  // one. A visible-but-unfocused window is raised+focused first (one click to
  // foreground, a second to minimize), matching common desktop behaviour.
  function toggleMinimize(target) {
    const win = resolveWin(target);
    if (!win) return;
    if (win.minimized.peek()) { restoreWindow(win); return; }
    if (focused.peek() === win) { minimize(win); return; }
    bringToFront(win);
  }

  function focusNext() { cycleFocus(1); }
  function focusPrev() { cycleFocus(-1); }

  function cycleFocus(dir) {
    // Alt+Tab skips minimized windows entirely.
    const list = windows.peek().filter((w) => w.focusable && !w.minimized.peek());
    if (list.length === 0) { focused.value = null; return; }
    const cur = focused.peek();
    let idx = cur ? list.indexOf(cur) : -1;
    idx = ((idx + dir) % list.length + list.length) % list.length;
    bringToFront(list[idx]);
  }

  function toggleMaximize(target) {
    const win = resolveWin(target);
    if (!win || !win.maximizable) return;
    if (win.maximized.peek()) {
      win.maximized.value = false;
      win._restoreGeom();
    } else {
      win._saveGeom();
      win.maximized.value = true;
      win._fitToScreen();
    }
  }

  // If engine resizes while a window is maximized, follow.
  effect(() => {
    const c = engine.cols.value, r = engine.rows.value;
    for (const win of windows.peek()) {
      if (win.maximized.peek() && !win.minimized.peek()) {
        win.x.value = 0; win.y.value = 0;
        win.w.value = c; win.h.value = r;
      }
    }
  });

  // ── Hit testing ──────────────────────────────────────────────────
  // Each region a click can land in.
  // Returns { win, zone, btn? } or null. zone: 'title'|'body'|'border'|'resize'|'btn'
  function hitTest(px, py) {
    const list = windows.peek();
    // Iterate top-down so the visually-on-top window wins.
    for (let i = list.length - 1; i >= 0; i--) {
      const win = list[i];
      // Minimized windows are not on the desktop — they can't be hit.
      if (win.minimized.peek()) continue;
      const wx = win.x.peek(), wy = win.y.peek();
      const ww = win.w.peek(), wh = win.h.peek();
      if (px < wx || py < wy || px >= wx + ww || py >= wy + wh) continue;

      // Inside this window.
      const localX = px - wx;
      const localY = py - wy;

      // Title row is y=0. Body is y=1 .. h-2. Last row is bottom border.
      // Resize handle is the bottom-right cell.
      if (win.resizable && !win.maximized.peek() &&
          localX === ww - 1 && localY === wh - 1) {
        return { win, zone: 'resize' };
      }

      if (localY === 0) {
        // Title bar — check buttons first (right-aligned).
        const btn = hitTitleButton(win, localX, ww);
        if (btn) return { win, zone: 'btn', btn };
        return { win, zone: 'title' };
      }

      // Border cells (left/right/bottom) → treat as border (focus-only).
      if (localX === 0 || localX === ww - 1 || localY === wh - 1) {
        return { win, zone: 'border' };
      }

      return { win, zone: 'body' };
    }
    return null;
  }

  // Layout of the right-side buttons in the title bar.
  // We render up to three buttons: [_] [□] [×], each occupies one cell with a
  // single-cell gap between them, anchored to ww-2 (last cell is right border).
  // Returns the button id or null.
  function hitTitleButton(win, localX, ww) {
    const buttons = visibleButtons(win);
    if (!buttons.length) return null;
    // Special-case the right corner glyph (ww-1) — clicks there commonly
    // overshoot the actual button cell, especially on maximized windows
    // where cell rounding at the viewport edge can miss by one.
    if (localX === ww - 1) return buttons[buttons.length - 1];

    // Each button covers 2 cells: the glyph + the cell immediately to its left
    // (the separator). This widens the click target without overlapping with
    // the title text region.
    let cursor = ww - 2;
    for (let i = buttons.length - 1; i >= 0; i--) {
      if (localX === cursor || localX === cursor - 1) return buttons[i];
      cursor -= 2;
      if (cursor < 1) break;
    }
    return null;
  }

  function visibleButtons(win) {
    // Order matters for layout (left → right): minimize, maximize, close.
    const out = [];
    if (win.minimizable) out.push('min');
    if (win.maximizable) out.push('max');
    if (win.closable) out.push('close');
    return out;
  }

  // ── Input ────────────────────────────────────────────────────────
  // Track double-click on title bars manually because the engine's dblclick
  // also fires on body / borders and we want title-only behaviour.
  let lastTitleClick = { t: 0, win: null, x: 0, y: 0 };

  engine.onMouse((e) => {
    if (e.type === 'mousedown') {
      const hit = hitTest(e.x, e.y);
      if (!hit) return;
      // Always raise focus on any mousedown inside a window.
      bringToFront(hit.win);

      if (hit.zone === 'btn') {
        // Buttons activate on mousedown (immediate, terminal-style).
        if (hit.btn === 'close') hit.win.close();
        else if (hit.btn === 'max') toggleMaximize(hit.win);
        else if (hit.btn === 'min') minimize(hit.win);
        return;
      }

      if (hit.zone === 'title') {
        // Double-click detection runs in BOTH normal and maximized state
        // (otherwise a maximized window could never be un-maximized via title).
        const now = performance.now();
        const isDbl = lastTitleClick.win === hit.win &&
                      now - lastTitleClick.t < 350 &&
                      Math.abs(lastTitleClick.x - e.x) <= 1 &&
                      Math.abs(lastTitleClick.y - e.y) <= 1;
        if (isDbl) {
          toggleMaximize(hit.win);
          lastTitleClick = { t: 0, win: null, x: 0, y: 0 };
          return;
        }
        lastTitleClick = { t: now, win: hit.win, x: e.x, y: e.y };

        // Drag only when not maximized — you can't drag a fullscreen window.
        if (!hit.win.maximized.peek()) {
          drag = {
            win: hit.win,
            mode: 'drag',
            grabDX: e.x - hit.win.x.peek(),
            grabDY: e.y - hit.win.y.peek(),
          };
        }
        return;
      }

      if (hit.zone === 'resize') {
        drag = {
          win: hit.win,
          mode: 'resize',
          grabDX: 0, grabDY: 0,
          startW: hit.win.w.peek(),
          startH: hit.win.h.peek(),
          startX: e.x, startY: e.y,
        };
        return;
      }
      // body / border — focus already raised; let app handle body input.
    } else if (e.type === 'mousemove') {
      if (!drag) return;
      const win = drag.win;
      if (drag.mode === 'drag') {
        const cols = engine.cols.peek();
        const rows = engine.rows.peek();
        // Clamp so at least the title row stays on-screen.
        let nx = e.x - drag.grabDX;
        let ny = e.y - drag.grabDY;
        nx = Math.max(1 - win.w.peek(), Math.min(cols - 1, nx));
        ny = Math.max(0, Math.min(rows - 1, ny));
        win.x.value = nx;
        win.y.value = ny;
      } else if (drag.mode === 'resize') {
        const dx = e.x - drag.startX;
        const dy = e.y - drag.startY;
        const cols = engine.cols.peek();
        const rows = engine.rows.peek();
        let nw = Math.max(MIN_W, drag.startW + dx);
        let nh = Math.max(MIN_H, drag.startH + dy);
        // Clamp to screen so resize handle doesn't escape.
        nw = Math.min(nw, cols - win.x.peek());
        nh = Math.min(nh, rows - win.y.peek());
        win.w.value = nw;
        win.h.value = nh;
      }
    } else if (e.type === 'mouseup') {
      drag = null;
    } else if (e.type === 'click' || e.type === 'dblclick') {
      // Already handled on mousedown; nothing to do. We avoid acting here so
      // we don't get duplicate close-button activations.
    }
  });

  // ── Touch ────────────────────────────────────────────────────────
  // Touch model:
  //   tap on title         → focus
  //   tap on close button  → close
  //   tap on max button    → toggle maximize
  //   doubletap on title   → toggle maximize
  //   longpress on title   → begin drag; subsequent moves drag the window
  //   swipe inside body    → app's concern; we don't intercept
  let touchDrag = null; // { win, grabDX, grabDY }

  engine.onTouch((e) => {
    if (e.type === 'start') {
      // Nothing to do until we know it's a tap/longpress/swipe.
      return;
    }
    if (e.type === 'tap') {
      const hit = hitTest(e.x, e.y);
      if (!hit) return;
      bringToFront(hit.win);
      if (hit.zone === 'btn') {
        if (hit.btn === 'close') hit.win.close();
        else if (hit.btn === 'max') toggleMaximize(hit.win);
        else if (hit.btn === 'min') minimize(hit.win);
      }
      return;
    }
    if (e.type === 'doubletap') {
      const hit = hitTest(e.x, e.y);
      if (hit && hit.zone === 'title') toggleMaximize(hit.win);
      return;
    }
    if (e.type === 'longpress') {
      const hit = hitTest(e.x, e.y);
      if (!hit) return;
      bringToFront(hit.win);
      if (hit.zone === 'title' && !hit.win.maximized.peek()) {
        touchDrag = {
          win: hit.win,
          grabDX: e.x - hit.win.x.peek(),
          grabDY: e.y - hit.win.y.peek(),
        };
      }
      return;
    }
    if (e.type === 'move' && touchDrag) {
      const win = touchDrag.win;
      const cols = engine.cols.peek();
      const rows = engine.rows.peek();
      let nx = e.x - touchDrag.grabDX;
      let ny = e.y - touchDrag.grabDY;
      nx = Math.max(1 - win.w.peek(), Math.min(cols - 1, nx));
      ny = Math.max(0, Math.min(rows - 1, ny));
      win.x.value = nx;
      win.y.value = ny;
      return;
    }
    if (e.type === 'end' || e.type === 'swipe') {
      touchDrag = null;
    }
  });

  // ── Keyboard ─────────────────────────────────────────────────────
  engine.onKey((e) => {
    if (e.type !== 'down') return;
    // Alt+Tab / Alt+Shift+Tab — cycle focus.
    if (e.alt && e.key === 'Tab') {
      if (e.shift) focusPrev(); else focusNext();
      e.raw?.preventDefault?.();
      return;
    }
    // Alt+F4 — close focused window.
    if (e.alt && (e.key === 'F4' || e.code === 'F4')) {
      const f = focused.peek();
      if (f && f.closable) f.close();
      e.raw?.preventDefault?.();
      return;
    }
  });

  // ── Rendering ────────────────────────────────────────────────────
  function render() {
    const list = windows.peek();
    const f = focused.peek();
    // Draw bottom-to-top so the focused window (which we always position at
    // the end of the array on focus) sits visually on top.
    // Minimized windows are hidden — kept in state for the taskbar only.
    for (const win of list) {
      if (win.minimized.peek()) continue;
      drawWindow(win, win === f);
    }
  }

  function drawWindow(win, isFocused) {
    const theme = engine.theme.peek();
    const colors = theme.colors;
    const x = win.x.peek(), y = win.y.peek();
    const w = win.w.peek(), h = win.h.peek();
    if (w < MIN_W || h < MIN_H) return;

    // Skip entirely off-screen windows — engine.put already clips, but this
    // saves work on large window counts.
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();
    if (x + w <= 0 || y + h <= 0 || x >= cols || y >= rows) return;

    const borderColor = isFocused ? colors.borderFocus : colors.border;
    const glyphSet = isFocused ? 'borderDouble' : 'border';
    const bg = colors.bg;

    // 1. Solid fill so windows occlude what's underneath.
    engine.rect(x, y, w, h, { ch: ' ', bg });

    // 2. Border around the entire window.
    engine.box(x, y, w, h, { fg: borderColor, glyphSet });

    // 3. Title bar — overwrite the top border between the corners.
    drawTitleBar(win, x, y, w, isFocused, colors, theme);

    // 4. Body via clipped sub-context.
    if (h > 2 && w > 2) {
      const ctx = engine.subContext({ x: x + 1, y: y + 1, w: w - 2, h: h - 2 });
      try { win.body(ctx, win); }
      catch (err) {
        // Render the error inside the window rather than tearing down the WM.
        ctx.text(0, 0, '[body error]', { fg: colors.error, bold: true });
        const msg = String(err?.message || err);
        ctx.text(0, 1, msg.slice(0, ctx.width), { fg: colors.error });
      }
    }

    // 5. Resize hint glyph in the bottom-right corner (replaces the corner).
    if (win.resizable && !win.maximized.peek()) {
      engine.put(x + w - 1, y + h - 1, '◢', { fg: borderColor });
    }
  }

  function drawTitleBar(win, x, y, w, isFocused, colors, theme) {
    if (w < 2) return;
    const fg = isFocused ? colors.borderFocus : colors.fgDim;
    const titleFg = isFocused ? colors.accent : colors.fg;
    const g = theme.glyphs[isFocused ? 'borderDouble' : 'border'];

    // Buttons (rightmost first).
    const buttons = visibleButtons(win);
    let btnCells = 0;
    if (buttons.length > 0) {
      // Each button takes 1 cell + 1 separator cell, except no separator after
      // the rightmost button (it sits at ww-2, last cell is right border).
      btnCells = buttons.length * 2 - 1 + 1; // +1 pad before buttons
    }

    // Title text region: from x+1 .. x + w - 2 - btnCells.
    const titleStart = x + 1;
    const titleEnd = x + w - 2 - btnCells; // inclusive
    const titleSpace = Math.max(0, titleEnd - titleStart + 1);

    // Fill the title row with a horizontal rule first so it joins the border.
    for (let i = 1; i < w - 1; i++) {
      engine.put(x + i, y, g.h, { fg });
    }

    // Title text — bracketed and truncated.
    if (titleSpace > 2) {
      const raw = String(win.title.peek() ?? '');
      const max = titleSpace - 2; // leave room for ' '..' '
      let shown = raw;
      if (shown.length > max) shown = shown.slice(0, Math.max(0, max - 1)) + '…';
      const label = ' ' + shown + ' ';
      engine.text(titleStart, y, label, { fg: titleFg, bold: isFocused });
    } else if (titleSpace > 0) {
      const raw = String(win.title.peek() ?? '');
      engine.text(titleStart, y, raw.slice(0, titleSpace), { fg: titleFg });
    }

    // Buttons.
    const isMax = win.maximized.peek();
    let cursor = x + w - 2;
    for (let i = buttons.length - 1; i >= 0; i--) {
      const id = buttons[i];
      let glyph;
      if (id === 'close') glyph = '×';
      else if (id === 'max') glyph = isMax ? '▣' : '□'; // ▣ = restore, □ = maximize
      else glyph = '_';
      const color = id === 'close' ? colors.error : colors.accent;
      engine.put(cursor, y, glyph, { fg: color, bold: true });
      cursor -= 2;
    }
  }

  return {
    // Mutators
    addWindow,
    removeWindow,
    bringToFront,
    focusNext,
    focusPrev,
    toggleMaximize,
    minimize,
    restore: restoreWindow,
    toggleMinimize,
    isMinimized,

    // State (signals)
    focused,
    windows,

    // Drawing
    render,
  };
}
