// A level tile moved with its paths (CONTEXT.md "Level tile", #367): the paths from it to the next level, stop or exit
// tile (its **paths**, levelPaths) are drawn again from there to where it goes, as the route brush draws them
// (owroute.ts routeTiles): the shortest way from the cell beside the far end the old path left it by – so the far end
// keeps its way off – to a side of the new cell no other path takes, the old path's cells first, its tiles chosen anew
// (of the old path's kind); the cells it no longer uses cleared (to the tile before the progress edited); the level's exit directions and initial flags turned
// from each path's old direction to its new one. A path is kept where it was (said, not refused: the level moves) where
// a cell of it is not of the progress edited (the map before events: a cell an event changes; an event: a cell not of
// its layer 1 changes), where it forks or ends on nothing on the way, where no way leads to the new cell or no path
// tiles fit the way. Layer 2 is not touched (the paths' look is painted with map pieces). Pure but for the ROM edit.

import type { Rom } from './rom.ts';
import { readL1, writeL1, readTranslevels, exitDirections, setExitDirection, initialFlags, setInitialFlags, hasLevelFlagsPatch, DIR_FLAGS } from './overworld.ts';
import { readEvents, writeEvents, paintEventL1, eventL1Tiles } from './owevents.ts';
import { neighbor } from './owreach.ts';
import { pathGraph, routeTiles, routeKind, dirTo, type RouteTiles } from './owroute.ts';
import { moveLevelTile, type LevelTileEvent } from './owleveltiles.ts';
import type { PathKind, PathShapes } from './owpaths.ts';

// One of a level tile's paths: the direction it leaves the tile in, its path cells outwards, the level, stop or exit
// tile at its other end (null: it forks or ends on nothing on the way – cells up to there).
export interface LevelPath { dir: number; cells: number[]; far: number | null }

// The paths of the level tile at `cell` on map l1: one for each side a path is linked to it (owroute.ts pathGraph).
export function levelPaths(l1: ArrayLike<number>, kinds: readonly PathKind[], shapes: PathShapes, cell: number): LevelPath[] {
  const g = pathGraph(l1, kinds, shapes), out: LevelPath[] = [];
  for (let d = 0; d < 4; d++) {
    if (!g.linked(cell, d)) continue;
    const n = neighbor(cell, d);
    if (g.isStop(n)) { out.push({ dir: d, cells: [], far: n }); continue; }
    const back = g.walked(n) ? g.backAlong(n, cell, new Set([cell])) : null;
    out.push(back ? { dir: d, cells: [n, ...back.slice(0, -1)], far: back[back.length - 1] } : { dir: d, cells: [n], far: null });
  }
  return out;
}

// What a move does: the map after it (the level tile moved, the paths drawn again), the cells the paths change, each
// path drawn again (its route from the far end to the new cell, the solver's tiles, the level's old and new direction
// to it) and each kept where it was, with why.
export interface Rerouted { path: LevelPath; route: number[]; solved: RouteTiles; dirOld: number; dirNew: number }
// (far: the path leads to the tile the level swaps with – it stays, between the two)
export type KeptWhy = 'progress' | 'fork' | 'far' | 'noWay' | 'noTiles';
export interface KeptPath { path: LevelPath; why: KeptWhy }
export interface LevelMovePlan { l1: Uint16Array; changed: Set<number>; routes: Rerouted[]; kept: KeptPath[] }
// l1: the map as shown at the progress edited; moved: as the level tile's move leaves it (default: the two cells
// swapped – owleveltiles.ts moveLevelTile moves a castle's top too); editable: whether a path's cell is of that
// progress; avoid: cells a new way may not take (before events: those an event changes); cleared: the tile a path
// cell no longer used gets (as before the progress)
export interface LevelMoveInput {
  l1: ArrayLike<number>; moved?: ArrayLike<number>; kinds: readonly PathKind[]; shapes: PathShapes;
  editable: (cell: number) => boolean; avoid?: (cell: number) => boolean; cleared: (cell: number) => number;
}

export function planLevelMove(inp: LevelMoveInput, from: number, to: number): LevelMovePlan {
  const { kinds, shapes } = inp, avoid = inp.avoid ?? (() => false);
  const w = Uint16Array.from(inp.moved ?? inp.l1);
  if (!inp.moved) [w[from], w[to]] = [w[to], w[from]];
  const routes: Rerouted[] = [], kept: KeptPath[] = [], changed = new Set<number>();
  const paths = levelPaths(inp.l1, kinds, shapes, from);
  // (kept at once: their exits keep their directions, so no path drawn again may arrive on those sides)
  const keptAt = (path: LevelPath): KeptWhy | null => (path.far === null ? 'fork' : path.far === to ? 'far' : !path.cells.every(inp.editable) ? 'progress' : null);
  const taken = new Set<number>();
  for (const path of paths) {
    const why = keptAt(path);
    if (why) { kept.push({ path, why }); taken.add(path.dir); }
  }
  for (const path of paths) {
    if (keptAt(path)) continue;
    // (the path's cells cleared – and the level's old cell where the move left a cell of the path there)
    const trial = Uint16Array.from(w), old = new Set(path.cells.filter((c) => c !== to));
    if (path.cells.includes(to)) old.add(from);
    for (const c of old) trial[c] = inp.cleared(c);
    const start = path.cells.length ? path.cells[path.cells.length - 1] : from;
    const way = start === to ? [] : shortestWay(trial, kinds, start, to, old, taken, avoid);
    if (!way) { kept.push({ path, why: 'noWay' }); taken.add(path.dir); continue; }
    const route = [path.far!, ...way, to];
    // (solved on the cells cleared: an old tile kept there may lead into another path drawn again beside it – the
    // solver would make that a junction; the tiles of a way the old path took come out the same)
    const solved = routeTiles(route, { l1: trial, kinds, shapes, prefer: routeKind(path.cells, inp.l1, kinds) });
    if (solved.refusal || solved.stops.length) { kept.push({ path, why: 'noTiles' }); taken.add(path.dir); continue; }
    route.forEach((c, k) => { if (solved.tiles[k] !== null) trial[c] = solved.tiles[k]!; });
    for (const c of [...old, ...route]) if (trial[c] !== w[c]) changed.add(c);
    w.set(trial);
    const dirNew = dirTo(to, route[route.length - 2])!;
    taken.add(dirNew);
    routes.push({ path, route, solved, dirOld: path.dir, dirNew });
  }
  return { l1: w, changed, routes, kept };
}

// The shortest way from `start` to a cell beside `to` on a side not taken, over cells without a path (kind "none") or
// of `old` (the old path's, cleared) and not avoided – of the shortest, the one with most cells of `old` –, start first,
// the cell beside `to` last; null: none. (Breadth first, a step at a time: each cell reached by the fewest steps, with
// the fewest cells not of `old`.)
function shortestWay(l1: ArrayLike<number>, kinds: readonly PathKind[], start: number, to: number, old: ReadonlySet<number>,
  taken: ReadonlySet<number>, avoid: (cell: number) => boolean): number[] | null {
  const free = (c: number) => c >= 0 && c !== to && (c >> 10) === (to >> 10) && !avoid(c) && (old.has(c) || kinds[l1[c]] === 'none');
  if (!free(start)) return null;
  const fresh = new Map<number, number>([[start, old.has(start) ? 0 : 1]]), prev = new Map<number, number>();
  const ends = (c: number) => { const d = dirTo(to, c); return d !== undefined && !taken.has(d); };
  for (let layer = [start]; layer.length;) {
    const done = layer.filter(ends);
    if (done.length) {
      const way = [done.reduce((a, b) => (fresh.get(b)! < fresh.get(a)! ? b : a))];
      while (prev.has(way[0])) way.unshift(prev.get(way[0])!);
      return way;
    }
    const next: number[] = [];
    for (const cur of layer) for (let d = 0; d < 4; d++) {
      const n = neighbor(cur, d);
      if (!free(n)) continue;
      const f = fresh.get(cur)! + (old.has(n) ? 0 : 1), had = fresh.get(n);
      if (had === undefined) { fresh.set(n, f); prev.set(n, cur); next.push(n); }
      else if (next.includes(n) && f < had) { fresh.set(n, f); prev.set(n, cur); }
    }
    layer = next;
  }
  return null;
}

// The level tile at `from` moved to `to` with its paths (one ROM edit's work: call it inside one): moved as
// owleveltiles.ts moveLevelTile does (in event ev, or the map before events), the paths drawn again (planLevelMove) –
// as layer 1 changes of the event, or into the map –, the level's exit directions and initial flags turned with them.
// The paths drawn again (count) and those kept where they were, with why.
export function moveLevelTileWithPaths(rom: Rom, from: number, to: number, ev: LevelTileEvent | null, kinds: readonly PathKind[], shapes: PathShapes): { rerouted: number; kept: KeptPath[] } {
  const events = readEvents(rom), shown = ev ? Uint16Array.from(ev.after) : readL1(rom);
  const own = ev ? new Set(eventL1Tiles(events, ev.event)) : null;
  const byEvents = new Set(events.silent.flatMap((st) => st.filter((x) => x.layer === 1).map((x) => x.loc)));
  moveLevelTile(rom, from, to, ev);
  // (the map as the move leaves it: in an event the two cells swapped, before events read back – a castle's top moved too)
  const moved = ev ? Uint16Array.from(shown) : readL1(rom);
  if (ev) [moved[from], moved[to]] = [moved[to], moved[from]];
  const plan = planLevelMove({
    l1: shown, moved, kinds, shapes,
    editable: own ? (c) => own.has(c) : (c) => !byEvents.has(c),
    avoid: own ? undefined : (c) => byEvents.has(c),
    cleared: ev ? (c) => ev.without[c] : () => 0,
  }, from, to);
  if (!plan.routes.length) return { rerouted: 0, kept: plan.kept };
  if (ev) writeEvents(rom, paintEventL1(readEvents(rom), ev.event, plan.l1, ev.without, plan.changed));
  else writeL1(rom, plan.l1);
  // the level's ways turned with its paths: each exit's direction and the initial flags (from the old values)
  const tl = readTranslevels(rom)[to];
  if (tl) {
    const turn = new Map(plan.routes.map((r) => [r.dirOld, r.dirNew]));
    exitDirections(rom, tl).forEach((d, exit) => { const n = turn.get(d); if (n !== undefined && n !== d) setExitDirection(rom, tl, exit, n); });
    if (hasLevelFlagsPatch(rom)) {
      const flags = initialFlags(rom, tl);
      let out = flags;
      for (const [o] of turn) out &= ~DIR_FLAGS[o];
      for (const [o, n] of turn) if (flags & DIR_FLAGS[o]) out |= DIR_FLAGS[n];
      if (out !== flags) setInitialFlags(rom, tl, out);
    }
  }
  return { rerouted: plan.routes.length, kept: plan.kept };
}
