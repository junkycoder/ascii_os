# AUDIT — FakanOS (multi-perspektivní review)

> Vygenerováno 2026-05-31 multi-agent auditem (6 nezávislých perspektiv +
> syntéza): architektura, UX/přístupnost, bezpečnost, výkon, produkt,
> robustnost. Každý nález má `file:line`. Tohle je **trackovatelný backlog** —
> odškrtávej `[x]` a maž hotové sekce. Vize a konvence viz `CLAUDE.md` /
> `HANDOFF.md`.

## Zaostřený cíl produktu

> **FakanOS = kolaborativní celotextový počítač v jednom browser tabu** — sdílený
> workspace v terminálové estetice, který otevřeš kdekoli (telefon, TV, kiosk) a
> doslova z něj vykopíruješ obsah, protože celý běžící desktop je reálný
> selectovatelný DOM text, ne canvas.

Klín (wedge) = průnik tří věcí, které žádný canvasový web-OS neumí naráz:
**copyable-everything + run-anywhere + živá kolaborace pozváním e-mailem.**
Near-term job: udělat **jeden** workflow (dva lidé co-editují sdílený ASCII
desktop, pak výsledek vykopírují jinam) bezchybný a *prokazatelně* funkční
end-to-end — a tou jednou větou řezat scope všeho ostatního.

---

## 🔴 MUST-FIX — kritické bezpečnostní a správnostní díry

- [x] **CRITICAL — Collab room čitelný kýmkoli přihlášeným.** *(opraveno: DO
  `isMember(uid,owner)` gate před ws/members/fs reads; `uid` stampuje worker z
  ověřené session; externí `join` zablokován. Ověřeno wrangler dev: cizí room →
  403, vlastní → 200.)*
  `worker/index.js:463-489, 598-626` — `handleCollab` ověří jen platnou session,
  ne členství; DO nikdy neověří membership pro ws/manifest/fsGet (jen zápisy
  downgraduje). `room id = 'u-'+sha256hex(email).slice(0,16)` (`worker:191`) →
  kdo zná e-mail, spočítá room offline a stáhne celý zrcadlený `/desktop`.
  **Fix:** vyžadovat `sess.id == owner` NEBO záznam `member:<sess.id>` před
  servováním ws/members/fs reads; netreat low-entropy id jako capability.

- [x] **HIGH — Share upload/delete bez auth.** *(opraveno: `/new` razí per-room
  `writeToken`, PUT/DELETE ho vyžadují přes `x-share-token` (fail-closed),
  joineři read-only; per-IP rate-limit. Ověřeno: bez tokenu → 403, s tokenem →
  200.)* `worker/index.js:281-301, 363-400`
  — kdo zná kód (link, historie, referrer) může přepsat/smazat všechny soubory
  nebo zaplnit 8 MiB cap; joineři si vše auto-stahují do vlastního FS.
  **Fix:** per-room `writeToken` z `/new`, vyžadovat pro PUT/DELETE, joineři
  read-only; min. rate-limit PUT/DELETE per IP.

- [x] **HIGH — Stored-XSS přes content-type.** *(opraveno: `safeFileResponse`
  na všech DO file response — aktivní typy (html/svg/xml/js) → `text/plain`,
  vždy `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`.
  Ověřeno: uložený `evil.html` se servíruje jako text/plain.)*
  `worker/index.js:353-361,
  621-626` (upload na :369/:632) — soubory se vrací s uploaderovým Content-Type
  (i `text/html`/`svg`) ze stejného originu `os.fakan.cz`, kde v localStorage
  leží `acii.session.v3`. Writer nahraje `evil.html` → JS v originu → exfiltrace
  tokenu. **Fix:** vynutit benigní content-type + `X-Content-Type-Options:
  nosniff` + `Content-Disposition: attachment`; ideálně sandbox origin.

- [x] **HIGH — Path traversal v collabsync/share.** *(opraveno: nový pure
  `src/pathsafe.js` `isSafeRel()` (odmítá `..`/leading-`/`/prázdné/control
  segmenty), použit na OBOU stranách — worker DO put/get/del + `collabsync.js`
  onRemote + `share.js` pullFile. Ověřeno: `../evil` → 400.)*
  `collabsync.js:101-116, 48`;
  `worker/index.js:628-642`; `fs.js` (normalizace) — `onRemote` dělá
  `fs.write(localRoot+'/'+rel)` s `rel` přímo z broadcastu (worker kontroluje
  jen délku ≤1024). `rel='../../desktop/evil'` přepíše `/desktop`/`/apps` u
  každého peera. **Fix:** centrální `normalize(path)` odmítající `..`, leading
  `/`, prázdné/control segmenty na OBOU stranách + assert pod mount root.

- [x] **HIGH — Žádný rate-limit** na `/share/new`, WS upgrady, `/auth/verify`,
  `/auth/peek`. *(opraveno: per-IP `rateLimit()` (KV, best-effort) na všech 4 +
  cap `MAX_PEERS=32` socketů per room v obou DO. Ověřeno: 25× `/share/new` →
  6×429. Pozn.: per-email TOCTOU a `peek` leak `{email,exists,invitedBy}`
  zůstávají jako separátní low-priority položky níže.)*
  `worker/index.js:285-287, 403-417, 123-139, 179-189`. **Fix:** per-IP limity,
  cap concurrent socketů per room.

- [ ] **HIGH — `computed().peek()` netrackuje deps, vrací stale.**
  `signals.js:40-44` — vrací raw peek inner signálu; current zůstává jen díky
  eager efektu na `.value` readech. Render loop čtoucí computed přes peek (dle
  docs) může lagovat o frame. **Fix:** lazy dirty-flag — `.value` i `.peek()`
  recompute když dirty. ~10 řádků.

- [ ] **HIGH — Engine bindí ~17 global listenerů bez removeEventListener/
  destroy().** `engine.js:254-362, 225-243, 503-514` — `stop()` nechá pending
  tick a re-arming RAF bez uložení handle. Latentní dnes (logout=reload), ale
  in-page account switch nabinduje vše 2×. **Fix:** zaznamenat
  `(target,type,handler)` při bindu, vrátit `destroy()`, uložit/cancelovat RAF
  id. Totéž `wm.js`.

- [ ] **HIGH — Two-way FS sync řeší konflikty pořadím příchodu.**
  `collabsync.js` — shadow-map jen potlačuje echo; concurrent edit jednoho
  path = LWW dle arrival, tiše zahodí edit; non-atomické apply+shadow+broadcast
  vzkřísí smazaný soubor. **Fix:** per-path version/origin tag, ignorovat
  self/starší ops, tombstones pro delete, atomické apply+shadow.

- [ ] **HIGH — WS reconnect bez bounded backoffu a clean teardownu.**
  `share.js`, `collab.js` — `onclose` loop bez jitteru hammeruje worker; socket
  reopen po `destroy()` běží proti torn-down stavu. **Fix:** `_closed` flag na
  začátku každého handleru i před reconnectem, exp. backoff s jitter+cap,
  clearTimeout/null RTCPeerConnection v `destroy()`.

---

## ⚡ Quick wins (malá práce, velká hodnota — bez deps/buildu)

- [ ] **Boot odolnost** — `index.html:221-235` `Promise.all` bez catch → jeden
  stale `?v=` 404 shodí celý boot. → `allSettled` + obalit `createApp()`
  (`shell.js:~536`) do try/catch s error oknem. ~15 řádků.
- [ ] **localStorage selhání zviditelnit** — `fs.js:159-160` polyká
  `QuotaExceededError` → tichá ztráta dat. → `onPersistError` hook + non-blocking
  banner „úložiště plné".
- [ ] **Zapojit `keymap.js`** — celý leader-key modul s `describe()` cheat-sheetem
  existuje, **nic ho neimportuje** (`keymap.js:1`, `shell.js:1674`). → route
  `onKey` přes keymap + `?`/leader overlay nápovědy + context-menu položka.
  (raised 3 agenty)
- [ ] **Kontrast témat** — `themes.js:33` `default-light fgDim #707070`/`#fafafa`
  ~4.0:1 (pod AA). → ~`#595959`; lighten crt-green/amber fgDim (i disabled menu).
- [ ] **`effect()` nemá re-throwovat** — `signals.js:30-38` → catch +
  `console.error` + depth counter proti cyklům.
- [x] **`nosniff` + attachment** na všechny DO file response —
  `worker/index.js:353-361, 621-626`. (hotovo spolu s XSS must-fix —
  `safeFileResponse`)
- [ ] **Přeložit zbylé české `confirm/prompt`** — `shell.js:846-847, 1238, 1278,
  1284`. Bonus: nahradit nativní `window.confirm/prompt/alert` (rozbité v iOS
  WebView) za in-grid `createDialog`/`createInput`.
- [ ] **`keymap.js` purity leak** — čte `globalThis.navigator` (`:46-47`) →
  předat `isMac` v context snapshotu.

---

## 🔄 Průřezová témata (zmíněna víc agenty)

1. **Chybí teardown disciplína napříč systémem** — efekty, WS, timery, global
   listenery přežívají vlastníky (architektura + výkon + robustnost). Jedna
   příčina → leaky, render-after-destroy, reconnect storms.
2. **localStorage tiše ztrácí data** na quota/private-mode (architektura +
   výkon + robustnost).
3. **Kolaborace = produktový klín I nejméně důvěryhodný kód** — neověřeno
   end-to-end + děravá bezpečnost.
4. **Untrusted content do FS + servovaný same-origin s útočníkovým Content-Type**
   — stejná třída defektu (důvěra v remote path/type) přes share, collab, FS.
5. **`keymap.js` hotový, ale nezapojený** (architektura + UX + produkt).
6. **„Copyable/accessible text" slib jen z poloviny splněn** — ARIA-less spany,
   selection defaultně off; přitom „copy screen as text" je unikátní
   superschopnost (UX + produkt).
7. **Nativní confirm/prompt + stringly-typed globály** rozbíjejí in-grid model
   (UX + architektura).
8. **Žádný idle-redraw gate** — full draw tree + flush každých 33 ms i v klidu
   (výkon + architektura).

---

## 🗺️ Roadmapa zapracování

### NEAR
- [~] Zavřít collab bezpečnostní díry (membership gate, share writeToken,
  content-type/nosniff, path normalize, rate limity) **← hotovo (bezpečnostní
  PR)**; zbývají boot/persist quick wins (PR #2).
- [ ] **Prokázat killer demo:** deploy na `trunk` s DO, natočit 2 prohlížeče /
  2 lidi co-editující jeden sdílený ASCII desktop s živými kurzory (= homepage
  i pitch).
- [ ] Jednotný **teardown kontrakt:** `createApp` vrací/sbírá disposers (efekty,
  timery, WS, subscriptions), WM je drainuje při zavření okna; `signals.js`
  per-effect dep cleanup + disposer; `destroy()` na engine + wm.

### MID
- [ ] „**Copy the screen as text**" jako first-class feature (marquee/command →
  grid jako plain ASCII; paste `.acii` zpět) + a11y substrát (ARIA role na
  root/rows, aria-live region, viditelný selection toggle).
- [ ] **Jedna daily-use kotva** — FS-backed, link-shareable, živě co-editovatelný
  notes/scratchpad (složit do něj drafts+share+collab). Povýšit Terminal na
  reálný command surface nad existujícím FS+git+app registry. Nahradit nativní
  modály in-grid `createDialog`/`createInput`.
- [ ] **Rozbít 1941ř `shell.js`** na factory moduly (taskbar, desktopIcons,
  widgets, contextMenuController, inputRouter, wallpaper) + nahradit ~10
  `globalThis.__acii*` handoff globálů explicitními intent parametry přes
  `openApp`/`createApp`.

### FAR
- [ ] Vybrat jednu **positioning lane** (OSS framework vs. hosted produkt).
- [ ] `invalidate()` needs-redraw gate.
- [ ] TV/kiosk spatial-focus navigace (D-pad nad ikony/taskbar/widgety) +
  leanback dashboard mód.
- [ ] **Sjednotit share+collab do jednoho „room" primitivu** (link i invite mód,
  sdílený presence + FS-sync kód).
- [ ] Dotáhnout retro identitu (amber/green default, CSS-only scanline/glow,
  sdílitelný boot/ASCII exporter).

---

## Per-lens nálezy navíc (nižší priorita, ale evidováno)

### Architektura
- [ ] `medium` — Stringly-typed `globalThis.__acii*` handoff protokol (~10 klíčů:
  `__aciiOpenFile/OpenApp/GitRepo/SharePath/ShareJoin/TimetrackQuickLog/
  HandleAuthToken/PendingAuthToken/KeyboardHeight`) napříč shell+apps — set
  global pak focus app; race/typo neviditelné. → explicitní `intent` param.
- [ ] `medium` — Ověřit, že findman/mediamogul `destroy()` volá `unsubUser()`/
  `unsubFS()` (`findman.js:265,279`, `mediamogul.js:207`) — leak na shared
  singletonu.
- [ ] `medium` — `signals.js` effect re-throwuje + chybí cycle guard (viz quick
  win).
- [ ] `low` — `engine.js:171-191` per-cell style writes v hot pathu; textContent
  mutace ruší živou text selection.

### UX / přístupnost
- [ ] `high` — Žádný first-run onboarding interakčního modelu (1-9 launch,
  right-click menu, Space Quick-Look, Alt+K klávesnice). `shell.js:1921`.
- [ ] `high` — Grid DOM bez a11y sémantiky (`engine.js:62`) — tisíce spanů bez
  ARIA, selection suppressed. → `role=application/row`, aria-live, selection
  toggle.
- [ ] `high` — TV/remote mód bez navigačního modelu (`engine.js:447`) — desktop
  neovladatelný bez pointeru.
- [ ] `medium` — Touch nemůže resizovat okna (`wm.js:405`), chybí touch
  multi-select.
- [ ] `medium` — Focus indikace jen barvou (double vs single border, `wm.js:500`)
  — selhává pro barvoslepé. → shape-based cue.
- [ ] `medium` — `ui.js:267` TextArea caret degenerovaný (jen append/backspace na
  konci, žádný pohyb v textu). → buď reálný caret, nebo označit append-only.
- [ ] `low` — On-screen kbd sticky-modifier nerozliší „once" vs „lock"
  (`keyboard.js:153`); Cmd/meta nedosažitelné (`:220 meta:false`).
- [ ] `low` — Quick-Look (Space) neviditelný, selection bez legendy
  (`shell.js:1710`).

### Bezpečnost (navíc k must-fix)
- [ ] `medium` — Magic-link throttle jen per-email, TOCTOU; verify bez limitu
  (`worker:152-158`).
- [ ] `medium` — newfish proxy forwarduje libovolný path suffix → traversal/SSRF
  v rámci new-fish.net s credentials oběti (`worker:741-743`). → odmítat `..`,
  allowlist sub-paths, assert origin.
- [ ] `medium` — localStorage session plně důvěřována při bootu; forge
  `acii.session.v3` (guest bez tokenu, `auth.js:60`) vybere cizí FS namespace
  (`auth.js:52-67,161-168`).
- [ ] `medium` — Session token v URL query (`?t=`) pro collab WS/members/fs
  (`collab.js:26,33,37`) → logy + referrer leak. → Authorization header pro
  fetch.
- [ ] `low` — `peek` leakuje existenci účtu + inviter (`worker:123-139`); invite
  token žije 7 dní.
- [ ] `low` — Invite rights defaultují na `write` (`worker:500`) → non-owner
  zapíše do owner `/desktop`. → default `read`.

### Výkon
- [ ] `high` — Chybí needs-redraw gate (`engine.js:205-223`) — full draw tree +
  flush každých 33 ms i v klidu. → `invalidate()` dirty flag.
- [ ] `medium` — `applyCellToSpan` (`engine.js:171-176`) zapisuje 3 style props
  bezpodmínečně per změněný cell. → guard proti curBuf nebo CSS class.
- [ ] `medium` — Signály neunsubscribují stale deps (`signals.js:5-38`);
  per-window computed (`wm.js:75`) zůstává subscribed po removeWindow.

### Robustnost (navíc)
- [ ] `medium` — Draft restore vs. save: stale draft přepíše novější on-disk
  soubor (`drafts.js`) — chybí base-version porovnání. → hash/mtime báze + prompt.
- [ ] `medium` — Theme `.value` v render loopu (`engine.js`) re-subscribe každý
  frame + tear při mid-render switchi. → `.peek()`, snapshot na začátku framu.
- [ ] `medium` — Off-by-one clamping na pravém/dolním okraji `put()`/`box()`
  (`engine.js`) — souvisí s widened hit-testem maximized close `×`.
- [ ] `medium` — Vim corner cases (`vim.js`): `dd` na poslední/jediné řádce, `x`
  na prázdné řádce, cursor clamp po delete. → clamp row/col po každém mutaci.
- [ ] `medium` — FS path normalizace (`fs.js`): trailing slash, `..`, `//`,
  duplicitní segmenty → tentýž soubor pod 2 klíči, rozbité draft keys + shadow
  map.
- [ ] `medium` — `onFileDrop`/paste velkých/binárních souborů bez size guardu
  (`shell.js`) → base64 do localStorage zamrzne loop + quota.
- [ ] `low` — Offline 401 revalidace reloaduje a ztratí neuložený stav
  (`auth.js`); odlišit 401 od network/5xx.
- [ ] `low` — Interval-driven apps (snake, music, media) mohou nechat timery
  běžet po `destroy()` (`apps/snake.js`).

---

*Plný strojově čitelný výstup auditu (JSON, všech 6 perspektiv): dočasně
v `tasks/wmnrasvp6.output` v session tmp dir.*
