// notes.js — multi-line text editor with localStorage persistence.
// Mounted by the WM. Coords passed to render(ctx) are LOCAL to window content.
import { signal, effect } from '../signals.js';

const STORAGE_KEY = 'acii.notes';
const SAVE_DEBOUNCE_MS = 500;
const SAVE_FLASH_MS = 1000;
const TAB_SPACES = '  '; // two spaces

const DEFAULT_CONTENT =
  'welcome to notes.\n' +
  '\n' +
  'just start typing. your work auto-saves to localStorage.\n' +
  '\n' +
  'shortcuts:\n' +
  '  arrows      move caret\n' +
  '  home / end  line edges\n' +
  '  pgup/pgdn   page jump\n' +
  '  enter       new line\n' +
  '  backspace   delete\n' +
  '  tab         indent (2 spaces)\n';

export function createApp(initialCtx, win) {
  // ── State ────────────────────────────────────────────────────────────
  // Buffer of lines. Always at least one line (possibly empty).
  let lines = ['']; // string[]
  let row = 0;      // caret row (line index)
  let col = 0;      // caret col (char index inside line)
  let scrollY = 0;  // first visible row in viewport (vertical scroll)

  // Save bookkeeping
  let saveTimer = null;
  let lastSavedAt = 0;
  const savedFlash = signal(false); // briefly true after a save lands
  let flashTimer = null;

  // Caret blink — we use wall-clock time inside render(), no setInterval needed,
  // but we keep one so the cell repaints even if nothing else changes.
  let blinkOn = true;
  const blinkInterval = setInterval(() => {
    blinkOn = !blinkOn;
  }, 500);

  // ── Load ─────────────────────────────────────────────────────────────
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null && raw !== undefined) {
      lines = raw.length === 0 ? [''] : raw.split('\n');
    } else {
      lines = DEFAULT_CONTENT.split('\n');
    }
  } catch {
    lines = DEFAULT_CONTENT.split('\n');
  }
  if (lines.length === 0) lines = [''];

  // ── Save (debounced) ─────────────────────────────────────────────────
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(commitSave, SAVE_DEBOUNCE_MS);
  }
  function commitSave() {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, lines.join('\n'));
      lastSavedAt = Date.now();
      savedFlash.value = true;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        savedFlash.value = false;
        flashTimer = null;
      }, SAVE_FLASH_MS);
    } catch {
      // Storage may be unavailable (private mode / quota). Silently ignore.
    }
  }

  // ── Caret/viewport helpers ───────────────────────────────────────────
  function clampCaret() {
    if (row < 0) row = 0;
    if (row >= lines.length) row = lines.length - 1;
    const len = lines[row].length;
    if (col < 0) col = 0;
    if (col > len) col = len;
  }
  function viewportHeight(ctx) {
    // Reserve 1 row for the status bar at the bottom.
    return Math.max(1, ctx.height - 1);
  }
  function ensureCaretVisible(ctx) {
    const vh = viewportHeight(ctx);
    if (row < scrollY) scrollY = row;
    else if (row >= scrollY + vh) scrollY = row - vh + 1;
    if (scrollY < 0) scrollY = 0;
  }

  // ── Edit ops (all touch buffer + schedule save) ──────────────────────
  function insertChar(ch) {
    const line = lines[row];
    lines[row] = line.slice(0, col) + ch + line.slice(col);
    col += ch.length;
    scheduleSave();
  }
  function insertNewline() {
    const line = lines[row];
    const head = line.slice(0, col);
    const tail = line.slice(col);
    lines[row] = head;
    lines.splice(row + 1, 0, tail);
    row++;
    col = 0;
    scheduleSave();
  }
  function backspace() {
    if (col > 0) {
      const line = lines[row];
      lines[row] = line.slice(0, col - 1) + line.slice(col);
      col--;
      scheduleSave();
    } else if (row > 0) {
      // Merge with previous line.
      const prev = lines[row - 1];
      const cur = lines[row];
      col = prev.length;
      lines[row - 1] = prev + cur;
      lines.splice(row, 1);
      row--;
      scheduleSave();
    }
  }

  // ── Word count (cheap, recomputed per render — text is small) ────────
  function wordCount() {
    let n = 0;
    for (const ln of lines) {
      const m = ln.match(/\S+/g);
      if (m) n += m.length;
    }
    return n;
  }

  // ── Public app interface ─────────────────────────────────────────────
  return {
    render(ctx) {
      const C = ctx.theme.peek().colors;
      const W = ctx.width;
      const H = ctx.height;
      if (W <= 0 || H <= 0) return;

      ensureCaretVisible(ctx);

      // Clear our window area to theme bg.
      ctx.rect(0, 0, W, H, { ch: ' ', bg: C.bg, fg: C.fg });

      const vh = viewportHeight(ctx);
      const maxLineWidth = Math.max(1, W - 1); // leave 1 col for truncation indicator

      // Draw visible lines.
      for (let i = 0; i < vh; i++) {
        const lineIdx = scrollY + i;
        if (lineIdx >= lines.length) break;
        const line = lines[lineIdx];
        let visible = line;
        let truncated = false;
        if (line.length > maxLineWidth) {
          visible = line.slice(0, maxLineWidth);
          truncated = true;
        }
        if (visible.length > 0) {
          ctx.text(0, i, visible, { fg: C.fg, bg: C.bg });
        }
        if (truncated) {
          ctx.put(W - 1, i, '›', { fg: C.warning, bg: C.bg });
        }
      }

      // Caret: only paint if focused, and only if within viewport.
      const focused = win && win.focused ? win.focused.value : true;
      const caretY = row - scrollY;
      if (focused && caretY >= 0 && caretY < vh) {
        // If caret is past the truncation point, clamp it to the last visible col
        // so the user can still see something — they'll need to scroll horizontally
        // in a future revision, but for now we just pin to the edge.
        const caretX = Math.min(col, maxLineWidth - 1, W - 1);
        if (caretX >= 0) {
          // Char under caret (if any) — used for inverse block style.
          const lineAtCaret = lines[row] || '';
          const underCh = lineAtCaret[col] || ' ';
          if (blinkOn) {
            // Inverse block: bg=accent, fg=bg.
            ctx.put(caretX, caretY, underCh, { fg: C.bg, bg: C.accent });
          } else {
            // Off-phase: just show the underlying char.
            ctx.put(caretX, caretY, underCh, { fg: C.fg, bg: C.bg });
          }
        }
      }

      // Status bar (bottom row).
      const statusY = H - 1;
      ctx.rect(0, statusY, W, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });
      const lineNum = row + 1;
      const colNum = col + 1;
      const words = wordCount();
      const left = `L${lineNum}:C${colNum}  Words: ${words}`;
      ctx.text(0, statusY, left.slice(0, W), { fg: C.fgDim, bg: C.bg });

      const flashing = savedFlash.value;
      const saveLabel = flashing ? 'Saved' : (saveTimer ? '...' : 'Saved');
      const saveColor = flashing ? C.accent : C.fgDim;
      const saveX = W - saveLabel.length;
      if (saveX >= left.length + 2) {
        ctx.text(saveX, statusY, saveLabel, { fg: saveColor, bg: C.bg });
      }
    },

    onKey(e) {
      if (e.type !== 'down') return;
      const k = e.key;

      // Movement
      if (k === 'ArrowLeft') {
        if (col > 0) col--;
        else if (row > 0) { row--; col = lines[row].length; }
        return;
      }
      if (k === 'ArrowRight') {
        if (col < lines[row].length) col++;
        else if (row < lines.length - 1) { row++; col = 0; }
        return;
      }
      if (k === 'ArrowUp') {
        if (row > 0) { row--; clampCaret(); }
        return;
      }
      if (k === 'ArrowDown') {
        if (row < lines.length - 1) { row++; clampCaret(); }
        return;
      }
      if (k === 'Home') { col = 0; return; }
      if (k === 'End')  { col = lines[row].length; return; }
      if (k === 'PageUp') {
        const step = Math.max(1, (initialCtx?.height ?? 10) - 2);
        row = Math.max(0, row - step);
        clampCaret();
        return;
      }
      if (k === 'PageDown') {
        const step = Math.max(1, (initialCtx?.height ?? 10) - 2);
        row = Math.min(lines.length - 1, row + step);
        clampCaret();
        return;
      }

      // Editing
      if (k === 'Enter') { insertNewline(); return; }
      if (k === 'Backspace') { backspace(); return; }
      if (k === 'Tab') { insertChar(TAB_SPACES); return; }

      // Printable characters: length-1 keys are typically a single glyph.
      // Skip modifier chords (ctrl/meta) so we don't insert on Cmd+S etc.
      if (!e.ctrl && !e.meta && typeof k === 'string' && k.length === 1) {
        insertChar(k);
        return;
      }
    },

    onMouse(e) {
      if (e.type !== 'click' && e.type !== 'mousedown') return;
      // Map click to caret position. e.x / e.y are LOCAL to window.
      const vh = viewportHeight(initialCtx);
      if (e.y < 0 || e.y >= vh) return;
      const targetRow = scrollY + e.y;
      if (targetRow >= lines.length) {
        row = lines.length - 1;
        col = lines[row].length;
        return;
      }
      row = targetRow;
      col = Math.min(Math.max(0, e.x), lines[row].length);
    },

    onTouch(e) {
      if (e.type !== 'tap') return;
      const vh = viewportHeight(initialCtx);
      if (e.y < 0 || e.y >= vh) return;
      const targetRow = scrollY + e.y;
      if (targetRow >= lines.length) {
        row = lines.length - 1;
        col = lines[row].length;
        return;
      }
      row = targetRow;
      col = Math.min(Math.max(0, e.x), lines[row].length);
    },

    destroy() {
      // Flush any pending save synchronously so we don't lose recent edits.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        try { localStorage.setItem(STORAGE_KEY, lines.join('\n')); } catch {}
      }
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (blinkInterval) clearInterval(blinkInterval);
    },
  };
}
