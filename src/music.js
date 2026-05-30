// music.js — a tiny dependency-free music player engine for acii_os.
//
// Two open sources, switchable:
//   • disk  — audio files from the virtual FS (and mounted folders)
//   • radio — free / open-licensed internet radio streams (SomaFM)
//
// Pure-ish: wraps one HTMLAudioElement. No DOM rendering — the host widget
// draws from state() and drives it via play/pause/next/prev/toggleMode.
//
//   import { createMusicPlayer, RADIO_STATIONS, scanAudioFiles } from './music.js';
//   const p = createMusicPlayer(fs);
//   p.toggle(); p.next(); p.state(); p.destroy();

export const RADIO_STATIONS = [
  { name: 'Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { name: 'Drone Zone',   url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { name: 'Lush',         url: 'https://ice1.somafm.com/lush-128-mp3' },
  { name: 'Indie Pop',    url: 'https://ice1.somafm.com/indiepop-128-mp3' },
  { name: 'Beat Blender', url: 'https://ice1.somafm.com/beatblender-128-mp3' },
  { name: 'Secret Agent', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
];

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);

// Recursively collect audio files from the virtual FS.
export function scanAudioFiles(fs) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 8) return;
    let kids;
    try { kids = fs.list(dir); } catch { return; }
    if (!Array.isArray(kids)) return;
    for (const k of kids) {
      const p = (dir === '/' ? '' : dir) + '/' + k.name;
      if (k.type === 'dir') walk(p, depth + 1);
      else {
        const ext = (k.name.toLowerCase().split('.').pop() || '');
        if (AUDIO_EXT.has(ext)) out.push({ path: p, name: k.name });
      }
    }
  }
  walk('/', 0);
  return out;
}

export function createMusicPlayer(fs) {
  const audio = new Audio();
  audio.preload = 'none';

  let mode = 'disk';      // 'disk' | 'radio'
  let fsList = [];
  let fsIdx = 0;
  let radioIdx = 0;
  let blobUrl = null;
  let label = '';
  let error = '';

  audio.addEventListener('ended', () => { if (mode === 'disk') next(); });
  audio.addEventListener('error', () => { error = 'playback error'; });

  function revoke() { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch {} blobUrl = null; } }
  function refreshFs() { fsList = scanAudioFiles(fs); if (fsIdx >= fsList.length) fsIdx = 0; }

  function loadDisk(i) {
    refreshFs();
    if (!fsList.length) { label = ''; error = 'no audio on disk'; revoke(); audio.removeAttribute('src'); return; }
    fsIdx = ((i % fsList.length) + fsList.length) % fsList.length;
    const f = fsList[fsIdx];
    error = '';
    try {
      const buf = fs.readBytes(f.path);
      revoke();
      blobUrl = URL.createObjectURL(new Blob([buf || new ArrayBuffer(0)]));
      audio.src = blobUrl;
      label = f.name;
    } catch { error = 'cannot read file'; }
  }
  function loadRadio(i) {
    radioIdx = ((i % RADIO_STATIONS.length) + RADIO_STATIONS.length) % RADIO_STATIONS.length;
    const s = RADIO_STATIONS[radioIdx];
    revoke();
    audio.src = s.url;
    label = s.name;
    error = '';
  }
  function ensureLoaded() {
    if (audio.getAttribute('src')) return;
    if (mode === 'disk') loadDisk(fsIdx); else loadRadio(radioIdx);
  }
  function play() {
    ensureLoaded();
    if (!audio.getAttribute('src')) return;
    const pr = audio.play();
    if (pr && pr.catch) pr.catch(() => { error = 'tap ▶ to start'; });
  }
  function pause() { audio.pause(); }
  function toggle() { if (audio.paused) play(); else pause(); }
  function next() { if (mode === 'disk') loadDisk(fsIdx + 1); else loadRadio(radioIdx + 1); play(); }
  function prev() { if (mode === 'disk') loadDisk(fsIdx - 1); else loadRadio(radioIdx - 1); play(); }
  function setMode(m) {
    if (m === mode) return;
    pause();
    mode = m;
    revoke();
    audio.removeAttribute('src');
    label = '';
    error = '';
    if (m === 'disk') refreshFs();
  }
  function toggleMode() { setMode(mode === 'disk' ? 'radio' : 'disk'); }
  function state() {
    const count = mode === 'disk' ? fsList.length : RADIO_STATIONS.length;
    const idx = mode === 'disk' ? fsIdx : radioIdx;
    return {
      mode,
      playing: !audio.paused && !!audio.getAttribute('src'),
      label: label || (mode === 'disk' ? '(no track)' : '(pick a station)'),
      error,
      count,
      idx,
    };
  }
  function destroy() { try { audio.pause(); } catch {} revoke(); try { audio.removeAttribute('src'); } catch {} }

  // Start on whichever source is immediately useful: disk if it has files,
  // else radio so the widget plays something out of the box.
  refreshFs();
  if (!fsList.length) mode = 'radio';

  return { play, pause, toggle, next, prev, setMode, toggleMode, refreshFs, state, destroy };
}
