// ASCII video player — wraps media.js createVideoPlayer in an app window.
//
// Layout (LOCAL coords inside the window content area):
//   y = 0 .. H-4                 -> ASCII frame (video canvas)
//   y = H-3                      -> timeline + time readout
//   y = H-2                      -> control buttons row
//   y = H-1                      -> status / hint row
//
// The player is created lazily once a URL is loaded; the canvas height
// passed to media.js is (H - 3) so the bottom three rows host controls.
// On window resize we recreate the player at the new dimensions but
// preserve the current playhead so playback continues uninterrupted.

import { signal } from '../signals.js';
import { createVideoPlayer } from '../media.js';
import { createFS } from '../fs.js';

const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });

// MIME-by-extension for blob URL hint (helps some browsers pick decoder)
function mimeForExt(ext) {
  return ({
    mp4: 'video/mp4', m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg', ogg: 'video/ogg',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
  })[(ext || '').toLowerCase()] || 'video/mp4';
}

const STORAGE_KEY = 'acii.video.lastUrl';
const DEFAULT_URL =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

// Control button definitions. Each has a label as it appears on the bar
// and an `action` key consumed by handleClick / key handlers.
const BUTTONS = [
  { label: '[ play ]',     action: 'play'  },
  { label: '[ pause ]',    action: 'pause' },
  { label: '[ stop ]',     action: 'stop'  },
  { label: '[ load url… ]', action: 'load' },
];

export function createApp(initialCtx, win) {
  // ── State ──────────────────────────────────────────────────────
  let player = null;
  let url = null;
  // Cached last sampled frame as a 2D array of { ch, fg } cells.
  let lastFrame = null;
  // Dimensions we last requested from media.js; used to detect resize.
  let playerW = 0, playerH = 0;
  // Hit-zones for the toolbar — computed during render, consumed by click.
  let buttonZones = []; // [{ x0, x1, action }]
  let timelineRow = -1;
  let timelineX0 = 0, timelineX1 = 0;

  const status = signal('');
  let statusUntil = 0;
  function setStatus(msg, ms = 1500) {
    status.value = msg;
    statusUntil = performance.now() + ms;
  }

  // ── Player lifecycle ───────────────────────────────────────────
  function teardownPlayer() {
    if (player) {
      try { player.destroy(); } catch (_) {}
      player = null;
    }
    lastFrame = null;
    playerW = 0;
    playerH = 0;
  }

  // Spin up a fresh player at the given dims. If resumeAt is provided,
  // we seek there once metadata loads — used by resize to keep playback
  // continuous across canvas-size changes.
  function spawnPlayer(srcUrl, W, H, { autoplay = true, resumeAt = 0, wasPlaying = true } = {}) {
    teardownPlayer();
    if (!srcUrl || W <= 0 || H <= 0) return;
    try {
      player = createVideoPlayer({
        src: srcUrl,
        width: W,
        height: H,
        color: 'rgb',
        fps: 15,
      });
    } catch (err) {
      setStatus('failed to load: ' + (err.message || err), 3000);
      return;
    }
    playerW = W;
    playerH = H;
    url = srcUrl;
    lastFrame = null;
    player.onFrame((cells) => { lastFrame = cells; });

    // Seek+play once we know the metadata is ready. The 'loadedmetadata'
    // hook in media.js sets duration; we listen to the same signal.
    let kicked = false;
    const stop = (function watchDuration() {
      // Simple polling effect via signal subscription: we want a one-shot
      // when duration becomes > 0. Using a tiny interval keeps this self-
      // contained (no manual effect plumbing inside the app).
      const t = setInterval(() => {
        if (kicked) return;
        if (player && player.duration.peek() > 0) {
          kicked = true;
          if (resumeAt > 0) {
            try { player.seek(Math.min(resumeAt, player.duration.peek() - 0.1)); } catch (_) {}
          }
          if (autoplay && wasPlaying) {
            player.play().catch((err) => {
              setStatus('autoplay blocked — click play', 2500);
            });
          }
          clearInterval(t);
        }
      }, 80);
      // Safety timeout — give up watching after 8s.
      setTimeout(() => clearInterval(t), 8000);
      return () => clearInterval(t);
    })();
  }

  function loadFromPrompt() {
    const initial = url || localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;
    const next = window.prompt('Video URL nebo /cesta/v/fs', initial);
    if (!next) return;
    // FS path? Load via blob.
    if (next.startsWith('/')) { loadFromFS(next); return; }
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
    spawnPlayer(next, playerW || 40, playerH || 10, { autoplay: true });
    setStatus('loading…');
  }

  // Track blob URLs we created so we can revoke them on teardown / reload.
  const blobUrls = new Set();
  function makeBlobUrl(path) {
    try {
      const bytes = fs.readBytes(path);   // ArrayBuffer
      const ext = path.split('.').pop();
      const blob = new Blob([bytes], { type: mimeForExt(ext) });
      const u = URL.createObjectURL(blob);
      blobUrls.add(u);
      return u;
    } catch (err) {
      setStatus('FS read failed: ' + (err.message || err), 3000);
      return null;
    }
  }
  function loadFromFS(path) {
    const u = makeBlobUrl(path);
    if (!u) return;
    win.setTitle?.('Video · ' + path);
    spawnPlayer(u, playerW || 40, playerH || 10, { autoplay: true });
    setStatus('loading ' + path);
  }

  // Pick up shell hint: if openFile() routed a video here, load it.
  function consumeOpenFileHint() {
    const p = globalThis.__aciiOpenFile;
    if (!p || !p.startsWith('/')) return;
    if (!fs.exists(p)) return;
    globalThis.__aciiOpenFile = null;
    loadFromFS(p);
  }

  // ── Time formatting ────────────────────────────────────────────
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── Render ─────────────────────────────────────────────────────
  function render(ctx) {
    const W = ctx.width;
    const H = ctx.height;
    if (W <= 0 || H < 5) return;

    const colors = ctx.theme.peek().colors;
    const videoH = H - 3; // top region for frames

    // If we have a player but the canvas size changed, respawn at new dims.
    if (player && (playerW !== W || playerH !== videoH)) {
      const resumeAt = player.currentTime.peek();
      const wasPlaying = player.playing.peek();
      spawnPlayer(url, W, videoH, { autoplay: true, resumeAt, wasPlaying });
    }

    // ── Video area ───────────────────────────────────────────────
    if (lastFrame) {
      const rows = Math.min(videoH, lastFrame.length);
      for (let y = 0; y < rows; y++) {
        const row = lastFrame[y];
        const cols = Math.min(W, row.length);
        for (let x = 0; x < cols; x++) {
          const cell = row[x];
          ctx.put(x, y, cell.ch, { fg: cell.fg || colors.fg, bg: colors.bg });
        }
      }
    } else {
      // Empty state — fill with bg and show centered hint.
      ctx.rect(0, 0, W, videoH, { ch: ' ', bg: colors.bg, fg: colors.fg });
      const msg = url ? 'loading…' : "No video loaded — press 'L' to load URL";
      const mx = Math.max(0, Math.floor((W - msg.length) / 2));
      const my = Math.max(0, Math.floor(videoH / 2));
      ctx.text(mx, my, msg.slice(0, W), { fg: colors.fgDim, bg: colors.bg });
    }

    // ── Timeline row ─────────────────────────────────────────────
    const tlY = H - 3;
    timelineRow = tlY;
    ctx.rect(0, tlY, W, 1, { ch: ' ', bg: colors.bg, fg: colors.fgDim });

    const cur = player ? player.currentTime.peek() : 0;
    const dur = player ? player.duration.peek() : 0;
    const timeStr = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    // Reserve right-side space for the time readout (+1 for padding).
    const timeW = timeStr.length + 1;
    const barX0 = 0;
    const barX1 = Math.max(barX0, W - timeW - 1);
    timelineX0 = barX0;
    timelineX1 = barX1;
    const barLen = Math.max(0, barX1 - barX0);

    if (barLen > 0) {
      // Track.
      for (let i = 0; i < barLen; i++) {
        ctx.put(barX0 + i, tlY, '─', { fg: colors.fgDim, bg: colors.bg });
      }
      // Progress fill + scrubber knob.
      if (dur > 0) {
        const ratio = Math.max(0, Math.min(1, cur / dur));
        const knob = Math.round(ratio * (barLen - 1));
        for (let i = 0; i < knob; i++) {
          ctx.put(barX0 + i, tlY, '─', { fg: colors.accent, bg: colors.bg });
        }
        ctx.put(barX0 + knob, tlY, '●', { fg: colors.accent, bg: colors.bg, bold: true });
      }
    }
    // Time readout.
    ctx.text(W - timeStr.length, tlY, timeStr, { fg: colors.fg, bg: colors.bg });

    // ── Control buttons row ──────────────────────────────────────
    const btnY = H - 2;
    ctx.rect(0, btnY, W, 1, { ch: ' ', bg: colors.bg, fg: colors.fg });
    buttonZones = [];
    let col = 0;
    for (const btn of BUTTONS) {
      if (col >= W) break;
      const label = btn.label;
      const fits = Math.min(label.length, W - col);
      // Highlight the currently-meaningful button: play if paused, pause if playing.
      let highlight = false;
      if (player) {
        const playing = player.playing.peek();
        if (btn.action === 'play' && !playing && url) highlight = true;
        if (btn.action === 'pause' && playing) highlight = true;
      }
      ctx.text(col, btnY, label.slice(0, fits), {
        fg: highlight ? colors.bg : colors.fg,
        bg: highlight ? colors.accent : colors.bg,
        bold: highlight,
      });
      buttonZones.push({ x0: col, x1: col + fits - 1, action: btn.action });
      col += fits + 1; // 1-cell gap between buttons
    }

    // ── Status row ───────────────────────────────────────────────
    const stY = H - 1;
    ctx.rect(0, stY, W, 1, { ch: ' ', bg: colors.bg, fg: colors.fgDim });
    const showStatus = status.peek() && performance.now() < statusUntil;
    const hint = 'SPACE play/pause   ←/→ seek 5s   L load URL';
    const msg = showStatus ? status.peek() : hint;
    ctx.text(0, stY, msg.slice(0, W), { fg: colors.fgDim, bg: colors.bg });
  }

  // ── Input ──────────────────────────────────────────────────────
  function handleAction(action) {
    switch (action) {
      case 'play':
        if (!player) { loadFromPrompt(); return; }
        player.play().catch(() => setStatus('play blocked', 2000));
        break;
      case 'pause':
        if (player) player.pause();
        break;
      case 'stop':
        if (player) player.stop();
        break;
      case 'load':
        loadFromPrompt();
        break;
    }
  }

  function seekBy(delta) {
    if (!player) return;
    const dur = player.duration.peek();
    const cur = player.currentTime.peek();
    const next = Math.max(0, Math.min(Math.max(0, dur - 0.1), cur + delta));
    player.seek(next);
  }

  function onKey(e) {
    if (e.type !== 'down') return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      if (!player) { loadFromPrompt(); return; }
      if (player.playing.peek()) player.pause();
      else player.play().catch(() => setStatus('play blocked', 2000));
      return;
    }
    if (k === 'ArrowLeft')  { seekBy(-5); return; }
    if (k === 'ArrowRight') { seekBy(+5); return; }
    if (k === 'l' || k === 'L') { loadFromPrompt(); return; }
  }

  function onMouse(e) {
    if (e.type !== 'click') return;
    const { x, y } = e;
    // Toolbar button click.
    for (const z of buttonZones) {
      if (y === (timelineRow + 1) && x >= z.x0 && x <= z.x1) {
        handleAction(z.action);
        return;
      }
    }
    // Timeline scrub.
    if (y === timelineRow && player) {
      const dur = player.duration.peek();
      const barLen = Math.max(0, timelineX1 - timelineX0);
      if (dur > 0 && barLen > 0 && x >= timelineX0 && x < timelineX0 + barLen) {
        const ratio = (x - timelineX0) / Math.max(1, barLen - 1);
        player.seek(Math.max(0, Math.min(dur - 0.1, ratio * dur)));
      }
    }
  }

  function onTouch(e) {
    if (e.type === 'tap') onMouse({ type: 'click', x: e.x, y: e.y });
    else if (e.type === 'swipe') {
      // Quick scrub: swipe left/right seeks ±10s.
      if (e.dir === 'left')  seekBy(-10);
      if (e.dir === 'right') seekBy(+10);
    }
  }

  function destroy() {
    teardownPlayer();
    for (const u of blobUrls) URL.revokeObjectURL(u);
    blobUrls.clear();
  }

  // ── Boot ─────────────────────────────────────────────────────────
  // Priority: openFile hint from shell → last saved URL → nothing.
  const realRender = render;
  let bootDone = false;
  render = function bootRender(ctx) {
    if (!bootDone && ctx.width > 0 && ctx.height >= 5) {
      bootDone = true;
      // 1) Try opening a file passed in via shell.openFile()
      const hint = globalThis.__aciiOpenFile;
      if (hint && hint.startsWith('/') && fs.exists(hint)) {
        globalThis.__aciiOpenFile = null;
        loadFromFS(hint);
      } else {
        // 2) Restore last URL from localStorage
        try {
          const savedUrl = localStorage.getItem(STORAGE_KEY);
          if (savedUrl) {
            url = savedUrl;
            spawnPlayer(savedUrl, ctx.width, ctx.height - 3, { autoplay: true });
          }
        } catch (_) {}
      }
    }
    // Pick up later openFile hints — fires whenever shell.openFile() routes
    // another video to this app while it's already open.
    consumeOpenFileHint();
    return realRender(ctx);
  };

  return {
    // Use getters so the boot wrapper above (which reassigns `render`)
    // is picked up after this object is returned.
    get render() { return render; },
    onKey,
    onMouse,
    onTouch,
    destroy,
  };
}
