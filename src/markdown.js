// markdown.js — ASCII grid markdown renderer.
//
// Renders a subset of markdown into an engine sub-context. Markup characters
// like ** _ * ~~ ` are HIDDEN in 'rendered' mode (they never appear as glyphs),
// styling is applied via per-span fg/bg/bold attributes.
//
// Visual degradation notes (the engine has no italic/underline cell style):
//   - bold       -> rendered with cell.bold = true
//   - italic     -> rendered with fgDim color (visually distinct, no glyphs)
//   - underline  -> rendered with fgDim color + we keep flag for future use
//   - strike     -> rendered with fgDim color (markup hidden, content kept)
//   - code (`)   -> subtle bg + accent fg
//   - link       -> link color, every cell flagged so click hit-tests work
//
// Only ONE file, no deps, ESM. Coordinates passed to render(ctx) are local
// to the ctx — we use ctx.put / ctx.text exclusively (never engine.*).

import { signal, effect } from "./signals.js";

// ── Tokenization of inline emphasis ────────────────────────────────────────
//
// Inline parser walks chars and emits spans { text, style } where style is a
// shallow object of flags: { bold, italic, underline, strike, code, link, url }.
// Markup chars are consumed (hidden).
//
// We DON'T support nested emphasis intentionally (per the spec); the first
// matching closer wins. Unclosed markers fall back to literal text.
function parseInline(line) {
  const out = [];
  const stack = []; // {marker, startIdx, style-key}
  let buf = "";
  let style = { bold: false, italic: false, underline: false, strike: false };

  const flush = () => {
    if (buf.length === 0) return;
    out.push({ text: buf, style: { ...style } });
    buf = "";
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next2 = line.slice(i, i + 2);

    // Link [label](url)  — eat eagerly
    if (ch === "[") {
      const close = line.indexOf("]", i + 1);
      if (close !== -1 && line[close + 1] === "(") {
        const urlEnd = line.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          flush();
          const label = line.slice(i + 1, close);
          const url = line.slice(close + 2, urlEnd);
          // Re-parse label inline so links can be bold etc.
          const inner = parseInline(label);
          for (const sp of inner) {
            out.push({
              text: sp.text,
              style: { ...sp.style, link: true, url },
            });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Inline code `…`
    if (ch === "`") {
      const close = line.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        out.push({
          text: line.slice(i + 1, close),
          style: { code: true },
        });
        i = close + 1;
        continue;
      }
    }

    // Bold **…**
    if (next2 === "**") {
      const close = line.indexOf("**", i + 2);
      if (close !== -1) {
        flush();
        const inner = parseInline(line.slice(i + 2, close));
        for (const sp of inner) {
          out.push({ text: sp.text, style: { ...sp.style, bold: true } });
        }
        i = close + 2;
        continue;
      }
    }

    // Strike ~~…~~
    if (next2 === "~~") {
      const close = line.indexOf("~~", i + 2);
      if (close !== -1) {
        flush();
        const inner = parseInline(line.slice(i + 2, close));
        for (const sp of inner) {
          out.push({ text: sp.text, style: { ...sp.style, strike: true } });
        }
        i = close + 2;
        continue;
      }
    }

    // Italic *…* (single star, but not ** which is handled above)
    if (ch === "*" && line[i + 1] !== "*") {
      const close = line.indexOf("*", i + 1);
      if (close !== -1 && line[close + 1] !== "*") {
        flush();
        const inner = parseInline(line.slice(i + 1, close));
        for (const sp of inner) {
          out.push({ text: sp.text, style: { ...sp.style, italic: true } });
        }
        i = close + 1;
        continue;
      }
    }

    // Underline _…_  (we require the closer to also be _ with whitespace/end
    // after — keeps snake_case_identifiers in code-like prose intact… mostly)
    if (ch === "_") {
      const close = line.indexOf("_", i + 1);
      if (close !== -1) {
        flush();
        const inner = parseInline(line.slice(i + 1, close));
        for (const sp of inner) {
          out.push({ text: sp.text, style: { ...sp.style, underline: true } });
        }
        i = close + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ── Block parser ───────────────────────────────────────────────────────────
function parseBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];

    // Fenced code block
    if (ln.startsWith("```")) {
      const lang = ln.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]); i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(ln)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headers
    if (ln.startsWith("### ")) {
      blocks.push({ type: "h3", text: ln.slice(4) }); i++; continue;
    }
    if (ln.startsWith("## ")) {
      blocks.push({ type: "h2", text: ln.slice(3) }); i++; continue;
    }
    if (ln.startsWith("# ")) {
      blocks.push({ type: "h1", text: ln.slice(2) }); i++; continue;
    }

    // Block quote (consecutive > lines)
    if (ln.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    // Unordered list item
    const ulMatch = ln.match(/^(\s*)[-*]\s+(.*)$/);
    if (ulMatch) {
      blocks.push({ type: "ul", indent: ulMatch[1].length, text: ulMatch[2] });
      i++;
      continue;
    }

    // Ordered list item
    const olMatch = ln.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      blocks.push({
        type: "ol",
        indent: olMatch[1].length,
        num: olMatch[2],
        text: olMatch[3],
      });
      i++;
      continue;
    }

    // Blank
    if (ln.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Paragraph — merge consecutive non-empty non-special lines.
    const para = [ln];
    i++;
    while (i < lines.length) {
      const p = lines[i];
      if (
        p.trim() === "" ||
        p.startsWith("#") ||
        p.startsWith(">") ||
        p.startsWith("```") ||
        /^---+\s*$/.test(p) ||
        /^(\s*)[-*]\s+/.test(p) ||
        /^(\s*)\d+\.\s+/.test(p)
      ) break;
      para.push(p);
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

// ── Word-wrap a list of spans into multiple display lines ──────────────────
//
// Each input span carries style. We split on whitespace, then greedily pack
// words into lines of at most `width` cells, re-emitting spans clipped to
// each output line. Whitespace between words is preserved as plain spans.
function wrapSpans(spans, width) {
  if (width <= 0) return [[]];
  // Tokenize spans into words + spaces, each retaining the originating style.
  const tokens = [];
  for (const sp of spans) {
    const parts = sp.text.split(/(\s+)/);
    for (const p of parts) {
      if (p.length === 0) continue;
      tokens.push({ text: p, style: sp.style, ws: /^\s+$/.test(p) });
    }
  }

  const lines = [];
  let cur = [];
  let curLen = 0;

  const pushLine = () => {
    // Trim trailing whitespace tokens.
    while (cur.length && cur[cur.length - 1].ws) {
      curLen -= cur[cur.length - 1].text.length;
      cur.pop();
    }
    lines.push(cur);
    cur = [];
    curLen = 0;
  };

  for (const tok of tokens) {
    if (curLen + tok.text.length <= width) {
      // Skip leading whitespace on a fresh line.
      if (cur.length === 0 && tok.ws) continue;
      cur.push(tok);
      curLen += tok.text.length;
      continue;
    }
    // Word longer than width — hard-break it.
    if (!tok.ws && tok.text.length > width) {
      let remaining = tok.text;
      while (remaining.length > 0) {
        const room = width - curLen;
        if (room <= 0) { pushLine(); continue; }
        const slice = remaining.slice(0, room);
        cur.push({ text: slice, style: tok.style, ws: false });
        curLen += slice.length;
        remaining = remaining.slice(room);
        if (remaining.length > 0) pushLine();
      }
      continue;
    }
    pushLine();
    if (!tok.ws) {
      cur.push(tok);
      curLen += tok.text.length;
    }
  }
  if (cur.length > 0 || lines.length === 0) pushLine();
  return lines;
}

// ── Layout: blocks → flat array of display lines ───────────────────────────
//
// Each display line is { spans: [{text, style}], meta?: {block, ...} }.
// `meta.kind` lets us mark special rows (hr, code-frame) for the renderer.
function layoutBlocks(blocks, width) {
  const out = [];
  const blank = () => out.push({ spans: [{ text: "", style: {} }] });

  for (const b of blocks) {
    if (b.type === "blank") {
      blank();
      continue;
    }
    if (b.type === "hr") {
      out.push({
        spans: [{ text: "─".repeat(Math.max(1, width)), style: { dim: true } }],
      });
      continue;
    }
    if (b.type === "h1") {
      blank();
      const txt = b.text.toUpperCase();
      const wrapped = wrapSpans([{ text: txt, style: { h1: true } }], width);
      for (const ln of wrapped) out.push({ spans: ln });
      continue;
    }
    if (b.type === "h2") {
      blank();
      const wrapped = wrapSpans(parseInline(b.text).map(s => ({
        text: s.text, style: { ...s.style, h2: true },
      })), width);
      for (const ln of wrapped) out.push({ spans: ln });
      continue;
    }
    if (b.type === "h3") {
      const wrapped = wrapSpans(parseInline(b.text).map(s => ({
        text: s.text, style: { ...s.style, bold: true },
      })), width);
      for (const ln of wrapped) out.push({ spans: ln });
      continue;
    }
    if (b.type === "p") {
      const wrapped = wrapSpans(parseInline(b.text), width);
      for (const ln of wrapped) out.push({ spans: ln });
      continue;
    }
    if (b.type === "ul" || b.type === "ol") {
      const bullet = b.type === "ul" ? "• " : `${b.num}. `;
      const indent = " ".repeat(b.indent);
      const prefix = indent + bullet;
      const hang = " ".repeat(prefix.length);
      const inner = parseInline(b.text);
      const innerWidth = Math.max(1, width - prefix.length);
      const wrapped = wrapSpans(inner, innerWidth);
      wrapped.forEach((ln, idx) => {
        const pfx = idx === 0 ? prefix : hang;
        out.push({
          spans: [
            { text: pfx, style: { dim: idx === 0 ? false : true } },
            ...ln,
          ],
        });
      });
      continue;
    }
    if (b.type === "quote") {
      const innerWidth = Math.max(1, width - 2);
      const blocks2 = parseBlocks(b.text);
      const innerLines = layoutBlocks(blocks2, innerWidth);
      for (const ln of innerLines) {
        out.push({
          spans: [
            { text: "│ ", style: { dim: true } },
            ...ln.spans.map(s => ({ text: s.text, style: { ...s.style, dim: true } })),
          ],
        });
      }
      continue;
    }
    if (b.type === "code") {
      // Frame: top border, body lines (clipped to width-2), bottom border.
      const inner = Math.max(1, width - 2);
      out.push({ spans: [{ text: "", style: {} }], meta: { kind: "codeTop", width } });
      for (const ln of b.lines) {
        // hard-break long code lines
        let rem = ln;
        if (rem.length === 0) {
          out.push({ spans: [{ text: "", style: {} }], meta: { kind: "codeBody", text: "" } });
          continue;
        }
        while (rem.length > 0) {
          const slice = rem.slice(0, inner);
          out.push({
            spans: [{ text: "", style: {} }],
            meta: { kind: "codeBody", text: slice },
          });
          rem = rem.slice(inner);
        }
      }
      out.push({ spans: [{ text: "", style: {} }], meta: { kind: "codeBot", width } });
      continue;
    }
  }
  return out;
}

// ── Public factory ─────────────────────────────────────────────────────────
export function createMarkdownView(opts = {}) {
  const source = signal(opts.source || "");
  const viewMode = signal(opts.viewMode || "rendered");
  const scrollTop = signal(0);
  const focused = signal(false);
  const links = signal([]);
  const focusedLink = signal(-1);

  let width = Math.max(1, opts.w || 80);
  let height = Math.max(1, opts.h || 24);

  // Parse + layout cache. Re-runs only on source/viewMode/width change.
  let blocks = [];
  let lines = []; // rendered-mode display lines

  function rebuild() {
    if (viewMode.peek() === "raw") {
      lines = source.peek().split("\n").map(l => ({
        spans: [{ text: l, style: { code: true } }],
      }));
      return;
    }
    blocks = parseBlocks(source.peek());
    lines = layoutBlocks(blocks, width);
  }
  rebuild();

  effect(() => { const _ = source.value; const __ = viewMode.value; rebuild(); });

  function setSource(str) { source.value = str; scrollTop.value = 0; }

  function clampScroll() {
    const max = Math.max(0, lines.length - height);
    if (scrollTop.peek() > max) scrollTop.value = max;
    if (scrollTop.peek() < 0) scrollTop.value = 0;
  }

  function scroll(delta) {
    scrollTop.value = Math.max(
      0,
      Math.min(Math.max(0, lines.length - height), scrollTop.peek() + delta),
    );
  }

  // ── render ───────────────────────────────────────────────────────────────
  //
  // Walks visible lines, draws each span at the running x cursor. Code blocks
  // are special-cased to draw their frame border characters using the ctx's
  // theme. Builds the links signal as a side effect so click hit-tests have
  // up-to-date positions.
  function render(ctx) {
    if (width !== ctx.width || height !== ctx.height) {
      width = ctx.width;
      height = ctx.height;
      rebuild();
    }
    clampScroll();
    const theme = ctx.theme.peek();
    const C = theme.colors;
    const G = theme.glyphs.border;

    // Clear visible area.
    ctx.rect(0, 0, ctx.width, ctx.height, { ch: " ", bg: C.bg });

    const collected = [];
    const top = scrollTop.peek();

    for (let row = 0; row < height; row++) {
      const lineIdx = top + row;
      if (lineIdx >= lines.length) break;
      const ln = lines[lineIdx];

      // Code-block frame rows.
      if (ln.meta?.kind === "codeTop") {
        const w = ln.meta.width;
        ctx.put(0, row, G.tl, { fg: C.border, bg: C.bg });
        for (let x = 1; x < w - 1; x++) ctx.put(x, row, G.h, { fg: C.border, bg: C.bg });
        ctx.put(w - 1, row, G.tr, { fg: C.border, bg: C.bg });
        continue;
      }
      if (ln.meta?.kind === "codeBot") {
        const w = ln.meta.width;
        ctx.put(0, row, G.bl, { fg: C.border, bg: C.bg });
        for (let x = 1; x < w - 1; x++) ctx.put(x, row, G.h, { fg: C.border, bg: C.bg });
        ctx.put(w - 1, row, G.br, { fg: C.border, bg: C.bg });
        continue;
      }
      if (ln.meta?.kind === "codeBody") {
        ctx.put(0, row, G.v, { fg: C.border, bg: C.bg });
        ctx.put(width - 1, row, G.v, { fg: C.border, bg: C.bg });
        // Code body cells get the subtle code background.
        const codeBg = C.bg;
        ctx.text(1, row, " " + ln.meta.text, { fg: C.accent, bg: codeBg });
        continue;
      }

      // Normal span line.
      let x = 0;
      for (const sp of ln.spans) {
        if (x >= width) break;
        const style = styleToCellAttrs(sp.style, C);
        // Track link rectangles (one per span).
        if (sp.style?.link) {
          collected.push({
            x, y: row, w: Math.min(sp.text.length, width - x),
            url: sp.style.url, label: sp.text,
            lineIdx,
          });
        }
        ctx.text(x, row, sp.text, style);
        x += sp.text.length;
      }
    }

    // Update links signal (only if changed by identity-of-contents).
    const prev = links.peek();
    let same = prev.length === collected.length;
    if (same) {
      for (let i = 0; i < prev.length; i++) {
        const a = prev[i], b = collected[i];
        if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.url !== b.url) {
          same = false; break;
        }
      }
    }
    if (!same) links.value = collected;

    // Highlight focused link: overlay with borderFocus underline-style color.
    const fi = focusedLink.peek();
    if (fi >= 0 && fi < collected.length) {
      const l = collected[fi];
      ctx.text(l.x, l.y, l.label.slice(0, l.w), {
        fg: C.borderFocus, bg: C.bg, bold: true,
      });
    }
  }

  // Convert our abstract style flags to engine cell attrs.
  function styleToCellAttrs(style, C) {
    if (!style) return { fg: C.fg, bg: C.bg };
    if (style.code) {
      return { fg: C.accent, bg: C.bg, bold: false };
    }
    if (style.link) {
      return { fg: C.link, bg: C.bg, bold: !!style.bold };
    }
    if (style.h1) return { fg: C.accent, bg: C.bg, bold: true };
    if (style.h2) return { fg: C.accent, bg: C.bg, bold: !!style.bold };
    // italic/underline/strike degrade to fgDim (engine has no such cell attrs).
    if (style.italic || style.underline || style.strike || style.dim) {
      return { fg: C.fgDim, bg: C.bg, bold: !!style.bold };
    }
    return { fg: C.fg, bg: C.bg, bold: !!style.bold };
  }

  // ── input ────────────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.type !== "down") return;
    if (e.key === "ArrowDown") scroll(1);
    else if (e.key === "ArrowUp") scroll(-1);
    else if (e.key === "PageDown") scroll(height - 1);
    else if (e.key === "PageUp") scroll(-(height - 1));
    else if (e.key === "Home") scrollTop.value = 0;
    else if (e.key === "End") scrollTop.value = Math.max(0, lines.length - height);
    else if (e.key === "Tab") {
      const n = links.peek().length;
      if (n === 0) return;
      let next = focusedLink.peek() + (e.shift ? -1 : 1);
      if (next < 0) next = n - 1;
      if (next >= n) next = 0;
      focusedLink.value = next;
      // Scroll to keep focused link visible.
      const l = links.peek()[next];
      if (l) {
        const top = scrollTop.peek();
        if (l.lineIdx < top) scrollTop.value = l.lineIdx;
        else if (l.lineIdx >= top + height) scrollTop.value = l.lineIdx - height + 1;
      }
    } else if (e.key === "Enter") {
      const fi = focusedLink.peek();
      const l = links.peek()[fi];
      if (l) activateLink(l.url);
    }
  }

  function activateLink(url) {
    if (opts.onLinkClick) opts.onLinkClick(url);
    else if (typeof window !== "undefined") window.open(url, "_blank");
  }

  function onMouse(e) {
    if (e.type === "wheel") {
      scroll(e.deltaY > 0 ? 3 : -3);
      return;
    }
    if (e.type === "click") {
      // Hit-test against link rects (coords are LOCAL — the consumer must
      // translate engine-coords to ctx-coords before forwarding).
      for (const l of links.peek()) {
        if (e.y === l.y && e.x >= l.x && e.x < l.x + l.w) {
          activateLink(l.url);
          return;
        }
      }
    }
  }

  return {
    render,
    scroll,
    scrollTop,
    onKey,
    onMouse,
    focused,
    setSource,
    source,
    viewMode,
    links,
    focusedLink,
  };
}
