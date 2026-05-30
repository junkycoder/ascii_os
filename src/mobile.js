// mobile.js — Capacitor native integration, browser-safe.
//
// This file is loaded by both the plain browser build and the native iOS app.
// It NEVER `import`s an npm package: Capacitor exposes itself as a global
// (`window.Capacitor` + `window.Capacitor.Plugins.*`), so this module is a
// valid zero-dependency ES module that also runs fine on the dev server and in
// any browser — where it simply does nothing.
//
// Contract: index.html calls `initMobile(engine)` once, right after the engine
// starts — BEFORE login, so the native splash lifts as soon as any UI (login or
// shell) is on screen. The shell doesn't exist yet at call time, so the back
// handler resolves it lazily from `window.shell`. In a normal browser this
// returns immediately (no Capacitor).

export function isNative() {
  const Cap = globalThis.Capacitor;
  return !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
}

export function initMobile(engine, shell = null) {
  // ── Browser / dev server: no Capacitor → no-op, app runs exactly as before.
  if (!isNative()) return;

  const Cap = globalThis.Capacitor;
  const P = (Cap && Cap.Plugins) || {};

  // ── Mark the document as running natively so index.html's iOS-only CSS
  //    (minimum top/bottom safe-area inset) activates. On the web this class
  //    is never set, so the grid keeps using the bare env() insets (0 on
  //    desktop). Setting it before the resize kicks below ensures the first
  //    reflow already measures the enforced inset.
  try { document.documentElement.classList.add('cap-native'); } catch (_) {}

  // ── Splash: we set launchAutoHide:false so the boot screen shows through;
  //    hide once the web app is up.
  try { P.SplashScreen && P.SplashScreen.hide(); } catch (_) {}

  // ── Status bar: hide it entirely and let the WebView extend underneath, so
  //    the grid reclaims that strip (content sits higher). The CSS safe-area
  //    padding on #app still keeps the title bars below the notch / Dynamic
  //    Island, so nothing important hides under the camera cutout.
  try {
    if (P.StatusBar) {
      // overlay:true → WebView draws full-screen, status bar floats over it;
      // hide() then removes the bar completely, freeing the top strip.
      P.StatusBar.setOverlaysWebView &&
        P.StatusBar.setOverlaysWebView({ overlay: true });
      P.StatusBar.setStyle && P.StatusBar.setStyle({ style: 'DARK' });
      P.StatusBar.hide && P.StatusBar.hide();
    }
  } catch (_) {}

  // After the native bars settle, the safe-area insets change — nudge the web
  // app to recompute its grid so window sizes (and the bottom border) fit the
  // real content box. index.html listens for 'resize' → reflow.
  try {
    const kick = () => { try { window.dispatchEvent(new Event('resize')); } catch (_) {} };
    setTimeout(kick, 50);
    setTimeout(kick, 250);
    setTimeout(kick, 600);
  } catch (_) {}

  // ── Hardware/back gesture (iOS has none, but App plugin still fires on
  //    Android and the swipe-back edge): close the focused window instead of
  //    backgrounding the app, if there is one.
  try {
    if (P.App && P.App.addListener) {
      P.App.addListener('backButton', () => {
        try {
          const sh = shell || globalThis.shell;
          const wm = sh && sh.wm;
          const focused = wm && wm.focused && wm.focused();
          if (focused && wm.close) wm.close(focused.id);
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── Keyboard: config has resize:none so the WebView viewport does NOT shrink
  //    under the keyboard (the engine owns its own grid sizing). We only listen
  //    so apps could react later if they want; no layout thrash here.
  try {
    if (P.Keyboard && P.Keyboard.addListener) {
      P.Keyboard.addListener('keyboardWillShow', (info) => {
        globalThis.__aciiKeyboardHeight = (info && info.keyboardHeight) || 0;
      });
      P.Keyboard.addListener('keyboardWillHide', () => {
        globalThis.__aciiKeyboardHeight = 0;
      });
    }
  } catch (_) {}
}

export default { initMobile, isNative };
