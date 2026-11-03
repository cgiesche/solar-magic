// The layer 1 tiles an event reveals and destroys, edited with the event (the overworld editor's timeline, #339): an
// event reveals at most one tile (the game's reveal table, one entry per event) and destroys at most one (the destroy
// list, 0x18 entries in all); a reveal or destroy added beyond that is refused with the reason, not moved. A reveal
// turns the cell's tile into its counterpart of the reveal list: picking what it becomes may change the cell's tile on
// the map before events to the one the list turns into it.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, l1XY, revealAt, setRevealAt, revealEventCount, revealedTile, readRevealList, readDestroyList, writeDestroyList,
  destroySettingAt, DESTROYS, NO_EVENT, OW_EVENTS, OW_MAIN_TILES,
} from './overworld.ts';
import { l1Hex } from './owl1sheet.ts';
import { hex } from './names.ts';

// "main map 09,06": a layer 1 cell as the editor names it
export function cellText(i: number): string {
  const { x, y } = l1XY(i);
  return `${i >= OW_MAIN_TILES ? 'submaps' : 'main map'} ${hex(x, 2)},${hex(y, 2)}`;
}
export const NO_REVEAL_AT_0 = 'The top left tile of the main map can\'t be revealed (0 stands for none).';

// ---- reveals ----
// the cell event e reveals, -1 none
export function eventReveal(rom: Rom, e: number): number {
  return e < revealEventCount(rom) ? revealAt(rom, e) || -1 : -1;
}
// why event e can't reveal a tile (null: it can) – one tile per event, the events the reveal table has
export function revealRefusal(rom: Rom, e: number): string | null {
  const n = revealEventCount(rom);
  if (e >= n) return `Event ${hex(e, 2)} can't reveal a tile: the reveal table has events 00–${hex(n - 1, 2)}.`;
  const at = revealAt(rom, e);
  return at ? `An event reveals one tile: event ${hex(e, 2)} already reveals the tile at ${cellText(at)} – remove that first.` : null;
}
// the tile a cell holding t must hold to become `into` when revealed: t when it does, else a tile the reveal list turns
// into it (the game writes the low byte: the high byte stays), -1 none
export function revealSource(rom: Rom, t: number, into: number): number {
  if (revealedTile(rom, t) === into) return t;
  for (const p of readRevealList(rom)) {
    const f = (into & 0xff00) | p.from;
    if (p.to === (into & 0xff) && revealedTile(rom, f) === into) return f;
  }
  return -1;
}
// event e reveals cell i (l1Index), which becomes tile `into` (by default what its tile becomes): a cell whose tile
// doesn't become it gets the tile that does (revealSource) on the map before events. Throws the reason when refused.
export function addReveal(rom: Rom, e: number, i: number, into?: number): void {
  const why = revealRefusal(rom, e);
  if (why) throw new Error(why);
  if (!i) throw new Error(NO_REVEAL_AT_0);
  const l1 = readL1(rom), t = l1[i], to = into ?? revealedTile(rom, t);
  if (to < 0) throw new Error(`Tile ${l1Hex(t)} is not in the reveal list: revealing it changes nothing – pick the tile it becomes.`);
  const from = revealSource(rom, t, to);
  if (from < 0) throw new Error(`No tile becomes ${l1Hex(to)} when revealed: add it to the reveal list first.`);
  if (from !== t) { l1[i] = from; writeL1(rom, l1); }
  setRevealAt(rom, e, i);
}
// event e reveals no tile
export function removeReveal(rom: Rom, e: number): void {
  if (e < revealEventCount(rom)) setRevealAt(rom, e, 0);
}

// ---- destroys ----
// the cells event e destroys (one, unless the ROM's list has more)
export function eventDestroys(rom: Rom, e: number): number[] {
  return readDestroyList(rom).filter((d) => d.event === e).map((d) => d.tile);
}
// why event e can't destroy a tile (null: it can) – one tile per event, 0x18 in all
export function destroyRefusal(rom: Rom, e: number): string | null {
  if (e >= OW_EVENTS) return `Event ${hex(e, 2)} is past the last event (${hex(OW_EVENTS - 1, 2)}).`;
  const l = readDestroyList(rom), own = l.find((d) => d.event === e);
  if (own) return `An event destroys one tile: event ${hex(e, 2)} already destroys the tile at ${cellText(own.tile)} – remove that first.`;
  if (!l.some((d) => d.event === NO_EVENT)) return `All ${DESTROYS} destroyed level tiles of the game are used – remove one first.`;
  return null;
}
// the cell to set a destroy on for cell i clicked: i or the tile whose destroy changes it (a castle's level tile: its
// top), as the game may see it (destroySettingAt; shown: the map at the event progress, by default before events);
// -1: the game destroys no such tile, destroying it would change nothing
export function destroyTarget(rom: Rom, i: number, shown?: ArrayLike<number>): number {
  const l1 = readL1(rom);
  return destroySettingAt(rom, l1, shown ?? l1, i).at;
}
// event e destroys the tile clicked at cell i (set where destroyTarget says). Throws the reason when refused.
export function addDestroy(rom: Rom, e: number, i: number, shown?: ArrayLike<number>): void {
  const why = destroyRefusal(rom, e);
  if (why) throw new Error(why);
  const at = destroyTarget(rom, i, shown);
  if (at < 0) throw new Error(`The game destroys no tile ${l1Hex(readL1(rom)[i])}: destroying it would change nothing (castles, fortresses and switch palaces collapse).`);
  const l = readDestroyList(rom);
  l[l.findIndex((d) => d.event === NO_EVENT)] = { event: e, tile: at };
  writeDestroyList(rom, l);
}
// event e no longer destroys cell i
export function removeDestroy(rom: Rom, e: number, i: number): void {
  writeDestroyList(rom, readDestroyList(rom).map((d) => (d.event === e && d.tile === i ? { event: NO_EVENT, tile: 0 } : d)));
}
