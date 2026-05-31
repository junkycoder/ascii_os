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

A **workspace for digital makers** — writers, coders, designers, musicians,
and everyone tinkering at the edges. One calm, text-first desktop in your
browser. Runs *anywhere* the web runs: laptop, phone, tablet, TV.

---

## What it's for

A place to *make things* without the noise. Write notes and docs, sketch in
ASCII, keep your files, play with sound and pictures, share work with a friend
— all in one quiet, copyable, keyboard-friendly space.

> No accounts to juggle. No clutter. Just a desktop that gets out of your way
> and lets you work.

## The studio

- **Notes & docs** — jot, draft, and edit. Your words auto-save as you type.
- **Findman** — browse and open your files; edit text with optional vim keys.
- **Paint** — sketch and doodle directly on the character grid.
- **Media House** — bring in images, video, and audio; turn pictures into ASCII.
- **Music** — play your own tracks or tune into open internet radio.
- **Terminal** — a real shell for the curious and the command-line crowd.
- **Share** — hand a file to someone with a code; live sync, no setup.

## Make it yours

- **Themes** — flip the whole desktop's palette in an instant.
- **Widgets** — drop a clock, system stats, or a sticky note on your desktop.
- **Wallpaper & layout** — arrange windows the way you think.
- **On any screen** — touch, mouse, or keyboard; it adapts to what you've got.

## Getting around

- **1–9** — launch an app (when no window is focused)
- **Cmd/Ctrl + number** — always launch an app
- **Alt+Tab** — swap / cycle windows
- **Ctrl+W** — close the focused window
- **Esc** — un-maximize the focused window
- **Ctrl+T** — cycle the color theme
- **Alt+W** — spawn a desktop widget (clock → stats → note)
- **Alt+H** — move the taskbar (bottom → top → hidden)

## Reading this doc

- **Arrow keys** — scroll line by line
- **PageUp / PageDown** — scroll a screen at a time
- **Home / End** — jump to top or bottom
- **Tab / Shift+Tab** — cycle through links · **Enter** — open one
- **Mouse wheel** — scroll · **click** — follow a link

---

_Made with monospace and stubbornness — for the people who still like to make._
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
    // Pure reading view — fully navigable by swipe (scroll) and tap (links),
    // so the on-screen keyboard isn't needed; hiding it frees the screen on
    // touch. (Arrow / PageUp-Down / wheel still work when a keyboard exists.)
    wantsKeyboard() { return false; },
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
      // about wheel/click, so we translate here. Drag tracks the finger 1:1
      // (content follows finger): drag down → earlier lines, drag up → later.
      if (e.type === "move") {
        if (e.sy) md.scroll(-e.sy);
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
