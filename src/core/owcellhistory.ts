// A layer 1 cell's history over the game (#359): what each event changes on it, in number order – the order the game
// applies the events loading a save (CONTEXT.md "Event progress"), so the event list (ADR 0014) can edit each. Layer 1
// as the events leave it: an event's layer 1 changes (its silent steps), then the tile it reveals (turned into its
// counterpart of the reveal list), then the tiles it destroys (what destroying the tile there does, learned from the
// game's code: destroyEffects); layer 2: its steps covering the cell's four 8x8 entries. A level tile placed or
// removed is a layer 1 change from or to a level tile.

import type { Rom } from './rom.ts';
import {
  readL1, readL2, l1XY, l2Index, revealedTile, readDestroyList, destroyEffects, destroyChanges, NO_EVENT, OW_EVENTS,
  type DestroyChange, type Destroy,
} from './overworld.ts';
import { readEvents, eventPieces, drawPiece, type EventData } from './owevents.ts';
import { eventReveal } from './oweventtiles.ts';
import { isPassed, type EventProgress } from './eventset.ts';

// how an event changed a cell's layer 1 tile: its layer 1 changes, a reveal, a destroy (several when more act on it)
export type CellCause = 'tiles' | 'reveal' | 'destroy';
// what event `event` changes on the cell: its layer 1 tile from → to (and how; a reveal is told also where the tile
// stays, not in the reveal list), its layer 2 entries changed (l2), a level tile
// placed or removed there
export interface CellChange {
  event: number;
  l1: { from: number; to: number; by: CellCause[] } | null;
  l2: boolean;
  level: 'placed' | 'removed' | null;
}
// a cell's history: its layer 1 tile before events, the events changing it in number order
export interface CellHistory { before: number; changes: CellChange[] }

// event e's layer 1 writes on `map` (changed in place), in the game's order: its layer 1 changes, its reveal, its
// destroys (destroys: the destroy list's entries of events); `set` takes each cell's new tile (told: a change also where
// the tile stays – a reveal)
type L1Set = (i: number, t: number, by: CellCause, told?: boolean) => void;
function eventL1(rom: Rom, d: EventData, map: Uint16Array, e: number, effects: DestroyChange[][], destroys: readonly Destroy[], set: L1Set): void {
  for (const s of d.silent[e]) if (s.layer === 1 && s.loc < 0x800) set(s.loc, s.tile, 'tiles');
  const r = eventReveal(rom, e);
  if (r >= 0) { const t = revealedTile(rom, map[r]); set(r, t >= 0 ? t : map[r], 'reveal', true); }
  for (const x of destroys) if (x.event === e) for (const c of destroyChanges(effects, map, x.tile)) set(c.cell, c.tile, 'destroy');
}

// Layer 1 through the events: calls `each` after every event e with the cells changed (and how), the map as after it
// (map: the map before events, changed in place); only the events passed at `progress` (all by default) applied
function walkL1(rom: Rom, d: EventData, map: Uint16Array, each: (e: number, changed: Map<number, CellCause[]>) => void, progress: EventProgress = OW_EVENTS): void {
  const effects = destroyEffects(rom), destroys = readDestroyList(rom).filter((x) => x.event !== NO_EVENT);
  for (let e = 0; e < OW_EVENTS; e++) {
    if (!isPassed(progress, e)) continue;
    const changed = new Map<number, CellCause[]>();
    eventL1(rom, d, map, e, effects, destroys, (i, t, by, told = false) => {
      if (map[i] === t && !told) return;
      map[i] = t;
      changed.set(i, [...(changed.get(i) ?? []).filter((c) => c !== by), by]);
    });
    each(e, changed);
  }
}

// layer 1 `map` with only event e's layer 1 writes applied (a copy), as walkL1 applies them
export function layer1AfterEvent(rom: Rom, map: ArrayLike<number>, e: number, d: EventData = readEvents(rom)): Uint16Array {
  const out = Uint16Array.from(map);
  eventL1(rom, d, out, e, destroyEffects(rom), readDestroyList(rom).filter((x) => x.event !== NO_EVENT), (i, t) => { out[i] = t; });
  return out;
}

// layer 1 at an event progress (events 0 … progress-1 passed, or any set: eventset.ts), the events passed applied in
// number order as the model above has it (what the test compares with the game's at every progress and at sets)
export function layer1AtProgress(rom: Rom, progress: EventProgress, d: EventData = readEvents(rom)): Uint16Array {
  const map = readL1(rom);
  walkL1(rom, d, map, () => {}, progress);
  return map;
}

// layer 1 at every event progress 0 … OW_EVENTS (index: the progress), as layer1AtProgress has each, in one walk
// through the events
export function layer1AtEveryProgress(rom: Rom, d: EventData = readEvents(rom)): Uint16Array[] {
  const map = readL1(rom), out = [map.slice()];
  walkL1(rom, d, map, () => { out.push(map.slice()); });
  return out;
}

// cell i's (l1Index) history: its layer 1 tile before events, then each event changing it (layer 1 or the layer 2
// entries under it); isLevelTile: whether a layer 1 tile enters a level (the path kinds', learned) – none: no level
// tile placed or removed told
export function cellHistory(rom: Rom, i: number, isLevelTile?: (t: number) => boolean, d: EventData = readEvents(rom)): CellHistory {
  const map = readL1(rom), before = map[i], l2 = readL2(rom), { x, y } = l1XY(i), region = i >> 10;
  // (the layer 2 entries under the cell)
  const under = [0, 1, 2, 3].map((k) => l2Index(region, x * 2 + (k & 1), y * 2 + (k >> 1)));
  const changes: CellChange[] = [];
  let cur = before;
  walkL1(rom, d, map, (e, changed) => {
    const was = under.map((k) => l2[k]);
    for (const p of eventPieces(d, e)) drawPiece(l2, d, p);
    const l2Changed = under.some((k, n) => l2[k] !== was[n]);
    const by = changed.get(i);
    if (!by && !l2Changed) return;
    const from = cur, to = cur = map[i];
    const [wasLevel, isLevel] = by && isLevelTile ? [isLevelTile(from), isLevelTile(to)] : [false, false];
    changes.push({ event: e, l1: by ? { from, to, by } : null, l2: l2Changed, level: wasLevel === isLevel ? null : isLevel ? 'placed' : 'removed' });
  });
  return { before, changes };
}

// The history in the player's words, one entry per event (-1: before events) to edit in the event list: "6E (before
// events)", "revealed: 66 (Yoshi's Island 2 · normal exit)", "destroyed: 81, no level tile (Iggy's Castle · normal
// exit)", "layer 2 changes (…)". tile: a layer 1 tile in words, event: an event in words (owevents.ts eventWords)
export function historyWords(h: CellHistory, tile: (t: number) => string, event: (e: number) => string): { event: number; text: string }[] {
  const change = (c: CellChange) => {
    const parts: string[] = [];
    if (c.l1) {
      const by = c.l1.by, to = tile(c.l1.to);
      parts.push(by.includes('destroy') ? `destroyed: ${to}` : by.includes('reveal') ? (c.l1.from === c.l1.to ? `revealed (${to} stays)` : `revealed: ${to}`) : to);
    }
    if (c.level) parts.push(c.level === 'placed' ? 'level tile placed' : 'no level tile');
    if (c.l2) parts.push(c.l1 ? 'layer 2 too' : 'layer 2 changes');
    return `${parts.join(', ')} (${event(c.event)})`;
  };
  return [{ event: -1, text: `${tile(h.before)} (before events)` }, ...h.changes.map((c) => ({ event: c.event, text: change(c) }))];
}
