#!/usr/bin/env bash
#
# Xcode Cloud — runs right after the repo is cloned, before resolving the
# Xcode project. The native iOS shell is committed, but the web build (www/),
# node_modules/ and CocoaPods Pods/ are .gitignored, so we regenerate them here.
#
# acii_os is zero-dep / no-build at *runtime*; this is the dev-time/CI toolchain
# only (see CAPACITOR.md). Flow: install toolchain → npm ci → build www →
# cap sync ios (copies www into the app + pod install) → ios-postsync
# (brand icon/splash + Info.plist patches).

set -euo pipefail
set -x

export HOMEBREW_NO_INSTALL_CLEANUP=TRUE

echo "📦 Installing CocoaPods + Node (Homebrew)"
brew install cocoapods node@20
brew link --overwrite node@20

# package.json + tools/ live at the repo root, not in ios/App.
cd "$CI_PRIMARY_REPOSITORY_PATH"

echo "📦 npm ci"
npm config set maxsockets 3   # documented Xcode Cloud network flakiness workaround
npm ci

echo "🔧 build www → cap sync ios → ios-postsync"
npm run sync   # = node tools/build-www.mjs && npx cap sync ios && node tools/ios-postsync.mjs

echo "✅ ci_post_clone done"
