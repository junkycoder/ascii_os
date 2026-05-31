# CLAUDE.md — FakanOS project guide

ASCII-first UI framework + desktop shell for the browser. **Read `HANDOFF.md`
for current state and the work backlog before starting.** This file and
`AGENTS.md` carry the same guidance — keep them in sync if you edit one.

## Repo / git
- **Default branch is `trunk`** (not `main`). Remote: `origin`
  (`git@github.com:junkycoder/ascii_os.git`). Base PRs / merges on `trunk`.
- Pushes to `trunk` **auto-deploy to Cloudflare** (`.github/workflows/deploy.yml`).
- `gh` is authenticated (keychain) — open PRs against `trunk` via a branch.
- Manual deploy `npx wrangler deploy` needs **Wrangler 4.x** (CI pins `4.95.0`);
  3.x can't read `wrangler.jsonc`.

## Non-negotiable constraints
- **Zero dependencies. No build step. No TypeScript.** Vanilla ES modules only.
  (The Capacitor iOS wrapper — `package.json`, `tools/build-www.mjs`, `www/`,
  `worker/` — is a dev-time native/edge shell only; it adds no runtime deps to
  `src/`. See `CAPACITOR.md`.)
- Must run "anywhere the web runs" — desktop, mobile (touch), TV. Keep it text.
- Everything renders into one DOM cell grid via the engine. No canvas, no SVG.
- Text in the grid stays copyable / accessible.

## Layout
```
src/signals.js   reactive core: signal / computed / effect / batch
src/engine.js    cell buffer, DOM diff renderer, 30fps loop, kbd/mouse/touch,
                 subContext (clipped local-coord drawing), onContextMenu,
                 onFileDrop, responsive `mode` signal
src/themes.js    4 themes; theme is a signal → instant re-paint
src/ui.js        UI kit (Panel/Button/Input/TextArea/List/Menu/Tabs/…)
src/wm.js        window manager (z-order, drag, resize, maximize, minimize, focus)
src/markdown.js  markdown view with hidden markup
src/syntax.js    pure source highlighter (js/json/css/html/py/sh/md) → role spans
src/vim.js       reusable modal vim engine over a text buffer (pure logic, no DOM)
src/drafts.js    draft / auto-backup store (last unsaved edit per path)
src/user.js      system user + preferences (vimEnabled, quicklook, …)
src/keymap.js    global leader-key scheme + Quick-Look routing (pure logic)
src/keyboard.js  on-screen touch keyboard (pure logic: layouts/state/hitTest/press)
src/fs.js        virtual FS (in-memory + localStorage + File System Access mounts)
src/auth.js      email + magic-link sign-in, session, per-user storage keys
                 (client side of worker /api/auth/*); replaces the old users.js
src/login.js     ASCII login screen (createLogin) — email+username, magic link
src/ui-menu.js   context / dropdown menu (createContextMenu)
src/media.js     imageToAscii, createVideoPlayer, createAudio
src/music.js     createMusicPlayer (virtual-FS audio + open internet radio)
src/mobile.js    Capacitor native integration, browser-safe (no-op in browser)
src/shell.js     desktop shell — wires engine+wm+apps, icons, taskbar, widgets,
                 wallpaper, context menus, file drop, keymap, input routing;
                 user chip + logout menu (opts.user / opts.onLogout / opts.storageKey)
src/share.js     file-share client: DO room (local→DO→locals) over /api/share/*,
                 WS live sync + WebRTC tunnel (createShareClient / createTunnel)
src/collab.js    collaborative-desktop client: email invite + presence WS +
                 shared-FS transport over /api/collab/* (createCollabClient)
src/collabsync.js two-way shared-desktop FS sync (owner /desktop ⇄ /room/<owner>/)
                 via the CollabRoom DO; loop-safe shadow map (createDesktopSync)
src/apps/*.js    apps: terminal, snake, notes, paint, readme, findman,
                 mediamogul (Media House), gamemaker, share, feedback
index.html       boots engine → login → shell (dynamic imports with ?v= cache-bust)
bench.html       standalone perf benchmark
worker/index.js  Cloudflare Worker entry: serves ASSETS, /api/auth/*,
                 /api/feedback/* (public board, KV-backed), /api/share/*
                 (ShareRoom DO), /api/collab/* (CollabRoom DO), /api/newfish/* proxy
wrangler.jsonc   Cloudflare config (assets from repo root, no build)
.claude/devserver.py   dev server with Cache-Control: no-store
.claude/launch.json    preview config (python3 devserver.py 8765 0.0.0.0)
```

> App labels vs. ids: `findman` is labeled **"Findman Dick"** (a Feynman pun);
> `mediamogul` is labeled **"Media House"**. Use the *id* in code/handoffs.

## Conventions
- **App contract:** `export function createApp(initialCtx, win)` returns
  `{ render(ctx), onKey(e), onMouse(e), onTouch(e), destroy() }`. Coords are
  LOCAL to the window content area. Apps DON'T subscribe to engine input — the
  shell routes events to the focused app's handlers. Apps DON'T call
  `engine.clear()` / `engine.start()`.
  - **Optional `wantsKeyboard()`:** on touch the shell shows the on-screen
    keyboard whenever a window is focused. An app may export `wantsKeyboard()`
    → return `false` to hide it while no text field is active (e.g. a pure
    reading/gesture view like `readme`). Omit it and the keyboard stays shown —
    keep it omitted (or `true`) for any app that drives navigation/actions from
    keys (arrows, vim `hjkl`, paint brush digits).
- **Shared singletons** (use these EXACT lines wherever needed, so every app
  shares one instance):
  - `const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });`
  - `const drafts = globalThis.__aciiDrafts ||= createDrafts();`
  - `const user = globalThis.__aciiUser ||= createUser();`
  **Boot pre-creates the FS singleton with the active account's key**
  (`auth.fsKey(user)`) BEFORE importing apps, so the `||=` adopts the per-user
  FS. Every account is namespaced by its server user id (`acii.fs.v1::<id>`).
- **Auth / login (email + magic link):** `index.html` boots engine →
  `createLogin` → (on token) `bootShell(user)`. `login.js` collects email +
  username and POSTs `/api/auth/request`; the worker emails a one-time link
  (`os.fakan.cz/auth?token=…`). Opening it (web tab, or iOS universal link →
  `mobile.js` → `__aciiHandleAuthToken`) calls `login.signIn(token)` →
  `/api/auth/verify` → a long-lived session token in `localStorage`
  (`acii.session.v3`). Boot reads the cached session and shows the shell
  immediately, revalidating via `/api/auth/me` in the background (offline →
  keep trusting the cache; 401 → reload to login). Logout =
  `auth.clearSession()` + `location.reload()`. **Backend** = `worker/index.js`
  + Cloudflare KV (binding `AUTH`) + Resend; needs the `RESEND_API_KEY` secret
  and a verified `fakan.cz` sender. The python devserver can't run the worker —
  exercise auth via `wrangler dev` or a `trunk` deploy.
- **Open-a-file handoff:** shell sets `globalThis.__aciiOpenFile = path` then
  focuses the target app; the app picks it up on first render and clears it.
- **File share (Durable Object):** a "room" is keyed by an unguessable code (the
  code IS the capability — no auth). Source local PUTs small files (≤256 KiB,
  `SHARE_MAX_FILE`) into the per-code `ShareRoom` DO; other locals join by code,
  pull the manifest, and stream files into `/share/<code>/`. A WebSocket carries
  live `added/updated/deleted` events AND relays WebRTC signaling so peers open a
  direct data-channel **tunnel** for files too big for the DO. Backend =
  `worker/index.js` `ShareRoom` DO (binding `SHARE`, SQLite migration in
  `wrangler.jsonc`). Client = `src/share.js` (`createShareClient` + `createTunnel`,
  pure: fetch + WebSocket + RTCPeerConnection, no DOM) → app `src/apps/share.js`.
  Handoffs: `__aciiSharePath` (create+push a path; set by the file context menu's
  "Share…") and `__aciiShareJoin` / `?share=<code>` (join on open).
- **Collaborative desktop (Durable Object):** a "room" is one owner's desktop,
  keyed by the **owner's user id**. People are added by **email invite** (owner →
  user-chip menu "Invite to desktop…" → worker emails a magic link carrying the
  room). Opening it: `/api/auth/peek` (no consume) tells boot whether to show a
  **nickname step** — shown ONLY for a brand-new email (registration only if new);
  existing accounts go straight in. `verify` records membership in the `CollabRoom`
  DO + persists `room` on the session, so boot enters that desktop. The DO holds
  the member list + **live presence** (who's here + cursors) over a WebSocket.
  Backend = `worker/index.js` `CollabRoom` DO (binding `COLLAB`, migration v2 in
  `wrangler.jsonc`). Client = `src/collab.js` (`createCollabClient`, pure: fetch +
  WebSocket). Shell consumes `opts.collab`/`canInvite`/`onInvite` → presence
  overlay + invite. **Phase 3 (shared desktop FS) landed:** the owner's
  `/desktop` mirrors into the room and shows to joiners under `/room/<owner>/`,
  **two-way** (a host with write rights edits their copy → DO → broadcast → owner
  applies into `/desktop`); last-write-wins via `src/collabsync.js`
  (`createDesktopSync`, loop-safe shadow map; the DO stores files as `f:<rel>` +
  relays `{type:'fs',op}` over the presence WS). Invite rights (`read`/`write`)
  ride the session (`auth` `rights`); boot wires `createDesktopSync` against
  `__aciiFS`. **Window replication + co-editing CRDT (phase 4) are not built yet.**
- **Colors:** read `ctx.theme.peek().colors.{accent,fg,fgDim,error,warning,success,link,border,borderFocus,bg}`.
  Never hardcode hex. `theme` is a signal — reading `.value` inside an effect
  subscribes; use `.peek()` in render loops.
- **Engine drawing:** `put(x,y,ch,{fg,bg,bold})`, `text`, `box(…,{glyphSet:'border'|'borderDouble'|'borderRound'})`, `rect`.
- **Pure-logic modules stay pure:** `vim.js`, `syntax.js`, `keymap.js` own no
  engine/DOM state — they take input + a context snapshot and return data/intents
  the host renders or executes. Keep them that way.
- **No `Date.now()` / `Math.random()` in Workflow scripts** (they throw there).
  Fine at app runtime in the browser (drafts/user use `Date.now()` deliberately).

## Engine input events
- `onKey(e)`     `{ type:'down'|'up', key, code, ctrl, shift, alt, meta }`
- `onMouse(e)`   `{ type:'mousedown'|'mouseup'|'mousemove'|'click'|'dblclick'|'wheel', x, y, button, deltaY }`
- `onTouch(e)`   `{ type:'tap'|'doubletap'|'swipe'|'longpress'|'start'|'move'|'end', x, y, dir? }`
- `onContextMenu(e)` `{ x, y }` (right-click / ctrl-click; native menu suppressed)
- `onFileDrop(e)`    `{ x, y, files:[{name,type,size,asText(),asArrayBuffer(),asDataUrl()}] }`

> Use `e.code === 'KeyW'` for letter shortcuts (macOS Option+letter yields a
> symbol in `e.key`). See `keyIs()` in `keymap.js` / `shell.js`.

## Editing stack (Findman + Media House)
- **Drafts:** every Findman edit auto-backs-up (debounced) to the shared drafts
  store; reopening a file with a newer draft restores it; a real save clears it.
- **Vim:** opt-in via `user.prefs.vimEnabled`. When on, Findman routes `onKey`
  through `createVim()`; `:w` saves, `:q` closes; `F9` toggles the pref.
- **Syntax:** `langForPath(path)` → lang, `highlight(text, lang)` → role spans,
  `roleColor(role, colors)` maps roles to the active theme.

## Dev / preview
- Start: `python3 .claude/devserver.py 8765 0.0.0.0` (or the `acii` launch config).
- Preview tab is a background tab → RAF is throttled; FPS reads low there but is
  fine in a real foreground tab. Verify behavior via `preview_eval` against the
  DOM (`.acii-row` / `.acii-cell` text), not just screenshots (the screenshot
  tool has lagged in this project). `window.engine` / `window.shell` /
  `window.shell.fs` are exposed for console poking.
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
- iOS safe-area insets aren't resolved on the first frame — `index.html`
  recomputes the grid after a delay / on `orientationchange`.

## Workflow usage
Big multi-file feature work has been done via the Workflow tool (parallel
sub-agents, one new file each, no shared edits). Keep that pattern: foundation
modules first (signals → engine → fs/user/drafts → vim/syntax/keymap), then apps
that consume them. Integrate + verify on the main thread.
