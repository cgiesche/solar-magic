// Where Mario died in recent test plays (core/deaths.ts), kept in the browser per ROM (by its name) and level
// – the newest MAX_KEPT – until cleared; shown over the level as markers, with what killed him.

import { hex2, hex3 } from '../core/names.ts';
import type { Death, Killer } from '../core/deaths.ts';

const PREF = 'deaths:';
const MAX_KEPT = 100;

export type DeathMark = Omit<Death, 'level'>;

const key = (rom: string, level: number) => `${PREF}${rom}:${level}`;
const cache = new Map<string, DeathMark[]>(); // by key, as stored (the level view asks on every paint)

export function loadDeaths(rom: string, level: number): DeathMark[] {
  const k = key(rom, level);
  let marks = cache.get(k);
  if (!marks) {
    try { marks = JSON.parse(localStorage.getItem(k) ?? '[]') as DeathMark[]; } catch { marks = []; }
    cache.set(k, marks);
  }
  return marks;
}

export function addDeath(rom: string, d: Death): void {
  const { level, ...mark } = d, k = key(rom, level);
  const all = [...loadDeaths(rom, level), mark].slice(-MAX_KEPT);
  cache.set(k, all);
  try { localStorage.setItem(k, JSON.stringify(all)); } catch { /* no storage */ }
}

export function clearDeaths(rom: string, level: number): void {
  const k = key(rom, level);
  cache.set(k, []);
  try { localStorage.removeItem(k); } catch { /* no storage */ }
}

// what killed Mario, for a sentence ("Killed by …"); name: a normal sprite's name by its id
export function killerText(k: Killer, name: (id: number) => string): string {
  switch (k.kind) {
    case 'sprite': return k.slots === 'sprite' ? name(k.id) : `${k.slots} sprite ${hex2(k.id)}`;
    case 'block': return `the block (tile ${hex3(k.tile)})`;
    case 'pit': return 'falling out of the screen';
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
