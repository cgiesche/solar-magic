// Where Mario died in recent test plays (core/deaths.ts), kept in the browser per project (core/projectid.ts) and level
// – the newest MAX_KEPT – until cleared; shown over the level as markers, with what killed him. Each carries
// the version of its level then (levelVersion): one from before the level was changed is shown as older.

import { hex2, hex3 } from '../core/names.ts';
import type { Rom } from '../core/rom.ts';
import type { Death, Killer } from '../core/deaths.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeLevelSprites } from '../core/level.ts';
import { hashBytes } from '../core/patchreg.ts';

const PREF = 'deaths:';
const MAX_KEPT = 100;

// version: levelVersion of its level when Mario died
export type DeathMark = Omit<Death, 'level'> & { version: number };

const key = (project: string, level: number) => `${PREF}${project}:${level}`;

// the level as saved in the ROM (header, objects, sprites), as a hash; -1 when it can't be read
const versions = new Map<number, { rom: Rom; gen: number; version: number }>();
export function levelVersion(rom: Rom, n: number): number {
  const v = versions.get(n);
  if (v && v.rom === rom && v.gen === rom.gen) return v.version;
  let version = -1;
  try {
    const lv = loadLevel(rom, n);
    const head = new TextEncoder().encode(JSON.stringify([lv.header, lv.secondary]));
    version = hashBytes([head, serializeLayer1(rom, lv), serializeLayer2(rom, lv) ?? new Uint8Array(0), serializeLevelSprites(rom, lv)]);
  } catch { /* not a level the editor reads */ }
  versions.set(n, { rom, gen: rom.gen, version });
  return version;
}
const cache = new Map<string, DeathMark[]>(); // by key, as stored (the level view asks on every paint)

export function loadDeaths(project: string, level: number): DeathMark[] {
  const k = key(project, level);
  let marks = cache.get(k);
  if (!marks) {
    try { marks = JSON.parse(localStorage.getItem(k) ?? '[]') as DeathMark[]; } catch { marks = []; }
    cache.set(k, marks);
  }
  return marks;
}

// version: levelVersion of the level Mario died in
export function addDeath(project: string, d: Death, version: number): void {
  const { level, ...rest } = d, k = key(project, level);
  const all = [...loadDeaths(project, level), { ...rest, version }].slice(-MAX_KEPT);
  cache.set(k, all);
  try { localStorage.setItem(k, JSON.stringify(all)); } catch { /* no storage */ }
}

export function clearDeaths(project: string, level: number): void {
  const k = key(project, level);
  cache.set(k, []);
  try { localStorage.removeItem(k); } catch { /* no storage */ }
}

// the deaths of every level of the ROM
export function clearAllDeaths(project: string): void {
  const pref = `${PREF}${project}:`;
  for (const k of cache.keys()) if (k.startsWith(pref)) cache.set(k, []);
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k?.startsWith(pref));
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* no storage */ }
}

// whether any level of the ROM has deaths kept
export function anyDeaths(project: string): boolean {
  const pref = `${PREF}${project}:`;
  try { return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some((k) => k?.startsWith(pref)); } catch { return false; }
}

// what killed Mario, for a sentence ("Killed by …"); name: a normal sprite's name by its id
export function killerText(k: Killer, name: (id: number) => string): string {
  switch (k.kind) {
    case 'sprite': return k.slots === 'sprite' ? name(k.id) : `${k.slots} sprite ${hex2(k.id)}`;
    case 'block': return `the block (tile ${hex3(k.tile)})`;
    case 'pit': return 'falling out of view';
    case 'time': return 'the timer running out';
    default: return 'something not recognised';
  }
}

// the tile the killer was in (none for a pit, the timer)
export function killerTile(k: Killer): { tx: number; ty: number } | null {
  if (k.kind === 'sprite') return { tx: (k.x + 8) >> 4, ty: (k.y + 8) >> 4 };
  if (k.kind === 'block') return { tx: k.tx, ty: k.ty };
  return null;
}
