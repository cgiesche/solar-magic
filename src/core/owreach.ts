// Path validation (CONTEXT.md "Reached tile"): which layer 1 tiles Mario can reach at an event progress, and
// what keeps him from others. A graph search over the path kinds learned by emulation (owpaths.ts) and the save
// at the event progress (layer 1 with its events applied, the level flags), following the game's rules for
// moving on the overworld ($049120…, checked by emulation in tools/testowreach.ts):
//
// - standing on a stop or level tile, Mario walks off in a direction its translevel's flags ($1EA2) open – tile 82
//   in any direction – when the tile next to him there is one he walks onto (owpaths: not "none");
// - stepping onto a path tile, its shape moves him and may turn him (owpaths.ts path shapes); from it he goes on
//   that way where he can, else the first of right, left, down, up (never back) with a tile he walks onto; with
//   none he is stuck (a dead end);
// - onto an exit path tile he leaves for the exit path entry of the pixel position his step onto it ends at
//   (owteleport.ts; none: he is stuck), is moved from its destination by the exit tile's vector (its way, not the
//   path's: across the path he comes out beside it, OffPath) and walks on from the tile it leads to; onto a stop or
//   level tile he stops, and its translevel's flag of the way back opens;
// - a star/pipe entry takes him from its tile (a star or pipe: 5B, 5F, 82) to its destination, a level's exit to the overworld that teleports
//   (Lunar Magic's) from the level's tiles to its location; put there he stands, walking off as from a stop tile – by
//   the flags of the tile's translevel, a path tile's 0 (stuckOnArrival);
// - with no tile next to him, the game's hardcoded paths ($049078: from a translevel, or a place of the main map,
//   in a direction, the steps and tiles of the way) – the game's own, not tiles of the map (not editable).
//
// The flags at an event progress are the save's there (owprogress.ts, learned by playing the events' levels); passing a
// level that runs no event opens nothing (revealwalk.ts: the game handles the exit enabling no direction, without the
// reveal walk). Flags only open, so the search runs until nothing more opens.

import { Rom, snesToPc } from './rom.ts';
import { isStarPipeTile, l1Index, l1XY, DIR_FLAGS, DIR_NAMES, exitDirections, translevelToLevel, MAX_TRANSLEVEL, initialFlags } from './overworld.ts';
import { readEvents, eventRunners, exitChanges, eventTitle, exitPassedOtherwise, type EventChanges, type EventRunner } from './owevents.ts';
import { hex2, hex3 } from './names.ts';
import type { Severity } from './problems.ts';
import { readTeleports, readExitPaths, starEntryAt, tileText, type OwTile } from './owteleport.ts';
import { DX, DY, PATH_TILES_END, dirOf, reverse, shapeVector, turnedAt, type PathKind, type PathShapes } from './owpaths.ts';

// the tile next to layer 1 tile i in direction dir on its map, -1 off the map
export function neighbor(i: number, dir: number): number {
  const { x, y } = l1XY(i), nx = x + DX[dir], ny = y + DY[dir];
  return nx < 0 || ny < 0 || nx > 31 || ny > 31 ? -1 : l1Index(i >> 10, nx, ny);
}

// directions in the order of DIR_NAMES / DIR_FLAGS: up, down, left, right
const TURNS = [3, 2, 1, 0]; // the game's order of trying another way: right, left, down, up
export const ANY_WAY_TILE = 0x82; // the game lets Mario walk off it in every direction ($049268)
const lowByte = (t: number) => t & 0xff;

const tileOf = (t: OwTile): number => l1Index(t.submap ? 1 : 0, t.x, t.y);

// a way of the game's own ($049078): from a tile of translevel `tl` (or, tl -1, from tile `at` of the main map)
// in direction `dir`, the tiles stepped onto (l1 index), the last where he stops (-1 for its tile: the map's)
export interface HardPath { tl: number; at: number; dir: number; steps: { dir: number; tile: number }[] }
const HP_FROM = 0x049078, HP_DIRS = 0x0490ca, HP_TILES = 0x049086, HP_START = 0x04910e, HP_Y = 0x049082, HP_X = 0x049084;
const HP_COUNT = 10, HP_STEPS = 0x44, HP_MAP_TILE = 0x58;
export function hardPaths(rom: Rom): HardPath[] {
  const d = rom.data, r8 = (a: number) => d[snesToPc(a)], dir = (y: number) => y >> 1; // (the game's 0, 2, 4, 6: up, down, left, right)
  return Array.from({ length: HP_COUNT }, (_, x) => {
    const from = r8(HP_FROM + x), a = r8(HP_START + x), b = x + 1 < HP_COUNT ? r8(HP_START + x + 1) : HP_STEPS;
    const steps = Array.from({ length: b - a }, (_, k) => ({ dir: dir(r8(HP_DIRS + a + k)), tile: r8(HP_TILES + a + k) }));
    const at = from === 0xff ? l1Index(0, rom.r16(HP_X) >> 4, rom.r16(HP_Y) >> 4) : -1;
    return { tl: from === 0xff ? -1 : from, at, dir: steps[0]?.dir ?? 0, steps: steps.map((s) => ({ dir: s.dir, tile: s.tile === HP_MAP_TILE ? -1 : s.tile })) };
  });
}

// What the search needs: layer 1 and the translevels as the game has them at the event progress (l1Index order),
// the level flags of the save (per translevel), the path kinds, where Mario starts, the links.
export interface ReachInput {
  l1: ArrayLike<number>;
  tls: ArrayLike<number>;
  flags: ArrayLike<number>;
  kinds: readonly PathKind[];
  shapes: PathShapes;
  start: number;
  stars: Map<number, number[]>; // star/pipe entries: from a tile to the tile it leads to (the entry the game finds)
  // exit path entries: the pixel position Mario leaves at (the region: main map 0, submaps 1), the pixel position and
  // tile he comes to
  exitPaths: { from: { region: number; x: number; y: number }; to: { x: number; y: number }; tile: number }[];
  hard: HardPath[];
  levelWarps?: (tl: number) => number[]; // the tiles a level's exits to the overworld teleport to
  // the tiles star/pipe entries and levels' exits lead to, as the entry stores them (its submap: in an overlap of
  // views the tile alone doesn't tell it), to name them (reachInput fills it; a level's as its teleports are asked –
  // arrivals asks them before they are named; two entries to one cell on different submaps: the last named)
  targets?: Map<number, OwTile>;
  ends?: (tile: number) => boolean; // stop tiles Mario goes no further from (no walk, star or teleport): the search ends there
}

// a way Mario takes from a stop tile in a direction: the tiles he walks over, where he stops (-1: stuck), coming in
// direction `dir`; stuck: the tile he is stuck on and why; offPath: the first exit path tile he comes out of off the
// path
export interface Walk { path: number[]; to: number; dir: number; stuck?: { at: number; why: 'end' | 'exit' | 'loop' }; offPath?: OffPath }
// An exit path tile Mario comes out of beside the path (CONTEXT.md "Path shape": an exit tile's way): the exit tile's
// vector moved him from the entry's destination to where no path tile leaves him – the tile's axis across the path into
// it (`across`: a vertical exit tile at the end of a horizontal path), or the entry's destination on another side of
// the tile it leads to than the one opposite to where he went in (a link's target side). The game warps him and he
// walks on, his pixel position beside his tile. at: the exit path tile, to: the tile led to, into: the direction he
// stepped onto it in, out: the one the exit tile's vector moves him in
export interface OffPath { at: number; to: number; into: number; out: number; across: boolean }

export interface Reach {
  tiles: Uint8Array; // per layer 1 tile: 1 Mario walks over it or stands on it
  stops: Set<number>; // the stop and level tiles he reaches
  walks: Map<number, Walk>; // by stop tile * 4 + direction: the ways he took
  flags: Uint8Array; // the level flags once every tile Mario gets to is reached
}

const MAX_STEPS = 0x1000;
// the last entry found (the game searches its tables from the last entry down)
function last<T>(a: T[], f: (v: T) => boolean): T | undefined {
  for (let k = a.length - 1; k >= 0; k--) if (f(a[k])) return a[k];
  return undefined;
}

// onStep: each path tile walked over by its shape (not an exit tile), with where Mario steps onto it and where its
// vector moves him (pixels in the tile), stepping on in direction dir and going on in direction out
export type WalkStep = (cell: number, from: [number, number], to: [number, number], dir: number, out: number) => void;
export function walkFrom(inp: ReachInput, from: number, d: number, onStep?: WalkStep): Walk | null {
  const { l1, kinds, shapes } = inp;
  const next = neighbor;
  const walkable = (i: number) => i >= 0 && kinds[l1[i]] !== 'none';
  const first = next(from, d);
  if (!walkable(first)) return hardWalk(inp, from, d);
  // Mario's pixel position (on his tile at +8, +8) after his first step
  const { x: sx, y: sy } = l1XY(from), [fx, fy] = shapeVector(shapes.first, l1[first], d, 8);
  let px = sx * 16 + 8 + fx, py = sy * 16 + 8 + fy;
  const path: number[] = [];
  let cur = from, dir = d, n = first, offPath: OffPath | undefined;
  for (let k = 0; k < MAX_STEPS; k++) {
    const kind = kinds[l1[n]];
    if (kind === 'level' || kind === 'stop') return { path, to: n, dir, offPath };
    path.push(n);
    if (kind === 'exit') {
      // the exit path entry of where his step onto it ended ($049A24: his pixel position, not the tile's – 4D's first
      // step off a stop ends where none is), then the exit tile's own vector from the entry's destination ($04971D, as
      // for a path tile looked ahead onto), turned by where it ends
      const r = n >> 10, e = last(inp.exitPaths, (p) => p.from.region === r && p.from.x === px && p.from.y === py);
      if (!e) return { path, to: -1, dir, stuck: { at: n, why: 'exit' }, offPath };
      const into = dir, [vx, vy] = shapeVector(shapes.walk, l1[n], dir, 16);
      cur = e.tile;
      px = (e.to.x + vx) & ~3; py = (e.to.y + vy) & ~3;
      dir = turnedAt(px, py, vx, vy, dir);
      const k2 = kinds[l1[cur]];
      if (k2 === 'level' || k2 === 'stop') return { path, to: cur, dir, offPath };
      // on the path where he ends at the edge of the tile led to that he goes on over, as a path tile leaves him
      const { x: tx, y: ty } = l1XY(cur);
      if (!offPath && (px !== tx * 16 + 8 + DX[dir] * 8 || py !== ty * 16 + 8 + DY[dir] * 8)) {
        offPath = { at: n, to: cur, into, out: dirOf(vx, vy, vx !== 0), across: (vx !== 0) !== (into >= 2) };
      }
      path.push(cur);
    } else {
      // moved by the tile's vector (the sum's low 2 bits cleared), turned by where it ends
      const [vx, vy] = shapeVector(shapes.walk, l1[n], dir, 16), was = [px, py], into = dir;
      px = (px + vx) & ~3; py = (py + vy) & ~3;
      dir = turnedAt(px, py, vx, vy, dir);
      cur = n;
      if (onStep) {
        const { x: cx, y: cy } = l1XY(n);
        onStep(n, [was[0] - cx * 16, was[1] - cy * 16], [px - cx * 16, py - cy * 16], into, dir);
      }
    }
    // the way he has first, else the first other one but back
    const ways = [dir, ...TURNS.filter((t) => t !== dir && t !== reverse(dir))];
    const w = ways.find((t) => walkable(next(cur, t)));
    if (w === undefined) return { path, to: -1, dir, stuck: { at: cur, why: 'end' }, offPath };
    dir = w;
    n = next(cur, w);
  }
  return { path, to: -1, dir, stuck: { at: cur, why: 'loop' }, offPath };
}

// The exit tile to put at exit path tile `at` that Mario, on way k (Reach.walks' key), comes out of off the path: the
// first exit tile (path kinds) with which he comes out on it – an exit tile of the path's axis, one where his step
// onto it ends where the link is taken (not 4D right off a stop) – of `used` (the map's own, in the order given),
// else the lowest tile number; -1 none (also where the link, not the tile, puts him beside the path)
export function exitTileFix(inp: ReachInput, k: number, at: number, used: readonly number[]): number {
  if (!walkFrom(inp, k >> 2, k & 3)?.offPath?.across) return -1;
  const exits = inp.kinds.flatMap((kind, t) => (kind === 'exit' ? [t] : []));
  const l1 = Array.from(inp.l1), was = l1[at];
  const fits = (t: number) => {
    l1[at] = t;
    const w = walkFrom({ ...inp, l1 }, k >> 2, k & 3);
    return !!w && w.path.includes(at) && w.offPath?.at !== at && !(w.stuck?.why === 'exit' && w.stuck.at === at);
  };
  return [...used.filter((t) => exits.includes(t)), ...exits].find((t) => t !== was && fits(t)) ?? -1;
}

// the game's hardcoded paths from tile `from` in direction d (none: null)
function hardWalk(inp: ReachInput, from: number, d: number): Walk | null {
  const tl = inp.tls[from];
  const hp = last(inp.hard, (p) => p.dir === d && (p.tl < 0 ? p.at === from : p.tl === tl && tl > 0));
  if (!hp) return null;
  const path: number[] = [];
  let cur = from;
  for (const s of hp.steps) {
    const n = neighbor(cur, s.dir);
    if (n < 0) return { path, to: -1, dir: s.dir, stuck: { at: cur, why: 'end' } };
    cur = n;
    const t = s.tile < 0 ? inp.l1[cur] : s.tile;
    if (t >= PATH_TILES_END) {
      const k = inp.kinds[t];
      return k === 'level' || k === 'stop' ? { path, to: cur, dir: s.dir } : { path, to: -1, dir: s.dir, stuck: { at: cur, why: 'end' } };
    }
    path.push(cur);
  }
  return { path, to: -1, dir: hp.steps.at(-1)?.dir ?? d, stuck: { at: cur, why: 'end' } };
}

export function reach(inp: ReachInput): Reach {
  const tiles = new Uint8Array(0x800), stops = new Set<number>(), walks = new Map<number, Walk>();
  const flags = Uint8Array.from({ length: MAX_TRANSLEVEL + 1 }, (_, k) => inp.flags[k] ?? 0);
  const queue: number[] = [];
  const open = (tl: number, f: number) => {
    if ((flags[tl] & f) === f) return;
    flags[tl] |= f;
    for (const s of stops) if (inp.tls[s] === tl) queue.push(s);
  };
  const stand = (i: number) => {
    tiles[i] = 1;
    if (stops.has(i)) return;
    stops.add(i);
    queue.push(i);
  };
  stand(inp.start);
  while (queue.length) {
    const s = queue.pop()!, tl = inp.tls[s];
    if (inp.ends?.(s)) continue;
    if (isStarPipeTile(inp.l1[s])) for (const to of inp.stars.get(s) ?? []) stand(to);
    if (tl) for (const to of inp.levelWarps?.(tl) ?? []) stand(to);
    for (let d = 0; d < 4; d++) {
      if (walks.has(s * 4 + d) || (lowByte(inp.l1[s]) !== ANY_WAY_TILE && !(flags[tl] & DIR_FLAGS[d]))) continue;
      const w = walkFrom(inp, s, d);
      if (!w) continue;
      walks.set(s * 4 + d, w);
      for (const i of w.path) tiles[i] = 1;
      if (w.to < 0) continue;
      stand(w.to);
      if (lowByte(inp.l1[w.to]) !== ANY_WAY_TILE) open(inp.tls[w.to], DIR_FLAGS[reverse(w.dir)]);
    }
  }
  return { tiles, stops, walks, flags };
}

// The ways Mario takes on from stop tile s in a search's result (reach): the tiles he passes (walked over, an exit
// path tile then the tile it leads to) and where he stops – walking off as the flags let him, a star or pipe, a
// level's exit teleporting
export function waysFrom(inp: ReachInput, r: Reach, s: number): { path: number[]; to: number }[] {
  const out: { path: number[]; to: number }[] = [];
  for (let d = 0; d < 4; d++) {
    const w = r.walks.get(s * 4 + d);
    if (w && w.to >= 0) out.push({ path: w.path, to: w.to });
  }
  if (isStarPipeTile(inp.l1[s])) for (const to of inp.stars.get(s) ?? []) out.push({ path: [], to });
  const tl = inp.tls[s];
  if (tl) for (const to of inp.levelWarps?.(tl) ?? []) out.push({ path: [], to });
  return out;
}

// ---- arriving standing ----

// Whether Mario, put standing on tile i – by a star/pipe link or a level's exit teleporting there, not walking in – can't
// do anything there (CONTEXT.md "Overworld link"; emulated in tools/testowlinks.ts): standing, the game lets him walk off
// only in a direction the level flags of the tile's translevel open ($049299: $7ED000, then $1EA2 – tile 82 any way),
// whatever the tile is; a path tile holds translevel 0, whose flags nothing opens in the clean game (with them opened
// he walks off a path tile too). A on a level tile enters its level, on a star or pipe with an entry warps (`back`: a
// link being made both ways gives it one). flags: the level flags (Reach.flags: once every tile he gets to is reached)
export function stuckOnArrival(inp: ReachInput, flags: ArrayLike<number>, i: number, back = false): boolean {
  const t = inp.l1[i];
  if (inp.kinds[t] === 'level' || (isStarPipeTile(t) && (back || inp.stars.has(i)))) return false;
  const open = lowByte(t) === ANY_WAY_TILE ? 0x0f : flags[inp.tls[i]] ?? 0;
  return ![0, 1, 2, 3].some((d) => open & DIR_FLAGS[d] && walkFrom(inp, i, d));
}

// Why Mario can't move arriving at tile i (stuckOnArrival; name: the tile's name), put there by a star/pipe link or
// a level's teleport (how): on a path tile (or one he doesn't walk on) – the link must lead to a tile he stops on –, or
// on a stop, star or pipe whose translevel's flags open no way off it
export function stuckOnArrivalText(inp: ReachInput, i: number, name: string, how: ArrivalHow): string {
  const t = inp.l1[i], k = inp.kinds[t], tl = inp.tls[i];
  if (k !== 'stop') {
    return `Mario arrives standing on ${k === 'none' ? 'a tile he doesn\'t walk on' : 'a path tile'} at ${name} and can't move – ${how === 'star' ? 'a star/pipe link' : 'an exit to the overworld\'s location'} must lead to a tile he stops on (a level, stop, star or pipe tile)`;
  }
  const what = lowByte(t) === STAR_TILE ? 'star' : isStarPipeTile(t) ? 'pipe' : 'stop tile';
  return `Mario arrives standing on the ${what} at ${name} and can't move: no way off it is open ${tl ? `(its translevel ${hex2(tl)}'s flags)` : '– it has no translevel of its own (translevel 00\'s flags, shared by every tile without one)'}`;
}

// how Mario is put somewhere standing: by a star/pipe link, by a level's exit to the overworld teleporting
export type ArrivalHow = 'star' | 'teleport';
// a tile a search takes Mario to standing (`at`: the star or pipe, or the level tile whose level's exit teleports)
export interface Arrival { at: number; to: number; how: ArrivalHow }
// why standing on a tile Mario can't move (the hover of the warnings)
export const ARRIVAL_RULE = 'Standing, Mario walks off only in the ways the level flags of his tile\'s translevel open (tile 82: any way) – a path tile has translevel 00, whose flags nothing opens; walking in by a path or an exit path he would walk on.';
const STAR_TILE = 0x5f; // (owstars.ts's, which imports this module)
export function arrivals(s: Reached): Arrival[] {
  const { inp, r } = s, out: Arrival[] = [];
  for (const at of r.stops) {
    const t = inp.l1[at], tl = inp.tls[at];
    if (isStarPipeTile(t)) for (const to of inp.stars.get(at) ?? []) out.push({ at, to, how: 'star' });
    if (tl && inp.kinds[t] === 'level') for (const to of inp.levelWarps?.(tl) ?? []) out.push({ at, to, how: 'teleport' });
  }
  return out;
}

// the problems of the tiles Mario arrives at standing and can't move on from (a warning, Links): one per tile, the
// first way there named
function arrivalProblems(s: Reached, place: (tile: number) => string): ReachProblem[] {
  const out = new Map<number, ReachProblem>();
  for (const a of arrivals(s)) {
    if (out.has(a.to) || !stuckOnArrival(s.inp, s.r.flags, a.to)) continue;
    const t = s.inp.targets?.get(a.to), name = t ? tileText(t) : place(a.to);
    const by = a.how === 'star' ? `The star or pipe at ${place(a.at)}` : `An exit to the overworld of the level at ${place(a.at)}`;
    out.set(a.to, { key: `arrival-stuck:${a.to}`, kind: 'arrival-stuck', severity: 'warn', tile: a.to, at: 'now',
      text: stuckOnArrivalText(s.inp, a.to, name, a.how),
      brief: `Mario stuck arriving at ${name}`,
      title: `${by} puts him there standing. ${ARRIVAL_RULE} Lead it to a level tile, a star, pipe or stop tile with a way off it open (a star or pipe 5B painted or a stop put by the route brush gets a translevel with its paths' ways, a pipe 82 is walked off any way; a stop tile painted by hand has none).` });
  }
  return [...out.values()];
}

// ---- the input at an event progress ----

// the input of the search for a ROM at an event progress: layer 1 and the translevels as the game has them there
// the ROM's exit path entries as a search (ReachInput.exitPaths) and the route solver (owroute.ts RouteInput) take them
export function exitPathEntries(rom: Rom): ReachInput['exitPaths'] {
  return readExitPaths(rom).flatMap((e) => {
    if (!e) return [];
    const tile = l1Index(e.to.submap ? 1 : 0, e.tile.x, e.tile.y);
    return [{ from: { region: e.from.submap ? 1 : 0, x: e.from.x, y: e.from.y }, to: { x: e.to.x, y: e.to.y }, tile }];
  });
}

// (gameL1 of the map loaded at it, its translevels), the level flags of the save there (owprogress.ts), the path
// kinds and Mario's start position; levelWarps: where the levels' exits to the overworld teleport (optional)
export function reachInput(rom: Rom, l1: ArrayLike<number>, tls: ArrayLike<number>, flags: ArrayLike<number>, kinds: readonly PathKind[],
  shapes: PathShapes, start: OwTile, levelWarps?: (tl: number) => OwTile[]): ReachInput {
  const stars = new Map<number, number[]>(), targets = new Map<number, OwTile>();
  readTeleports(rom).forEach((t, i, all) => {
    if (t.from && t.to && starEntryAt(all, t.from) === i) { stars.set(tileOf(t.from), [tileOf(t.to)]); targets.set(tileOf(t.to), t.to); } // the entry the game finds
  });
  const exitPaths = exitPathEntries(rom);
  return {
    l1, tls, flags, kinds, shapes, start: tileOf(start), stars, exitPaths, hard: hardPaths(rom), targets,
    levelWarps: levelWarps && ((tl) => levelWarps(tl).map((t) => { targets.set(tileOf(t), t); return tileOf(t); })),
  };
}

// The input with every event passed but event e (`all`: the input with every event passed): e's layer 1 changes undone
// (the tiles as on the map before events, `before`: readL1) and the way its levels' exits open closed in the level
// flags (the direction of each exit running e – runners: eventRunners' entry of e – unless open from the start, another
// exit of the level opens it too, or the same exit passes the level running another event: the level's own exit and an
// exit to the overworld with its own event, owevents.ts exitPassedOtherwise). `changes`: what e changes (eventChanges)
export function inputWithout(rom: Rom, all: ReachInput, changes: EventChanges, runners: readonly EventRunner[], before: ArrayLike<number>): ReachInput {
  const l1 = Uint16Array.from(all.l1), flags = Uint8Array.from(all.flags);
  for (const i of changes.l1) l1[i] = before[i];
  for (const r of runners) {
    const { tl, exit } = r, dirs = exitDirections(rom, tl), d = dirs[exit];
    if (exitPassedOtherwise(rom, r, changes.event)) continue;
    if (!dirs.some((o, x) => x !== exit && o === d)) flags[tl] &= ~(DIR_FLAGS[d] & ~initialFlags(rom, tl));
  }
  return { ...all, l1, flags };
}

// ---- problems ----

// a problem of the overworld's paths, at a layer 1 tile: its kind, found at the event progress shown (`at` now) or
// with every event passed (all); `key` its kind and place, the same while the problem stays (the World check compares
// lists by it); `brief` the problem in a few words, to go on in a sentence ("dead end at Main map 0C,09")
export type ReachKind = 'dead-end' | 'exit-nowhere' | 'exit-off-path' | 'arrival-stuck' | 'unreached-level' | 'event-reveals-nothing';
export type CheckSeverity = Exclude<Severity, 'info'>;
// way: the way it is found on (Reach.walks' key: stop tile * 4 + direction; an exit path tile Mario comes out of off
// the path)
export interface ReachProblem { key: string; kind: ReachKind; severity: CheckSeverity; text: string; brief: string; title?: string; tile: number; at: 'now' | 'all'; way?: number }
export interface Reached { inp: ReachInput; r: Reach }

const axisName = (alongX: boolean) => (alongX ? 'horizontal' : 'vertical');
// the problem of an exit path tile Mario comes out of off the path (Walk.offPath), found on way k (Reach.walks' key)
function offPathProblem(o: OffPath, k: number, place: (tile: number) => string): ReachProblem {
  const along = o.out >= 2, into = o.into >= 2;
  return { key: `exit-off-path:${o.at}`, kind: 'exit-off-path', severity: 'warn', tile: o.at, at: 'now', way: k,
    text: `Mario comes out of the exit at ${place(o.at)} walking ${DIR_NAMES[o.out]}, off the path (${o.across
      ? `the exit tile is ${axisName(along)}, the path into it ${axisName(into)}`
      : `the link puts him on another side of ${place(o.to)} than the one opposite to where he goes in`})`,
    brief: `exit at ${place(o.at)} leaving Mario off the path`,
    title: `After the warp the game moves Mario on by the exit tile's own way, from where the link puts him: here he walks beside the path, his position no longer on his tile (walking ${DIR_NAMES[k & 3]} from ${place(k >> 2)}).${o.across
      ? ' Use an exit tile of the path\'s axis (Fix).' : ' Link it with the target\'s side opposite to the source\'s (Links).'}` };
}

// the ways of a search that end nowhere (at: 'now'): a path without a stop tile at its end (a dead end), an exit path
// tile no exit path is taken from where Mario comes; and the exit path tiles Mario comes out of off the path and the
// tiles a star, pipe or level's teleport puts him on standing where he can't move (warnings); a tile several ways get
// stuck on (come out of) once (the first way named)
export function stuckProblems(s: Reached, place: (tile: number) => string): ReachProblem[] {
  const out = new Map<string, ReachProblem>();
  for (const [k, w] of s.r.walks) {
    if (w.offPath) { const p = offPathProblem(w.offPath, k, place); if (!out.has(p.key)) out.set(p.key, p); }
    if (!w.stuck) continue;
    const at = w.stuck.at, way = `walking ${DIR_NAMES[k & 3]} from ${place(k >> 2)}`;
    const p: ReachProblem = w.stuck.why === 'exit'
      ? { key: `exit-nowhere:${at}`, kind: 'exit-nowhere', severity: 'error', tile: at, at: 'now',
        text: `Exit path tile at ${place(at)} leads nowhere: Mario gets stuck ${way}`, brief: `exit path tile at ${place(at)} leading nowhere`,
        title: 'No exit path is taken from the side Mario comes from: link the tile to where it leads (Links).' }
      : { key: `dead-end:${at}`, kind: 'dead-end', severity: 'error', tile: at, at: 'now',
        text: `Dead end at ${place(at)}: Mario gets stuck ${way}`, brief: `dead end at ${place(at)}`,
        title: w.stuck.why === 'loop' ? 'The path goes round in a circle without a level or stop tile.' : 'The path ends without a level or stop tile: Mario has no way on.' };
    if (!out.has(p.key)) out.set(p.key, p);
  }
  for (const p of arrivalProblems(s, place)) out.set(p.key, p);
  return [...out.values()];
}

// The level tiles the clean game leaves unreached, by their level and place: level 019 at main map 03,19 and level 112
// at submaps 12,07 – no path, star, pipe or exit leads there even with every event passed (found by the search on the
// clean game: tools/testworldcheck.ts). A fixed list, not a comparison with a clean ROM: a level tile of the same level
// (whatever its layer 1 tile) at the same place unreached is a warning, not an error; moved elsewhere it is an error.
const CLEAN_UNREACHED: readonly { cell: number; level: number }[] = [
  { cell: l1Index(0, 0x03, 0x19), level: 0x019 },
  { cell: l1Index(1, 0x12, 0x07), level: 0x112 },
];
const unreachedInCleanGame = (cell: number, level: number): boolean => CLEAN_UNREACHED.some((u) => u.cell === cell && u.level === level);
// What keeps Mario from tiles: at the event progress shown (now) the ways that end nowhere (a path without a stop tile
// at its end, an exit path tile no exit path is taken from where Mario comes); with every event passed (all) the
// level tiles he reaches neither then nor now, and the level exits whose events change layer 1 only where he doesn't
// get (layer 1 with every event passed) – one the clean game leaves unreached there too only a warning
// (CLEAN_UNREACHED). (Level 112's event 43, destroying its tile 078, which has no destroy effect, changes nothing:
// eventChanges, #391 – no warning.)
// place: a tile's name ("Main map 0C,09"). A tile several ways get stuck on is one problem (the first way named).
export function reachProblems(rom: Rom, now: Reached, all: Reached, place: (tile: number) => string): ReachProblem[] {
  const out: ReachProblem[] = [];
  const keys = new Set<string>();
  const add = (p: ReachProblem) => { if (!keys.has(p.key)) { keys.add(p.key); out.push(p); } };
  for (const p of stuckProblems(now, place)) add(p);
  const { l1, tls, kinds } = all.inp;
  for (let i = 0; i < l1.length; i++) {
    if (kinds[l1[i]] !== 'level' || !tls[i] || all.r.stops.has(i)) continue;
    const level = translevelToLevel(tls[i]), asClean = unreachedInCleanGame(i, level);
    add({ key: `unreached-level:${i}`, kind: 'unreached-level', severity: asClean ? 'warn' : 'error', tile: i, at: 'all',
      text: asClean ? `Level ${hex3(level)} at ${place(i)} not reached – as in the original game` : `Level ${hex3(level)} at ${place(i)} can't be reached`,
      brief: `level ${hex3(level)} at ${place(i)} not reached`,
      title: `Not even with every event passed: no path, star, pipe or exit leads Mario there.${asClean ? '\nA warning: the original game has this level here, unreached too.' : ''}` });
  }
  const d = readEvents(rom), runners = eventRunners(rom);
  const tlsOnMap = [...new Set(Array.from(tls))].filter((tl) => tl).sort((a, b) => a - b);
  for (const tl of tlsOnMap) {
    for (const c of exitChanges(rom, tl, d, runners)) {
      // (the tiles Mario walks or stands on it changes; one changing scenery only is no path)
      const path = c.l1.filter((i) => kinds[l1[i]] !== 'none');
      if (!path.length || path.some((i) => all.r.tiles[i])) continue;
      add({ key: `event-reveals-nothing:${c.event}`, kind: 'event-reveals-nothing', severity: 'warn', tile: path[0], at: 'all',
        text: `${eventTitle(runners, c.event)}: its event reveals nothing Mario reaches`, brief: `event ${hex2(c.event)} revealing nothing reached`,
        title: `None of the path or level tiles event ${hex2(c.event)} changes is reached with every event passed.` });
    }
  }
  return out;
}
