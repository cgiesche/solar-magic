// Route solving (CONTEXT.md "Route"): the layer 1 tiles for a way Mario is to walk – a sequence of cells next to each
// other on one map – chosen among the path tiles whose shapes are learned (owpaths.ts, owpathshape.ts tileWays), or
// the first cell no tile fits, with why and what would work there. Pure: nothing written.
//
// Each cell gets a tile whose way leads from the cell before to the cell after, both ways: Mario steps onto a tile
// at a point of its side, its vector moves him to a point of another side and turns him there (the way), and from
// there its vector for the way back leads him back to where he stepped on. A way starts where the tile before left
// him – so a stair leaves the tiles after it higher or lower –, the first one where his first step off the stop tile
// before leaves him (a vector of its own, owpaths.ts), and the last one ends where his first step off the stop tile
// after leaves him, walking back: the walk there and the walk back are each other's mirror, as the game's own paths.
//
// Level tiles, stop tiles and exit tiles on the route are left alone, Mario stops there (an exit only at an end: it
// takes him to another submap). A stop tile goes where the route ends on no stop or level tile, and where it runs
// into a path already there (the cell's tile leads on to a cell off the route Mario walks onto): the junction, as in
// the game. A path tile the route runs along is replaced, kept where it fits.
//
// A stop tile put gets a translevel no tile holds and without name, base event or messages (a stop never takes one
// with them, the route is refused instead): standing on a stop, Mario walks off only in
// the directions its translevel's flags ($1EA2) open, and coming onto it opens only the way back – a stop with
// translevel 0 shares the flags of every such tile, so at a junction he could not walk on. Its initial flags (Lunar
// Magic's table, every new game) open the ways the stop has: the route's and those of the path it runs into.

import { DX, DY, PATH_TILES_END, reverse, shapeVector, type PathKind, type PathShapes } from './owpaths.ts';
import { neighbor } from './owreach.ts';
import { tileWays, WALKED_KINDS, type PathWay } from './owpathshape.ts';
import { stopTile, levelsWithoutTile, heldElsewhere, type LevelTileEvent } from './owleveltiles.ts';
import type { Rom } from './rom.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';
import {
  readL1, writeL1, readTranslevels, writeTranslevels, setExitDirection, setInitialFlags, translevelUse, hasNameEventOrMessages, freeTranslevel, resetTranslevel,
  DIR_FLAGS, MAX_TRANSLEVEL, isStarPipeTile,
} from './overworld.ts';
import { readEvents, writeEvents, paintEventL1, eventRunners } from './owevents.ts';

// What the solver needs: layer 1 as it is (l1Index order: the route's cells, the paths it may run into), the path
// kinds and shapes, the kind of path to use where a tile of it fits (the kind at the route's start), the stop tile to
// put (default: owleveltiles.ts stopTile), route cells (indices into the route) to make stop tiles anyway, and the
// translevels as in the ROM (stopTranslevels: a stop tile put on a cell without one takes a free one – refused where
// none is left; without them not checked).
export interface RouteInput {
  l1: ArrayLike<number>;
  kinds: readonly PathKind[];
  shapes: PathShapes;
  prefer: PathKind;
  stop?: number;
  stops?: ReadonlySet<number>;
  through?: ReadonlySet<number>; // route cells (indices) whose stop tile becomes a path tile (routeEnds' through)
  stopTranslevels?: StopTranslevels;
}

// each layer 1 tile's translevel (tls) and those a new stop tile may take (free): no tile holds them and they have
// no name, base event or messages (hasNameEventOrMessages) – a level without level tile keeps them for a tile placed
// later, and a stop taking it would erase them; kept: how many without level tile are left out for that
export interface StopTranslevels { tls: ArrayLike<number>; free: readonly number[]; kept: number }
export function stopTranslevels(rom: Rom, tls: ArrayLike<number> = readTranslevels(rom)): StopTranslevels {
  const without = levelsWithoutTile(tls), free = without.filter((tl) => !hasNameEventOrMessages(rom, tl));
  return { tls, free, kept: without.length - free.length };
}
const noTranslevel = (t: StopTranslevels): OwRefusalData => ({ kind: 'routeNoTranslevel', max: MAX_TRANSLEVEL, kept: t.kept });

// The first cell no tile fits: its index in the route and its layer 1 cell, why (as data, worded by ui/owrefusal.ts),
// and what would work instead – a stop
// tile there (stop), or the route turning another way there (turns: the directions some tile leads him on in).
export interface RouteRefusal { at: number; cell: number; why: OwRefusalData; stop: boolean; turns: number[] }

// A stop tile the route puts: its first index in the route, its cell, the directions Mario walks off it in (the
// route's, the ways of the path tile there before – the path the route runs into).
export interface RouteStop { at: number; cell: number; dirs: number[] }

// Per route cell the tile to write (null: left alone – a level, stop or exit tile, or a cell of the route after a
// refusal), the stop tiles put (none on a refusal), and the refusal (null: every cell fits).
// through: the cells whose stop tile becomes a path tile (RouteInput through), their translevels freed when written.
export interface RouteTiles { tiles: (number | null)[]; stops: RouteStop[]; refusal: RouteRefusal | null; through?: number[] }

// what a cell of the route is: left alone (Mario stops or exits there), a stop tile to put, a path tile to find
type Role = 'keep' | 'stop' | 'path';

// the kind of path a route prefers: the kind at its start – of the first path tile on it, else walking
export function routeKind(route: readonly number[], l1: ArrayLike<number>, kinds: readonly PathKind[]): PathKind {
  return route.map((c) => kinds[l1[c]]).find((k) => WALKED_KINDS.includes(k)) ?? 'walk';
}

// The route as solved and written: the route as drawn, its ends taken on (CONTEXT.md "Route"):
// - an end on a cell without a path (kind "none") goes on to a level or stop tile beside it, or to the last tile of a
//   path beside it (see below; with the way back along that path): the one straight on (the way the route leaves or
//   arrives at that end), else the only one beside it – with several and none straight on, or the route a single cell,
//   it stays (a stop tile goes there): a route drawn from beside one level to beside another means those levels, not
//   new stop tiles beside them;
// - an end on the last tile of a path – a path tile linked to one cell besides the route, or a plain stop tile linked
//   to one (not a star, pipe or level tile, nor one `kept`: its translevel brings something along) – goes on back
//   along that path to the first level, stop or exit tile on it: the route draws the path on from its end, its tiles
//   kept where they fit, a stop tile at the end becoming a path tile (`through`: its index in the cells, for the
//   solver's RouteInput). Where the path forks or ends on nothing on the way back the end stays (a junction there).
// Linked: the tiles of two cells side by side lead into each other – a path tile's ways (tileWays) reach that side, a
// level, stop or exit tile leads every way.
export interface RouteEnds { cells: number[]; through: number[] }
export function routeEnds(route: readonly number[], l1: ArrayLike<number>, kinds: readonly PathKind[], shapes: PathShapes,
  kept: (cell: number) => boolean = () => false): RouteEnds {
  if (route.length < 2) return { cells: route.slice(), through: [] };
  const kind = (c: number) => kinds[l1[c]], walked = (c: number) => WALKED_KINDS.includes(kind(c));
  const isStop = (c: number) => kind(c) === 'level' || kind(c) === 'stop' || kind(c) === 'exit';
  // (a stop tile a path may be drawn on through: a plain stop, its translevel not kept)
  const passable = (c: number) => kind(c) === 'stop' && !isStarPipeTile(l1[c]) && !kept(c);
  const sideMemo = new Map<number, number[]>();
  const sides = (c: number): number[] => {
    let out = sideMemo.get(c);
    if (!out) sideMemo.set(c, out = isStop(c) ? [0, 1, 2, 3] : walked(c) ? [...new Set(tileWays(l1[c], kind(c), shapes).flatMap((w) => [reverse(w.dir), w.out]))] : []);
    return out;
  };
  const linked = (c: number, d: number) => {
    const n = neighbor(c, d);
    return n >= 0 && sides(c).includes(d) && sides(n).includes(reverse(d));
  };
  // from c, the last tile of a path (reached from `from`), back along it to the first level, stop or exit tile: the
  // cells after c, outwards (null: c is no path's last tile, or the way back forks or ends on nothing); taken: cells
  // the way back may not use (the route's)
  const backAlong = (c: number, from: number, taken: ReadonlySet<number>): number[] | null => {
    if (!walked(c) && !passable(c)) return null;
    const out: number[] = [], seen = new Set(taken);
    for (let prev = from, cur = c; out.length < l1.length;) {
      seen.add(cur);
      const next = [0, 1, 2, 3].filter((d) => linked(cur, d)).map((d) => neighbor(cur, d)).filter((n) => n !== prev && !seen.has(n));
      if (next.length !== 1) return null;
      out.push(next[0]);
      if (isStop(next[0])) return out;
      if (!walked(next[0])) return null;
      prev = cur; cur = next[0];
    }
    return null;
  };
  // the cells an end goes on to, outwards (end: the route's end cell, inner: the one before it), and the stop tile at a
  // path's end it runs through (via: the end or the stop beside it; null: none)
  type OnTo = { cells: number[]; via: number | null };
  const NONE: OnTo = { cells: [], via: null };
  const through1 = (c: number, back: number[] | null): number | null => (back && passable(c) ? c : null);
  const onTo = (end: number, inner: number, taken: ReadonlySet<number>): OnTo => {
    if (kind(end) !== 'none') {
      const back = backAlong(end, inner, taken);
      return back ? { cells: back, via: through1(end, back) } : NONE;
    }
    const beside = [0, 1, 2, 3].flatMap((d): (OnTo & { d: number })[] => {
      const n = neighbor(end, d);
      if (n < 0 || taken.has(n)) return [];
      // (a level or stop tile – a plain stop at a path's end with the way back –; the last tile of a path leading this way)
      if (kind(n) === 'level' || kind(n) === 'stop') {
        const back = backAlong(n, end, taken);
        return [{ d, cells: [n, ...(back ?? [])], via: through1(n, back) }];
      }
      const back = walked(n) && sides(n).includes(reverse(d)) ? backAlong(n, end, taken) : null;
      return back ? [{ d, cells: [n, ...back], via: null }] : [];
    });
    const ahead = beside.find((b) => b.d === reverse(dirTo(end, inner)!));
    return ahead ?? (beside.length === 1 ? beside[0] : NONE);
  };
  const first = onTo(route[0], route[1], new Set(route));
  const last = onTo(route[route.length - 1], route[route.length - 2], new Set([...route, ...first.cells]));
  const cells = [...first.cells.slice().reverse(), ...route, ...last.cells];
  const through = [first.via, last.via].flatMap((c) => (c === null ? [] : [cells.indexOf(c)])).sort((a, b) => a - b);
  return { cells, through };
}

// the direction from cell a to cell b next to it (undefined: not next to it)
const dirTo = (a: number, b: number): number | undefined => [0, 1, 2, 3].find((d) => neighbor(a, d) === b);

export function routeTiles(route: readonly number[], inp: RouteInput): RouteTiles {
  return solve(route, inp, true);
}

// the route being solved: its cells, what each is, the direction from each cell to the next (dirs[k]: from cell k to
// cell k + 1), the tiles to choose from, the tiles found
interface Solving { route: readonly number[]; roles: Role[]; dirs: number[]; inp: RouteInput; cands: Candidate[]; tiles: (number | null)[] }

// (askAlternatives: whether a refusal tells if a stop tile would work – solved again with one there, not asking again)
function solve(route: readonly number[], inp: RouteInput, askAlternatives: boolean): RouteTiles {
  const { l1, kinds } = inp;
  const tiles: (number | null)[] = route.map(() => null);
  const refuse = (at: number, why: OwRefusalData, alt: { stop?: boolean; turns?: number[] } = {}): RouteTiles =>
    ({ tiles, stops: [], refusal: { at, cell: route[at], why, stop: alt.stop ?? false, turns: alt.turns ?? [] } });
  if (!route.length) return { tiles, stops: [], refusal: null };

  // the route: each cell next to the one before on the same map
  const dirs: number[] = [];
  for (let k = 1; k < route.length; k++) {
    const d = dirTo(route[k - 1], route[k]);
    if (d === undefined) return refuse(k, { kind: 'routeGap' });
    dirs.push(d);
  }

  const roles: Role[] = route.map((c, k) => {
    const kind = kinds[l1[c]], end = k === 0 || k === route.length - 1;
    if (inp.through?.has(k) && !end) return 'path';
    if (kind === 'level' || kind === 'stop' || (kind === 'exit' && end)) return 'keep';
    if (end || inp.stops?.has(k)) return 'stop';
    if (kind === 'exit') return 'path'; // (refused below)
    return WALKED_KINDS.includes(kind) && joins(c, route[k - 1], route[k + 1], inp) ? 'stop' : 'path';
  });
  for (let k = 1; k < route.length - 1; k++) {
    if (kinds[l1[route[k]]] === 'exit' && roles[k] === 'path') return refuse(k, { kind: 'routeExitInside' });
  }
  const seen = new Map<number, number>();
  for (let k = 0; k < route.length; k++) {
    const j = seen.get(route[k]);
    if (j !== undefined && (roles[k] === 'path' || roles[j] === 'path')) return refuse(k, { kind: 'routeCrosses' });
    seen.set(route[k], k);
  }

  const stop = inp.stop ?? stopTile(kinds);
  for (let k = 0; k < route.length; k++) if (roles[k] === 'stop') tiles[k] = stop;
  const sv: Solving = { route, roles, dirs, inp, cands: candidates(inp, route[0] >> 10), tiles };
  // the stretches between two cells Mario stops at, each solved on its own
  let from = 0;
  for (let k = 1; k < route.length; k++) {
    if (roles[k] === 'path') continue;
    const r = solveStretch(sv, from, k);
    if (r) {
      // what would work there: a stop tile (the route solved with one there gets past it), another turn
      const again = askAlternatives ? solve(route, { ...inp, stops: new Set([...(inp.stops ?? []), r.at]) }, false) : null;
      tiles.fill(null, r.at); // (nothing from the refused cell on, the stop tiles after it neither)
      return refuse(r.at, r.why, { stop: !!again && (!again.refusal || again.refusal.at > r.at), turns: r.turns });
    }
    from = k;
  }
  const stops = routeStops(sv);
  // (a translevel for each stop tile on a cell without one)
  const st = inp.stopTranslevels;
  if (st) {
    const need = stops.filter((s) => !st.tls[s.cell]), free = st.free.length;
    if (need.length > free) {
      tiles.fill(null, need[free].at);
      return refuse(need[free].at, noTranslevel(st));
    }
  }
  return { tiles, stops, refusal: null, through: [...(inp.through ?? [])].filter((k) => roles[k] === 'path').map((k) => route[k]) };
}

// the stop tiles the route puts, each cell once: the directions to the cells before and after it on the route, and
// those the path tile there leads in (to a cell on the map)
function routeStops(sv: Solving): RouteStop[] {
  const { route, roles, dirs, inp } = sv, out: RouteStop[] = [];
  route.forEach((c, k) => {
    if (roles[k] !== 'stop') return;
    const t = inp.l1[c], ds = new Set<number>();
    if (k > 0) ds.add(reverse(dirs[k - 1]));
    if (k < route.length - 1) ds.add(dirs[k]);
    for (const w of tileWays(t, inp.kinds[t], inp.shapes)) for (const d of [reverse(w.dir), w.out]) if (neighbor(c, d) >= 0) ds.add(d);
    const had = out.find((s) => s.cell === c);
    if (had) had.dirs = [...new Set([...had.dirs, ...ds])].sort();
    else out.push({ at: k, cell: c, dirs: [...ds].sort() });
  });
  return out;
}

// whether the route running through cell c (from cell `prev` to cell `next`) runs into a path there: the tile on it
// leads to a cell off the route Mario walks onto
function joins(c: number, prev: number, next: number, inp: RouteInput): boolean {
  const t = inp.l1[c];
  for (const w of tileWays(t, inp.kinds[t], inp.shapes)) {
    for (const n of [neighbor(c, reverse(w.dir)), neighbor(c, w.out)]) {
      if (n >= 0 && n !== prev && n !== next && inp.kinds[inp.l1[n]] !== 'none') return true;
    }
  }
  return false;
}

// a tile to choose from: its ways, how much it costs (a tile of another kind than preferred, a tile used less on the
// map; the tile already on the cell costs nothing)
interface Candidate { tile: number; ways: PathWay[]; cost: number }
// a tile chosen for a cell (by the point where its way leaves Mario), the cost so far, the tile chosen for the cell before
interface Step { tile: number; cost: number; prev: Step | null }
const key = (p: readonly number[]) => `${p[0]},${p[1]}`;

// The path cells between cells a and b of the route (stop, level or exit tiles) solved into the tiles; null when every
// cell fits, else the first that doesn't, why, and the directions some tile leads on in there.
function solveStretch(sv: Solving, a: number, b: number): { at: number; why: OwRefusalData; turns: number[] } | null {
  if (b - a < 2) return null;
  const { route, roles, dirs, inp, tiles } = sv, { l1, kinds, shapes } = inp;
  const exitAt = (k: number) => kinds[l1[route[k]]] === 'exit' && roles[k] === 'keep';
  // where Mario's first step off a stop tile (route cell s) onto tile t in direction d leaves him, in t's cell (an
  // exit: where the exit path puts him isn't known here – the middle of the side)
  const firstStep = (s: number, t: number, d: number): [number, number] => {
    const f = exitAt(s) ? [0, 0] : shapeVector(shapes.first, t, d, 8);
    return [8 + f[0] - DX[d] * (exitAt(s) ? 8 : 16), 8 + f[1] - DY[d] * (exitAt(s) ? 8 : 16)];
  };
  const endExit = exitAt(b);
  let layer = new Map<string, Step>();
  for (let k = a + 1; k < b; k++) {
    const d = dirs[k - 1], o = dirs[k], first = k === a + 1, last = k === b - 1, here = l1[route[k]];
    // (the tile already on the cell too, where it is no candidate: a tile of page 1)
    const cands = sv.cands.some((c) => c.tile === here) || !WALKED_KINDS.includes(kinds[here]) ? sv.cands
      : [...sv.cands, { tile: here, ways: tileWays(here, kinds[here], shapes), cost: 0 }];
    // (where Mario steps onto the cell's tile: off the stop before, or where the tile before left him)
    const steppedOn = (c: Candidate, w: PathWay) => (first ? key(firstStep(a, c.tile, d)) === key(w.from) : layer.has(key(w.from)));
    const next = new Map<string, Step>();
    let any = false, met = false;
    for (const c of cands) {
      for (const w of c.ways) {
        if (w.dir !== d || w.out !== o) continue;
        any = true;
        if (!steppedOn(c, w)) continue;
        met = true;
        // (the last: where his first step off the stop tile after leaves him walking back is where this way ends)
        if (last && !endExit && key(firstStep(b, c.tile, reverse(o))) !== key(w.to)) continue;
        const prev = first ? null : layer.get(key(w.from))!;
        const cost = (prev?.cost ?? 0) + (here === c.tile ? 0 : c.cost);
        const at = key([w.to[0] - DX[o] * 16, w.to[1] - DY[o] * 16]), had = next.get(at);
        if (!had || cost < had.cost) next.set(at, { tile: c.tile, cost, prev });
      }
    }
    if (!next.size) {
      // the cells before it as far as they fit (the cheapest way there)
      fill(cheapest(layer), k - 1, tiles);
      const turns = [0, 1, 2, 3].filter((t) => t !== o && t !== reverse(d) && cands.some((c) => c.ways.some((w) => w.dir === d && w.out === t && steppedOn(c, w))));
      const why: OwRefusalData = { kind: 'routeNoTile', dir: d, out: o, where: !any ? 'any' : !met ? (first ? 'stopStep' : 'pathBefore') : 'stepBack' };
      return { at: k, why, turns };
    }
    layer = next;
  }
  fill(cheapest(layer), b - 1, tiles);
  return null;
}

const cheapest = (layer: Map<string, Step>): Step | null => [...layer.values()].reduce<Step | null>((m, s) => (!m || s.cost < m.cost ? s : m), null);
function fill(s: Step | null, k: number, tiles: (number | null)[]): void {
  for (; s; s = s.prev, k--) tiles[k] = s.tile;
}

// the path tiles to choose from (page 0, a shaped kind, with ways), each with its cost: another kind than preferred
// first, then how rarely the route's map (main map 0, submaps 1) uses it (the game's own straight tiles before tiles
// it uses once)
function candidates(inp: RouteInput, map: number): Candidate[] {
  const uses = new Map<number, number>();
  for (let i = map * 0x400; i < (map + 1) * 0x400 && i < inp.l1.length; i++) uses.set(inp.l1[i], (uses.get(inp.l1[i]) ?? 0) + 1);
  const tiles = Array.from({ length: PATH_TILES_END - 1 }, (_, k) => k + 1).filter((t) => WALKED_KINDS.includes(inp.kinds[t]));
  const rank = new Map([...tiles].sort((x, y) => (uses.get(y) ?? 0) - (uses.get(x) ?? 0) || x - y).map((t, k) => [t, k]));
  return tiles.map((t) => ({ tile: t, ways: tileWays(t, inp.kinds[t], inp.shapes), cost: (inp.kinds[t] === inp.prefer ? 0 : 0x10000) + 1 + rank.get(t)! }))
    .filter((c) => c.ways.length);
}

// ---- written ----

// a level's exit a route sets the direction of: the translevel, the exit (0 normal, 1–3 secret), the direction
export interface RouteExit { tl: number; exit: number; dir: number }

// The exits a route sets in event ev.event: a level tile at its start or end whose exit runs the event gets that exit's
// direction the way the route leaves the tile – so the game's reveal walk takes the route when the exit is passed. On
// the map before events (ev null) none.
export function routeExits(rom: Rom, route: readonly number[], ev: LevelTileEvent | null): RouteExit[] {
  if (!ev || route.length < 2) return [];
  const tls = readTranslevels(rom), runners = eventRunners(rom).get(ev.event) ?? [], out: RouteExit[] = [];
  const ends: [number, number][] = [[route[0], route[1]], [route[route.length - 1], route[route.length - 2]]];
  for (const [c, n] of ends) {
    const tl = tls[c], dir = dirTo(c, n);
    if (!tl || dir === undefined || !ev.isLevelTile(ev.after[c])) continue;
    for (const r of runners) if (r.tl === tl && !out.some((o) => o.tl === tl && o.exit === r.exit)) out.push({ tl, exit: r.exit, dir });
  }
  return out;
}

// The route's tiles (routeTiles' tiles: null left alone) written: into the map before events, or with an event (ev) as
// layer 1 changes of it (owevents.ts paintEventL1, as layer 1 painted into the event), and the exits routeExits gives
// set. Each stop tile put on a cell without a translevel gets a free one (stopTranslevels: none with a name, base
// event or messages; of them the one bringing least along, freeTranslevel by translevelUse; one for every event
// progress, the table being per cell): its settings reset (no exit directions, resetTranslevel), its initial flags the
// stop's directions (stopFlags). Throws (nothing written) where no translevel is left for one. Layer 2 is not
// touched. The exits it set, the translevels the stops took.
export function writeRoute(rom: Rom, route: readonly number[], solved: Pick<RouteTiles, 'tiles' | 'stops' | 'through'>, ev: LevelTileEvent | null,
  kinds: readonly PathKind[]): { exits: RouteExit[]; taken: number[] } {
  const { tiles } = solved, tls = readTranslevels(rom), need = solved.stops.filter((s) => !tls[s.cell]), st = stopTranslevels(rom, tls);
  if (need.length > st.free.length) throw new OwRefusal(noTranslevel(st));
  const cells = route.flatMap((c, k) => (tiles[k] === null ? [] : [[c, tiles[k]!] as const]));
  if (ev) {
    const after = Uint16Array.from(ev.after);
    for (const [c, t] of cells) after[c] = t;
    writeEvents(rom, paintEventL1(readEvents(rom), ev.event, after, ev.without, new Set(cells.map(([c]) => c))));
  } else {
    const l1 = readL1(rom);
    for (const [c, t] of cells) l1[c] = t;
    writeL1(rom, l1);
  }
  // (a stop tile run through, a path tile now: its translevel freed – unless the cell is a stop or level tile at another
  // progress, the table being per cell –, reset once no cell holds it)
  const isStop = (t: number) => kinds[t] === 'stop' || kinds[t] === 'level';
  const held = solved.through?.length ? heldElsewhere(rom, isStop, ev ? ev.event : -1, ev?.without ?? null) : () => true;
  const freed = (solved.through ?? []).filter((c) => tls[c] && !held(c)).map((c) => { const tl = tls[c]; tls[c] = 0; return tl; });
  const taken = need.map((s) => takeStopTranslevel(rom, tls, st, s.cell, stopFlags(s)));
  for (const tl of new Set(freed)) if (!tls.includes(tl) && !taken.includes(tl)) resetTranslevel(rom, tl);
  if (taken.length || freed.length) writeTranslevels(rom, tls);
  const exits = routeExits(rom, route, ev);
  for (const x of exits) setExitDirection(rom, x.tl, x.exit, x.dir);
  return { exits, taken };
}
// the level flags ($1EA2) opening directions `dirs` (DIR_NAMES order); a stop's
export const dirFlags = (dirs: readonly number[]): number => dirs.reduce((f, d) => f | DIR_FLAGS[d], 0);
export const stopFlags = (s: RouteStop): number => dirFlags(s.dirs);
// a free translevel (of st.free, the one bringing least along: freeTranslevel by translevelUse) for the stop tile or star
// at `cell` (tls changed; the caller writes it): its settings reset, its initial flags `flags`. Call it only while
// st.free has one left (one with a name, base event or messages is ranked out: never taken)
export function takeStopTranslevel(rom: Rom, tls: Uint8Array, st: StopTranslevels, cell: number, flags: number): number {
  const tl = freeTranslevel(tls, (n) => (st.free.includes(n) ? translevelUse(rom, n) : Infinity));
  tls[cell] = tl;
  resetTranslevel(rom, tl);
  setInitialFlags(rom, tl, flags);
  return tl;
}
