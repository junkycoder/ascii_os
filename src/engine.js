import { signal, effect } from "./signals.js";
import { themes } from "./themes.js";

const EMPTY_CH = " ";

// ── Scroll tuning ────────────────────────────────────────────────────
// One place to make wheel (desktop) and touch-drag (mobile) feel right.
//  - WHEEL_PX_PER_LINE: pixels of wheel travel per scrolled text line. Higher
//    = slower. Decouples scroll speed from how OFTEN the OS fires wheel events
//    (macOS trackpads fire ~60/s, which used to scroll absurdly fast because
//    every event moved a whole line). We accumulate raw pixels and only emit a
//    line step once this threshold is crossed.
const WHEEL_PX_PER_LINE = 40;
// Browsers report wheel deltas in pixels (deltaMode 0), lines (1) or pages (2).
// Normalise everything to pixels so the accumulator is consistent across mice
// (often line/page mode) and trackpads (pixel mode).
function wheelToPixels(e) {
  if (e.deltaMode === 1) return e.deltaY * 16;   // lines → ~1 text line
  if (e.deltaMode === 2) return e.deltaY * 400;  // pages → ~one viewport
  return e.deltaY;                                // already pixels
}

function makeCell() {
  return { ch: EMPTY_CH, fg: null, bg: null, bold: false };
}

export function createEngine(opts = {}) {
  const target = typeof opts.target === "string"
    ? document.querySelector(opts.target)
    : opts.target;
  if (!target) throw new Error("createEngine: target not found");

  const theme = signal(opts.theme || themes["default-dark"]);
  const cols = signal(opts.cols || 80);
  const rows = signal(opts.rows || 30);
  const fpsCap = signal(opts.fps || 30);

  // Two buffers — current (committed to DOM) and next (being drawn).
  let curBuf = makeBuffer(cols.peek(), rows.peek());
  let nextBuf = makeBuffer(cols.peek(), rows.peek());

  // DOM mount
  const root = document.createElement("div");
  root.className = "acii-root";
  root.tabIndex = 0;
  const grid = document.createElement("div");
  grid.className = "acii-grid";
  root.appendChild(grid);
  target.appendChild(root);

  let spans = []; // 2D array [r][c] -> span

  function makeBuffer(c, r) {
    const buf = new Array(r);
    for (let y = 0; y < r; y++) {
      buf[y] = new Array(c);
      for (let x = 0; x < c; x++) buf[y][x] = makeCell();
    }
    return buf;
  }

  function buildGridDOM() {
    grid.innerHTML = "";
    spans = [];
    const c = cols.peek();
    const r = rows.peek();
    for (let y = 0; y < r; y++) {
      const row = document.createElement("div");
      row.className = "acii-row";
      const rowSpans = [];
      for (let x = 0; x < c; x++) {
        const sp = document.createElement("span");
        sp.className = "acii-cell";
        sp.textContent = EMPTY_CH;
        row.appendChild(sp);
        rowSpans.push(sp);
      }
      grid.appendChild(row);
      spans.push(rowSpans);
    }
  }

  function applyTheme() {
    const t = theme.value;
    root.style.setProperty("--acii-bg", t.colors.bg);
    root.style.setProperty("--acii-fg", t.colors.fg);
    root.style.setProperty("--acii-font", t.font.family);
    root.style.setProperty("--acii-size", t.font.size + "px");
    root.style.setProperty("--acii-aspect", t.font.cellAspect);
  }

  function resize(c, r) {
    cols.value = c;
    rows.value = r;
    curBuf = makeBuffer(c, r);
    nextBuf = makeBuffer(c, r);
    buildGridDOM();
    paintAll();
  }

  function clear() {
    const c = cols.peek();
    const r = rows.peek();
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const cell = nextBuf[y][x];
        cell.ch = EMPTY_CH;
        cell.fg = null;
        cell.bg = null;
        cell.bold = false;
      }
    }
  }

  function put(x, y, ch, style) {
    if (x < 0 || y < 0 || x >= cols.peek() || y >= rows.peek()) return;
    const cell = nextBuf[y][x];
    cell.ch = ch || EMPTY_CH;
    cell.fg = style?.fg ?? null;
    cell.bg = style?.bg ?? null;
    cell.bold = !!style?.bold;
  }

  function text(x, y, str, style) {
    if (!str) return;
    const c = cols.peek();
    for (let i = 0; i < str.length; i++) {
      const cx = x + i;
      if (cx >= c) break;
      put(cx, y, str[i], style);
    }
  }

  function rect(x, y, w, h, style) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        put(x + dx, y + dy, style?.ch || EMPTY_CH, style);
      }
    }
  }

  function box(x, y, w, h, style) {
    const g = theme.peek().glyphs[style?.glyphSet || "border"];
    text(x, y, g.tl + g.h.repeat(Math.max(0, w - 2)) + g.tr, style);
    text(x, y + h - 1, g.bl + g.h.repeat(Math.max(0, w - 2)) + g.br, style);
    for (let i = 1; i < h - 1; i++) {
      put(x, y + i, g.v, style);
      put(x + w - 1, y + i, g.v, style);
    }
  }

  function paintAll() {
    const c = cols.peek();
    const r = rows.peek();
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        applyCellToSpan(nextBuf[y][x], spans[y][x]);
        copyCell(nextBuf[y][x], curBuf[y][x]);
      }
    }
  }

  function copyCell(src, dst) {
    dst.ch = src.ch; dst.fg = src.fg; dst.bg = src.bg; dst.bold = src.bold;
  }

  function cellEq(a, b) {
    return a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold;
  }

  function applyCellToSpan(cell, sp) {
    if (sp.textContent !== cell.ch) sp.textContent = cell.ch;
    sp.style.color = cell.fg || "";
    sp.style.background = cell.bg || "";
    sp.style.fontWeight = cell.bold ? "700" : "";
  }

  function flush() {
    const c = cols.peek();
    const r = rows.peek();
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const nx = nextBuf[y][x];
        const cu = curBuf[y][x];
        if (!cellEq(nx, cu)) {
          applyCellToSpan(nx, spans[y][x]);
          copyCell(nx, cu);
        }
      }
    }
  }

  // ── Animation loop ──────────────────────────────────────────────
  const frameHandlers = new Set();
  function onFrame(fn) { frameHandlers.add(fn); return () => frameHandlers.delete(fn); }

  let running = false;
  let lastT = 0;
  let lastFlushT = 0;
  let frames = 0;
  let fpsAcc = 0;
  let fpsLast = performance.now();
  const fps = signal(0);

  function tick(t) {
    if (!running) return;
    const dt = lastT === 0 ? 0 : t - lastT;
    lastT = t;
    const minDt = 1000 / fpsCap.peek();
    if (t - lastFlushT >= minDt) {
      lastFlushT = t;
      for (const h of frameHandlers) h(dt, t);
      flush();
      frames++;
      fpsAcc += dt;
      if (t - fpsLast >= 500) {
        fps.value = Math.round((frames * 1000) / (t - fpsLast));
        frames = 0;
        fpsLast = t;
      }
    }
    schedule();
  }

  function schedule() {
    // RAF when tab is visible (vsync-aligned), fallback to setTimeout
    // when hidden so the engine keeps ticking for background work.
    if (document.hidden) {
      setTimeout(() => tick(performance.now()), 1000 / fpsCap.peek());
    } else {
      requestAnimationFrame(tick);
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastT = 0;
    lastFlushT = 0;
    fpsLast = performance.now();
    schedule();
  }
  function stop() { running = false; }

  // ── Inputs ──────────────────────────────────────────────────────
  const keyHandlers = new Set();
  const mouseHandlers = new Set();
  const keysDown = new Set();

  function onKey(fn) { keyHandlers.add(fn); return () => keyHandlers.delete(fn); }
  function onMouse(fn) { mouseHandlers.add(fn); return () => mouseHandlers.delete(fn); }
  function isKeyDown(k) { return keysDown.has(k); }

  root.addEventListener("keydown", (e) => {
    keysDown.add(e.key);
    for (const h of keyHandlers) h({ type: "down", key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, raw: e });
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
  });
  root.addEventListener("keyup", (e) => {
    keysDown.delete(e.key);
    for (const h of keyHandlers) h({ type: "up", key: e.key, code: e.code, raw: e });
  });

  function cellFromEvent(e) {
    const rect = grid.getBoundingClientRect();
    const cw = rect.width / cols.peek();
    const ch = rect.height / rows.peek();
    const x = Math.floor((e.clientX - rect.left) / cw);
    const y = Math.floor((e.clientY - rect.top) / ch);
    return { x, y };
  }
  // Suppress browser text-selection during drag.
  // We still allow selection via dbl-click / triple-click / shift-click.
  root.addEventListener("selectstart", (e) => {
    if (e.detail && e.detail >= 2) return; // dbl/triple click — let it select
    e.preventDefault();
  });
  let wheelAccum = 0; // pixels of wheel travel not yet turned into a line step
  ["mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel"].forEach((evt) => {
    root.addEventListener(evt, (e) => {
      if (evt === "mousedown" && e.button === 0 && !e.shiftKey) {
        // Block browser from starting a text selection on left-click drags.
        // preventDefault() also suppresses the browser's default focus-on-click,
        // so once root lost keyboard focus (clicking browser chrome, a dialog,
        // another tab) a click back into the grid wouldn't restore it and keys
        // went nowhere. Refocus explicitly so typing always works after a click.
        e.preventDefault();
        if (document.activeElement !== root) root.focus({ preventScroll: true });
      }
      const { x, y } = cellFromEvent(e);
      if (evt === "wheel") {
        // Accumulate pixels and emit a normalised integer `lines` step so scroll
        // speed tracks distance travelled, not OS event frequency. Reset on a
        // direction flip so reversing feels immediate.
        const px = wheelToPixels(e);
        if ((px < 0) !== (wheelAccum < 0)) wheelAccum = 0;
        wheelAccum += px;
        const lines = (wheelAccum / WHEEL_PX_PER_LINE) | 0; // trunc toward 0
        wheelAccum -= lines * WHEEL_PX_PER_LINE;
        for (const h of mouseHandlers) h({ type: evt, x, y, button: e.button, deltaY: e.deltaY, lines, raw: e });
        return;
      }
      for (const h of mouseHandlers) h({ type: evt, x, y, button: e.button, deltaY: e.deltaY, raw: e });
    });
  });

  // ── Context menu (right-click) ───────────────────────────────────
  // Browser fires `contextmenu` on right-click (and Ctrl-click on Mac).
  // We swallow the native menu and dispatch our own event to handlers.
  const contextHandlers = new Set();
  function onContextMenu(fn) { contextHandlers.add(fn); return () => contextHandlers.delete(fn); }
  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { x, y } = cellFromEvent(e);
    for (const h of contextHandlers) h({ x, y, raw: e });
  });

  // ── File drop ────────────────────────────────────────────────────
  // Accepts files dragged onto the engine root. Each file is delivered with
  // lazy readers so handlers can pick the right format.
  const dropHandlers = new Set();
  const dropOverHandlers = new Set();
  function onFileDrop(fn) { dropHandlers.add(fn); return () => dropHandlers.delete(fn); }
  function onDragOver(fn) { dropOverHandlers.add(fn); return () => dropOverHandlers.delete(fn); }

  function wrapFile(f) {
    return {
      name: f.name,
      type: f.type,
      size: f.size,
      lastModified: f.lastModified,
      raw: f,
      asText: () => f.text(),
      asArrayBuffer: () => f.arrayBuffer(),
      asDataUrl: () => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }),
    };
  }

  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const { x, y } = cellFromEvent(e);
    for (const h of dropOverHandlers) h({ x, y, raw: e });
  });
  root.addEventListener("dragleave", (e) => {
    const { x, y } = cellFromEvent(e);
    for (const h of dropOverHandlers) h({ x, y, leaving: true, raw: e });
  });
  root.addEventListener("drop", async (e) => {
    e.preventDefault();
    const { x, y } = cellFromEvent(e);
    const files = e.dataTransfer ? [...e.dataTransfer.files].map(wrapFile) : [];
    for (const h of dropHandlers) {
      try { await h({ x, y, files, raw: e }); }
      catch (err) { console.error("file drop handler", err); }
    }
  });

  // Initial setup
  buildGridDOM();
  applyTheme();
  paintAll();
  effect(() => { applyTheme(); /* track theme */ const _ = theme.value; });
  root.focus();

  // ── Touch ───────────────────────────────────────────────────────
  const touchHandlers = new Set();
  function onTouch(fn) { touchHandlers.add(fn); return () => touchHandlers.delete(fn); }

  let touchStart = null;     // {x, y, t} in cells/ms
  let lastTouch = null;      // {x, y} of the previous move — for per-step deltas
  let lastTapT = 0;
  let lastTapPos = null;
  let longPressTimer = null;

  function cellFromTouch(t) {
    const rect = grid.getBoundingClientRect();
    const cw = rect.width / cols.peek();
    const ch = rect.height / rows.peek();
    return {
      x: Math.floor((t.clientX - rect.left) / cw),
      y: Math.floor((t.clientY - rect.top) / ch),
    };
  }
  function dispatchTouch(ev) { for (const h of touchHandlers) h(ev); }

  root.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const { x, y } = cellFromTouch(e.touches[0]);
    touchStart = { x, y, t: performance.now() };
    lastTouch = { x, y };
    dispatchTouch({ type: "start", x, y });
    longPressTimer = setTimeout(() => {
      if (touchStart) dispatchTouch({ type: "longpress", x, y });
    }, 500);
    e.preventDefault();
  }, { passive: false });
  root.addEventListener("touchmove", (e) => {
    if (!touchStart || e.touches.length !== 1) return;
    const { x, y } = cellFromTouch(e.touches[0]);
    // sx/sy = movement since the previous move event (cells). Apps use these for
    // continuous, finger-tracking scroll — a whole gesture no longer collapses
    // into one fixed-size `swipe` step at touchend (which felt far too slow).
    const sx = x - lastTouch.x, sy = y - lastTouch.y;
    dispatchTouch({ type: "move", x, y, dx: x - touchStart.x, dy: y - touchStart.y, sx, sy });
    lastTouch = { x, y };
    if (longPressTimer && (Math.abs(x - touchStart.x) > 1 || Math.abs(y - touchStart.y) > 1)) {
      clearTimeout(longPressTimer); longPressTimer = null;
    }
    e.preventDefault();
  }, { passive: false });
  root.addEventListener("touchend", (e) => {
    if (!touchStart) return;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    const dt = performance.now() - touchStart.t;
    const last = e.changedTouches[0];
    const { x, y } = cellFromTouch(last);
    const dx = x - touchStart.x, dy = y - touchStart.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dt < 250 && dist <= 1) {
      // tap
      const now = performance.now();
      if (lastTapPos && now - lastTapT < 350 &&
          Math.abs(lastTapPos.x - x) < 2 && Math.abs(lastTapPos.y - y) < 2) {
        dispatchTouch({ type: "doubletap", x, y });
        lastTapT = 0; lastTapPos = null;
      } else {
        dispatchTouch({ type: "tap", x, y });
        lastTapT = now; lastTapPos = { x, y };
      }
    } else if (dist > 2) {
      const dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? "right" : "left")
        : (dy > 0 ? "down" : "up");
      dispatchTouch({ type: "swipe", x, y, dx, dy, dir });
    }
    dispatchTouch({ type: "end", x, y });
    touchStart = null;
  });

  // ── Responsive mode ─────────────────────────────────────────────
  const mode = signal("desktop");
  function recomputeMode() {
    const c = cols.peek();
    if (c <= 25) mode.value = "watch";
    else if (c <= 60) mode.value = "mobile";
    else if (c <= 100) mode.value = "tablet";
    else if (c <= 160) mode.value = "desktop";
    else mode.value = "tv";
  }
  effect(() => { const _ = cols.value; recomputeMode(); });

  // ── Sub-context (windowed drawing in local coords) ──────────────
  function subContext(bounds) {
    const b = bounds; // {x, y, w, h}
    function clip(x, y) {
      return x >= 0 && y >= 0 && x < b.w && y < b.h;
    }
    return {
      width: b.w,
      height: b.h,
      theme,
      fps,
      mode,
      put(x, y, ch, style) {
        if (!clip(x, y)) return;
        put(b.x + x, b.y + y, ch, style);
      },
      text(x, y, str, style) {
        if (!str) return;
        for (let i = 0; i < str.length; i++) {
          const cx = x + i;
          if (cx < 0) continue;
          if (cx >= b.w) break;
          if (y < 0 || y >= b.h) break;
          put(b.x + cx, b.y + y, str[i], style);
        }
      },
      rect(x, y, w, h, style) {
        for (let dy = 0; dy < h; dy++)
          for (let dx = 0; dx < w; dx++)
            if (clip(x + dx, y + dy))
              put(b.x + x + dx, b.y + y + dy, style?.ch || " ", style);
      },
      box(x, y, w, h, style) {
        const g = theme.peek().glyphs[style?.glyphSet || "border"];
        const right = g.tl + g.h.repeat(Math.max(0, w - 2)) + g.tr;
        this.text(x, y, right, style);
        this.text(x, y + h - 1, g.bl + g.h.repeat(Math.max(0, w - 2)) + g.br, style);
        for (let i = 1; i < h - 1; i++) {
          this.put(x, y + i, g.v, style);
          this.put(x + w - 1, y + i, g.v, style);
        }
      },
    };
  }

  return {
    root,
    theme,
    cols, rows, fps, mode,
    resize, clear, put, text, rect, box,
    subContext,
    onFrame, onKey, onMouse, onTouch, onContextMenu, onFileDrop, onDragOver, isKeyDown,
    start, stop,
    flush, // manual flush (for static scenes)
    themes,
  };
}

export { signal, effect, themes };
