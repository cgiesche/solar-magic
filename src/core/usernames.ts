// The user's names of things, so they are easy to find later: for now FG and BG Map16 tiles; other kinds
// (graphics files, levels …) are meant to join as further kinds (the graphics files' names are still the
// ROM's, gfxnames.ts). One name per thing at most, several things may share one (a multi-tile thing is
// named by naming all its tiles). Editor data, not part of the ROM image: kept with the working ROM and the
// project file, never in the playable ROM. One entry holding JSON: { v, kinds: { kind: { number in hex:
// name } } }. The caller makes the change one ROM edit.

import type { Rom } from './rom.ts';
import { hex3 } from './names.ts';

export type NameKind = 'fg' | 'bg';
export const NAME_MAX = 64;
const ID = 'names';
const VERSION = 1;

type Store = Record<string, Record<string, string>>;

function load(rom: Rom): Store {
  const b = rom.getBlob(ID);
  if (!b) return {};
  const j = JSON.parse(new TextDecoder().decode(b)) as { v: number; kinds: Store };
  if (j.v > VERSION) throw new Error('The names are from a newer editor version');
  return j.kinds;
}

function store(rom: Rom, kinds: Store): void {
  for (const k of Object.keys(kinds)) if (!Object.keys(kinds[k]).length) delete kinds[k];
  rom.setBlob(ID, Object.keys(kinds).length ? new TextEncoder().encode(JSON.stringify({ v: VERSION, kinds })) : null);
}

// a name as stored: trimmed, at most NAME_MAX characters ('' : none)
export function cleanName(name: string): string {
  return [...name.trim()].slice(0, NAME_MAX).join('').trim();
}

export function namesOf(rom: Rom, kind: NameKind): Map<number, string> {
  return new Map(Object.entries(load(rom)[kind] ?? {}).map(([k, v]) => [parseInt(k, 16), v]));
}

export function nameOf(rom: Rom, kind: NameKind, n: number): string | null {
  return load(rom)[kind]?.[n.toString(16)] ?? null;
}

// gives all of them the same name (an empty one removes theirs)
export function setName(rom: Rom, kind: NameKind, nums: Iterable<number>, name: string): void {
  const kinds = load(rom), v = cleanName(name), m = { ...kinds[kind] };
  for (const n of nums) if (v) m[n.toString(16)] = v; else delete m[n.toString(16)];
  kinds[kind] = m;
  store(rom, kinds);
}

// things taken to other numbers (from → to; the sources are the numbers before, so swaps work): each
// destination gets its source's name or none, a source no one moves onto is left without
export function moveNames(rom: Rom, kind: NameKind, map: Map<number, number>): void {
  const kinds = load(rom), old = kinds[kind] ?? {}, m = { ...old };
  for (const from of map.keys()) delete m[from.toString(16)];
  for (const [from, to] of map) {
    const v = old[from.toString(16)];
    if (v) m[to.toString(16)] = v; else delete m[to.toString(16)];
  }
  kinds[kind] = m;
  store(rom, kinds);
}

// the named things (central search): the numbers of each name ascending, the names in alphabetical order
export function nameGroups(names: Map<number, string>): { name: string; tiles: number[] }[] {
  const by = new Map<string, number[]>();
  for (const [n, v] of names) { const g = by.get(v); if (g) g.push(n); else by.set(v, [n]); }
  return [...by].map(([name, tiles]) => ({ name, tiles: tiles.sort((a, b) => a - b) })).sort((a, b) => a.name.localeCompare(b.name));
}

// the rectangle around the tiles on the sheet (16 per row) when they are connected side by side or one above
// another, else null
export function connectedRect(tiles: number[]): { first: number; w: number; h: number } | null {
  if (!tiles.length) return null;
  const set = new Set(tiles), seen = new Set([tiles[0]]), todo = [tiles[0]];
  while (todo.length) {
    const t = todo.pop()!;
    for (const n of [(t & 15) ? t - 1 : -1, (t & 15) < 15 ? t + 1 : -1, t - 16, t + 16]) {
      if (set.has(n) && !seen.has(n)) { seen.add(n); todo.push(n); }
    }
  }
  if (seen.size < set.size) return null;
  const xs = tiles.map((t) => t & 15), ys = tiles.map((t) => t >> 4);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { first: y0 * 16 + x0, w: Math.max(...xs) - x0 + 1, h: Math.max(...ys) - y0 + 1 };
}

// tile numbers (ascending) as shown: runs of consecutive ones as ranges, "210–212, 220"
export function tileRanges(tiles: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < tiles.length;) {
    let j = i;
    while (j + 1 < tiles.length && tiles[j + 1] === tiles[j] + 1) j++;
    out.push(j > i ? `${hex3(tiles[i])}–${hex3(tiles[j])}` : hex3(tiles[i]));
    i = j + 1;
  }
  return out.join(', ');
}
