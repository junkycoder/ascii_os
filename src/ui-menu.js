// ui-menu.js — popup / context menu component
//
// Floating list of items in a small bordered box. Used for right-click menus
// on icons, desktop, widgets, etc. Supports separators, hotkeys, disabled
// items, danger styling, and nested submenus.
//
// API
//   import { createContextMenu, MenuItem } from './ui-menu.js'
//   const menu = createContextMenu({ x, y, items, onClose, maxWidth })
//   menu.render(engine)   // each frame while open
//   menu.onKey(e)         // up/down/enter/esc/hotkey
//   menu.onMouse(e)       // hover/click
//   menu.close()
//   menu.bounds           // { x, y, w, h }  — for outside-click detection
//
// Item shape:
//   { label, onSelect?, hotkey?, disabled?, danger?, items?, type? }
//   type === 'separator'  → horizontal rule
//   items: [...]          → submenu (opens on Enter / Right / hover)

import { signal } from "./signals.js";

// Re-exported helper for callers that want a typed constructor. It's just a
// passthrough — keeps call-sites readable: MenuItem({ label, onSelect }).
export function MenuItem(opts) { return { ...opts }; }

const SUBMENU_ARROW = "▸"; // ▸
const SEPARATOR_CH  = "─"; // ─

function isSelectable(it) {
  return it && it.type !== "separator" && !it.disabled;
}

function itemWidth(it) {
  if (!it) return 0;
  if (it.type === "separator") return 0;
  let w = (it.label || "").length;
  if (it.hotkey)   w += 1 + it.hotkey.length;     // space + key
  if (it.items)    w += 2;                        // space + arrow
  return w;
}

export function createContextMenu(opts) {
  const items   = opts.items || [];
  const onClose = opts.onClose || (() => {});
  const maxW    = opts.maxWidth || 40;

  // Compute natural width — longest item + padding (1 left, 1 right) + border (2).
  let natW = 0;
  for (const it of items) natW = Math.max(natW, itemWidth(it));
  const w = Math.min(maxW, Math.max(8, natW + 4));
  const h = items.length + 2;

  // Anchor coords. Auto-flipped at render time once we know engine bounds.
  const anchorX = opts.x | 0;
  const anchorY = opts.y | 0;

  // Selection cursor — index into items[]. Skips separators/disabled.
  const cursor = signal(firstSelectable(items, 0, 1));

  // Bounds get filled in by render() the first time. Until then provide a
  // best-guess so outside-click detection has *something* to work against.
  const bounds = { x: anchorX, y: anchorY, w, h };

  // Active nested submenu (createContextMenu instance) or null.
  let activeSubmenu = null;
  let activeParentIdx = -1;

  // Closed menus are inert; render() / events become no-ops.
  let closed = false;

  function firstSelectable(arr, from, step) {
    if (!arr.length) return -1;
    let i = from;
    for (let n = 0; n < arr.length; n++) {
      if (i < 0) i = arr.length - 1;
      if (i >= arr.length) i = 0;
      if (isSelectable(arr[i])) return i;
      i += step;
    }
    return -1;
  }

  function moveCursor(step) {
    if (cursor.peek() < 0) {
      cursor.value = firstSelectable(items, step > 0 ? 0 : items.length - 1, step);
      return;
    }
    let i = cursor.peek() + step;
    for (let n = 0; n < items.length; n++) {
      if (i < 0) i = items.length - 1;
      if (i >= items.length) i = 0;
      if (isSelectable(items[i])) { cursor.value = i; return; }
      i += step;
    }
  }

  function close(reason) {
    if (closed) return;
    closed = true;
    if (activeSubmenu) { activeSubmenu.close(); activeSubmenu = null; }
    try { onClose(reason); } catch (e) { console.error("menu onClose", e); }
  }

  function openSubmenuFor(idx, engine) {
    if (activeSubmenu) { activeSubmenu.close(); activeSubmenu = null; }
    const it = items[idx];
    if (!it || !it.items || !it.items.length) return;
    activeParentIdx = idx;
    // Position to the right of this item, aligned with its row.
    const sx = bounds.x + bounds.w;
    const sy = bounds.y + 1 + idx;
    activeSubmenu = createContextMenu({
      x: sx,
      y: sy,
      items: it.items,
      maxWidth: maxW,
      onClose: () => { activeSubmenu = null; activeParentIdx = -1; },
    });
    // Bubble selections up — when the submenu activates something we close
    // the whole chain so callers don't have to chase nested onClose calls.
    const wrap = activeSubmenu;
    const innerClose = wrap.close;
    wrap.close = (reason) => {
      innerClose(reason);
      if (reason === "select") close("select");
    };
  }

  function activate(idx, engine) {
    const it = items[idx];
    if (!it || !isSelectable(it)) return;
    if (it.items && it.items.length) {
      openSubmenuFor(idx, engine);
      return;
    }
    try { it.onSelect && it.onSelect(it); }
    catch (e) { console.error("menu onSelect", e); }
    close("select");
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render(engine) {
    if (closed) return;
    const theme = engine.theme.value;
    const C = theme.colors;
    const cols = engine.cols.value;
    const rows = engine.rows.value;

    // Auto-flip: prefer right/down, flip to left/up if we'd overflow.
    let x = anchorX;
    let y = anchorY;
    if (x + w > cols) x = Math.max(0, anchorX - w);
    if (y + h > rows) y = Math.max(0, anchorY - h);
    bounds.x = x; bounds.y = y; bounds.w = w; bounds.h = h;

    // Background fill — without this the menu becomes see-through and
    // illegible against whatever is underneath.
    engine.rect(x, y, w, h, { ch: " ", bg: C.bg, fg: C.fg });
    engine.box(x, y, w, h, { fg: C.border, glyphSet: "borderRound" });

    const innerW = w - 2;
    for (let i = 0; i < items.length; i++) {
      const row = y + 1 + i;
      const it = items[i];
      if (it.type === "separator") {
        engine.text(x + 1, row, SEPARATOR_CH.repeat(innerW), { fg: C.borderFocus || C.fgDim || C.fg, bg: C.bg });
        continue;
      }

      const focused = i === cursor.peek() || i === activeParentIdx;
      const disabled = !!it.disabled;
      const danger = !!it.danger;

      let fg = C.fg;
      let bg = C.bg;
      if (disabled) fg = C.fgDim;
      else if (danger) fg = C.error;
      if (focused && !disabled) {
        bg = C.accent;
        fg = C.bg;
      } else if (focused && disabled) {
        bg = C.accentDim || C.bg;
      }

      // Paint full-width row background first so the highlight bar spans
      // the whole interior, not just the label text.
      engine.rect(x + 1, row, innerW, 1, { ch: " ", bg, fg });

      const label = (it.label || "").slice(0, innerW - 2);
      engine.text(x + 2, row, label, { fg, bg, bold: !!it.bold });

      // Right-aligned decorations. Submenu arrow wins; otherwise show hotkey.
      if (it.items && it.items.length) {
        engine.put(x + w - 2, row, SUBMENU_ARROW, { fg, bg });
      } else if (it.hotkey) {
        const hk = String(it.hotkey);
        const hx = x + w - 1 - hk.length;
        if (hx >= x + 2 + label.length + 1) {
          engine.text(hx, row, hk, {
            fg: focused ? fg : (C.fgDim || fg),
            bg,
          });
        }
      }
    }

    // Submenu draws on top — recurse last so its highlight wins z-order.
    if (activeSubmenu) activeSubmenu.render(engine);
  }

  // ── Keyboard ────────────────────────────────────────────────────────
  function onKey(e) {
    if (closed) return false;
    if (e.type && e.type !== "down") return false;

    // Forward to active submenu first — it owns focus while open.
    if (activeSubmenu) {
      const handled = activeSubmenu.onKey(e);
      if (handled) return true;
      // ArrowLeft / Esc on a submenu closes just the submenu.
      if (e.key === "ArrowLeft" || e.key === "Escape") {
        activeSubmenu.close("cancel");
        activeSubmenu = null;
        activeParentIdx = -1;
        return true;
      }
      return false;
    }

    switch (e.key) {
      case "ArrowUp":   moveCursor(-1); return true;
      case "ArrowDown": moveCursor( 1); return true;
      case "Home":      cursor.value = firstSelectable(items, 0, 1); return true;
      case "End":       cursor.value = firstSelectable(items, items.length - 1, -1); return true;
      case "Enter":
      case " ":
        if (cursor.peek() >= 0) activate(cursor.peek());
        return true;
      case "ArrowRight": {
        const it = items[cursor.peek()];
        if (it && it.items && it.items.length) { openSubmenuFor(cursor.peek()); return true; }
        return false;
      }
      case "Escape":
        close("cancel");
        return true;
    }

    // Hotkey match — single character, case-insensitive.
    if (e.key && e.key.length === 1) {
      const k = e.key.toLowerCase();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!isSelectable(it) || !it.hotkey) continue;
        if (String(it.hotkey).toLowerCase() === k) {
          cursor.value = i;
          activate(i);
          return true;
        }
      }
    }
    return false;
  }

  // ── Mouse ───────────────────────────────────────────────────────────
  function hit(x, y) {
    return x >= bounds.x && x < bounds.x + bounds.w
        && y >= bounds.y && y < bounds.y + bounds.h;
  }
  function rowAt(x, y) {
    if (!hit(x, y)) return -1;
    const r = y - bounds.y - 1;
    if (r < 0 || r >= items.length) return -1;
    return r;
  }

  function onMouse(e) {
    if (closed) return false;
    // Submenu has first claim on events inside its bounds.
    if (activeSubmenu) {
      const sb = activeSubmenu.bounds;
      const inSub = e.x >= sb.x && e.x < sb.x + sb.w && e.y >= sb.y && e.y < sb.y + sb.h;
      if (inSub) return activeSubmenu.onMouse(e);
      // Click outside submenu but inside us → collapse submenu, then fall through.
      if (e.type === "mousedown" || e.type === "click") {
        activeSubmenu.close("cancel");
        activeSubmenu = null;
        activeParentIdx = -1;
      }
    }

    if (!hit(e.x, e.y)) return false;

    const r = rowAt(e.x, e.y);
    if (e.type === "mousemove") {
      if (r >= 0 && isSelectable(items[r])) {
        cursor.value = r;
        // Auto-open submenus on hover after a brief settle — but here we open
        // immediately to match the spec ("open recursively on hover").
        const it = items[r];
        if (it.items && it.items.length && activeParentIdx !== r) {
          openSubmenuFor(r);
        } else if (!it.items && activeSubmenu) {
          activeSubmenu.close("cancel");
          activeSubmenu = null;
          activeParentIdx = -1;
        }
      }
      return true;
    }
    if (e.type === "click" || e.type === "mouseup") {
      if (r >= 0 && isSelectable(items[r])) { activate(r); return true; }
      return true; // consumed inside bounds even if no-op
    }
    if (e.type === "mousedown") return true; // swallow to avoid downstream selection
    return false;
  }

  return {
    get bounds() { return bounds; },
    get closed() { return closed; },
    render,
    onKey,
    onMouse,
    close,
    // Exposed for hosts that want to drive selection programmatically.
    cursor,
  };
}
