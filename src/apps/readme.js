// apps/readme.js — README viewer app.
//
// Thin wrapper around the markdown view: defers all rendering, scrolling, link
// hit-testing and keyboard nav to createMarkdownView. We just supply the
// default doc and forward window events.
//
// Contract reminder: coords from the WM are LOCAL to the window's content
// area, so we pass mouse/touch events straight through without translation.

import { createMarkdownView } from "../markdown.js";

const DEFAULT_README = `# FakanOS

A tiny **ASCII operating environment** for the web — a reactive grid renderer,
a window manager, and a handful of apps. Runs *anywhere* the web runs:
desktop, mobile, TV, even a smartwatch if you squint.

---

## Why

Most UI frameworks pretend pixels are infinite. *FakanOS* picks the opposite
constraint: every screen is a grid of characters. The result is fast,
themeable, accessible, and refreshingly small.

> Zero dependencies. No build step. No TypeScript.
> One \`<script type="module">\` and you're running.

## Quick start

\`\`\`js
import { createEngine } from './engine.js'
const engine = createEngine({ target: '#app', cols: 80, rows: 24 })
engine.onFrame(() => engine.text(2, 1, 'hello, grid'))
engine.start()
\`\`\`

## Controls

- **Arrow keys** — scroll line by line
- **PageUp / PageDown** — scroll a screen at a time
- **Home / End** — jump to top or bottom
- **Tab / Shift+Tab** — cycle through links
- **Enter** — open the focused link
- **Mouse wheel** — scroll; **click** — follow a link

## Shortcuts

- **1–9** — launch an app (when no window is focused)
- **Cmd/Ctrl + number** — always launch an app
- **Alt+Tab** — swap / cycle windows
- **Ctrl+W** — close the focused window
- **Esc** — un-maximize the focused window
- **Ctrl+T** — cycle the color theme
- **Alt+W** — spawn a desktop widget (clock → stats → note)
- **Alt+H** — move the taskbar (bottom → top → hidden)

## What ships

1. A reactive *signals* primitive (\`signal\`, \`computed\`, \`effect\`)
2. The grid \`engine\` with theming, input, sub-contexts
3. A windowing layer with focus, drag, resize
4. Apps: terminal, editor, file browser, and this reader

## Learn more

See the [project page](https://github.com/) or read the engine source —
it's about ~500 lines and ~~scary~~ approachable.

---

_Made with monospace and stubbornness._
`;

export function createApp(initialCtx, win) {
  // Build the markdown view sized to the initial content area. The view
  // re-layouts automatically when ctx.width / ctx.height change between
  // render calls, so resize "just works".
  const md = createMarkdownView({
    source: DEFAULT_README,
    w: initialCtx.width,
    h: initialCtx.height,
  });

  return {
    render(ctx) {
      md.render(ctx);
    },
    onKey(e) {
      md.onKey(e);
    },
    onMouse(e) {
      md.onMouse(e);
    },
    onTouch(e) {
      // Map touch gestures to scroll — the markdown view itself only knows
      // about wheel/click, so we translate here.
      if (e.type === "swipe") {
        if (e.dir === "up") md.scroll(3);
        else if (e.dir === "down") md.scroll(-3);
      } else if (e.type === "tap") {
        // Synthesize a click so link hit-testing fires.
        md.onMouse({ type: "click", x: e.x, y: e.y, button: 0 });
      }
    },
    destroy() {
      // Nothing to tear down — no timers, no listeners outside our handlers.
    },
  };
}
