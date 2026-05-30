// System user + settings/preferences store for acii_os.
//
// Concept: everything lives on the virtual "disk". A single system user owns
// settings/preferences that persist across reloads via localStorage.
//
// Usage (shared singleton — use this exact line everywhere):
//   const user = globalThis.__aciiUser ||= createUser();
//
//   user.name.value                  // reactive display name (signal)
//   user.settings.get('foo', 0)      // generic key/value bag (any string key)
//   user.settings.set('foo', 42)
//   user.settings.all()              // { ...everything }
//   user.prefs.vimEnabled.value      // known prefs as individual signals
//   user.prefs.vimEnabled.value = true
//   user.get('quicklook')            // shorthand read of a known pref
//   user.set('quicklook', false)     // shorthand write of a known pref
//   user.subscribe(fn)               // fires whenever anything changes
//   user.changed.value               // bump counter signal (reactive)
//   user.reset()                     // restore all defaults
//
// Persists to localStorage key 'acii.user.v1'.

import { signal } from './signals.js';

const STORAGE_KEY = 'acii.user.v1';

// Known preferences with explicit defaults. New prefs added here get a default
// and are exposed as `user.prefs.<key>` signals automatically.
const PREF_DEFAULTS = {
  vimEnabled: false,
  leaderKey: ' ', // space
  theme: null,    // null = follow system / shell default
  quicklook: true,
};

const DEFAULT_NAME = 'guest';

function loadRaw() {
  try {
    const txt = localStorage.getItem(STORAGE_KEY);
    if (!txt) return null;
    const data = JSON.parse(txt);
    return (data && typeof data === 'object') ? data : null;
  } catch {
    return null;
  }
}

export function createUser() {
  const stored = loadRaw() || {};

  // --- name ---
  const name = signal(
    typeof stored.name === 'string' && stored.name ? stored.name : DEFAULT_NAME
  );

  // --- known prefs as individual signals ---
  const storedPrefs = (stored.prefs && typeof stored.prefs === 'object')
    ? stored.prefs : {};
  const prefs = {};
  for (const key of Object.keys(PREF_DEFAULTS)) {
    const initial = (key in storedPrefs) ? storedPrefs[key] : PREF_DEFAULTS[key];
    prefs[key] = signal(initial);
  }

  // --- generic settings bag (arbitrary key/value) ---
  const settingsStore = (stored.settings && typeof stored.settings === 'object')
    ? { ...stored.settings } : {};

  // --- change notification ---
  // `changed` is a monotonically increasing counter; reading `.value` inside an
  // effect subscribes, so UIs can re-render on any user/pref/settings change.
  const changed = signal(0);
  const subscribers = new Set();

  let suppressPersist = false;

  function notify() {
    changed.value = changed.peek() + 1;
    for (const fn of [...subscribers]) {
      try { fn(); } catch { /* never let a bad subscriber break others */ }
    }
  }

  function persist() {
    if (suppressPersist) return;
    const prefsOut = {};
    for (const key of Object.keys(prefs)) prefsOut[key] = prefs[key].peek();
    const out = {
      name: name.peek(),
      prefs: prefsOut,
      settings: { ...settingsStore },
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* storage full / unavailable — keep running in-memory */ }
  }

  function persistAndNotify() {
    persist();
    notify();
  }

  // Persist + notify whenever a known pref or the name changes.
  name.subscribe(persistAndNotify);
  for (const key of Object.keys(prefs)) prefs[key].subscribe(persistAndNotify);

  // --- generic settings API ---
  const settings = {
    get(key, fallback = undefined) {
      return (key in settingsStore) ? settingsStore[key] : fallback;
    },
    set(key, value) {
      if (settingsStore[key] === value) return value;
      settingsStore[key] = value;
      persistAndNotify();
      return value;
    },
    has(key) {
      return key in settingsStore;
    },
    remove(key) {
      if (!(key in settingsStore)) return false;
      delete settingsStore[key];
      persistAndNotify();
      return true;
    },
    all() {
      return { ...settingsStore };
    },
    keys() {
      return Object.keys(settingsStore);
    },
  };

  // --- known-pref shorthands ---
  function get(key) {
    if (!(key in prefs)) {
      throw new Error(`unknown pref: ${key}`);
    }
    return prefs[key].peek();
  }
  function set(key, value) {
    if (!(key in prefs)) {
      throw new Error(`unknown pref: ${key}`);
    }
    prefs[key].value = value; // triggers persist + notify via subscribe
    return value;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function reset() {
    suppressPersist = true;
    try {
      name.value = DEFAULT_NAME;
      for (const key of Object.keys(PREF_DEFAULTS)) {
        prefs[key].value = PREF_DEFAULTS[key];
      }
      for (const key of Object.keys(settingsStore)) delete settingsStore[key];
    } finally {
      suppressPersist = false;
    }
    persistAndNotify();
  }

  return {
    name,
    prefs,
    settings,
    changed,
    get,
    set,
    subscribe,
    reset,
    // expose the defaults so UIs can label/iterate known prefs
    prefDefaults: { ...PREF_DEFAULTS },
  };
}

// Shared singleton.
const user = globalThis.__aciiUser ||= createUser();
export default user;
