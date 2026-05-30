# CAPACITOR.md — iOS app `cz.fakan.os`

Zadání + návod, jak z `acii_os` (zero-dep, no-build web) udělat nativní iOS
appku přes [Capacitor](https://capacitorjs.com/). Web zůstává čistě vanilla ES
moduly; Capacitor je jen nativní obal navíc.

---

## 1. Cíl

- **App ID:** `cz.fakan.os`
- **App name:** `fakan.os`
- Do nativní appky se **servíruje statický web build** (žádný bundler) —
  `npx cap copy` / `npx cap sync` zkopíruje webové soubory do iOS projektu.
- **Build = kopie souborů + mobilní specifika** (viewport / safe-area /
  Capacitor most). Žádný Webpack/Vite/Rollup. Drží to projektový zákon
  „Zero dependencies. No build step." pro **web runtime**; Node/Capacitor
  toolchain je čistě dev-time obal, ne závislost běhového kódu.
- **Capacitor kód žije ve zdrojovém HTML/JS, ale je ošetřen pro běžný
  prohlížeč** — když `window.Capacitor` není, vše degraduje na no-op a appka
  běží dál v Chrome/Safari/dev serveru úplně stejně jako dnes.

---

## 2. Principy / mantinely

1. **`src/` zůstává nedotčené co do filozofie** — žádné `import` z npm balíčků.
   Jediný nový web soubor je `src/mobile.js`, který:
   - feature-detekuje `globalThis.Capacitor` (a `Capacitor.isNativePlatform()`),
   - když není → tichý no-op, browser běží jako dřív,
   - když je → zapne nativní vychytávky (status bar, hardware back, splash hide,
     klávesnice).
2. **Žádný runtime npm import v `src/`.** Capacitor pluginy se na webu volají
   přes globální `window.Capacitor.Plugins.*`, ne přes `import`. Tím pádem
   web nepotřebuje build a `src/mobile.js` se načte i bez Capacitoru.
3. **`www/` je build výstup** (assembled), **ne ručně editovaný zdroj**.
   Generuje ho `tools/build-www.mjs`. `www/` je v `.gitignore`.
4. **Capacitor je dev/CI závislost** — `package.json` + `node_modules` +
   `ios/` nativní projekt. Vše v `.gitignore` kromě `package.json`,
   `capacitor.config.json` a build skriptu.

---

## 3. Soubory (vytvořeno)

```
package.json                 # @capacitor/{core,cli,ios} + plugins, npm scripts
capacitor.config.json        # appId cz.fakan.os, appName, webDir: "www"
tools/build-www.mjs          # assembling skript: kopíruje web → www/ + mobil
src/mobile.js                # browser-safe Capacitor integrace (no-op v prohlížeči)
www/                         # (generováno, .gitignore) statický web pro cap copy
ios/                         # (generováno přes `npx cap add ios`, .gitignore)
.gitignore                   # + node_modules, www, ios
```

### 3.1 `package.json`
- `name: cz-fakan-os`, `private`, `type: module`.
- deps: `@capacitor/core`, `@capacitor/ios`, `@capacitor/status-bar`,
  `@capacitor/splash-screen`, `@capacitor/keyboard`, `@capacitor/app`.
- devDeps: `@capacitor/cli`.
- scripts: `dev` (python dev server jako dnes), `build` (node build-www),
  `copy` (`build && cap copy ios`), `sync` (`build && cap sync ios`),
  `ios:add`, `ios:open`.

### 3.2 `capacitor.config.json`
- `appId: cz.fakan.os`, `appName: fakan.os`, `webDir: www`, černé pozadí.
- `ios.contentInset: "always"` — safe-area řeší nativně WebView.
- `SplashScreen.launchAutoHide:false` (skryje ho `mobile.js` po startu).
- `Keyboard.resize:none` — engine si grid řídí sám, nechceme reflow viewportu.

### 3.3 `tools/build-www.mjs` (assembling build)
Čistý Node (žádné npm deps):
1. Smaže a vytvoří `www/`.
2. Zkopíruje `src/` (rekurzivně → nové moduly se berou automaticky),
   `README.md`, `bench.html`. **Nekopíruje** `.claude/`, `node_modules`,
   `ios/`, `tools/`, `www/`, dotfiles.
3. **Mobilní úprava `index.html`** (string-patche, idempotentní):
   - viewport `+viewport-fit=cover`,
   - `?v=Date.now()` → fixní build stamp (na nativu není no-store dev server),
   - inject loader `import('./src/mobile.js')` + `initMobile(engine, shell)`
     před `engine.onFrame(...)`,
   - safe-area padding na boot screen.

### 3.4 `src/mobile.js`
- `export function initMobile(engine, shell)` + `isNative()`.
- V prohlížeči `initMobile` ihned `return` (no Capacitor) → nulový dopad.
- Na nativu: `SplashScreen.hide()`, `StatusBar` styl, `App.backButton` →
  zavře fokusované okno, `Keyboard` listenery. Vše přes optional chaining /
  try-catch, žádný `import` (bere globály).

---

## 4. Postup zprovoznění

> Vyžaduje: Node ≥ 18 ✅ (v22), Xcode ✅ (26.2), **CocoaPods** ⚠️ (chybí —
> `brew install cocoapods` nebo `sudo gem install cocoapods`). Bez CocoaPods
> selže `cap add ios` / `cap sync` při `pod install`.

```bash
npm install        # 1. toolchain (jednorázově)
npm run build      # 2. postav www/ (ověřeno: funguje, exit 0)
npm run ios:add    # 3. vytvoř ios/ (potřebuje CocoaPods)
npm run sync       # 4. build www → kopie do ios + pluginy + pod install
npm run ios:open   # 5. otevři v Xcode, vyber simulator/zařízení, Run
```

Při změně webu pak stačí `npm run sync` (nebo `npm run copy` bez změny pluginů).

---

## 5. Browser kompatibilita

- Root `index.html` zůstává **beze změny** → dev server / prohlížeč funguje 1:1.
- Mobilní úpravy se dějí jen ve `www/index.html` při buildu.
- `src/mobile.js` v prohlížeči no-op (Capacitor global chybí).
- Žádná appka v `src/apps/*` se nemění.

---

## 6. Stav prací

- [x] `package.json`
- [x] `capacitor.config.json`
- [x] `tools/build-www.mjs`
- [x] `src/mobile.js`
- [x] `.gitignore` rozšířen (node_modules, www, ios)
- [x] `npm run build` ověřen — `www/` (28 souborů), `index.html` zapatchován
- [ ] Nainstalovat CocoaPods (chybí na stroji)
- [ ] `npm install` → `npm run ios:add` → `npm run sync` → Run v Xcode
      (na macOS s CocoaPods)
