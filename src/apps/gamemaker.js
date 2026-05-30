// GameMaker — grid-based game editor + play mode.
//
// Two modes:
//   EDITOR: paint tiles onto a grid. Each tile has a glyph + color + behavior
//           tag (wall / player / goal / enemy / empty).
//   PLAY:   spawn the player at the first 'player' tile, arrows to move,
//           walls block, goal wins, enemies wander and kill on contact.
//
// Layout (editor mode):
//   left pane (≈⅔ width)  -> game grid (default 30×20 cells)
//   right pane           -> brush settings (char/color/tag) + action buttons
//   bottom row           -> tile count + mode indicator
//
// Layout (play mode):
//   whole window         -> game area (right pane hidden)
//   bottom row           -> hints
//
// TODO: load sprite from /desktop/*.acii via fs.js (replace brush glyph
//       with multi-cell sprite import for richer tiles).
// TODO: play audio cue on win/lose via media.js (success ding, lose buzz).
// TODO: video background via media.js (loop a clip behind the grid).
//
// Coords here are all LOCAL to the app's window via `ctx`. The window
// manager owns the engine frame/input loop; we just react to render() and
// the event callbacks it forwards to us.

import { signal } from '../signals.js';

const STORAGE_KEY = 'acii.gamemaker.level';

// Available brush characters — cycle with [ and ].
const BRUSH_CHARS = ['#', '@', '$', 'x', 'o', '*', '.', '=', '~', '+', '%'];

// Theme color names — cycle with ; / '. Stored by name so theme swaps
// reskin levels automatically.
const BRUSH_COLORS = ['fg', 'accent', 'error', 'warning', 'success', 'link', 'fgDim'];

// Behavior tags — cycle with , / .
// 'empty' is the eraser; 'player' should be unique but we don't enforce it.
const BRUSH_TAGS = ['wall', 'player', 'goal', 'enemy', 'empty'];

// Default suggestions per tag so cycling tag also nudges glyph/color
// to something sensible — the user can still override afterwards.
const TAG_DEFAULTS = {
  wall:   { ch: '#', color: 'fg' },
  player: { ch: '@', color: 'accent' },
  goal:   { ch: '$', color: 'success' },
  enemy:  { ch: 'x', color: 'error' },
  empty:  { ch: ' ', color: 'fg' },
};

// Default grid size — fits comfortably inside a typical window.
const DEFAULT_W = 30;
const DEFAULT_H = 20;

// Enemy tick interval in ms.
const ENEMY_TICK_MS = 300;

export function createApp(initialCtx, win) {
  // ── State ──────────────────────────────────────────────────────
  // Level is a Map keyed by "x,y" -> { ch, fg (color name), tag }.
  // Sparse storage keeps save files small and lookups O(1).
  let level = new Map();
  let gridW = DEFAULT_W;
  let gridH = DEFAULT_H;

  const mode = signal('editor'); // 'editor' | 'play'
  const brushCharIdx = signal(0);
  const brushColorIdx = signal(1);    // start on 'accent' so paints are visible
  const brushTagIdx = signal(0);      // start on 'wall'
  const status = signal('');
  let statusUntil = 0;

  // Pointer drag state (mouse + touch share this path).
  let dragging = false;
  let lastPaintKey = '';

  // Play-mode state.
  let player = null;                  // { x, y } or null if no player tile
  let enemies = [];                   // [{ x, y }, ...]
  let playState = 'running';          // 'running' | 'won' | 'dead'
  let enemyTimer = null;              // setInterval handle

  // ── Helpers ────────────────────────────────────────────────────
  const key = (x, y) => x + ',' + y;

  function setStatus(msg, ms = 1500) {
    status.value = msg;
    statusUntil = performance.now() + ms;
  }

  function setBrushTag(idx) {
    brushTagIdx.value = idx;
    // Snap glyph/color to the tag's defaults so the user sees consistent
    // visuals — they can still override after the snap.
    const tag = BRUSH_TAGS[idx];
    const def = TAG_DEFAULTS[tag];
    if (def) {
      const ci = BRUSH_CHARS.indexOf(def.ch);
      if (ci >= 0) brushCharIdx.value = ci;
      const ki = BRUSH_COLORS.indexOf(def.color);
      if (ki >= 0) brushColorIdx.value = ki;
    }
  }

  function paintAt(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return;
    const tag = BRUSH_TAGS[brushTagIdx.peek()];
    if (tag === 'empty') {
      level.delete(key(gx, gy));
      return;
    }
    const ch = BRUSH_CHARS[brushCharIdx.peek()];
    const fg = BRUSH_COLORS[brushColorIdx.peek()];
    level.set(key(gx, gy), { ch, fg, tag });
  }

  function clearLevel() {
    level = new Map();
    setStatus('cleared');
  }

  function save() {
    try {
      const arr = [];
      for (const [k, t] of level) {
        const [x, y] = k.split(',').map(Number);
        arr.push({ x, y, ch: t.ch, fg: t.fg, tag: t.tag });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        w: gridW, h: gridH, tiles: arr,
      }));
    } catch (err) { /* silent — storage may be disabled */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tiles)) return;
      if (data.w) gridW = data.w | 0;
      if (data.h) gridH = data.h | 0;
      level = new Map();
      for (const t of data.tiles) {
        if (typeof t.x !== 'number' || typeof t.y !== 'number') continue;
        level.set(key(t.x, t.y), {
          ch: t.ch || '#',
          fg: t.fg || 'fg',
          tag: t.tag || 'wall',
        });
      }
    } catch (err) { /* ignore corrupt save */ }
  }

  // ── Play mode lifecycle ────────────────────────────────────────
  function startPlay() {
    // Snapshot player + enemies from the level. The level Map is
    // untouched during play so 'E' returns the user to exactly what
    // they painted.
    player = null;
    enemies = [];
    for (const [k, t] of level) {
      const [x, y] = k.split(',').map(Number);
      if (t.tag === 'player' && !player) player = { x, y };
      else if (t.tag === 'enemy') enemies.push({ x, y });
    }
    if (!player) {
      setStatus('place a player tile first (@ / tag=player)', 2500);
      return;
    }
    playState = 'running';
    mode.value = 'play';
    if (enemyTimer) clearInterval(enemyTimer);
    enemyTimer = setInterval(stepEnemies, ENEMY_TICK_MS);
  }

  function stopPlay() {
    mode.value = 'editor';
    if (enemyTimer) { clearInterval(enemyTimer); enemyTimer = null; }
  }

  // Lookup what's at a grid cell for collision purposes. Player &
  // enemies aren't in the level Map during play (they're sprites on top),
  // so we only need to consult level tiles.
  function tileAt(x, y) {
    return level.get(key(x, y)) || null;
  }

  function isWall(x, y) {
    const t = tileAt(x, y);
    return !!(t && t.tag === 'wall');
  }

  function tryMovePlayer(dx, dy) {
    if (playState !== 'running' || !player) return;
    const nx = player.x + dx, ny = player.y + dy;
    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) return;
    if (isWall(nx, ny)) return;
    player.x = nx; player.y = ny;
    checkCollisions();
  }

  function checkCollisions() {
    if (!player) return;
    const t = tileAt(player.x, player.y);
    if (t && t.tag === 'goal') { playState = 'won'; return; }
    for (const e of enemies) {
      if (e.x === player.x && e.y === player.y) { playState = 'dead'; return; }
    }
  }

  function stepEnemies() {
    if (playState !== 'running') return;
    // Random walk: pick a direction, only move if free. Enemies can't
    // pass through walls or stack on each other; players standing in the
    // target square get caught (which kills them — checked below).
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[0,0]]; // 0,0 = stay
    for (const e of enemies) {
      const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
      const nx = e.x + dx, ny = e.y + dy;
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      if (isWall(nx, ny)) continue;
      if (enemies.some(o => o !== e && o.x === nx && o.y === ny)) continue;
      e.x = nx; e.y = ny;
    }
    checkCollisions();
  }

  // ── Render ─────────────────────────────────────────────────────
  function render(ctx) {
    const W = ctx.width, H = ctx.height;
    if (W < 10 || H < 5) return;
    const colors = ctx.theme.peek().colors;

    if (mode.peek() === 'editor') renderEditor(ctx, W, H, colors);
    else renderPlay(ctx, W, H, colors);
  }

  function renderEditor(ctx, W, H, colors) {
    // Layout split: right pane is ~20 cols wide (clamped). Leave 1
    // row at the bottom for status.
    const sideW = Math.min(22, Math.max(16, Math.floor(W * 0.32)));
    const gridPaneW = W - sideW - 1; // -1 for separator
    const gridPaneH = H - 1;

    // Visible grid area — clamp to whichever is smaller.
    const visW = Math.min(gridW, gridPaneW);
    const visH = Math.min(gridH, gridPaneH);

    // Paint grid background and tiles.
    for (let y = 0; y < visH; y++) {
      for (let x = 0; x < visW; x++) {
        const t = level.get(key(x, y));
        if (t) {
          const fg = colors[t.fg] || colors.fg;
          ctx.put(x, y, t.ch, { fg, bg: colors.bg });
        } else {
          // Faint grid dots every 5 cells so the empty space stays legible.
          const dot = (x % 5 === 0 && y % 5 === 0) ? '·' : ' ';
          ctx.put(x, y, dot, { fg: colors.fgDim, bg: colors.bg });
        }
      }
    }

    // Separator between grid and side panel.
    const sepX = gridPaneW;
    for (let y = 0; y < gridPaneH; y++) {
      ctx.put(sepX, y, '│', { fg: colors.border, bg: colors.bg });
    }

    // ── Side panel ────────────────────────────────────────────
    const px = sepX + 1;
    let py = 0;
    const tag = BRUSH_TAGS[brushTagIdx.peek()];
    const ch = BRUSH_CHARS[brushCharIdx.peek()];
    const col = BRUSH_COLORS[brushColorIdx.peek()];

    ctx.text(px + 1, py++, 'BRUSH', { fg: colors.accent, bold: true });
    py++;
    ctx.text(px + 1, py, 'char:', { fg: colors.fgDim });
    ctx.put(px + 7, py, ch, { fg: colors[col] || colors.fg, bold: true });
    ctx.text(px + 9, py++, '[ ]', { fg: colors.fgDim });
    ctx.text(px + 1, py, 'color:', { fg: colors.fgDim });
    ctx.put(px + 8, py, '█', { fg: colors[col] || colors.fg });
    ctx.text(px + 10, py++, '; \'', { fg: colors.fgDim });
    ctx.text(px + 1, py, 'tag:', { fg: colors.fgDim });
    ctx.text(px + 6, py, tag.padEnd(7), { fg: colors[col] || colors.fg, bold: true });
    ctx.text(px + 13, py++, ', .', { fg: colors.fgDim });

    py++;
    // Tag list — click to pick.
    ctx.text(px + 1, py++, 'TAGS', { fg: colors.accent, bold: true });
    for (let i = 0; i < BRUSH_TAGS.length; i++) {
      const sel = i === brushTagIdx.peek();
      const label = (sel ? '▶ ' : '  ') + BRUSH_TAGS[i];
      ctx.text(px + 1, py + i, label.padEnd(sideW - 2), {
        fg: sel ? colors.bg : colors.fg,
        bg: sel ? colors.accent : colors.bg,
        bold: sel,
      });
    }
    py += BRUSH_TAGS.length + 1;

    // Action buttons.
    drawButton(ctx, px + 1, py, '[ play ]', colors, colors.success);
    drawButton(ctx, px + 11, py, '[clear]', colors, colors.error);
    py += 2;
    ctx.text(px + 1, py++, 'P play  E edit', { fg: colors.fgDim });
    ctx.text(px + 1, py++, 'C clear S save', { fg: colors.fgDim });

    // Bottom status row.
    const sy = H - 1;
    ctx.rect(0, sy, W, 1, { ch: ' ', bg: colors.bg, fg: colors.fgDim });
    const showStatus = status.peek() && performance.now() < statusUntil;
    const baseMsg = `editor · ${level.size} tiles · ${gridW}×${gridH}`;
    const msg = showStatus ? status.peek() : baseMsg;
    ctx.text(0, sy, msg.slice(0, W), { fg: colors.fgDim, bg: colors.bg });
  }

  function drawButton(ctx, x, y, label, colors, fg) {
    ctx.text(x, y, label, { fg, bold: true });
  }

  function renderPlay(ctx, W, H, colors) {
    const visW = Math.min(gridW, W);
    const visH = Math.min(gridH, H - 1);

    // Tiles.
    for (let y = 0; y < visH; y++) {
      for (let x = 0; x < visW; x++) {
        const t = level.get(key(x, y));
        if (t && t.tag !== 'player' && t.tag !== 'enemy') {
          // Don't render player/enemy tiles from the level — they're
          // drawn as sprites below so their starting cell is "empty".
          const fg = colors[t.fg] || colors.fg;
          ctx.put(x, y, t.ch, { fg, bg: colors.bg });
        } else {
          ctx.put(x, y, ' ', { bg: colors.bg });
        }
      }
    }
    // Enemies on top.
    for (const e of enemies) {
      if (e.x < visW && e.y < visH) {
        ctx.put(e.x, e.y, 'x', { fg: colors.error, bold: true });
      }
    }
    // Player on top.
    if (player && player.x < visW && player.y < visH) {
      ctx.put(player.x, player.y, '@', { fg: colors.accent, bold: true });
    }

    // Overlays for terminal states.
    if (playState === 'won') {
      drawCenterOverlay(ctx, W, H,
        ['YOU WIN!', 'Press E to edit · R to retry'],
        colors, colors.success);
    } else if (playState === 'dead') {
      drawCenterOverlay(ctx, W, H,
        ['GAME OVER', 'R to retry · E to edit'],
        colors, colors.error);
    }

    // Status row.
    const sy = H - 1;
    ctx.rect(0, sy, W, 1, { ch: ' ', bg: colors.bg, fg: colors.fgDim });
    const hint = playState === 'running'
      ? 'arrows move · E edit · R restart'
      : 'R retry · E edit';
    ctx.text(0, sy, ('play · ' + hint).slice(0, W), { fg: colors.fgDim, bg: colors.bg });
  }

  function drawCenterOverlay(ctx, W, H, lines, colors, accentFg) {
    const boxW = Math.max(...lines.map(l => l.length)) + 4;
    const boxH = lines.length + 2;
    const bx = Math.max(0, Math.floor((W - boxW) / 2));
    const by = Math.max(0, Math.floor((H - boxH) / 2));
    ctx.rect(bx, by, boxW, boxH, { ch: ' ', bg: colors.bg, fg: colors.fg });
    ctx.box(bx, by, boxW, boxH, { fg: accentFg, glyphSet: 'borderDouble' });
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const lx = bx + Math.floor((boxW - l.length) / 2);
      ctx.text(lx, by + 1 + i, l, {
        fg: i === 0 ? accentFg : colors.fg,
        bg: colors.bg,
        bold: i === 0,
      });
    }
  }

  // ── Input ──────────────────────────────────────────────────────
  function onKey(e) {
    if (e.type !== 'down') return;
    const k = (e.key || '').toLowerCase();

    if (mode.peek() === 'play') {
      if (k === 'e') { stopPlay(); return; }
      if (k === 'r') { startPlay(); return; }
      if (playState !== 'running') return;
      if (e.key === 'ArrowUp')    { tryMovePlayer(0, -1); return; }
      if (e.key === 'ArrowDown')  { tryMovePlayer(0, 1);  return; }
      if (e.key === 'ArrowLeft')  { tryMovePlayer(-1, 0); return; }
      if (e.key === 'ArrowRight') { tryMovePlayer(1, 0);  return; }
      return;
    }

    // Editor hotkeys.
    if (k === '[') { brushCharIdx.value = (brushCharIdx.peek() - 1 + BRUSH_CHARS.length) % BRUSH_CHARS.length; return; }
    if (k === ']') { brushCharIdx.value = (brushCharIdx.peek() + 1) % BRUSH_CHARS.length; return; }
    if (k === ';') { brushColorIdx.value = (brushColorIdx.peek() - 1 + BRUSH_COLORS.length) % BRUSH_COLORS.length; return; }
    if (k === "'") { brushColorIdx.value = (brushColorIdx.peek() + 1) % BRUSH_COLORS.length; return; }
    if (k === ',') { setBrushTag((brushTagIdx.peek() - 1 + BRUSH_TAGS.length) % BRUSH_TAGS.length); return; }
    if (k === '.') { setBrushTag((brushTagIdx.peek() + 1) % BRUSH_TAGS.length); return; }
    if (k === 'p') { save(); startPlay(); return; }
    if (k === 'c') { clearLevel(); save(); return; }
    if (k === 's') { save(); setStatus('saved'); return; }
    if (k === 'e') { /* already in editor */ return; }
  }

  function onMouse(e) {
    if (mode.peek() === 'play') return; // play mode is keyboard-only
    const { type, x, y } = e;

    // Side panel hit-testing depends on render's sideW formula. We don't
    // have ctx here, but the WM clamps app coords to the window so we can
    // derive sideW from the *last known* canvas dims. Simpler: just check
    // whether the click lands in the action button row (right column).
    if (type === 'mousedown' && e.button === 0) {
      // Editor click: try side-panel first, then grid paint.
      if (handleSidePanelClick(x, y)) return;
      dragging = true;
      lastPaintKey = '';
      paintGridFromClick(x, y);
    } else if (type === 'mousemove' && dragging) {
      paintGridFromClick(x, y);
    } else if (type === 'mouseup' || type === 'click') {
      dragging = false;
      lastPaintKey = '';
      save(); // autosave at end of stroke
    }
  }

  function paintGridFromClick(x, y) {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    const k = key(x, y);
    if (k === lastPaintKey) return; // skip duplicate paints on the same cell
    paintAt(x, y);
    lastPaintKey = k;
  }

  // The side panel layout is recomputed here from a cached width we
  // can't see — instead we hit-test based on the labels' offsets relative
  // to the right edge. The render code lays things out at a known offset
  // from `sepX` (the panel start), so we estimate sepX as gridW (which is
  // also the visible width when the window is wide enough). For narrow
  // windows we fall back to ignoring side-panel clicks.
  function handleSidePanelClick(x, y) {
    // Heuristic: assume panel starts at gridW + 1 (separator) OR wherever
    // the grid actually ends. The render uses min(gridW, gridPaneW) so when
    // the window is wider than gridW the panel begins at gridW + 1.
    // (For narrower windows we just paint — no panel reachable.)
    const sepX = gridW;
    if (x < sepX) return false;
    const px = sepX + 1;

    // Tag list rows: header at py=6, items at py=7..7+BRUSH_TAGS.length-1.
    // (Match the layout in renderEditor.)
    const tagStart = 7;
    const tagIdx = y - tagStart;
    if (tagIdx >= 0 && tagIdx < BRUSH_TAGS.length && x >= px && x < px + 16) {
      setBrushTag(tagIdx);
      return true;
    }

    // Buttons row: at py = tagStart + BRUSH_TAGS.length + 1.
    const btnY = tagStart + BRUSH_TAGS.length + 1;
    if (y === btnY) {
      // [ play ] spans px+1..px+8, [clear] spans px+11..px+17
      if (x >= px + 1 && x <= px + 8) { save(); startPlay(); return true; }
      if (x >= px + 11 && x <= px + 17) { clearLevel(); save(); return true; }
    }

    // Char +/- on row py=3 of side panel.
    if (y === 3 && x >= px + 9 && x <= px + 11) {
      brushCharIdx.value = (brushCharIdx.peek() + 1) % BRUSH_CHARS.length;
      return true;
    }
    // Color +/- on row py=4.
    if (y === 4 && x >= px + 10 && x <= px + 12) {
      brushColorIdx.value = (brushColorIdx.peek() + 1) % BRUSH_COLORS.length;
      return true;
    }
    // Tag +/- on row py=5.
    if (y === 5 && x >= px + 13 && x <= px + 15) {
      setBrushTag((brushTagIdx.peek() + 1) % BRUSH_TAGS.length);
      return true;
    }
    return false;
  }

  function onTouch(e) {
    if (mode.peek() === 'play') {
      // Swipe-to-move feels natural on touch devices.
      if (e.type === 'swipe' && playState === 'running') {
        if (e.dir === 'up') tryMovePlayer(0, -1);
        else if (e.dir === 'down') tryMovePlayer(0, 1);
        else if (e.dir === 'left') tryMovePlayer(-1, 0);
        else if (e.dir === 'right') tryMovePlayer(1, 0);
      } else if (e.type === 'doubletap') {
        stopPlay();
      }
      return;
    }
    // Editor touch: tap to paint single cell, drag to paint stroke.
    const { type, x, y } = e;
    if (type === 'tap') {
      if (handleSidePanelClick(x, y)) return;
      paintAt(x, y);
      save();
    } else if (type === 'start') {
      if (handleSidePanelClick(x, y)) return;
      dragging = true;
      lastPaintKey = '';
      paintGridFromClick(x, y);
    } else if (type === 'move' && dragging) {
      paintGridFromClick(x, y);
    } else if (type === 'end') {
      dragging = false;
      lastPaintKey = '';
      save();
    }
  }

  // ── Init ───────────────────────────────────────────────────────
  load();
  if (win && win.setTitle) win.setTitle('GameMaker · editor');

  return {
    render,
    onKey,
    onMouse,
    onTouch,
    destroy() {
      if (enemyTimer) { clearInterval(enemyTimer); enemyTimer = null; }
    },
  };
}
