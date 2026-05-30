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

export function effect(fn) {
  const run = () => {
    const prev = currentEffect;
    currentEffect = run;
    try { fn(); } finally { currentEffect = prev; }
  };
  run();
  return run;
}

export function computed(fn) {
  const s = signal(undefined);
  effect(() => { s.value = fn(); });
  return { get value() { return s.value; }, peek: s.peek };
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
