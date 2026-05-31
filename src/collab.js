// collab.js — client for the collaborative desktop (shared room + presence).
//
// A "room" is one owner's desktop, keyed by the owner's user id. People are
// added by email invite (a magic link carrying the room — see worker
// /api/collab/invite + the auth verify flow). Once in, every member opens a
// presence WebSocket so the shell can show who's here and their live cursors.
//
// Pure module: no engine/DOM. fetch + WebSocket only. The shell owns rendering;
// it reads roster()/onCursor and calls sendCursor() as the local pointer moves.

export function createCollabClient({ apiBase = '/api/collab' } = {}) {
  // Owner invites an email into their own room. `token` is the caller's session
  // token (Bearer). Resolves on accepted; throws with the server message.
  async function invite(token, { email, nick = '', rights = 'write' } = {}) {
    const res = await fetch(apiBase + '/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ email: String(email || '').trim().toLowerCase(), nick, rights }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  async function members(room, token) {
    const res = await fetch(`${apiBase}/${room}/members?t=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data; // { owner, members:[{userId,nick,role,rights}] }
  }

  // ── Shared desktop FS (two-way) ─────────────────────────────────
  function fsFileUrl(room, token, path) {
    return `${apiBase}/${room}/fs/file?t=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
  }
  async function fsManifest(room, token) {
    const res = await fetch(`${apiBase}/${room}/fs/manifest?t=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data; // { files:[{path,name,mime,size,mtime,hash}] }
  }
  async function fsPull(room, token, path) {
    const res = await fetch(fsFileUrl(room, token, path));
    if (!res.ok) throw new Error('pull failed: HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    return { mime: ct, bytes: await res.arrayBuffer() };
  }
  async function fsPush(room, token, path, bytes, { mime = 'application/octet-stream', mtime = Date.now(), hash = '' } = {}) {
    const res = await fetch(fsFileUrl(room, token, path), {
      method: 'PUT',
      headers: { 'content-type': mime, 'x-mtime': String(mtime), 'x-hash': String(hash) },
      body: bytes,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data.file;
  }
  async function fsDelete(room, token, path) {
    const res = await fetch(fsFileUrl(room, token, path), { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed: HTTP ' + res.status);
  }

  // Open the presence socket. handlers: onHello({you,roster}), onRoster(roster),
  // onCursor({userId,nick,role,x,y}), onOpen, onClose. Returns a live handle.
  function connect(room, token, handlers = {}) {
    let ws = null, closed = false;
    let me = null;
    let roster = [];

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${apiBase}/${room}/ws?t=${encodeURIComponent(token)}`);
      ws.onopen = () => handlers.onOpen && handlers.onOpen();
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'hello') {
          me = m.you; roster = m.roster || [];
          handlers.onHello && handlers.onHello(m);
        } else if (m.type === 'roster') {
          roster = m.roster || [];
          handlers.onRoster && handlers.onRoster(roster);
        } else if (m.type === 'cursor') {
          // Keep our roster cache's cursor fresh too, so a late render sees it.
          const r = roster.find((p) => p.userId === m.userId);
          if (r) { r.x = m.x; r.y = m.y; }
          handlers.onCursor && handlers.onCursor(m);
        } else if (m.type === 'fs') {
          handlers.onFs && handlers.onFs(m); // { op:'added'|'updated'|'deleted', file?, path? }
        }
      };
      ws.onclose = () => {
        handlers.onClose && handlers.onClose();
        if (!closed) setTimeout(open, 1500); // auto-reconnect
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    open();

    // Throttle cursor sends to ~20/s — the grid is coarse, no need for more.
    let lastSent = 0, lastX = -1, lastY = -1;
    function sendCursor(x, y) {
      if (!ws || ws.readyState !== 1) return;
      const now = Date.now();
      if (x === lastX && y === lastY) return;
      if (now - lastSent < 50) return;
      lastSent = now; lastX = x; lastY = y;
      try { ws.send(JSON.stringify({ type: 'cursor', x, y })); } catch {}
    }

    return {
      get me() { return me; },
      roster: () => roster,
      sendCursor,
      close() { closed = true; try { ws && ws.close(); } catch {} },
    };
  }

  return { invite, members, connect, fsManifest, fsPull, fsPush, fsDelete, fsFileUrl };
}
