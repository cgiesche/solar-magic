// The layer 1 tiles an event reveals and destroys, edited with the event (the overworld editor's timeline, #339): an
// event reveals at most one tile (the game's reveal table, one entry per event) and destroys at most one (the destroy
// list, 0x18 entries in all); a reveal or destroy added beyond that is refused with the reason, not moved. A reveal
// turns the cell's tile into its counterpart of the reveal list: picking what it becomes may change the cell's tile on
// the map before events to the one the list turns into it.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, l1XY, revealAt, setRevealAt, revealEventCount, revealedTile, readRevealList, readDestroyList, writeDestroyList,
  destroySettingAt, destroySettings, baseEvent, DESTROYS, NO_EVENT, OW_EVENTS, OW_MAIN_TILES,
} from './overworld.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';
import { hex } from './names.ts';

// "main map 09,06": a layer 1 cell as the editor names it
export function cellText(i: number): string {
  const { x, y } = l1XY(i);
  return `${i >= OW_MAIN_TILES ? 'submaps' : 'main map'} ${hex(x, 2)},${hex(y, 2)}`;
}

// ---- reveals ----
// the cell event e reveals, -1 none
export function eventReveal(rom: Rom, e: number): number {
  return e < revealEventCount(rom) ? revealAt(rom, e) || -1 : -1;
}
// why event e can't reveal a tile (null: it can) – one tile per event, the events the reveal table has
export function revealRefusal(rom: Rom, e: number): OwRefusalData | null {
  const n = revealEventCount(rom);
  if (e >= n) return { kind: 'revealPastTable', event: e, events: n };
  const at = revealAt(rom, e);
  return at ? { kind: 'revealTaken', event: e, cell: at } : null;
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
// "+ Reveal"'s pick (#348): why event e can't reveal each cell clicked (null: it can – a cell whose tile the reveal list
// doesn't turn into the tile picked gets one that it does, addReveal)
export function revealPickCheck(rom: Rom, e: number): (i: number) => OwRefusalData | null {
  const why = revealRefusal(rom, e);
  return (i) => why ?? (i ? null : { kind: 'revealTopLeft' });
}
// event e reveals cell i (l1Index), which becomes tile `into` (by default what its tile becomes): a cell whose tile
// doesn't become it gets the tile that does (revealSource) on the map before events. Throws the refusal (OwRefusal).
export function addReveal(rom: Rom, e: number, i: number, into?: number): void {
  const why = revealPickCheck(rom, e)(i);
  if (why) throw new OwRefusal(why);
  const l1 = readL1(rom), t = l1[i], to = into ?? revealedTile(rom, t);
  if (to < 0) throw new OwRefusal({ kind: 'revealUnchanged', tile: t });
  const from = revealSource(rom, t, to);
  if (from < 0) throw new OwRefusal({ kind: 'revealNoSource', tile: to });
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
export function destroyRefusal(rom: Rom, e: number): OwRefusalData | null {
  if (e >= OW_EVENTS) return { kind: 'destroyPastEvents', event: e, events: OW_EVENTS };
  const l = readDestroyList(rom), own = l.find((d) => d.event === e);
  if (own) return { kind: 'destroyTaken', event: e, cell: own.tile };
  if (!l.some((d) => d.event === NO_EVENT)) return { kind: 'destroysFull', event: e, max: DESTROYS };
  return null;
}
// the cell to set a destroy on for cell i clicked: i or the tile whose destroy changes it (a castle's level tile: its
// top), as the game may see it (destroySettingAt; shown: the map at the event progress, by default before events);
// -1: the game destroys no such tile, destroying it would change nothing
export function destroyTarget(rom: Rom, i: number, shown?: ArrayLike<number>): number {
  const l1 = readL1(rom);
  return destroySettingAt(rom, l1, shown ?? l1, i).at;
}
// "+ Destroy"'s pick (#348): why event e can't destroy each cell clicked (null: it can) – a cell destroyTarget
// resolves; the ROM read once
export function destroyPickCheck(rom: Rom, e: number, shown?: ArrayLike<number>): (i: number) => OwRefusalData | null {
  const why = destroyRefusal(rom, e);
  if (why) return () => why;
  const l1 = readL1(rom), target = destroySettings(rom, l1, shown ?? l1);
  return (i) => (target(i).at < 0 ? { kind: 'destroyNothing', tile: l1[i] } : null);
}
// event e destroys the tile clicked at cell i (set where destroyTarget says). Throws the refusal (OwRefusal).
export function addDestroy(rom: Rom, e: number, i: number, shown?: ArrayLike<number>): void {
  const why = destroyPickCheck(rom, e, shown)(i);
  if (why) throw new OwRefusal(why);
  const at = destroyTarget(rom, i, shown);
  const l = readDestroyList(rom);
  l[l.findIndex((d) => d.event === NO_EVENT)] = { event: e, tile: at };
  writeDestroyList(rom, l);
}
// event e no longer destroys cell i
export function removeDestroy(rom: Rom, e: number, i: number): void {
  writeDestroyList(rom, readDestroyList(rom).map((d) => (d.event === e && d.tile === i ? { event: NO_EVENT, tile: 0 } : d)));
}

// ---- "Crumbles when beaten" (the Levels mode, #368) ----
// A level tile the game destroys – a castle by its top (the tile above, destroyTarget), a fortress or switch palace
// itself – crumbles when its level's normal exit is passed: a destroy of that cell in the level's base event. tl: the
// translevel the level tile at i enters; shown: the map as the game shows it (destroyTarget).
// whether it does (false without a base event)
export function crumbles(rom: Rom, i: number, tl: number, shown?: ArrayLike<number>): boolean {
  const e = baseEvent(rom, tl), at = destroyTarget(rom, i, shown);
  return e !== NO_EVENT && at >= 0 && eventDestroys(rom, e).includes(at);
}
// why it can't be made to crumble (null: it can, or it does): a tile the game doesn't destroy, a level whose normal
// exit runs no event, the event past the last one, its destroy taken or the destroy list full (the destroy patch is
// in every ROM the editor opens, ADR 0004)
export function crumbleRefusal(rom: Rom, i: number, tl: number, shown?: ArrayLike<number>): OwRefusalData | null {
  if (destroyTarget(rom, i, shown) < 0) return { kind: 'destroyNothing', tile: readL1(rom)[i] };
  const e = baseEvent(rom, tl);
  if (e === NO_EVENT) return { kind: 'crumbleNoEvent', tl };
  return crumbles(rom, i, tl, shown) ? null : destroyRefusal(rom, e);
}
// on: the destroy added (throws the refusal); off: removed
export function setCrumbles(rom: Rom, i: number, tl: number, on: boolean, shown?: ArrayLike<number>): void {
  if (on === crumbles(rom, i, tl, shown)) return;
  if (!on) { removeDestroy(rom, baseEvent(rom, tl), destroyTarget(rom, i, shown)); return; }
  const why = crumbleRefusal(rom, i, tl, shown);
  if (why) throw new OwRefusal(why);
  addDestroy(rom, baseEvent(rom, tl), i, shown);
}
