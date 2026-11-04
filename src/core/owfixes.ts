// Ways out of overworld refusals (#349, core/owrefusal.ts): each a write that makes the refused edit possible, offered
// in the refusal's toast and made with the edit in one ROM edit where the edit is one. Each says what it wrote.
//  - no reveal list pair gives the tile wanted: the change added to the list, in a pair that never applies (its tile
//    on no map, or one a later pair overrides);
//  - the link tables full: the entries nothing uses removed (a later entry has their tile, the game never finds
//    them; a location no entrance teleports to);
//  - no free layer 1 tile for a new look: a copy of tile 000 on a map (drawn and acting as 000) taken – its places
//    get 000 itself, so the tile is free.

import type { Rom } from './rom.ts';
import { readL1, writeL1, readRevealList, writeRevealList, revealedTile, owTileWords, OW_L1_TILES } from './overworld.ts';
import { readEvents, writeEvents } from './owevents.ts';
import { readTeleports, writeTeleport, readExitPaths, writeExitPath, starEntryAt, exitEntryAt } from './owteleport.ts';
import { locationUses, type LinkKind } from './owlinks.ts';
import { tilesOnMaps, l1Hex, emptyL1Tiles, freeL1Tiles } from './owl1sheet.ts';
import { OwRefusal } from './owrefusal.ts';
import type { PathKind } from './owpaths.ts';

// ---- the reveal list ----
// the pair of the reveal list that can take "t becomes into" (-1 none): t doesn't become another tile yet, both on the
// same page (the game writes the low byte), and a pair that never applies – no tile on a map has its tile (low byte),
// or a later pair has the same one (the game looks from the last pair down)
export function revealPairFor(rom: Rom, t: number, into: number): number {
  if (t >> 8 !== into >> 8 || (t & 0xff) === (into & 0xff)) return -1;
  const list = readRevealList(rom);
  if (list.some((p) => p.from === (t & 0xff))) return -1;
  const onMaps = new Set([...tilesOnMaps(rom)].map((v) => v & 0xff));
  return list.findIndex((p, k) => !onMaps.has(p.from) || list.slice(k + 1).some((q) => q.from === p.from));
}
// "t becomes into" written into the pair revealPairFor finds; throws when there is none
export function addRevealPair(rom: Rom, t: number, into: number): string {
  const k = revealPairFor(rom, t, into);
  if (k < 0) throw new RangeError(`no pair of the reveal list can take ${l1Hex(t)} → ${l1Hex(into)}`);
  const list = readRevealList(rom), was = list[k];
  list[k] = { from: t & 0xff, to: into & 0xff };
  writeRevealList(rom, list);
  return `Reveal list: tile ${l1Hex(t)} becomes ${l1Hex(into)} (pair ${k + 1}, was ${l1Hex(was.from)} → ${l1Hex(was.to)}, which never applied)`;
}

// ---- the link tables ----
// the entries of the star/pipe table (kind 'star') or the exit path table ('exit') nothing uses: one whose tile or
// position a later entry has too (the game searches from the last entry down: it never finds this one), and a
// location (an entry without a tile) no entrance teleports to; a location an entrance uses stays
export function unusedLinkEntries(rom: Rom, kind: LinkKind): number[] {
  if (kind === 'star') {
    const all = readTeleports(rom), kept = locationUses(rom);
    return all.flatMap((e, i) => (kept.has(i) || (!e.from && !e.to) || (e.from && starEntryAt(all, e.from) === i) ? [] : [i]));
  }
  const all = readExitPaths(rom);
  return all.flatMap((e, i) => (e && exitEntryAt(all, e.from) !== i ? [i] : []));
}
// the entries unusedLinkEntries gives removed
export function freeLinkEntries(rom: Rom, kind: LinkKind, entries: number[]): string {
  for (const i of entries) {
    if (kind === 'star') writeTeleport(rom, i, { from: null, to: null });
    else writeExitPath(rom, i, null);
  }
  return `${entries.length} unused ${kind === 'star' ? 'star/pipe' : 'exit path'} ${entries.length === 1 ? 'entry' : 'entries'} removed (nothing used ${entries.length === 1 ? 'it' : 'them'})`;
}

// ---- free layer 1 tiles ----
// the first free layer 1 tile (owl1sheet.ts) to give a new look; throws the refusal when there is none
export function newL1Tile(rom: Rom, kinds: readonly PathKind[]): number {
  const t = freeL1Tiles(emptyL1Tiles(rom), kinds).indexOf(true);
  if (t < 0) throw new OwRefusal({ kind: 'noFreeL1Tile', tiles: OW_L1_TILES });
  return t;
}
// the copies of tile 000 on a map (drawn as 000, acting as 000 where Mario walks, revealed into nothing and nothing
// revealed into them) – their places can hold 000 itself
export function tileCopiesOf000(rom: Rom, kinds: readonly PathKind[]): number[] {
  const zero = owTileWords(rom, 0), on = tilesOnMaps(rom), into = new Set(readRevealList(rom).map((p) => p.to));
  if (revealedTile(rom, 0) >= 0) return [];
  return [...on].filter((t) => t > 0 && t < OW_L1_TILES && kinds[t] === kinds[0] && revealedTile(rom, t) < 0 && !into.has(t & 0xff)
    && owTileWords(rom, t).every((w, q) => w === zero[q])).sort((a, b) => a - b);
}
// copy t of tile 000 taken: 000 in its places (layer 1 before events, the events' layer 1 tiles), so t is free
export function takeTileCopy(rom: Rom, t: number): string {
  const l1 = readL1(rom);
  let n = 0;
  l1.forEach((v, i) => { if (v === t) { l1[i] = 0; n++; } });
  writeL1(rom, l1);
  const d = readEvents(rom), silent = d.silent.map((s) => s.slice());
  for (const s of silent) s.forEach((x, k) => { if (x.layer === 1 && x.tile === t) { s[k] = { ...x, tile: 0 }; n++; } });
  if (silent.some((s, e) => s.some((x, k) => x !== d.silent[e][k]))) writeEvents(rom, { ...d, silent });
  return `Tile ${l1Hex(t)} is free: its ${n} ${n === 1 ? 'place holds' : 'places hold'} tile ${l1Hex(0)} now, which looks and acts the same`;
}
