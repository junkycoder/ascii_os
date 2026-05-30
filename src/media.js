// media.js — adapters for images, video, and audio in the ASCII engine.
//
// Everything here is browser-side, zero deps. Brightness is mapped to a
// charset ramp; colors are optional (rgb mode emits per-cell hex fg).
//
// Cells produced by image/video sampling match the engine's draw API:
//   { ch, fg } — pass straight to ctx.put(x, y, cell.ch, { fg: cell.fg }).

import { signal } from "./signals.js";

// Default ramp: sparse → dense. Index 0 = darkest (space), last = brightest.
// The wider/punchier the ramp, the better mid-tones look.
const DEFAULT_CHARSET = " .'`,:;-+*xX%#@";

// ─── Shared canvas helper ───────────────────────────────────────────
// We oversample vertically by 2x because terminal cells are roughly
// twice as tall as wide. Sampling at WxH*2 then mapping 1 source pixel
// per cell keeps the aspect right without distortion.
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  // willReadFrequently keeps getImageData fast across redraws.
  const g = c.getContext("2d", { willReadFrequently: true });
  return { canvas: c, ctx: g };
}

function toHex(r, g, b) {
  // Pack 0–255 RGB into '#rrggbb'. Faster than string concat.
  const n = (r << 16) | (g << 8) | b;
  return "#" + n.toString(16).padStart(6, "0");
}

// Sample a drawable (HTMLImageElement / HTMLVideoElement / Canvas / ImageBitmap)
// into a 2D array of { ch, fg } cells at the target terminal size.
function sampleDrawable(drawable, { width, height, charset, color }) {
  const ramp = charset || DEFAULT_CHARSET;
  const last = ramp.length - 1;
  const sw = width;
  const sh = height * 2; // vertical oversample

  const { canvas, ctx } = makeCanvas(sw, sh);
  // Drop alpha onto the canvas bg so transparent pixels read as dark, not
  // garbage. drawImage is told to stretch into the full target rect.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(drawable, 0, 0, sw, sh);

  const img = ctx.getImageData(0, 0, sw, sh).data;
  const cells = new Array(height);

  for (let y = 0; y < height; y++) {
    const row = new Array(width);
    // Pick the vertically-averaged pair of source rows for this cell.
    const sy0 = y * 2;
    const sy1 = sy0 + 1;
    for (let x = 0; x < width; x++) {
      const i0 = (sy0 * sw + x) * 4;
      const i1 = (sy1 * sw + x) * 4;
      const r = (img[i0] + img[i1]) >> 1;
      const g = (img[i0 + 1] + img[i1 + 1]) >> 1;
      const b = (img[i0 + 2] + img[i1 + 2]) >> 1;
      // Perceived luminance (Rec. 601). Good enough for ramp picking.
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      const idx = Math.min(last, Math.max(0, Math.round((lum / 255) * last)));
      const ch = ramp[idx];
      row[x] = color === "rgb"
        ? { ch, fg: toHex(r, g, b) }
        : { ch, fg: null };
    }
    cells[y] = row;
  }
  return { width, height, cells };
}

// ─── Image → ASCII ──────────────────────────────────────────────────
// Accepts a URL string, a Blob, or anything URL.createObjectURL can swallow.
// Returns a Promise so we can await image decode.
export async function imageToAscii(srcUrlOrBlob, opts = {}) {
  const { width, height } = opts;
  if (!width || !height) {
    throw new Error("imageToAscii: width and height are required");
  }
  const img = await loadImage(srcUrlOrBlob);
  return sampleDrawable(img, opts);
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    // Best-effort cross-origin for canvas read-back. If the server doesn't
    // play along, getImageData below will throw — fine, caller sees it.
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = (e) => rej(new Error("imageToAscii: failed to load image"));
    if (typeof src === "string") {
      img.src = src;
    } else if (src instanceof Blob) {
      img.src = URL.createObjectURL(src);
    } else {
      rej(new Error("imageToAscii: src must be a URL string or Blob"));
    }
  });
}

// ─── Video → ASCII ──────────────────────────────────────────────────
// Wraps a hidden <video> and samples it on a timer. Frame callbacks
// receive the same { cells } shape as imageToAscii so renderers can be
// shared. Caller is responsible for calling destroy() when done.
export function createVideoPlayer(opts) {
  const { src, width, height, charset, color = "mono", fps = 15,
          muted = true, volume = 1 } = opts;
  if (!src) throw new Error("createVideoPlayer: src required");
  if (!width || !height) {
    throw new Error("createVideoPlayer: width and height required");
  }

  // Off-DOM video element. We don't attach it; canvas reads work fine.
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  // muted defaults to true so unattended autoplay is browser-friendly; pass
  // muted:false (e.g. Media House) to hear audio — works once the user has
  // interacted with the page (clicking a file / the play control counts).
  video.muted = !!muted;
  video.volume = Math.max(0, Math.min(1, volume));
  video.loop = false;
  video.preload = "auto";
  video.src = src;

  const currentTime = signal(0);
  const duration = signal(0);
  const playing = signal(false);

  const frameHandlers = new Set();
  function onFrame(fn) { frameHandlers.add(fn); return () => frameHandlers.delete(fn); }

  let sampleTimer = null;
  function startSampling() {
    if (sampleTimer) return;
    const interval = Math.max(16, Math.round(1000 / fps));
    sampleTimer = setInterval(() => {
      // readyState >= 2 means we have current frame data we can paint.
      if (video.readyState < 2) return;
      currentTime.value = video.currentTime;
      const sampled = sampleDrawable(video, { width, height, charset, color });
      for (const h of frameHandlers) h(sampled.cells);
    }, interval);
  }
  function stopSampling() {
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
  }

  video.addEventListener("loadedmetadata", () => {
    duration.value = isFinite(video.duration) ? video.duration : 0;
  });
  video.addEventListener("play", () => { playing.value = true; startSampling(); });
  video.addEventListener("pause", () => { playing.value = false; stopSampling(); });
  video.addEventListener("ended", () => { playing.value = false; stopSampling(); });

  return {
    play() {
      // Returns the underlying play() Promise so callers can await
      // permission-related rejection if the page hasn't gestured yet.
      return video.play();
    },
    pause() { video.pause(); },
    stop() {
      video.pause();
      try { video.currentTime = 0; } catch (_) { /* not seekable yet */ }
      stopSampling();
    },
    seek(t) { video.currentTime = t; },
    setMuted(m) { video.muted = !!m; },
    isMuted() { return video.muted; },
    setVolume(v) { video.volume = Math.max(0, Math.min(1, v)); },
    currentTime,
    duration,
    playing,
    onFrame,
    destroy() {
      stopSampling();
      video.pause();
      video.removeAttribute("src");
      video.load();
      frameHandlers.clear();
    },
  };
}

// ─── Audio ──────────────────────────────────────────────────────────
// Three layers:
//   beep()      — synthesized one-shots, no asset needed
//   loadSound() — decoded buffer for fast SFX (think key clicks)
//   loadMusic() — HTMLAudioElement wrapper for long tracks (streams)
//
// Browsers gate AudioContext until a user gesture. resume() exists so
// callers can wire it to a first-click handler.
export function createAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("createAudio: Web Audio API not supported");
  const ctx = new AC();

  // ── beep ────────────────────────────────────────────────────────
  // Quick oscillator + gain envelope. Resolves when the note ends so
  // callers can chain sequences with await.
  function beep(opts = {}) {
    const {
      freq = 440,
      duration = 100,
      type = "sine",
      volume = 0.2,
    } = opts;
    return new Promise((resolve) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;

      // Tiny attack/release envelope to avoid click on note start/stop.
      const now = ctx.currentTime;
      const dur = duration / 1000;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.005);
      gain.gain.setValueAtTime(volume, now + dur - 0.01);
      gain.gain.linearRampToValueAtTime(0, now + dur);

      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur);
      osc.onended = () => { try { osc.disconnect(); } catch (_) {} resolve(); };
    });
  }

  // ── loadSound ───────────────────────────────────────────────────
  // Fetch + decode once, then spawn cheap BufferSources per play().
  // Caches by URL so repeated loadSound calls don't redecode.
  const bufferCache = new Map();

  async function loadSound(url) {
    let buffer = bufferCache.get(url);
    if (!buffer) {
      const res = await fetch(url);
      const ab = await res.arrayBuffer();
      buffer = await ctx.decodeAudioData(ab);
      bufferCache.set(url, buffer);
    }
    // Each call creates a fresh source — BufferSources are one-shot.
    const active = new Set();
    return {
      duration: buffer.duration,
      play(playOpts = {}) {
        const { volume = 1, rate = 1, loop = false, when = 0 } = playOpts;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        src.loop = loop;
        gain.gain.value = volume;
        src.connect(gain).connect(ctx.destination);
        src.start(ctx.currentTime + when);
        active.add(src);
        src.onended = () => {
          active.delete(src);
          try { src.disconnect(); gain.disconnect(); } catch (_) {}
        };
        return src;
      },
      stop() {
        for (const src of active) {
          try { src.stop(); } catch (_) {}
        }
        active.clear();
      },
    };
  }

  // ── loadMusic ───────────────────────────────────────────────────
  // HTMLAudioElement streams, so this is the right choice for long
  // tracks. Exposes reactive signals so UI can bind to time/duration.
  function loadMusic(url) {
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = url;

    const currentTime = signal(0);
    const duration = signal(0);
    const playing = signal(false);

    el.addEventListener("loadedmetadata", () => {
      duration.value = isFinite(el.duration) ? el.duration : 0;
    });
    el.addEventListener("timeupdate", () => {
      currentTime.value = el.currentTime;
    });
    el.addEventListener("play", () => { playing.value = true; });
    el.addEventListener("pause", () => { playing.value = false; });
    el.addEventListener("ended", () => { playing.value = false; });

    return {
      play() { return el.play(); },
      pause() { el.pause(); },
      stop() {
        el.pause();
        try { el.currentTime = 0; } catch (_) {}
      },
      volume(v) {
        // Clamp so callers can pass dirty data without trapping.
        el.volume = Math.max(0, Math.min(1, v));
      },
      seek(t) { el.currentTime = t; },
      currentTime,
      duration,
      playing,
      el, // escape hatch for advanced use (e.g. piping into Web Audio)
    };
  }

  return {
    beep,
    loadSound,
    loadMusic,
    ctx,
    resume() { return ctx.resume(); },
  };
}
