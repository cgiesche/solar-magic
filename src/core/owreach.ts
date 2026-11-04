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
// - onto an exit path tile he leaves for the exit path entry of where he is (owteleport.ts) and walks on from the
//   tile it leads to; onto a stop or level tile he stops, and its translevel's flag of the way back opens;
// - a star/pipe entry takes him from its tile (a star or pipe: 5B, 5F, 82) to its destination, a level's exit to the overworld that teleports
//   (Lunar Magic's) from the level's tiles to its location;
// - with no tile next to him, the game's hardcoded paths ($049078: from a translevel, or a place of the main map,
//   in a direction, the steps and tiles of the way) – the game's own, not tiles of the map (not editable).
//
// The flags at an event progress are the save's there (owprogress.ts, learned by playing the events' levels); a level
// that runs no event opens its normal exit's direction once Mario reaches it (passing it changes nothing else).
// Flags only open, so the search runs until nothing more opens.

import { Rom, snesToPc } from './rom.ts';
import { l1Index, l1XY, DIR_FLAGS, DIR_NAMES, NO_EVENT, baseEvent, exitDirections, translevelToLevel, MAX_TRANSLEVEL } from './overworld.ts';
import { readEvents, eventRunners, exitChanges, eventTitle } from './owevents.ts';
import { hex2, hex3 } from './names.ts';
import type { Severity } from './problems.ts';
import { readTeleports, readExitPaths, type OwTile } from './owteleport.ts';
import { DX, DY, PATH_TILES_END, dirOf, reverse, shapeVector, turnedAt, type PathKind, type PathShapes } from './owpaths.ts';

// the tile next to layer 1 tile i in direction dir on its map, -1 off the map
export function neighbor(i: number, dir: number): number {
  const { x, y } = l1XY(i), nx = x + DX[dir], ny = y + DY[dir];
  return nx < 0 || ny < 0 || nx > 31 || ny > 31 ? -1 : l1Index(i >> 10, nx, ny);
}

// directions in the order of DIR_NAMES / DIR_FLAGS: up, down, left, right
const TURNS = [3, 2, 1, 0]; // the game's order of trying another way: right, left, down, up
export const ANY_WAY_TILE = 0x82; // the game lets Mario walk off it in every direction ($049268)
export const WARP_TILES = [0x5b, 0x5f, 0x82]; // the tiles A takes Mario to a star/pipe entry's destination from ($04915E)
// (the game reads the tiles' low byte there, $7EC800: a tile 182 is one too)
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
  stars: Map<number, number[]>; // star/pipe entries: from a tile to the tiles they lead to
  // exit path entries: the pixel position Mario leaves at (the region: main map 0, submaps 1), the tile he comes to
  // and the direction he walks onto it in (-1: on as before)
  exitPaths: { from: { region: number; x: number; y: number }; to: { x: number; y: number }; tile: number; dir: number }[];
  hard: HardPath[];
  levelWarps?: (tl: number) => number[]; // the tiles a level's exits to the overworld teleport to
  noEvent?: (tl: number) => number; // a level running no event: the direction its normal exit opens (-1: it runs one)
}

// a way Mario takes from a stop tile in a direction: the tiles he walks over, where he stops (-1: stuck), coming in
// direction `dir`; stuck: the tile he is stuck on and why
export interface Walk { path: number[]; to: number; dir: number; stuck?: { at: number; why: 'end' | 'exit' | 'loop' } }

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

export function walkFrom(inp: ReachInput, from: number, d: number): Walk | null {
  const { l1, kinds, shapes } = inp;
  const next = neighbor;
  const walkable = (i: number) => i >= 0 && kinds[l1[i]] !== 'none';
  const first = next(from, d);
  if (!walkable(first)) return hardWalk(inp, from, d);
  // Mario's pixel position (on his tile at +8, +8) after his first step
  const { x: sx, y: sy } = l1XY(from), [fx, fy] = shapeVector(shapes.first, l1[first], d, 8);
  let px = sx * 16 + 8 + fx, py = sy * 16 + 8 + fy;
  const path: number[] = [];
  let cur = from, dir = d, n = first;
  for (let k = 0; k < MAX_STEPS; k++) {
    const kind = kinds[l1[n]];
    if (kind === 'level' || kind === 'stop') return { path, to: n, dir };
    path.push(n);
    if (kind === 'exit') {
      // (where he is: half a tile before it)
      const { x, y } = l1XY(n), ex = x * 16 + 8 - DX[dir] * 8, ey = y * 16 + 8 - DY[dir] * 8, r = n >> 10;
      const e = last(inp.exitPaths, (p) => p.from.region === r && p.from.x === ex && p.from.y === ey);
      if (!e) return { path, to: -1, dir, stuck: { at: n, why: 'exit' } };
      cur = e.tile;
      px = e.to.x; py = e.to.y;
      if (e.dir >= 0) dir = e.dir;
      const k2 = kinds[l1[cur]];
      if (k2 === 'level' || k2 === 'stop') return { path, to: cur, dir };
      path.push(cur);
    } else {
      // moved by the tile's vector (the sum's low 2 bits cleared), turned by where it ends
      const [vx, vy] = shapeVector(shapes.walk, l1[n], dir, 16);
      px = (px + vx) & ~3; py = (py + vy) & ~3;
      dir = turnedAt(px, py, vx, vy, dir);
      cur = n;
    }
    // the way he has first, else the first other one but back
    const ways = [dir, ...TURNS.filter((t) => t !== dir && t !== reverse(dir))];
    const w = ways.find((t) => walkable(next(cur, t)));
    if (w === undefined) return { path, to: -1, dir, stuck: { at: cur, why: 'end' } };
    dir = w;
    n = next(cur, w);
  }
  return { path, to: -1, dir, stuck: { at: cur, why: 'loop' } };
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
    const tl = inp.tls[i];
    const nd = tl ? inp.noEvent?.(tl) ?? -1 : -1;
    if (nd >= 0) open(tl, DIR_FLAGS[nd]);
  };
  stand(inp.start);
  while (queue.length) {
    const s = queue.pop()!, tl = inp.tls[s];
    if (WARP_TILES.includes(lowByte(inp.l1[s]))) for (const to of inp.stars.get(s) ?? []) stand(to);
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
  if (WARP_TILES.includes(lowByte(inp.l1[s]))) for (const to of inp.stars.get(s) ?? []) out.push({ path: [], to });
  const tl = inp.tls[s];
  if (tl) for (const to of inp.levelWarps?.(tl) ?? []) out.push({ path: [], to });
  return out;
}

// ---- the input at an event progress ----

// the input of the search for a ROM at an event progress: layer 1 and the translevels as the game has them there
// (gameL1 of the map loaded at it, its translevels), the level flags of the save there (owprogress.ts), the path
// kinds and Mario's start position; levelWarps: where the levels' exits to the overworld teleport (optional)
export function reachInput(rom: Rom, l1: ArrayLike<number>, tls: ArrayLike<number>, flags: ArrayLike<number>, kinds: readonly PathKind[],
  shapes: PathShapes, start: OwTile, levelWarps?: (tl: number) => OwTile[]): ReachInput {
  const stars = new Map<number, number[]>();
  for (const t of readTeleports(rom)) {
    if (!t.from || !t.to) continue;
    const f = tileOf(t.from);
    (stars.get(f) ?? stars.set(f, []).get(f)!).push(tileOf(t.to));
  }
  const exitPaths = readExitPaths(rom).flatMap((e) => {
    if (!e) return [];
    const tile = l1Index(e.to.submap ? 1 : 0, e.tile.x, e.tile.y), dx = e.tile.x * 16 + 8 - e.to.x, dy = e.tile.y * 16 + 8 - e.to.y;
    const dir = dx || dy ? dirOf(dx, dy, Math.abs(dx) > Math.abs(dy)) : -1;
    return [{ from: { region: e.from.submap ? 1 : 0, x: e.from.x, y: e.from.y }, to: { x: e.to.x, y: e.to.y }, tile, dir }];
  });
  const noEvent = (tl: number) => (baseEvent(rom, tl) === NO_EVENT ? exitDirections(rom, tl)[0] : -1);
  return {
    l1, tls, flags, kinds, shapes, start: tileOf(start), stars, exitPaths, hard: hardPaths(rom),
    levelWarps: levelWarps && ((tl) => levelWarps(tl).map(tileOf)), noEvent,
  };
}

// ---- problems ----

// a problem of the overworld's paths, at a layer 1 tile: its kind, found at the event progress shown (`at` now) or
// with every event passed (all); `key` its kind and place, the same while the problem stays (the World check compares
// lists by it)
export type ReachKind = 'dead-end' | 'exit-nowhere' | 'unreached-level' | 'event-reveals-nothing';
export type CheckSeverity = Exclude<Severity, 'info'>;
export interface ReachProblem { key: string; kind: ReachKind; severity: CheckSeverity; text: string; title?: string; tile: number; at: 'now' | 'all' }
export interface Reached { inp: ReachInput; r: Reach }

// What keeps Mario from tiles: at the event progress shown (now) the ways that end nowhere (a path without a stop tile
// at its end, an exit path tile no exit path is taken from where Mario comes); with every event passed (all) the
// level tiles he reaches neither then nor now, and the level exits whose events change layer 1 only where he doesn't
// get (layer 1 with every event passed). place: a tile's name ("Main map 0C,09"). A tile several ways get stuck on is
// one problem (the first way named).
export function reachProblems(rom: Rom, now: Reached, all: Reached, place: (tile: number) => string): ReachProblem[] {
  const out: ReachProblem[] = [];
  const keys = new Set<string>();
  const add = (p: ReachProblem) => { if (!keys.has(p.key)) { keys.add(p.key); out.push(p); } };
  for (const [k, w] of now.r.walks) {
    if (!w.stuck) continue;
    const at = w.stuck.at, way = `walking ${DIR_NAMES[k & 3]} from ${place(k >> 2)}`;
    add(w.stuck.why === 'exit'
      ? { key: `exit-nowhere:${at}`, kind: 'exit-nowhere', severity: 'error', tile: at, at: 'now',
        text: `Exit path tile at ${place(at)} leads nowhere: Mario gets stuck ${way}`,
        title: 'No exit path is taken from the side Mario comes from: link the tile to where it leads (Links).' }
      : { key: `dead-end:${at}`, kind: 'dead-end', severity: 'error', tile: at, at: 'now',
        text: `Dead end at ${place(at)}: Mario gets stuck ${way}`,
        title: w.stuck.why === 'loop' ? 'The path goes round in a circle without a level or stop tile.' : 'The path ends without a level or stop tile: Mario has no way on.' });
  }
  const { l1, tls, kinds } = all.inp;
  for (let i = 0; i < l1.length; i++) {
    if (kinds[l1[i]] !== 'level' || !tls[i] || all.r.stops.has(i)) continue;
    add({ key: `unreached-level:${i}`, kind: 'unreached-level', severity: 'error', tile: i, at: 'all',
      text: `Level ${hex3(translevelToLevel(tls[i]))} at ${place(i)} can't be reached`,
      title: 'Not even with every event passed: no path, star, pipe or exit leads Mario there.' });
  }
  const d = readEvents(rom), runners = eventRunners(rom);
  const tlsOnMap = [...new Set(Array.from(tls))].filter((tl) => tl).sort((a, b) => a - b);
  for (const tl of tlsOnMap) {
    for (const c of exitChanges(rom, tl, d, runners)) {
      // (the tiles Mario walks or stands on it changes; one changing scenery only is no path)
      const path = c.l1.filter((i) => kinds[l1[i]] !== 'none');
      if (!path.length || path.some((i) => all.r.tiles[i])) continue;
      add({ key: `event-reveals-nothing:${c.event}`, kind: 'event-reveals-nothing', severity: 'warn', tile: path[0], at: 'all',
        text: `${eventTitle(runners, c.event)}: its event reveals nothing Mario reaches`,
        title: `None of the path or level tiles event ${hex2(c.event)} changes is reached with every event passed.` });
    }
  }
  return out;
}
