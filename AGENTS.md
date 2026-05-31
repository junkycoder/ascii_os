# AGENTS.md — working on FakanOS

Guide for any AI coding agent (Claude Code, Codex, Cursor, …) working in this
repo, **together with the user**. `CLAUDE.md` carries the same project rules in
Claude-Code form — if you edit one, keep the other in sync. Read **`HANDOFF.md`**
for the live state and the feature backlog before you touch anything.

---

## What this project is

FakanOS is an **ASCII-first, OS-flavored UI framework for the web**: a reactive
grid renderer + window manager + a fleet of desktop apps, all rendered as
**copyable monospace text in the DOM**. It boots from `index.html`, which imports
`src/*.js` as native ES modules. There is **nothing to compile**.

## The three laws (do not break these)

1. **Zero dependencies.** No npm package reaches `src/` runtime code. The
   Capacitor (`package.json`, `tools/`, `www/`) and Cloudflare (`worker/`,
   `wrangler.jsonc`) bits are dev-time/edge wrappers only.
2. **No build step. No TypeScript.** Vanilla ES modules. If a change would need a
   bundler or a transpile, it's the wrong change.
3. **Everything is text in one DOM cell grid.** No `<canvas>`, no SVG. Text stays
   selectable / copyable / accessible. Must run anywhere the web runs — desktop,
   touch, TV.

If a request seems to require breaking one of these, **stop and tell the user**
rather than quietly adding a dependency or a build.

## Run & verify

```bash
python3 .claude/devserver.py 8765 0.0.0.0   # http://localhost:8765/
```

The dev server sends `Cache-Control: no-store`, so a plain reload picks up module
edits. There is no test suite — **verify in the browser**:

- Prefer inspecting the live DOM (`.acii-row` / `.acii-cell` text content) over
  screenshots; the screenshot path has been flaky in this project.
- `window.engine`, `window.shell`, `window.shell.fs` are exposed for the console.
- The preview tab runs in the background, so its FPS reads low — that's a
  throttling artifact, not a regression. Check a real foreground tab for perf.

When you finish a change that affects the UI, **show the user proof** it works
(observed DOM / behavior, and a screenshot for visual changes) — don't ask them
to check manually.

## How the code is shaped

Layered, each layer importable on its own (full file table in `README.md`):

```
signals → engine → { fs, user, drafts, themes } → { wm, ui, ui-menu, markdown,
          syntax, vim, keymap, media, music } → shell → apps
```

- **`signals.js`** — `signal` / `computed` / `effect` / `batch`. Reactive core.
  In render loops read `signal.peek()`; read `.value` only when you want to
  subscribe.
- **`engine.js`** — owns the cell buffer, the DOM diff renderer, the 30 fps loop,
  and all input. Draw with `put` / `text` / `box` / `rect`; clip with
  `subContext`.
- **`shell.js`** — the desktop: icons, taskbar (with a user chip), widgets
  (clock / stats / note / music), wallpaper, context menus, file drop, the
  global keymap, and **input routing to the focused app**. This is the
  integration hub.
- **`auth.js` + `login.js`** — email + magic-link sign-in (replaces the old
  local `users.js` account store). `index.html` boots engine → `createLogin` →
  (on token) `bootShell(user)`. `login.js` takes email + username and POSTs
  `/api/auth/request`; the worker emails a one-time link; opening it (web, or
  iOS universal link → `mobile.js` → `__aciiHandleAuthToken`) →
  `/api/auth/verify` → a long-lived session in `localStorage` (`acii.session.v3`).
  Each account is namespaced by its server user id (`acii.fs.v1::<id>`).
  **Backend** = `worker/index.js` + Cloudflare KV (`AUTH`) + Resend; the python
  devserver can't run it — use `wrangler dev` or deploy to exercise auth.

### The app contract

```js
export function createApp(initialCtx, win) {
  return { render(ctx), onKey(e), onMouse(e), onTouch(e), destroy() };
}
```

- Coordinates passed to handlers/`render` are **LOCAL** to the window content
  area.
- Apps **do not** subscribe to engine input and **do not** call
  `engine.clear()` / `engine.start()` — the shell drives all of that.
- Optional `wantsKeyboard()`: on touch the shell shows the on-screen keyboard
  whenever a window is focused. Export `wantsKeyboard()` → `false` to hide it
  while no text field is active (e.g. a pure reading/gesture view like
  `readme`). Omit it (or return `true`) for any app that drives navigation /
  actions from keys (arrows, vim `hjkl`, paint brush digits).
- Read colors from the theme, never hardcode hex:
  `ctx.theme.peek().colors.{accent,fg,fgDim,error,warning,success,link,border,borderFocus,bg}`.

### Shared singletons (use these exact lines)

```js
const fs     = globalThis.__aciiFS     ||= createFS({ storageKey: 'acii.fs.v1' });
const drafts = globalThis.__aciiDrafts ||= createDrafts();
const user   = globalThis.__aciiUser   ||= createUser();
```

Every app that touches files / drafts / settings must reuse the one instance.
Boot pre-creates the FS singleton with the active account's key
(`users.fsKey(user)`) before importing apps, so `||=` adopts the per-user FS.

### Pure-logic modules

`vim.js`, `syntax.js`, and `keymap.js` own no engine/DOM state. They take input +
a context snapshot and return data (buffer/cursor/mode), role spans, or intents
for the host to render/execute. **Keep them pure** — don't reach into the engine
from inside them.

### Input event shapes

```
onKey(e)         { type:'down'|'up', key, code, ctrl, shift, alt, meta }
onMouse(e)       { type:'mousedown'|'mouseup'|'mousemove'|'click'|'dblclick'|'wheel', x, y, button, deltaY }
onTouch(e)       { type:'tap'|'doubletap'|'swipe'|'longpress'|'start'|'move'|'end', x, y, dir? }
onContextMenu(e) { x, y }
onFileDrop(e)    { x, y, files:[{name,type,size,asText(),asArrayBuffer(),asDataUrl()}] }
```

For letter shortcuts match `e.code` (e.g. `'KeyW'`), not `e.key` — macOS
Option+letter yields a symbol in `e.key`. See `keyIs()`.

## Gotchas

- Number keys `1–9` launch apps **only when no window is focused** (so app keys
  like Paint brushes work). `Cmd/Ctrl + number` always launches.
- Render order matters: windows occlude the hint banner; the context menu renders
  last (on top).
- Maximized window: the close `×` sits in the far-right cell — hit-test is
  widened so the corner counts; double-click title toggles maximize.
- iOS safe-area insets aren't resolved on the first frame; `index.html` recomputes
  the grid after a delay / on `orientationchange`.

## Working with the user

- **Surface trade-offs early.** If a task collides with the three laws, or a
  feature has a UX fork (e.g. which leader key, vim default on/off), ask before
  building — the user has opinions on conventions and naming (Findman = Feynman
  pun, Media House, etc.).
- **Branch + PR against `trunk`** (not `main`). `gh` is authenticated. Pushes to
  `trunk` auto-deploy to Cloudflare, so don't push there directly unless asked.
- **For UI changes, attach before/after screenshots** from the running app to the
  PR.
- **Keep `HANDOFF.md` honest** — it's the running log of what works and what's
  backlogged. Update it when you finish or discover something.
- Big multi-file features have been built by fanning out one-new-file-per-agent
  (foundation modules first, then the apps that consume them), integrating and
  verifying on the main thread. Reuse that pattern for large work.

## Deploy

Cloudflare Workers serves the repo root verbatim via the `ASSETS` binding (no
build); `.assetsignore` strips non-web files. `worker/index.js` is where a D1
database and `/api/*` routes will land later. Manual deploy: `npx wrangler deploy`
— use **Wrangler 4.x** locally to match the CI pin (`4.95.0` in `deploy.yml`);
3.x can't read `wrangler.jsonc`. Native iOS wrapper: see `CAPACITOR.md`.
