# CAPACITOR.md — iOS app `cz.fakan.os`

Zadání + návod, jak z `FakanOS` (zero-dep, no-build web) udělat nativní iOS
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
4. **Capacitor je dev/CI závislost** — `package.json` + `node_modules`.
   `node_modules` + `www/` jsou v `.gitignore`. Nativní `ios/` projekt je
   **commitnutý** (kvůli Xcode Cloud, viz §8); ignorují se jen jeho generované
   části přes `ios/.gitignore`.

---

## 3. Soubory (vytvořeno)

```
package.json                 # @capacitor/{core,cli,ios} + plugins, npm scripts
capacitor.config.json        # appId cz.fakan.os, appName, webDir: "www"
tools/build-www.mjs          # assembling skript: kopíruje web → www/ + mobil
tools/ios-postsync.mjs       # po cap sync/copy: status bar + nainstaluje ikonu/splash
tools/gen-app-assets.sh      # generátor ikony + splash masterů (ImageMagick, dev-time)
assets/ios/                  # (commitnuto) icon-1024.png + splash-2732.png — brand mastery
src/mobile.js                # browser-safe Capacitor integrace (no-op v prohlížeči)
www/                         # (generováno, .gitignore) statický web pro cap copy
ios/                         # nativní projekt — COMMITNUTÝ (Xcode Cloud, §8);
                             #   generované části ignoruje ios/.gitignore
ios/App/ci_scripts/          # Xcode Cloud hooky: ci_post_clone + ci_pre_xcodebuild
.gitignore                   # node_modules + www (ios/ se už neignoruje)
```

### 3.0 Ikona + splash (`assets/ios/`, `tools/gen-app-assets.sh`)
- Brand: zářící zelený `>` terminálový prompt + blokový kurzor na téměř černém
  poli (accent `#00ff88`, bg `#0d0d0d` / splash černá), Menlo font.
- `tools/gen-app-assets.sh` přegeneruje `assets/ios/icon-1024.png` (1024², bez
  alfa — iOS to u AppIcon vyžaduje) a `assets/ios/splash-2732.png` (2732²,
  značka + wordmark `fakan.os` v safe zóně). Vyžaduje `magick` (dev-time, ne
  runtime dep).
- `ios-postsync.mjs` mastery nakopíruje do `ios/` asset katalogu (ten je
  `.gitignore` a `cap add ios` ho regeneruje na default placeholdery). Mastery
  jsou committed source of truth.

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
- [x] Nativní `ios/` **commitnut** + Xcode Cloud CI (viz §8)

---

## 7. Magic-link deeplink (Universal Links + custom scheme)

Login je e-mail + **magic link** (viz `HANDOFF.md`). Odkaz `os.fakan.cz/auth?token=…`
má na iOS otevřít appku, ne Safari.

- **Universal Links** — worker servíruje `/.well-known/apple-app-site-association`
  (sestaven z `IOS_TEAM_ID` + `cz.fakan.os`, cesty `/auth*`). V Xcode je potřeba
  zapnout **Associated Domains** (Signing & Capabilities → `applinks:os.fakan.cz`)
  — vyžaduje Apple Team / provisioning profil. `IOS_TEAM_ID` se nastaví ve
  `wrangler.jsonc`.
- **Custom scheme `fakanos://`** — fallback. `tools/ios-postsync.mjs` ho zapíše
  do `Info.plist` (`CFBundleURLTypes`) při každém `npm run sync` a (pokud existuje
  `App.entitlements`) doplní i associated-domain entitlement.
- **Záchyt v JS** — `src/mobile.js` poslouchá `App` plugin (`getLaunchUrl` +
  `appUrlOpen`), vytáhne `token` z URL a předá ho boot flow přes
  `globalThis.__aciiHandleAuthToken` (cold start → `__aciiPendingAuthToken`).
- **@capacitor/app** plugin už je v `package.json` deps — `appUrlOpen` jde odtud.

---

## 8. Xcode Cloud → TestFlight (automatický iOS build)

Cíl: každý push relevantní větve postaví v cloudu IPA a nahraje ji na
**TestFlight**. Apple builduje **přímo z gitu**, takže nativní `ios/` projekt je
nově **commitnutý** (dřív `.gitignore`). Generované části (`Pods/`, `www` →
`App/App/public`, node config, `build/`, `DerivedData`, `xcuserdata`) zůstávají
ignorované přes `ios/.gitignore` a CI si je vyrobí samo.

### Co je v repu (hotovo, verzováno)
- `ios/` nativní projekt: `App.xcodeproj`, `App.xcworkspace`, `App/` zdroje,
  `Info.plist`, `Assets.xcassets` (brandovaná ikona + splash), `Podfile(.lock)`.
- **Sdílené schéma** `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`
  — Xcode Cloud bez shared scheme workflow nezaложí.
- **CI skripty** (`ios/App/ci_scripts/`, executable bit v gitu = `100755`):
  - `ci_post_clone.sh` — `brew install cocoapods node@20`, `npm ci`,
    `npm run sync` (build `www/` → `cap sync ios` = kopie webu + `pod install`
    → `ios-postsync` = ikona/splash + `Info.plist` patche).
  - `ci_pre_xcodebuild.sh` — `agvtool new-version -all $CI_BUILD_NUMBER`, takže
    každý upload na TestFlight má unikátní, rostoucí build number.
- `project.pbxproj`: `VERSIONING_SYSTEM = apple-generic` (nutné pro `agvtool`),
  `CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM = C8W48M2X85`,
  bundle `cz.fakan.os`, `MARKETING_VERSION 1.0` (zvedat ručně u reálné verze).

### Manuální kroky v App Store Connectu (jednorázově — vyžadují Apple účet)
Tohle z gitu nejde, musí člověk přihlášený do Apple Developer programu (team
`C8W48M2X85`):
1. **App Store Connect → Apps → +** → nová app, platform iOS, bundle
   `cz.fakan.os` (pokud App Record ještě není; bundle ID případně založ v
   *Certificates, IDs & Profiles*).
2. **Xcode Cloud** zapni buď v Xcode (Product → Xcode Cloud → Create Workflow),
   nebo v App Store Connect (Xcode Cloud → Get Started). Propoj GitHub repo
   `junkycoder/ascii_os`, udělej grant přístupu Apple GitHub appce.
3. **Workflow**:
   - *Branch Changes* na `trunk` (start condition).
   - Environment: **Xcode 16** (macOS image s Homebrew), scheme **App**.
   - Action **Archive**, platform **iOS**.
   - Post-action **TestFlight Internal Testing** (vyber interní skupinu testerů).
4. **Signing**: nech `Automatic` — Xcode Cloud podepisuje cloud-managed
   certifikátem/profilem sám, není třeba lokální `.p12`.
5. První build spusť ručně (Start Build) a ověř log `ci_post_clone` (brew/npm)
   + že archive doběhne a objeví se na TestFlightu.

### macOS poznámka
Capacitor nemá nativní macOS target — appka je iOS. Na Mac se dostane přes
**„Mac (Designed for iPad)"**: v App Store Connectu u TestFlightu zaškrtni
dostupnost pro Apple Silicon Mac; běží tatáž iOS binárka, žádný extra build ani
target (a žádná změna v repu). Pravý nativní mac build by znamenal jinou cestu
(Electron) a Xcode Cloud workflow by se ho netýkal.

### Lokální ověření před spoléháním na CI
`npm run sync` potřebuje **Node ≥ 18** (Capacitor 6 CLI) + CocoaPods na PATH —
lokálně přes nvm `node v22` a `LANG=en_US.UTF-8` (jinak padá pod/Node). V CI to
řeší `ci_post_clone.sh` (brew node@20). Po `sync` jde `npm run ios:open` a Run.

---

## 9. Živý web z `os.fakan.cz` + offline fallback

Appka **nenačítá zabundlovaný web jako primární zdroj** — `capacitor.config.json`
má `server.url: "https://os.fakan.cz"`, takže WKWebView táhne web rovnou z
produkce. **Deploy na `trunk` (Cloudflare) se v appce projeví bez rebuildu** —
stačí appku znovu otevřít. Rebuild / `npm run sync` je potřeba už jen na nativní
změny (config, pluginy, ikona, `Info.plist`).

- **Capacitor most funguje i s remote URL** — `window.Capacitor` se injektuje do
  vzdálené stránky, takže `src/mobile.js`, splash, status bar i deeplinky jedou
  dál. Universal Links (`/.well-known/apple-app-site-association`) se týkají
  domény `os.fakan.cz`, což teď sedí 1:1.
- **Offline fallback (nativní):** `ios/App/App/RemoteWebViewController.swift`
  (subclass `CAPBridgeViewController`, nastaven ve storyboardu jako `customClass`)
  v `instanceDescriptor()` **při startu** ověří reachability hostu. Když je
  zařízení offline → `descriptor.serverURL = nil` → Capacitor servíruje
  **zabundlovaný `www/`** (`App/App/public` z posledního `cap sync`) z
  `capacitor://localhost`. Online → živý remote.
- **Mez:** rozhodnutí padá jen jednou při studeném startu (čistý hook, nebojuje
  s navigation delegatem bridge). Když appka při běhu ztratí síť, načtená
  stránka zůstává; tvrdý reload bez sítě by spadl na bundle. Bundle je z
  posledního `sync`, takže offline = případně starší build (povaha fallbacku).
