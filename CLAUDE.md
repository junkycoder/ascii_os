# CLAUDE.md — acii_os project guide

ASCII-first UI framework + desktop shell for the browser. **Read `HANDOFF.md`
for current state and the work backlog before starting.**

## Non-negotiable constraints
- **Zero dependencies. No build step. No TypeScript.** Vanilla ES modules only.
- Must run "anywhere the web runs" — desktop, mobile (touch), TV. Keep it text.
- Everything renders into one DOM cell grid via the engine. No canvas, no SVG.
- Text in the grid stays copyable / accessible.

## Layout
```
src/signals.js   reactive core: signal / computed / effect / batch
src/engine.js    cell buffer, DOM diff renderer, 30fps loop, kbd/mouse/touch,
                 subContext (clipped local-coord drawing), onContextMenu, onFileDrop
src/themes.js    4 themes; theme is a signal → instant re-paint
src/ui.js        UI kit (Panel/Button/Input/TextArea/List/Menu/Tabs/…)
src/wm.js        window manager (z-order, drag, resize, maximize, focus chain)
src/markdown.js  markdown view with hidden markup
src/fs.js        virtual FS (in-memory + localStorage + File System Access mounts)
src/users.js     account store + session (localStorage); per-user storage keys
src/login.js     ASCII login screen (createLogin) — runs before the shell boots
src/ui-menu.js   context / dropdown menu (createContextMenu)
src/media.js     imageToAscii, createVideoPlayer, createAudio
src/shell.js     desktop shell — wires engine+wm+apps, icons, taskbar, widgets,
                 wallpaper, context menus, file drop, input routing; user chip +
                 logout menu (opts.user / opts.onLogout / opts.storageKey)
src/apps/*.js    apps (terminal, snake, notes, paint, readme, finder, video, gamemaker)
index.html       boots engine → login → shell (dynamic imports with ?v= cache-bust)
bench.html       standalone perf benchmark
.claude/devserver.py   dev server with Cache-Control: no-store
.claude/launch.json    preview config (python3 devserver.py 8765 0.0.0.0)
```

## Conventions
- **App contract:** `export function createApp(initialCtx, win)` returns
  `{ render(ctx), onKey(e), onMouse(e), onTouch(e), destroy() }`. Coords are
  LOCAL to the window content area. Apps DON'T subscribe to engine input — the
  shell routes events to the focused app's handlers. Apps DON'T call
  `engine.clear()` / `engine.start()`.
- **Shared FS singleton:** `const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' })`.
  Every app that touches files uses this exact line. **Boot pre-creates this
  singleton with the active user's key** (`users.fsKey(user)`) BEFORE importing
  apps, so the `||=` adopts the per-user FS. The hardcoded key is the fallback.
- **Users / login:** `index.html` boots engine → `createLogin` → (on login)
  `bootShell(user)`. The built-in `default` account keeps the LEGACY keys
  (`acii.fs.v1` / `acii.shell.v2`); other accounts are namespaced by id
  (`…::<id>`). Logout = `users.clearSession()` + `location.reload()` (a session
  in localStorage skips login on the next load). Passwords are salted + hashed
  in `users.js` — a TOY hash, not real security. New-user / delete flows use
  `window.prompt`/`confirm` (preview headless can't run these; they work in a
  real browser, same as the shell's rename / new-file menus).
- **Open-a-file handoff:** shell sets `globalThis.__aciiOpenFile = path` then
  focuses the target app; the app picks it up on first render and clears it.
- **Colors:** read `ctx.theme.peek().colors.{accent,fg,fgDim,error,warning,success,link,border,borderFocus,bg}`.
  Never hardcode hex. `theme` is a signal — reading `.value` inside an effect
  subscribes; use `.peek()` in render loops.
- **Engine drawing:** `put(x,y,ch,{fg,bg,bold})`, `text`, `box(…,{glyphSet:'border'|'borderDouble'|'borderRound'})`, `rect`.
- **No `Date.now()` / `Math.random()` in Workflow scripts** (they throw there).
  Fine at app runtime in the browser.

## Engine input events
- `onKey(e)`     `{ type:'down'|'up', key, code, ctrl, shift, alt, meta }`
- `onMouse(e)`   `{ type:'mousedown'|'mouseup'|'mousemove'|'click'|'dblclick'|'wheel', x, y, button, deltaY }`
- `onTouch(e)`   `{ type:'tap'|'doubletap'|'swipe'|'longpress'|'start'|'move'|'end', x, y, dir? }`
- `onContextMenu(e)` `{ x, y }` (right-click / ctrl-click; native menu suppressed)
- `onFileDrop(e)`    `{ x, y, files:[{name,type,size,asText(),asArrayBuffer(),asDataUrl()}] }`

> Use `e.code === 'KeyW'` for letter shortcuts (macOS Option+letter yields a
> symbol in `e.key`). See `keyIs()` in shell.js.

## Dev / preview
- Start: `python3 .claude/devserver.py 8765 0.0.0.0` (or the `acii` launch config).
- Preview tab is a background tab → RAF is throttled; FPS reads low there but is
  fine in a real foreground tab. Verify behavior via `preview_eval` against the
  DOM (`.acii-row` / `.acii-cell` text), not just screenshots (the screenshot
  tool has lagged in this project).
- After editing modules, a plain reload suffices (no-store). If a module seems
  stale, the HTTP disk cache from before no-store can persist — bump the `?v=`
  or restart the preview server.

## Gotchas learned
- Number keys `1–9` launch apps ONLY when no window is focused (so Paint brushes
  etc. work). `Cmd/Ctrl+number` always launches.
- Hint banner / taskbar must render in the right order vs. windows (windows
  occlude the hint; context menu renders last, on top).
- Maximized window: close `×` is at the far-right cell; hit-test widened so the
  corner counts. Double-click title toggles maximize even while maximized.

## Workflow usage
Big multi-file feature work has been done via the Workflow tool (parallel
sub-agents, one new file each, no shared edits). Keep that pattern: foundation
modules first, then apps that consume them. Integrate + verify on the main thread.
