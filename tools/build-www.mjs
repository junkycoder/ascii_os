#!/usr/bin/env node
// build-www.mjs — assemble the static web build into www/ for Capacitor.
//
// "cap copy/sync => copy files + add mobile specifics". This is the whole
// build: NO bundler, NO transpile. It copies the vanilla web sources verbatim
// and applies a few mobile-only tweaks to index.html. Pure Node, zero npm deps.
//
// Usage: node tools/build-www.mjs   (run by `npm run build`)

import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');

// Files / dirs copied verbatim into www/. `src` is copied recursively, so any
// new module (drafts.js, vim.js, user.js, …) is picked up automatically.
// Everything else (.claude, tools, node_modules, ios, www, dotfiles) is left out.
const COPY = ['src', 'README.md', 'bench.html'];

// Stable build stamp. The native app has no no-store dev server, so we want a
// fixed cache-bust per build instead of `Date.now()` on every page load.
const STAMP = String(Date.now());

function log(...a) { console.log('[build-www]', ...a); }

// ── 1. clean www/ ──
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

// ── 2. copy verbatim assets ──
for (const item of COPY) {
  const from = join(ROOT, item);
  if (!existsSync(from)) { log('skip (missing):', item); continue; }
  cpSync(from, join(WWW, item), { recursive: true });
  log('copied', item);
}

// ── 3. transform index.html → www/index.html ──
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

function replaceOnce(re, repl, label) {
  if (!re.test(html)) { log('WARN: pattern not found:', label); return; }
  html = html.replace(re, repl);
  log('patched', label);
}

// 3a. viewport-fit=cover so content can extend under the notch / safe areas.
replaceOnce(
  /(<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no)("\s*\/?>)/,
  '$1,viewport-fit=cover$2',
  'viewport-fit=cover'
);

// 3b. fixed cache-bust stamp instead of per-load Date.now().
replaceOnce(
  /const V = '\?v=' \+ Date\.now\(\);/,
  `const V = '?v=${STAMP}';`,
  'cache-bust stamp'
);

// 3c. load + init mobile.js after the shell is created. Browser-safe: the
//     module no-ops when Capacitor is absent. Inserted right before the frame
//     loop wiring so `engine` and `shell` already exist.
replaceOnce(
  /(\n\s*engine\.onFrame\(\(\) => shell\.render\(\)\);)/,
  "\n    // mobile: native Capacitor integration (no-op in a plain browser)\n" +
  "    import('./src/mobile.js' + V)\n" +
  "      .then((m) => m.initMobile && m.initMobile(engine, shell))\n" +
  "      .catch(() => {});\n$1",
  'mobile.js loader'
);

// 3d. tiny safe-area belt-and-suspenders: black background already covers the
//     inset area; viewport-fit=cover + contentInset:always (capacitor.config)
//     do the real work. Add env() padding so the boot screen respects insets.
replaceOnce(
  /(\.boot \{[^}]*?inset: 0;)/,
  '$1 padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);',
  'boot safe-area padding'
);

writeFileSync(join(WWW, 'index.html'), html, 'utf8');
log('wrote www/index.html  (stamp', STAMP + ')');
log('done ->', WWW);
