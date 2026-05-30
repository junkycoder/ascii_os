// mobile.js — Capacitor native integration, browser-safe.
//
// This file is loaded by both the plain browser build and the native iOS app.
// It NEVER `import`s an npm package: Capacitor exposes itself as a global
// (`window.Capacitor` + `window.Capacitor.Plugins.*`), so this module is a
// valid zero-dependency ES module that also runs fine on the dev server and in
// any browser — where it simply does nothing.
//
// Contract: index.html calls `initMobile(engine, shell)` once after the shell
// is created. In a normal browser this returns immediately (no Capacitor).

export function isNative() {
  const Cap = globalThis.Capacitor;
  return !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
}

export function initMobile(engine, shell) {
  // ── Browser / dev server: no Capacitor → no-op, app runs exactly as before.
  if (!isNative()) return;

  const Cap = globalThis.Capacitor;
  const P = (Cap && Cap.Plugins) || {};

  // ── Splash: we set launchAutoHide:false so the boot screen shows through;
  //    hide once the web app is up.
  try { P.SplashScreen && P.SplashScreen.hide(); } catch (_) {}

  // ── Status bar: light text over the dark OS theme; overlay so the grid can
  //    use the full screen (safe-area handled by contentInset:always).
  try {
    if (P.StatusBar) {
      P.StatusBar.setStyle({ style: 'DARK' });          // 'DARK' = light content
      P.StatusBar.setBackgroundColor &&
        P.StatusBar.setBackgroundColor({ color: '#000000' });
    }
  } catch (_) {}

  // ── Hardware/back gesture (iOS has none, but App plugin still fires on
  //    Android and the swipe-back edge): close the focused window instead of
  //    backgrounding the app, if there is one.
  try {
    if (P.App && P.App.addListener) {
      P.App.addListener('backButton', () => {
        try {
          const wm = shell && shell.wm;
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
