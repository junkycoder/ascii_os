// terminal.js — toy terminal emulator app for acii_os
// Fake shell with built-in commands, scrollback, history, caret.
// API contract: see project CLAUDE.md — exports createApp(initialCtx, win).

import { signal } from '../signals.js';

const SCROLLBACK_CAP = 500;
const PROMPT = 'acii> ';

// ── fake filesystem for `ls` / `cat` ────────────────────────────────
const FAKE_FILES = {
  'about.md': [
    '# acii_os',
    '',
    'A tiny ASCII engine and shell that runs anywhere the web runs.',
    'Zero dependencies. Pure DOM. ESM only.',
  ].join('\n'),
  'README.md': [
    '# README',
    '',
    'Type `help` to see available commands.',
    'Use the up/down arrows to cycle history.',
    'PgUp / PgDn to scroll the scrollback.',
  ].join('\n'),
  'motd.txt': [
    'Welcome to acii_os.',
    'All bits are imaginary; all glyphs are real.',
  ].join('\n'),
};

const FORTUNES = [
  'A bug in the hand is worth two in the backlog.',
  'Today is a good day to ship.',
  'You will refactor something you wrote yesterday.',
  'The cache is lying to you again.',
  'Beware of off-by-one errors.',
  'When in doubt, console.log it out.',
];

// ── helpers ─────────────────────────────────────────────────────────
function wrapLine(str, width) {
  // Break a logical line into width-sized chunks. Width must be >= 1.
  if (width < 1) return [str];
  if (!str) return [''];
  const out = [];
  for (let i = 0; i < str.length; i += width) out.push(str.slice(i, i + width));
  return out;
}

function nowStr() {
  const d = new Date();
  return d.toString();
}

function cowsay(text) {
  const t = text || 'moo';
  const top = ' ' + '_'.repeat(t.length + 2);
  const mid = '< ' + t + ' >';
  const bot = ' ' + '-'.repeat(t.length + 2);
  return [
    top,
    mid,
    bot,
    '        \\   ^__^',
    '         \\  (oo)\\_______',
    '            (__)\\       )\\/\\',
    '                ||----w |',
    '                ||     ||',
  ];
}

function banner(text) {
  // Tiny block banner: just uppercase + spaced, framed.
  const s = (text || '').toUpperCase();
  const inner = s.split('').join(' ');
  const w = inner.length + 4;
  return [
    '+' + '-'.repeat(w - 2) + '+',
    '| ' + inner + ' |',
    '+' + '-'.repeat(w - 2) + '+',
  ];
}

export function createApp(initialCtx, win) {
  // ── state ────────────────────────────────────────────────────────
  // scrollback: ring of { text, style } — style key resolved at draw time.
  const scrollback = [];
  let scrollOffset = 0; // 0 = stuck to bottom; >0 = scrolled up by N lines.

  // input
  let buffer = '';
  let cursor = 0; // index within buffer

  // history (newest at end)
  const history = [];
  let histIdx = -1; // -1 = not navigating; otherwise index into history.

  // caret blink
  let caretOn = true;
  let lastBlink = performance.now();

  function pushLine(text, style = 'fg') {
    scrollback.push({ text: text ?? '', style });
    while (scrollback.length > SCROLLBACK_CAP) scrollback.shift();
    // New output snaps view back to bottom.
    scrollOffset = 0;
  }

  function pushLines(lines, style = 'fg') {
    for (const l of lines) pushLine(l, style);
  }

  // ── motd ────────────────────────────────────────────────────────
  pushLine('acii_os 0.1 (web) — type `help` for commands.', 'accent');
  pushLine('', 'fg');

  // ── command table ───────────────────────────────────────────────
  const COMMANDS = {
    help() {
      pushLine('available commands:', 'accent');
      pushLine('  help                 show this message');
      pushLine('  echo <text>          print text');
      pushLine('  ls                   list fake files');
      pushLine('  cat <file>           print a fake file');
      pushLine('  clear | cls          clear the scrollback');
      pushLine('  uname                show system');
      pushLine('  date                 show current date');
      pushLine('  whoami               show current user');
      pushLine('  fortune              a random fortune');
      pushLine('  cowsay <text>        a cow says text');
      pushLine('  banner <text>        big banner');
      pushLine('  history              show command history');
    },
    echo(args) { pushLine(args.join(' ')); },
    ls() {
      // Two-column list.
      const names = Object.keys(FAKE_FILES);
      pushLine(names.join('   '), 'link');
    },
    cat(args) {
      const name = args[0];
      if (!name) { pushLine('cat: missing file operand', 'error'); return; }
      const file = FAKE_FILES[name];
      if (file === undefined) {
        pushLine(`cat: ${name}: No such file or directory`, 'error');
        return;
      }
      pushLines(file.split('\n'));
    },
    clear() { scrollback.length = 0; scrollOffset = 0; },
    cls() { this.clear(); },
    uname() { pushLine('acii_os 0.1 (web)'); },
    date() { pushLine(nowStr()); },
    whoami() { pushLine('guest@acii'); },
    fortune() {
      pushLine(FORTUNES[Math.floor(Math.random() * FORTUNES.length)], 'warning');
    },
    cowsay(args) { pushLines(cowsay(args.join(' '))); },
    banner(args) { pushLines(banner(args.join(' ')), 'accent'); },
    history() {
      if (!history.length) { pushLine('(no history)', 'fgDim'); return; }
      history.forEach((h, i) => pushLine(`  ${String(i + 1).padStart(3)}  ${h}`));
    },
  };

  function run(input) {
    const line = input.trim();
    // Always echo the prompt + input into scrollback for history feel.
    pushLine(PROMPT + input, 'fgDim');
    if (!line) return;
    history.push(input);
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    const fn = COMMANDS[cmd];
    if (fn) {
      try { fn.call(COMMANDS, args); }
      catch (err) { pushLine('error: ' + (err?.message || err), 'error'); }
    } else {
      pushLine(`command not found: ${parts[0]}`, 'error');
    }
  }

  // ── rendering ────────────────────────────────────────────────────
  function styleFor(theme, key) {
    const c = theme.colors;
    switch (key) {
      case 'accent':  return { fg: c.accent };
      case 'accentDim': return { fg: c.accentDim };
      case 'error':   return { fg: c.error };
      case 'warning': return { fg: c.warning };
      case 'success': return { fg: c.success };
      case 'link':    return { fg: c.link };
      case 'fgDim':   return { fg: c.fgDim };
      case 'fg':
      default:        return { fg: c.fg };
    }
  }

  function render(ctx) {
    const theme = ctx.theme.peek();
    const colors = theme.colors;
    const W = ctx.width;
    const H = ctx.height;
    if (W < 1 || H < 1) return;

    // Background fill (transparent over WM paint — only fill our area).
    ctx.rect(0, 0, W, H, { ch: ' ', bg: colors.bg });

    // Prompt line is the bottom row (H-1).
    const promptRow = H - 1;
    const scrollRows = Math.max(0, promptRow); // rows available for scrollback

    // Build a flat list of wrapped visual lines from scrollback.
    // Wrap each logical line to width W; keep style.
    const visual = [];
    for (const entry of scrollback) {
      const chunks = wrapLine(entry.text, W);
      for (const c of chunks) visual.push({ text: c, style: entry.style });
    }

    // Determine the slice to show. scrollOffset counts lines above the
    // bottom of the visual buffer; clamp it so we can't scroll past the top.
    const maxOffset = Math.max(0, visual.length - scrollRows);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset < 0) scrollOffset = 0;

    const end = visual.length - scrollOffset;
    const start = Math.max(0, end - scrollRows);
    const slice = visual.slice(start, end);

    // Render from bottom up so partial scrollback aligns to prompt.
    for (let i = 0; i < slice.length; i++) {
      const row = promptRow - slice.length + i;
      if (row < 0) continue;
      const line = slice[i];
      ctx.text(0, row, line.text, styleFor(theme, line.style));
    }

    // If scrolled up, show a small indicator at the top-right.
    if (scrollOffset > 0) {
      const tag = `[+${scrollOffset}]`;
      ctx.text(Math.max(0, W - tag.length), 0, tag, { fg: colors.warning });
    }

    // ── prompt line ───────────────────────────────────────────────
    // Render prompt + buffer; if too long for width, scroll horizontally
    // so the cursor stays visible.
    const promptStyle = styleFor(theme, 'accent');
    const textStyle = styleFor(theme, 'fg');
    ctx.text(0, promptRow, PROMPT, promptStyle);

    const inputStartCol = PROMPT.length;
    const inputWidth = Math.max(1, W - inputStartCol);

    // Horizontal scroll so cursor fits.
    let viewStart = 0;
    if (cursor >= inputWidth) viewStart = cursor - inputWidth + 1;
    const visibleInput = buffer.slice(viewStart, viewStart + inputWidth);
    ctx.text(inputStartCol, promptRow, visibleInput, textStyle);

    // Caret. Only blink when window is focused.
    const caretCol = inputStartCol + (cursor - viewStart);
    if (caretCol >= inputStartCol && caretCol < W) {
      const focused = win?.focused?.value ?? true;
      const showCaret = !focused ? false : caretOn;
      if (showCaret) {
        const under = buffer[cursor] || ' ';
        ctx.put(caretCol, promptRow, under, { fg: colors.bg, bg: colors.accent });
      }
    }
  }

  // Caret blink uses wall-clock; render is called every frame by WM.
  // We piggyback on render() — toggle every ~500ms.
  const origRender = render;
  function renderWithBlink(ctx) {
    const t = performance.now();
    if (t - lastBlink >= 500) { caretOn = !caretOn; lastBlink = t; }
    origRender(ctx);
  }

  // ── input handlers ───────────────────────────────────────────────
  function onKey(e) {
    if (e.type !== 'down') return;
    const k = e.key;

    // Scrollback navigation.
    if (k === 'PageUp') { scrollOffset += 5; return; }
    if (k === 'PageDown') { scrollOffset = Math.max(0, scrollOffset - 5); return; }

    // History navigation (only when not actively scrolling text).
    if (k === 'ArrowUp') {
      if (!history.length) return;
      if (histIdx === -1) histIdx = history.length - 1;
      else if (histIdx > 0) histIdx--;
      buffer = history[histIdx] ?? '';
      cursor = buffer.length;
      return;
    }
    if (k === 'ArrowDown') {
      if (histIdx === -1) return;
      if (histIdx < history.length - 1) {
        histIdx++;
        buffer = history[histIdx] ?? '';
      } else {
        histIdx = -1;
        buffer = '';
      }
      cursor = buffer.length;
      return;
    }

    if (k === 'ArrowLeft') { if (cursor > 0) cursor--; return; }
    if (k === 'ArrowRight') { if (cursor < buffer.length) cursor++; return; }
    if (k === 'Home') { cursor = 0; return; }
    if (k === 'End') { cursor = buffer.length; return; }

    if (k === 'Backspace') {
      if (cursor > 0) {
        buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
        cursor--;
      }
      return;
    }
    if (k === 'Delete') {
      if (cursor < buffer.length) {
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
      }
      return;
    }

    if (k === 'Enter') {
      const input = buffer;
      buffer = '';
      cursor = 0;
      histIdx = -1;
      run(input);
      return;
    }

    // Printable character. Single-character keys only; ignore modifiers'
    // standalone presses ('Shift', 'Control', etc.) which have length > 1.
    if (k.length === 1 && !e.ctrl && !e.meta) {
      buffer = buffer.slice(0, cursor) + k + buffer.slice(cursor);
      cursor++;
      caretOn = true;
      lastBlink = performance.now();
    }
  }

  function onMouse(e) {
    if (e.type === 'wheel') {
      // wheel: positive deltaY = scroll down → reduce offset.
      const step = e.deltaY > 0 ? -2 : 2;
      scrollOffset = Math.max(0, scrollOffset + step);
    }
  }

  function onTouch(e) {
    if (e.type === 'swipe') {
      if (e.dir === 'down') scrollOffset = Math.max(0, scrollOffset - 3);
      else if (e.dir === 'up') scrollOffset += 3;
    }
  }

  function destroy() { /* no timers/listeners owned outside render */ }

  return { render: renderWithBlink, onKey, onMouse, onTouch, destroy };
}
