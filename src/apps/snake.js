// Snake — classic. Mounts into a window; coords are LOCAL to ctx.
// Engine API used: ctx.put/text/rect, ctx.width/height (signals), ctx.theme.peek().
// Input is routed by the window manager: onKey/onMouse/onTouch.

import { signal } from '../signals.js';

const TICK_MS = 150;
const BEST_KEY = 'acii.snake.best';

// Directions
const DIRS = {
  up:    { dx: 0,  dy: -1 },
  down:  { dx: 0,  dy:  1 },
  left:  { dx: -1, dy:  0 },
  right: { dx: 1,  dy:  0 },
};

function opposite(a, b) {
  return a.dx === -b.dx && a.dy === -b.dy;
}

function readBest() {
  try {
    const v = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch { return 0; }
}

function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch {}
}

export function createApp(initialCtx, win) {
  // Reserve top row for the status line.
  const STATUS_H = 1;

  // ---- State ----------------------------------------------------------------
  const score    = signal(0);
  const best     = signal(readBest());
  const paused   = signal(false);
  const gameOver = signal(false);

  // Snake stored as array of {x, y}; head is index 0.
  let snake = [];
  // Pending direction (applied on next tick — prevents 180° in single frame).
  let dir = DIRS.right;
  let queuedDir = DIRS.right;
  let food = { x: 0, y: 0 };

  // Track playfield size (the area below the status line). Resize on demand.
  let fieldW = Math.max(8, (initialCtx.width?.peek?.() ?? initialCtx.width ?? 40));
  let fieldH = Math.max(6, (initialCtx.height?.peek?.() ?? initialCtx.height ?? 20) - STATUS_H);

  let lastTick = performance.now();

  // ---- Helpers --------------------------------------------------------------
  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < fieldW && y < fieldH;
  }

  function occupied(x, y) {
    for (let i = 0; i < snake.length; i++) {
      if (snake[i].x === x && snake[i].y === y) return true;
    }
    return false;
  }

  function placeFood() {
    // Defensive: if the snake fills the field, just bail (won't happen in practice).
    const total = fieldW * fieldH;
    if (snake.length >= total) { food = { x: -1, y: -1 }; return; }
    let x, y, tries = 0;
    do {
      x = (Math.random() * fieldW) | 0;
      y = (Math.random() * fieldH) | 0;
      tries++;
      if (tries > 500) break; // safety
    } while (occupied(x, y));
    food = { x, y };
  }

  function reset() {
    const cx = (fieldW / 2) | 0;
    const cy = (fieldH / 2) | 0;
    snake = [
      { x: cx + 1, y: cy },
      { x: cx,     y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
    dir = DIRS.right;
    queuedDir = DIRS.right;
    score.value = 0;
    paused.value = false;
    gameOver.value = false;
    placeFood();
    lastTick = performance.now();
  }

  function step() {
    if (gameOver.peek() || paused.peek()) return;

    // Apply queued direction unless it would reverse the snake.
    if (!opposite(queuedDir, dir)) dir = queuedDir;

    const head = snake[0];
    const nx = head.x + dir.dx;
    const ny = head.y + dir.dy;

    // Wall collision.
    if (!inBounds(nx, ny)) { endGame(); return; }

    // Self collision — ignore tail tip if we're not eating (it will move out).
    const eating = (nx === food.x && ny === food.y);
    const checkLen = eating ? snake.length : snake.length - 1;
    for (let i = 0; i < checkLen; i++) {
      if (snake[i].x === nx && snake[i].y === ny) { endGame(); return; }
    }

    snake.unshift({ x: nx, y: ny });
    if (eating) {
      score.value = score.peek() + 1;
      if (score.peek() > best.peek()) {
        best.value = score.peek();
        writeBest(best.peek());
      }
      placeFood();
    } else {
      snake.pop();
    }
  }

  function endGame() {
    gameOver.value = true;
  }

  // Initialize.
  reset();

  // ---- Render ---------------------------------------------------------------
  function render(ctx) {
    const W = ctx.width.peek ? ctx.width.peek() : ctx.width;
    const H = ctx.height.peek ? ctx.height.peek() : ctx.height;
    if (W < 4 || H < 3) return;

    // Detect resize — adjust the field. If snake leaves the new bounds, restart.
    const newFieldW = W;
    const newFieldH = Math.max(1, H - STATUS_H);
    if (newFieldW !== fieldW || newFieldH !== fieldH) {
      fieldW = newFieldW;
      fieldH = newFieldH;
      // If anything is out of bounds after resize, restart cleanly.
      let outOfBounds = false;
      for (const seg of snake) if (!inBounds(seg.x, seg.y)) { outOfBounds = true; break; }
      if (outOfBounds || !inBounds(food.x, food.y)) reset();
    }

    // Tick driver: time-based, independent of render fps.
    const now = performance.now();
    while (now - lastTick >= TICK_MS) {
      lastTick += TICK_MS;
      step();
    }

    const colors = ctx.theme.peek().colors;

    // Status line (row 0).
    const status = `Score: ${score.peek()}  Best: ${best.peek()}${paused.peek() ? '  [paused]' : ''}`;
    // Clear status row to background then write text.
    ctx.rect(0, 0, W, 1, { ch: ' ', fg: colors.fgDim, bg: colors.bg });
    ctx.text(0, 0, status.slice(0, W), { fg: colors.fgDim });

    // Playfield background (clear it explicitly — we own this area).
    ctx.rect(0, STATUS_H, W, H - STATUS_H, { ch: ' ', fg: colors.fg, bg: colors.bg });

    // Food.
    if (food.x >= 0) {
      ctx.put(food.x, food.y + STATUS_H, '*', { fg: colors.warning, bold: true });
    }

    // Snake body then head.
    for (let i = snake.length - 1; i >= 1; i--) {
      const s = snake[i];
      ctx.put(s.x, s.y + STATUS_H, '█', { fg: colors.accent });
    }
    if (snake.length > 0) {
      const h = snake[0];
      ctx.put(h.x, h.y + STATUS_H, 'O', { fg: colors.success, bold: true });
    }

    // Game over overlay.
    if (gameOver.peek()) {
      const msg = 'GAME OVER  press R';
      const mx = Math.max(0, ((W - msg.length) / 2) | 0);
      const my = STATUS_H + Math.max(0, ((H - STATUS_H) / 2) | 0);
      ctx.text(mx, my, msg, { fg: colors.error, bold: true });
    }
  }

  // ---- Input ----------------------------------------------------------------
  function setDir(d) {
    if (gameOver.peek()) return;
    // Only update the queue; the tick gates against reversing.
    if (!opposite(d, dir)) queuedDir = d;
  }

  function onKey(e) {
    if (e.type !== 'down') return;
    const k = (e.key || '').toLowerCase();
    // arrows · WASD · vim HJKL (all coexist)
    if (k === 'arrowup'    || k === 'w' || k === 'k') { setDir(DIRS.up);    return; }
    if (k === 'arrowdown'  || k === 's' || k === 'j') { setDir(DIRS.down);  return; }
    if (k === 'arrowleft'  || k === 'a' || k === 'h') { setDir(DIRS.left);  return; }
    if (k === 'arrowright' || k === 'd' || k === 'l') { setDir(DIRS.right); return; }
    if (k === ' ' || e.code === 'Space') {
      if (!gameOver.peek()) paused.value = !paused.peek();
      return;
    }
    if (k === 'r') { reset(); return; }
  }

  function onMouse(_e) { /* no-op: snake is keyboard/touch */ }

  function onTouch(e) {
    if (e.type === 'tap') {
      if (gameOver.peek()) { reset(); return; }
      paused.value = !paused.peek();
      return;
    }
    if (e.type === 'swipe') {
      // dir is provided by engine; fall back to dx/dy if absent.
      let d = e.dir;
      if (!d) {
        const dx = e.dx ?? 0, dy = e.dy ?? 0;
        if (Math.abs(dx) > Math.abs(dy)) d = dx > 0 ? 'right' : 'left';
        else                              d = dy > 0 ? 'down'  : 'up';
      }
      if (DIRS[d]) setDir(DIRS[d]);
    }
  }

  function destroy() {
    // Nothing async to tear down — tick is driven by render().
  }

  return { render, onKey, onMouse, onTouch, destroy };
}
