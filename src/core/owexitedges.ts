// What a level exit opens (CONTEXT.md "Exit edge"): exit E opens level B when B is reached (owreach.ts) with every
// event passed and not with every event but E's (owreach.ts inputWithout) – or, the first rule kept as a supplement,
// at the event progress just after E's event and not at the one before – and B is a first level on the way: Mario
// gets there without passing another level so opened. Derived from the path searches, never stored. The layer 1 mode
// draws them as arrows (ui/owexitarrows.ts): the selected level tile's, every one with View → "Exit arrows".
//
// It searches the maps at every event progress built from the events (owprogress.ts progressMapsFromEvents: layer 1
// through the events, the saves' level flags), searched as the World check searches them (progressSearches).

import type { Rom } from './rom.ts';
import { OW_EVENTS, DIR_FLAGS, exitDirections, readL1, readDestroyList, destroyEffects, destroyedCells, type OverworldLoads } from './overworld.ts';
import { eventChanges, eventRunners, exitChanges, readEvents, submapViewsJob, submapOf, type EventChanges, type EventRunner, type ExitChanges } from './owevents.ts';
import { progressSavesJob, progressSearches, progressInput, progressMapsFromEvents } from './owprogress.ts';
import { inputWithout, reach, waysFrom, type Reach, type Reached, type ReachInput } from './owreach.ts';
import { ExitGraph } from './exitgraph.ts';
import type { PathKind, PathShapes } from './owpaths.ts';
import type { Job } from './jobrunner.ts';

// a level B an exit opens: its translevel, its level tile Mario reaches, where the exit's arrow ends – that tile, or
// on a way to another submap the link leaving the exit's submap (the exit path tile, star or pipe; a level tile whose
// exit teleports)
export interface Opened { tl: number; tile: number; end: number }
// level exit `exit` (0 normal, 1–3 the secret exits) of translevel `tl` runs event `event`; `from`: the level's tile
// (the first the translevel table gives it); reached: Mario gets to that tile with every event passed or at the
// progress after the event – when not, an exit opening nothing can't be told from one whose level isn't reached;
// opens: the levels (none: the event opens nothing Mario reaches)
export interface ExitEdge { tl: number; exit: number; event: number; from: number; reached: boolean; opens: Opened[] }

// the edges drawn as arrows (#396): every one with View → "Exit arrows" (all), else those of the selected level tile
// (l1Index; -1: none)
export function shownExitEdges(edges: readonly ExitEdge[], all: boolean, selected: number): ExitEdge[] {
  return all ? edges.slice() : edges.filter((e) => e.from === selected);
}

// a path search: its input, its result, the translevels whose level tiles it reaches (each with its first tile
// reached); a level tile: one with a translevel, a level tile on the map searched or one an event destroys
// (`destroyed`: a castle destroyed is a stop tile, still its level's – a star is no level tile)
interface Searched { inp: ReachInput; r: Reach; reached: Map<number, number>; isLevel: (tile: number) => boolean; destroyed: ReadonlySet<number> }
function searched(inp: ReachInput, destroyed: ReadonlySet<number>, r: Reach = reach(inp)): Searched {
  const reached = new Map<number, number>();
  const isLevel = (i: number) => !!inp.tls[i] && (inp.kinds[inp.l1[i]] === 'level' || destroyed.has(i));
  for (const i of [...r.stops].sort((a, b) => a - b)) if (isLevel(i) && !reached.has(inp.tls[i])) reached.set(inp.tls[i], i);
  return { inp, r, reached, isLevel, destroyed };
}

// The edges of every level exit running an event whose level is the first to run it (owevents.ts eventRunners: the
// event is that exit's, as exitChanges has it – a secret exit only where the level can have it), in event order; a
// secret exit whose event changes nothing on the map and opens nothing is left out (one the level likely hasn't). A
// level is opened by either rule: reached with every event passed and not without the exit's event – what the exit is
// needed for, whatever order the events pass in –, or reached at the progress after the event and not at the one before
// (events in number order) – of those the first on the way (nextLevels). "Without the exit's event": here with every
// event but the exit's (its layer 1 changes undone, the way the exit opens closed: cheap, the tests' rule to compare
// with – the arrows are the probe worker's passableEdgesJob's, which has the events still passable without it; this
// misses levels Mario reaches backwards with every event passed). Its level not reached, what the exit opens is still
// told by the rules – where the event's way leads from tiles reached, not from the level. at(p): the search at event
// progress p (0 … OW_EVENTS; owprogress.ts progressSearches, each searched once); submapAt: the submap a layer 1 tile
// is on (default its region: main map 0, submaps 1).
export function exitEdges(rom: Rom, at: (progress: number) => Reached, submapAt: (tile: number) => number = (i) => i >> 10): ExitEdge[] {
  const steps = exitEdgeSteps(rom, at, submapAt, false);
  for (;;) { const s = steps.next(); if (s.done) return s.value; }
}

// exitEdges a step per exit (a job's); passable: without the exit's event the events still passable (passableWithout)
function* exitEdgeSteps(rom: Rom, at: (progress: number) => Reached, submapAt: (tile: number) => number, passable: boolean): Generator<void, ExitEdge[]> {
  const out: ExitEdge[] = [], d = readEvents(rom), runners = eventRunners(rom), changes = new Map<number, ExitChanges[]>(), eventChange = eventChanges(rom, d);
  const before = readL1(rom), effects = destroyEffects(rom), destroyed = new Set<number>();
  for (const x of readDestroyList(rom)) if (x.event < OW_EVENTS) for (const i of destroyedCells(effects, before, x.tile)) destroyed.add(i);
  const progress = new Map<number, Searched>();
  // the search at event progress p with its level tiles reached (each once)
  const search = (p: number) => {
    let s = progress.get(p);
    if (!s) { const a = at(p); progress.set(p, s = searched(a.inp, destroyed, a.r)); }
    return s;
  };
  const all = search(OW_EVENTS);
  yield; // (the search with every event passed a step, passableWithout's rounds the next)
  const without = passable ? passableWithout(rom, at, runners, eventChange, before) : null;
  const changesNothing = (tl: number, exit: number) => {
    const c = (changes.get(tl) ?? changes.set(tl, exitChanges(rom, tl, d, runners)).get(tl)!).find((x) => x.exit === exit);
    return !c || (!c.l1.length && !c.l2.length);
  };
  for (const [event, eventRuns] of [...runners].sort((a, b) => a[0] - b[0])) {
    const run = eventRuns[0];
    if (!run || event >= OW_EVENTS) continue;
    const opens: Opened[] = [];
    // the levels reached in `now` and not in `then` that Mario comes to first (none found already), the arrow's end on
    // the way from the exit's level in `now`
    const add = (now: Searched, then: Searched) => {
      const tls = [...nextLevels(now, then, run.tl)].filter((tl) => !opens.some((o) => o.tl === tl));
      const ways = tls.length ? route(now.inp, now.r, run.tile) : new Map<number, Way>();
      for (const tl of tls) {
        // (of the level's tiles reached the one the way from the exit's level leads to first)
        const tile = [...ways.keys()].find((i) => now.inp.tls[i] === tl && now.isLevel(i)) ?? now.reached.get(tl)!;
        opens.push({ tl, tile, end: arrowEnd(ways, run.tile, tile, submapAt) });
      }
    };
    const post = search(event + 1);
    add(post, search(event));
    add(all, searched(without ? without(event) : inputWithout(rom, all.inp, eventChange(event), eventRuns, before), destroyed));
    yield;
    if (run.exit > 0 && !opens.length && changesNothing(run.tl, run.exit)) continue;
    out.push({ tl: run.tl, exit: run.exit, event, from: run.tile, reached: all.r.stops.has(run.tile) || post.r.stops.has(run.tile), opens });
  }
  return out;
}

// The search's input with the events still passable without event e, per e: start with no event passed, add every
// event whose level is reached (the level whose normal exit runs it, else the first of its runners: eventRunners),
// repeat until the set stops growing – never adding e. The events no level exit runs (a teleport's, the hack's own
// code's) count as passed from the start: no exit needs them, and Mario can't pass them by reaching a level. The
// rounds are those without any event left out until e would be added: each e starts from the last round before that
// (the set only grows). The map with a set of events passed: a cell some event changes has its tile after the last
// of them passed (at the progress after it, events in number order), the map before events' when none is – so a tile
// two events change stays as long as one of them is passed (with every event but e's, e's tiles are undone: a Star
// Road star another exit reveals too is gone, and the Star World levels behind it seem opened by e); the level flags
// those before events, and per event passed those its save sets (the ones in the save after it not in the one
// before) and its exit's way.
function passableWithout(rom: Rom, at: (progress: number) => Reached, runners: Map<number, EventRunner[]>, eventChange: (e: number) => EventChanges,
  before: ArrayLike<number>): (e: number) => ReachInput {
  const all = at(OW_EVENTS).inp, input = (p: number) => at(p).inp;
  // per cell the events changing it, in number order; per event its level (exits: the runner whose event it is) and
  // the level flags passing it sets (an earlier event setting one of them too: its exit's way at least)
  const changers = new Map<number, number[]>(), sets: Uint8Array[] = [];
  for (let e = 0; e < OW_EVENTS; e++) for (const i of eventChange(e).l1) (changers.get(i) ?? changers.set(i, []).get(i)!).push(e);
  const exits = [...runners].filter(([e]) => e < OW_EVENTS).map(([e, runs]) => [e, runs.find((r) => !r.exit) ?? runs[0]] as const);
  for (let e = 0; e < OW_EVENTS; e++) { const a = input(e).flags, b = input(e + 1).flags; sets.push(Uint8Array.from(b, (f, tl) => f & ~a[tl])); }
  for (const [e, { tl, exit }] of exits) sets[e][tl] |= DIR_FLAGS[exitDirections(rom, tl)[exit]] & ~input(0).flags[tl];
  const inputWith = (passed: ReadonlySet<number>): ReachInput => {
    const l1 = Uint16Array.from(all.l1), flags = Uint8Array.from(input(0).flags);
    for (const [i, es] of changers) {
      let k = es.length - 1;
      while (k >= 0 && !passed.has(es[k])) k--;
      l1[i] = k < 0 ? before[i] : input(es[k] + 1).l1[i];
    }
    for (const e of passed) if (e < OW_EVENTS) sets[e].forEach((f, tl) => { flags[tl] |= f; });
    return { ...all, l1, flags };
  };
  // the events whose exit's level the search with `passed` reaches, not passed yet (and not e)
  const next = (passed: ReadonlySet<number>, e: number): number[] => {
    const r = reach(inputWith(passed));
    return exits.filter(([x, run]) => x !== e && !passed.has(x) && r.stops.has(run.tile)).map(([x]) => x);
  };
  // the rounds without any event left out (each the one before and the events it adds)
  const rounds: Set<number>[] = [new Set(Array.from({ length: OW_EVENTS }, (_, e) => e).filter((e) => !runners.get(e)?.length))];
  for (let added = next(rounds[0], -1); added.length; added = next(rounds[rounds.length - 1], -1)) rounds.push(new Set([...rounds[rounds.length - 1], ...added]));
  return (e) => {
    const k = rounds.findIndex((r) => r.has(e)), passed = new Set(rounds[k < 0 ? rounds.length - 1 : k - 1]);
    for (let added = next(passed, e); added.length; added = next(passed, e)) for (const x of added) passed.add(x);
    return inputWith(passed);
  };
}

// The levels reached in `now` and not in `then` that Mario comes to first: reached in `now`'s search ending at the
// level tiles of those levels – not those he gets to only through another (without an exit's event every level
// behind the way it opens isn't reached: the exit opens the first). The exit's own level (`own`) is none of them and
// no end: the way leads on through it
function nextLevels(now: Searched, then: Searched, own: number): Set<number> {
  const opened = (tl: number) => tl !== own && !then.reached.has(tl);
  if (![...now.reached.keys()].some(opened)) return new Set();
  const ends = (i: number) => now.isLevel(i) && opened(now.inp.tls[i]);
  return new Set([...searched({ ...now.inp, ends }, now.destroyed).reached.keys()].filter(opened));
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

// The exits' edges with the events still passable without each exit's event (exitEdgeSteps passable), as a job of the
// result learner (probe worker): the saves' level flags (owprogress.ts progressSavesJob, kept by the loads), the maps at
// every progress from the events, then a step per exit. kinds, shapes: the path kinds and shapes (sent with the job)
export function* passableEdgesJob(rom: Rom, loads: OverworldLoads, kinds: readonly PathKind[], shapes: PathShapes): Job<ExitEdge[]> {
  const flags = (yield* progressSavesJob(loads)).map((s) => s.levelFlags);
  yield;
  const search = progressSearches(progressInput(rom, progressMapsFromEvents(rom, flags), kinds, shapes, new ExitGraph(rom))), views = yield* submapViewsJob(loads);
  return yield* exitEdgeSteps(rom, search, (i) => submapOf(views, i), true);
}
