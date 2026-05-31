// FakanOS keymap — a global prefix-key (leader) scheme + Quick-Look helpers.
//
// One consistent way to bind system-level shortcuts so they don't collide with
// per-app keys:
//   - Direct combos:  Cmd/Ctrl + <key>   (macOS / Windows convention)
//   - Leader sequence: press the leader once, then a key (vim-style chord).
//
// Plus a Quick-Look-style behaviour: pressing Space while a file is selected on
// the desktop (and no text editor is focused) opens a preview intent.
//
// This module is PURE LOGIC. It owns no engine/DOM state and produces no side
// effects. `route()` inspects a key event + a context snapshot and returns an
// "intent" object (`{ id, label, action }`) for the shell to execute, or null.
//
// Public API:
//   const km = createKeymap({ user })
//   km.register(id, { keys, when, run, label })   // add / override a binding
//   km.unregister(id)
//   km.route(keyEvent, ctx) -> intent | null      // call from shell.onKey
//   km.leaderActive()                             // is a leader sequence open?
//   km.cancelLeader()                             // abort a pending leader
//   km.bindings()                                 // [{ id, keys, label, … }]
//   km.describe()                                 // human-readable cheat-sheet
//   keyIs(e, code, mods?)                         // layout-robust matcher
//
// Bindings are DATA. `keys` is a spec string (or array of alternatives):
//   "mod+w"        Cmd (mac) or Ctrl (win/linux) + W
//   "ctrl+w"       Ctrl + W exactly
//   "meta+w"       Cmd / Win key + W
//   "alt+tab"      Alt + Tab
//   "shift+mod+s"  Cmd/Ctrl + Shift + S
//   "leader n"     leader, then N
//   "leader g f"   leader, then G, then F (multi-key chord)
//   "space"        bare Space (used with a `when` guard)
//
// `when(ctx)` is an optional predicate gating the binding for the current
// context. `run(ctx)` is optional and returns extra payload merged into the
// intent (e.g. the file path to preview). `label` is for the cheat-sheet.

import { signal } from './signals.js';

// ── Platform detection ─────────────────────────────────────────────
// "mod" maps to Cmd on macOS, Ctrl elsewhere. Detected once; overridable.
function detectMac() {
  try {
    const p = (globalThis.navigator?.platform || '') + ' ' +
              (globalThis.navigator?.userAgent || '');
    return /mac|iphone|ipad|ipod/i.test(p);
  } catch { return false; }
}

// ── keyIs — layout-robust key matcher ──────────────────────────────
// Mirrors shell.js's keyIs semantics: a letter shortcut matches either the
// physical code ("KeyW") or the produced key ("w"), because on macOS
// Option/Alt+letter yields a symbol in e.key while e.code stays stable.
// Here it's generalised to take a target code/letter plus optional modifiers.
//
//   keyIs(e, 'w')                         // letter W, any modifiers
//   keyIs(e, 'w', { ctrl: true })         // Ctrl/Meta + W (mod=true)
//   keyIs(e, 'Tab')                       // a named key
//   keyIs(e, 'w', { mod: true, shift:false })
//
// mods keys: { ctrl, meta, alt, shift, mod }. `mod` means "ctrl OR meta"
// (the platform command modifier). Unspecified modifiers are not constrained
// EXCEPT that when you pass any mod constraint, the others default to "must be
// false" so e.g. requesting Ctrl+W doesn't also fire on Ctrl+Alt+W. Pass the
// modifier explicitly as true to allow it.
export function keyIs(e, target, mods) {
  if (!e || !target) return false;
  // Key/code match.
  const t = String(target);
  let matched;
  if (/^[a-z]$/i.test(t)) {
    const code = `Key${t.toUpperCase()}`;
    matched = e.code === code || (e.key || '').toLowerCase() === t.toLowerCase();
  } else if (/^[0-9]$/.test(t)) {
    matched = e.code === `Digit${t}` || e.key === t;
  } else {
    // Named key: 'Tab', 'Escape', 'Enter', 'space', 'ArrowUp', '/', etc.
    const lk = (e.key || '');
    const lc = (e.code || '');
    if (t === 'space' || t === ' ' || t === 'Space') {
      matched = lk === ' ' || lc === 'Space';
    } else {
      matched = lk === t || lc === t ||
                lk.toLowerCase() === t.toLowerCase() ||
                lc.toLowerCase() === t.toLowerCase();
    }
  }
  if (!matched) return false;
  if (!mods) return true;

  // Normalise the event modifiers.
  const ev = { ctrl: !!e.ctrl, meta: !!e.meta, alt: !!e.alt, shift: !!e.shift };
  const evMod = ev.ctrl || ev.meta;

  if (mods.mod !== undefined) {
    // `mod` means "the platform command key" (ctrl OR meta).
    if (mods.mod && !evMod) return false;
    if (!mods.mod && evMod) return false;
    // When using `mod`, don't separately constrain ctrl/meta — either is fine.
  } else {
    // Constrain ctrl / meta individually (default off when any mod is passed).
    if (ev.ctrl !== (mods.ctrl ?? false)) return false;
    if (ev.meta !== (mods.meta ?? false)) return false;
  }

  if (ev.alt !== (mods.alt ?? false)) return false;

  // shift: only constrain when the caller cares (letters can be shifted freely).
  if (mods.shift !== undefined && ev.shift !== !!mods.shift) return false;

  return true;
}

// ── Spec parsing ───────────────────────────────────────────────────
// Parse one chord spec string into a structured token list.
//   "shift+mod+s" -> { type:'combo', mods:{mod,shift}, key:'s' }
//   "leader g f"   -> { type:'leader', steps:[{key:'g'},{key:'f'}] }
function parseSpec(spec) {
  const s = String(spec).trim();
  if (/^leader\b/i.test(s)) {
    const rest = s.replace(/^leader\b/i, '').trim();
    const steps = rest.split(/\s+/).filter(Boolean).map(tok => parseChord(tok));
    return { type: 'leader', steps };
  }
  return { type: 'combo', ...parseChord(s) };
}

// Parse "shift+mod+s" → { mods, key }
function parseChord(tok) {
  const parts = String(tok).split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  const mods = {};
  let key = '';
  for (const p of parts) {
    if (p === 'mod' || p === 'cmdctrl' || p === 'cmdorctrl') mods.mod = true;
    else if (p === 'ctrl' || p === 'control') mods.ctrl = true;
    else if (p === 'meta' || p === 'cmd' || p === 'super' || p === 'win') mods.meta = true;
    else if (p === 'alt' || p === 'opt' || p === 'option') mods.alt = true;
    else if (p === 'shift') mods.shift = true;
    else key = p;
  }
  // Normalise some key aliases back to canonical forms understood by keyIs.
  const aliases = { esc: 'Escape', escape: 'Escape', enter: 'Enter', ret: 'Enter',
                    tab: 'Tab', space: 'space', spc: 'space', del: 'Delete',
                    backspace: 'Backspace', up: 'ArrowUp', down: 'ArrowDown',
                    left: 'ArrowLeft', right: 'ArrowRight' };
  if (aliases[key]) key = aliases[key];
  return { mods, key };
}

// Robust matcher used internally (avoids keyIs's documented-but-buggy tail).
function matchChord(e, chord, isMac) {
  if (!chord.key) return false;
  if (!matchKeyToken(e, chord.key)) return false;
  return matchMods(e, chord.mods);
}

function matchKeyToken(e, key) {
  const t = String(key);
  if (/^[a-z]$/i.test(t)) {
    return e.code === `Key${t.toUpperCase()}` ||
           (e.key || '').toLowerCase() === t.toLowerCase();
  }
  if (/^[0-9]$/.test(t)) {
    return e.code === `Digit${t}` || e.key === t;
  }
  if (t === 'space') return (e.key || '') === ' ' || e.code === 'Space';
  return e.key === t || e.code === t ||
         (e.key || '').toLowerCase() === t.toLowerCase() ||
         (e.code || '').toLowerCase() === t.toLowerCase();
}

function matchMods(e, mods) {
  const ev = { ctrl: !!e.ctrl, meta: !!e.meta, alt: !!e.alt, shift: !!e.shift };
  const evMod = ev.ctrl || ev.meta;
  if (mods.mod) {
    if (!evMod) return false;
  } else {
    if ((mods.ctrl ?? false) !== ev.ctrl) return false;
    if ((mods.meta ?? false) !== ev.meta) return false;
  }
  if ((mods.alt ?? false) !== ev.alt) return false;
  // Shift is exact: a chord that doesn't ask for Shift must not fire while
  // Shift is held — otherwise "mod+s" would also swallow "shift+mod+s".
  if (!!mods.shift !== ev.shift) return false;
  return true;
}

// ── Default bindings (DATA) ─────────────────────────────────────────
// These describe system-level intents. The shell maps intent ids to actions.
// `when(ctx)` gates a binding; `run(ctx)` adds payload to the intent.
//
// ctx snapshot (provided by the shell) is expected to expose, all optional:
//   { focusedApp, editing, fileSelected, filePath, hasWindow, mode }
//   - editing: true when a text field / editor has focus (suppresses Space QL)
//   - fileSelected / filePath: the desktop-selected file, if any
const DEFAULT_BINDINGS = [
  { id: 'new-window',     keys: ['mod+n', 'leader n'],            label: 'New window' },
  { id: 'close',          keys: ['mod+w'],                        label: 'Close window' },
  { id: 'save',           keys: ['mod+s', 'leader w'],            label: 'Save' },
  { id: 'save-as',        keys: ['shift+mod+s'],                  label: 'Save as…' },
  { id: 'switch-app',     keys: ['alt+tab', 'leader tab'],        label: 'Switch app' },
  { id: 'minimize',       keys: ['mod+m', 'leader m'],            label: 'Minimize window' },
  { id: 'maximize',       keys: ['ctrl+mod+f', 'leader f'],       label: 'Toggle maximize' },
  { id: 'command-palette',keys: ['shift+mod+p', 'leader p'],      label: 'Command palette' },
  { id: 'find',           keys: ['mod+f'],                        label: 'Find' },
  { id: 'theme',          keys: ['mod+t', 'leader t'],            label: 'Cycle theme' },
  { id: 'open-finder',    keys: ['leader e'],                     label: 'Open file browser' },
  {
    id: 'open-quicklook',
    keys: ['space', 'leader space'],
    label: 'Quick Look (preview)',
    when: (ctx) => !!ctx && !!ctx.fileSelected && !ctx.editing,
    run: (ctx) => ({ path: ctx.filePath ?? null }),
  },
];

// ── createKeymap ────────────────────────────────────────────────────
export function createKeymap(opts = {}) {
  const user = opts.user || null;
  const isMac = opts.mac ?? detectMac();

  // Pending leader chord state. `leaderSeq` holds keys pressed since the leader.
  const leaderPending = signal(false);
  let leaderSeq = [];           // array of chords matched since leader
  let leaderTimer = null;       // optional auto-cancel timeout id (shell-managed)

  // Registry: id -> { id, keys:[spec…], parsed:[…], when, run, label }
  const registry = new Map();

  function _userPref(key, fallback) {
    if (!user) return fallback;
    try {
      // Support a few likely shapes of the system-user store (TASK #6):
      //   user.get(key) | user.prefs.peek()[key] | user.settings[key] | user[key]
      if (typeof user.get === 'function') {
        const v = user.get(key);
        if (v !== undefined && v !== null) return v;
      }
      const bag = (user.prefs?.peek?.() ?? user.prefs) ||
                  (user.settings?.peek?.() ?? user.settings) ||
                  (user.value?.prefs) || user;
      if (bag && typeof bag === 'object' && key in bag && bag[key] != null) {
        return bag[key];
      }
    } catch { /* ignore */ }
    return fallback;
  }

  // Resolve the active leader key spec from the user store (default: backtick).
  // Accepts a single-key chord spec like "`", "leader" alias, "ctrl+k", etc.
  function leaderChord() {
    const raw = _userPref('leaderKey', '`');
    return parseChord(String(raw));
  }

  // Is Quick-Look-on-space enabled? (user pref, default on)
  function quickLookEnabled() {
    const v = _userPref('quickLook', true);
    return v !== false;
  }

  function register(id, def = {}) {
    const keys = Array.isArray(def.keys) ? def.keys.slice()
               : def.keys ? [def.keys] : [];
    const rec = {
      id,
      keys,
      parsed: keys.map(parseSpec),
      when: typeof def.when === 'function' ? def.when : null,
      run: typeof def.run === 'function' ? def.run : null,
      label: def.label || id,
    };
    registry.set(id, rec);
    return rec;
  }
  function unregister(id) { return registry.delete(id); }

  // Seed defaults.
  for (const b of DEFAULT_BINDINGS) register(b.id, b);

  // ── Leader state helpers ──────────────────────────────────────────
  function leaderActive() { return leaderPending.peek(); }
  function cancelLeader() {
    leaderPending.value = false;
    leaderSeq = [];
    if (leaderTimer) { clearTimeout?.(leaderTimer); leaderTimer = null; }
  }
  function _beginLeader() {
    leaderSeq = [];
    leaderPending.value = true;
  }

  // Build an intent object for a matched binding.
  function _intent(rec, ctx, via) {
    let extra = null;
    if (rec.run) { try { extra = rec.run(ctx) || null; } catch { extra = null; } }
    return { id: rec.id, label: rec.label, via, ...(extra || {}) };
  }

  // Does the user-pref say Quick-Look is off? Then drop the QL binding.
  function _bindingEnabled(rec) {
    if (rec.id === 'open-quicklook' && !quickLookEnabled()) return false;
    return true;
  }

  // ── route — the core dispatcher ───────────────────────────────────
  // Returns an intent for the shell to run, the sentinel { id:'__leader__' }
  // when a leader was just armed (so the shell can swallow the key / show a
  // hint), or null when nothing matched.
  function route(e, ctx) {
    if (!e || e.type === 'up') return null;

    // 1) Leader key press (when not already mid-sequence) arms the sequence.
    const lc = leaderChord();
    if (!leaderPending.peek() && matchChord(e, lc, isMac)) {
      // Don't arm the leader while typing in an editor (so backtick works).
      if (ctx && ctx.editing) { /* fall through to combos */ }
      else { _beginLeader(); return { id: '__leader__', label: 'leader', via: 'leader-armed' }; }
    }

    // 2) If a leader sequence is open, try to advance / complete it.
    if (leaderPending.peek()) {
      // Escape (or the leader again) cancels.
      if (matchKeyToken(e, 'Escape')) { cancelLeader(); return { id: '__cancel__', via: 'leader' }; }

      const chord = { mods: modsFromEvent(e), key: tokenFromEvent(e) };
      if (!chord.key) return { id: '__leader__', via: 'leader-wait' }; // modifier-only press: keep waiting
      leaderSeq.push(chord);

      // Try to match the accumulated sequence against any binding's leader spec.
      const seqMatch = _matchLeaderSeq(leaderSeq, e, ctx);
      if (seqMatch.status === 'complete') {
        const rec = seqMatch.rec;
        cancelLeader();
        if (rec && _bindingEnabled(rec) && (!rec.when || _safeWhen(rec, ctx))) {
          return _intent(rec, ctx, 'leader');
        }
        return { id: '__cancel__', via: 'leader' };
      }
      if (seqMatch.status === 'partial') {
        return { id: '__leader__', via: 'leader-wait', depth: leaderSeq.length };
      }
      // No prefix matches — abort the sequence.
      cancelLeader();
      return { id: '__cancel__', via: 'leader' };
    }

    // 3) Direct combos (Cmd/Ctrl + key, Alt+Tab, bare Space for Quick Look…).
    for (const rec of registry.values()) {
      if (!_bindingEnabled(rec)) continue;
      for (const spec of rec.parsed) {
        if (spec.type !== 'combo') continue;
        if (matchChord(e, spec, isMac)) {
          if (rec.when && !_safeWhen(rec, ctx)) continue;
          return _intent(rec, ctx, 'combo');
        }
      }
    }
    return null;
  }

  function _safeWhen(rec, ctx) {
    try { return !!rec.when(ctx); } catch { return false; }
  }

  // Compare the accumulated leader sequence against every leader binding.
  // Returns { status:'complete', rec } | { status:'partial' } | { status:'none' }
  function _matchLeaderSeq(seq) {
    let partial = false;
    for (const rec of registry.values()) {
      if (!_bindingEnabled(rec)) continue;
      for (const spec of rec.parsed) {
        if (spec.type !== 'leader' || !spec.steps.length) continue;
        const n = Math.min(seq.length, spec.steps.length);
        let ok = true;
        for (let i = 0; i < n; i++) {
          if (!chordEq(seq[i], spec.steps[i])) { ok = false; break; }
        }
        if (!ok) continue;
        if (seq.length === spec.steps.length) return { status: 'complete', rec };
        if (seq.length < spec.steps.length) partial = true;
      }
    }
    return { status: partial ? 'partial' : 'none' };
  }

  // ── Introspection ─────────────────────────────────────────────────
  function bindings() {
    return [...registry.values()].map(r => ({
      id: r.id, keys: r.keys.slice(), label: r.label, hasGuard: !!r.when,
    }));
  }

  // Human-readable cheat sheet: [{ id, label, keys: 'displayed combo' }]
  function describe() {
    return [...registry.values()].map(r => ({
      id: r.id,
      label: r.label,
      keys: r.keys.map(k => prettySpec(k, isMac)).join('  /  '),
    }));
  }

  return {
    register, unregister, route,
    leaderActive, cancelLeader,
    bindings, describe,
    get isMac() { return isMac; },
    leaderPending,          // signal — shell can subscribe to show a hint
    leaderKey: leaderChord, // current leader chord (parsed)
    quickLookEnabled,
  };
}

// ── Small helpers (module-scope, pure) ─────────────────────────────
function modsFromEvent(e) {
  const m = {};
  if (e.ctrl) m.ctrl = true;
  if (e.meta) m.meta = true;
  if (e.alt) m.alt = true;
  if (e.shift) m.shift = true;
  return m;
}

// Extract the canonical key token from an event (letter/digit/named), or ''
// for a modifier-only keydown.
function tokenFromEvent(e) {
  const code = e.code || '';
  const key = e.key || '';
  if (/^Key([A-Z])$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit([0-9])$/.test(code)) return code.slice(5);
  if (code === 'Space' || key === ' ') return 'space';
  // Pure modifier presses have no actionable token.
  if (/^(Shift|Control|Alt|Meta)(Left|Right)?$/.test(code)) return '';
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return '';
  // Named keys: prefer key when it's a single recognisable name.
  if (key && key.length > 1) return key;       // 'Tab', 'Escape', 'ArrowUp'
  if (key && key.length === 1) return key.toLowerCase();
  return code || '';
}

// Equality of two parsed chords (ignoring shift unless one side cares).
function chordEq(a, b) {
  if (!a || !b) return false;
  if (normKey(a.key) !== normKey(b.key)) return false;
  const am = a.mods || {}, bm = b.mods || {};
  const mod = (x) => !!(x.mod || x.ctrl || x.meta);
  if (mod(am) !== mod(bm)) return false;
  if (!!am.alt !== !!bm.alt) return false;
  // shift compared only when both define it.
  if (am.shift !== undefined && bm.shift !== undefined && !!am.shift !== !!bm.shift) return false;
  return true;
}

function normKey(k) {
  const t = String(k || '').toLowerCase();
  const map = { ' ': 'space', spc: 'space' };
  return map[t] || t;
}

// Pretty-print a spec string for a cheat-sheet, platform-aware.
function prettySpec(spec, isMac) {
  const s = String(spec);
  if (/^leader\b/i.test(s)) {
    const rest = s.replace(/^leader\b/i, '').trim();
    const keys = rest.split(/\s+/).filter(Boolean).map(prettyKey).join(' ');
    return `leader ${keys}`.trim();
  }
  return s.split('+').map(part => {
    const p = part.toLowerCase();
    if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (p === 'meta' || p === 'cmd') return isMac ? '⌘' : 'Win';
    if (p === 'ctrl') return isMac ? '⌃' : 'Ctrl';
    if (p === 'alt' || p === 'opt') return isMac ? '⌥' : 'Alt';
    if (p === 'shift') return isMac ? '⇧' : 'Shift';
    return prettyKey(part);
  }).join(isMac ? '' : '+');
}

function prettyKey(k) {
  const t = String(k);
  if (t === 'space') return 'Space';
  if (/^[a-z]$/.test(t)) return t.toUpperCase();
  return t;
}
