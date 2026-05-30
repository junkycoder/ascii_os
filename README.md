# acii_os

An **ASCII-first operating-system-flavored UI framework for the web** — a reactive
grid renderer, a window manager, and a small fleet of apps, all rendered as
copyable monospace text in the DOM. Zero dependencies, no build step. Runs
anywhere the web runs: desktop, mobile (touch), TV, even a smartwatch if you
squint.

```
╔═ acii_os ════════════════════════════════════════╗
║  ╭────╮   ╭────╮   ╭────╮      ┌─ Terminal ──[×]┐ ║
║  │ ▸  │   │ $  │   │ ✎  │      │ acii> help      │ ║
║  ╰────╯   ╰────╯   ╰────╯      │ available cmds… │ ║
║  Finder   Term     Paint      └─────────────────┘ ║
╚══════════════════════════════════════════════════╝
```

## Quick start

No install, no bundler. Serve the folder and open `index.html`:

```bash
python3 .claude/devserver.py 8765 0.0.0.0
# → http://localhost:8765/        (desktop shell)
# → http://localhost:8765/bench.html  (perf benchmark)
```

The dev server sends `Cache-Control: no-store` so edits to ES modules show up on
a plain reload (no hard-refresh needed).

LAN access (phone / tablet on the same Wi-Fi): bind `0.0.0.0` as above, then
visit `http://<your-lan-ip>:8765/`.

## Architecture

Layered, each layer importable on its own:

```
Apps        terminal · snake · notes · paint · readme · finder · video · gamemaker
Shell       desktop, icons, taskbar, widgets, wallpaper, context menus, file drop
Window mgr  z-order · drag · resize · fullscreen · focus chain · alt-tab
UI kit      Panel Button Input TextArea List Menu Tabs ProgressBar Spinner Dialog
Markdown    hidden-markup renderer (bold/italic/headers/links/code/lists/quote)
Media       image→ASCII · video→ASCII player · Web Audio
FS          virtual in-memory tree + localStorage + File System Access mounts
Engine      cell buffer · DOM diff renderer · 30fps loop · kbd/mouse/touch · theming
Signals     signal / computed / effect / batch  (tiny reactive core)
```

| File | Role |
|------|------|
| `src/signals.js`  | reactive primitives |
| `src/engine.js`   | cell buffer, DOM diff renderer, anim loop, input, subContext, themes, context-menu + file-drop |
| `src/themes.js`   | 4 built-in themes (default-dark/light, crt-green, amber-terminal) |
| `src/ui.js`       | 10 UI components |
| `src/wm.js`       | window manager |
| `src/markdown.js` | markdown view |
| `src/fs.js`       | virtual filesystem |
| `src/ui-menu.js`  | context / dropdown menu |
| `src/media.js`    | image / video / audio adapters |
| `src/shell.js`    | desktop shell — wires everything together |
| `src/apps/*.js`   | the apps |
| `index.html`      | boots the shell |
| `bench.html`      | standalone perf benchmark |

## Controls

**Desktop**
- `1–9` — launch app by number (only when no window is focused)
- `Alt+Tab` / `Alt+Shift+Tab` — cycle windows
- `Ctrl/Cmd+W` — close focused window · `Esc` — un-maximize
- `Ctrl/Cmd+T` — cycle theme · `Ctrl/Cmd+B` — cycle background pattern
- `Alt+W` — add widget · `Alt+X` — remove top widget · `Alt+H` — toggle taskbar
- **Right-click** (or Ctrl-click / long-press) — context menu on icons, files, widgets, desktop
- Drag icons / widgets / files to move; drop OS files onto the desktop to import into `/desktop`

**Apps**
- **Terminal** — `help`, `ls`, `cat`, `cowsay`, `banner`, `fortune`, …
- **Snake** — arrows / WASD / vim HJKL · Space pause · R restart
- **Paint** — tools `✎ ╱ ▭ ◯ T` (pen/line/rect/circle/text), `G` cycle tool, `1–9` brush, `Q–U` color, `B` bold
- **Finder** — file tree + text editor, `Ctrl+S` save, `+ mount local…` to attach a real folder
- **Notes / README / Video / GameMaker**

## Status

MVP across engine → shell → apps is functional. Persistence via `localStorage`
(theme, window/icon/widget positions, wallpaper) and a virtual FS at `/desktop`,
`/docs`, etc. See `HANDOFF.md` for current work-in-progress and the pending
feature backlog.

## License

MIT (intended).
