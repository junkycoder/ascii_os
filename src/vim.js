// vim.js — reusable modal vim editing engine over a text buffer.
//
// Pure logic. NO DOM, NO engine import. It does not render itself; it manages a
// line buffer + cursor + mode and exposes that state so a host app can draw it.
//
// Usage:
//   const vim = createVim('hello\nworld');
//   vim.onCommand = (cmd) => { ... };   // host runs :w / :q / :wq / :q!
//   const consumed = vim.feed(keyEvent); // keyEvent = engine onKey shape
//   // then read vim.mode, vim.lines, vim.cursor, vim.status() to render.
//
// Key event shape (engine onKey): { type, key, code, ctrl, shift, alt, meta }.
// We only act on type === 'down'. Letter shortcuts use e.key (vim is symbolic,
// and a key like 'w' arrives literally); but we tolerate either.

const UNDO_LIMIT = 200;

export function createVim(initialText = '') {
  // ── Buffer state ──────────────────────────────────────────────────────
  let lines = splitText(initialText);
  let mode = 'normal';            // 'normal' | 'insert' | 'visual'
  const cursor = { x: 0, y: 0 };  // x = col, y = line

  // Visual mode anchor (where selection started). Active only in visual mode.
  let anchor = { x: 0, y: 0 };

  // Yank register: { type:'char'|'line', text:string }.
  let register = { type: 'line', text: '' };

  // Command-line buffer (when typing ':...'). null when not in cmdline.
  let cmdline = null;

  // Pending operator/count prefix for normal mode (e.g. the first 'g' of 'gg',
  // or the 'd'/'y' of dd/yy). We keep it as a short string.
  let pending = '';

  // Last command surfaced to the host (also delivered via onCommand callback).
  let pendingCommand = null;

  // Undo history: snapshots of { lines, cursor }. Bounded.
  const undoStack = [];
  const redoStack = [];

  // ── Helpers ───────────────────────────────────────────────────────────
  function splitTextLocal(s) { return splitText(s); }

  function snapshot() {
    return { lines: lines.slice(), cur: { x: cursor.x, y: cursor.y } };
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0; // a fresh edit invalidates redo
  }
  function restore(snap) {
    lines = snap.lines.slice();
    cursor.x = snap.cur.x;
    cursor.y = snap.cur.y;
    clampCursor();
  }

  function clampCursor() {
    if (lines.length === 0) lines = [''];
    if (cursor.y < 0) cursor.y = 0;
    if (cursor.y > lines.length - 1) cursor.y = lines.length - 1;
    const len = lines[cursor.y].length;
    // In normal/visual mode the cursor sits ON a char, so max is len-1 (or 0
    // for an empty line). In insert mode it may sit just past the last char.
    const max = mode === 'insert' ? len : Math.max(0, len - 1);
    if (cursor.x < 0) cursor.x = 0;
    if (cursor.x > max) cursor.x = max;
  }

  function curLine() { return lines[cursor.y] || ''; }

  // ── Motions ───────────────────────────────────────────────────────────
  function moveLeft()  { if (cursor.x > 0) cursor.x--; }
  function moveRight() {
    const max = mode === 'insert' ? curLine().length : Math.max(0, curLine().length - 1);
    if (cursor.x < max) cursor.x++;
  }
  function moveUp()   { if (cursor.y > 0) { cursor.y--; clampCursor(); } }
  function moveDown() { if (cursor.y < lines.length - 1) { cursor.y++; clampCursor(); } }
  function moveLineStart() { cursor.x = 0; }
  function moveLineEnd()   { cursor.x = Math.max(0, curLine().length - (mode === 'insert' ? 0 : 1)); }
  function moveFirstLine() { cursor.y = 0; cursor.x = 0; clampCursor(); }
  function moveLastLine()  { cursor.y = lines.length - 1; cursor.x = 0; clampCursor(); }

  const WORD_CHAR = /[A-Za-z0-9_]/;
  function isWord(ch) { return ch != null && WORD_CHAR.test(ch); }
  function isSpace(ch) { return ch == null || /\s/.test(ch); }

  // Move to start of next word (vim 'w'). Crosses line boundaries.
  function moveWordForward() {
    let { x, y } = cursor;
    const N = lines.length;
    const cls = (ch) => (ch == null || isSpace(ch)) ? 0 : (isWord(ch) ? 1 : 2);
    const startCls = cls(lines[y][x]);
    const beganOnEmptyLine = lines[y].length === 0;
    // advance one position; returns false at end of buffer. Sets `wrapped`
    // true when it crossed onto a new line (a newline is a word boundary).
    let wrapped = false;
    function adv() {
      wrapped = false;
      if (x < lines[y].length - 1) { x++; return true; }
      if (y < N - 1) { y++; x = 0; wrapped = true; return true; }
      x = Math.max(0, lines[y].length - 1);
      return false;
    }
    // 1) Skip the rest of the current run (same non-space class). A line wrap
    //    ends the run — the next word starts on the new line.
    if (startCls !== 0) {
      while (cls(lines[y][x]) === startCls) {
        if (!adv()) { cursor.x = x; cursor.y = y; return; }
        if (wrapped) break;
      }
    }
    // 2) Skip whitespace to the next word start. An empty line is itself a
    //    "word" in vim: if we *arrive* on an empty line we stop, but if we
    //    *start* on one we must step off it.
    if (beganOnEmptyLine) { if (!adv()) { cursor.x = x; cursor.y = y; return; } }
    while (lines[y].length > 0 && cls(lines[y][x]) === 0) {
      if (!adv()) { cursor.x = x; cursor.y = y; return; }
      if (lines[y].length === 0) break; // arrived on an empty line: stop
    }
    cursor.x = x; cursor.y = y; clampCursor();
  }

  // Move to start of previous word (vim 'b').
  function moveWordBackward() {
    let { x, y } = cursor;
    const cls = (ch) => (ch == null || isSpace(ch)) ? 0 : (isWord(ch) ? 1 : 2);
    // step back one
    function back() {
      if (x > 0) { x--; return true; }
      if (y > 0) { y--; x = Math.max(0, lines[y].length - 1); return true; }
      return false;
    }
    if (!back()) { cursor.x = 0; return; }
    // skip whitespace
    while (cls(lines[y][x]) === 0) { if (!back()) { cursor.x = x; cursor.y = y; return; } }
    // now on a word/punct char — move to its start
    const runCls = cls(lines[y][x]);
    while (x > 0 && cls(lines[y][x - 1]) === runCls) x--;
    cursor.x = x; cursor.y = y; clampCursor();
  }

  // ── Insert-mode entries ───────────────────────────────────────────────
  function enterInsert() { mode = 'insert'; }
  function insertBefore() { pushUndo(); enterInsert(); }                  // i
  function insertAfter()  { pushUndo(); if (curLine().length > 0) cursor.x++; enterInsert(); } // a
  function openBelow() {                                                  // o
    pushUndo();
    lines.splice(cursor.y + 1, 0, '');
    cursor.y++; cursor.x = 0; enterInsert();
  }
  function openAbove() {                                                  // O
    pushUndo();
    lines.splice(cursor.y, 0, '');
    cursor.x = 0; enterInsert();
  }

  // ── Edits ─────────────────────────────────────────────────────────────
  function deleteCharUnder() {                                           // x
    const line = curLine();
    if (line.length === 0) return;
    pushUndo();
    register = { type: 'char', text: line[cursor.x] || '' };
    lines[cursor.y] = line.slice(0, cursor.x) + line.slice(cursor.x + 1);
    clampCursor();
  }
  function deleteLine() {                                                // dd
    pushUndo();
    register = { type: 'line', text: curLine() };
    lines.splice(cursor.y, 1);
    if (lines.length === 0) lines = [''];
    if (cursor.y > lines.length - 1) cursor.y = lines.length - 1;
    cursor.x = 0; clampCursor();
  }
  function yankLine() {                                                  // yy
    register = { type: 'line', text: curLine() };
  }
  function paste() {                                                     // p
    pushUndo();
    if (register.type === 'line') {
      lines.splice(cursor.y + 1, 0, register.text);
      cursor.y++; cursor.x = 0;
    } else {
      const line = curLine();
      const at = line.length > 0 ? cursor.x + 1 : 0;
      lines[cursor.y] = line.slice(0, at) + register.text + line.slice(at);
      cursor.x = at + Math.max(0, register.text.length - 1);
    }
    clampCursor();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(snapshot());
    if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    restore(undoStack.pop());
  }
  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    restore(redoStack.pop());
  }

  // ── Insert-mode editing primitives ────────────────────────────────────
  function insChar(ch) {
    const line = curLine();
    lines[cursor.y] = line.slice(0, cursor.x) + ch + line.slice(cursor.x);
    cursor.x += ch.length;
  }
  function insNewline() {
    const line = curLine();
    const head = line.slice(0, cursor.x);
    const tail = line.slice(cursor.x);
    lines[cursor.y] = head;
    lines.splice(cursor.y + 1, 0, tail);
    cursor.y++; cursor.x = 0;
  }
  function insBackspace() {
    if (cursor.x > 0) {
      const line = curLine();
      lines[cursor.y] = line.slice(0, cursor.x - 1) + line.slice(cursor.x);
      cursor.x--;
    } else if (cursor.y > 0) {
      const prev = lines[cursor.y - 1];
      const cur = curLine();
      cursor.x = prev.length;
      lines[cursor.y - 1] = prev + cur;
      lines.splice(cursor.y, 1);
      cursor.y--;
    }
  }

  // ── Visual mode ───────────────────────────────────────────────────────
  function enterVisual() { mode = 'visual'; anchor = { x: cursor.x, y: cursor.y }; }
  // Ordered [start, end] of selection (inclusive of the char under each end).
  function selectionRange() {
    const a = anchor, b = cursor;
    if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return [{ ...a }, { ...b }];
    return [{ ...b }, { ...a }];
  }
  function selectionText() {
    const [s, e] = selectionRange();
    if (s.y === e.y) {
      return { type: 'char', text: (lines[s.y] || '').slice(s.x, e.x + 1) };
    }
    const out = [];
    out.push((lines[s.y] || '').slice(s.x));
    for (let y = s.y + 1; y < e.y; y++) out.push(lines[y]);
    out.push((lines[e.y] || '').slice(0, e.x + 1));
    return { type: 'char', text: out.join('\n') };
  }
  function deleteSelection() {
    pushUndo();
    const [s, e] = selectionRange();
    register = selectionText();
    if (s.y === e.y) {
      const line = lines[s.y] || '';
      lines[s.y] = line.slice(0, s.x) + line.slice(e.x + 1);
    } else {
      const head = (lines[s.y] || '').slice(0, s.x);
      const tail = (lines[e.y] || '').slice(e.x + 1);
      lines.splice(s.y, e.y - s.y + 1, head + tail);
    }
    cursor.x = s.x; cursor.y = s.y;
    mode = 'normal';
    clampCursor();
  }
  function yankSelection() {
    register = selectionText();
    cursor.x = selectionRange()[0].x;
    cursor.y = selectionRange()[0].y;
    mode = 'normal';
    clampCursor();
  }

  // ── Command line ──────────────────────────────────────────────────────
  function runCommand(raw) {
    const cmd = raw.trim();
    pendingCommand = cmd;
    // Recognized: w, q, wq, x, q!, w!  (host decides what to do).
    try { if (typeof api.onCommand === 'function') api.onCommand(cmd); } catch {}
  }

  // ── Key dispatch ──────────────────────────────────────────────────────
  function feed(e) {
    if (!e || e.type !== 'down') return false;
    const k = e.key;

    // Command-line capture takes priority over everything.
    if (cmdline !== null) {
      if (k === 'Escape') { cmdline = null; return true; }
      if (k === 'Enter') {
        const text = cmdline.slice(1); // drop leading ':'
        cmdline = null;
        runCommand(text);
        return true;
      }
      if (k === 'Backspace') {
        cmdline = cmdline.slice(0, -1);
        if (cmdline.length === 0) cmdline = null; // backspacing past ':' exits
        return true;
      }
      if (typeof k === 'string' && k.length === 1 && !e.ctrl && !e.meta) {
        cmdline += k;
        return true;
      }
      return true; // swallow other keys while in cmdline
    }

    if (mode === 'insert') return feedInsert(e, k);
    if (mode === 'visual') return feedVisual(e, k);
    return feedNormal(e, k);
  }

  function feedInsert(e, k) {
    if (k === 'Escape') {
      mode = 'normal';
      if (cursor.x > 0) cursor.x--; // vim pulls the cursor back on exit
      clampCursor();
      return true;
    }
    if (k === 'Enter') { insNewline(); return true; }
    if (k === 'Backspace') { insBackspace(); return true; }
    if (k === 'Tab') { insChar('  '); return true; }
    if (k === 'ArrowLeft') { moveLeft(); return true; }
    if (k === 'ArrowRight') { moveRight(); return true; }
    if (k === 'ArrowUp') { moveUp(); return true; }
    if (k === 'ArrowDown') { moveDown(); return true; }
    if (k === 'Home') { moveLineStart(); return true; }
    if (k === 'End') { cursor.x = curLine().length; return true; }
    if (typeof k === 'string' && k.length === 1 && !e.ctrl && !e.meta) {
      insChar(k);
      return true;
    }
    return false;
  }

  function feedVisual(e, k) {
    // Motions extend the selection (cursor moves, anchor stays).
    if (k === 'Escape') { mode = 'normal'; clampCursor(); return true; }
    if (k === 'h' || k === 'ArrowLeft')  { moveLeft();  return true; }
    if (k === 'l' || k === 'ArrowRight') { moveRight(); return true; }
    if (k === 'j' || k === 'ArrowDown')  { moveDown();  return true; }
    if (k === 'k' || k === 'ArrowUp')    { moveUp();    return true; }
    if (k === 'w') { moveWordForward(); return true; }
    if (k === 'b') { moveWordBackward(); return true; }
    if (k === '0') { moveLineStart(); return true; }
    if (k === '$') { moveLineEnd(); return true; }
    if (k === 'd' || k === 'x') { deleteSelection(); return true; }
    if (k === 'y') { yankSelection(); return true; }
    if (k === 'v') { mode = 'normal'; clampCursor(); return true; } // toggle off
    if (k === ':') { cmdline = ':'; return true; }
    if (k === 'G') { moveLastLine(); return true; }
    if (k === 'g') {
      if (pending === 'g') { pending = ''; moveFirstLine(); }
      else pending = 'g';
      return true;
    }
    if (pending === 'g') pending = '';
    return true; // visual mode swallows keys
  }

  function feedNormal(e, k) {
    // Two-key sequences first (gg, dd, yy).
    if (pending === 'g') {
      pending = '';
      if (k === 'g') { moveFirstLine(); return true; }
      // any other key cancels the 'g' prefix; fall through to handle k
    } else if (pending === 'd') {
      pending = '';
      if (k === 'd') { deleteLine(); return true; }
      return true; // 'd' + unsupported motion: swallow
    } else if (pending === 'y') {
      pending = '';
      if (k === 'y') { yankLine(); return true; }
      return true;
    }

    // Motions
    if (k === 'h' || k === 'ArrowLeft')  { moveLeft();  return true; }
    if (k === 'l' || k === 'ArrowRight') { moveRight(); return true; }
    if (k === 'j' || k === 'ArrowDown')  { moveDown();  return true; }
    if (k === 'k' || k === 'ArrowUp')    { moveUp();    return true; }
    if (k === 'w') { moveWordForward();  return true; }
    if (k === 'b') { moveWordBackward(); return true; }
    if (k === '0') { moveLineStart(); return true; }
    if (k === '$') { moveLineEnd();   return true; }
    if (k === 'G') { moveLastLine();  return true; }
    if (k === 'g') { pending = 'g';   return true; }

    // Insert entries
    if (k === 'i') { insertBefore(); return true; }
    if (k === 'a') { insertAfter();  return true; }
    if (k === 'o') { openBelow();    return true; }
    if (k === 'O') { openAbove();    return true; }
    if (k === 'A') { pushUndo(); cursor.x = curLine().length; enterInsert(); return true; }
    if (k === 'I') { pushUndo(); cursor.x = 0; enterInsert(); return true; }

    // Edits
    if (k === 'x') { deleteCharUnder(); return true; }
    if (k === 'd') { pending = 'd'; return true; }
    if (k === 'y') { pending = 'y'; return true; }
    if (k === 'p') { paste(); return true; }
    if (k === 'u') { undo(); return true; }
    if (k === 'r' && (e.ctrl)) { redo(); return true; } // Ctrl+R redo

    // Visual mode
    if (k === 'v') { enterVisual(); return true; }

    // Command line
    if (k === ':') { cmdline = ':'; return true; }

    // Unhandled: report not-consumed so the host can do something else.
    return false;
  }

  // ── Status string ─────────────────────────────────────────────────────
  function status() {
    if (cmdline !== null) return cmdline;
    if (mode === 'insert') return '-- INSERT --';
    if (mode === 'visual') return '-- VISUAL --';
    if (pendingCommand) return ':' + pendingCommand;
    return '';
  }

  // ── Public API ────────────────────────────────────────────────────────
  const api = {
    // Live state (read directly for rendering).
    get mode() { return mode; },
    get lines() { return lines; },
    cursor,
    // Visual selection range (or null when not in visual mode).
    get selection() { return mode === 'visual' ? selectionRange() : null; },
    // The pending ':' command-line text, or null.
    get cmdline() { return cmdline; },
    // Last surfaced command (e.g. 'w', 'wq', 'q!'); host can read + clear it.
    get pendingCommand() { return pendingCommand; },
    clearPendingCommand() { pendingCommand = null; },
    // Optional callback the host sets: onCommand(cmd) runs :w / :q / etc.
    onCommand: null,

    feed,
    status,

    getText() { return lines.join('\n'); },
    setText(s) {
      lines = splitTextLocal(s == null ? '' : String(s));
      cursor.x = 0; cursor.y = 0;
      mode = 'normal';
      cmdline = null;
      pending = '';
      undoStack.length = 0;
      redoStack.length = 0;
      clampCursor();
    },
  };

  return api;
}

function splitText(s) {
  const text = s == null ? '' : String(s);
  if (text.length === 0) return [''];
  return text.split('\n');
}
