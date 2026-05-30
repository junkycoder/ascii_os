# HANDOFF — acii_os
<!-- gh PR workflow nácvik 2026-05-30 -->

Session handoff. Context was running low; this captures everything needed to
continue cleanly.

## Where things stand (DONE & working)

Verified functional end-to-end:
- **Engine** — cell buffer + DOM diff renderer, 30fps loop with hidden-tab
  setTimeout fallback, kbd/mouse/touch, `subContext`, responsive `mode` signal
  (watch/mobile/tablet/desktop/tv), `onContextMenu`, `onFileDrop`, `onDragOver`.
- **Themes** — default-dark / default-light / crt-green / amber-terminal;
  switching is instant (theme is a signal).
- **Window manager** — open/close/focus, drag, resize, maximize/restore
  (`▣`/`□` glyph), Alt+Tab cycle, double-click title to (un)maximize, close `×`
  hit-test fixed for maximized windows.
- **UI kit** (`ui.js`) — 10 components. Mostly unused by apps so far but present.
- **Markdown** (`markdown.js`) — hidden markup, headers, bold, links, lists,
  code blocks. Used by README app.
- **FS** (`fs.js`) — virtual tree in `Map<path,…>`, localStorage persistence
  (debounced, base64 for binary), `changes` signal + `subscribe(path,fn)`,
  `mountLocal()` via File System Access API. Seeds `/desktop`, `/docs/README.md`,
  `/docs/CHANGELOG.md`, `/apps`, `/games` on first run.
- **Media** (`media.js`) — `imageToAscii`, `createVideoPlayer` (off-DOM video →
  canvas sample → ASCII cells), `createAudio` (beep / loadSound / loadMusic).
- **Context menu** (`ui-menu.js`) — popup with submenus, auto-flip at edges,
  keyboard + mouse. Wired into shell for icons / files / widgets / desktop.
- **Shell** — desktop with patterned background, app icons (4-row boxes,
  draggable, persisted), **desktop file icons from `/desktop`**, taskbar with
  running-app chips + clock, **pinnable widgets** (clock / stats / note, drag,
  close ×), **wallpaper** (a paint file set as background via right-click),
  **file drop** (OS file → `/desktop`), context menus everywhere, input routing
  to the focused app.
- **Apps:**
  - terminal — fake shell, 11 builtins, history, scrollback
  - snake — arrows/WASD/vim HJKL, best score persisted
  - notes — multi-line editor, localStorage
  - readme — markdown viewer
  - paint — **tools: pen / line / rect / circle / text**, live preview, bold
    toggle, color/brush pickers, saves to `/desktop/painting-N.acii`. File
    format `# acii-paint v1 WxH` then rows of `<char><colorChar><styleChar>`
    (e.g. `Ha1` = 'H', accent, bold). Backward compatible with old `a0` tags.
  - finder — file tree + text editor, `Ctrl+S`, `+ mount local…`, picks up
    `__aciiOpenFile`
  - video — ASCII player; now also accepts an FS path (`/desktop/clip.mp4`) and
    picks up `__aciiOpenFile`, blob-loads bytes from FS. **Still prompts for a
    URL** (to be replaced — see backlog).
  - gamemaker — grid editor + play mode (player/wall/goal/enemy), persisted

### File-type routing (shell `openFile`)
`.acii`→paint, video exts→video, text exts→finder, default→finder.
Double-click a desktop file icon or pick "Open" in its context menu.

## Recently fixed bugs
- Drag no longer text-selects the grid (CSS `user-select:none` + selectstart guard).
- Clock widget shows ISO `YYYY-MM-DD` (fits w=12).
- macOS Option+W/X/H shortcuts work (`e.code` match, not `e.key`).
- Widget close `×`, plus Alt+X / `shell.removeWidget(id)`.
- Number keys reach focused apps (only launch apps when nothing focused).
- Wallpaper renderer decodes paint color tags correctly (+ bold).
- Dev server sends `no-store`; consolidated `wm.mjs`→`wm.js`.

## BACKLOG — requested, NOT yet done (next session priorities)

From the user's last feature message (verbatim intent):

1. **Lost unsaved text in Finder.** Editing buffer isn't backed up. Implement a
   **draft/auto-backup system**: keep the last unsaved edit per file in a temp
   store (localStorage or a `/.drafts/` FS area) so a reopen/crash restores it.
   This ties into item 6 ("temp backup + last unsaved unfinished things").

2. **Rename Finder → "Findman Dick"** — pun on **Richard Phillips Feynman**
   (Dick = Richard). Theme the app around Feynman. (Full name for the about box:
   *Richard Phillips Feynman*.) Update app id/label/icon and any references.

3. **Findman supports vim** for editing (modal: normal/insert/visual, basic
   motions hjkl/w/b/0/$/gg/G, i/a/o, x/dd/yy/p, `:w` `:q`). Vim is **opt-in, not
   default** (see item 6).

4. **Verify the mounted local folder.** User reports mounting a folder shows
   nothing. `fs.mountLocal()` exists (File System Access API, Chrome-only) but
   the merged listing / reads through the mount may be broken. NEEDS DEBUGGING
   with the user driving the OS picker dialog — they'll click through, add a
   folder, and we inspect `fs.list('/mnt/local')`. Likely the async-list path in
   finder's tree isn't awaited / rendered.

5. **Replace Video player → "Media Mogul"** (English name). A read-only media
   browser: a **tree like Findman** but for **video / image / audio** files →
   shows ASCII rendering + a link to the original. **No URL prompt** (user
   doesn't know what's supported), **no editing**. Reuse `media.js`
   (`imageToAscii`, `createVideoPlayer`, `createAudio`) and the finder tree UI.

6. **System user + "disk" model.** Everything lives on the virtual "disk" when
   no device is mounted; the app remembers across reloads. Add a notion of a
   **system user** that owns settings/drafts. Provide: **temp backup** and
   **last unsaved/unfinished items** restore. vim becomes a per-user preference
   (default off).

7. **Global editing UX.** "Edit with spacebar" globally (Quick-Look-style:
   spacebar on a selected file opens/previews it), plus **general macOS/Windows
   conventions behind a prefix key** (a consistent modifier so shortcuts don't
   collide with app keys). Decide one prefix (e.g. a leader key) and route.

Also still open from earlier:
- **Window minimize** (`[_]` button → hide window, restore from taskbar chip).
  The WM reserves the slot but minimize is unimplemented. (Task #8.)

## Suggested approach next session
- Start with **#4 (mount debugging)** live with the user since it needs the OS
  dialog — quick win or quick diagnosis.
- Then **#1/#6 drafts + system-user/disk model** as shared infra (Findman, Media
  Mogul, vim all build on it).
- Then **#2/#3 Findman rebrand + vim**, **#5 Media Mogul** (Workflow: one new
  app file each, reuse finder tree + media.js).
- **#7 global UX** last — it's cross-cutting; design the prefix-key scheme before
  wiring.

## How to run / verify
```
python3 .claude/devserver.py 8765 0.0.0.0    # or the `acii` launch config
# http://localhost:8765/   ·   LAN: http://<lan-ip>:8765/
```
Verify via DOM (`.acii-row` textContent) through preview_eval; the screenshot
tool lagged badly this session. Apps are reachable from `window.shell` /
`window.engine` / `window.shell.fs` in the console.
