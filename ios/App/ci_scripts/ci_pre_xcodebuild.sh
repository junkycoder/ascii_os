#!/usr/bin/env bash
#
# Xcode Cloud — runs before each xcodebuild action. Stamps a unique, always
# increasing build number (CFBundleVersion via CURRENT_PROJECT_VERSION) so every
# TestFlight upload is accepted. CI_BUILD_NUMBER is the monotonic counter that
# Xcode Cloud increments per build. MARKETING_VERSION (the user-facing 1.0) is
# left untouched — bump it by hand in the project when you cut a real release.
#
# agvtool needs VERSIONING_SYSTEM = apple-generic (set in project.pbxproj).

set -euo pipefail
set -x

if [ -n "${CI_BUILD_NUMBER:-}" ]; then
  cd "$CI_PRIMARY_REPOSITORY_PATH/ios/App"
  xcrun agvtool new-version -all "$CI_BUILD_NUMBER"
fi

echo "✅ ci_pre_xcodebuild done"
