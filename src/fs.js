// Virtual filesystem for acii_os.
// In-memory tree persisted to localStorage, with optional File System Access mounts.
//
// Paths: UNIX-style, leading slash, no trailing slash (except root '/').
// Storage: { type:'file'|'dir', content?: string|base64, mtime: number }
//
// Binary detection by MIME (by extension). Binary content stored as 'base64:' prefix.

import { signal } from './signals.js';

const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'acii', 'html', 'htm', 'css', 'js', 'mjs', 'ts',
  'xml', 'svg', 'csv', 'tsv', 'yaml', 'yml', 'log', 'sh', 'py', 'rs',
  'go', 'c', 'h', 'cpp', 'java', 'rb', 'lua', 'toml', 'ini', 'conf'
]);

function isTextPath(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return true;
  const ext = path.slice(i + 1).toLowerCase();
  return TEXT_EXT.has(ext);
}

function normalize(path) {
  if (!path || path === '/') return '/';
  if (path[0] !== '/') path = '/' + path;
  // collapse // and remove trailing /
  path = path.replace(/\/+/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function parentOf(path) {
  path = normalize(path);
  if (path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i === 0 ? '/' : path.slice(0, i);
}

function basename(path) {
  path = normalize(path);
  if (path === '/') return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinPath(a, b) {
  if (!b) return normalize(a);
  if (b[0] === '/') return normalize(b);
  return normalize(a + '/' + b);
}

// --- base64 helpers for binary persistence ---
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const README_MD = `# acii_os

A tiny ASCII engine and shell that runs in the browser.

- Vanilla JS, zero dependencies, ES modules only.
- Built-in window manager, virtual filesystem, and theming.
- Apps live under /apps and follow a small contract.

Type \`help\` in the shell to see available commands.
Try \`ls /\` or \`cat /docs/CHANGELOG.md\`.
`;

const CHANGELOG_MD = `# Changelog

- Added virtual filesystem with localStorage persistence.
- Added optional File System Access API mounts.
- Added file drop, drag-over, and context-menu events to the engine.
- Window manager: focus, drag, resize, z-order.
- Themes: dark, light, mono, amber, c64, gameboy.
- Paint app writes to /desktop.
`;

export function createFS(opts = {}) {
  const storageKey = opts.storageKey || 'acii.fs.v1';
  const changes = signal(0);
  const subs = new Map(); // path -> Set<fn>
  const mounts = new Map(); // mountPath -> { handle, mode }

  // The store: Map<path, {type:'file'|'dir', content?:string, mtime:number, binary?:boolean}>
  const store = new Map();
  store.set('/', { type: 'dir', mtime: Date.now() });

  // --- persistence ---
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const obj = {};
        for (const [p, node] of store) {
          if (p === '/') continue;
          obj[p] = {
            t: node.type === 'dir' ? 'd' : 'f',
            m: node.mtime,
            c: node.type === 'file' ? node.content : undefined,
            b: node.binary ? 1 : undefined,
          };
        }
        localStorage.setItem(storageKey, JSON.stringify(obj));
      } catch (_) { /* quota / private mode */ }
    }, 200);
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(storageKey); } catch (_) {}
    if (!raw) {
      seed();
      scheduleSave();
      return;
    }
    try {
      const obj = JSON.parse(raw);
      for (const p of Object.keys(obj)) {
        const n = obj[p];
        if (n.t === 'd') {
          store.set(p, { type: 'dir', mtime: n.m || Date.now() });
        } else {
          store.set(p, {
            type: 'file',
            mtime: n.m || Date.now(),
            content: n.c == null ? '' : n.c,
            binary: !!n.b,
          });
        }
      }
      // ensure required dirs always exist
      ensureDir('/apps');
      ensureDir('/desktop');
      ensureDir('/docs');
      ensureDir('/games');
    } catch (_) {
      seed();
      scheduleSave();
    }
  }

  function seed() {
    ensureDir('/apps');
    ensureDir('/desktop');
    ensureDir('/docs');
    ensureDir('/games');
    store.set('/docs/README.md', { type: 'file', content: README_MD, mtime: Date.now() });
    store.set('/docs/CHANGELOG.md', { type: 'file', content: CHANGELOG_MD, mtime: Date.now() });
  }

  function ensureDir(path) {
    path = normalize(path);
    if (path === '/') return;
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      if (!store.has(cur)) {
        store.set(cur, { type: 'dir', mtime: Date.now() });
      }
    }
  }

  // --- mount routing ---
  function findMount(path) {
    path = normalize(path);
    let best = null;
    for (const mp of mounts.keys()) {
      if (path === mp || path.startsWith(mp + '/')) {
        if (!best || mp.length > best.length) best = mp;
      }
    }
    if (!best) return null;
    return { mountPath: best, rest: path === best ? '' : path.slice(best.length + 1) };
  }

  // --- notification ---
  function notify(path) {
    changes.value = changes.value + 1;
    // Walk up: any subscriber whose path is this or an ancestor should fire.
    const norm = normalize(path);
    for (const [subPath, set] of subs) {
      if (norm === subPath || norm.startsWith(subPath === '/' ? '/' : subPath + '/')) {
        for (const fn of set) {
          try { fn(norm); } catch (_) {}
        }
      }
    }
  }

  // --- core API (in-memory) ---
  function exists(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountExists(m);
    return path === '/' || store.has(path);
  }

  function stat(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountStat(m);
    if (path === '/') return { type: 'dir', size: 0, mtime: 0 };
    const node = store.get(path);
    if (!node) return null;
    return {
      type: node.type,
      size: node.type === 'file' ? sizeOf(node) : 0,
      mtime: node.mtime,
    };
  }

  function sizeOf(node) {
    if (node.type !== 'file') return 0;
    if (node.binary) {
      // base64 length -> byte length approximation
      const s = node.content || '';
      const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
      return Math.floor(s.length * 3 / 4) - pad;
    }
    return (node.content || '').length;
  }

  function list(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m && m.rest !== '') return mountList(m);
    // Gather direct children of path from in-memory store.
    const prefix = path === '/' ? '/' : path + '/';
    const out = [];
    const seen = new Set();
    for (const [p, node] of store) {
      if (p === '/') continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (seen.has(name)) continue;
      seen.add(name);
      const childPath = prefix + name;
      const childNode = store.get(childPath);
      if (childNode) {
        out.push({
          name,
          type: childNode.type,
          size: childNode.type === 'file' ? sizeOf(childNode) : 0,
          mtime: childNode.mtime,
        });
      } else {
        // implicit dir
        out.push({ name, type: 'dir', size: 0, mtime: 0 });
      }
    }
    // If this path is a mount root, also include mount contents via async-shim entries.
    if (m && m.rest === '') {
      // synchronous list returns just what we know; consumer can call list again after refresh.
    }
    // Also include mount points whose parent is this path.
    for (const mp of mounts.keys()) {
      const par = parentOf(mp);
      if (par === path) {
        const name = basename(mp);
        if (!seen.has(name)) {
          seen.add(name);
          out.push({ name, type: 'dir', size: 0, mtime: 0, mount: true });
        }
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function read(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountRead(m, 'auto');
    const node = store.get(path);
    if (!node || node.type !== 'file') throw new Error('Not a file: ' + path);
    if (node.binary) return base64ToBytes(node.content || '').buffer;
    return node.content || '';
  }

  function readText(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountRead(m, 'text');
    const node = store.get(path);
    if (!node || node.type !== 'file') throw new Error('Not a file: ' + path);
    if (node.binary) {
      const bytes = base64ToBytes(node.content || '');
      try { return new TextDecoder().decode(bytes); } catch (_) { return ''; }
    }
    return node.content || '';
  }

  function readBytes(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountRead(m, 'bytes');
    const node = store.get(path);
    if (!node || node.type !== 'file') throw new Error('Not a file: ' + path);
    if (node.binary) return base64ToBytes(node.content || '').buffer;
    return new TextEncoder().encode(node.content || '').buffer;
  }

  function write(path, data) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountWrite(m, data);
    if (path === '/') throw new Error('Cannot write to root');
    ensureDir(parentOf(path));
    const existing = store.get(path);
    if (existing && existing.type === 'dir') throw new Error('Is a directory: ' + path);

    let content, binary;
    const bytes = toUint8(data);
    if (typeof data === 'string') {
      content = data;
      binary = !isTextPath(path);
      if (binary) {
        // string for binary path: encode as utf-8 then base64
        content = bytesToBase64(new TextEncoder().encode(data));
      }
    } else if (bytes) {
      // bytes input
      if (isTextPath(path)) {
        try { content = new TextDecoder().decode(bytes); binary = false; }
        catch (_) { content = bytesToBase64(bytes); binary = true; }
      } else {
        content = bytesToBase64(bytes);
        binary = true;
      }
    } else {
      throw new Error('Unsupported data type for write');
    }

    store.set(path, { type: 'file', content, binary, mtime: Date.now() });
    scheduleSave();
    notify(path);
  }

  function del(path) {
    path = normalize(path);
    const m = findMount(path);
    if (m) return mountDelete(m);
    if (path === '/') throw new Error('Cannot delete root');
    const node = store.get(path);
    if (!node) throw new Error('No such path: ' + path);
    if (node.type === 'dir') {
      // must be empty
      const kids = list(path);
      if (kids.length > 0) throw new Error('Directory not empty: ' + path);
    }
    store.delete(path);
    scheduleSave();
    notify(path);
  }

  function mkdir(path) {
    path = normalize(path);
    if (path === '/') return;
    const m = findMount(path);
    if (m) return mountMkdir(m);
    const existing = store.get(path);
    if (existing) {
      if (existing.type !== 'dir') throw new Error('Not a directory: ' + path);
      return;
    }
    ensureDir(path);
    scheduleSave();
    notify(path);
  }

  function move(oldPath, newPath) {
    oldPath = normalize(oldPath);
    newPath = normalize(newPath);
    if (oldPath === '/' || newPath === '/') throw new Error('Cannot move root');
    if (findMount(oldPath) || findMount(newPath)) {
      throw new Error('Move across or within mounts not supported');
    }
    const node = store.get(oldPath);
    if (!node) throw new Error('No such path: ' + oldPath);
    if (store.has(newPath)) throw new Error('Destination exists: ' + newPath);
    ensureDir(parentOf(newPath));
    if (node.type === 'file') {
      store.delete(oldPath);
      store.set(newPath, { ...node, mtime: Date.now() });
    } else {
      // move dir and all descendants
      const prefix = oldPath + '/';
      const moves = [];
      for (const [p, n] of store) {
        if (p === oldPath || p.startsWith(prefix)) moves.push([p, n]);
      }
      for (const [p, n] of moves) {
        const np = newPath + p.slice(oldPath.length);
        store.delete(p);
        store.set(np, { ...n, mtime: Date.now() });
      }
    }
    scheduleSave();
    notify(oldPath);
    notify(newPath);
  }

  function copy(srcPath, dstPath) {
    srcPath = normalize(srcPath);
    dstPath = normalize(dstPath);
    if (findMount(srcPath) || findMount(dstPath)) {
      throw new Error('Copy across or within mounts not supported');
    }
    const node = store.get(srcPath);
    if (!node) throw new Error('No such path: ' + srcPath);
    ensureDir(parentOf(dstPath));
    if (node.type === 'file') {
      store.set(dstPath, { ...node, mtime: Date.now() });
    } else {
      const prefix = srcPath + '/';
      store.set(dstPath, { type: 'dir', mtime: Date.now() });
      for (const [p, n] of [...store]) {
        if (p.startsWith(prefix)) {
          const np = dstPath + p.slice(srcPath.length);
          store.set(np, { ...n, mtime: Date.now() });
        }
      }
    }
    scheduleSave();
    notify(dstPath);
  }

  function tree() {
    function buildNode(path) {
      const name = path === '/' ? '' : basename(path);
      const node = path === '/' ? { type: 'dir' } : store.get(path);
      if (!node) return { name, type: 'dir', children: [] };
      if (node.type === 'file') {
        return { name, type: 'file', size: sizeOf(node), mtime: node.mtime };
      }
      const kids = list(path).map(entry => {
        const child = joinPath(path, entry.name);
        return buildNode(child);
      });
      return { name, type: 'dir', children: kids };
    }
    return buildNode('/');
  }

  function subscribe(path, fn) {
    path = normalize(path);
    let set = subs.get(path);
    if (!set) { set = new Set(); subs.set(path, set); }
    set.add(fn);
    return () => {
      const s = subs.get(path);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) subs.delete(path);
    };
  }

  // --- File System Access API mounts ---
  function canMountLocal() {
    return typeof window !== 'undefined'
      && typeof window.showDirectoryPicker === 'function';
  }

  async function mountLocal({ at, mode = 'readwrite' } = {}) {
    if (!canMountLocal()) throw new Error('File System Access API unavailable');
    if (!at) throw new Error('mountLocal: { at } required');
    const mountPath = normalize(at);
    if (mountPath === '/') throw new Error('Cannot mount at root');
    const handle = await window.showDirectoryPicker({ mode });
    if (handle.queryPermission) {
      const perm = await handle.queryPermission({ mode });
      if (perm !== 'granted' && handle.requestPermission) {
        await handle.requestPermission({ mode });
      }
    }
    ensureDir(parentOf(mountPath));
    mounts.set(mountPath, { handle, mode });
    notify(mountPath);
    return { at: mountPath, name: handle.name, mode };
  }

  function unmount(mountPath) {
    mountPath = normalize(mountPath);
    if (!mounts.has(mountPath)) return false;
    mounts.delete(mountPath);
    notify(mountPath);
    return true;
  }

  // --- mount operation helpers (async-leaning but we offer best-effort sync where possible) ---
  // Since the public API is synchronous, mount file ops return promises for read/write.
  // exists/stat/list cache nothing — they walk handles on demand and may return promises.

  async function resolveHandle(mountPath, rest, { createDirs = false } = {}) {
    const mount = mounts.get(mountPath);
    if (!mount) throw new Error('No mount at ' + mountPath);
    let h = mount.handle;
    if (!rest) return { dir: h, name: null };
    const parts = rest.split('/');
    const fname = parts.pop();
    for (const p of parts) {
      h = await h.getDirectoryHandle(p, { create: createDirs });
    }
    return { dir: h, name: fname };
  }

  async function mountExists(m) {
    try {
      const { dir, name } = await resolveHandle(m.mountPath, m.rest);
      if (!name) return true;
      try { await dir.getFileHandle(name); return true; } catch (_) {}
      try { await dir.getDirectoryHandle(name); return true; } catch (_) {}
      return false;
    } catch (_) { return false; }
  }

  async function mountStat(m) {
    try {
      const { dir, name } = await resolveHandle(m.mountPath, m.rest);
      if (!name) return { type: 'dir', size: 0, mtime: 0, mount: true };
      try {
        const fh = await dir.getFileHandle(name);
        const f = await fh.getFile();
        return { type: 'file', size: f.size, mtime: f.lastModified, mount: true };
      } catch (_) {}
      try {
        await dir.getDirectoryHandle(name);
        return { type: 'dir', size: 0, mtime: 0, mount: true };
      } catch (_) {}
      return null;
    } catch (_) { return null; }
  }

  async function mountList(m) {
    const { dir, name } = await resolveHandle(m.mountPath, m.rest);
    let target = dir;
    if (name) target = await dir.getDirectoryHandle(name);
    const out = [];
    for await (const [n, h] of target.entries()) {
      if (h.kind === 'file') {
        try {
          const f = await h.getFile();
          out.push({ name: n, type: 'file', size: f.size, mtime: f.lastModified, mount: true });
        } catch (_) {
          out.push({ name: n, type: 'file', size: 0, mtime: 0, mount: true });
        }
      } else {
        out.push({ name: n, type: 'dir', size: 0, mtime: 0, mount: true });
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  async function mountRead(m, kind) {
    const { dir, name } = await resolveHandle(m.mountPath, m.rest);
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    if (kind === 'text') return await f.text();
    if (kind === 'bytes') return await f.arrayBuffer();
    // auto
    const fullPath = m.mountPath + (m.rest ? '/' + m.rest : '');
    if (isTextPath(fullPath)) return await f.text();
    return await f.arrayBuffer();
  }

  async function mountWrite(m, data) {
    const { dir, name } = await resolveHandle(m.mountPath, m.rest, { createDirs: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    if (typeof data === 'string') {
      await w.write(data);
    } else {
      const bytes = toUint8(data);
      if (bytes) await w.write(bytes);
      else throw new Error('Unsupported data type for mount write');
    }
    await w.close();
    notify(m.mountPath + (m.rest ? '/' + m.rest : ''));
  }

  async function mountDelete(m) {
    const { dir, name } = await resolveHandle(m.mountPath, m.rest);
    if (!name) throw new Error('Cannot delete mount root via fs.delete; use unmount');
    await dir.removeEntry(name, { recursive: false });
    notify(m.mountPath + '/' + m.rest);
  }

  async function mountMkdir(m) {
    const { dir, name } = await resolveHandle(m.mountPath, m.rest, { createDirs: true });
    if (name) await dir.getDirectoryHandle(name, { create: true });
    notify(m.mountPath + (m.rest ? '/' + m.rest : ''));
  }

  // initialize
  load();

  return {
    exists,
    stat,
    list,
    read,
    readText,
    readBytes,
    write,
    delete: del,
    mkdir,
    move,
    copy,
    tree,
    changes,
    subscribe,
    canMountLocal,
    mountLocal,
    unmount,
  };
}
