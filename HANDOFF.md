# HANDOFF — acii_os

Running log of what works and what's still open. Pair with `CLAUDE.md` /
`AGENTS.md` (project rules + conventions) and `README.md` (the map).

## Where things stand (DONE & working)

Verified functional end-to-end:

- **Engine** — cell buffer + DOM diff renderer, 30fps loop with hidden-tab
  setTimeout fallback, kbd/mouse/touch, `subContext`, responsive `mode` signal
  (watch/mobile/tablet/desktop/tv), `onContextMenu`, `onFileDrop`, `onDragOver`.
- **Themes** — default-dark / default-light / crt-green / amber-terminal;
  switching is instant (theme is a signal).
- **Window manager** — open/close/focus, drag, resize, maximize/restore
  (`▣`/`□`), **minimize/restore** (`Ctrl/Cmd+M`, restore via taskbar/refocus),
  Alt+Tab cycle, double-click title to (un)maximize, close `×` hit-test fixed
  for maximized windows.
- **UI kit** (`ui.js`) — components present; apps mostly draw directly.
- **Markdown** (`markdown.js`) — hidden markup, headers, bold, links, lists,
  code blocks. Used by README app + Findman markdown preview.
- **Syntax** (`syntax.js`) — pure highlighter for js/json/css/html/py/sh/md →
  role spans mapped to theme colors. Used by Findman's editor.
- **FS** (`fs.js`) — virtual tree in `Map<path,…>`, localStorage persistence
  (debounced, base64 for binary), `changes` signal + `subscribe(path,fn)`,
  `mountLocal({at})` via File System Access API. Seeds `/desktop`,
  `/docs/README.md`, `/docs/CHANGELOG.md`, `/apps`, `/games` on first run.
- **System user** (`user.js`) — single system user owns settings/preferences
  (`vimEnabled`, `quicklook`, …) persisted to `acii.user.v1`. Shared singleton
  `globalThis.__aciiUser`.
- **Auth + login — email + magic link** (`auth.js` + `login.js` + `worker/index.js`).
  Replaces the old local `users.js` account store (deleted). `login.js` collects
  **email + username** and POSTs `/api/auth/request`; the worker stores a
  single-use token in **Cloudflare KV** (binding `AUTH`, 15-min TTL) and emails a
  link `os.fakan.cz/auth?token=…` via **Resend**. Opening the link →
  `login.signIn(token)` → `/api/auth/verify` consumes the token, upserts the
  user, and returns a **long-lived session** (~1 year KV TTL) stored in
  `localStorage` (`acii.session.v3`). Boot shows the shell straight from the
  cached session and revalidates via `/api/auth/me` in the background (offline →
  trust cache; 401 → reload to login). Per-user FS/shell keys are namespaced by
  the server user id (`acii.fs.v1::<id>`). Logout = `auth.clearSession()` +
  reload. **Verified end-to-end locally via `wrangler dev`** (request→KV→Resend,
  verify→session, me, single-use enforcement, throttle, AASA, `/auth`→SPA). The
  python devserver only serves static files, so the login UI renders there but
  the API 404s — exercise auth via `wrangler dev` or a `trunk` deploy.
- **iOS deeplink** — worker serves `/.well-known/apple-app-site-association`
  (built from `env.IOS_TEAM_ID` + `cz.fakan.os`, paths `/auth*`);
  `tools/ios-postsync.mjs` registers the `fakanos://` custom-scheme fallback and
  (if an entitlements file exists) the `applinks:os.fakan.cz` associated domain;
  `mobile.js` catches `appUrlOpen` / launch URL and feeds the token to
  `__aciiHandleAuthToken`.
- **Drafts** (`drafts.js`) — last unsaved edit per path, debounced to
  localStorage; restored on reopen, cleared on real save. Shared singleton
  `globalThis.__aciiDrafts`.
- **Media** (`media.js`) — `imageToAscii`, `createVideoPlayer` (off-DOM video →
  canvas sample → ASCII cells), `createAudio`.
- **Music** (`music.js`) — `createMusicPlayer(fs)`: plays virtual-FS audio +
  open internet radio (SomaFM). Drives the `music` desktop widget.
- **Vim** (`vim.js`) — reusable modal engine (normal/insert/visual, hjkl/w/b/
  0/$/gg/G, i/a/o, x/dd/yy/p, `:w` `:q`). Pure logic; opt-in per user pref.
- **Context menu** (`ui-menu.js`) — popup with submenus, auto-flip at edges,
  keyboard + mouse. Wired into shell for icons / files / widgets / desktop.
- **Shell** — patterned-background desktop, draggable persisted app icons,
  desktop file icons from `/desktop`, **marquee + keyboard multi-select** for
  bulk file actions, taskbar with running-app chips + clock, pinnable widgets
  (clock / stats / note / **music**, drag, close ×), wallpaper (a paint file set
  as background), OS file drop → `/desktop`, context menus everywhere, input
  routing to the focused app, **Quick-Look** (spacebar previews the selected
  desktop file when no window is focused).
- **Apps:**
  - **terminal** — fake shell, builtins (`help echo ls cat clear/cls uname date
    whoami fortune cowsay banner history`), history, scrollback.
  - **snake** — arrows/WASD/vim HJKL, best score persisted.
  - **notes** — multi-line editor, localStorage.
  - **readme** — markdown viewer (opens on first run).
  - **paint** — tools pen / line / rect / circle / text, live preview, bold
    toggle, color/brush pickers, saves to `/desktop/painting-N.acii`. File
    format `# acii-paint v1 WxH` then rows of `<char><colorChar><styleChar>`.
  - **findman** (label **"Findman Dick"**, Feynman pun) — file tree + text
    editor, `Ctrl+S` save, `+ mount local…`, picks up `__aciiOpenFile`.
    **Drafts auto-backup**, **opt-in vim** (`F9` toggles `user.prefs.vimEnabled`),
    syntax highlighting, markdown preview, multi-select bulk actions.
  - **mediamogul** (label **"Media House"**) — read-only media browser: a
    Findman-style tree filtered to video/image/audio + ASCII rendering of the
    selection + link to the original. No URL prompt, no editing.
  - **gamemaker** — grid editor + play mode (player/wall/goal/enemy), persisted.

### File-type routing (shell `openFile`)
`.acii`→paint, video/image/audio exts→Media House, text exts→Findman,
default→Findman. Double-click a desktop file icon, pick "Open" in its context
menu, or spacebar (Quick-Look) on the selection.

## Infra / deploy

- **Cloudflare Workers** — repo root served verbatim via `ASSETS` (no build);
  `.assetsignore` strips non-web files. `worker/index.js` is the entry (D1 +
  `/api/*` to come). Custom domain `os.fakan.cz` + `*.workers.dev` fallback.
  **Pushes to `trunk` auto-deploy** (`.github/workflows/deploy.yml`, Wrangler
  4.x pinned). Manual: `npx wrangler deploy`.
- **iOS (Capacitor)** — `cz.fakan.os`. `src/mobile.js` integrates natively and
  no-ops in a plain browser; safe-area handled in `index.html`. See `CAPACITOR.md`.

## OPEN / next priorities

0. **Magic-link go-live — manual steps (code is done + verified locally):**
   - **Resend:** create an account, verify the `fakan.cz` sending domain
     (DNS records), then `wrangler secret put RESEND_API_KEY`. Confirm
     `MAIL_FROM` in `wrangler.jsonc` matches a verified sender.
   - **Deploy:** push to `trunk` (auto-deploy) or `npx wrangler deploy`; the KV
     namespace `AUTH` (id `482597e7e15f465cbf7e8d5066c2a3c6`) is already created
     and bound. Then send yourself a link end-to-end on `os.fakan.cz`.
   - **iOS universal links:** set `IOS_TEAM_ID` in `wrangler.jsonc` (Apple Team
     ID from developer.apple.com → Membership) so the AASA `appID` validates.
     In Xcode: Signing & Capabilities → **+ Associated Domains** →
     `applinks:os.fakan.cz` (needs the Team / a provisioning profile). Re-run
     `npm run sync` so `ios-postsync.mjs` re-applies the `fakanos://` scheme +
     entitlement. Test by opening a magic link on the device → app opens + signs in.
   - **Compat date:** local `wrangler dev` needs `--compatibility-date 2026-05-22`
     until the local wrangler binary catches up (CI pins 4.95.0, which is fine).

1. **Leader-key scheme not wired.** `src/keymap.js` (a full leader + Quick-Look
   routing module) exists but **nothing imports it**. The shell currently does
   global shortcuts *directly* (`Ctrl/Cmd+M` minimize, `Ctrl/Cmd+A` select-all,
   spacebar Quick-Look). To finish backlog item "global editing UX": pick a
   leader key, route shell `onKey` through `keymap.route()`, and migrate the
   ad-hoc combos into keymap bindings (so they're discoverable via
   `km.describe()`).
2. **Re-verify mounted local folder live.** `fs.mountLocal({at:'/mnt/local-…'})`
   is wired in Findman (`+ mount local…`, Chromium-only). Needs a user-driven
   pass through the OS picker to confirm the merged tree lists + reads cleanly;
   inspect `fs.list('/mnt/local-…')` in the console.
3. **Media House depth** — confirm video/audio playback + seek inside the grid
   across themes; large files / unsupported codecs should fail gracefully (no
   URL prompt by design).
4. **Per-account temp backup / unsaved-restore** and surfacing `user.prefs`
   (e.g. the vim toggle) across apps now that accounts/login landed (see DONE).
   Drafts are global today; tie them to the active account namespace.
5. **D1 / `/api/*`** — the worker just serves static assets today; server logic
   hangs off `worker/index.js` when the DB lands (`wrangler.jsonc` has the
   commented `d1_databases` block ready). Could back real (non-toy) auth later.

## How to run / verify
```
python3 .claude/devserver.py 8765 0.0.0.0    # or the `acii` launch config
# http://localhost:8765/   ·   LAN: http://<lan-ip>:8765/
```
No test suite — verify in the browser. Prefer inspecting the live DOM
(`.acii-row` textContent via preview_eval) over screenshots (the screenshot tool
has lagged here). `window.engine` / `window.shell` / `window.shell.fs` are
exposed for console poking.
