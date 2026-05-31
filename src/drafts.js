// Draft / auto-backup store for FakanOS.
//
// Keeps the LAST unsaved edit per file path so a reopen (after reload or crash)
// can restore in-progress text. Backed by localStorage under its own key, with
// debounced writes so frequent keystrokes don't thrash storage.
//
// Storage shape (JSON): { [path]: { text: string, savedAt: number } }
//   - savedAt is the browser wall-clock time (Date.now()) at save.
//
// Robust to JSON parse errors / corruption: the store resets to empty rather
// than throwing.
//
// API:
//   createDrafts(opts?) -> {
//     save(path, text),          // record/overwrite the draft for path (debounced flush)
//     load(path) -> string|null, // last saved text, or null if none
//     clear(path),               // drop the draft for path (e.g. after a real save)
//     has(path) -> boolean,
//     list() -> [{ path, savedAt, length }],
//     flush(),                   // force-write pending changes now
//   }
//
// Shared singleton (use this exact line wherever drafts are needed):
//   const drafts = globalThis.__aciiDrafts ||= createDrafts();

export function createDrafts(opts = {}) {
  const storageKey = opts.storageKey || 'acii.drafts.v1';
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 400;

  // In-memory mirror: path -> { text, savedAt }
  let store = Object.create(null);

  // --- load (robust to corruption) ---
  (function load() {
    let raw = null;
    try { raw = localStorage.getItem(storageKey); } catch (_) { /* private mode */ }
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const p of Object.keys(obj)) {
          const n = obj[p];
          if (n && typeof n.text === 'string') {
            store[p] = {
              text: n.text,
              savedAt: typeof n.savedAt === 'number' ? n.savedAt : Date.now(),
            };
          }
        }
      }
    } catch (_) {
      // corrupted blob -> reset to empty and overwrite on next flush
      store = Object.create(null);
      try { localStorage.removeItem(storageKey); } catch (_) {}
    }
  })();

  // --- debounced persistence ---
  let saveTimer = null;
  function persistNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      localStorage.setItem(storageKey, JSON.stringify(store));
    } catch (_) { /* quota / private mode — keep the in-memory copy */ }
  }
  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, debounceMs);
  }

  function save(path, text) {
    if (!path) return;
    store[path] = { text: text == null ? '' : String(text), savedAt: Date.now() };
    schedulePersist();
  }

  function load_(path) {
    const n = store[path];
    return n ? n.text : null;
  }

  function clear(path) {
    if (!path || !(path in store)) return;
    delete store[path];
    schedulePersist();
  }

  function has(path) {
    return path != null && path in store;
  }

  function list() {
    const out = [];
    for (const path of Object.keys(store)) {
      const n = store[path];
      out.push({ path, savedAt: n.savedAt, length: n.text.length });
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  }

  function flush() {
    persistNow();
  }

  // Best-effort flush of pending writes when the tab goes away.
  if (typeof addEventListener === 'function') {
    try {
      addEventListener('beforeunload', () => { if (saveTimer) persistNow(); });
      addEventListener('pagehide', () => { if (saveTimer) persistNow(); });
    } catch (_) {}
  }

  return { save, load: load_, clear, has, list, flush };
}
