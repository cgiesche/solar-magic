// Remap lists: changing 8x8 tile numbers, palettes and acts-like settings in bulk, in Lunar Magic's syntax
// (LM help: editor_16x16.htm, level_ex20_offset.htm), so its tutorials and habits carry over. A list is
// pairs "source,destination" separated by commas, one or more on a line (values hex):
//   100,25          tile 100 becomes 25          100-101,25     both become 25
//   100-101,+25     offset (also -25)            100-101,M125   moved to start at 125
//   R100-111,M25    a rectangle (16 tiles a row) of 8x8 tiles
//   P5-6,7          palettes 5-6 become 7        100-101,P7     these 8x8 tiles get palette 7
//   G100-101,+25    acts-like 100-101 of the tiles (also M, a value)
//   R200-211,S25    a rectangle of Map16 tiles gets a rectangle of acts-like settings from 25
// Sources always mean the values before the remap (100,25,25,100 swaps); a later pair for the same
// source supersedes an earlier one. Used by the Map16 tab and the Animations tab.

import type { ExSlot } from './exanim.ts';
import { kindOf, shapeOf } from './exanim.ts';

const hex3 = (v: number) => v.toString(16).toUpperCase().padStart(3, '0');

// what a list's values are, their limit and how a problem names it
type Domain = 'tiles' | 'pals' | 'acts' | 'map16';
const DOMAINS: Record<Domain, { max: number; name: string }> = {
  tiles: { max: 0x3ff, name: '8x8 tiles go up to 3FF' },
  pals: { max: 7, name: 'Palettes are 0–7' },
  acts: { max: 0x1ff, name: 'Acts-like settings go up to 1FF' },
  map16: { max: 0xfff, name: 'Map16 tiles go up to FFF' },
};
const TILE_MAX = DOMAINS.tiles.max;

export interface Remap {
  tiles: Map<number, number>; // 8x8 tile number → new number
  pals: Map<number, number>; // palette → palette
  tilePals: Map<number, number>; // 8x8 tile number (before) → its palette
  acts: Map<number, number>; // acts-like value → new value
  tileActs: Map<number, number>; // Map16 tile → acts-like value
  offset: number; // added to every 8x8 tile number the list leaves alone
}
type Into = Exclude<keyof Remap, 'offset'>;
const INTO_DOMAIN: Record<Into, Domain> = { tiles: 'tiles', pals: 'pals', tilePals: 'pals', acts: 'acts', tileActs: 'acts' };

// a bad pair: where in the text (from/to: the token, line: 0-based) and why
export interface RemapProblem { from: number; to: number; line: number; message: string }

export interface RemapOptions {
  offset?: number;
  // 'map16': everything; 'tiles': 8x8 tile numbers only (ExAnimation frames and targets)
  what?: 'map16' | 'tiles';
}

interface Token { text: string; from: number; to: number; line: number }

// the tokens of each line, between commas; empty ones skipped
function lineTokens(text: string): Token[][] {
  let at = 0;
  return text.split('\n').map((l, line) => {
    const out: Token[] = [];
    let start = 0;
    for (const part of l.split(',')) {
      const lead = part.length - part.trimStart().length, t = part.trim();
      if (t) out.push({ text: t, from: at + start + lead, to: at + start + lead + t.length, line });
      start += part.length + 1;
    }
    at += l.length + 1;
    return out;
  });
}

const HEX = /^[0-9a-f]+$/i;

// Unlike Lunar Magic, a pair never reaches over a line break: a line missing its destination is marked
// alone instead of shifting every pair below it, and a space between two values is a problem rather than
// one number.
export function parseRemap(text: string, opt: RemapOptions = {}): { remap: Remap; problems: RemapProblem[] } {
  const remap: Remap = { tiles: new Map(), pals: new Map(), tilePals: new Map(), acts: new Map(), tileActs: new Map(), offset: opt.offset ?? 0 };
  const problems: RemapProblem[] = [];
  const onlyTiles = opt.what === 'tiles';
  const fail = (t: Token, message: string) => { problems.push({ from: t.from, to: t.to, line: t.line, message }); };
  for (const toks of lineTokens(text)) {
    for (let i = 0; i < toks.length; i += 2) {
      const src = toks[i], dst = toks[i + 1];
      const spaced = [src, dst].find((t) => t && /\s/.test(t.text));
      if (spaced) { fail(spaced, 'A space between two values: separate them with a comma'); continue; }
      if (!dst) {
        // a bad source says so, else the destination is what is missing
        const alone = parsePair(src, { ...src, text: '0' }, onlyTiles);
        fail(src, typeof alone === 'string' ? alone : 'The destination is missing on this line (pairs are “source,destination”)');
        continue;
      }
      const pair = parsePair(src, dst, onlyTiles);
      if (typeof pair === 'string') { fail(src, pair); continue; }
      if ('dst' in pair) { fail(dst, pair.dst); continue; }
      for (const [a, b] of pair.map) remap[pair.into].set(a, b);
    }
  }
  return { remap, problems };
}

// one pair: the source values in order (a rectangle row by row, with each one's place in it) and what
// they become; a string is a problem with the source, { dst } one with the destination
function parsePair(src: Token, dst: Token, onlyTiles: boolean): string | { dst: string } | { map: [number, number][]; into: Into } {
  const s = src.text.toUpperCase(), d = dst.text.toUpperCase();
  const prefix = /^[PGR]/.test(s) ? s[0] : '';
  const onlyTilesHere = 'cannot be remapped here, only tile numbers';
  if (onlyTiles && (prefix === 'P' || prefix === 'G')) return `${prefix === 'P' ? 'Palettes' : 'Acts-like settings'} ${onlyTilesHere}`;
  const body = s.slice(prefix.length);
  const m = /^([^-]*)(?:-(.*))?$/.exec(body)!;
  const range = m[2] !== undefined;
  if (!HEX.test(m[1]) || (range && !HEX.test(m[2]))) {
    if (range && (m[1] === '' || m[2] === '')) return 'Incomplete range (e.g. 100-10F)';
    return `Not a source: “${src.text}” (hex values like 100, 100-10F, R100-11F, P5, G130)`;
  }
  const a = parseInt(m[1], 16), b = range ? parseInt(m[2], 16) : a;
  if (prefix === 'R' && !range) return 'A rectangle needs its top left and lower right tile (e.g. R100-111)';
  // destinations
  const dm = /^([+\-MPS]?)([0-9A-F]+)$/.exec(d);
  if (!dm) return { dst: `Not a destination: “${dst.text}” (a value, +n, -n, Mn${prefix === 'R' ? ', Sn' : ''}${prefix ? '' : ', Pn'})` };
  const op = dm[1], v = parseInt(dm[2], 16);
  if (op === 'S' && prefix !== 'R') return { dst: 'S (acts-like settings) needs a rectangle of Map16 tiles as source (e.g. R200-211,S25)' };
  if (op === 'P' && (prefix === 'P' || prefix === 'G')) return { dst: prefix === 'P' ? 'A palette becomes a palette: write the number alone (e.g. P5,7)' : 'P (palette) needs 8x8 tiles as source' };
  if (onlyTiles && (op === 'S' || op === 'P')) return { dst: `${op === 'P' ? 'Palettes' : 'Acts-like settings'} ${onlyTilesHere}` };
  const from = DOMAINS[prefix === 'P' ? 'pals' : prefix === 'G' ? 'acts' : op === 'S' ? 'map16' : 'tiles'];
  if (b > from.max || a > from.max) return from.name;
  if (b < a) return 'The range runs backwards (the smaller number first)';
  let cells: { v: number; k: number }[]; // source value, its offset from the source's start (rectangle: dy*16+dx)
  if (prefix === 'R') {
    if ((a & 15) > (b & 15)) return 'Not a rectangle: the lower right tile is left of the top left one';
    cells = [];
    for (let y = a >> 4; y <= b >> 4; y++) for (let x = a & 15; x <= (b & 15); x++) cells.push({ v: y * 16 + x, k: (y - (a >> 4)) * 16 + x - (a & 15) });
  } else cells = Array.from({ length: b - a + 1 }, (_, k) => ({ v: a + k, k }));
  const into: Into = op === 'S' ? 'tileActs' : op === 'P' ? 'tilePals' : prefix === 'P' ? 'pals' : prefix === 'G' ? 'acts' : 'tiles';
  const to = DOMAINS[INTO_DOMAIN[into]];
  const value = (c: { v: number; k: number }) => op === '+' ? c.v + v : op === '-' ? c.v - v : op === 'M' || op === 'S' ? v + c.k : v;
  const map = cells.map((c): [number, number] => [c.v, value(c)]);
  if (map.some(([, t]) => t < 0 || t > to.max)) return { dst: `${to.name}: ${op === '-' ? 'below 0' : 'too far'}` };
  return { map, into };
}

// a Map16 tile's words (and acts-like, null for BG tiles) after a remap; `out`: 8x8 tile numbers the offset
// would push out of 000–3FF (those stay)
export function remapTile(words: number[], acts: number | null, tile: number, r: Remap): { words: number[]; acts: number | null; out: number[] } {
  const out: number[] = [];
  const nw = words.map((w) => {
    const t = w & 0x3ff, p = (w >> 10) & 7;
    let nt = r.tiles.get(t);
    if (nt === undefined) {
      nt = t + r.offset;
      if (nt < 0 || nt > TILE_MAX) { out.push(t); nt = t; }
    }
    const np = r.tilePals.get(t) ?? r.pals.get(p) ?? p;
    return (w & 0xe000) | (np << 10) | nt;
  });
  const na = acts === null ? null : r.tileActs.get(tile) ?? r.acts.get(acts) ?? acts;
  return { words: nw, acts: na, out };
}

// an 8x8 tile number after a remap (null: the offset pushes it past max)
function remapNumber(t: number, r: Remap, max: number): number | null {
  const n = r.tiles.get(t) ?? t + r.offset;
  return n < 0 || n > max ? null : n;
}

// an ExAnimation slot after a remap: its frames (tiles of the animation graphic, up to frameMax for the
// frame's last tile) and its target (VRAM tile from the layer tiles' character base charWord); frames
// from RAM and color slots stay. `out`: what would leave the range (it stays).
export function remapSlot(e: ExSlot, r: Remap, charWord: number, what: { frames: boolean; target: boolean }, frameMax = TILE_MAX): { slot: ExSlot; out: string[] } {
  if (kindOf(e.type) !== 'tiles') return { slot: e, out: [] };
  const out: string[] = [];
  const alt = (e.dest & 0x8000) !== 0;
  const shape = shapeOf(e.type), per = shape.w * shape.h;
  let frames = e.frames, dest = e.dest;
  if (what.frames && alt) {
    frames = e.frames.map((f) => {
      const n = remapNumber(f >> 5, r, frameMax - per + 1);
      if (n === null) { out.push(`frame tile ${hex3(f >> 5)}`); return f; }
      return (n << 5) | (f & 31);
    });
  }
  if (what.target) {
    const t = ((e.dest & 0x7fff) - charWord) >> 4;
    const n = t >= 0 ? remapNumber(t, r, TILE_MAX) : null;
    if (n === null) out.push(`target tile ${hex3(t)}`);
    else dest = (e.dest & 0x8000) | ((charWord + n * 16) & 0x7fff);
  }
  return { slot: frames === e.frames && dest === e.dest ? e : { ...e, frames, dest }, out };
}

// the list line that moves a w×h block of 8x8 tiles from `from` to `to` (the visual mode writes these)
export function remapLine(from: number, w: number, h: number, to: number): string {
  if (w === 1 && h === 1) return `${hex3(from)},${hex3(to)}`;
  if (h === 1 || (w === 16 && !(from & 15))) return `${hex3(from)}-${hex3(from + (h - 1) * 16 + w - 1)},M${hex3(to)}`;
  return `R${hex3(from)}-${hex3(from + (h - 1) * 16 + w - 1)},M${hex3(to)}`;
}

// the line for a graphics file moved from the slot at `from` to the one at `to` (128 tiles each)
export function slotRemapLine(from: number, to: number): string {
  const d = to - from;
  return `${hex3(from)}-${hex3(from + 0x7f)},${d < 0 ? '-' : '+'}${hex3(Math.abs(d))}`;
}
