// Overworld links (CONTEXT.md "Overworld link"): a star, pipe or exit path tile leading to another place of the
// overworld, one-way or both ways, the locations exits to the overworld teleport to and the Koopa Kids' places.
// Lunar Magic links two
// tiles by Alt+click and a dialog of table indexes; here a link is two tiles (and for an exit path tile the side
// its path goes on), the editor finds or assigns the entries (owteleport.ts: the star/pipe table, 0x100 entries,
// and the exit path table, 0x80). A link both ways is two entries, each leading to the other's tile.
//
// Exit paths, as the game's 14 show (checked by emulation, tools/testowlinks.ts): Mario standing on a tile is at its
// 16x16 block's +8,+8; walking onto an exit path tile he leaves when he is half a tile before it (on the side its
// path goes on), and comes out half a tile outside the tile he goes to (on the side away from its path). The game then
// moves him on by the source exit tile's own vector ($04971D), never by the target's side: only the side opposite to
// the source's puts him on his tile (docs/research/overworld-submap-exit-tiles.md), so a link made here has the
// target's side derived from the source's (linkedTarget), not chosen. A ROM's own pair of other sides is read as it is
// (the World check's exit-off-path warning tells it).
//
// The Koopa Kids (Lunar Magic's "Koopa teleports"): Mario meeting one on tile 49, 4A or 4B and losing to it is put
// at one of 3 places of his submap afterwards (pixel X words at $048E49, Y words at $048E4F, the game's code at
// $048EBD), set the same way: from the tile to the place.

import type { Rom } from './rom.ts';
import {
  readTeleports, writeTeleport, readExitPaths, writeExitPath, sameTile as same, starEntryAt, exitEntryAt, tileText, TELEPORTS, EXIT_PATHS, type OwTile, type OwPos, type ExitPath, type Teleport,
} from './owteleport.ts';
import { readSecondaryEntrance, levelTranslevel } from './level.ts';
import type { ExitGraph } from './exitgraph.ts';
import { NO_SHAPE, dirOf, type PathKind, type PathShapes } from './owpaths.ts';
import { cellsBecoming } from './owevents.ts';
import { DIR_NAMES, readL1, l1Index, l1XY } from './overworld.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';

const SECONDARY_ENTRANCES = 0x200;

export type LinkKind = 'star' | 'exit'; // a star/pipe entry, an exit path entry
// a linked tile; for an exit path tile the side its path goes on (0 up, 1 down, 2 left, 3 right: DIR_NAMES)
export interface LinkEnd extends OwTile { side?: number }
// a → b, both: also b → a; entries: the table entries it is made of (a → b first)
export interface OwLink { kind: LinkKind; a: LinkEnd; b: LinkEnd; both: boolean; entries: number[] }

export const SIDES = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
export const opposite = (side: number): number => side ^ 1;
// an exit path link's target with its side derived from the source's: the opposite one (the only one putting Mario on
// his tile – the game moves him on by the source tile's vector, whatever the target's side)
export const linkedTarget = (a: LinkEnd, b: LinkEnd): LinkEnd => ({ ...b, side: opposite(a.side ?? 0) });
// whether an exit path link's target side is the one derived from its source's (linkedTarget); a ROM's own may not be
export const sidesMatch = (l: OwLink): boolean => l.kind !== 'exit' || (l.b.side ?? 0) === opposite(l.a.side ?? 0);

// Where Mario comes out of exit path tile `from` (the tile number `tile`, stepped onto from the side its path goes on)
// on the tile it leads to: the side of `to` he appears at (away from its path, DIR_NAMES order) and the direction the
// tile's learned "walk" vector moves him on in (null: not learned – shapes null, or no vector for that way)
export interface ExitOut { side: number; walk: number | null }
export function exitOut(from: LinkEnd, to: LinkEnd, tile: number, shapes: PathShapes | null): ExitOut {
  const into = opposite(from.side ?? 0), k = (tile * 4 + into) * 2, vx = shapes?.walk[k], vy = shapes?.walk[k + 1];
  const walk = vx === undefined || vy === undefined || vx === NO_SHAPE || (vx === 0 && vy === 0) ? null : dirOf(vx, vy, vx !== 0);
  return { side: opposite(to.side ?? 0), walk };
}
// the side words of DIR_NAMES order, of a tile: "above Yoshi's Island 04,00"
const SIDE_WORDS = ['above', 'below', 'left of', 'right of'];
// exitOut in words: "Mario comes out above Yoshi's Island 04,00, walking down" (`toText`: the target's name)
export const exitOutText = (o: ExitOut, toText: string): string =>
  `Mario comes out ${SIDE_WORDS[o.side]} ${toText}${o.walk === null ? '' : `, walking ${DIR_NAMES[o.walk]}`}`;

// ---- exit path entries ↔ tiles ----
const stand = (t: OwTile, side: number, d: number): OwPos => ({ submap: t.submap, x: t.x * 16 + 8 + SIDES[side][0] * d, y: t.y * 16 + 8 + SIDES[side][1] * d });
// the entry of an exit path from a to b
export const exitEntry = (a: LinkEnd, b: LinkEnd): ExitPath => ({ from: stand(a, a.side ?? 0, 8), to: stand(b, b.side ?? 0, -8), tile: { x: b.x, y: b.y } });
// the tile and side a position half a tile off a tile's center is at (`toward`: from the tile toward the position; else
// away from it), both tiles it can be on; null: no such position
function ends(p: OwPos, toward: boolean): [LinkEnd, LinkEnd] | null {
  const ox = (p.x - 8) & 15, oy = (p.y - 8) & 15;
  if (oy === 0 && ox === 8) { // between two tiles side by side
    const l = { submap: p.submap, x: (p.x - 16) >> 4, y: (p.y - 8) >> 4 }, r = { ...l, x: l.x + 1 };
    return toward ? [{ ...l, side: 3 }, { ...r, side: 2 }] : [{ ...l, side: 2 }, { ...r, side: 3 }];
  }
  if (ox === 0 && oy === 8) {
    const u = { submap: p.submap, x: (p.x - 8) >> 4, y: (p.y - 16) >> 4 }, d = { ...u, y: u.y + 1 };
    return toward ? [{ ...u, side: 1 }, { ...d, side: 0 }] : [{ ...u, side: 0 }, { ...d, side: 1 }];
  }
  return null;
}
// where an exit path entry leads: its tile with the side its path goes on (Mario comes out on the other); without a
// side where the position isn't half a tile outside it (not one the editor makes)
function exitTarget(e: ExitPath): LinkEnd {
  const at = ends(e.to, false)?.find((c) => c.x === e.tile.x && c.y === e.tile.y);
  return at ?? { submap: e.to.submap, x: e.tile.x, y: e.tile.y };
}

// The links of the tables: an entry and the one leading back from its target (both ways), the star/pipe table's
// first, then the exit paths'; of an entry the game never finds (starEntryAt, exitEntryAt: a later one has its tile)
// none. The tile an exit path is taken from is half a tile off where Mario is: the one an entry leads to (both ways),
// else the one `isExit` tells (an exit path tile), else the one after it.
export function readLinks(rom: Rom, isExit: (t: OwTile) => boolean = () => false): OwLink[] {
  const out: OwLink[] = [], warps = readTeleports(rom), exits = readExitPaths(rom);
  const done = new Set<number>();
  warps.forEach((w, i) => {
    if (!w.from || !w.to || done.has(i) || starEntryAt(warps, w.from) !== i) return;
    const j = starEntryAt(warps, w.to), v = warps[j], back = j !== i && !done.has(j) && v?.to && same(v.to, w.from) ? j : -1;
    done.add(i);
    if (back >= 0) done.add(back);
    out.push({ kind: 'star', a: { ...w.from }, b: { ...w.to }, both: back >= 0, entries: back >= 0 ? [i, back] : [i] });
  });
  const targets = exits.map((e) => e && exitTarget(e));
  const source = (i: number): LinkEnd => {
    const e = exits[i]!, c = ends(e.from, true);
    if (!c) return { submap: e.from.submap, x: e.from.x >> 4, y: e.from.y >> 4 };
    return c.find((t) => targets.some((b) => b && same(b, t))) ?? c.find(isExit) ?? c[1];
  };
  done.clear();
  const gameFinds = (i: number) => exitEntryAt(exits, exits[i]!.from) === i;
  exits.forEach((e, i) => {
    if (!e || done.has(i) || !gameFinds(i)) return;
    const a = source(i), b = targets[i]!;
    const back = exits.findIndex((v, j) => j !== i && !done.has(j) && v && gameFinds(j) && same(targets[j]!, a) && same(source(j), b));
    done.add(i);
    if (back >= 0) done.add(back);
    out.push({ kind: 'exit', a, b: { ...b }, both: back >= 0, entries: back >= 0 ? [i, back] : [i] });
  });
  return out;
}

// the star/pipe entries secondary entrances to the overworld teleport to (Lunar Magic's location indexes), with the
// entrances
export function locationUses(rom: Rom): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < SECONDARY_ENTRANCES; i++) {
    const o = readSecondaryEntrance(rom, i).overworld;
    if (o?.teleport) (out.get(o.location) ?? out.set(o.location, []).get(o.location)!).push(i);
  }
  return out;
}

// Links a to tile `to` (both: also back), replacing what a led to (and `to`, both ways): the entries a (and `to`) are
// taken from, else unused ones; an exit path's target with its side derived from a's (linkedTarget: `to`'s own side
// is not read). A star/pipe entry entrances teleport to (locationUses) stays their location where it was: the tile
// gets another entry. Returns the link (its target as linked); throws when the table is full.
export function makeLink(rom: Rom, kind: LinkKind, a: LinkEnd, to: LinkEnd, both: boolean): OwLink {
  const why = linkCheck(rom, kind, both)(a, to);
  const b = kind === 'exit' ? linkedTarget(a, to) : to;
  if (why) throw new OwRefusal(why);
  const entries = kind === 'star' ? linkStars(rom, a, b, both) : linkExits(rom, a, b, both);
  return { kind, a: { ...a }, b: { ...b }, both, entries };
}

// The cells a star/pipe link may start from (#455): those where A warps (path kind 'warp', as learned: kinds) at some
// event progress – on the map before events, revealed or put by an event – the game's table being keyed by the cell. Not
// a level tile (A enters its level) nor a plain stop tile (A does nothing) that is never a star or pipe.
export function warpCells(rom: Rom, kinds: readonly PathKind[]): Set<number> {
  return cellsBecoming(rom, (t) => kinds[t] === 'warp');
}

const NOT_ITSELF: OwRefusalData = { kind: 'linkToItself' };
const starsFull: OwRefusalData = { kind: 'teleportsFull', max: TELEPORTS };
const exitsFull: OwRefusalData = { kind: 'exitPathsFull', max: EXIT_PATHS };
// why a link of `kind` (both: also back) can't lead from a to b (null: it can, as makeLink makes it, an exit path's
// target side derived: linkedTarget): b is another tile, and the entries it needs are free – a's and b's own reused
// (a star's that a location keeps leading elsewhere not); replacing: the link it replaces, removed first (removeLink:
// its entries free again, a location's kept). The ROM read once (#348: the tiles hatched while a link's end is
// dragged).
export function linkCheck(rom: Rom, kind: LinkKind, both: boolean, replacing: OwLink | null = null): (a: LinkEnd, b: LinkEnd) => OwRefusalData | null {
  let free: number, needs: (from: LinkEnd, to: LinkEnd) => number, full: OwRefusalData;
  const gone = new Set(replacing?.kind === kind ? replacing.entries : []);
  if (kind === 'star') {
    const kept = locationUses(rom), all = readTeleports(rom).map((t, k): Teleport => (gone.has(k) ? { from: null, to: kept.has(k) ? t.to : null } : t));
    free = all.filter((t, k) => !t.from && !t.to && !kept.has(k)).length;
    needs = (from, to) => { const i = starEntryAt(all, from); return i < 0 || (kept.has(i) && !same(all[i].to!, to)) ? 1 : 0; };
    full = starsFull;
  } else {
    const all = readExitPaths(rom).map((x, k) => (gone.has(k) ? null : x));
    free = all.filter((x) => !x).length;
    needs = (from, to) => (exitEntryAt(all, exitEntry(from, to).from) >= 0 ? 0 : 1);
    full = exitsFull;
  }
  return (a, to) => {
    const b = kind === 'exit' ? linkedTarget(a, to) : to;
    return same(a, b) ? NOT_ITSELF : needs(a, b) + (both ? needs(b, a) : 0) > free ? full : null;
  };
}
// why a Koopa Kid on tile `from` can't put Mario at tile `to` (null: it can): a place of the submap of its tile
export function koopaPlaceRefusal(from: OwTile, to: OwTile): OwRefusalData | null {
  return to.submap !== from.submap ? { kind: 'koopaPlaceSubmap', from: { ...from } } : null;
}
// why location i (a star/pipe entry exits to the overworld teleport to) can't be moved (null: it can, moveLocation): a
// star's or pipe's entry the game finds (starEntryAt) needs a free one to keep leading where it does
export function locationMoveRefusal(rom: Rom, i: number): OwRefusalData | null {
  const all = readTeleports(rom), t = all[i];
  if (!t.from || !t.to || starEntryAt(all, t.from) !== i) return null;
  const kept = locationUses(rom);
  return all.some((e, n) => !e.from && !e.to && !kept.has(n)) ? null : { kind: 'locationsFull', max: TELEPORTS };
}

// star/pipe entry k unused (in the ROM and `all`), one a location an entrance teleports to (`kept`) staying that location
function unsetStar(rom: Rom, all: Teleport[], kept: Map<number, number[]>, k: number): void {
  all[k] = { from: null, to: kept.has(k) ? all[k].to : null };
  writeTeleport(rom, k, all[k]);
}
// every star/pipe entry of tile `from` unused (unsetStar), the earlier ones the game never found too
function unsetStarsOf(rom: Rom, all: Teleport[], kept: Map<number, number[]>, from: OwTile): void {
  for (let k; (k = starEntryAt(all, from)) >= 0;) unsetStar(rom, all, kept, k);
}
// every exit path entry of position `from` unused, the earlier ones the game never found too
function unsetExitsOf(rom: Rom, all: (ExitPath | null)[], from: OwPos): void {
  for (let k; (k = exitEntryAt(all, from)) >= 0;) { writeExitPath(rom, k, null); all[k] = null; }
}

// the entry of a tile is the one the game finds (starEntryAt); one taken anew for it is the last: the tile's earlier
// entries (the game never found them) lose it, a location's staying the location
function linkStars(rom: Rom, a: OwTile, b: OwTile, both: boolean): number[] {
  const all = readTeleports(rom), kept = locationUses(rom);
  const write = (from: OwTile, to: OwTile): number => {
    let i = starEntryAt(all, from);
    if (i >= 0 && kept.has(i) && !same(all[i].to!, to)) { unsetStar(rom, all, kept, i); i = -1; }
    if (i < 0) {
      i = all.findIndex((t, k) => !t.from && !t.to && !kept.has(k));
      if (i < 0) throw new OwRefusal(starsFull);
      unsetStarsOf(rom, all, kept, from);
    }
    const e: Teleport = { from: { submap: from.submap, x: from.x, y: from.y }, to: { submap: to.submap, x: to.x, y: to.y } };
    writeTeleport(rom, i, e);
    all[i] = e;
    return i;
  };
  const out = [write(a, b)];
  if (both) out.push(write(b, a));
  return out;
}

function linkExits(rom: Rom, a: LinkEnd, b: LinkEnd, both: boolean): number[] {
  const all = readExitPaths(rom);
  const write = (from: LinkEnd, to: LinkEnd): number => {
    const e = exitEntry(from, to);
    let i = exitEntryAt(all, e.from);
    if (i < 0) i = all.findIndex((x) => !x);
    if (i < 0) throw new OwRefusal(exitsFull);
    writeExitPath(rom, i, e);
    all[i] = e;
    return i;
  };
  const out = [write(a, b)];
  if (both) out.push(write(b, a));
  return out;
}

// removes a link: its entries unused, a star/pipe entry an entrance teleports to kept as that location; so are the
// earlier entries of its tiles the game never found (else the game would find one now: the tile still leading there)
export function removeLink(rom: Rom, l: OwLink): void {
  if (l.kind === 'exit') {
    const all = readExitPaths(rom);
    for (const i of l.entries) { const from = all[i]?.from; writeExitPath(rom, i, null); all[i] = null; if (from) unsetExitsOf(rom, all, from); }
    return;
  }
  const kept = locationUses(rom), all = readTeleports(rom);
  for (const i of l.entries) { const from = all[i].from; unsetStar(rom, all, kept, i); if (from) unsetStarsOf(rom, all, kept, from); }
}

// a link made one-way (a → b only) or both ways again
export function setBothWays(rom: Rom, l: OwLink, both: boolean): OwLink {
  if (both === l.both) return l;
  if (!both) { removeLink(rom, { ...l, a: l.b, b: l.a, entries: l.entries.slice(1) }); return { ...l, both, entries: l.entries.slice(0, 1) }; }
  return makeLink(rom, l.kind, l.a, l.b, true);
}

// the side an exit path tile's path goes on: toward a tile `isPath` tells (Mario walks there), else away from the
// map's nearest edge (32x32 tiles)
export function pathSide(t: OwTile, isPath: (x: number, y: number) => boolean): number {
  const on = (s: number) => { const x = t.x + SIDES[s][0], y = t.y + SIDES[s][1]; return x >= 0 && y >= 0 && x < 32 && y < 32 && isPath(x, y); };
  const s = [0, 1, 2, 3].find(on);
  if (s !== undefined) return s;
  const edge = [t.y, 31 - t.y, t.x, 31 - t.x];
  return opposite(edge.indexOf(Math.min(...edge)));
}

// ---- the locations exits to the overworld teleport to ----
// moves location i (an entry of the star/pipe table) to tile `to`; a star or pipe whose entry the game finds it is keeps
// leading where it did, in another entry – the tile's last: its earlier entries (never found) lose it (throws when the
// table is full). The entry of a star the game never finds just loses its tile.
export function moveLocation(rom: Rom, i: number, to: OwTile): void {
  const why = locationMoveRefusal(rom, i);
  if (why) throw new OwRefusal(why);
  const all = readTeleports(rom), t = all[i], kept = locationUses(rom);
  const star = t.from && t.to && starEntryAt(all, t.from) === i ? all.findIndex((e, n) => !e.from && !e.to && !kept.has(n)) : -1;
  all[i] = { from: null, to: { submap: to.submap, x: to.x, y: to.y } };
  writeTeleport(rom, i, all[i]);
  if (star < 0) return;
  unsetStarsOf(rom, all, kept, t.from!);
  writeTeleport(rom, star, t);
}

// the locations the exits of translevel tl's levels (it and its sub-levels) teleport to through entrances to the
// overworld: the location, where it is, the entrance and its action (level.ts OW_ACTIONS)
export interface LevelTeleport { location: number; to: OwTile; entrance: number; action: number }
export function levelTeleports(rom: Rom, graph: ExitGraph, tl: number): LevelTeleport[] {
  const all = readTeleports(rom), tlOf = new Map<number, number>(), out: LevelTeleport[] = [];
  for (const [location, ents] of locationUses(rom)) {
    const to = all[location].to;
    if (!to) continue;
    for (const entrance of ents) {
      const ours = graph.usersOfEntrance(entrance).some((r) => (tlOf.get(r.from) ?? tlOf.set(r.from, levelTranslevel(rom, r.from)).get(r.from)) === tl);
      if (ours) out.push({ location, to, entrance, action: readSecondaryEntrance(rom, entrance).overworld!.action });
    }
  }
  return out;
}

// ---- Koopa Kids ----
export const KOOPA_X = 0x048e49, KOOPA_Y = 0x048e4f, KOOPAS = 3;
export const KOOPA_TILE = 0x49; // the tile of the first; the others the next ones
// the Koopa Kid whose tile layer 1 tile t is (-1 none): the game reads the low byte ($7EC800), 149 is one too
export function koopaOfTile(t: number): number { const k = (t & 0xff) - KOOPA_TILE; return k >= 0 && k < KOOPAS ? k : -1; }
// where Mario is put after losing to Koopa Kid k, a tile of his submap – the one of its tile (null: none, the game's 0,0)
export function koopaTeleport(rom: Rom, k: number): { x: number; y: number } | null {
  const x = rom.r16(KOOPA_X + k * 2), y = rom.r16(KOOPA_Y + k * 2);
  return x || y ? { x: x >> 4, y: y >> 4 } : null;
}
export function setKoopaTeleport(rom: Rom, k: number, t: { x: number; y: number } | null): void {
  rom.w16(KOOPA_X + k * 2, t ? t.x * 16 + 8 : 0);
  rom.w16(KOOPA_Y + k * 2, t ? t.y * 16 + 8 : 0);
}

// ---- link ends as objects on layer 1 (#413) ----
// what ends at a layer 1 cell, each with a mark there (owlinkview.ts): an end of a star/pipe link or exit path, a
// location exits to the overworld teleport to (teleports index), a Koopa Kid's tile with a place, Koopa Kid k's place
export type LinkMark = { kind: 'link'; link: OwLink } | { kind: 'location'; i: number } | { kind: 'koopaTile'; k: number } | { kind: 'koopaPlace'; k: number };
// The layer 1 cells (l1Index) a link ends at, with what ends there (in this order: links, locations, Koopa Kids): both
// ends of every star/pipe and exit path link, the locations exits to the overworld teleport to, the tile of a Koopa Kid
// with a place on `l1` and that place (on the tile's region)
export function linkMarks(rom: Rom, l1: ArrayLike<number>, links: readonly OwLink[] = readLinks(rom)): Map<number, LinkMark[]> {
  const out = new Map<number, LinkMark[]>(), cell = (t: OwTile) => l1Index(t.submap ? 1 : 0, t.x, t.y);
  const put = (i: number, m: LinkMark) => (out.get(i) ?? out.set(i, []).get(i)!).push(m);
  for (const link of links) { put(cell(link.a), { kind: 'link', link }); if (cell(link.b) !== cell(link.a)) put(cell(link.b), { kind: 'link', link }); }
  const all = readTeleports(rom);
  for (const [i] of locationUses(rom)) { const to = all[i].to; if (to) put(cell(to), { kind: 'location', i }); }
  const placed = new Set<number>();
  for (let i = 0; i < 0x800; i++) {
    const k = koopaOfTile(l1[i]), p = k >= 0 ? koopaTeleport(rom, k) : null;
    if (!p) continue;
    put(i, { kind: 'koopaTile', k });
    const at = l1Index(i >> 10, p.x, p.y), key = at * KOOPAS + k;
    if (!placed.has(key)) { placed.add(key); put(at, { kind: 'koopaPlace', k }); }
  }
  return out;
}
// The layer 1 cells (l1Index) a link ends at (linkMarks). Painting and the route brush leave them alone; a level tile
// moved takes them along (moveLinkEnds).
export function linkEndCells(rom: Rom, l1: ArrayLike<number>, links: readonly OwLink[] = readLinks(rom)): Set<number> {
  return new Set(linkMarks(rom, l1, links).keys());
}

// The link ends at layer 1 cells `from` and `to` (l1Index, one region) swapped, as a level tile moved there swaps with
// the tile there: every star/pipe entry's and location's tile, exit path entry's position (Mario half a tile off its
// tile) and Koopa Kid's place at one cell put at the other, on the same submap. `links`: as readLinks reads them (the
// sources of exit paths). One ROM edit's work.
export function moveLinkEnds(rom: Rom, from: number, to: number, links: readonly OwLink[] = readLinks(rom)): void {
  if (from === to || (from & 0x400) !== (to & 0x400)) return;
  const A = l1XY(from), B = l1XY(to);
  const other = (t: { x: number; y: number }): { x: number; y: number } | null =>
    t.x === A.x && t.y === A.y ? B : t.x === B.x && t.y === B.y ? A : null;
  const region = (s: number) => (s ? 0x400 : 0) === (from & 0x400);
  // star/pipe entries and locations: their tiles
  readTeleports(rom).forEach((e, i) => {
    const f = e.from && region(e.from.submap) ? other(e.from) : null, t = e.to && region(e.to.submap) ? other(e.to) : null;
    if (f || t) writeTeleport(rom, i, { from: e.from && (f ? { ...e.from, ...f } : e.from), to: e.to && (t ? { ...e.to, ...t } : e.to) });
  });
  // exit path entries: shifted with the tile they leave from or lead to
  const exits = readExitPaths(rom), shift = (p: OwPos, n: { x: number; y: number }, o: OwTile): OwPos => ({ ...p, x: p.x + (n.x - o.x) * 16, y: p.y + (n.y - o.y) * 16 });
  const moved = new Map<number, ExitPath>();
  for (const l of links) {
    if (l.kind !== 'exit') continue;
    l.entries.forEach((i, k) => {
      const e = moved.get(i) ?? exits[i];
      if (!e) return;
      const src = k ? l.b : l.a, dst = k ? l.a : l.b;
      const ns = region(src.submap) ? other(src) : null, nd = region(dst.submap) ? other(dst) : null;
      if (!ns && !nd) return;
      moved.set(i, { from: ns ? shift(e.from, ns, src) : e.from, to: nd ? shift(e.to, nd, dst) : e.to, tile: nd ?? e.tile });
    });
  }
  for (const [i, e] of moved) writeExitPath(rom, i, e);
  // the Koopa Kids' places (on the region of their tiles)
  const l1 = readL1(rom), base = from & 0x400;
  for (let k = 0; k < KOOPAS; k++) {
    let ours = false;
    for (let i = base; i < base + 0x400 && !ours; i++) ours = koopaOfTile(l1[i]) === k;
    const p = ours ? koopaTeleport(rom, k) : null, n = p && other(p);
    if (n) setKoopaTeleport(rom, k, n);
  }
}
