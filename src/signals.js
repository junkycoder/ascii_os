let currentEffect = null;
let batchDepth = 0;
const pending = new Set();

export function signal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get value() {
      if (currentEffect) subs.add(currentEffect);
      return value;
    },
    set value(next) {
      if (Object.is(next, value)) return;
      value = next;
      if (batchDepth > 0) {
        for (const s of subs) pending.add(s);
      } else {
        for (const s of [...subs]) s();
      }
    },
    peek() { return value; },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

const EFFECT_DEPTH_LIMIT = 100;
let effectDepth = 0;

export function effect(fn) {
  const run = () => {
    if (effectDepth >= EFFECT_DEPTH_LIMIT) {
      console.error('[signals] effect re-entrancy limit reached — possible cycle (effect → set signal → effect). Aborting.');
      return;
    }
    const prev = currentEffect;
    currentEffect = run;
    effectDepth++;
    try { fn(); }
    catch (err) { console.error('[signals] effect threw:', err); }
    finally { currentEffect = prev; effectDepth--; }
  };
  run();
  return run;
}

export function computed(fn) {
  let value;
  let dirty = true;
  const s = signal(undefined); // notifies .value subscribers when deps change
  // Eager effect: tracks deps; on dep change it marks dirty and bumps the
  // inner signal so .value readers get notified. It does NOT recompute here.
  effect(() => { fn(); dirty = true; s.value = (s.peek() || 0) + 1; });
  dirty = true; // first read recomputes
  const recompute = () => {
    if (dirty) {
      const prev = currentEffect;
      currentEffect = null; // recompute without subscribing the reader to deps
      try { value = fn(); } finally { currentEffect = prev; }
      dirty = false;
    }
    return value;
  };
  return {
    get value() { const v = recompute(); s.value; return v; }, // subscribe reader
    peek() { return recompute(); },
  };
}

export function batch(fn) {
  batchDepth++;
  try { fn(); }
  finally {
    batchDepth--;
    if (batchDepth === 0) {
      const toRun = [...pending];
      pending.clear();
      for (const s of toRun) s();
    }
  }
}
