// A change of a cell's history moved to another event (#360): what an event changes on layer 1 there – its layer 1
// changes (a level tile placed or removed among them), its reveal, its destroy – is made by another event, or put into
// the map before events. A move changes only *when*, never how the map ends up: refused (with the event) where
// another event changes one of the cells between the two, the target included. By default every cell the event
// changes on layer 1 connected to the one dragged (4-neighbours, same submap – the painted path section) moves with it;
// `single`: that cell only. A destroy moves whole (every cell it changes), as does a cell's whole change (its layer 1
// changes, reveal and destroy there). Layer 2 is not touched: the event's steps stay (`layer2` tells whether they
// cover a cell moved). A reveal moved keeps the event rules (one per event, the reveal table's events), as a destroy
// (one per event); one moved into the map before events becomes the tile it leaves.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, l1XY, l1Index, setRevealAt, readDestroyList, writeDestroyList, destroyEffects,
  destroyedCells, l2Index, NO_EVENT,
} from './overworld.ts';
import { readEvents, writeEvents, eventPieces, pieceTiles, type EventData, type Silent } from './owevents.ts';
import { layer1AtEveryProgress } from './owcellhistory.ts';
import { eventReveal, revealRefusal, destroyRefusal } from './oweventtiles.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';

export const BEFORE_EVENTS = -1;

// a move asked for: the change event `from` makes on cell `cell` (l1Index) into event `to` (BEFORE_EVENTS: the map
// before events); single: that cell only; submap: the submap of a cell (connected cells are on the same one; by
// default its region)
export interface MoveAsk { cell: number; from: number; to: number; single?: boolean; submap?: (i: number) => number }
// what the move does: the cells whose layer 1 change moves (sorted), the event's layer 1 changes moving (their cells),
// its reveal (the cell, -1 none) and destroys (the destroy list's cells) moving, whether its layer 2 steps cover a
// moved cell (they stay); refusal: why it can't (null: it can; to === from: nothing to do)
export interface MovePlan {
  from: number; to: number;
  cells: number[];
  steps: number[];
  reveal: number;
  destroys: number[];
  layer2: boolean;
  refusal: OwRefusalData | null;
}

// the cells event e touches on layer 1 (maps: layer1AtEveryProgress, index the progress: the map before event e is
// maps[e], after it maps[e + 1]): those it changes, those its layer 1 changes, reveal and destroys write (also where
// the tile stays)
function touched(rom: Rom, d: EventData, maps: Uint16Array[], e: number, effects = destroyEffects(rom)): Set<number> {
  const out = new Set<number>(), a = maps[e], b = maps[e + 1];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.add(i);
  for (const s of d.silent[e]) if (s.layer === 1 && s.loc < 0x800) out.add(s.loc);
  const r = eventReveal(rom, e);
  if (r >= 0) out.add(r);
  for (const x of readDestroyList(rom)) if (x.event === e) for (const m of [a, b]) for (const c of destroyedCells(effects, m, x.tile)) out.add(c);
  return out;
}
// the 4-neighbours of cell i on its map (l1Index)
function neighbours(i: number): number[] {
  const { x, y } = l1XY(i), map = i >> 10, out: number[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < 32 && ny < 32) out.push(l1Index(map, nx, ny));
  }
  return out;
}

// what moving the change asked for does, and whether it is refused (the ROM unchanged); d, maps: the events and
// layer1AtEveryProgress when already read
export function planMove(rom: Rom, ask: MoveAsk, d: EventData = readEvents(rom), maps = layer1AtEveryProgress(rom, d)): MovePlan {
  const { cell, from: s, to: t } = ask;
  if (s < 0) throw new Error('Only an event\'s change is moved (not the map before events)');
  const effects = destroyEffects(rom), own = touched(rom, d, maps, s, effects);
  const destroys = readDestroyList(rom).filter((x) => x.event === s);
  const plan: MovePlan = { from: s, to: t, cells: [], steps: [], reveal: -1, destroys: [], layer2: false, refusal: null };
  if (!own.has(cell)) return { ...plan, refusal: { kind: 'moveNoLayer1', event: s, cell } };
  // the cells moving: the connected ones the event changes on layer 1 (or the one), each destroy whole
  const submap = ask.submap ?? ((i: number) => i >> 10), sub = submap(cell), cells = new Set([cell]);
  if (!ask.single) {
    const todo = [cell];
    while (todo.length) for (const n of neighbours(todo.pop()!)) if (!cells.has(n) && own.has(n) && submap(n) === sub) { cells.add(n); todo.push(n); }
  }
  const destroyCells = (j: number) => new Set([maps[s], maps[s + 1]].flatMap((m) => destroyedCells(effects, m, j)));
  for (let grew = true; grew;) {
    grew = false;
    for (const x of destroys) {
      const dc = destroyCells(x.tile);
      if ([...dc].some((c) => cells.has(c)) && [...dc].some((c) => !cells.has(c))) { dc.forEach((c) => cells.add(c)); grew = true; }
    }
  }
  const r = eventReveal(rom, s);
  plan.cells = [...cells].sort((a, b) => a - b);
  plan.steps = d.silent[s].filter((x) => x.layer === 1 && cells.has(x.loc)).map((x) => x.loc);
  plan.reveal = r >= 0 && cells.has(r) ? r : -1;
  plan.destroys = destroys.filter((x) => [...destroyCells(x.tile)].some((c) => cells.has(c))).map((x) => x.tile);
  const l2 = new Set(eventPieces(d, s).flatMap((p) => pieceTiles(d, p)));
  plan.layer2 = plan.cells.some((c) => {
    const { x, y } = l1XY(c);
    return [0, 1, 2, 3].some((k) => l2.has(l2Index(c >> 10, x * 2 + (k & 1), y * 2 + (k >> 1))));
  });
  if (t === s) return plan;
  // another event changing a cell between the two (the target included)
  const [lo, hi] = t > s ? [s + 1, t] : [Math.max(t, 0), s - 1];
  for (let e = lo; e <= hi; e++) {
    const other = touched(rom, d, maps, e, effects), hit = plan.cells.find((c) => other.has(c));
    if (hit !== undefined) return { ...plan, refusal: { kind: 'moveCrossed', event: e, cell: hit, from: s, to: t } };
  }
  if (t >= 0 && plan.reveal >= 0) {
    const why = revealRefusal(rom, t);
    if (why) return { ...plan, refusal: why };
  }
  if (t >= 0 && plan.destroys.length) {
    const why = destroyRefusal(rom, t);
    if (why && why.kind !== 'destroysFull') return { ...plan, refusal: why }; // (the entry moves: none more taken)
  }
  return plan;
}

// moves the change (planMove) – one ROM write of the events, reveal table, destroy list, map before events as
// needed; throws the refusal (OwRefusal). Returns the plan done (to === from: nothing written)
export function moveChange(rom: Rom, ask: MoveAsk): MovePlan {
  const d = readEvents(rom), maps = layer1AtEveryProgress(rom, d), plan = planMove(rom, ask, d, maps);
  if (plan.refusal) throw new OwRefusal(plan.refusal);
  const { from: s, to: t } = plan;
  if (t === s) return plan;
  const cells = new Set(plan.cells);
  if (plan.steps.length) {
    const silent = d.silent.slice(), moves = (x: Silent) => x.layer === 1 && cells.has(x.loc), moved = d.silent[s].filter(moves);
    silent[s] = d.silent[s].filter((x) => !moves(x));
    if (t >= 0) silent[t] = [...d.silent[t], ...moved];
    writeEvents(rom, { ...d, silent });
  }
  if (plan.reveal >= 0) {
    setRevealAt(rom, s, 0);
    if (t >= 0) setRevealAt(rom, t, plan.reveal);
  }
  if (plan.destroys.length) {
    writeDestroyList(rom, readDestroyList(rom).map((x) => (x.event === s && plan.destroys.includes(x.tile)
      ? (t >= 0 ? { event: t, tile: x.tile } : { event: NO_EVENT, tile: 0 }) : x)));
  }
  if (t < 0) {
    // the map before events gets the tiles the event left
    const l1 = readL1(rom);
    for (const c of cells) l1[c] = maps[s + 1][c];
    writeL1(rom, l1);
  }
  return plan;
}
