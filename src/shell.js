// acii_os shell — desktop / launcher built on top of engine + wm + apps.
//
// Wires:
//   - background (themed pattern)
//   - app registry → desktop icons → openable windows
//   - taskbar with running apps
//   - input routing: keys + mouse → focused window's app
//   - responsive mode: watch/mobile = single fullscreen, tablet+ = floating WM
//   - persistence: icon positions + open windows + theme to localStorage
//
// Public API:
//   const shell = createShell(engine, { apps, background?, persist? })
//   shell.openApp(id), shell.closeApp(id), shell.cycleTheme()
//   call shell inside engine.onFrame() — it manages WM render + background.

import { signal, effect } from './signals.js';
import { createWindowManager } from './wm.js';
import { createFS } from './fs.js';
import { createContextMenu } from './ui-menu.js';
import { createMusicPlayer } from './music.js';

// Shared FS singleton — used by Paint, Finder, and Shell (desktop icons).
const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });

// Per-instance music players for the 'music' widget, keyed by widget id.
const musicPlayers = new Map();
function getMusicPlayer(id) {
  let p = musicPlayers.get(id);
  if (!p) { p = createMusicPlayer(fs); musicPlayers.set(id, p); }
  return p;
}

// ── System info (memory + storage) for the 'system' widget ──────────
function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}
const sysInfo = { at: 0, usage: 0, quota: 0, lsBytes: 0 };
function refreshSysInfo() {
  try {
    let b = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      b += (k.length + (localStorage.getItem(k) || '').length) * 2; // UTF-16
    }
    sysInfo.lsBytes = b;
  } catch {}
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate()
      .then((e) => { sysInfo.usage = e.usage || 0; sysInfo.quota = e.quota || 0; })
      .catch(() => {});
  }
}
function drawBar(ctx, x, y, w, frac, c) {
  const f = Math.max(0, Math.min(1, frac || 0));
  const fill = Math.round(w * f);
  for (let i = 0; i < w; i++) {
    ctx.put(x + i, y, i < fill ? '█' : '░', { fg: i < fill ? c.accent : c.fgDim, bg: c.bg });
  }
}

const STORAGE_KEY = 'acii.shell.v2';

const PATTERNS = {
  dots:   { ch: '·', spacing: 4 },
  grid:   { ch: '+', spacing: 6 },
  scan:   { ch: '─', spacing: 3 },
  blank:  null,
};

// Icon dimensions: a tight tile (3-row box hugging the glyph + up to 2 label rows).
const ICON_W = 8;
const ICON_BOX_H = 3;          // bordered box height (top + 1 interior + bottom)
const ICON_H = ICON_BOX_H + 1; // box + 1 baseline label row (hit-test height)
const ICON_LAYOUT_V = 4;       // bump when icon size changes → drop stale positions

// Built-in widgets — pinned panels on the desktop. Each renders into a
// sub-context. Spec: { defaultSize: {w, h}, render(ctx, widget) }.
const WIDGETS = {
  clock: {
    defaultSize: { w: 12, h: 4 },
    label: 'clock',
    render(ctx) {
      const c = ctx.theme.peek().colors;
      ctx.box(0, 0, ctx.width, ctx.height, { fg: c.border, glyphSet: 'borderRound' });
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const time = `${hh}:${mm}:${ss}`;
      const tx = Math.max(1, Math.floor((ctx.width - time.length) / 2));
      ctx.text(tx, 1, time, { fg: c.accent, bold: true });
      if (ctx.height >= 4) {
        // ISO date: YYYY-MM-DD (10 chars, fits w=12 with borders)
        const yyyy = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const date = `${yyyy}-${mo}-${dd}`;
        const dx = Math.max(1, Math.floor((ctx.width - date.length) / 2));
        ctx.text(dx, 2, date.slice(0, ctx.width - 2), { fg: c.fgDim });
      }
    },
  },
  stats: {
    defaultSize: { w: 16, h: 7 },
    label: 'stats',
    render(ctx, w, env) {
      const c = ctx.theme.peek().colors;
      ctx.box(0, 0, ctx.width, ctx.height, { fg: c.border });
      ctx.text(1, 0, ' stats ', { fg: c.fgDim });
      const rows = [
        ['fps ', String(env.fps)],
        ['cols', String(env.cols)],
        ['rows', String(env.rows)],
        ['mode', env.mode],
        ['thm ', env.theme],
      ];
      for (let i = 0; i < rows.length && i < ctx.height - 2; i++) {
        ctx.text(1, 1 + i, rows[i][0], { fg: c.fgDim });
        ctx.text(6, 1 + i, rows[i][1].slice(0, ctx.width - 7), { fg: c.accent });
      }
    },
  },
  note: {
    defaultSize: { w: 24, h: 6 },
    label: 'note',
    render(ctx, w) {
      const c = ctx.theme.peek().colors;
      ctx.box(0, 0, ctx.width, ctx.height, { fg: c.warning, glyphSet: 'borderRound' });
      ctx.text(1, 0, ' note ', { fg: c.warning });
      const text = w.config?.text || 'sticky note — drag to move';
      // Simple word wrap.
      const words = String(text).split(/\s+/);
      let line = '';
      let yy = 1;
      for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (next.length > ctx.width - 2) {
          if (line) ctx.text(1, yy++, line, { fg: c.fg });
          line = word;
          if (yy >= ctx.height - 1) break;
        } else {
          line = next;
        }
      }
      if (line && yy < ctx.height - 1) ctx.text(1, yy, line, { fg: c.fg });
    },
  },
  music: {
    defaultSize: { w: 26, h: 6 },
    label: 'music',
    render(ctx, w) {
      const c = ctx.theme.peek().colors;
      const p = getMusicPlayer(w.id);
      const st = p.state();
      const W = ctx.width, H = ctx.height;
      ctx.box(0, 0, W, H, { fg: c.accent, glyphSet: 'borderRound' });
      ctx.text(1, 0, ' music ', { fg: c.accent });

      // Source toggle button (top-right): [ disk ] / [radio]
      const src = st.mode === 'disk' ? '[ disk ]' : '[radio]';
      const srcX = Math.max(8, W - src.length - 1);
      ctx.text(srcX, 0, src, { fg: c.fgDim });

      // Track / station name (or error).
      const name = (st.error ? '! ' + st.error : st.label).slice(0, W - 2);
      ctx.text(1, 1, name, { fg: st.error ? c.warning : c.fg, bold: !st.error });
      // Position.
      const pos = st.count
        ? `${st.mode === 'disk' ? 'track' : 'station'} ${st.idx + 1}/${st.count}`
        : (st.mode === 'disk' ? 'drop audio on the desktop' : 'no stations');
      ctx.text(1, 2, pos.slice(0, W - 2), { fg: c.fgDim });

      // Transport buttons: [<]  [>|=]  [»]   (play shows [=] while playing)
      const cy = H - 2;
      const prev = '[<]', play = st.playing ? '[=]' : '[>]', next = '[»]';
      const px = Math.max(1, Math.floor((W - (prev.length + play.length + next.length + 4)) / 2));
      const playX = px + prev.length + 2;
      const nextX = playX + play.length + 2;
      ctx.text(px, cy, prev, { fg: c.accent, bold: true });
      ctx.text(playX, cy, play, { fg: st.playing ? c.success : c.accent, bold: true });
      ctx.text(nextX, cy, next, { fg: c.accent, bold: true });

      // Stash clickable hit-zones for onClick (local coords).
      w._mctrl = { srcX, srcW: src.length, cy, prevX: px, prevW: prev.length,
                   playX, playW: play.length, nextX, nextW: next.length };
    },
    // Clicks on controls (local coords). Returns true when handled so the
    // shell doesn't start a drag.
    onClick(lx, ly, w) {
      const p = getMusicPlayer(w.id);
      const m = w._mctrl;
      if (!m) return false;
      if (ly === 0 && lx >= m.srcX && lx < m.srcX + m.srcW) { p.toggleMode(); return true; }
      if (ly === m.cy) {
        if (lx >= m.prevX && lx < m.prevX + m.prevW) { p.prev(); return true; }
        if (lx >= m.playX && lx < m.playX + m.playW) { p.toggle(); return true; }
        if (lx >= m.nextX && lx < m.nextX + m.nextW) { p.next(); return true; }
      }
      return false;
    },
  },
  system: {
    defaultSize: { w: 30, h: 7 },
    label: 'system',
    render(ctx) {
      const c = ctx.theme.peek().colors;
      const W = ctx.width, H = ctx.height;
      if (performance.now() - sysInfo.at > 2000) { sysInfo.at = performance.now(); refreshSysInfo(); }
      ctx.box(0, 0, W, H, { fg: c.border, glyphSet: 'borderRound' });
      ctx.text(1, 0, ' system ', { fg: c.accent });
      const barW = Math.max(4, W - 2);
      let y = 1;
      // RAM (JS heap on Chromium; else approximate device memory).
      const mem = performance.memory;
      if (mem && mem.jsHeapSizeLimit) {
        ctx.text(1, y, 'ram', { fg: c.fgDim });
        ctx.text(5, y, `${fmtBytes(mem.usedJSHeapSize)} / ${fmtBytes(mem.jsHeapSizeLimit)} heap`, { fg: c.fg });
        if (++y < H - 1) { drawBar(ctx, 1, y, barW, mem.usedJSHeapSize / mem.jsHeapSizeLimit, c); y++; }
      } else {
        ctx.text(1, y, `ram  ~${navigator.deviceMemory || '?'} GB device`, { fg: c.fg });
        y++;
      }
      // Storage (origin quota).
      if (y < H - 1) {
        ctx.text(1, y, 'disk', { fg: c.fgDim });
        ctx.text(6, y, sysInfo.quota ? `${fmtBytes(sysInfo.usage)} / ${fmtBytes(sysInfo.quota)}` : 'estimating…', { fg: c.fg });
        if (++y < H - 1 && sysInfo.quota) { drawBar(ctx, 1, y, barW, sysInfo.usage / sysInfo.quota, c); y++; }
      }
      // Virtual FS footprint in localStorage.
      if (y < H - 1) ctx.text(1, y, `fs   ${fmtBytes(sysInfo.lsBytes)} · localStorage`, { fg: c.fgDim });
    },
  },
};

export function createShell(engine, opts = {}) {
  const apps = opts.apps || [];
  const persist = opts.persist !== false;
  const taskbarPos = signal(opts.taskbarPosition || 'bottom'); // bottom|top|hidden
  const backgroundKind = signal(opts.background || 'dots');
  // Currently selected desktop file (for Quick-Look: spacebar previews it).
  const selectedFile = signal(null);

  const wm = createWindowManager(engine);

  // Map: appId -> { app spec, instance(s)?, win }
  const running = new Map(); // winId -> { spec, instance, win }
  const iconPositions = new Map(); // appId -> { x, y }
  const widgets = signal([]); // [{ id, type, x, y, w, h, config }]
  let _widgetSeq = 1;

  // Wallpaper: path to a paint file in FS, or null for pattern background.
  const wallpaperPath = signal(null);

  // Active context menu (single at a time). Closed on outside click.
  const activeMenu = signal(null);

  // File icon positions: filename → { x, y }
  const fileIconPos = new Map();

  // Multi-selection of desktop files (set of '/desktop/<name>' paths) for bulk
  // actions. `selectedFile` (above) stays the single lead / Quick-Look target.
  const selectedFiles = new Set();

  // Drag state for icons / widgets (separate from WM's window drag).
  // shape: { kind: 'icon'|'widget'|'file', target, ox, oy, baseX, baseY, moved }
  //   or marquee: { kind:'marquee', x0, y0, x1, y1, base:Set, moved }
  let deskDrag = null;

  // ── Persistence ─────────────────────────────────────────────────
  function load() {
    if (!persist) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function save() {
    if (!persist) return;
    const state = {
      iconLayoutV: ICON_LAYOUT_V,
      theme: engine.theme.peek().name,
      background: backgroundKind.peek(),
      taskbarPosition: taskbarPos.peek(),
      icons: Object.fromEntries(iconPositions),
      widgets: widgets.peek().map(w => ({ id: w.id, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, config: w.config || null })),
      wallpaperPath: wallpaperPath.peek(),
      fileIcons: Object.fromEntries(fileIconPos),
      windows: [...running.values()].map(({ spec, win }) => ({
        appId: spec.id,
        x: win.x.peek(), y: win.y.peek(),
        w: win.w.peek(), h: win.h.peek(),
        maximized: win.maximized.peek(),
      })),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }
  const saved = load();
  if (saved) {
    if (saved.theme && engine.themes[saved.theme]) {
      engine.theme.value = engine.themes[saved.theme];
    }
    if (saved.background) backgroundKind.value = saved.background;
    if (saved.taskbarPosition) taskbarPos.value = saved.taskbarPosition;
    // Only restore saved icon positions if they were laid out for the current
    // icon size; otherwise drop them so they re-default with the new spacing.
    if (saved.iconLayoutV === ICON_LAYOUT_V) {
      if (saved.icons) for (const [k, v] of Object.entries(saved.icons)) iconPositions.set(k, v);
      if (saved.fileIcons) for (const [k, v] of Object.entries(saved.fileIcons)) fileIconPos.set(k, v);
    }
    if (saved.wallpaperPath) wallpaperPath.value = saved.wallpaperPath;
    if (saved.widgets?.length) {
      widgets.value = saved.widgets.map(w => ({ ...w, id: w.id || `wd-${_widgetSeq++}` }));
      const maxId = Math.max(0, ...saved.widgets.map(w => {
        const m = /^wd-(\d+)$/.exec(w.id || ''); return m ? +m[1] : 0;
      }));
      _widgetSeq = maxId + 1;
    }
  }

  // Save when state changes (debounced)
  let saveT = null;
  function bumpSave() {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(save, 300);
  }

  // ── Icon layout ─────────────────────────────────────────────────
  // Default grid: left column on wide screens, grid on narrow.
  // Each icon is ICON_W × ICON_H cells; spacing 1 cell.
  function defaultIconPos(appIdx) {
    const isWide = engine.cols.peek() >= 60;
    const slotH = ICON_BOX_H + 2; // box (5) + 2 label rows, tight spacing
    const slotW = ICON_W + 2;
    if (isWide) {
      return { x: 2, y: 1 + appIdx * slotH };
    } else {
      const perRow = Math.max(1, Math.floor((engine.cols.peek() - 2) / slotW));
      return {
        x: 2 + (appIdx % perRow) * slotW,
        y: 1 + Math.floor(appIdx / perRow) * slotH,
      };
    }
  }
  function iconPos(appId, appIdx) {
    if (iconPositions.has(appId)) return iconPositions.get(appId);
    const p = defaultIconPos(appIdx);
    iconPositions.set(appId, p);
    return p;
  }

  // ── App lifecycle ───────────────────────────────────────────────
  let _winSeq = 1;

  function openApp(appId, geom) {
    const spec = apps.find(a => a.id === appId);
    if (!spec) return null;
    const mode = engine.mode.peek();
    // On watch/mobile: only one window at a time — close others.
    if (mode === 'watch' || mode === 'mobile') {
      for (const r of [...running.values()]) closeWindow(r.win);
    }

    const cols = engine.cols.peek();
    const rows = engine.rows.peek();
    const tbH = taskbarPos.peek() === 'hidden' ? 0 : 1;

    let x, y, w, h, maximized;
    if (mode === 'watch') {
      x = 0; y = 0; w = cols; h = rows; maximized = true;
    } else if (mode === 'mobile') {
      x = 0; y = 0; w = cols; h = rows - tbH; maximized = true;
    } else {
      // Floating defaults: try to use saved geom or default
      const defaultW = Math.min(50, cols - 8);
      const defaultH = Math.min(20, rows - 6);
      x = geom?.x ?? (4 + ((_winSeq * 3) % Math.max(1, cols - defaultW - 4)));
      y = geom?.y ?? (2 + ((_winSeq * 2) % Math.max(1, rows - defaultH - 4)));
      w = geom?.w ?? defaultW;
      h = geom?.h ?? defaultH;
      maximized = geom?.maximized || false;
    }
    _winSeq++;

    // Lazy app instantiation on first body call (so initialCtx is real).
    let inst = null;
    const win = wm.addWindow({
      title: spec.label,
      x, y, w, h, maximized,
      resizable: true, closable: true, maximizable: true,
      body: (ctx, w_) => {
        if (!inst) {
          try { inst = spec.factory(ctx, w_); }
          catch (err) {
            ctx.text(0, 0, '[app init error]', { fg: ctx.theme.peek().colors.error, bold: true });
            ctx.text(0, 1, String(err?.message || err).slice(0, ctx.width), { fg: ctx.theme.peek().colors.error });
            return;
          }
          // Store instance on the registered record
          const rec = running.get(win.id);
          if (rec) rec.instance = inst;
        }
        try { inst.render(ctx); }
        catch (err) {
          ctx.text(0, 0, '[render error]', { fg: ctx.theme.peek().colors.error, bold: true });
          ctx.text(0, 1, String(err?.message || err).slice(0, ctx.width), { fg: ctx.theme.peek().colors.error });
        }
      },
      onClose: () => {
        const rec = running.get(win.id);
        if (rec?.instance?.destroy) {
          try { rec.instance.destroy(); } catch {}
        }
        running.delete(win.id);
        bumpSave();
      },
    });
    running.set(win.id, { spec, instance: null, win });
    win.focus();
    bumpSave();
    return win;
  }

  function closeWindow(win) { win.close(); }

  function closeApp(appId) {
    for (const r of [...running.values()]) if (r.spec.id === appId) r.win.close();
  }

  // Persist on geometry changes
  effect(() => {
    // Touch all window signals so we re-run on change.
    for (const r of running.values()) {
      r.win.x.value; r.win.y.value; r.win.w.value; r.win.h.value; r.win.maximized.value;
    }
    bumpSave();
  });
  effect(() => { engine.theme.value; bumpSave(); });

  // ── Background ──────────────────────────────────────────────────
  // Wallpaper: parse a /desktop/*.acii paint file and tile/center it.
  // Format (from paint.js): first line "# acii-paint v1 WxH", then H rows
  // of "<char><colorName>|..." separated by '|'.
  // Decode paint-file color tags: '<colorChar><styleChar>' (e.g. 'a1' = accent bold).
  const PAINT_CODE_COLOR = { a: 'accent', f: 'fg', e: 'error', w: 'warning', s: 'success', l: 'link', d: 'fgDim' };
  function parsePaintFile(text) {
    if (!text) return null;
    const lines = text.split('\n');
    const head = lines[0] || '';
    const m = /^#\s*acii-paint\s+v1\s+(\d+)x(\d+)/i.exec(head);
    if (!m) return null;
    const W = +m[1], H = +m[2];
    const cells = [];
    for (let y = 0; y < H; y++) {
      const row = [];
      const parts = (lines[1 + y] || '').split('|');
      for (let x = 0; x < W; x++) {
        const tok = parts[x] || ' f0';
        const ch = tok.length >= 2 ? tok.slice(0, tok.length - 2) : ' ';
        const tag = tok.length >= 2 ? tok.slice(-2) : 'f0';
        const color = PAINT_CODE_COLOR[tag[0]] || 'fg';
        const bold = tag[1] === '1';
        row.push({ ch: ch || ' ', color, bold });
      }
      cells.push(row);
    }
    return { W, H, cells };
  }

  function renderBackground() {
    const t = engine.theme.peek();
    const c = t.colors;
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();
    engine.rect(0, 0, cols, rows, { ch: ' ', fg: c.fg, bg: c.bg });

    // Wallpaper from paint file?
    const wp = wallpaperPath.peek();
    if (wp && fs.exists(wp)) {
      const text = fs.readText(wp);
      const pic = parsePaintFile(text);
      if (pic) {
        const ox = Math.max(0, Math.floor((cols - pic.W) / 2));
        const oy = Math.max(0, Math.floor((rows - pic.H) / 2));
        for (let y = 0; y < pic.H; y++) {
          for (let x = 0; x < pic.W; x++) {
            const cell = pic.cells[y][x];
            if (cell.ch === ' ') continue;
            const fg = c[cell.color] || c.fg;
            engine.put(ox + x, oy + y, cell.ch, { fg, bold: !!cell.bold });
          }
        }
        return;
      }
    }

    // Pattern fallback
    const kind = backgroundKind.peek();
    const pat = PATTERNS[kind];
    if (!pat) return;
    for (let y = 0; y < rows; y += pat.spacing) {
      for (let x = 0; x < cols; x += pat.spacing) {
        engine.put(x, y, pat.ch, { fg: c.border });
      }
    }
  }

  // ── Desktop icons ───────────────────────────────────────────────
  // Icon layout (ICON_W=6, ICON_H=4):
  //   ╭────╮     row 0
  //   │ $  │     row 1   (glyph char from app.icon — first non-bracket char)
  //   ╰────╯     row 2
  //    Term      row 3   (label)
  function glyphFromIcon(raw) {
    if (!raw) return '?';
    // Take the first non-bracket / non-space char.
    for (const ch of raw) if (!'[](){}<> '.includes(ch)) return ch;
    return raw[0];
  }

  // Icon labels center under the tile and may wrap to a second row, so
  // two-word names ("Game Maker", "Media House") stay readable.
  const LABEL_W = ICON_W;
  function splitLabel(raw) {
    const s = String(raw == null ? '' : raw);
    if (s.length <= LABEL_W) return [s];
    // Prefer a break near the middle, at a separator or a camelCase boundary.
    const mid = Math.ceil(s.length / 2);
    let best = -1, bestDist = Infinity;
    for (let i = 1; i < s.length; i++) {
      const sep = /[\s_\-.]/.test(s[i - 1]) || /[\s_\-.]/.test(s[i]);
      const camel = /[a-z0-9]/.test(s[i - 1]) && /[A-Z]/.test(s[i]);
      if (sep || camel) { const d = Math.abs(i - mid); if (d < bestDist) { bestDist = d; best = i; } }
    }
    if (best === -1) best = mid;
    const clip = (t) => t.length > LABEL_W ? t.slice(0, LABEL_W - 1) + '…' : t;
    const a = clip(s.slice(0, best).replace(/[\s_\-.]+$/, ''));
    const b = clip(s.slice(best).replace(/^[\s_\-.]+/, ''));
    return b ? [a, b] : [a];
  }
  function drawIconLabel(boxX, labelY, raw, fg) {
    const lines = splitLabel(raw);
    for (let i = 0; i < lines.length && i < 2; i++) {
      const lbl = lines[i];
      const lx = Math.max(0, boxX + Math.floor((ICON_W - lbl.length) / 2));
      engine.text(lx, labelY + i, lbl, { fg });
    }
  }

  // A rounded tile: ICON_W wide × ICON_BOX_H tall, glyph centered on a faint
  // face. Shared by app and file icons for a consistent, bigger look.
  function drawIconTile(x, y, glyph, borderFg, glyphFg, faceBg) {
    const g = engine.theme.peek().glyphs.borderRound;
    const inner = ICON_W - 2;
    engine.text(x, y, g.tl + g.h.repeat(inner) + g.tr, { fg: borderFg });
    for (let r = 1; r < ICON_BOX_H - 1; r++) {
      engine.put(x, y + r, g.v, { fg: borderFg });
      engine.text(x + 1, y + r, ' '.repeat(inner), { fg: borderFg, bg: faceBg });
      engine.put(x + ICON_W - 1, y + r, g.v, { fg: borderFg });
    }
    engine.text(x, y + ICON_BOX_H - 1, g.bl + g.h.repeat(inner) + g.br, { fg: borderFg });
    // Glyph (1–2 chars) centered in the interior.
    const gstr = String(glyph).slice(0, 2);
    const gx = x + Math.floor((ICON_W - gstr.length) / 2);
    const gy = y + Math.floor(ICON_BOX_H / 2);
    engine.text(gx, gy, gstr, { fg: glyphFg, bg: faceBg, bold: true });
  }

  function renderIcons() {
    if (engine.mode.peek() === 'watch') return; // no icons on watch
    if (running.size > 0 && engine.mode.peek() === 'mobile') return;

    const t = engine.theme.peek();
    const c = t.colors;
    const g = t.glyphs.borderRound;

    apps.forEach((app, i) => {
      const { x, y } = iconPos(app.id, i);
      const isDragging = deskDrag?.kind === 'icon' && deskDrag.target === app.id;
      const fg = isDragging ? c.borderFocus : c.accent;
      const labelFg = isDragging ? c.borderFocus : c.fg;
      const face = isDragging ? (c.accentDim || c.border) : c.border;
      // Bigger rounded tile with a faint face + centered glyph.
      drawIconTile(x, y, glyphFromIcon(app.icon), fg, c.accent, face);
      // Centered label under the tile (wraps for long / two-word names).
      drawIconLabel(x, y + ICON_BOX_H, app.label || app.id, labelFg);
    });
  }

  function iconHitTest(px, py) {
    for (let i = 0; i < apps.length; i++) {
      const app = apps[i];
      const { x, y } = iconPos(app.id, i);
      if (px >= x && px < x + ICON_W && py >= y && py < y + ICON_H) return app;
    }
    return null;
  }

  // ── Desktop file icons (from /desktop/ in shared FS) ────────────
  function extGlyph(name) {
    const ext = name.toLowerCase().split('.').pop();
    return ({
      acii: '✎',  txt: 'T',  md: 'M',
      json: '{}', html: '<>', js: 'JS',
      mp3: '♪',  wav: '♪',  mp4: '▶', mov: '▶',
      png: '🖼', jpg: '🖼', jpeg: '🖼',
    })[ext] || '·';
  }

  function listDesktopFiles() {
    if (!fs.exists('/desktop')) return [];
    return fs.list('/desktop').filter(f => f.type === 'file');
  }

  function defaultFileIconPos(fileIdx) {
    // Files go in a column to the RIGHT of app icons.
    const isWide = engine.cols.peek() >= 60;
    const slotH = ICON_BOX_H + 2;
    if (isWide) {
      return { x: 2 + (ICON_W + 2) + 4, y: 1 + fileIdx * slotH };
    } else {
      // Below apps in narrow mode
      const appsHeight = 1 + apps.length * slotH;
      return { x: 2, y: appsHeight + 1 + fileIdx * slotH };
    }
  }

  function fileIcon(name, fileIdx) {
    if (fileIconPos.has(name)) return fileIconPos.get(name);
    const p = defaultFileIconPos(fileIdx);
    fileIconPos.set(name, p);
    return p;
  }

  function renderFileIcons() {
    if (engine.mode.peek() === 'watch') return;
    if (running.size > 0 && engine.mode.peek() === 'mobile') return;

    const t = engine.theme.peek();
    const c = t.colors;
    const g = t.glyphs.borderRound;
    const files = listDesktopFiles();

    files.forEach((f, i) => {
      const { x, y } = fileIcon(f.name, i);
      const path = '/desktop/' + f.name;
      const isDragging = deskDrag?.kind === 'file' && deskDrag.target === f.name;
      const isWallpaper = wallpaperPath.peek() === path;
      const isSelected = selectedFiles.has(path);
      const fg = isDragging ? c.borderFocus
              : isSelected ? c.accent
              : isWallpaper ? c.warning
              : c.accentDim;
      const glyphFg = isWallpaper ? c.warning : (isSelected ? c.accent : c.fg);
      // Selected tiles get a theme-tinted face; others stay outline-only so they
      // read lighter than app icons.
      const faceBg = isSelected ? c.border : c.bg;
      drawIconTile(x, y, extGlyph(f.name), fg, glyphFg, faceBg);
      // Filename centered under the tile (wraps for two-part names).
      drawIconLabel(x, y + ICON_BOX_H, f.name, isSelected ? c.accent : c.fg);
    });
  }

  function fileIconHitTest(px, py) {
    const files = listDesktopFiles();
    for (let i = 0; i < files.length; i++) {
      const { x, y } = fileIcon(files[i].name, i);
      if (px >= x && px < x + ICON_W && py >= y && py < y + ICON_H) {
        return files[i];
      }
    }
    return null;
  }

  // ── Desktop file selection (single + multi for bulk actions) ────
  function leadFile() {
    return selectedFiles.size ? [...selectedFiles][selectedFiles.size - 1] : null;
  }
  function clearFileSelection() {
    if (!selectedFiles.size && !selectedFile.peek()) return;
    selectedFiles.clear();
    selectedFile.value = null;
  }
  function selectSingleFile(path) {
    selectedFiles.clear();
    selectedFiles.add(path);
    selectedFile.value = path;
  }
  function toggleFileSelection(path) {
    if (selectedFiles.has(path)) selectedFiles.delete(path);
    else selectedFiles.add(path);
    selectedFile.value = leadFile();
  }
  function selectAllDesktopFiles() {
    selectedFiles.clear();
    for (const f of listDesktopFiles()) selectedFiles.add('/desktop/' + f.name);
    selectedFile.value = leadFile();
  }
  function deleteSelectedFiles() {
    const paths = [...selectedFiles].filter(p => fs.exists(p));
    if (!paths.length) return;
    const msg = paths.length === 1
      ? 'Smazat ' + paths[0] + ' ?'
      : 'Smazat ' + paths.length + ' položek?';
    if (!window.confirm(msg)) return;
    for (const p of paths) {
      if (wallpaperPath.peek() === p) clearWallpaper();
      try { fs.delete(p); } catch {}
      fileIconPos.delete(p.slice('/desktop/'.length));
    }
    clearFileSelection();
    bumpSave();
  }

  // Recompute the marquee's covered files. `m.base` is the selection snapshot
  // at drag start (so an additive Cmd-drag adds to what was already selected).
  function updateMarqueeSelection(m) {
    const lx = Math.min(m.x0, m.x1), rx = Math.max(m.x0, m.x1);
    const ty = Math.min(m.y0, m.y1), by = Math.max(m.y0, m.y1);
    const next = new Set(m.base || []);
    listDesktopFiles().forEach((f, i) => {
      const { x, y } = fileIcon(f.name, i);
      // Rectangle intersection of the icon's hit box with the marquee.
      if (x < rx && x + ICON_W > lx && y < by && y + ICON_H > ty) {
        next.add('/desktop/' + f.name);
      }
    });
    selectedFiles.clear();
    for (const p of next) selectedFiles.add(p);
    selectedFile.value = leadFile();
  }

  function renderMarquee() {
    if (!deskDrag || deskDrag.kind !== 'marquee' || !deskDrag.moved) return;
    const c = engine.theme.peek().colors;
    const lx = Math.min(deskDrag.x0, deskDrag.x1), rx = Math.max(deskDrag.x0, deskDrag.x1);
    const ty = Math.min(deskDrag.y0, deskDrag.y1), by = Math.max(deskDrag.y0, deskDrag.y1);
    const w = rx - lx + 1, h = by - ty + 1;
    if (w < 2 || h < 2) return;
    engine.box(lx, ty, w, h, { fg: c.borderFocus, glyphSet: 'borderRound' });
  }

  // ── Widgets ─────────────────────────────────────────────────────
  function addWidget(type, opts = {}) {
    const spec = WIDGETS[type];
    if (!spec) return null;
    const w = {
      id: opts.id || `wd-${_widgetSeq++}`,
      type,
      x: opts.x ?? 4,
      y: opts.y ?? 4,
      w: opts.w ?? spec.defaultSize.w,
      h: opts.h ?? spec.defaultSize.h,
      config: opts.config || null,
    };
    widgets.value = [...widgets.peek(), w];
    bumpSave();
    return w;
  }
  function removeWidget(id) {
    const mp = musicPlayers.get(id);
    if (mp) { try { mp.destroy(); } catch {} musicPlayers.delete(id); }
    widgets.value = widgets.peek().filter(w => w.id !== id);
    bumpSave();
  }

  function renderWidgets() {
    if (engine.mode.peek() === 'watch') return;
    const env = {
      fps: engine.fps.peek(),
      cols: engine.cols.peek(),
      rows: engine.rows.peek(),
      mode: engine.mode.peek(),
      theme: engine.theme.peek().name,
    };
    const c = engine.theme.peek().colors;
    for (const w of widgets.peek()) {
      const spec = WIDGETS[w.type];
      if (!spec) continue;
      const ctx = engine.subContext({ x: w.x, y: w.y, w: w.w, h: w.h });
      const isDragging = deskDrag?.kind === 'widget' && deskDrag.target === w.id;
      try { spec.render(ctx, w, env); }
      catch (err) {
        ctx.text(0, 0, '[widget error]', { fg: c.error });
      }
      // Highlight border when dragging
      if (isDragging) {
        engine.box(w.x, w.y, w.w, w.h, { fg: c.borderFocus, glyphSet: 'borderDouble' });
      }
      // Always-visible close × in top-right corner (replaces border glyph).
      // Click it to remove the widget. See widgetCloseHit() / mousedown handler.
      if (w.w >= 3) {
        engine.put(w.x + w.w - 1, w.y, '×', { fg: c.error, bold: true });
      }
    }
  }

  function widgetHitTest(px, py) {
    // Topmost (last in list) wins.
    const list = widgets.peek();
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      if (px >= w.x && px < w.x + w.w && py >= w.y && py < w.y + w.h) return w;
    }
    return null;
  }

  // Was the click on the widget's close × ? Returns widget if so.
  function widgetCloseHit(px, py) {
    const list = widgets.peek();
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      // Generous hit zone: top-right cell + cell to its left (border).
      if (py === w.y && (px === w.x + w.w - 1 || px === w.x + w.w - 2)) return w;
    }
    return null;
  }

  function pointInAnyWindow(px, py) {
    for (const win of wm.windows.peek()) {
      const x = win.x.peek(), y = win.y.peek();
      if (px >= x && px < x + win.w.peek() && py >= y && py < y + win.h.peek()) return true;
    }
    return false;
  }

  // ── Taskbar ─────────────────────────────────────────────────────
  function taskbarY() {
    const pos = taskbarPos.peek();
    if (pos === 'hidden') return -1;
    if (pos === 'top') return 0;
    return engine.rows.peek() - 1;
  }
  function renderTaskbar() {
    const y = taskbarY();
    if (y < 0) return;
    const t = engine.theme.peek();
    const cols = engine.cols.peek();
    engine.rect(0, y, cols, 1, { ch: ' ', bg: t.colors.border });

    // Left segment: brand + clock
    const brand = ' acii_os ';
    engine.text(0, y, brand, { fg: t.colors.bg, bg: t.colors.accent, bold: true });
    let cur = brand.length + 1;

    // Running app chips
    for (const r of running.values()) {
      const isFocused = r.win.focused.peek();
      const isMin = wm.isMinimized(r.win.id);
      // Minimized windows show their label in brackets + dimmed.
      const chip = isMin
        ? ` ${r.spec.icon || '[]'} (${r.spec.label}) `
        : ` ${r.spec.icon || '[]'} ${r.spec.label} `;
      const fg = isMin ? t.colors.fgDim : (isFocused ? t.colors.bg : t.colors.fg);
      const bg = isFocused && !isMin ? t.colors.accent : t.colors.bg;
      if (cur + chip.length >= cols - 10) break;
      engine.text(cur, y, chip, { fg, bg });
      cur += chip.length + 1;
    }

    // Right: clock
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const clock = ` ${hh}:${mm} `;
    engine.text(cols - clock.length, y, clock, { fg: t.colors.fg, bg: t.colors.bg });
  }

  function taskbarHitTest(px, py) {
    const y = taskbarY();
    if (y < 0 || py !== y) return null;
    let cur = ' acii_os '.length + 1;
    for (const r of running.values()) {
      const chip = wm.isMinimized(r.win.id)
        ? ` ${r.spec.icon || '[]'} (${r.spec.label}) `
        : ` ${r.spec.icon || '[]'} ${r.spec.label} `;
      if (px >= cur && px < cur + chip.length) return { kind: 'chip', win: r.win };
      cur += chip.length + 1;
    }
    return null;
  }

  // ── Hint banner (single line at top of mode info / shortcuts) ────
  function renderHint() {
    const mode = engine.mode.peek();
    if (mode === 'watch') return;
    const y = taskbarPos.peek() === 'top' ? 1 : 0;
    const t = engine.theme.peek();
    const hint = ` ${mode}  ·  Alt+Tab swap  ·  Ctrl+W close  ·  Esc unmax  ·  Ctrl+T theme  ·  Alt+W widget+  ·  fps ${engine.fps.peek()} `;
    if (y === 0) {
      engine.text(engine.cols.peek() - hint.length - 1, y, hint, { fg: t.colors.fgDim });
    }
  }

  // ── Input routing ───────────────────────────────────────────────
  // WM already handles drag/resize/focus via mousedown on its decoration.
  // We handle: icon clicks, taskbar chips, and forward body events to focused app.

  function openOrFocus(appId) {
    const existing = [...running.values()].find(r => r.spec.id === appId);
    if (existing) { existing.win.focus(); return existing.win; }
    return openApp(appId);
  }

  // Open a file: routes to the right app by extension.
  // Apps read `globalThis.__aciiOpenFile = path` on init/focus.
  function appForExt(ext) {
    switch ((ext || '').toLowerCase()) {
      case 'acii':                                            return 'paint';
      // Media → Media Mogul (read-only browser): video / image / audio.
      case 'mp4': case 'webm': case 'mov': case 'ogv':
      case 'm4v': case 'avi': case 'mkv': case 'ogg':
      case 'png': case 'jpg': case 'jpeg': case 'gif':
      case 'bmp': case 'webp': case 'ico': case 'avif':
      case 'mp3': case 'wav': case 'oga': case 'm4a':
      case 'aac': case 'flac': case 'opus':                   return 'mediamogul';
      case 'md':                                              return 'findman';  // Findman edits it
      case 'txt': case 'json': case 'js': case 'html':
      case 'css': case 'svg': case 'log': case 'csv':
      case 'xml': case 'yml': case 'yaml':                    return 'findman';
      default:                                                return 'findman';
    }
  }
  function openFile(path) {
    const ext = path.split('.').pop();
    const target = appForExt(ext);
    // Stash the path for the target app to pick up on first render.
    globalThis.__aciiOpenFile = path;
    const win = openOrFocus(target);
    return win;
  }

  function setWallpaper(path) {
    wallpaperPath.value = path;
    bumpSave();
  }
  function clearWallpaper() {
    wallpaperPath.value = null;
    bumpSave();
  }

  // ── Context menu builders ───────────────────────────────────────
  function menuForApp(app, x, y) {
    return createContextMenu({
      x, y,
      items: [
        { label: 'Open',       onSelect: () => openOrFocus(app.id), hotkey: 'O' },
        { type: 'separator' },
        { label: 'About app',  disabled: true },
      ],
      onClose: () => { activeMenu.value = null; },
    });
  }

  function menuForFile(file, x, y) {
    const path = '/desktop/' + file.name;
    const isWp = wallpaperPath.peek() === path;
    const multi = selectedFiles.size > 1 && selectedFiles.has(path);
    const deleteItem = multi
      ? { label: `Delete ${selectedFiles.size} items`, onSelect: deleteSelectedFiles, danger: true, hotkey: 'D' }
      : { label: 'Delete', onSelect: () => {
            if (isWp) clearWallpaper();
            fs.delete(path);
            fileIconPos.delete(file.name);
            selectedFiles.delete(path);
            if (selectedFile.peek() === path) selectedFile.value = leadFile();
          }, danger: true, hotkey: 'D' };
    return createContextMenu({
      x, y,
      items: [
        { label: 'Open',           onSelect: () => openFile(path), hotkey: 'O' },
        { label: isWp ? 'Remove wallpaper' : 'Set as wallpaper',
          onSelect: () => isWp ? clearWallpaper() : setWallpaper(path), hotkey: 'W' },
        { type: 'separator' },
        { label: 'Rename…',        disabled: multi, onSelect: () => {
            const next = window.prompt('Nový název:', file.name);
            if (next && next !== file.name && !fs.exists('/desktop/' + next)) {
              fs.move(path, '/desktop/' + next);
              if (isWp) wallpaperPath.value = '/desktop/' + next;
            }
          } },
        deleteItem,
      ],
      onClose: () => { activeMenu.value = null; },
    });
  }

  function menuForWidget(w, x, y) {
    return createContextMenu({
      x, y,
      items: [
        { label: 'Remove widget',  onSelect: () => removeWidget(w.id), danger: true, hotkey: 'D' },
        { type: 'separator' },
        ...Object.keys(WIDGETS).map(type => ({
          label: 'Add ' + WIDGETS[type].label,
          onSelect: () => addWidget(type, { x: w.x + 2, y: w.y + 2 }),
        })),
      ],
      onClose: () => { activeMenu.value = null; },
    });
  }

  function menuForDesktop(x, y) {
    return createContextMenu({
      x, y,
      items: [
        { label: 'New widget',
          items: Object.keys(WIDGETS).map(type => ({
            label: WIDGETS[type].label,
            onSelect: () => addWidget(type, { x, y }),
          })),
        },
        { label: 'New paint',      onSelect: () => openOrFocus('paint'), hotkey: 'P' },
        { label: 'New file',       onSelect: () => {
            fs.mkdir('/desktop');
            const name = window.prompt('Název souboru (na /desktop/):', 'untitled.txt');
            if (!name) return;
            const path = '/desktop/' + name.replace(/^\/+/, '');
            if (!fs.exists(path)) fs.write(path, '');
          }, hotkey: 'F' },
        { label: 'New folder',     onSelect: () => {
            const name = window.prompt('Název složky (absolutní cesta):', '/desktop/new-folder');
            if (!name) return;
            fs.mkdir(name);
          } },
        { label: 'Open Findman',   onSelect: () => openOrFocus('findman') },
        { type: 'separator' },
        { label: 'Background',
          items: Object.keys(PATTERNS).map(p => ({
            label: p,
            onSelect: () => { backgroundKind.value = p; bumpSave(); },
          })),
        },
        { label: 'Theme',
          items: Object.keys(engine.themes).map(name => ({
            label: name,
            onSelect: () => { engine.theme.value = engine.themes[name]; },
          })),
        },
        ...(wallpaperPath.peek() ? [
          { type: 'separator' },
          { label: 'Remove wallpaper', onSelect: clearWallpaper, hotkey: 'W' },
        ] : []),
      ],
      onClose: () => { activeMenu.value = null; },
    });
  }

  // Decide which menu to show for a right-click / longpress at (x, y).
  function openContextMenuAt(x, y) {
    // priority: widget close × → file icon → app icon → widget → desktop
    const file = fileIconHitTest(x, y);
    if (file) {
      // Right-clicking a file that isn't selected selects it (single); a file
      // already in a multi-selection keeps the group so bulk actions apply.
      const path = '/desktop/' + file.name;
      if (!selectedFiles.has(path)) selectSingleFile(path);
      activeMenu.value = menuForFile(file, x, y);
      return;
    }
    const app = iconHitTest(x, y);
    if (app)  { activeMenu.value = menuForApp(app, x, y); return; }
    const w = widgetHitTest(x, y);
    if (w && !pointInAnyWindow(x, y)) { activeMenu.value = menuForWidget(w, x, y); return; }
    if (!pointInAnyWindow(x, y)) {
      activeMenu.value = menuForDesktop(x, y);
    }
  }

  engine.onContextMenu((e) => { openContextMenuAt(e.x, e.y); });

  // ── File drop: drag a file from OS onto the desktop or window ───
  engine.onFileDrop(async (e) => {
    fs.mkdir('/desktop');
    for (const f of e.files) {
      const name = f.name.replace(/[^\w.\- ]+/g, '_');
      const path = '/desktop/' + name;
      const isText = /^text\//.test(f.type) ||
        /\.(txt|md|json|html|css|js|svg|acii)$/i.test(name);
      try {
        if (isText) fs.write(path, await f.asText());
        else fs.write(path, await f.asArrayBuffer());
      } catch (err) {
        console.error('drop save failed', err);
      }
    }
  });

  function clampPos(x, y, w, h) {
    const cols = engine.cols.peek();
    const rows = engine.rows.peek();
    const tbY = taskbarY();
    const maxY = tbY >= 0 && taskbarPos.peek() === 'bottom' ? tbY - 1 : rows - 1;
    return {
      x: Math.max(0, Math.min(cols - w, x)),
      y: Math.max(0, Math.min(maxY - h + 1, y)),
    };
  }

  engine.onMouse((e) => {
    // ── Active context menu intercepts mouse events ────────────
    const am = activeMenu.peek();
    if (am) {
      // Forward to the menu, which owns hit-testing for itself AND any open
      // submenu (drawn outside the parent's bounds). It returns true when it
      // consumed the event; a false means the click was truly outside the
      // whole chain, so we close and let it fall through.
      if (e.type === 'mousedown' || e.type === 'click') {
        let handled = false;
        try { handled = !!am.onMouse?.(e); } catch {}
        if (handled) return;
        activeMenu.value = null;
        // fall through to whatever's underneath
      } else if (e.type === 'mousemove') {
        try { am.onMouse?.(e); } catch {}
        return;
      }
    }

    // ── Drag in progress: track move/up first ─────────────────
    if (deskDrag) {
      if (e.type === 'mousemove') {
        if (deskDrag.kind === 'marquee') {
          deskDrag.x1 = e.x; deskDrag.y1 = e.y;
          if (e.x !== deskDrag.x0 || e.y !== deskDrag.y0) deskDrag.moved = true;
          updateMarqueeSelection(deskDrag);
          return;
        }
        const nx = deskDrag.baseX + (e.x - deskDrag.ox);
        const ny = deskDrag.baseY + (e.y - deskDrag.oy);
        if (deskDrag.kind === 'icon') {
          const { x, y } = clampPos(nx, ny, ICON_W, ICON_H);
          iconPositions.set(deskDrag.target, { x, y });
          if (nx !== deskDrag.baseX || ny !== deskDrag.baseY) deskDrag.moved = true;
        } else if (deskDrag.kind === 'file') {
          if (deskDrag.group) {
            const dx = e.x - deskDrag.ox, dy = e.y - deskDrag.oy;
            for (const g of deskDrag.group) {
              const { x, y } = clampPos(g.baseX + dx, g.baseY + dy, ICON_W, ICON_H);
              fileIconPos.set(g.name, { x, y });
            }
          } else {
            const { x, y } = clampPos(nx, ny, ICON_W, ICON_H);
            fileIconPos.set(deskDrag.target, { x, y });
          }
          if (nx !== deskDrag.baseX || ny !== deskDrag.baseY) deskDrag.moved = true;
        } else if (deskDrag.kind === 'widget') {
          const w = widgets.peek().find(x => x.id === deskDrag.target);
          if (w) {
            const c = clampPos(nx, ny, w.w, w.h);
            // Re-emit signal so reactive consumers update
            widgets.value = widgets.peek().map(x => x.id === w.id ? { ...x, x: c.x, y: c.y } : x);
            if (nx !== deskDrag.baseX || ny !== deskDrag.baseY) deskDrag.moved = true;
          }
        }
        return;
      }
      if (e.type === 'mouseup') {
        if (deskDrag.kind === 'marquee') { deskDrag = null; return; }
        if (deskDrag.moved) bumpSave();
        deskDrag = null;
        return;
      }
    }

    if (e.type === 'dblclick') {
      const file = fileIconHitTest(e.x, e.y);
      if (file) { openFile('/desktop/' + file.name); return; }
      const app = iconHitTest(e.x, e.y);
      if (app) { openOrFocus(app.id); return; }
    }

    if (e.type === 'mousedown' && e.button === 0) {
      const hit = taskbarHitTest(e.x, e.y);
      if (hit?.kind === 'chip') { wm.toggleMinimize(hit.win.id); return; }
      // Start desktop drag only if NOT inside a window (WM handles its own drag)
      if (!pointInAnyWindow(e.x, e.y)) {
        // Close × on a widget — check before drag so user can hit it cleanly.
        const closing = widgetCloseHit(e.x, e.y);
        if (closing) { removeWidget(closing.id); return; }

        const widget = widgetHitTest(e.x, e.y);
        if (widget) {
          // Interactive widgets (music) get first crack at the click; if a
          // control was hit, don't start a drag.
          const spec = WIDGETS[widget.type];
          if (spec && spec.onClick) {
            try { if (spec.onClick(e.x - widget.x, e.y - widget.y, widget)) return; } catch {}
          }
          widgets.value = [...widgets.peek().filter(x => x.id !== widget.id), widget];
          deskDrag = { kind: 'widget', target: widget.id, ox: e.x, oy: e.y, baseX: widget.x, baseY: widget.y, moved: false };
          return;
        }
        const additive = !!(e.raw && (e.raw.metaKey || e.raw.ctrlKey || e.raw.shiftKey));
        const file = fileIconHitTest(e.x, e.y);
        if (file) {
          const path = '/desktop/' + file.name;
          if (additive) {
            // Cmd/Ctrl/Shift+click toggles a file in the selection (no drag).
            toggleFileSelection(path);
            return;
          }
          // Plain click: select just this file unless it's already part of a
          // multi-selection (so the existing group stays put).
          if (!selectedFiles.has(path)) selectSingleFile(path);
          else selectedFile.value = path;
          const pos = fileIcon(file.name);
          // Dragging a file that's part of a multi-selection moves the whole
          // group; snapshot each member's base position up front.
          let group = null;
          if (selectedFiles.size > 1 && selectedFiles.has(path)) {
            group = [];
            for (const sp of selectedFiles) {
              const nm = sp.slice('/desktop/'.length);
              const gp = fileIcon(nm);
              group.push({ name: nm, baseX: gp.x, baseY: gp.y });
            }
          }
          deskDrag = { kind: 'file', target: file.name, ox: e.x, oy: e.y, baseX: pos.x, baseY: pos.y, moved: false, group };
          return;
        }
        const app = iconHitTest(e.x, e.y);
        if (app) {
          clearFileSelection();
          const pos = iconPos(app.id);
          deskDrag = { kind: 'icon', target: app.id, ox: e.x, oy: e.y, baseX: pos.x, baseY: pos.y, moved: false };
          return;
        }
        // Empty desktop: begin a rubber-band marquee. Additive keeps what was
        // already selected; a plain drag replaces the selection.
        if (!additive) clearFileSelection();
        deskDrag = { kind: 'marquee', x0: e.x, y0: e.y, x1: e.x, y1: e.y, base: new Set(selectedFiles), moved: false };
        return;
      }
    }

    // Forward to focused app if click is inside its content area
    const f = wm.focused.peek();
    if (!f) return;
    const wx = f.x.peek(), wy = f.y.peek(), ww = f.w.peek(), wh = f.h.peek();
    const bx = wx + 1, by = wy + 1, bw = ww - 2, bh = wh - 2;
    const rec = running.get(f.id);
    const inside = !(e.x < bx || e.y < by || e.x >= bx + bw || e.y >= by + bh);
    if (!inside) {
      // Always deliver mouseup so drag-based apps (paint, gamemaker) can end a
      // stroke even if the pointer was released outside their content area —
      // otherwise the brush "sticks" and keeps painting on every move.
      if (e.type === 'mouseup' && rec?.instance?.onMouse) {
        const cx = Math.max(0, Math.min(e.x - bx, bw - 1));
        const cy = Math.max(0, Math.min(e.y - by, bh - 1));
        try { rec.instance.onMouse({ ...e, x: cx, y: cy }); } catch {}
      }
      return;
    }
    if (rec?.instance?.onMouse) {
      try { rec.instance.onMouse({ ...e, x: e.x - bx, y: e.y - by }); } catch {}
    }
  });

  engine.onTouch((e) => {
    // Active menu — outside tap closes, inside-tap forwarded.
    const am = activeMenu.peek();
    if (am) {
      if (e.type === 'tap') {
        const b = am.bounds;
        const inside = b && e.x >= b.x && e.x < b.x + b.w && e.y >= b.y && e.y < b.y + b.h;
        if (!inside) { activeMenu.value = null; return; }
        try { am.onMouse?.({ type: 'click', x: e.x, y: e.y, button: 0 }); } catch {}
        return;
      }
    }
    // Tap on widget close × removes it (touch shortcut).
    if (e.type === 'tap' && !pointInAnyWindow(e.x, e.y)) {
      const closing = widgetCloseHit(e.x, e.y);
      if (closing) { removeWidget(closing.id); return; }
      // Tap on an interactive widget's controls (music transport).
      const widget = widgetHitTest(e.x, e.y);
      if (widget) {
        const spec = WIDGETS[widget.type];
        if (spec && spec.onClick) {
          try { if (spec.onClick(e.x - widget.x, e.y - widget.y, widget)) return; } catch {}
        }
      }
    }
    // Long-press → context menu (matches mobile OS convention).
    // Touch-drag for moving icons: just touch+move directly (without longpress).
    if (e.type === 'longpress' && !pointInAnyWindow(e.x, e.y)) {
      openContextMenuAt(e.x, e.y);
      return;
    }
    if (e.type === 'move' && deskDrag) {
      const nx = deskDrag.baseX + (e.x - deskDrag.ox);
      const ny = deskDrag.baseY + (e.y - deskDrag.oy);
      if (deskDrag.kind === 'icon') {
        const { x, y } = clampPos(nx, ny, ICON_W, ICON_H);
        iconPositions.set(deskDrag.target, { x, y });
      } else if (deskDrag.kind === 'widget') {
        const w = widgets.peek().find(x => x.id === deskDrag.target);
        if (w) {
          const c = clampPos(nx, ny, w.w, w.h);
          widgets.value = widgets.peek().map(x => x.id === w.id ? { ...x, x: c.x, y: c.y } : x);
        }
      }
      deskDrag.moved = true;
      return;
    }
    if ((e.type === 'end' || e.type === 'swipe') && deskDrag) {
      if (deskDrag.moved) bumpSave();
      deskDrag = null;
      return;
    }

    if (e.type === 'doubletap') {
      const app = iconHitTest(e.x, e.y);
      if (app) { openOrFocus(app.id); return; }
    }
    if (e.type === 'tap') {
      const hit = taskbarHitTest(e.x, e.y);
      if (hit?.kind === 'chip') { wm.toggleMinimize(hit.win.id); return; }
    }
    const f = wm.focused.peek();
    if (!f) return;
    const wx = f.x.peek(), wy = f.y.peek(), ww = f.w.peek(), wh = f.h.peek();
    const bx = wx + 1, by = wy + 1, bw = ww - 2, bh = wh - 2;
    if (e.x < bx || e.y < by || e.x >= bx + bw || e.y >= by + bh) return;
    const rec = running.get(f.id);
    if (rec?.instance?.onTouch) {
      try { rec.instance.onTouch({ ...e, x: e.x - bx, y: e.y - by }); } catch {}
    }
  });

  // Match a letter shortcut robustly across layouts. On macOS, Option+W
  // produces e.key='∑' (or other symbols in Czech layout), but e.code is
  // always 'KeyW' for the physical W key. Same for Ctrl+T etc.
  const keyIs = (e, letter) => {
    const code = `Key${letter.toUpperCase()}`;
    return e.code === code || (e.key || '').toLowerCase() === letter.toLowerCase();
  };

  engine.onKey((e) => {
    if (e.type !== 'down') return;

    // Active menu eats keys first.
    const am = activeMenu.peek();
    if (am) {
      if (e.key === 'Escape') { activeMenu.value = null; return; }
      try { am.onKey?.(e); } catch {}
      return;
    }

    if (e.key === 'Escape') {
      const f = wm.focused.peek();
      if (f && f.maximized.peek()) {
        f.toggleMaximize();
        return;
      }
      // Fall through to app handlers so Notes/Terminal/etc. can use Esc.
    }

    // Close focused window: Ctrl+W (Linux/Win) or Cmd+W (Mac).
    if ((e.ctrl || e.meta) && keyIs(e, 'w') && !e.alt) {
      e.raw?.preventDefault?.();
      const f = wm.focused.peek();
      if (f) f.close();
      return;
    }

    // Minimize focused window: Ctrl/Cmd+M
    if ((e.ctrl || e.meta) && keyIs(e, 'm') && !e.alt) {
      e.raw?.preventDefault?.();
      const f = wm.focused.peek();
      if (f) wm.minimize(f.id);
      return;
    }

    // Quick Look: spacebar previews the selected desktop file when no window
    // is focused (so apps still receive their own space key while focused).
    if (e.key === ' ' && !e.ctrl && !e.meta && !e.alt && !wm.focused.peek()) {
      const sel = selectedFile.peek();
      if (sel && fs.exists(sel)) {
        e.raw?.preventDefault?.();
        openFile(sel);
        return;
      }
    }

    // ── Desktop file selection shortcuts (only when no window is focused, so
    // they never clobber an app's own keys) ────────────────────────
    if (!wm.focused.peek()) {
      // Select all desktop files.
      if ((e.ctrl || e.meta) && keyIs(e, 'a') && !e.alt) {
        e.raw?.preventDefault?.();
        selectAllDesktopFiles();
        return;
      }
      // Clear the selection.
      if (e.key === 'Escape' && selectedFiles.size) {
        clearFileSelection();
        return;
      }
      // Bulk-delete the selection.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrl && !e.meta && !e.alt && selectedFiles.size) {
        e.raw?.preventDefault?.();
        deleteSelectedFiles();
        return;
      }
    }

    // Cycle theme: Ctrl/Cmd+T
    if ((e.ctrl || e.meta) && keyIs(e, 't') && !e.alt) {
      e.raw?.preventDefault?.();
      cycleTheme(); return;
    }
    // Cycle background pattern: Ctrl/Cmd+B
    if ((e.ctrl || e.meta) && keyIs(e, 'b') && !e.alt) {
      e.raw?.preventDefault?.();
      const keys = Object.keys(PATTERNS);
      const idx = keys.indexOf(backgroundKind.peek());
      backgroundKind.value = keys[(idx + 1) % keys.length];
      bumpSave();
      return;
    }
    // Alt+W cycles spawn widget type: clock → stats → note
    if (e.alt && keyIs(e, 'w')) {
      const types = Object.keys(WIDGETS);
      const existing = widgets.peek();
      const lastType = existing[existing.length - 1]?.type;
      const next = lastType ? types[(types.indexOf(lastType) + 1) % types.length] : types[0];
      // Stagger so they don't stack on the same cell
      const baseX = engine.cols.peek() - WIDGETS[next].defaultSize.w - 2;
      const baseY = 2 + (existing.length % 6) * 2;
      addWidget(next, { x: baseX, y: baseY });
      return;
    }
    // Alt+X removes topmost widget
    if (e.alt && keyIs(e, 'x')) {
      const list = widgets.peek();
      if (list.length) removeWidget(list[list.length - 1].id);
      return;
    }
    // Alt+H toggle taskbar position
    if (e.alt && keyIs(e, 'h')) {
      const order = ['bottom', 'top', 'hidden'];
      const i = order.indexOf(taskbarPos.peek());
      taskbarPos.value = order[(i + 1) % order.length];
      bumpSave();
      return;
    }
    const f = wm.focused.peek();

    // App launch by number key (1..9) — ONLY when no window is focused, so
    // focused apps (Paint brushes, GameMaker, etc.) can use number keys.
    // Cmd/Ctrl+number always launches, even with a focused window.
    if (/^[1-9]$/.test(e.key) && !e.alt && ((e.ctrl || e.meta) || !f)) {
      const idx = parseInt(e.key, 10) - 1;
      const app = apps[idx];
      if (app) {
        e.raw?.preventDefault?.();
        const existing = [...running.values()].find(r => r.spec.id === app.id);
        if (existing) existing.win.focus();
        else openApp(app.id);
        return;
      }
    }

    // Forward to focused app
    if (!f) return;
    const rec = running.get(f.id);
    if (rec?.instance?.onKey) {
      try { rec.instance.onKey(e); } catch {}
    }
  });

  function cycleTheme() {
    const keys = Object.keys(engine.themes);
    const cur = engine.theme.peek().name;
    const i = keys.indexOf(cur);
    engine.theme.value = engine.themes[keys[(i + 1) % keys.length]];
  }

  // ── Restore previous session ────────────────────────────────────
  if (saved?.windows?.length) {
    // Defer to next tick so engine is fully ready
    setTimeout(() => {
      for (const w of saved.windows) openApp(w.appId, w);
    }, 0);
  }

  // ── Per-frame render ────────────────────────────────────────────
  function render() {
    engine.clear();
    renderBackground();
    renderWidgets();        // pinned widgets — under icons/windows
    renderIcons();
    renderFileIcons();      // /desktop/* files
    renderMarquee();        // rubber-band selection box over the desktop
    renderHint();           // BEFORE wm so windows occlude it
    wm.render();
    renderTaskbar();
    renderActiveMenu();     // context menu always on top
  }

  function renderActiveMenu() {
    const m = activeMenu.peek();
    if (!m) return;
    try { m.render(engine); } catch { activeMenu.value = null; }
  }

  // Subscribe to FS changes so wallpaper / icons stay in sync.
  effect(() => { fs.changes.value; });
  fs.subscribe('/desktop', () => { /* react via signal */ });

  // First-boot defaults: spawn a clock widget if user has nothing saved.
  if (!saved?.widgets?.length) {
    setTimeout(() => {
      const cols = engine.cols.peek();
      addWidget('clock', { x: Math.max(2, cols - 14), y: 2 });
    }, 0);
  }

  return {
    wm, fs,
    render,
    openApp, closeApp, openFile,
    cycleTheme,
    addWidget, removeWidget, widgets,
    setWallpaper, clearWallpaper, wallpaperPath,
    activeMenu,
    taskbarPos, backgroundKind,
    running,
  };
}
