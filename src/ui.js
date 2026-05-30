// ui.js — foundational UI components for acii_os
//
// Each factory returns a component with:
//   render(ctx)   — draw to a sub-context or engine. Uses ABSOLUTE coords passed at create-time.
//   onKey(e)?     — returns true if the event was handled (consumer can stop propagation).
//   onMouse(e)?   — coordinates are expected in the same space the component lives in.
//   focused       — signal<boolean>
//   destroy()?    — optional cleanup hook
//
// Conventions:
//   - Colors are pulled from ctx.theme.peek().colors at render time so theme switches
//     just work. We use peek (not .value) to avoid accidentally subscribing the caller's
//     frame loop to the theme signal — engine.onFrame already re-runs every tick.
//   - Focused components use the `borderFocus` color and the `borderDouble` glyph set.
//   - The caret blink uses performance.now() so all inputs blink in lockstep.

import { signal } from "./signals.js";

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

function colors(ctx) { return ctx.theme.peek().colors; }
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function caretOn() { return (performance.now() % 1000) < 500; }

// Hit-test a rect in the component's coordinate space.
function inRect(e, x, y, w, h) {
  return e && e.x >= x && e.x < x + w && e.y >= y && e.y < y + h;
}

// Wrap a string into lines of at most `w` chars. Hard-wraps long words —
// good enough for terminal-style UIs where exact width matters more than typography.
function wrapLines(str, w) {
  if (w <= 0) return [];
  const out = [];
  const paragraphs = String(str ?? "").split("\n");
  for (const p of paragraphs) {
    if (p.length === 0) { out.push(""); continue; }
    let i = 0;
    while (i < p.length) {
      // try to break on the last space within the window
      let end = Math.min(i + w, p.length);
      if (end < p.length) {
        const sp = p.lastIndexOf(" ", end);
        if (sp > i) end = sp;
      }
      out.push(p.slice(i, end));
      i = end;
      while (p[i] === " ") i++; // skip the break-space
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 1. Panel — static framed region with optional title
// ────────────────────────────────────────────────────────────────

export function createPanel({ x, y, w, h, title = "", glyphSet, border = true }) {
  const focused = signal(false);
  return {
    focused,
    render(ctx) {
      const c = colors(ctx);
      const f = focused.value;
      const gs = glyphSet || (f ? "borderDouble" : "border");
      if (border) {
        ctx.box(x, y, w, h, { glyphSet: gs, fg: f ? c.borderFocus : c.border });
      }
      if (title && w >= title.length + 4) {
        // Surround with spaces so the title doesn't fuse into the border glyphs.
        const label = ` ${title} `;
        const tx = x + Math.floor((w - label.length) / 2);
        ctx.text(tx, y, label, { fg: f ? c.borderFocus : c.fg, bold: true });
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 2. Button — [ Label ] / ▶ Label ◀ when focused
// ────────────────────────────────────────────────────────────────

export function createButton({ x, y, w, label, onClick, hotkey }) {
  const focused = signal(false);
  // If width is omitted, size to label + brackets/markers (3 chars padding each side).
  const width = w || label.length + 4;

  function activate() { if (typeof onClick === "function") onClick(); }

  return {
    focused,
    get label() { return label },
    render(ctx) {
      const c = colors(ctx);
      const f = focused.value;
      const inner = width - 4; // space between markers
      const pad = Math.max(0, inner - label.length);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      const text = " ".repeat(left) + label.slice(0, inner) + " ".repeat(right);
      if (f) {
        // Inverse style: accent background, bg-color text.
        ctx.text(x, y, "▶ " + text + " ◀", { fg: c.bg, bg: c.accent, bold: true });
      } else {
        ctx.text(x, y, "[ " + text + " ]", { fg: c.fg });
      }
    },
    onKey(e) {
      if (e.type !== "down") return false;
      if (focused.peek() && (e.key === "Enter" || e.key === " ")) { activate(); return true; }
      if (hotkey && e.key.toLowerCase() === String(hotkey).toLowerCase()) { activate(); return true; }
      return false;
    },
    onMouse(e) {
      if (e.type === "click" && inRect(e, x, y, width, 1)) { activate(); return true; }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 3. Input — single-line text with blinking caret
// ────────────────────────────────────────────────────────────────

export function createInput({ x, y, w, value = "", placeholder = "", onChange, onSubmit }) {
  const val = signal(value);
  const caret = signal(value.length);
  const focused = signal(false);
  // Horizontal scroll offset — keeps caret visible when text exceeds width.
  let scroll = 0;

  function setValue(next, newCaret) {
    val.value = next;
    caret.value = clamp(newCaret ?? caret.peek(), 0, next.length);
    if (typeof onChange === "function") onChange(next);
  }

  function ensureCaretVisible() {
    const inner = w - 2; // 1 char padding each side
    const cur = caret.peek();
    if (cur < scroll) scroll = cur;
    else if (cur >= scroll + inner) scroll = cur - inner + 1;
    if (scroll < 0) scroll = 0;
  }

  return {
    value: val,
    caret,
    focused,
    setValue(s) { setValue(String(s ?? ""), String(s ?? "").length); },
    render(ctx) {
      const c = colors(ctx);
      const f = focused.value;
      const fg = f ? c.borderFocus : c.border;
      // Frame
      ctx.box(x, y, w, 3, { glyphSet: f ? "borderDouble" : "border", fg });
      ensureCaretVisible();
      const inner = w - 2;
      const v = val.value;
      const showPlaceholder = v.length === 0 && !f;
      const display = showPlaceholder ? placeholder : v;
      const visible = display.slice(scroll, scroll + inner);
      // Clear interior (in case prior content was wider)
      ctx.text(x + 1, y + 1, " ".repeat(inner), { fg: c.fg });
      ctx.text(x + 1, y + 1, visible, {
        fg: showPlaceholder ? c.fgDim : c.fg,
      });
      // Caret — only when focused and blink-on
      if (f && caretOn()) {
        const cx = x + 1 + (caret.value - scroll);
        if (cx >= x + 1 && cx < x + 1 + inner) {
          const under = v[caret.value] || " ";
          ctx.put(cx, y + 1, under, { fg: c.bg, bg: c.accent });
        }
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      const v = val.peek();
      const cur = caret.peek();
      if (e.key === "Enter") { if (typeof onSubmit === "function") onSubmit(v); return true; }
      if (e.key === "Backspace") {
        if (cur > 0) setValue(v.slice(0, cur - 1) + v.slice(cur), cur - 1);
        return true;
      }
      if (e.key === "Delete") {
        if (cur < v.length) setValue(v.slice(0, cur) + v.slice(cur + 1), cur);
        return true;
      }
      if (e.key === "ArrowLeft") { caret.value = clamp(cur - 1, 0, v.length); return true; }
      if (e.key === "ArrowRight") { caret.value = clamp(cur + 1, 0, v.length); return true; }
      if (e.key === "Home") { caret.value = 0; return true; }
      if (e.key === "End") { caret.value = v.length; return true; }
      // Printable single chars only (avoid e.g. "Shift", "ArrowUp", "F1")
      if (e.key.length === 1 && !e.ctrl && !e.meta) {
        setValue(v.slice(0, cur) + e.key + v.slice(cur), cur + 1);
        return true;
      }
      return false;
    },
    onMouse(e) {
      if (e.type === "click" && inRect(e, x, y, w, 3)) {
        // Place caret approximately under click
        const cx = clamp(e.x - x - 1, 0, w - 3);
        caret.value = clamp(scroll + cx, 0, val.peek().length);
        return true;
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 4. TextArea — multi-line, wrapping, scrollable
// ────────────────────────────────────────────────────────────────

export function createTextArea({ x, y, w, h, value = "", onChange }) {
  const val = signal(value);
  const caret = signal(value.length);
  const focused = signal(false);
  const scrollY = signal(0);

  function setValue(next, newCaret) {
    val.value = next;
    caret.value = clamp(newCaret ?? caret.peek(), 0, next.length);
    if (typeof onChange === "function") onChange(next);
  }

  // Map flat caret index → {row, col} in the wrapped layout.
  // We rebuild the wrap on every render — cheap for terminal-sized text.
  function layout(text, innerW) {
    const lines = wrapLines(text, innerW);
    return lines;
  }

  return {
    value: val,
    focused,
    scrollY,
    setValue(s) { setValue(String(s ?? ""), String(s ?? "").length); },
    render(ctx) {
      const c = colors(ctx);
      const f = focused.value;
      const fg = f ? c.borderFocus : c.border;
      ctx.box(x, y, w, h, { glyphSet: f ? "borderDouble" : "border", fg });
      const innerW = w - 2;
      const innerH = h - 2;
      const lines = layout(val.value, innerW);
      const top = scrollY.value;
      for (let i = 0; i < innerH; i++) {
        const ln = lines[top + i] || "";
        ctx.text(x + 1, y + 1 + i, ln + " ".repeat(Math.max(0, innerW - ln.length)), { fg: c.fg });
      }
      // Scrollbar indicator on the right edge.
      if (lines.length > innerH) {
        const trackH = innerH;
        const knob = Math.max(1, Math.floor(trackH * trackH / lines.length));
        const maxTop = Math.max(1, lines.length - innerH);
        const knobY = Math.floor((top / maxTop) * (trackH - knob));
        for (let i = 0; i < trackH; i++) {
          const within = i >= knobY && i < knobY + knob;
          ctx.put(x + w - 1, y + 1 + i, within ? "█" : "│", { fg: within ? c.accent : c.border });
        }
      }
      if (f && caretOn()) {
        // Naive caret: put it at the end of the last visible line.
        // Full caret-in-wrapped-text mapping is intentionally out of scope here.
        const lastIdx = Math.min(lines.length - 1, top + innerH - 1);
        const last = lines[lastIdx] || "";
        const cx = x + 1 + Math.min(last.length, innerW - 1);
        const cy = y + 1 + (lastIdx - top);
        ctx.put(cx, cy, "▌", { fg: c.accent });
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      const v = val.peek();
      if (e.key === "Backspace") { setValue(v.slice(0, -1), v.length - 1); return true; }
      if (e.key === "Enter") { setValue(v + "\n", v.length + 1); return true; }
      if (e.key === "ArrowUp") { scrollY.value = Math.max(0, scrollY.peek() - 1); return true; }
      if (e.key === "ArrowDown") { scrollY.value = scrollY.peek() + 1; return true; }
      if (e.key === "PageUp") { scrollY.value = Math.max(0, scrollY.peek() - (h - 2)); return true; }
      if (e.key === "PageDown") { scrollY.value = scrollY.peek() + (h - 2); return true; }
      if (e.key.length === 1 && !e.ctrl && !e.meta) {
        setValue(v + e.key, v.length + 1); return true;
      }
      return false;
    },
    onMouse(e) {
      if (e.type === "wheel" && inRect(e, x, y, w, h)) {
        scrollY.value = Math.max(0, scrollY.peek() + (e.deltaY > 0 ? 1 : -1));
        return true;
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 5. List — vertical scrollable list of strings
// ────────────────────────────────────────────────────────────────

export function createList({ x, y, w, h, items = [], selectedIndex = 0, onSelect }) {
  const sel = signal(clamp(selectedIndex, 0, Math.max(0, items.length - 1)));
  const focused = signal(false);
  const scroll = signal(0);
  // Items can be swapped after construction via the returned `setItems`.
  let list = items.slice();

  function ensureVisible() {
    const innerH = h - 2;
    const s = sel.peek();
    if (s < scroll.peek()) scroll.value = s;
    else if (s >= scroll.peek() + innerH) scroll.value = s - innerH + 1;
  }

  function setItems(next) {
    list = (next || []).slice();
    sel.value = clamp(sel.peek(), 0, Math.max(0, list.length - 1));
    scroll.value = 0;
  }

  return {
    selectedIndex: sel,
    focused,
    setItems,
    get items() { return list; },
    render(ctx) {
      const c = colors(ctx);
      const f = focused.value;
      ctx.box(x, y, w, h, { glyphSet: f ? "borderDouble" : "border", fg: f ? c.borderFocus : c.border });
      ensureVisible();
      const innerW = w - 2;
      const innerH = h - 2;
      const top = scroll.value;
      for (let i = 0; i < innerH; i++) {
        const idx = top + i;
        if (idx >= list.length) break;
        const item = String(list[idx]);
        const isSel = idx === sel.value;
        const line = (isSel ? "▶ " : "  ") + item;
        const trimmed = line.slice(0, innerW);
        const pad = " ".repeat(Math.max(0, innerW - trimmed.length));
        ctx.text(x + 1, y + 1 + i, trimmed + pad, isSel
          ? { fg: c.bg, bg: c.accent, bold: true }
          : { fg: c.fg });
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      if (e.key === "ArrowUp") { sel.value = clamp(sel.peek() - 1, 0, list.length - 1); return true; }
      if (e.key === "ArrowDown") { sel.value = clamp(sel.peek() + 1, 0, list.length - 1); return true; }
      if (e.key === "Home") { sel.value = 0; return true; }
      if (e.key === "End") { sel.value = list.length - 1; return true; }
      if (e.key === "Enter") {
        if (typeof onSelect === "function") onSelect(list[sel.peek()], sel.peek());
        return true;
      }
      return false;
    },
    onMouse(e) {
      if (e.type === "wheel" && inRect(e, x, y, w, h)) {
        scroll.value = clamp(scroll.peek() + (e.deltaY > 0 ? 1 : -1), 0, Math.max(0, list.length - (h - 2)));
        return true;
      }
      if (e.type === "click" && inRect(e, x, y, w, h)) {
        const idx = scroll.peek() + (e.y - y - 1);
        if (idx >= 0 && idx < list.length) {
          sel.value = idx;
          if (typeof onSelect === "function") onSelect(list[idx], idx);
        }
        return true;
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 6. Menu — vertical popup with disabled items, esc cancels
// ────────────────────────────────────────────────────────────────

export function createMenu({ x, y, items = [], onSelect, onCancel }) {
  const focused = signal(true); // menus are typically modal/focused on appear
  const sel = signal(0);
  // Width auto-fit: longest label + 4 padding (▶ label ◀-ish)
  const w = Math.max(8, items.reduce((m, it) => Math.max(m, String(it.label || "").length), 0) + 6);
  const h = items.length + 2;

  // Skip disabled items when moving selection.
  function move(delta) {
    if (items.length === 0) return;
    let i = sel.peek();
    for (let k = 0; k < items.length; k++) {
      i = (i + delta + items.length) % items.length;
      if (!items[i].disabled) { sel.value = i; return; }
    }
  }
  // Land on first enabled item.
  if (items[0]?.disabled) move(1);

  return {
    focused,
    selectedIndex: sel,
    width: w,
    height: h,
    render(ctx) {
      const c = colors(ctx);
      ctx.box(x, y, w, h, { glyphSet: "borderDouble", fg: c.borderFocus });
      const innerW = w - 2;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const label = String(it.label || "");
        const isSel = i === sel.value && !it.disabled;
        const line = (isSel ? " ▶ " : "   ") + label;
        const trimmed = line.slice(0, innerW);
        const pad = " ".repeat(Math.max(0, innerW - trimmed.length));
        const style = it.disabled
          ? { fg: c.fgDim }
          : isSel
            ? { fg: c.bg, bg: c.accent, bold: true }
            : { fg: c.fg };
        ctx.text(x + 1, y + 1 + i, trimmed + pad, style);
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      if (e.key === "Escape") { if (typeof onCancel === "function") onCancel(); return true; }
      if (e.key === "ArrowUp") { move(-1); return true; }
      if (e.key === "ArrowDown") { move(1); return true; }
      if (e.key === "Enter") {
        const it = items[sel.peek()];
        if (it && !it.disabled && typeof onSelect === "function") onSelect(it.value, it);
        return true;
      }
      return false;
    },
    onMouse(e) {
      if (e.type === "click" && inRect(e, x, y, w, h)) {
        const idx = e.y - y - 1;
        const it = items[idx];
        if (it && !it.disabled) {
          sel.value = idx;
          if (typeof onSelect === "function") onSelect(it.value, it);
        }
        return true;
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 7. Tabs — horizontal tab bar
// ────────────────────────────────────────────────────────────────

export function createTabs({ x, y, w, tabs = [], activeIndex = 0, onChange }) {
  const active = signal(clamp(activeIndex, 0, Math.max(0, tabs.length - 1)));
  const focused = signal(false);

  function setActive(i) {
    const next = clamp(i, 0, tabs.length - 1);
    if (next === active.peek()) return;
    active.value = next;
    if (typeof onChange === "function") onChange(next, tabs[next]);
  }

  // Pre-compute each tab's [x, width] in local space so onMouse and render agree.
  function layout() {
    const spans = [];
    let cx = 0;
    for (const t of tabs) {
      const label = String(t.label ?? t);
      const wTab = label.length + 4; // " label " + separators
      spans.push({ label, x: cx, w: wTab });
      cx += wTab;
    }
    return spans;
  }

  return {
    activeIndex: active,
    focused,
    setActive,
    render(ctx) {
      const c = colors(ctx);
      const spans = layout();
      // Clear the row first so stale glyphs don't bleed through on resize.
      ctx.text(x, y, " ".repeat(w), { fg: c.fg });
      ctx.text(x, y + 1, "─".repeat(w), { fg: c.border });
      for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        if (s.x >= w) break;
        const isActive = i === active.value;
        const label = " " + s.label + " ";
        if (isActive) {
          ctx.text(x + s.x, y, "▎" + label + "▕", { fg: c.bg, bg: c.accent, bold: true });
          // Knock out the separator under the active tab.
          ctx.text(x + s.x, y + 1, " ".repeat(s.w), { fg: c.border });
        } else {
          ctx.text(x + s.x, y, " " + label + " ", { fg: focused.value ? c.fg : c.fgDim });
        }
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      if (e.key === "ArrowLeft") { setActive(active.peek() - 1); return true; }
      if (e.key === "ArrowRight") { setActive(active.peek() + 1); return true; }
      return false;
    },
    onMouse(e) {
      if (e.type !== "click") return false;
      if (e.y !== y) return false;
      const lx = e.x - x;
      const spans = layout();
      for (let i = 0; i < spans.length; i++) {
        if (lx >= spans[i].x && lx < spans[i].x + spans[i].w) { setActive(i); return true; }
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 8. ProgressBar — [████░░] 60%
// ────────────────────────────────────────────────────────────────

export function createProgressBar({ x, y, w, value = 0, max = 100, label = "" }) {
  const val = signal(value);
  const focused = signal(false);
  return {
    value: val,
    focused,
    setValue(v) { val.value = v; },
    render(ctx) {
      const c = colors(ctx);
      const v = clamp(val.value, 0, max);
      const pct = max > 0 ? v / max : 0;
      // Reserve space for the percentage suffix " 100%" (5 chars worst case).
      const suffix = " " + Math.round(pct * 100) + "%";
      const labelPrefix = label ? label + " " : "";
      const barW = w - 2 - suffix.length - labelPrefix.length;
      if (barW <= 0) {
        // Degenerate — just write whatever fits.
        ctx.text(x, y, (labelPrefix + suffix).slice(0, w), { fg: c.fg });
        return;
      }
      const filled = Math.round(barW * pct);
      const empty = barW - filled;
      if (labelPrefix) ctx.text(x, y, labelPrefix, { fg: c.fgDim });
      const bx = x + labelPrefix.length;
      ctx.text(bx, y, "[", { fg: c.border });
      ctx.text(bx + 1, y, "█".repeat(filled), { fg: c.accent });
      ctx.text(bx + 1 + filled, y, "░".repeat(empty), { fg: c.fgDim });
      ctx.text(bx + 1 + barW, y, "]", { fg: c.border });
      ctx.text(bx + 2 + barW, y, suffix, { fg: c.fg });
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 9. Spinner — rotating glyph; advances on every render call
// ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createSpinner({ x, y, frames = SPINNER_FRAMES, speed = 80 }) {
  // Time-based rather than render-count based so the spin rate is stable
  // regardless of FPS cap or skipped frames.
  const focused = signal(false);
  return {
    focused,
    render(ctx) {
      const c = colors(ctx);
      const idx = Math.floor(performance.now() / speed) % frames.length;
      ctx.put(x, y, frames[idx], { fg: c.accent, bold: true });
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Dialog — modal panel: title, body callback, button row
// ────────────────────────────────────────────────────────────────

export function createDialog({
  x, y, w, h, title = "", body, buttons = [{ label: "OK", value: "ok" }], onClose,
}) {
  const focused = signal(true);
  // The dialog manages an inner focus cursor across its buttons.
  const btnIdx = signal(0);

  function close(value) { if (typeof onClose === "function") onClose(value); }

  // Compute button layout once per render — depends only on labels + width.
  function buttonLayout() {
    const labels = buttons.map(b => `[ ${b.label} ]`);
    const totalW = labels.reduce((a, s) => a + s.length, 0) + (labels.length - 1);
    const startX = x + Math.max(1, Math.floor((w - totalW) / 2));
    const row = y + h - 2;
    const positions = [];
    let cx = startX;
    for (let i = 0; i < labels.length; i++) {
      positions.push({ x: cx, w: labels[i].length, label: labels[i], row });
      cx += labels[i].length + 1;
    }
    return positions;
  }

  return {
    focused,
    btnIdx,
    render(ctx) {
      const c = colors(ctx);
      // Solid backdrop so anything underneath doesn't bleed through.
      ctx.rect(x, y, w, h, { ch: " ", bg: c.bg, fg: c.bg });
      ctx.box(x, y, w, h, { glyphSet: "borderDouble", fg: c.borderFocus });
      if (title) {
        const label = ` ${title} `;
        const tx = x + Math.floor((w - label.length) / 2);
        ctx.text(tx, y, label, { fg: c.borderFocus, bold: true });
      }
      // Body — callable receives a sub-context-shaped object so it can draw
      // in local coords without knowing the outer offsets. We synthesize one
      // by reusing the parent ctx with the inner bounds.
      if (typeof body === "function") {
        const bx = x + 2, by = y + 2, bw = w - 4, bh = h - 4;
        body({
          width: bw,
          height: bh,
          theme: ctx.theme,
          put(px, py, ch, st) { if (px >= 0 && py >= 0 && px < bw && py < bh) ctx.put(bx + px, by + py, ch, st); },
          text(px, py, str, st) {
            if (!str) return;
            for (let i = 0; i < str.length; i++) {
              const cx = px + i;
              if (cx < 0) continue;
              if (cx >= bw || py < 0 || py >= bh) break;
              ctx.put(bx + cx, by + py, str[i], st);
            }
          },
        });
      } else if (typeof body === "string") {
        const lines = wrapLines(body, w - 4);
        for (let i = 0; i < lines.length && i < h - 4; i++) {
          ctx.text(x + 2, y + 2 + i, lines[i], { fg: c.fg });
        }
      }
      // Buttons
      const positions = buttonLayout();
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        const isFocused = i === btnIdx.value;
        if (isFocused) {
          ctx.text(p.x, p.row, `▶ ${buttons[i].label} ◀`, { fg: c.bg, bg: c.accent, bold: true });
        } else {
          ctx.text(p.x, p.row, p.label, { fg: c.fg });
        }
      }
    },
    onKey(e) {
      if (!focused.peek() || e.type !== "down") return false;
      if (e.key === "Escape") { close(null); return true; }
      if (e.key === "Tab" || e.key === "ArrowRight") {
        btnIdx.value = (btnIdx.peek() + 1) % buttons.length; return true;
      }
      if (e.key === "ArrowLeft") {
        btnIdx.value = (btnIdx.peek() - 1 + buttons.length) % buttons.length; return true;
      }
      if (e.key === "Enter" || e.key === " ") {
        close(buttons[btnIdx.peek()]?.value); return true;
      }
      return false;
    },
    onMouse(e) {
      if (e.type !== "click") return false;
      const positions = buttonLayout();
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        if (e.y === p.row && e.x >= p.x && e.x < p.x + p.w) {
          btnIdx.value = i;
          close(buttons[i].value);
          return true;
        }
      }
      return false;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// exports
// ────────────────────────────────────────────────────────────────

export default {
  createPanel,
  createButton,
  createInput,
  createTextArea,
  createList,
  createMenu,
  createTabs,
  createProgressBar,
  createSpinner,
  createDialog,
};
