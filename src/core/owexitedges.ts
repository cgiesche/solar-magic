// What a level exit opens (CONTEXT.md "Exit edge"): exit E opens level B when B is reached (owreach.ts) at the event
// progress just after E's event and not at the one before – derived from the path search at the two progresses,
// never stored. The Levels mode draws them as arrows (ui/owexitarrows.ts).
//
// The maps it searches over are the game's at every event progress (layer 1 and the translevels of the map loaded
// there, the level flags of the save there: progressMapsJob, emulated in the probe worker).

import type { Rom } from './rom.ts';
import { OW_EVENTS, gameL1, type OverworldLoads } from './overworld.ts';
import { eventRunners, exitChanges, readEvents, type ExitChanges } from './owevents.ts';
import { progressSaves } from './owprogress.ts';
import { reach, reachInput, waysFrom, type Reach, type ReachInput } from './owreach.ts';
import { levelTeleports } from './owlinks.ts';
import { readStart } from './owsprites.ts';
import type { ExitGraph } from './exitgraph.ts';
import type { PathKind, PathShapes } from './owpaths.ts';
import type { OwTile } from './owteleport.ts';
import { RAM } from './ram.ts';
import type { Job } from './jobrunner.ts';

// a level B an exit opens: its translevel, its level tile Mario reaches, where the exit's arrow ends – that tile, or
// on a way to another submap the link leaving the exit's submap (the exit path tile, star or pipe; a level tile whose
// exit teleports)
export interface Opened { tl: number; tile: number; end: number }
// level exit `exit` (0 normal, 1–3 the secret exits) of translevel `tl` runs event `event`; `from`: the level's tile
// (the first the translevel table gives it); reached: Mario gets to that tile at the progress after the event – when
// not (events pass in number order: the level is opened by a later event), an exit opening nothing can't be told
// from one whose level isn't reached yet; opens: the levels (none: the event opens nothing Mario reaches)
export interface ExitEdge { tl: number; exit: number; event: number; from: number; reached: boolean; opens: Opened[] }

// The edges of every level exit running an event whose level is the first to run it (owevents.ts eventRunners: the
// event is that exit's, as exitChanges has it), in event order; a secret exit whose event changes nothing on the map
// and opens nothing is left out (every level gets events for three secret exits: one the level likely hasn't).
// Its level not reached at the progress after the event, what the exit opens is still told by the rule – where the
// event's way leads from tiles reached, not from the level. at(p): the search's input at event progress p (0 …
// OW_EVENTS); submapAt: the submap a layer 1 tile is on (default its region: main map 0, submaps 1).
export function exitEdges(rom: Rom, at: (progress: number) => ReachInput, submapAt: (tile: number) => number = (i) => i >> 10): ExitEdge[] {
  const searched = new Map<number, { inp: ReachInput; r: Reach; reached: Map<number, number> }>();
  // the search at event progress p (each once), the translevels whose level tiles it reaches
  const search = (p: number) => {
    let s = searched.get(p);
    if (!s) {
      const inp = at(p), r = reach(inp), reached = new Map<number, number>(); // translevel → its first level tile reached
      for (const i of [...r.stops].sort((a, b) => a - b)) {
        const tl = inp.tls[i];
        if (tl && inp.kinds[inp.l1[i]] === 'level' && !reached.has(tl)) reached.set(tl, i);
      }
      searched.set(p, s = { inp, r, reached });
    }
    return s;
  };
  const out: ExitEdge[] = [], d = readEvents(rom), runners = eventRunners(rom), changes = new Map<number, ExitChanges[]>();
  const changesNothing = (tl: number, exit: number) => {
    const c = (changes.get(tl) ?? changes.set(tl, exitChanges(rom, tl, d, runners)).get(tl)!).find((x) => x.exit === exit);
    return !c || (!c.l1.length && !c.l2.length);
  };
  for (const [event, eventRuns] of [...runners].sort((a, b) => a[0] - b[0])) {
    const run = eventRuns[0];
    if (!run || event >= OW_EVENTS) continue;
    const before = search(event), after = search(event + 1);
    const reached = after.r.stops.has(run.tile), ways = route(after.inp, after.r, run.tile);
    const opens: Opened[] = [];
    for (const [tl, first] of after.reached) {
      if (before.reached.has(tl) || tl === run.tl) continue;
      // (of the level's tiles reached the one the way from the exit's level leads to first)
      const tile = [...ways.keys()].find((i) => after.inp.tls[i] === tl && after.inp.kinds[after.inp.l1[i]] === 'level') ?? first;
      opens.push({ tl, tile, end: arrowEnd(ways, run.tile, tile, submapAt) });
    }
    if (run.exit > 0 && !opens.length && changesNothing(run.tl, run.exit)) continue;
    out.push({ tl: run.tl, exit: run.exit, event, from: run.tile, reached, opens });
  }
  return out;
}

// the way to a stop tile: the stop tile before it, the tiles passed between them
interface Way { prev: number; path: number[] }

// the stop tiles Mario gets to from stop tile `from` (in the order found, breadth first), each with the way there:
// the tile before it on the way and the tiles passed between them
function route(inp: ReachInput, r: Reach, from: number): Map<number, Way> {
  const ways = new Map<number, Way>([[from, { prev: -1, path: [] }]]), queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const s = queue[q];
    for (const w of waysFrom(inp, r, s)) {
      if (ways.has(w.to)) continue;
      ways.set(w.to, { prev: s, path: w.path });
      queue.push(w.to);
    }
  }
  return ways;
}

// where an arrow from tile `from` to tile `to` ends: on the way there the last tile on from's submap before one on
// another (the link leading there), else `to` (also when no way from `from` leads there)
function arrowEnd(ways: Map<number, Way>, from: number, to: number, submapAt: (tile: number) => number): number {
  if (!ways.has(to)) return to;
  const seq: number[] = [];
  // (from, the tiles passed, the stop they lead to, …, to)
  for (let s = to; s >= 0; s = ways.get(s)!.prev) seq.unshift(...ways.get(s)!.path, s);
  const sub = submapAt(from), k = seq.findIndex((i) => submapAt(i) !== sub);
  return k < 0 ? to : seq[k - 1];
}

// ---- the maps at every event progress ----

// layer 1 and the translevels (l1Index order) of the map loaded at an event progress, the level flags of the save there
export interface ProgressMap { l1: Uint16Array; tls: Uint8Array; flags: number[] }

// The map at every event progress 0 … OW_EVENTS (index: the progress), as a job of the result learner (probe worker):
// the saves (owprogress.ts) in one step, then a step per progress loaded (each kept by the loads while the ROM bytes it
// read are unchanged; layer 1 is the same whichever map is loaded, so the main map's)
export function* progressMapsJob(loads: OverworldLoads): Job<ProgressMap[]> {
  const saves = progressSaves(loads);
  yield;
  const out: ProgressMap[] = [];
  for (let p = 0; p <= OW_EVENTS; p++) {
    const m = loads.derive(`progressMap:${p}`, (load) => {
      const r = load(0, p);
      return { l1: gameL1(r), tls: r.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd) };
    });
    out.push({ ...m, flags: saves[p].levelFlags });
    yield;
  }
  return out;
}

// the search's input at event progress p from the maps at every progress, as the overworld view searches: with the
// levels' exits to the overworld teleporting (each level's asked once)
export function progressInput(rom: Rom, maps: readonly ProgressMap[], kinds: readonly PathKind[], shapes: PathShapes, graph: ExitGraph): (p: number) => ReachInput {
  const warps = new Map<number, OwTile[]>(), start = readStart(rom, 0);
  const levelWarps = (tl: number) => warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl).map((t) => t.to)).get(tl)!;
  return (p) => reachInput(rom, maps[p].l1, maps[p].tls, maps[p].flags, kinds, shapes, start, levelWarps);
}
