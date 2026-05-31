// mediamogul.js — "Media House", a READ-ONLY media browser for FakanOS.
//
// Replaces the old Video app. Left pane: a Findman-style tree of the virtual
// FS, filtered to media files only (video / image / audio), with a "+ mount
// local…" row to attach an OS folder. Right pane: the ASCII rendering of the
// selected item plus a link to the original file path.
//
// Reuses media.js:
//   imageToCells      — images → static half-block frame (▀, fg/bg per cell)
//   createVideoPlayer — off-DOM <video> → canvas → half-block frames (play/pause/seek)
//   createAudio       — long-track player for audio (play/stop, no ASCII picture)
//
// No URL prompt, no editing. Picks up globalThis.__aciiOpenFile and selects it.
//
// Coords passed to render(ctx) are LOCAL to the window content area. The app
// does NOT subscribe to engine input — the shell routes events here.

import { signal } from '../signals.js';
import { createFS } from '../fs.js';
import { imageToCells, createVideoPlayer, createAudio } from '../media.js';

// Picture/video render strategies (cycled with R in preview focus):
//   half    — ▀ half-block, two colored pixels per cell (fg=top, bg=bottom).
//             2× vertical res, the default. Draw loops honour cell.bg.
//   braille — ⠿ 2×4 dot matrix, one color per cell. High-density, line-art look.
//   ascii   — classic brightness ramp, one char per cell. Sparsest, most "text".
const RENDER_MODES = ['half', 'braille', 'ascii'];

const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });

// ── Media classification by extension ──────────────────────────────────
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'avi', 'mkv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'oga', 'm4a', 'aac', 'flac', 'opus']);
// 'ogg' is ambiguous (audio or video); we treat it as video above. The
// classifier below resolves a single kind per path.

function extOf(path) {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i + 1).toLowerCase();
}
function mediaKind(path) {
  const e = extOf(path);
  if (VIDEO_EXT.has(e)) return 'video';
  if (IMAGE_EXT.has(e)) return 'image';
  if (AUDIO_EXT.has(e)) return 'audio';
  return null;
}
function isMediaPath(path) { return mediaKind(path) !== null; }

// MIME-by-extension so blob URLs hint the right decoder to the browser.
function mimeForPath(path) {
  const e = extOf(path);
  return ({
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
    ogv: 'video/ogg', ogg: 'video/ogg', mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
    mp3: 'audio/mpeg', wav: 'audio/wav', oga: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  })[e] || 'application/octet-stream';
}

const KIND_GLYPH = { video: '▶', image: '▣', audio: '♪' };

// ── Path helpers ───────────────────────────────────────────────────────
function parentOf(path) {
  if (!path || path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
function basename(path) {
  if (!path || path === '/') return '/';
  return path.slice(path.lastIndexOf('/') + 1);
}
function joinPath(a, b) {
  if (a === '/') return '/' + b;
  return a + '/' + b;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createApp(initialCtx, win) {
  // ── Tree state ───────────────────────────────────────────────────────
  const expanded = new Set(['/', '/desktop']);
  let selectedPath = null;       // currently highlighted tree row path
  let treeScroll = 0;
  let visibleRows = [];          // [{ path, name, type, kind?, depth }]

  // ── Focus ────────────────────────────────────────────────────────────
  let focus = 'tree';            // 'tree' | 'preview'

  // ── Loaded-item state ────────────────────────────────────────────────
  let loadedPath = null;         // path of the media currently shown
  let loadedKind = null;         // 'video' | 'image' | 'audio'
  let loadError = null;

  // Active render strategy for the picture area (see RENDER_MODES). Instance
  // state so each Media House window cycles independently.
  let renderMode = 'half';

  // Image: a static 2D array of { ch, fg, bg } cells.
  let imageCells = null;
  let imageReqW = 0, imageReqH = 0;     // dims last requested (to detect resize)
  let imageLoading = false;
  let imageSrcUrl = null;               // blob url backing the current image

  // Video: a media.js player + last sampled frame.
  let player = null;
  let playerSrc = null;
  let lastFrame = null;
  let playerW = 0, playerH = 0;
  let videoMuted = false;   // play .mp4 with sound by default (M toggles)
  let pendingSeek = null;   // on a respawn (e.g. mode toggle), restore this time…
  let pendingPlay = false;  // …and resume playing only if it was playing before

  // Audio: a media.js audio context + music handle.
  let audio = null;
  let music = null;
  let audioPlaying = signal(false);

  // Hit-zones recomputed each render, consumed by clicks.
  let buttonZones = [];          // [{ x0, x1, y, action }]
  let timelineRow = -1, timelineX0 = 0, timelineX1 = 0;
  let linkRow = -1;              // row holding the "open original" link

  // Transient status line.
  const status = signal('');
  let statusUntil = 0;
  function setStatus(msg, ms = 1800) {
    status.value = msg;
    statusUntil = performance.now() + ms;
  }

  // Caret blink piggybacks on the render loop for the selection marker.
  let blinkOn = true;
  const blinkTimer = setInterval(() => { blinkOn = !blinkOn; }, 500);

  // ── Blob URL bookkeeping ─────────────────────────────────────────────
  const blobUrls = new Set();
  async function makeBlobUrl(path) {
    try {
      // Async read so mounted-local files (File System Access) work — sync
      // readBytes only sees the in-memory cache and fails for cold mounts.
      const bytes = await fs.readBytesAsync(path);  // ArrayBuffer
      const blob = new Blob([bytes], { type: mimeForPath(path) });
      const u = URL.createObjectURL(blob);
      blobUrls.add(u);
      return u;
    } catch (err) {
      loadError = 'FS read failed: ' + (err && err.message || err);
      return null;
    }
  }
  function revokeBlob(u) {
    if (u && blobUrls.has(u)) {
      try { URL.revokeObjectURL(u); } catch (_) {}
      blobUrls.delete(u);
    }
  }

  // ── Tree building (media-filtered) ───────────────────────────────────
  // Keep a directory only if it (recursively) contains at least one media
  // file, so the tree doesn't fill with empty branches.
  function dirHasMedia(dirPath, depthGuard = 0) {
    if (depthGuard > 12) return false;
    let kids;
    try { kids = fs.list(dirPath); } catch { return false; }
    if (!Array.isArray(kids)) return false;
    for (const k of kids) {
      const childPath = joinPath(dirPath, k.name);
      if (k.type === 'file') {
        if (isMediaPath(childPath)) return true;
      } else if (k.type === 'dir') {
        if (dirHasMedia(childPath, depthGuard + 1)) return true;
      }
    }
    return false;
  }

  function rebuildVisibleRows() {
    const out = [];
    function walk(dirPath, depth) {
      let kids;
      try { kids = fs.list(dirPath); } catch { kids = []; }
      if (!Array.isArray(kids)) return;
      for (const k of kids) {
        const childPath = joinPath(dirPath, k.name);
        if (k.type === 'dir') {
          if (!dirHasMedia(childPath)) continue;        // prune empty dirs
          out.push({ path: childPath, name: k.name, type: 'dir', depth });
          if (expanded.has(childPath)) walk(childPath, depth + 1);
        } else if (k.type === 'file') {
          const kind = mediaKind(childPath);
          if (!kind) continue;                          // media files only
          out.push({ path: childPath, name: k.name, type: 'file', kind, depth });
        }
      }
    }
    walk('/', 0);
    // Always offer a "mount local…" action row at the bottom so the user can
    // attach an OS folder and browse its media.
    if (!fs.canMountLocal || fs.canMountLocal()) {
      out.push({ path: '__mount__', name: '+ mount local…', type: 'mount', depth: 0 });
    }
    visibleRows = out;
    // Default selection: first media file if nothing selected yet.
    if (selectedPath == null && out.length) {
      const firstFile = out.find(r => r.type === 'file');
      selectedPath = (firstFile || out[0]).path;
    }
  }

  // React to FS changes (new media dropped, mounts warming, deletions).
  const unsubFS = fs.subscribe('/', () => {
    rebuildVisibleRows();
    if (loadedPath && !fs.exists(loadedPath)) {
      teardownMedia();
      loadedPath = null;
      loadedKind = null;
    }
  });
  rebuildVisibleRows();

  // ── Tree navigation ──────────────────────────────────────────────────
  function indexOfSelected() {
    for (let i = 0; i < visibleRows.length; i++) {
      if (visibleRows[i].path === selectedPath) return i;
    }
    return -1;
  }
  function selectByIndex(i) {
    if (i < 0 || i >= visibleRows.length) return;
    selectedPath = visibleRows[i].path;
  }
  function moveSelection(delta) {
    const i = indexOfSelected();
    if (i < 0) { selectByIndex(0); return; }
    let next = i + delta;
    if (next < 0) next = 0;
    if (next >= visibleRows.length) next = visibleRows.length - 1;
    selectByIndex(next);
  }
  function selectedRow() {
    const i = indexOfSelected();
    return i < 0 ? null : visibleRows[i];
  }
  function doMount() {
    if (fs.canMountLocal && !fs.canMountLocal()) {
      loadError = 'Local folder mount is not supported in this browser';
      return;
    }
    Promise.resolve(fs.mountLocal({ at: '/mnt/local' }))
      .then(() => { expanded.add('/mnt'); expanded.add('/mnt/local'); rebuildVisibleRows(); })
      .catch((e) => { loadError = 'Mount cancelled: ' + (e && e.message || e); });
  }
  function activateSelection() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'mount') { doMount(); return; }
    if (r.type === 'dir') {
      if (expanded.has(r.path)) expanded.delete(r.path);
      else expanded.add(r.path);
      rebuildVisibleRows();
    } else {
      loadMedia(r.path);
      focus = 'preview';
    }
  }
  function expandOrPreview() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'mount') { doMount(); return; }
    if (r.type === 'dir' && !expanded.has(r.path)) {
      expanded.add(r.path);
      rebuildVisibleRows();
    } else if (r.type === 'file') {
      if (loadedPath !== r.path) loadMedia(r.path);
      focus = 'preview';
    }
  }
  function collapseOrParent() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'dir' && expanded.has(r.path)) {
      expanded.delete(r.path);
      rebuildVisibleRows();
      return;
    }
    const par = parentOf(r.path);
    if (par && par !== '/') {
      const idx = visibleRows.findIndex(v => v.path === par);
      if (idx >= 0) selectByIndex(idx);
    }
  }

  // ── Media lifecycle ──────────────────────────────────────────────────
  function teardownPlayer() {
    if (player) { try { player.destroy(); } catch (_) {} player = null; }
    if (playerSrc) { revokeBlob(playerSrc); playerSrc = null; }
    lastFrame = null;
    playerW = 0; playerH = 0;
  }
  function teardownImage() {
    imageCells = null;
    imageReqW = 0; imageReqH = 0;
    imageLoading = false;
    if (imageSrcUrl) { revokeBlob(imageSrcUrl); imageSrcUrl = null; }
  }
  function teardownAudio() {
    if (music) { try { music.stop(); } catch (_) {} music = null; }
    audioPlaying.value = false;
    // Keep the AudioContext (`audio`) alive across selections — cheap to reuse.
  }
  function teardownMedia() {
    teardownPlayer();
    teardownImage();
    teardownAudio();
  }

  async function loadMedia(path) {
    if (!fs.exists(path)) { loadError = 'File not found: ' + path; return; }
    const kind = mediaKind(path);
    if (!kind) { loadError = 'Unsupported file: ' + path; return; }

    teardownMedia();
    loadError = null;
    loadedPath = path;
    loadedKind = kind;
    win.setTitle?.('Media House · ' + basename(path));

    if (kind === 'image') {
      // Defer the actual decode to render, where we know the pane size.
      imageCells = null;
      imageReqW = 0; imageReqH = 0;
      imageLoading = false;
    } else if (kind === 'video') {
      const u = await makeBlobUrl(path);
      if (loadedPath !== path) { if (u) revokeBlob(u); return; } // selection moved on
      if (!u) { loadError = loadError || 'could not read video'; return; }
      playerSrc = u;
      // Player spawned in render once we know the canvas dims.
      setStatus('loading video…');
    } else if (kind === 'audio') {
      const u = await makeBlobUrl(path);
      if (loadedPath !== path) { if (u) revokeBlob(u); return; } // selection moved on
      if (!u) { loadError = loadError || 'could not read audio'; return; }
      try {
        if (!audio) audio = createAudio();
        music = audio.loadMusic(u);
        // Reflect the music's playing signal into our local one.
        // (loadMusic exposes a `playing` signal updated on play/pause/ended.)
        setStatus('loaded audio — press SPACE to play');
        // Try to auto-resume the context (browsers gate until a gesture).
        audio.resume?.().catch?.(() => {});
        // The blob backing music is revoked in teardownAudio via blobUrls set,
        // but loadMusic streams from it, so keep it until teardownMedia.
        playerSrc = u; // reuse playerSrc slot for revoke bookkeeping
      } catch (err) {
        loadError = 'audio failed: ' + (err && err.message || err);
      }
    }
  }

  function spawnPlayer(W, H) {
    if (!playerSrc || W <= 0 || H <= 0) return;
    if (player) { try { player.destroy(); } catch (_) {} player = null; }
    try {
      player = createVideoPlayer({
        src: playerSrc, width: W, height: H, mode: renderMode, fps: 15,
        muted: videoMuted, volume: 1,
      });
    } catch (err) {
      loadError = 'video failed: ' + (err && err.message || err);
      return;
    }
    playerW = W; playerH = H;
    lastFrame = null;
    player.onFrame((cells) => { lastFrame = cells; });

    // Once metadata is ready (muted, so browsers usually allow autoplay):
    // a fresh load autoplays; a respawn (mode toggle) restores time + play state.
    let kicked = false;
    const t = setInterval(() => {
      if (kicked || !player) { clearInterval(t); return; }
      if (player.duration.peek() > 0) {
        kicked = true;
        if (pendingSeek != null) { try { player.seek(pendingSeek); } catch (_) {} }
        const shouldPlay = pendingSeek != null ? pendingPlay : true;
        pendingSeek = null;
        if (shouldPlay) player.play().catch(() => setStatus('autoplay blocked — press SPACE', 2500));
        clearInterval(t);
      }
    }, 80);
    setTimeout(() => clearInterval(t), 8000);
  }

  async function ensureImage(W, H) {
    if (!loadedPath || loadedKind !== 'image') return;
    if (imageLoading) return;
    if (imageCells && imageReqW === W && imageReqH === H) return; // up to date
    imageLoading = true;
    imageReqW = W; imageReqH = H;
    const reqPath = loadedPath;
    try {
      if (!imageSrcUrl) {
        const u = await makeBlobUrl(reqPath);
        if (loadedPath !== reqPath) { if (u) revokeBlob(u); imageLoading = false; return; }
        if (!u) { imageLoading = false; return; }
        imageSrcUrl = u;
      }
      const out = await imageToCells(imageSrcUrl, {
        width: W, height: H, mode: renderMode,
      });
      // Guard against a selection change mid-decode.
      if (loadedPath === reqPath) imageCells = out.cells;
    } catch (err) {
      if (loadedPath === reqPath) loadError = 'image failed: ' + (err && err.message || err);
    } finally {
      imageLoading = false;
    }
  }

  // ── Playback controls ────────────────────────────────────────────────
  function togglePlay() {
    if (loadedKind === 'video' && player) {
      if (player.playing.peek()) player.pause();
      else player.play().catch(() => setStatus('play blocked', 2000));
    } else if (loadedKind === 'audio' && music) {
      if (audioPlaying.peek()) { music.pause(); audioPlaying.value = false; }
      else {
        audio?.resume?.().catch?.(() => {});
        music.play().then(() => { audioPlaying.value = true; })
          .catch(() => setStatus('play blocked — tap again', 2000));
      }
    }
  }
  function stopPlayback() {
    if (loadedKind === 'video' && player) player.stop();
    else if (loadedKind === 'audio' && music) { music.stop(); audioPlaying.value = false; }
  }
  // Cycle the picture render strategy and invalidate whatever's showing so the
  // next render re-samples in the new mode (audio has no picture → no-op there).
  function cycleRenderMode() {
    const i = RENDER_MODES.indexOf(renderMode);
    renderMode = RENDER_MODES[(i + 1) % RENDER_MODES.length];
    if (loadedKind === 'image') {
      imageCells = null; imageReqW = -1; imageReqH = -1;   // force ensureImage()
    } else if (loadedKind === 'video') {
      // Respawn the player in the new mode. spawnPlayer reads `renderMode`; the
      // render loop re-creates it when playerW no longer matches.
      const wasPlaying = player && player.playing.peek();
      const at = player ? player.currentTime.peek() : 0;
      if (player) { try { player.destroy(); } catch (_) {} player = null; }
      lastFrame = null; playerW = -1; playerH = -1;
      pendingSeek = at; pendingPlay = wasPlaying;            // applied on respawn
    }
    setStatus('render: ' + renderMode, 1400);
  }
  function seekBy(delta) {
    const p = loadedKind === 'video' ? player : (loadedKind === 'audio' ? music : null);
    if (!p) return;
    const dur = p.duration.peek();
    const cur = p.currentTime.peek();
    const next = Math.max(0, Math.min(Math.max(0, dur - 0.1), cur + delta));
    p.seek(next);
  }

  // ── openFile handoff ─────────────────────────────────────────────────
  function consumeOpenFileHint() {
    const p = globalThis.__aciiOpenFile;
    if (!p || typeof p !== 'string' || !p.startsWith('/')) return;
    if (!fs.exists(p)) return;
    if (!isMediaPath(p)) return;   // leave non-media hints for other apps
    globalThis.__aciiOpenFile = null;
    // Expand ancestors so the row is visible in the tree.
    let dir = parentOf(p);
    while (dir && dir !== '/') { expanded.add(dir); dir = parentOf(dir); }
    expanded.add('/');
    rebuildVisibleRows();
    selectedPath = p;
    loadMedia(p);
    focus = 'preview';
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function leftPaneWidth(W) {
    return Math.max(16, Math.min(32, Math.floor(W / 3)));
  }

  function renderTree(ctx, x0, y0, w, h) {
    const C = ctx.theme.peek().colors;
    const treeFocused = focus === 'tree';
    const borderColor = treeFocused ? C.borderFocus : C.border;

    ctx.box(x0, y0, w, h, { fg: borderColor });
    ctx.text(x0 + 2, y0, ' media ', { fg: borderColor, bg: C.bg });

    const innerH = h - 2;
    const innerW = w - 2;
    if (innerH <= 0 || innerW <= 0) return;

    if (visibleRows.length === 0) {
      const msg = '(no media files)';
      ctx.text(x0 + 1, y0 + 1, msg.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      return;
    }

    // Keep selection on screen.
    const selIdx = indexOfSelected();
    if (selIdx >= 0) {
      if (selIdx < treeScroll) treeScroll = selIdx;
      else if (selIdx >= treeScroll + innerH) treeScroll = selIdx - innerH + 1;
    }
    if (treeScroll < 0) treeScroll = 0;
    const maxScroll = Math.max(0, visibleRows.length - innerH);
    if (treeScroll > maxScroll) treeScroll = maxScroll;

    for (let i = 0; i < innerH; i++) {
      const ri = treeScroll + i;
      if (ri >= visibleRows.length) break;
      const row = visibleRows[ri];
      const isSel = row.path === selectedPath;
      const isLoaded = row.path === loadedPath;

      let glyph;
      if (row.type === 'dir') glyph = expanded.has(row.path) ? '▾' : '▸';
      else glyph = KIND_GLYPH[row.kind] || '·';

      const indent = '  '.repeat(row.depth);
      const text = `${indent}${glyph} ${row.name}`;
      let fg = isSel
        ? (treeFocused ? C.bg : C.fg)
        : (row.type === 'dir' ? C.fg : C.fgDim);
      if (!isSel && isLoaded) fg = C.accent;
      const bg = isSel ? (treeFocused ? C.accent : C.border) : C.bg;

      ctx.rect(x0 + 1, y0 + 1 + i, innerW, 1, { ch: ' ', bg, fg });
      ctx.text(x0 + 1, y0 + 1 + i, text.slice(0, innerW), {
        fg, bg, bold: isSel && treeFocused,
      });
      if (isSel && treeFocused) {
        ctx.put(x0 + w - 2, y0 + 1 + i, '◄', { fg, bg });
      }
    }
  }

  function renderPreview(ctx, x0, y0, w, h) {
    const C = ctx.theme.peek().colors;
    const pvFocused = focus === 'preview';
    const borderColor = pvFocused ? C.borderFocus : C.border;
    ctx.box(x0, y0, w, h, { fg: borderColor });

    const title = loadedPath
      ? ' ' + (KIND_GLYPH[loadedKind] || '') + ' ' + basename(loadedPath) + ' '
      : ' preview ';
    ctx.text(x0 + 2, y0, title.slice(0, Math.max(0, w - 4)), {
      fg: borderColor, bg: C.bg,
    });

    const innerX = x0 + 1;
    const innerY = y0 + 1;
    const innerW = w - 2;
    const innerH = h - 2;
    buttonZones = [];
    timelineRow = -1;
    linkRow = -1;
    if (innerW <= 0 || innerH <= 0) return;

    // Background wash.
    ctx.rect(innerX, innerY, innerW, innerH, { ch: ' ', bg: C.bg, fg: C.fg });

    if (loadError) {
      ctx.text(innerX, innerY, ('error: ' + loadError).slice(0, innerW),
        { fg: C.error, bg: C.bg });
      return;
    }
    if (!loadedPath) {
      const msg = 'select a media file in the tree (Enter / →)';
      const my = innerY + Math.floor(innerH / 2);
      const mx = innerX + Math.max(0, Math.floor((innerW - msg.length) / 2));
      ctx.text(mx, my, msg.slice(0, innerW), { fg: C.fgDim, bg: C.bg });
      return;
    }

    // Footer rows reserved at the bottom:
    //   linkRow  (always)  — original path link
    //   timeline + controls for video/audio
    const hasTransport = loadedKind === 'video' || loadedKind === 'audio';
    const footerH = hasTransport ? 3 : 1;   // link + timeline + controls
    const pictH = Math.max(0, innerH - footerH);

    // ── Picture area ───────────────────────────────────────────────────
    if (loadedKind === 'image') {
      ensureImage(innerW, pictH); // async; fills imageCells when done
      if (imageCells) {
        const rows = Math.min(pictH, imageCells.length);
        for (let y = 0; y < rows; y++) {
          const rowCells = imageCells[y];
          const cols = Math.min(innerW, rowCells.length);
          for (let x = 0; x < cols; x++) {
            const cell = rowCells[x];
            ctx.put(innerX + x, innerY + y, cell.ch, {
              fg: cell.fg || C.fg, bg: cell.bg || C.bg,
            });
          }
        }
      } else {
        const msg = imageLoading ? 'rendering…' : 'loading image…';
        ctx.text(innerX, innerY + Math.floor(pictH / 2), msg, { fg: C.fgDim, bg: C.bg });
      }
    } else if (loadedKind === 'video') {
      // (Re)spawn player when dims change.
      if (playerSrc && (!player || playerW !== innerW || playerH !== pictH)) {
        spawnPlayer(innerW, pictH);
      }
      if (lastFrame) {
        const rows = Math.min(pictH, lastFrame.length);
        for (let y = 0; y < rows; y++) {
          const rowCells = lastFrame[y];
          const cols = Math.min(innerW, rowCells.length);
          for (let x = 0; x < cols; x++) {
            const cell = rowCells[x];
            ctx.put(innerX + x, innerY + y, cell.ch, {
              fg: cell.fg || C.fg, bg: cell.bg || C.bg,
            });
          }
        }
      } else {
        ctx.text(innerX, innerY + Math.floor(pictH / 2), 'loading video…',
          { fg: C.fgDim, bg: C.bg });
      }
    } else if (loadedKind === 'audio') {
      // No picture — show a centered audio badge + simple level bars.
      drawAudioArt(ctx, innerX, innerY, innerW, pictH, C);
    }

    // ── Transport (timeline + controls) for video/audio ────────────────
    let cursorY = innerY + innerH - 1; // bottom-most inner row
    // Link row sits at the very bottom; controls/timeline above it.
    const linkY = cursorY;
    let tlY = -1, ctrlY = -1;
    if (hasTransport) {
      tlY = linkY - 2;
      ctrlY = linkY - 1;
      renderTimeline(ctx, innerX, tlY, innerW, C);
      renderControls(ctx, innerX, ctrlY, innerW, C);
    }
    renderLink(ctx, innerX, linkY, innerW, C);
  }

  function drawAudioArt(ctx, x, y, w, h, C) {
    if (h <= 0) return;
    const cy = y + Math.floor(h / 2);
    const label = '♪  ' + basename(loadedPath) + '  ♪';
    const lx = x + Math.max(0, Math.floor((w - label.length) / 2));
    ctx.text(lx, Math.max(y, cy - 1), label.slice(0, w),
      { fg: C.accent, bg: C.bg, bold: true });
    // A static equalizer-ish row of bars, animated by the blink + time.
    if (cy + 1 < y + h) {
      const playing = audioPlaying.peek();
      const t = music ? music.currentTime.peek() : 0;
      const barCount = Math.min(w, 24);
      const bx = x + Math.max(0, Math.floor((w - barCount) / 2));
      const glyphs = '▁▂▃▄▅▆▇';
      for (let i = 0; i < barCount; i++) {
        let gi;
        if (playing) {
          // Cheap pseudo-spectrum from time + index.
          const v = Math.abs(Math.sin(t * 3 + i * 0.7) * Math.cos(i * 0.3 + t));
          gi = Math.min(glyphs.length - 1, Math.floor(v * glyphs.length));
        } else {
          gi = 0;
        }
        ctx.put(bx + i, cy + 1, glyphs[gi],
          { fg: playing ? C.accent : C.fgDim, bg: C.bg });
      }
    }
  }

  function renderTimeline(ctx, x, y, w, C) {
    const p = loadedKind === 'video' ? player : music;
    timelineRow = y;
    ctx.rect(x, y, w, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });

    const cur = p ? p.currentTime.peek() : 0;
    const dur = p ? p.duration.peek() : 0;
    const timeStr = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    const timeW = timeStr.length + 1;
    const barX0 = x;
    const barX1 = Math.max(barX0, x + w - timeW - 1);
    timelineX0 = barX0;
    timelineX1 = barX1;
    const barLen = Math.max(0, barX1 - barX0);

    for (let i = 0; i < barLen; i++) {
      ctx.put(barX0 + i, y, '─', { fg: C.fgDim, bg: C.bg });
    }
    if (dur > 0 && barLen > 0) {
      const ratio = Math.max(0, Math.min(1, cur / dur));
      const knob = Math.round(ratio * (barLen - 1));
      for (let i = 0; i < knob; i++) {
        ctx.put(barX0 + i, y, '─', { fg: C.accent, bg: C.bg });
      }
      ctx.put(barX0 + knob, y, '●', { fg: C.accent, bg: C.bg, bold: true });
    }
    ctx.text(x + w - timeStr.length, y, timeStr, { fg: C.fg, bg: C.bg });
  }

  function renderControls(ctx, x, y, w, C) {
    ctx.rect(x, y, w, 1, { ch: ' ', bg: C.bg, fg: C.fg });
    const playing = loadedKind === 'video'
      ? (player && player.playing.peek())
      : audioPlaying.peek();
    const buttons = [
      { label: playing ? '[ pause ]' : '[ play ]', action: 'toggle', hot: true },
      { label: '[ stop ]', action: 'stop' },
    ];
    // Mute toggle only makes sense for video (audio uses its own controls).
    if (loadedKind === 'video') {
      buttons.push({ label: videoMuted ? '[ ♪off ]' : '[ ♪on ]', action: 'mute' });
    }
    let col = x;
    for (const b of buttons) {
      if (col >= x + w) break;
      const fits = Math.min(b.label.length, x + w - col);
      const hl = b.hot;
      ctx.text(col, y, b.label.slice(0, fits), {
        fg: hl ? C.bg : C.fg,
        bg: hl ? C.accent : C.bg,
        bold: hl,
      });
      buttonZones.push({ x0: col, x1: col + fits - 1, y, action: b.action });
      col += fits + 1;
    }
    // Right-aligned hint.
    const hint = '←/→ seek';
    const hx = x + w - hint.length;
    if (hx > col + 1) ctx.text(hx, y, hint, { fg: C.fgDim, bg: C.bg });
  }

  function renderLink(ctx, x, y, w, C) {
    linkRow = y;
    ctx.rect(x, y, w, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });
    const showStatus = status.peek() && performance.now() < statusUntil;
    if (showStatus) {
      ctx.text(x, y, status.peek().slice(0, w), { fg: C.warning, bg: C.bg });
      return;
    }
    const label = 'original: ';
    ctx.text(x, y, label, { fg: C.fgDim, bg: C.bg });
    // Reserve room on the right for the render-mode tag (picture media only).
    const tag = (loadedKind === 'image' || loadedKind === 'video')
      ? '[' + renderMode + ' · R]' : '';
    const linkText = loadedPath || '';
    const lx = x + label.length;
    const avail = Math.max(0, w - label.length - (tag ? tag.length + 1 : 0));
    ctx.text(lx, y, linkText.slice(0, avail), {
      fg: C.link, bg: C.bg, bold: focus === 'preview',
    });
    if (tag) {
      ctx.text(x + w - tag.length, y, tag, { fg: C.accent, bg: C.bg });
    }
  }

  function renderStatusBar(ctx, y) {
    const C = ctx.theme.peek().colors;
    const W = ctx.width;
    ctx.rect(0, y, W, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });
    const r = selectedRow();
    const left = r ? r.path : '/';
    ctx.text(0, y, left.slice(0, W), { fg: C.fgDim, bg: C.bg });
    const right = focus === 'tree'
      ? '↑↓ move · ↵ open · ⇥ preview'
      : 'SPACE play · ←/→ seek · ⇥ tree';
    const rx = W - right.length;
    if (rx > left.length + 2) ctx.text(rx, y, right, { fg: C.fgDim, bg: C.bg });
  }

  // ── App interface ────────────────────────────────────────────────────
  return {
    render(ctx) {
      consumeOpenFileHint();
      const C = ctx.theme.peek().colors;
      const W = ctx.width;
      const H = ctx.height;
      if (W <= 4 || H <= 4) return;

      ctx.rect(0, 0, W, H, { ch: ' ', bg: C.bg, fg: C.fg });

      const lw = leftPaneWidth(W);
      const paneH = H - 1; // reserve a status row at the bottom

      renderTree(ctx, 0, 0, lw, paneH);
      renderPreview(ctx, lw - 1, 0, W - (lw - 1), paneH);
      renderStatusBar(ctx, H - 1);
    },

    onKey(e) {
      if (e.type !== 'down') return;
      const k = e.key;

      if (k === 'Tab') {
        focus = focus === 'tree' ? 'preview' : 'tree';
        return;
      }

      if (focus === 'tree') {
        if (k === 'ArrowUp') { moveSelection(-1); return; }
        if (k === 'ArrowDown') { moveSelection(1); return; }
        if (k === 'PageUp') { moveSelection(-8); return; }
        if (k === 'PageDown') { moveSelection(8); return; }
        if (k === 'Home') { selectByIndex(0); return; }
        if (k === 'End') { selectByIndex(visibleRows.length - 1); return; }
        if (k === 'ArrowRight') { expandOrPreview(); return; }
        if (k === 'ArrowLeft') { collapseOrParent(); return; }
        if (k === 'Enter') { activateSelection(); return; }
        // Quick-Look style: space previews the highlighted file.
        if (k === ' ' || k === 'Spacebar') {
          const r = selectedRow();
          if (r && r.type === 'file') { loadMedia(r.path); focus = 'preview'; }
          return;
        }
        return;
      }

      // Preview focus
      if (k === ' ' || k === 'Spacebar') { togglePlay(); return; }
      if (k === 'ArrowLeft') { seekBy(-5); return; }
      if (k === 'ArrowRight') { seekBy(+5); return; }
      if (k === 'ArrowUp') { focus = 'tree'; return; }
      if (e.code === 'KeyS') { stopPlayback(); return; }
      if (e.code === 'KeyR') { cycleRenderMode(); return; }   // cycle picture mode
      if (e.code === 'KeyM') {                       // mute / unmute video
        videoMuted = !videoMuted;
        if (player && player.setMuted) player.setMuted(videoMuted);
        setStatus(videoMuted ? 'muted' : 'sound on', 1200);
        return;
      }
    },

    onMouse(e) {
      if (e.type !== 'click' && e.type !== 'dblclick' && e.type !== 'mousedown') return;
      const W = initialCtx.width;
      const H = initialCtx.height;
      const lw = leftPaneWidth(W);
      const paneH = H - 1;

      // Tree pane.
      if (e.x >= 0 && e.x < lw && e.y >= 1 && e.y < paneH - 1) {
        focus = 'tree';
        const rowIdx = treeScroll + (e.y - 1);
        if (rowIdx >= 0 && rowIdx < visibleRows.length) {
          selectByIndex(rowIdx);
          activateSelection();
        }
        return;
      }

      // Preview pane.
      if (e.x >= lw - 1 && e.x < W) {
        focus = 'preview';
        // Control buttons.
        for (const z of buttonZones) {
          if (e.y === z.y && e.x >= z.x0 && e.x <= z.x1) {
            if (z.action === 'toggle') togglePlay();
            else if (z.action === 'stop') stopPlayback();
            else if (z.action === 'mute') {
              videoMuted = !videoMuted;
              if (player && player.setMuted) player.setMuted(videoMuted);
              setStatus(videoMuted ? 'muted' : 'sound on', 1200);
            }
            return;
          }
        }
        // Timeline scrub.
        if (e.y === timelineRow) {
          const p = loadedKind === 'video' ? player : music;
          if (p) {
            const dur = p.duration.peek();
            const barLen = Math.max(0, timelineX1 - timelineX0);
            if (dur > 0 && barLen > 0 && e.x >= timelineX0 && e.x < timelineX0 + barLen) {
              const ratio = (e.x - timelineX0) / Math.max(1, barLen - 1);
              p.seek(Math.max(0, Math.min(dur - 0.1, ratio * dur)));
            }
          }
          return;
        }
        // Click the "original" link → hand off to the shell's file opener so
        // the user can open it elsewhere (finder etc.). Best-effort.
        if (e.y === linkRow && loadedPath) {
          try { globalThis.shell?.openFile?.(loadedPath); } catch (_) {}
          return;
        }
      }
    },

    onTouch(e) {
      if (e.type === 'tap') { this.onMouse({ type: 'click', x: e.x, y: e.y }); }
      else if (e.type === 'doubletap') { this.onMouse({ type: 'dblclick', x: e.x, y: e.y }); }
      else if (e.type === 'swipe') {
        if (focus === 'tree') {
          if (e.dir === 'up') moveSelection(3);
          else if (e.dir === 'down') moveSelection(-3);
        } else {
          if (e.dir === 'left') seekBy(-10);
          else if (e.dir === 'right') seekBy(+10);
        }
      } else if (e.type === 'longpress') {
        togglePlay();
      }
    },

    destroy() {
      teardownMedia();
      if (audio && audio.ctx) { try { audio.ctx.close(); } catch (_) {} audio = null; }
      for (const u of blobUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
      blobUrls.clear();
      if (blinkTimer) clearInterval(blinkTimer);
      if (typeof unsubFS === 'function') unsubFS();
    },
  };
}
