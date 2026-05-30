#!/usr/bin/env node
// ios-postsync.mjs — apply native iOS tweaks that live in the generated ios/
// project (which is .gitignored, so we re-apply them after every cap sync/copy
// instead of hand-editing files that get regenerated). Idempotent. macOS only.
//
// Currently: hide the status bar at the OS level, from the splash onward, so
// there is no top strip even before the WebView's JS runs. This complements
// the runtime StatusBar.hide() in src/mobile.js (belt and suspenders).
//
// Usage: node tools/ios-postsync.mjs   (run by `npm run copy` / `npm run sync`)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = join(ROOT, 'ios', 'App', 'App', 'Info.plist');
const PB = '/usr/libexec/PlistBuddy';

function log(...a) { console.log('[ios-postsync]', ...a); }

if (!existsSync(PLIST)) {
  log('skip: ios/ not generated yet (run `npm run ios:add` first) —', PLIST);
  process.exit(0);
}
if (!existsSync(PB)) {
  log('skip: PlistBuddy not found (not macOS?) —', PB);
  process.exit(0);
}

// Set a bool key, adding it if missing (Set fails on a non-existent key).
function setBool(key, value) {
  const v = value ? 'true' : 'false';
  try {
    execFileSync(PB, ['-c', `Set :${key} ${v}`, PLIST], { stdio: 'pipe' });
  } catch (_) {
    execFileSync(PB, ['-c', `Add :${key} bool ${v}`, PLIST], { stdio: 'pipe' });
  }
  log(`set ${key} = ${v}`);
}

// Status bar hidden from launch; opt out of per-view-controller appearance so
// the Info.plist value actually wins.
setBool('UIStatusBarHidden', true);
setBool('UIViewControllerBasedStatusBarAppearance', false);

log('done →', PLIST);
