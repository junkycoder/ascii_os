// apps/share.js — Durable-Object file share (local→DO→locals).
//
// Create a room (you become the source), or join one by code. Small files
// (text + small images/audio) live in the room's Durable Object and sync live
// over a WebSocket; files too big for the DO are sent peer-to-peer over the
// WebRTC tunnel the same socket signals for.
//
// Handoffs (set by the shell before focusing this app):
//   globalThis.__aciiSharePath  → create a room and push this FS path
//   globalThis.__aciiShareJoin  → join this room code on open
// Coords from the WM are LOCAL to the window content area.

import { createFS } from '../fs.js';
import { createShareClient, createTunnel } from '../share.js';

const fs = globalThis.__aciiFS ||= createFS({ storageKey: 'acii.fs.v1' });

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
  return (n / 1024 / 1024).toFixed(1) + ' M';
}

export function createApp(initialCtx, win) {
  const share = createShareClient({ fs });

  let mode = 'home';        // 'home' | 'room'
  let code = null;
  let writeToken = null;    // per-room write secret (source only; null = read-only)
  let role = null;          // 'host' | 'guest'
  let conn = null;          // WS connection handle
  let tunnel = null;        // WebRTC tunnel (lazy)
  let files = [];           // [{path,name,mime,size,mtime}]
  let sel = 0;              // selected file index
  let peers = 0;
  let status = '';          // transient status line
  let busy = false;

  // Inline text prompt (join code / push path).
  let prompt = null;        // { kind:'join'|'push', label, buf }

  function setStatus(s) { status = s || ''; }

  function destDir() { return '/share/' + (code || 'incoming'); }

  // ── live connection ──────────────────────────────────────────────
  function openConn(c) {
    conn = share.connect(c, {
      onHello: (m) => { peers = (m.peers || []).length; refresh(); },
      onPeer: () => { peers = conn ? conn.peers().length : 0; },
      onOpen: () => setStatus('connected'),
      onClose: () => setStatus('reconnecting…'),
      onEvent: () => refresh(),
      onSignal: (m) => { ensureTunnel(); tunnel.handleSignal(m); },
    });
  }

  function ensureTunnel() {
    if (tunnel) return tunnel;
    tunnel = createTunnel(conn, {
      onFile: ({ name, bytes }) => {
        try { fs.write(destDir() + '/' + name, new Uint8Array(bytes)); setStatus('tunnel: received ' + name); }
        catch (e) { setStatus('tunnel write failed: ' + e.message); }
      },
      onProgress: ({ name, got, size }) => setStatus(`tunnel ${name} ${Math.round(got / size * 100)}%`),
    });
    return tunnel;
  }

  async function refresh() {
    if (!code) return;
    try {
      const m = await share.getManifest(code);
      files = m.files || [];
      peers = m.peers || peers;
      if (sel >= files.length) sel = Math.max(0, files.length - 1);
    } catch (e) { setStatus('manifest: ' + e.message); }
  }

  // ── actions ──────────────────────────────────────────────────────
  async function createRoom(pushPath) {
    busy = true; setStatus('creating share…');
    try {
      const room = await share.createRoom();
      code = room.code;
      writeToken = room.token;
      role = 'host';
      mode = 'room';
      openConn(code);
      if (pushPath) await doPush(pushPath);
      await refresh();
      setStatus('share ready — code ' + code);
    } catch (e) { setStatus('create failed: ' + e.message); }
    finally { busy = false; }
  }

  async function joinRoom(c) {
    c = String(c || '').trim().toLowerCase();
    if (!c) return;
    busy = true; setStatus('joining ' + c + '…');
    try {
      code = c;
      role = 'guest';
      mode = 'room';
      openConn(code);
      await refresh();
      setStatus('joined ' + c + ' — ' + files.length + ' file(s)');
    } catch (e) { setStatus('join failed: ' + e.message); }
    finally { busy = false; }
  }

  async function doPush(path) {
    if (!fs.exists(path)) { setStatus('no such path: ' + path); return; }
    if (!writeToken) { setStatus('read-only: only the source can push'); return; }
    busy = true; setStatus('pushing ' + path + '…');
    try {
      const { pushed, tooLarge } = await share.pushPath(code, path, writeToken);
      await refresh();
      if (tooLarge.length) {
        // Files over the DO cap go peer-to-peer to every connected peer.
        ensureTunnel();
        for (const f of tooLarge) {
          const bytes = await fs.readBytesAsync(f.src);
          for (const p of conn.peers()) await tunnel.sendFile(p, { name: f.rel, mime: 'application/octet-stream', bytes });
        }
        setStatus(`pushed ${pushed.length}; tunneled ${tooLarge.length} large file(s)`);
      } else {
        setStatus('pushed ' + pushed.length + ' file(s)');
      }
    } catch (e) { setStatus('push failed: ' + e.message); }
    finally { busy = false; }
  }

  async function pullAll() {
    busy = true; setStatus('saving to ' + destDir() + '…');
    try {
      const out = await share.pullAll(code, destDir());
      setStatus('saved ' + out.length + ' file(s) to ' + destDir());
    } catch (e) { setStatus('pull failed: ' + e.message); }
    finally { busy = false; }
  }

  async function delSelected() {
    const f = files[sel]; if (!f) return;
    if (!writeToken) { setStatus('read-only: only the source can remove files'); return; }
    try { await share.deleteFile(code, f.path, writeToken); await refresh(); setStatus('deleted ' + f.path); }
    catch (e) { setStatus('delete failed: ' + e.message); }
  }

  async function openSelected() {
    const f = files[sel]; if (!f) return;
    const dest = destDir() + '/' + f.path;
    try {
      await share.pullFile(code, f, destDir());
      globalThis.__aciiOpenFile = dest;
      setStatus('opening ' + dest + ' — switch via taskbar');
    } catch (e) { setStatus('open failed: ' + e.message); }
  }

  function leave() {
    if (conn) conn.close();
    if (tunnel) tunnel.close();
    conn = null; tunnel = null;
    mode = 'home'; code = null; writeToken = null; role = null; files = []; sel = 0; peers = 0;
    setStatus('left share');
  }

  function copyLink() {
    const link = location.origin + '/?share=' + code;
    try { navigator.clipboard && navigator.clipboard.writeText(link); setStatus('link copied'); }
    catch { setStatus(link); }
  }

  // ── handoffs ─────────────────────────────────────────────────────
  let bootHandled = false;
  function handleBoot() {
    if (bootHandled) return;
    bootHandled = true;
    let join = globalThis.__aciiShareJoin;
    if (!join) { try { join = new URLSearchParams(location.search).get('share'); } catch {} }
    const pushPath = globalThis.__aciiSharePath;
    globalThis.__aciiShareJoin = null;
    globalThis.__aciiSharePath = null;
    if (pushPath) createRoom(pushPath);
    else if (join) joinRoom(join);
  }

  // ── render ───────────────────────────────────────────────────────
  function render(ctx) {
    handleBoot();
    const C = ctx.theme.peek().colors;
    const W = ctx.width, H = ctx.height;
    if (W <= 0 || H <= 0) return;
    ctx.rect(0, 0, W, H, { ch: ' ', bg: C.bg, fg: C.fg });

    // Title bar.
    const title = mode === 'room' ? ` Share · ${code} ` : ' Share ';
    ctx.text(0, 0, title, { fg: C.accent, bold: true, bg: C.bg });
    if (mode === 'room') {
      const right = `${role === 'host' ? '⇡ source' : '⇣ local'} · ${peers} peer${peers === 1 ? '' : 's'}`;
      ctx.text(Math.max(title.length + 1, W - right.length), 0, right.slice(0, W), { fg: C.fgDim, bg: C.bg });
    }

    if (mode === 'home') renderHome(ctx, C, W, H);
    else renderRoom(ctx, C, W, H);

    // Status / prompt line.
    const y = H - 1;
    ctx.rect(0, y, W, 1, { ch: ' ', bg: C.bg, fg: C.fgDim });
    if (prompt) {
      const line = prompt.label + prompt.buf + '_';
      ctx.text(0, y, line.slice(0, W), { fg: C.warning, bg: C.bg });
    } else if (status) {
      ctx.text(0, y, status.slice(0, W), { fg: busy ? C.warning : C.fgDim, bg: C.bg });
    }
  }

  function renderHome(ctx, C, W, H) {
    let y = 2;
    const lines = [
      'Share text + small files between your devices.',
      'A code is the key — anyone with it can join.',
      '',
      '  [C]  Create a share  (you become the source)',
      '  [J]  Join a share by code',
      '',
      'Large files go peer-to-peer over the tunnel.',
    ];
    for (const l of lines) {
      const isAction = l.trim().startsWith('[');
      ctx.text(2, y++, l.slice(0, W - 2), { fg: isAction ? C.fg : C.fgDim, bg: C.bg });
    }
  }

  function renderRoom(ctx, C, W, H) {
    // Header: link + actions.
    ctx.text(2, 2, ('link: ' + location.origin + '/?share=' + code).slice(0, W - 2), { fg: C.link, bg: C.bg });
    const actions = writeToken
      ? '[P]ush  [S]ave all  [O]pen  [Y] copy link  [Del] remove  [L]eave'
      : '[S]ave all  [O]pen  [Y] copy link  [L]eave  (read-only)';
    ctx.text(2, 3, actions.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });

    // File list.
    const top = 5;
    const listH = Math.max(1, H - top - 1);
    ctx.text(2, top - 1, `files (${files.length}):`.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });
    if (files.length === 0) {
      ctx.text(2, top, '(empty — push a file or wait for the source)'.slice(0, W - 2), { fg: C.fgDim, bg: C.bg });
      return;
    }
    let start = 0;
    if (sel >= listH) start = sel - listH + 1;
    for (let i = 0; i < listH; i++) {
      const idx = start + i;
      if (idx >= files.length) break;
      const f = files[idx];
      const on = idx === sel;
      const size = fmtBytes(f.size).padStart(7);
      const row = ` ${f.path}`;
      const yy = top + i;
      if (on) ctx.rect(0, yy, W, 1, { ch: ' ', bg: C.accent, fg: C.bg });
      ctx.text(0, yy, row.slice(0, W - 8), { fg: on ? C.bg : C.fg, bg: on ? C.accent : C.bg });
      ctx.text(W - 8, yy, size, { fg: on ? C.bg : C.fgDim, bg: on ? C.accent : C.bg });
    }
  }

  // ── input ────────────────────────────────────────────────────────
  function commitPrompt() {
    const p = prompt; prompt = null;
    if (!p) return;
    const v = p.buf.trim();
    if (!v) return;
    if (p.kind === 'join') joinRoom(v);
    else if (p.kind === 'push') doPush(v[0] === '/' ? v : '/' + v);
  }

  function onKey(e) {
    if (e.type !== 'down') return;
    const k = e.key;

    if (prompt) {
      if (k === 'Enter') { commitPrompt(); return; }
      if (k === 'Escape') { prompt = null; return; }
      if (k === 'Backspace') { prompt.buf = prompt.buf.slice(0, -1); return; }
      if (!e.ctrl && !e.meta && typeof k === 'string' && k.length === 1) prompt.buf += k;
      return;
    }

    if (mode === 'home') {
      if (e.code === 'KeyC') { createRoom(); return; }
      if (e.code === 'KeyJ') { prompt = { kind: 'join', label: 'join code: ', buf: '' }; return; }
      return;
    }

    // room mode
    if (k === 'ArrowUp') { if (sel > 0) sel--; return; }
    if (k === 'ArrowDown') { if (sel < files.length - 1) sel++; return; }
    if (e.code === 'KeyP') { if (writeToken) prompt = { kind: 'push', label: 'push path: /', buf: '' }; else setStatus('read-only: only the source can push'); return; }
    if (e.code === 'KeyS') { pullAll(); return; }
    if (e.code === 'KeyO') { openSelected(); return; }
    if (e.code === 'KeyY') { copyLink(); return; }
    if (e.code === 'KeyL') { leave(); return; }
    if (k === 'Delete' || k === 'Backspace') { delSelected(); return; }
  }

  function onMouse(e) {
    if (e.type !== 'click' && e.type !== 'dblclick') return;
    if (mode !== 'room') return;
    const top = 5;
    const idx = e.y - top;
    if (idx >= 0 && idx < files.length) {
      sel = idx;
      if (e.type === 'dblclick') openSelected();
    }
  }

  function onTouch(e) {
    if (e.type === 'tap') onMouse({ type: 'click', x: e.x, y: e.y });
    else if (e.type === 'doubletap') onMouse({ type: 'dblclick', x: e.x, y: e.y });
  }

  function destroy() {
    if (conn) conn.close();
    if (tunnel) tunnel.close();
  }

  return { render, onKey, onMouse, onTouch, destroy };
}
