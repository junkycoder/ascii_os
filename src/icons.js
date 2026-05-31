// icons.js — pure pixel-icon sprites + a half-block renderer.
//
// A sprite is { w, h, rows } where `rows` are `h` strings of `w` chars. Each
// char is a palette key resolved against the active theme colors at render
// time (so icons re-tint with the theme); '.'/' ' = transparent.
//
//   '.' ' '  transparent (lets the tile face show through)
//   A accent   F fg      D fgDim    B border
//   W warning  E error   S success  L link
//
// Rendered to half-block cells: each cell stacks two vertical pixels — top is
// the glyph ink (fg), bottom is the cell background. So one 8×8 sprite becomes
// 8 wide × 4 tall cells. Transparent halves fall back to the passed face color
// (▀ top-only / ▄ bottom-only); fully-transparent cells are returned as null so
// the caller can skip them and leave the tile face untouched.

const PAL = {
  A: 'accent', F: 'fg', D: 'fgDim', B: 'border',
  W: 'warning', E: 'error', S: 'success', L: 'link',
};

function colorOf(ch, colors) {
  if (!ch || ch === '.' || ch === ' ') return null;
  const key = PAL[ch];
  return key ? (colors[key] || null) : null;
}

// sprite → 2D array (ceil(h/2) rows × w cols) of { ch, fg, bg } | null.
export function spriteToHalfCells(sprite, colors, faceBg) {
  const { w, h, rows } = sprite;
  const out = [];
  for (let cy = 0; cy < Math.ceil(h / 2); cy++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const top = colorOf(rows[cy * 2] && rows[cy * 2][x], colors);
      const bot = colorOf(rows[cy * 2 + 1] && rows[cy * 2 + 1][x], colors);
      if (top && bot) row.push({ ch: '▀', fg: top, bg: bot });
      else if (top) row.push({ ch: '▀', fg: top, bg: faceBg });
      else if (bot) row.push({ ch: '▄', fg: bot, bg: faceBg });
      else row.push(null);                 // fully transparent → leave face
    }
    out.push(row);
  }
  return out;
}

export function spriteSize(sprite) {
  return { wCells: sprite.w, hCells: Math.ceil(sprite.h / 2) };
}

// ─── App icons (8×8) ────────────────────────────────────────────────
// Keyed by the shell app id. Anything without an entry falls back to the
// text glyph. Authored for legibility at 8×8 — simple, bold motifs.

const S = (rows) => ({ w: rows[0].length, h: rows.length, rows });

export const PIXEL_ICONS = {
  // README — a question mark (help/docs); matches the [?] glyph.
  readme: S([
    '.AAAAA..',
    'AA...AA.',
    '.....AA.',
    '....AA..',
    '...AA...',
    '...AA...',
    '........',
    '...AA...',
  ]),
  // Findman — a magnifier (lens + handle).
  findman: S([
    '.AAAA...',
    'A....A..',
    'A.FF.A..',
    'A.FF.A..',
    'A....A..',
    '.AAAAD..',
    '.....DD.',
    '......DD',
  ]),
  // Git Desk — a commit graph: two branches off a trunk.
  gitdesk: S([
    '..AA....',
    '..AA....',
    '..AAAA..',
    '..AA.A..',
    '..AA.AA.',
    '..AA..AA',
    '..AA....',
    '..AA....',
  ]),
  // Terminal — a screen with a prompt and a cursor.
  terminal: S([
    'BBBBBBBB',
    'B......B',
    'B.SS...B',
    'B...SS.B',
    'B.SS...B',
    'B....FFB',
    'B......B',
    'BBBBBBBB',
  ]),
  // Notes — a checklist.
  notes: S([
    'FFFFFFFF',
    'F.A.DDD.',
    'F......F',
    'F.A.DDD.',
    'F......F',
    'F.A.DDD.',
    'F......F',
    'FFFFFFFF',
  ]),
  // Paint — a brush with a colored tip.
  paint: S([
    '......DD',
    '.....DD.',
    '....DD..',
    '...WW...',
    '..WWW...',
    '.WWWA...',
    'WWWA....',
    '.AA.....',
  ]),
  // Media House — a play triangle on a screen.
  mediamogul: S([
    'BBBBBBBB',
    'B......B',
    'B.AF...B',
    'B.AFF..B',
    'B.AFFF.B',
    'B.AFF..B',
    'B.AF...B',
    'BBBBBBBB',
  ]),
  // GameMaker — a game controller / d-pad.
  gamemaker: S([
    '........',
    '.AAAAAA.',
    'AF.AA.WA',
    'AAAAAAWA',
    'AF.AA..A',
    '.AAAAAA.',
    '........',
    '........',
  ]),
  // Time — a clock face with hands.
  timetrack: S([
    '.AAAAAA.',
    'A......A',
    'A..F...A',
    'A..F...A',
    'A..FFF.A',
    'A......A',
    'A......A',
    '.AAAAAA.',
  ]),
  // Share — an upload/out arrow over a tray.
  share: S([
    '...AA...',
    '..AAAA..',
    '.AAAAAA.',
    'AA.AA.AA',
    '...AA...',
    'F......F',
    'F......F',
    'FFFFFFFF',
  ]),
  // Feedback — an envelope with a V flap.
  feedback: S([
    '........',
    'FFFFFFFF',
    'FAA..AAF',
    'F.AAAA.F',
    'F..AA..F',
    'F......F',
    'FFFFFFFF',
    '........',
  ]),
  // Snake — three body segments + an apple.
  snake: S([
    '........',
    '.SS.....',
    '.SSSS...',
    '...SS...',
    '...SSSS.',
    '.....SS.',
    '......EE',
    '......EE',
  ]),
};

// ─── File-type icons (8×8) ──────────────────────────────────────────
// Desktop file tiles render these by extension category instead of the old
// single ext glyph. A folded-corner page is the shared base; the motif varies.

const FILE_ICONS = {
  // Plain text / docs — page with text lines.
  text: S([
    'FFFFFFD.',
    'F.....DD',
    'F.DDDD.F',
    'F......F',
    'F.DDDD.F',
    'F......F',
    'F.DDD..F',
    'FFFFFFFF',
  ]),
  // Source code — page with a chevron pair.
  code: S([
    'FFFFFFD.',
    'F.....DD',
    'F.A..A.F',
    'F..AA..F',
    'F..AA..F',
    'F.A..A.F',
    'F......F',
    'FFFFFFFF',
  ]),
  // Structured data — page with braces.
  data: S([
    'FFFFFFD.',
    'F.....DD',
    'F.A..A.F',
    'F.A..A.F',
    'F.A..A.F',
    'F.A..A.F',
    'F......F',
    'FFFFFFFF',
  ]),
  // Image — a framed sun + hills.
  image: S([
    'FFFFFFFF',
    'F......F',
    'F.WW...F',
    'FWWWW..F',
    'F....A.F',
    'F..AAAAF',
    'FAAAAAAF',
    'FFFFFFFF',
  ]),
  // Audio — a musical note.
  audio: S([
    '........',
    '...AAAA.',
    '...A..A.',
    '...A....',
    '...A....',
    '.AAA....',
    'AAAA....',
    '.AA.....',
  ]),
  // Video — a play triangle on a screen.
  video: S([
    'BBBBBBBB',
    'B......B',
    'B.AF...B',
    'B.AFF..B',
    'B.AFFF.B',
    'B.AFF..B',
    'B.AF...B',
    'BBBBBBBB',
  ]),
  // Anything else — a blank folded page.
  generic: S([
    'FFFFFFD.',
    'F.....DD',
    'F......F',
    'F......F',
    'F......F',
    'F......F',
    'F......F',
    'FFFFFFFF',
  ]),
};

// A folder — tab + body. Exposed for desktop/Findman folder tiles.
export const FOLDER_ICON = S([
  '.AAA....',
  'AAAAAA..',
  'AAAAAAAA',
  'A......A',
  'A......A',
  'A......A',
  'AAAAAAAA',
  '........',
]);

const EXT_CATEGORY = {
  // text / docs
  txt: 'text', md: 'text', log: 'text', csv: 'text', tsv: 'text', acii: 'text',
  conf: 'text', ini: 'text', yaml: 'text', yml: 'text',
  // code
  js: 'code', mjs: 'code', ts: 'code', html: 'code', htm: 'code', css: 'code',
  py: 'code', sh: 'code', rs: 'code', go: 'code', c: 'code', h: 'code',
  cpp: 'code', java: 'code', rb: 'code', lua: 'code', xml: 'code', svg: 'code',
  // data
  json: 'data', toml: 'data',
  // image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  webp: 'image', avif: 'image', ico: 'image',
  // audio
  mp3: 'audio', wav: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio',
  flac: 'audio', opus: 'audio', ogg: 'audio',
  // video
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video',
  avi: 'video', mkv: 'video',
};

// Pick the file sprite for a name by its extension category.
export function fileSprite(name) {
  const i = String(name).lastIndexOf('.');
  const ext = i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  return FILE_ICONS[EXT_CATEGORY[ext] || 'generic'];
}

// ─── User avatar (8×8) — a simple face for the desktop user widget ──
export const USER_AVATAR = S([
  '.AAAAAA.',
  'ADDDDDDA',
  'AD.DD.DA',
  'ADDDDDDA',
  'AD.DD.DA',
  'AD.AA.DA',
  'ADDDDDDA',
  '.AAAAAA.',
]);
