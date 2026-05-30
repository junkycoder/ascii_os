#!/usr/bin/env bash
# gen-app-assets.sh — regenerate the iOS app icon + splash masters from scratch
# using ImageMagick (a dev-time tool; not a runtime dep). Output lands in the
# committed assets/ios/ dir; `tools/ios-postsync.mjs` copies it into the
# .gitignored ios/ asset catalog after every `cap sync` / `cap copy`.
#
# Design: acii_os brand — a glowing green ">" terminal prompt + block cursor on
# a near-black field (accent #00ff88, bg #0d0d0d / splash #000000). Menlo font.
#
# Usage: bash tools/gen-app-assets.sh    (requires `magick`; macOS has Menlo)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/ios"
MENLO="/System/Library/Fonts/Menlo.ttc"
ACCENT="#00ff88"
mkdir -p "$OUT"

command -v magick >/dev/null || { echo "need ImageMagick (magick)"; exit 1; }

# --- App icon: 1024x1024, opaque (iOS forbids alpha in AppIcon) -------------
tmp="$(mktemp -d)"
magick -size 1024x1024 xc:none \
  -font "$MENLO" -fill "$ACCENT" -gravity center \
  -pointsize 460 -annotate +-95-22 '>' \
  -fill "$ACCENT" -draw 'rectangle 612,402 712,632' \
  "$tmp/glyph.png"
magick "$tmp/glyph.png" -blur 0x22 -channel A -evaluate multiply 0.7 +channel "$tmp/glow.png"
magick -size 1024x1024 xc:'#0d0d0d' \
  "$tmp/glow.png" -compose over -composite \
  "$tmp/glyph.png" -compose over -composite \
  -alpha off "$OUT/icon-1024.png"

# --- Splash: 2732x2732, black field, centred mark + "fakan.os" wordmark ------
magick -size 2732x2732 xc:none \
  -font "$MENLO" -fill "$ACCENT" -gravity center \
  -pointsize 300 -annotate +-62-180 '>' \
  -fill "$ACCENT" -draw 'rectangle 1426,1086 1492,1236' \
  "$tmp/smark.png"
magick "$tmp/smark.png" -blur 0x16 -channel A -evaluate multiply 0.7 +channel "$tmp/sglow.png"
magick -size 2732x2732 xc:none \
  -font "$MENLO" -fill '#d8d8d8' -gravity center \
  -pointsize 120 -annotate +0+170 'FakanOS' \
  "$tmp/sword.png"
magick -size 2732x2732 xc:'#000000' \
  "$tmp/sglow.png" -compose over -composite \
  "$tmp/smark.png" -compose over -composite \
  "$tmp/sword.png" -compose over -composite \
  -alpha off "$OUT/splash-2732.png"

rm -rf "$tmp"
echo "[gen-app-assets] wrote $OUT/icon-1024.png + $OUT/splash-2732.png"
