// Overworld links (CONTEXT.md "Overworld link"): a star, pipe or exit path tile leading to another place of the
// overworld, one-way or both ways, and the locations exits to the overworld teleport to. Lunar Magic links two
// tiles by Alt+click and a dialog of table indexes; here a link is two tiles (and for an exit path tile the side
// its path goes on), the editor finds or assigns the entries (owteleport.ts: the star/pipe table, 0x100 entries,
// and the exit path table, 0x80). A link both ways is two entries, each leading to the other's tile.
//
// Exit paths, as the game's 14 show (checked by emulation, tools/testowlinks.ts): Mario standing on a tile is at its
// 16x16 block's +8,+8; walking onto an exit path tile he leaves when he is half a tile before it (on the side its
// path goes on), and comes out half a tile outside the tile he goes to (on the side away from its path), walking on.
//
// The Koopa Kids (Lunar Magic's "Koopa teleports"): Mario meeting one on tile 49, 4A or 4B and losing to it is put
// at one of 3 places of his submap afterwards (pixel X words at $048E49, Y words at $048E4F, the game's code at
// $048EBD), set the same way: from the tile to the place.

import type { Rom } from './rom.ts';
import {
  readTeleports, writeTeleport, readExitPaths, writeExitPath, TELEPORTS, EXIT_PATHS, type OwTile, type OwPos, type ExitPath, type Teleport,
} from './owteleport.ts';
import { readSecondaryEntrance } from './level.ts';

export type LinkKind = 'warp' | 'exit';
// a linked tile; for an exit path tile the side its path goes on (0 up, 1 down, 2 left, 3 right: DIR_NAMES)
export interface LinkEnd extends OwTile { side?: number }
// a → b, both: also b → a; entries: the table entries it is made of (a → b first)
export interface OwLink { kind: LinkKind; a: LinkEnd; b: LinkEnd; both: boolean; entries: number[] }

export const SIDES = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
export const opposite = (side: number): number => side ^ 1;
const same = (a: OwTile, b: OwTile) => a.submap === b.submap && a.x === b.x && a.y === b.y;
const samePos = (a: OwPos, b: OwPos) => a.submap === b.submap && a.x === b.x && a.y === b.y;

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
// where an exit path entry leads: its tile, the side Mario comes from (the tile's path on the other); null: the
// position isn't half a tile outside it (not one the editor makes – drawn at the tile)
function exitTarget(e: ExitPath): LinkEnd {
  const at = ends(e.to, false)?.find((c) => c.x === e.tile.x && c.y === e.tile.y);
  return at ?? { submap: e.to.submap, x: e.tile.x, y: e.tile.y };
}

// The links of the tables: an entry and the one leading back from its target (both ways), the star/pipe table's
// first, then the exit paths'. The tile an exit path is taken from is half a tile off where Mario is: the one an
// entry leads to (both ways), else the one `isExit` tells (an exit path tile), else the one after it.
export function readLinks(rom: Rom, isExit: (t: OwTile) => boolean = () => false): OwLink[] {
  const out: OwLink[] = [], warps = readTeleports(rom), exits = readExitPaths(rom);
  const done = new Set<number>();
  warps.forEach((w, i) => {
    if (!w.from || !w.to || done.has(i)) return;
    const back = warps.findIndex((v, j) => j !== i && !done.has(j) && v.from && v.to && same(v.from, w.to!) && same(v.to, w.from!));
    done.add(i);
    if (back >= 0) done.add(back);
    out.push({ kind: 'warp', a: { ...w.from }, b: { ...w.to }, both: back >= 0, entries: back >= 0 ? [i, back] : [i] });
  });
  const targets = exits.map((e) => e && exitTarget(e));
  const source = (i: number): LinkEnd => {
    const e = exits[i]!, c = ends(e.from, true);
    if (!c) return { submap: e.from.submap, x: e.from.x >> 4, y: e.from.y >> 4 };
    return c.find((t) => targets.some((b) => b && same(b, t))) ?? c.find(isExit) ?? c[1];
  };
  done.clear();
  exits.forEach((e, i) => {
    if (!e || done.has(i)) return;
    const a = source(i), b = targets[i]!;
    const back = exits.findIndex((v, j) => j !== i && !done.has(j) && v && same(targets[j]!, a) && same(source(j), b));
    done.add(i);
    if (back >= 0) done.add(back);
    out.push({ kind: 'exit', a, b: { ...b }, both: back >= 0, entries: back >= 0 ? [i, back] : [i] });
  });
  return out;
}

// the star/pipe entries secondary entrances to the overworld teleport to (Lunar Magic's location indexes), with the
// levels the entrances belong to
export function locationUses(rom: Rom): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < 0x200; i++) {
    const s = readSecondaryEntrance(rom, i), o = s.overworld;
    if (!o?.teleport) continue;
    const l = out.get(o.location) ?? out.set(o.location, []).get(o.location)!;
    if (!l.includes(s.destLevel)) l.push(s.destLevel);
  }
  return out;
}

// Links a to b (both: also b to a), replacing what a led to (and b, both ways): the entries a (and b) are taken from,
// else unused ones – star/pipe entries kept for the locations entrances teleport to (locationUses) aren't. Returns
// the link; throws when the table is full.
export function makeLink(rom: Rom, kind: LinkKind, a: LinkEnd, b: LinkEnd, both: boolean): OwLink {
  if (same(a, b)) throw new Error('A link leads to another tile');
  const entries = kind === 'warp' ? linkWarps(rom, a, b, both) : linkExits(rom, a, b, both);
  return { kind, a: { ...a }, b: { ...b }, both, entries };
}

function linkWarps(rom: Rom, a: OwTile, b: OwTile, both: boolean): number[] {
  const all = readTeleports(rom), kept = locationUses(rom), taken = new Set<number>();
  const write = (from: OwTile, to: OwTile): number => {
    let i = all.findIndex((t, k) => !taken.has(k) && t.from && same(t.from, from));
    if (i < 0) i = all.findIndex((t, k) => !taken.has(k) && !t.from && !t.to && !kept.has(k));
    if (i < 0) throw new Error(`Every one of the ${TELEPORTS} star/pipe entries is used`);
    taken.add(i);
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
  const all = readExitPaths(rom), taken = new Set<number>();
  const write = (from: LinkEnd, to: LinkEnd): number => {
    const e = exitEntry(from, to);
    let i = all.findIndex((x, k) => !taken.has(k) && x && samePos(x.from, e.from));
    if (i < 0) i = all.findIndex((x, k) => !taken.has(k) && !x);
    if (i < 0) throw new Error(`Every one of the ${EXIT_PATHS} exit path entries is used`);
    taken.add(i);
    writeExitPath(rom, i, e);
    all[i] = e;
    return i;
  };
  const out = [write(a, b)];
  if (both) out.push(write(b, a));
  return out;
}

// removes a link: its entries unused, a star/pipe entry an entrance teleports to kept as that location
export function removeLink(rom: Rom, l: OwLink): void {
  const kept = l.kind === 'warp' ? locationUses(rom) : new Map<number, number[]>();
  for (const i of l.entries) {
    if (l.kind === 'exit') writeExitPath(rom, i, null);
    else writeTeleport(rom, i, { from: null, to: kept.has(i) ? readTeleports(rom)[i].to : null });
  }
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
// moves location i (an entry of the star/pipe table) to tile `to`: a star or pipe leading there leads there too
export function moveLocation(rom: Rom, i: number, to: OwTile): void {
  const t = readTeleports(rom)[i];
  writeTeleport(rom, i, { from: t.from, to: { submap: to.submap, x: to.x, y: to.y } });
}

// ---- Koopa Kids ----
export const KOOPA_X = 0x048e49, KOOPA_Y = 0x048e4f, KOOPAS = 3;
export const KOOPA_TILE = 0x49; // the tile of the first; the others the next ones
// where Mario is put after losing to Koopa Kid k, a tile of his submap (null: none, the game's 0,0)
export function koopaTeleport(rom: Rom, k: number): { x: number; y: number } | null {
  const x = rom.r16(KOOPA_X + k * 2), y = rom.r16(KOOPA_Y + k * 2);
  return x || y ? { x: x >> 4, y: y >> 4 } : null;
}
export function setKoopaTeleport(rom: Rom, k: number, t: { x: number; y: number } | null): void {
  rom.w16(KOOPA_X + k * 2, t ? t.x * 16 + 8 : 0);
  rom.w16(KOOPA_Y + k * 2, t ? t.y * 16 + 8 : 0);
}
