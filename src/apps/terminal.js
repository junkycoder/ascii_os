// terminal.js — toy terminal emulator app for FakanOS
// Fake shell with built-in commands, scrollback, history, caret.
// API contract: see project CLAUDE.md — exports createApp(initialCtx, win).

import { signal } from '../signals.js';
import { createFS } from '../fs.js';
import { createGit } from '../git.js';

// Shared singletons (see CLAUDE.md): one FS + one git engine across all apps.
const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });
const git = globalThis.__aciiGit ||= createGit(fs);

const SCROLLBACK_CAP = 500;

// --- path helpers (UNIX-style, shared with fs.js conventions) -------------
function normPath(p) {
  if (!p || p === '/') return '/';
  if (p[0] !== '/') p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}
function resolvePath(cwd, arg) {
  if (!arg) return cwd;
  let base = arg[0] === '/' ? arg : (cwd === '/' ? '/' + arg : cwd + '/' + arg);
  const parts = base.split('/').filter(Boolean);
  const stack = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  return '/' + stack.join('/');
}

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

  // Working directory over the shared virtual FS. The prompt reflects it (and
  // the current branch when cwd is inside a repo, GitHub-Desktop style).
  let cwd = '/';

  // Build the prompt dynamically: "acii:<cwd> (<branch>)> ". When cwd is inside
  // a git repo we show the active branch in parens — like a shell git prompt.
  function promptStr() {
    const repo = git.repoFor(cwd);
    let branch = '';
    if (repo) {
      try { branch = ' (' + git.status(repo).branch + ')'; } catch {}
    }
    const shown = cwd.length > 18 ? '…' + cwd.slice(-17) : cwd;
    return `acii:${shown}${branch}> `;
  }

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
  pushLine('FakanOS 0.1 (web) — type `help` for commands.', 'accent');
  pushLine('', 'fg');

  // ── command table ───────────────────────────────────────────────
  const COMMANDS = {
    help() {
      pushLine('available commands:', 'accent');
      pushLine('  help                 show this message');
      pushLine('  echo <text>          print text');
      pushLine('  pwd                  print working directory');
      pushLine('  cd <dir>             change directory');
      pushLine('  ls [dir]             list files in the virtual FS');
      pushLine('  cat <file>           print a file');
      pushLine('  git <cmd>            git: init/status/add/commit/branch/…', 'accent');
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
    pwd() { pushLine(cwd); },
    cd(args) {
      const target = resolvePath(cwd, args[0] || '/');
      if (!fs.exists(target)) { pushLine(`cd: ${args[0]}: No such file or directory`, 'error'); return; }
      const st = fs.stat(target);
      if (st && st.type !== 'dir') { pushLine(`cd: ${args[0]}: Not a directory`, 'error'); return; }
      cwd = target;
    },
    ls(args) {
      const target = resolvePath(cwd, args[0]);
      if (!fs.exists(target)) { pushLine(`ls: ${args[0] || target}: No such file or directory`, 'error'); return; }
      const st = fs.stat(target);
      if (st && st.type === 'file') { pushLine(target.split('/').pop(), 'fg'); return; }
      let entries = [];
      try { entries = fs.list(target); } catch {}
      if (!entries.length) { pushLine('(empty)', 'fgDim'); return; }
      const names = entries.map(e => e.type === 'dir' ? e.name + '/' : e.name);
      pushLine(names.join('   '), 'link');
    },
    cat(args) {
      const name = args[0];
      if (!name) { pushLine('cat: missing file operand', 'error'); return; }
      const target = resolvePath(cwd, name);
      if (!fs.exists(target)) { pushLine(`cat: ${name}: No such file or directory`, 'error'); return; }
      const st = fs.stat(target);
      if (st && st.type === 'dir') { pushLine(`cat: ${name}: Is a directory`, 'error'); return; }
      try { pushLines(fs.readText(target).split('\n')); }
      catch (err) { pushLine('cat: ' + (err?.message || err), 'error'); }
    },
    git(args) { runGit(args); },
    clear() { scrollback.length = 0; scrollOffset = 0; },
    cls() { this.clear(); },
    uname() { pushLine('FakanOS 0.1 (web)'); },
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

  // ── git subcommands (over the shared virtual git engine) ─────────
  function requireRepo() {
    const repo = git.repoFor(cwd);
    if (!repo) { pushLine('fatal: not a git repository (use `git init`)', 'error'); return null; }
    return repo;
  }
  function runGit(args) {
    const sub = (args[0] || '').toLowerCase();
    const rest = args.slice(1);
    try {
      switch (sub) {
        case '': case 'help':
          pushLine('usage: git <command>', 'accent');
          pushLine('  init                 make the current dir a repo');
          pushLine('  status               working-tree status');
          pushLine('  add <path>|.         stage a file (or all with .)');
          pushLine('  reset <path>         unstage a file');
          pushLine('  commit -m <msg>      commit the staged changes');
          pushLine('  log                  show commit history');
          pushLine('  branch [name]        list or create branches');
          pushLine('  checkout <name>      switch branch (-b to create)');
          break;
        case 'init': {
          const repo = git.init(cwd);
          pushLine('Initialized empty Git repository in ' + cwd + '/.git', 'success');
          break;
        }
        case 'status': {
          const repo = requireRepo(); if (!repo) break;
          const s = git.status(repo);
          pushLine('On branch ' + s.branch, 'accent');
          if (s.clean) { pushLine('nothing to commit, working tree clean', 'success'); break; }
          if (s.staged.length) {
            pushLine('Changes to be committed:', 'success');
            for (const e of s.staged) pushLine(`  ${nameForStatus(e.status)}: ${e.path}`, 'success');
          }
          if (s.unstaged.length) {
            pushLine('Changes not staged for commit:', 'warning');
            for (const e of s.unstaged) pushLine(`  ${nameForStatus(e.status)}: ${e.path}`, 'warning');
          }
          break;
        }
        case 'add': {
          const repo = requireRepo(); if (!repo) break;
          if (!rest.length) { pushLine('Nothing specified, nothing added.', 'error'); break; }
          if (rest[0] === '.' || rest[0] === '-A' || rest[0] === '--all') { git.stageAll(repo); pushLine('staged all changes', 'fgDim'); break; }
          for (const a of rest) {
            const r = a.startsWith('/') ? a.replace(repo + '/', '') : a;
            git.stage(repo, r);
          }
          break;
        }
        case 'reset': {
          const repo = requireRepo(); if (!repo) break;
          if (!rest.length) { git.unstageAll(repo); pushLine('unstaged all', 'fgDim'); break; }
          for (const a of rest) git.unstage(repo, a);
          break;
        }
        case 'commit': {
          const repo = requireRepo(); if (!repo) break;
          // accept: commit -m "msg"  /  commit -m msg…
          let msg = '';
          const mi = rest.indexOf('-m');
          if (mi >= 0) msg = rest.slice(mi + 1).join(' ').replace(/^["']|["']$/g, '');
          if (!msg) { pushLine('error: commit message required (-m "msg")', 'error'); break; }
          const id = git.commit(repo, msg);
          pushLine(`[${git.status(repo).branch} ${id.slice(0, 7)}] ${msg}`, 'success');
          break;
        }
        case 'log': {
          const repo = requireRepo(); if (!repo) break;
          const entries = git.log(repo);
          if (!entries.length) { pushLine('(no commits yet)', 'fgDim'); break; }
          for (const c of entries) {
            pushLine('commit ' + c.id, 'warning');
            pushLine('  ' + c.author, 'fgDim');
            pushLine('  ' + new Date(c.time).toLocaleString(), 'fgDim');
            pushLine('    ' + c.message.split('\n')[0]);
          }
          break;
        }
        case 'branch': {
          const repo = requireRepo(); if (!repo) break;
          if (!rest.length) {
            const { list } = git.branches(repo);
            for (const b of list) pushLine((b.current ? '* ' : '  ') + b.name, b.current ? 'accent' : 'fg');
          } else { git.createBranch(repo, rest[0]); pushLine('created branch ' + rest[0], 'fgDim'); }
          break;
        }
        case 'checkout': {
          const repo = requireRepo(); if (!repo) break;
          if (rest[0] === '-b') { git.createBranch(repo, rest[1], { checkout: true }); pushLine("Switched to a new branch '" + rest[1] + "'", 'success'); break; }
          git.checkout(repo, rest[0]);
          pushLine("Switched to branch '" + rest[0] + "'", 'success');
          break;
        }
        default:
          pushLine(`git: '${sub}' is not a git command. See 'git help'.`, 'error');
      }
    } catch (err) { pushLine('git: ' + (err?.message || err), 'error'); }
  }
  function nameForStatus(s) { return s === 'A' ? 'new file ' : s === 'D' ? 'deleted  ' : 'modified '; }

  function run(input) {
    const line = input.trim();
    // Always echo the prompt + input into scrollback for history feel.
    pushLine(promptStr() + input, 'fgDim');
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
    const PROMPT = promptStr();
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
