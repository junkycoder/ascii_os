# KEYBOARD.md — zadání: vlastní ASCII virtuální klávesnice (mobil)

Zadání pro implementaci on-screen klávesnice pro **FakanOS** na dotykových
zařízeních (iOS/Android/touch web). Drží projektový zákon: **zero deps, no build,
vanilla ES moduly, vše vykreslené do gridu enginem** — žádná nativní iOS
klávesnice, žádný skrytý `<input>`. Klávesnice je „jen další vrstva", kterou
shell vykreslí do cell gridu a která posílá syntetické `onKey` eventy do
fokusované appky přesně ve formátu, který už engine/shell používá.

---

## 1. Cíl a motivace

Na mobilu není fyzická klávesnice. Appky FakanOS (Terminal, Notes, Findman,
login, …) čekají `onKey(e)` eventy. Potřebujeme **dotykovou klávesnici
vykreslenou do ASCII gridu**, která:

- vypadá jako zbytek systému (text cells, aktivní téma, žádná nativní UI),
- posílá eventy ve stejném tvaru jako engine (`{ type, key, code, ctrl, shift,
  alt, meta }`) — viz CLAUDE.md „Engine input events",
- je čistá logika + render do `subContext`, bez vlastního DOM,
- jde zapnout/vypnout (na desktopu defaultně OFF, na touch defaultně ON).

**Nepoužívat** nativní systémovou klávesnici ani skrytý `<input>`. Důvod:
konzistence vzhledu, plná kontrola nad layoutem (engine si sám počítá grid a
výšku — viz iOS full-bleed v `index.html`), a copy/accessibility model gridu
zůstává nedotčený.

---

## 2. Architektura — kam to patří

Drž vzor projektu: **pure-logic modul + integrace v shellu** (jako `vim.js` /
`keymap.js`, které „own no engine/DOM state").

- **`src/keyboard.js`** — NOVÝ pure-logic modul. Vlastní:
  - definice layoutů (řádky kláves, jejich šířky, glyphy),
  - stav (aktivní vrstva, shift/caps/ctrl/alt drženo, kurzor zvýraznění),
  - `hitTest(x, y)` → která klávesa je na lokálních souřadnicích,
  - `press(keyId)` → vrací **intent**: pole syntetických key eventů, které má
    host poslat do fokus-appky (např. shift+a → `{type:'down', key:'A',
    code:'KeyA', shift:true}` + odpovídající `up`),
  - `layout()` / měření, aby si host spočítal výšku panelu.
  - Žádný import enginu, žádné `put()`/`text()`. Bere vstup + snapshot
    kontextu a vrací data/intenty (přesně jako `vim.js`/`keymap.js`).
- **`src/shell.js`** — integrace:
  - drží instanci klávesnice, rozhoduje o viditelnosti (signal
    `keyboardVisible`), vykresluje ji do spodního pásu gridu **nad** taskbarem,
  - routuje `onTouch`/`onMouse` z oblasti klávesnice do `keyboard.hitTest` +
    `keyboard.press`, a výsledné intenty posílá do `running` fokus-appky přes
    její `onKey` (stejnou cestou, jakou už shell posílá klávesy),
  - **přepočítá dostupnou výšku pro okna** — když je klávesnice vidět, obsah
    nad ní (windows/taskbar) musí dostat o `keyboardRows` méně, ať klávesnice
    nic nepřekrývá (analogicky k `taskbarY()` / `tbH` ve `shell.js`).
- **`src/user.js`** — nová preference `keyboardEnabled` (jako `vimEnabled`),
  persistovaná. Default: `true` na touch zařízení, `false` na desktopu.

> Detekce touch: `('ontouchstart' in window) || navigator.maxTouchPoints > 0`,
> nebo navázat na engine `mode` signal, pokud rozlišuje touch. Nepřidávat nové
> závislosti.

---

## 3. UX / chování

- **Pozice:** spodní pás gridu, plná šířka, nad taskbarem. Při full-bleed iOS
  (viz `html.cap-native #app { padding-bottom: 0 }`) klávesnice doléhá až k
  hraně — počítej s tím, že nejspodnější řádek může být blízko home indikátoru;
  poslední aktivní řádek kláves nedávej na úplně poslední grid-row, nech 1 řádek
  rezervu (tappable comfort).
- **Vrstvy (layers):**
  1. `letters` — malá písmena + mezera, backspace, enter, shift, `123?` přepínač.
  2. `letters-shift` — velká písmena (shift drží jednu klávesu; caps lock na
     dvojklik shiftu).
  3. `symbols` — čísla a běžné symboly (`1234567890`, `-_/:;()$&@"`, `.,?!'`),
     přepínač zpět na `ABC`.
  4. `ctrl` (volitelně) — řada modifierů + šipky + Esc/Tab pro Terminal/vim
     (`Esc Tab ← ↓ ↑ → Ctrl Alt`). Důležité pro Findman+vim a Terminal.
- **Modifiery (sticky):** `Shift`, `Ctrl`, `Alt` se chovají jako sticky — ťuk
  je zapne pro příští klávesu, dvojťuk zamkne, další ťuk vypne. Vizuálně
  zvýrazni zapnutý/zamčený stav (téma `accent` bg).
- **Speciální klávesy:** `⌫` backspace (`{key:'Backspace', code:'Backspace'}`),
  `⏎` enter (`{key:'Enter', code:'Enter'}`), `␣` space (`{key:' ',
  code:'Space'}`), šipky (`ArrowLeft/Right/Up/Down`).
- **Repeat:** longpress na backspace/šipkách → opakování (debounce ~120 ms po
  úvodním ~400 ms). Využij `onTouch` `longpress` + vlastní časovač v shellu
  (runtime `Date.now()` je v browseru OK; viz CLAUDE.md).
- **Feedback:** krátké vizuální zvýraznění stisknuté klávesy (1–2 frame invert).
  Žádný zvuk.
- **Skrytí:** klávesnice je vidět jen když má fokus appka, která žádá text
  (zatím: vždy když je `keyboardEnabled` a je fokusované okno; v budoucnu může
  appka deklarovat `wantsKeyboard`). Toggle i ručně — leader/zkratka + ikona.

---

## 4. Event kontrakt (KRITICKÉ — musí sednout na engine)

Klávesnice generuje eventy **identické** s těmi z enginu (viz CLAUDE.md):

```js
onKey(e) // { type:'down'|'up', key, code, ctrl, shift, alt, meta }
```

- Pro každý stisk pošli `type:'down'` a vzápětí `type:'up'` (appky reagují na
  `down`; `up` posílej pro korektnost).
- `code` používej fyzické (`'KeyA'`, `'Digit1'`, `'Space'`, `'Enter'`,
  `'Backspace'`, `'ArrowLeft'`…). Pozor: shell na písmenné zkratky testuje
  `e.code === 'KeyW'` (viz `keyIs()` v `keymap.js`) — generuj `code` správně,
  ať klávesnice umí spustit i systémové zkratky.
- `key` dej výsledný znak s ohledem na shift (`'a'` vs `'A'`, `'1'` vs `'!'`).
- Modifiery (`ctrl/shift/alt/meta`) nastav podle sticky stavu v okamžiku stisku.

Host (shell) NEVOLÁ engine input — bere intent z `keyboard.press()` a posílá ho
na `focusedApp.onKey(e)` stejnou cestou jako reálné klávesy.

---

## 5. Render kontrakt

- Klávesnice se kreslí do `subContext` (clipped local coords) přiděleného
  shellem — stejný princip jako okna/widgety.
- Barvy **jen z aktivního tématu**: `ctx.theme.peek().colors.{accent,fg,fgDim,
  border,borderFocus,bg}`. Nikdy nehardcoduj hex (viz CLAUDE.md „Colors").
- Klávesa = orámovaný blok (`box` s `glyphSet:'border'`/`borderRound`) s glyphem
  uprostřed. Šířka kláves se přizpůsobí počtu sloupců gridu (responsive); na
  úzkém gridu zmenši mezery, ne čitelnost.
- Aktivní vrstva, sticky modifiery a právě stisknutá klávesa mají odlišný
  `bg`/`bold`.

---

## 6. Integrace s existující logikou

- **Routing fokusu:** posílej eventy do `running` fokus-appky stejně, jako už
  shell routuje fyzickou klávesnici (najdi v `shell.js` místo, kde se `onKey`
  forwarduje fokus-appce, a napoj na to klávesnici).
- **Login:** `createLogin` taky bere `onKey` — klávesnice musí fungovat i před
  bootnutím shellu (na login screenu). Buď ji vykresluj i v login fázi, nebo
  (jednodušší v1) jen v shellu a login nech na fyzické/nativní; rozhodni a
  zdůvodni. **Doporučení v1:** zapnout i na loginu (mobil uživatel jinak email
  nenapíše).
- **Vim/Terminal:** `ctrl` vrstva (Esc/Tab/šipky/Ctrl) je nutná, aby šel ovládat
  vim ve Findmanu a Terminal. Otestuj `:w`/`:q` flow přes virtuální klávesy.
- **Nezasahuj** do `vim.js`/`syntax.js`/`keymap.js` — zůstávají pure. Klávesnice
  je další pure modul + integrace v shellu.

---

## 7. Akceptační kritéria (DoD)

1. Na touch zařízení (a v preview přes simulaci touch) je vidět ASCII klávesnice
   nad taskbarem, vykreslená aktivním tématem.
2. Ťuk na písmeno vloží znak do fokusované appky (ověř na Notes/Terminal: text
   se objeví v `.acii-cell` obsahu).
3. Shift/Caps, přepínač `123?/ABC`, backspace, enter, mezera, šipky fungují.
4. `ctrl` vrstva umí Esc/Tab/šipky → vim ve Findmanu se dá ovládat, `:w`/`:q`
   projde.
5. Okna/taskbar se nepřekrývají s klávesnicí (dostupná výška se zmenší o výšku
   klávesnice).
6. Desktop bez touch: klávesnice defaultně skrytá, nic nerozbije; toggle ji
   zobrazí.
7. Přepnutí tématu (Ctrl+T) překreslí i klávesnici (čte theme signal).
8. Zero deps, no build; `node --check` projde na `src/keyboard.js` a `shell.js`.
9. `tools/build-www.mjs` zkopíruje `keyboard.js` automaticky (je v `src/`, takže
   se veze s rekurzivní kopií — ověř, že je v `www/src/`).

---

## 8. Mimo rozsah (v1)

- Prediktivní text / autocomplete.
- Vícejazyčné rozložení (diakritika) — v1 stačí EN/ASCII; CZ diakritiku řešit
  později vrstvou nebo longpress akcenty.
- Haptika / zvuky.
- Nativní klávesnice / `<input>` fallback (vědomě nepoužíváme).

---

## 9. Soubory k vytvoření / úpravě

- **nový:** `src/keyboard.js` (pure-logic: layouty, stav, `hitTest`, `press`,
  `layout`).
- **uprav:** `src/shell.js` (instance, render do spodního pásu, routing
  touch→press→focusApp.onKey, přepočet výšky oken, toggle).
- **uprav:** `src/user.js` (`keyboardEnabled` pref + default dle touch).
- **uprav:** `CLAUDE.md` + `AGENTS.md` (přidat `keyboard.js` do Layout sekce a
  zmínit kontrakt) — drž je v synchronu.
- **ověř:** `www/src/keyboard.js` po `node tools/build-www.mjs`.
