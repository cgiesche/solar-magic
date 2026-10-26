// The user's names of things, so they are easy to find later: for now FG and BG Map16 tiles; other kinds
// (graphics files, levels …) are meant to join as further kinds. One name per thing at most, several
// things may share one (a multi-tile thing is named by naming all its tiles). Editor data, not part of the
// ROM image: kept with the working ROM and the project file, never in the playable ROM. One entry holding
// JSON: { v, kinds: { kind: { number in hex: name } } }. The caller makes the change one ROM edit.

import type { Rom } from './rom.ts';

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
