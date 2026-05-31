// share.js — client for the Durable-Object file share (local→DO→locals).
//
// A "share" is a room addressed by an unguessable code. The source local pushes
// small files (text + small images/audio) into the room's Durable Object; other
// locals join with the code, pull the manifest, and stream files into their own
// virtual FS. A WebSocket carries live add/update/delete events AND relays
// WebRTC signaling so peers can open a direct data-channel "tunnel" for files
// too big to keep in the DO.
//
// Pure module: no engine/DOM. It talks to the shared `fs` singleton (passed in),
// the worker's /api/share/* routes, and the browser's WebSocket / RTCPeerConnection.
// Server-side limits live in worker/index.js (SHARE_MAX_FILE / SHARE_MAX_TOTAL).

// Files at or below this go through the DO; above it the caller should fall back
// to the peer-to-peer tunnel. Mirror of SHARE_MAX_FILE in the worker.
export const SHARE_MAX_FILE = 256 * 1024;

import { isSafeRel } from './pathsafe.js';

// Minimal extension→MIME map (the worker only needs text-ness; this keeps the
// stored content-type meaningful for getFile + Media House rendering).
const MIME = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  html: 'text/html', htm: 'text/html', xml: 'text/xml', svg: 'image/svg+xml',
  csv: 'text/csv', acii: 'text/plain', log: 'text/plain', sh: 'text/x-sh',
  py: 'text/x-python', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
};
function mimeFor(path) {
  const i = path.lastIndexOf('.');
  const ext = i < 0 ? '' : path.slice(i + 1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
function isTextMime(mime) {
  return mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('svg');
}
function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
function parentOf(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function joinPath(a, b) { return (a === '/' ? '' : a) + '/' + b; }

export function createShareClient({ fs, apiBase = '/api/share' } = {}) {
  if (!fs) throw new Error('createShareClient: { fs } required');

  function wsUrl(code) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${apiBase}/${code}/ws`;
  }
  function fileUrl(code, path) {
    return `${apiBase}/${code}/file?path=${encodeURIComponent(path)}`;
  }

  // Mint a fresh room. Returns { code, token } — the code is the read/join
  // capability (goes in the share link), the token is the per-room WRITE secret
  // the source keeps private and passes to push/delete. A joiner only has the
  // code, so they're read-only.
  async function createRoom() {
    const res = await fetch(apiBase + '/new', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.code) throw new Error((data && data.error) || 'could not create share');
    return { code: data.code, token: data.token || '' };
  }

  async function getManifest(code) {
    const res = await fetch(`${apiBase}/${code}/manifest`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data; // { files, total, created, peers }
  }

  // Walk a FS path into a flat list of { src, rel } where rel is relative to the
  // parent of `root` (so a shared folder reconstructs as a subtree on the peer).
  function collectFiles(root) {
    const base = parentOf(root);
    const out = [];
    (function walk(p) {
      const st = fs.stat(p);
      if (!st) return;
      if (st.type === 'file') {
        out.push({ src: p, rel: p.slice(base === '/' ? 1 : base.length + 1) });
      } else {
        for (const e of fs.list(p)) walk(joinPath(p, e.name));
      }
    })(root);
    return out;
  }

  // Push one FS file into the room (needs the room's write `token`). Returns the
  // file meta, or throws (incl. 413 'too large' so the caller can route it
  // through the tunnel instead).
  async function pushFile(code, src, rel = basename(src), token = '') {
    const mime = mimeFor(src);
    const bytes = await fs.readBytesAsync(src);          // ArrayBuffer
    if (bytes.byteLength > SHARE_MAX_FILE) {
      const err = new Error('file too large for share');
      err.tooLarge = true; err.size = bytes.byteLength; err.src = src;
      throw err;
    }
    const st = fs.stat(src) || {};
    const res = await fetch(fileUrl(code, rel), {
      method: 'PUT',
      headers: { 'content-type': mime, 'x-mtime': String(st.mtime || Date.now()), 'x-share-token': token },
      body: bytes,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.tooLarge = res.status === 413; err.src = src;
      throw err;
    }
    return data.file;
  }

  // Push a path (file or folder). Returns { pushed:[...], tooLarge:[...] } so the
  // UI can report which files need the tunnel.
  async function pushPath(code, root, token = '') {
    const files = collectFiles(root);
    const pushed = [], tooLarge = [];
    for (const f of files) {
      try { pushed.push(await pushFile(code, f.src, f.rel, token)); }
      catch (e) { if (e.tooLarge) tooLarge.push({ src: f.src, rel: f.rel, size: e.size }); else throw e; }
    }
    return { pushed, tooLarge };
  }

  // Pull one room file into the FS under destDir (preserving its relative path).
  async function pullFile(code, file, destDir) {
    // The manifest comes from a peer — never let a crafted path escape destDir.
    if (!isSafeRel(file.path)) throw new Error('unsafe path in manifest: ' + file.path);
    const res = await fetch(fileUrl(code, file.path));
    if (!res.ok) throw new Error('pull failed: HTTP ' + res.status);
    const dest = joinPath(destDir, file.path);
    const ct = res.headers.get('content-type') || file.mime || '';
    if (isTextMime(ct)) fs.write(dest, await res.text());
    else fs.write(dest, new Uint8Array(await res.arrayBuffer()));
    return dest;
  }

  async function pullAll(code, destDir) {
    const { files } = await getManifest(code);
    const out = [];
    for (const f of files) out.push(await pullFile(code, f, destDir));
    return out;
  }

  async function deleteFile(code, path, token = '') {
    const res = await fetch(fileUrl(code, path), { method: 'DELETE', headers: { 'x-share-token': token } });
    if (!res.ok) throw new Error('delete failed: HTTP ' + res.status);
  }

  // Open the live WebSocket. `handlers` may include onEvent({type,...}),
  // onHello({peerId,peers}), onPeer(joined|left), onSignal({from,signal}),
  // onOpen, onClose. Returns a connection handle with peerId + signaling send.
  function connect(code, handlers = {}) {
    let ws = null, peerId = null, closed = false;
    const peers = new Set();

    function open() {
      ws = new WebSocket(wsUrl(code));
      ws.onopen = () => handlers.onOpen && handlers.onOpen();
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'hello') {
          peerId = m.peerId;
          (m.peers || []).forEach((p) => peers.add(p));
          handlers.onHello && handlers.onHello(m);
        } else if (m.type === 'peer-join') {
          peers.add(m.peerId); handlers.onPeer && handlers.onPeer('join', m.peerId);
        } else if (m.type === 'peer-leave') {
          peers.delete(m.peerId); handlers.onPeer && handlers.onPeer('leave', m.peerId);
        } else if (m.type === 'signal') {
          handlers.onSignal && handlers.onSignal(m);
        } else if (m.type === 'added' || m.type === 'updated' || m.type === 'deleted') {
          handlers.onEvent && handlers.onEvent(m);
        }
      };
      ws.onclose = () => {
        handlers.onClose && handlers.onClose();
        if (!closed) setTimeout(open, 1500); // auto-reconnect until close()
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    open();

    return {
      get peerId() { return peerId; },
      peers: () => [...peers],
      // Relay a WebRTC signaling payload to a specific peer via the DO.
      signal(to, signal) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'signal', to, signal }));
      },
      close() { closed = true; try { ws && ws.close(); } catch {} },
    };
  }

  return {
    createRoom, getManifest, collectFiles,
    pushFile, pushPath, pullFile, pullAll, deleteFile,
    connect, fileUrl, SHARE_MAX_FILE,
  };
}

// ── WebRTC tunnel (large files, peer-to-peer) ───────────────────────
// The DO only *signals*; bytes flow directly between locals over a data
// channel. `conn` is the handle returned by createShareClient().connect(): we
// use its .signal(to, …) to send offers/answers/ICE and feed conn.onSignal back
// in via tunnel.handleSignal(). onFile({ name, mime, bytes }) fires on receipt.
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const CHUNK = 16 * 1024;

export function createTunnel(conn, { onFile, onProgress } = {}) {
  const peers = new Map(); // peerId -> { pc, dc, incoming }

  function makePeer(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const rec = { pc, dc: null, incoming: null };
    peers.set(peerId, rec);

    pc.onicecandidate = (e) => { if (e.candidate) conn.signal(peerId, { ice: e.candidate }); };
    pc.ondatachannel = (e) => wireChannel(rec, peerId, e.channel);

    if (initiator) {
      const dc = pc.createDataChannel('file');
      wireChannel(rec, peerId, dc);
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => conn.signal(peerId, { sdp: pc.localDescription }));
    }
    return rec;
  }

  // Framing: a JSON header message {name,mime,size} then `size` bytes of binary
  // chunks, reassembled on the far side.
  function wireChannel(rec, peerId, dc) {
    rec.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const h = JSON.parse(e.data);
        if (h.t === 'head') rec.incoming = { name: h.name, mime: h.mime, size: h.size, parts: [], got: 0 };
        return;
      }
      const inc = rec.incoming;
      if (!inc) return;
      inc.parts.push(e.data); inc.got += e.data.byteLength;
      onProgress && onProgress({ peerId, name: inc.name, got: inc.got, size: inc.size });
      if (inc.got >= inc.size) {
        const blob = new Blob(inc.parts, { type: inc.mime });
        blob.arrayBuffer().then((buf) => onFile && onFile({ name: inc.name, mime: inc.mime, bytes: buf, from: peerId }));
        rec.incoming = null;
      }
    };
  }

  async function handleSignal({ from, signal }) {
    let rec = peers.get(from);
    if (signal.sdp) {
      if (!rec) rec = makePeer(from, false);
      await rec.pc.setRemoteDescription(signal.sdp);
      if (signal.sdp.type === 'offer') {
        const ans = await rec.pc.createAnswer();
        await rec.pc.setLocalDescription(ans);
        conn.signal(from, { sdp: rec.pc.localDescription });
      }
    } else if (signal.ice && rec) {
      try { await rec.pc.addIceCandidate(signal.ice); } catch {}
    }
  }

  // Send a file ({ name, mime, bytes:ArrayBuffer }) to a peer over the channel,
  // opening the connection (as initiator) if needed.
  async function sendFile(peerId, file) {
    let rec = peers.get(peerId);
    if (!rec) rec = makePeer(peerId, true);
    const dc = await waitChannel(rec);
    dc.send(JSON.stringify({ t: 'head', name: file.name, mime: file.mime, size: file.bytes.byteLength }));
    const bytes = new Uint8Array(file.bytes);
    for (let off = 0; off < bytes.length; off += CHUNK) {
      // Respect backpressure so we don't blow the send buffer on big files.
      while (dc.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20));
      dc.send(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
    }
  }

  function waitChannel(rec) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        if (rec.dc && rec.dc.readyState === 'open') return resolve(rec.dc);
        if (Date.now() - t0 > 20000) return reject(new Error('tunnel timed out'));
        setTimeout(check, 50);
      })();
    });
  }

  function close() {
    for (const { pc } of peers.values()) { try { pc.close(); } catch {} }
    peers.clear();
  }

  return { handleSignal, sendFile, close };
}
