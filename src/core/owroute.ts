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

import { DX, DY, PATH_TILES_END, reverse, shapeVector, type PathKind, type PathShapes } from './owpaths.ts';
import { neighbor } from './owreach.ts';
import { tileWays, wayText, SHAPED_KINDS, type PathWay } from './owpathshape.ts';
import { stopTile } from './owleveltiles.ts';

// What the solver needs: layer 1 as it is (l1Index order: the route's cells, the paths it may run into), the path
// kinds and shapes, the kind of path to use where a tile of it fits (the kind at the route's start), the stop tile to
// put (default: owleveltiles.ts stopTile) and route cells (indices into the route) to make stop tiles anyway.
export interface RouteInput {
  l1: ArrayLike<number>;
  kinds: readonly PathKind[];
  shapes: PathShapes;
  prefer: PathKind;
  stop?: number;
  stops?: ReadonlySet<number>;
}

// The first cell no tile fits: its index in the route and its layer 1 cell, why, and what would work instead – a stop
// tile there (stop), or the route turning another way there (turns: the directions some tile leads him on in).
export interface RouteRefusal { at: number; cell: number; why: string; stop: boolean; turns: number[] }

// Per route cell the tile to write (null: left alone – a level, stop or exit tile, or a cell of the route after a
// refusal), and the refusal (null: every cell fits).
export interface RouteTiles { tiles: (number | null)[]; refusal: RouteRefusal | null }

// what a cell of the route is: left alone (Mario stops or exits there), a stop tile to put, a path tile to find
type Role = 'keep' | 'stop' | 'path';

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
  const refuse = (at: number, why: string, alt: { stop?: boolean; turns?: number[] } = {}): RouteTiles =>
    ({ tiles, refusal: { at, cell: route[at], why, stop: alt.stop ?? false, turns: alt.turns ?? [] } });
  if (!route.length) return { tiles, refusal: null };

  // the route: each cell next to the one before on the same map
  const dirs: number[] = [];
  for (let k = 1; k < route.length; k++) {
    const d = [0, 1, 2, 3].find((d) => neighbor(route[k - 1], d) === route[k]);
    if (d === undefined) return refuse(k, 'Not next to the cell before');
    dirs.push(d);
  }

  const roles: Role[] = route.map((c, k) => {
    const kind = kinds[l1[c]], end = k === 0 || k === route.length - 1;
    if (kind === 'level' || kind === 'stop' || (kind === 'exit' && end)) return 'keep';
    if (end || inp.stops?.has(k)) return 'stop';
    if (kind === 'exit') return 'path'; // (refused below)
    return SHAPED_KINDS.includes(kind) && joins(c, route[k - 1], route[k + 1], inp) ? 'stop' : 'path';
  });
  for (let k = 1; k < route.length - 1; k++) {
    if (kinds[l1[route[k]]] === 'exit' && roles[k] === 'path') return refuse(k, 'An exit tile takes Mario to another submap: the route can only end there');
  }
  const seen = new Map<number, number>();
  for (let k = 0; k < route.length; k++) {
    const j = seen.get(route[k]);
    if (j !== undefined && (roles[k] === 'path' || roles[j] === 'path')) return refuse(k, 'The route crosses itself here');
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
  return { tiles, refusal: null };
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
function solveStretch(sv: Solving, a: number, b: number): { at: number; why: string; turns: number[] } | null {
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
    const cands = sv.cands.some((c) => c.tile === here) || !SHAPED_KINDS.includes(kinds[here]) ? sv.cands
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
      const way = wayText(d, o);
      const why = !any ? `No path tile leads Mario ${way}`
        : !met ? `No path tile leads Mario ${way} from where ${first ? 'his first step off the stop' : 'the path before'} leaves him`
        : `No path tile leads Mario ${way} to where his first step off the stop after it leaves him walking back`;
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
  const tiles = Array.from({ length: PATH_TILES_END - 1 }, (_, k) => k + 1).filter((t) => SHAPED_KINDS.includes(inp.kinds[t]));
  const rank = new Map([...tiles].sort((x, y) => (uses.get(y) ?? 0) - (uses.get(x) ?? 0) || x - y).map((t, k) => [t, k]));
  return tiles.map((t) => ({ tile: t, ways: tileWays(t, inp.kinds[t], inp.shapes), cost: (inp.kinds[t] === inp.prefer ? 0 : 0x10000) + 1 + rank.get(t)! }))
    .filter((c) => c.ways.length);
}
