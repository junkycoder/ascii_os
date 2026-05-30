# acii_os

An **ASCII-first, operating-system-flavored UI framework for the web** — a
reactive grid renderer, a window manager, and a small fleet of desktop apps, all
rendered as **copyable monospace text in the DOM**. **Zero dependencies. No
build step. No TypeScript.** Runs anywhere the web runs: desktop, mobile (touch),
TV — and, via a thin Capacitor wrapper, as a native iOS app.

```
╔═ acii_os ════════════════════════════════════════╗
║  ╭────╮   ╭────╮   ╭────╮      ┌─ Terminal ──[×]┐ ║
║  │ ▸  │   │ $  │   │ ✎  │      │ acii> help      │ ║
║  ╰────╯   ╰────╯   ╰────╯      │ available cmds… │ ║
║  Findman  Term     Paint      └─────────────────┘ ║
╚══════════════════════════════════════════════════╝
```

Live: **[os.fakan.cz](https://os.fakan.cz)** · fallback
**[acii-os.junkycoder.workers.dev](https://acii-os.junkycoder.workers.dev)**

---

## Quick start

No install, no bundler. Serve the folder and open `index.html`:

```bash
python3 .claude/devserver.py 8765 0.0.0.0
# → http://localhost:8765/            desktop shell
# → http://localhost:8765/bench.html  standalone perf benchmark
```

The dev server sends `Cache-Control: no-store`, so edits to ES modules show up
on a plain reload (no hard refresh needed).

**Phone / tablet on the same Wi-Fi:** bind `0.0.0.0` as above, then visit
`http://<your-lan-ip>:8765/`.

Any static file server works too — there is nothing to compile. `index.html`
imports `src/*.js` as native ES modules.

---

## What it is

acii_os draws an entire desktop environment into **one DOM cell grid**: every
character is a `<span>` in a row, the renderer diffs cells frame-to-frame, and a
30 fps loop paints only what changed. No `<canvas>`, no SVG — so all text stays
selectable, copyable, and accessible. A tiny reactive core (`signal` /
`computed` / `effect`) drives re-paints; the active theme is itself a signal, so
switching themes recolors the whole screen instantly.

On top of the renderer sits a window manager (drag / resize / maximize / focus /
Alt-Tab), a virtual filesystem (in-memory + `localStorage` + real folders via
the File System Access API), and a desktop shell that wires apps, icons, a
taskbar, pinnable widgets, wallpaper, and context menus together.

---

## Architecture

Layered — each layer is importable on its own:

```
Apps        README · Findman · Terminal · Notes · Paint · Media House · GameMaker · Snake
Shell       desktop, icons, taskbar, widgets (clock/stats/note/music), wallpaper,
            context menus, file drop, global keymap, input routing
Window mgr  z-order · drag · resize · maximize · minimize · focus chain · Alt-Tab
UI kit      Panel Button Input TextArea List Menu Tabs ProgressBar Spinner Dialog
Editing     vim engine (modal) · syntax highlighter · drafts/auto-backup · markdown
FS          virtual tree + localStorage + File System Access mounts
Media       image→ASCII · video→ASCII player · Web Audio · music player (disk + radio)
System      accounts + ASCII login · system user + preferences · keymap (leader + Quick-Look)
Engine      cell buffer · DOM diff renderer · 30fps loop · kbd/mouse/touch · theming
Signals     signal / computed / effect / batch  (tiny reactive core)
Native      Capacitor iOS wrapper (dev-time only — adds no runtime deps)
```

| File | Role |
|------|------|
| `src/signals.js`   | reactive primitives — `signal` / `computed` / `effect` / `batch` |
| `src/engine.js`    | cell buffer, DOM diff renderer, anim loop, input, `subContext`, themes, context-menu + file-drop, responsive `mode` |
| `src/themes.js`    | 4 built-in themes (default-dark / default-light / crt-green / amber-terminal) |
| `src/ui.js`        | UI kit components |
| `src/wm.js`        | window manager |
| `src/markdown.js`  | markdown view with hidden markup |
| `src/syntax.js`    | dependency-free source highlighter (js/json/css/html/py/sh/md) |
| `src/vim.js`       | reusable modal vim editing engine over a text buffer (pure logic) |
| `src/drafts.js`    | draft / auto-backup store (last unsaved edit per file) |
| `src/user.js`      | system user + preferences (vim on/off, Quick-Look, …) |
| `src/users.js`     | account store + session (salted-hash, per-user storage keys) |
| `src/login.js`     | ASCII login screen (`createLogin`) — runs before the shell boots |
| `src/keymap.js`    | global leader-key scheme + Quick-Look routing (pure logic) |
| `src/fs.js`        | virtual filesystem |
| `src/ui-menu.js`   | context / dropdown menu (`createContextMenu`) |
| `src/media.js`     | image / video / audio adapters |
| `src/music.js`     | music player engine — virtual-FS audio + open internet radio |
| `src/mobile.js`    | Capacitor native integration, browser-safe (no-op in a plain browser) |
| `src/shell.js`     | desktop shell — wires everything together |
| `src/apps/*.js`    | the apps |
| `index.html`       | boots the shell (dynamic ES-module imports, cache-busted) |
| `bench.html`       | standalone perf benchmark |
| `worker/index.js`  | Cloudflare Worker entry (serves static assets; `/api/*` lands here later) |

---

## The apps

- **README** `[?]` — markdown viewer (opens on first run).
- **Findman** `[▸]` — *"Findman Dick"*, a Richard **Feynman**-flavored file
  manager (Dick = Richard). File tree + text editor, `Ctrl+S` to save,
  `+ mount local…` to attach a real OS folder. **Auto-backs up** every edit
  (drafts) and restores it on reopen. **Opt-in vim** editing with syntax
  highlighting (toggle with `F9`).
- **Terminal** `[$]` — fake shell: `help`, `echo`, `ls`, `cat`, `clear`/`cls`,
  `uname`, `date`, `whoami`, `fortune`, `cowsay`, `banner`, `history`. Command
  history + scrollback.
- **Notes** `[≡]` — multi-line editor persisted to `localStorage`.
- **Paint** `[✎]` — ASCII drawing: tools pen / line / rect / circle / text, live
  preview, bold toggle, color + brush pickers. Saves to `/desktop/painting-N.acii`.
- **Media House** `[▶]` — read-only media browser. A Findman-style tree filtered
  to video / image / audio, with ASCII rendering of the selection + a link to the
  original. No URL prompt, no editing.
- **GameMaker** `[♛]` — grid editor + play mode (player / wall / goal / enemy),
  persisted.
- **Snake** `[●]` — arrows / WASD / vim HJKL, best score persisted.

---

## Controls

**Desktop**
- `1–9` — launch app by number (**only when no window is focused**, so app keys
  like Paint brushes still work). `Cmd/Ctrl + number` always launches.
- `Alt+Tab` / `Alt+Shift+Tab` — cycle windows
- `Ctrl/Cmd+W` — close focused window · `Esc` — un-maximize
- `Ctrl/Cmd+T` — cycle theme · `Ctrl/Cmd+B` — cycle background pattern
- `Alt+W` — add widget · `Alt+X` — remove top widget · `Alt+H` — toggle taskbar
- **Right-click** (or Ctrl-click / long-press) — context menu on icons, files,
  widgets, desktop
- **Drag** icons / widgets / files to move; **drop OS files** onto the desktop to
  import them into `/desktop`
- **Marquee drag** to multi-select file icons (also keyboard) for bulk actions

**Widgets** — clock · stats · note · **music** (disk tracks + open internet radio,
transport controls inline).

**Touch** — tap / double-tap / long-press / swipe are all routed to apps and the
shell, sized for phone / tablet via the engine's responsive `mode`.

---

## Persistence

Everything lives on a virtual "disk" and survives reloads:

- **Accounts** — an ASCII login screen runs before the shell. Each account gets
  its own namespaced FS + desktop; the built-in `default` keeps the legacy keys.
  Passwords are salted+hashed (a toy hash — not real security). Switch user /
  log out from the taskbar user chip.
- **FS** — virtual tree at `/desktop`, `/docs`, `/apps`, `/games`, persisted to
  `localStorage` (binary as base64). Mount a real folder with Findman's
  `+ mount local…` (Chromium; File System Access API).
- **System user** (`user.js`) — display name + preferences (vim on/off,
  Quick-Look, …), `localStorage` key `acii.user.v1`.
- **Drafts** (`drafts.js`) — the last unsaved edit per file, so a reopen after a
  reload or crash restores in-progress text.
- **Shell state** — theme, window / icon / widget positions, wallpaper.

---

## Deploy

Hosted on **Cloudflare Workers**. The repo root is served verbatim through the
`ASSETS` binding (no build); `.assetsignore` strips non-web files. Config lives in
`wrangler.jsonc`; the worker entry is `worker/index.js` (where a D1 database and
`/api/*` routes will land later). **Pushes to `trunk` auto-deploy** via
`.github/workflows/deploy.yml`.

```bash
npx wrangler deploy        # manual deploy
```

Use **Wrangler 4.x** locally to match the version CI pins (`4.95.0` in
`deploy.yml`). Wrangler 3.x can't read `wrangler.jsonc` and fails with
"Missing entry-point".

## Native iOS

A Capacitor wrapper packages the same zero-build web as a native app
(`cz.fakan.os`). It copies files — no bundler — and `src/mobile.js` degrades to a
no-op in a plain browser. See **`CAPACITOR.md`**.

## Docs

- **`CLAUDE.md`** / **`AGENTS.md`** — guide for AI coding agents (constraints,
  conventions, the app contract, gotchas).
- **`HANDOFF.md`** — session handoff: current state + the feature backlog.
- **`CAPACITOR.md`** — iOS wrapper build (Czech).

## License

MIT (intended).
