// syntax.js — tiny dependency-free source highlighter for the acii grid.
//
// Pure logic, no DOM. Produces per-line spans of { text, role } where `role`
// is a semantic token class; the host maps roles to theme colors via
// roleColor(role, colors) so highlighting tracks the active theme.
//
//   import { langForPath, highlight, roleColor } from './syntax.js';
//   const lang = langForPath('/x/app.js');      // 'js' | 'json' | 'css' | 'html' | 'py' | 'sh' | null
//   const rows = highlight(sourceText, lang);    // Array<Array<{text, role}>>, one entry per line
//   const color = roleColor(span.role, themeColors);
//
// Stateful constructs that cross line boundaries (block comments, template
// strings) are handled by carrying tokenizer state line-to-line internally,
// so `highlight()` only needs the whole text once.

// ── language detection ──────────────────────────────────────────────
const EXT_LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
  json: 'json', json5: 'json',
  css: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  py: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  md: 'md', markdown: 'md', mdown: 'md', mkd: 'md',
};

export function langForPath(path) {
  if (!path) return null;
  const m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  return EXT_LANG[m[1]] || null;
}

// ── role → theme color ──────────────────────────────────────────────
// colors = ctx.theme.peek().colors (accent, fg, fgDim, warning, success, link, error…)
export function roleColor(role, c) {
  switch (role) {
    case 'keyword':  return c.accent;
    case 'string':   return c.success;
    case 'comment':  return c.fgDim;
    case 'number':   return c.warning;
    case 'atom':     return c.warning;   // true/false/null/undefined
    case 'function': return c.link;
    case 'tag':      return c.accent;
    case 'attr':     return c.link;
    case 'property': return c.link;
    case 'regex':    return c.warning;
    case 'punct':    return c.fgDim;
    case 'text':
    default:         return c.fg;
  }
}

// ── keyword / atom tables ───────────────────────────────────────────
const set = (arr) => new Set(arr);

const JS_KEYWORDS = set([
  'await','break','case','catch','class','const','continue','debugger',
  'default','delete','do','else','export','extends','finally','for','function',
  'if','import','in','instanceof','let','new','of','return','super','switch',
  'this','throw','try','typeof','var','void','while','with','yield','static',
  'get','set','async','as','from',
]);
const JS_ATOMS = set(['true','false','null','undefined','NaN','Infinity']);

const PY_KEYWORDS = set([
  'and','as','assert','async','await','break','class','continue','def','del',
  'elif','else','except','finally','for','from','global','if','import','in','is',
  'lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','self',
]);
const PY_ATOMS = set(['True','False','None']);

const SH_KEYWORDS = set([
  'if','then','else','elif','fi','for','while','do','done','case','esac','in',
  'function','return','exit','export','local','echo','cd','read','set','unset','source',
]);

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUM_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;

// ── core c-like tokenizer (js / py / sh / css value text / generic) ──
// Returns { spans, state }. state carries { block, tmpl } across lines.
function tokenizeCLike(line, st, cfg) {
  const spans = [];
  let i = 0;
  const n = line.length;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) spans.push({ text: line.slice(textStart, end), role: 'text' });
  };

  // Continuing a block comment from a previous line.
  if (st.block) {
    const close = line.indexOf('*/');
    if (close === -1) { spans.push({ text: line, role: 'comment' }); return { spans, state: st }; }
    spans.push({ text: line.slice(0, close + 2), role: 'comment' });
    st = { ...st, block: false };
    i = close + 2; textStart = i;
  }
  // Continuing a template string from a previous line.
  if (st.tmpl) {
    const close = findUnescaped(line, '`', 0);
    if (close === -1) { spans.push({ text: line, role: 'string' }); return { spans, state: st }; }
    spans.push({ text: line.slice(0, close + 1), role: 'string' });
    st = { ...st, tmpl: false };
    i = close + 1; textStart = i;
  }

  while (i < n) {
    const ch = line[i];
    const two = line.slice(i, i + 2);

    // line comment
    if (cfg.line && line.startsWith(cfg.line, i)) {
      flushText(i);
      spans.push({ text: line.slice(i), role: 'comment' });
      return { spans, state: st };
    }
    // block comment open
    if (cfg.block && two === '/*') {
      flushText(i);
      const close = line.indexOf('*/', i + 2);
      if (close === -1) { spans.push({ text: line.slice(i), role: 'comment' }); return { spans, state: { ...st, block: true } }; }
      spans.push({ text: line.slice(i, close + 2), role: 'comment' });
      i = close + 2; textStart = i; continue;
    }
    // template string (js)
    if (cfg.template && ch === '`') {
      flushText(i);
      const close = findUnescaped(line, '`', i + 1);
      if (close === -1) { spans.push({ text: line.slice(i), role: 'string' }); return { spans, state: { ...st, tmpl: true } }; }
      spans.push({ text: line.slice(i, close + 1), role: 'string' });
      i = close + 1; textStart = i; continue;
    }
    // quoted string
    if (ch === '"' || ch === "'") {
      flushText(i);
      const close = findUnescaped(line, ch, i + 1);
      const end = close === -1 ? n : close + 1;
      spans.push({ text: line.slice(i, end), role: 'string' });
      i = end; textStart = i; continue;
    }
    // number
    if (ch >= '0' && ch <= '9') {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(line);
      if (m && m.index === i) {
        flushText(i);
        spans.push({ text: m[0], role: 'number' });
        i += m[0].length; textStart = i; continue;
      }
    }
    // identifier / keyword / atom / function-call
    if (/[A-Za-z_$]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(line);
      if (m && m.index === i) {
        flushText(i);
        const word = m[0];
        let role = 'text';
        if (cfg.keywords.has(word)) role = 'keyword';
        else if (cfg.atoms && cfg.atoms.has(word)) role = 'atom';
        else if (line[i + word.length] === '(') role = 'function';
        spans.push({ text: word, role });
        i += word.length; textStart = i; continue;
      }
    }
    i++;
  }
  flushText(n);
  return { spans, state: st };
}

// Index of the next `quote` not preceded by a backslash, or -1.
function findUnescaped(s, quote, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === quote) return i;
  }
  return -1;
}

// ── JSON: keys vs values ────────────────────────────────────────────
function tokenizeJson(line) {
  const spans = [];
  let i = 0; const n = line.length; let textStart = 0;
  const flush = (end) => { if (end > textStart) spans.push({ text: line.slice(textStart, end), role: 'text' }); };
  while (i < n) {
    const ch = line[i];
    if (ch === '"') {
      flush(i);
      const close = findUnescaped(line, '"', i + 1);
      const end = close === -1 ? n : close + 1;
      // A string immediately followed by ':' is a property key.
      let j = end; while (j < n && line[j] === ' ') j++;
      spans.push({ text: line.slice(i, end), role: line[j] === ':' ? 'property' : 'string' });
      i = end; textStart = i; continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '-' && /[0-9]/.test(line[i + 1] || ''))) {
      NUM_RE.lastIndex = (ch === '-') ? i + 1 : i;
      const m = NUM_RE.exec(line);
      if (m) { flush(i); spans.push({ text: line.slice(i, NUM_RE.lastIndex), role: 'number' }); i = NUM_RE.lastIndex; textStart = i; continue; }
    }
    if (/[a-z]/.test(ch)) {
      IDENT_RE.lastIndex = i; const m = IDENT_RE.exec(line);
      if (m && m.index === i && (m[0] === 'true' || m[0] === 'false' || m[0] === 'null')) {
        flush(i); spans.push({ text: m[0], role: 'atom' }); i += m[0].length; textStart = i; continue;
      }
    }
    i++;
  }
  flush(n);
  return { spans, state: {} };
}

// ── CSS ─────────────────────────────────────────────────────────────
function tokenizeCss(line, st) {
  const spans = [];
  let i = 0; const n = line.length; let textStart = 0;
  const flush = (end) => { if (end > textStart) spans.push({ text: line.slice(textStart, end), role: 'text' }); };
  if (st.block) {
    const close = line.indexOf('*/');
    if (close === -1) { spans.push({ text: line, role: 'comment' }); return { spans, state: st }; }
    spans.push({ text: line.slice(0, close + 2), role: 'comment' });
    i = close + 2; textStart = i; st = { ...st, block: false };
  }
  while (i < n) {
    const ch = line[i]; const two = line.slice(i, i + 2);
    if (two === '/*') {
      flush(i);
      const close = line.indexOf('*/', i + 2);
      if (close === -1) { spans.push({ text: line.slice(i), role: 'comment' }); return { spans, state: { block: true } }; }
      spans.push({ text: line.slice(i, close + 2), role: 'comment' }); i = close + 2; textStart = i; continue;
    }
    if (ch === '"' || ch === "'") {
      flush(i); const close = findUnescaped(line, ch, i + 1); const end = close === -1 ? n : close + 1;
      spans.push({ text: line.slice(i, end), role: 'string' }); i = end; textStart = i; continue;
    }
    if (ch === '#' || ch === '.' || ch === '@' || ch === '&') {
      // selector / at-rule token
      IDENT_RE.lastIndex = i + 1; const m = IDENT_RE.exec(line);
      if (m && m.index === i + 1) { flush(i); spans.push({ text: ch + m[0], role: ch === '@' ? 'keyword' : 'tag' }); i += 1 + m[0].length; textStart = i; continue; }
    }
    if ((ch >= '0' && ch <= '9') || (ch === '-' && /[0-9.]/.test(line[i + 1] || ''))) {
      NUM_RE.lastIndex = (ch === '-') ? i + 1 : i; const m = NUM_RE.exec(line);
      if (m) { flush(i); const end = NUM_RE.lastIndex; // include a unit suffix
        let u = end; while (u < n && /[a-z%]/i.test(line[u])) u++;
        spans.push({ text: line.slice(i, u), role: 'number' }); i = u; textStart = i; continue; }
    }
    if (/[A-Za-z_-]/.test(ch)) {
      IDENT_RE.lastIndex = i; const m = /[A-Za-z_-][A-Za-z0-9_-]*/y; m.lastIndex = i; const mm = m.exec(line);
      if (mm && mm.index === i) {
        flush(i);
        let k = i + mm[0].length; while (line[k] === ' ') k++;
        spans.push({ text: mm[0], role: line[k] === ':' ? 'property' : 'text' });
        i += mm[0].length; textStart = i; continue;
      }
    }
    i++;
  }
  flush(n);
  return { spans, state: st };
}

// ── HTML / XML ──────────────────────────────────────────────────────
function tokenizeHtml(line, st) {
  const spans = [];
  let i = 0; const n = line.length; let textStart = 0;
  const flush = (end, role = 'text') => { if (end > textStart) spans.push({ text: line.slice(textStart, end), role }); };
  if (st.comment) {
    const close = line.indexOf('-->');
    if (close === -1) { spans.push({ text: line, role: 'comment' }); return { spans, state: st }; }
    spans.push({ text: line.slice(0, close + 3), role: 'comment' }); i = close + 3; textStart = i; st = { ...st, comment: false };
  }
  while (i < n) {
    if (line.startsWith('<!--', i)) {
      flush(i);
      const close = line.indexOf('-->', i + 4);
      if (close === -1) { spans.push({ text: line.slice(i), role: 'comment' }); return { spans, state: { comment: true } }; }
      spans.push({ text: line.slice(i, close + 3), role: 'comment' }); i = close + 3; textStart = i; continue;
    }
    if (line[i] === '<') {
      flush(i);
      const close = line.indexOf('>', i);
      const end = close === -1 ? n : close + 1;
      tokenizeTag(line.slice(i, end), spans);
      i = end; textStart = i; continue;
    }
    i++;
  }
  flush(n);
  return { spans, state: st };
}

function tokenizeTag(tag, spans) {
  // tag like "<div class="x">" — punct + tagname + attrs + strings
  const m = tag.match(/^<\/?[A-Za-z0-9-]*/);
  if (m) {
    spans.push({ text: m[0], role: 'tag' });
    let rest = tag.slice(m[0].length);
    const re = /("[^"]*"|'[^']*'|[A-Za-z_:][\w:.-]*|[^"'\w]+)/g;
    let mm;
    while ((mm = re.exec(rest))) {
      const t = mm[0];
      if (t[0] === '"' || t[0] === "'") spans.push({ text: t, role: 'string' });
      else if (/^[A-Za-z_:]/.test(t)) spans.push({ text: t, role: 'attr' });
      else spans.push({ text: t, role: 'tag' });
    }
  } else {
    spans.push({ text: tag, role: 'tag' });
  }
}

// ── Markdown (raw view, e.g. while editing in vim) ──────────────────
function tokenizeMarkdown(line, st) {
  // Fenced code block: everything between ``` fences is a string.
  if (line.trimStart().startsWith('```')) {
    return { spans: [{ text: line, role: 'keyword' }], state: { ...st, fence: !st.fence } };
  }
  if (st.fence) return { spans: [{ text: line, role: 'string' }], state: st };

  // Heading.
  if (/^\s*#{1,6}\s/.test(line)) return { spans: [{ text: line, role: 'keyword' }], state: st };
  // Blockquote.
  if (/^\s*>/.test(line)) return { spans: [{ text: line, role: 'comment' }], state: st };
  // Horizontal rule.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return { spans: [{ text: line, role: 'punct' }], state: st };

  const spans = [];
  let i = 0; const n = line.length;
  // Leading list marker.
  const lm = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/);
  if (lm) { spans.push({ text: lm[0], role: 'keyword' }); i = lm[0].length; }

  let textStart = i;
  const flush = (end) => { if (end > textStart) spans.push({ text: line.slice(textStart, end), role: 'text' }); };
  while (i < n) {
    const ch = line[i];
    // inline code `...`
    if (ch === '`') {
      const close = line.indexOf('`', i + 1);
      const end = close === -1 ? n : close + 1;
      flush(i); spans.push({ text: line.slice(i, end), role: 'string' }); i = end; textStart = i; continue;
    }
    // bold ** or __
    if ((ch === '*' && line[i + 1] === '*') || (ch === '_' && line[i + 1] === '_')) {
      const mark = line.slice(i, i + 2);
      const close = line.indexOf(mark, i + 2);
      if (close !== -1) { flush(i); spans.push({ text: line.slice(i, close + 2), role: 'atom' }); i = close + 2; textStart = i; continue; }
    }
    // emphasis * or _
    if (ch === '*' || ch === '_') {
      const close = line.indexOf(ch, i + 1);
      if (close !== -1 && close > i + 1) { flush(i); spans.push({ text: line.slice(i, close + 1), role: 'function' }); i = close + 1; textStart = i; continue; }
    }
    // link [text](url)
    if (ch === '[') {
      const m = line.slice(i).match(/^\[[^\]]*\]\([^)]*\)/);
      if (m) { flush(i); spans.push({ text: m[0], role: 'attr' }); i += m[0].length; textStart = i; continue; }
    }
    i++;
  }
  flush(n);
  return { spans, state: st };
}

// ── per-language line dispatcher ────────────────────────────────────
function lineTokenizer(lang) {
  switch (lang) {
    case 'js':   return (l, s) => tokenizeCLike(l, s, { line: '//', block: true, template: true, keywords: JS_KEYWORDS, atoms: JS_ATOMS });
    case 'py':   return (l, s) => tokenizeCLike(l, s, { line: '#', block: false, template: false, keywords: PY_KEYWORDS, atoms: PY_ATOMS });
    case 'sh':   return (l, s) => tokenizeCLike(l, s, { line: '#', block: false, template: false, keywords: SH_KEYWORDS, atoms: null });
    case 'json': return (l) => tokenizeJson(l);
    case 'css':  return (l, s) => tokenizeCss(l, s);
    case 'html': return (l, s) => tokenizeHtml(l, s);
    case 'md':   return (l, s) => tokenizeMarkdown(l, s);
    default:     return null;
  }
}

// ── public: highlight whole text → spans per line ───────────────────
export function highlight(text, lang) {
  const tok = lineTokenizer(lang);
  const lines = String(text == null ? '' : text).split('\n');
  if (!tok) return lines.map((l) => [{ text: l, role: 'text' }]);
  let state = {};
  const out = [];
  for (const line of lines) {
    let res;
    try { res = tok(line, state); }
    catch { res = { spans: [{ text: line, role: 'text' }], state }; }
    out.push(res.spans.length ? res.spans : [{ text: '', role: 'text' }]);
    state = res.state || {};
  }
  return out;
}
