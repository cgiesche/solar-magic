// What passing a level does, one sentence per exit in the player's words (the Levels mode's "When beaten…", #361):
// "Normal exit: opens Iggy's Castle · Iggy's Castle crumbles · the tile at submaps 09,06 becomes 66 · Mario goes to
// Main map 0C,09". The clauses come from the exit's edge – the levels it opens (owexitedges.ts, as its arrows: the
// sentence and the arrows never disagree) – from the exit's event – the tiles it destroys, the tile it reveals, the rest
// of the map it changes – and from the level's exits to the overworld teleporting Mario. Read only: each clause names
// the cells to outline, a reveal or destroy one also what removes it.

import type { Rom } from './rom.ts';
import { readL1, readTranslevels, revealedTile, destroyEffects, destroyChanges, l1Index } from './overworld.ts';
import { exitChanges, readEvents, eventRunners, type EventData, type EventRunner } from './owevents.ts';
import { eventReveal, eventDestroys, cellText } from './oweventtiles.ts';
import { tileText } from './owteleport.ts';
import type { LevelTeleport } from './owlinks.ts';
import { OW_NORMAL, OW_SECRET } from './level.ts';
import type { ExitEdge } from './owexitedges.ts';

export type ClauseKind = 'opens' | 'destroy' | 'reveal' | 'map' | 'teleport';
// a clause: its words, the layer 1 cells (l1Index) and layer 2 entries (readL2 index) it is about, and for a reveal or
// destroy the edit taking it away (the event no longer reveals / destroys `tile`)
export interface Clause { kind: ClauseKind; text: string; l1: number[]; l2: number[]; remove?: { kind: 'reveal' | 'destroy'; tile: number } }
// exit (0 normal, 1–3 the secret exits) runs `event`; no clauses: it opens nothing yet
export interface ExitSentence { exit: number; event: number; clauses: Clause[] }
export interface SentenceWords { level: (tl: number) => string; tile: (t: number) => string }

// the exit an exit to the overworld passes the level with by its action (-1: none of the exits – nothing passed, the
// turn ended, Lunar Magic's other actions: told apart)
export const teleportExit = (a: number): number => (a === OW_NORMAL ? 0 : a === OW_SECRET ? 1 : -1);

// the sentences of translevel tl's exits whose event is the level's (as exitChanges has them, in exit order: a secret
// exit the level can't have – owevents.ts eventRunners – and an exit whose event another level's exit runs first are
// not the level's and get none);
// teleports: the level's exits to the overworld (owlinks.ts levelTeleports); edges: the exits' edges (owexitedges.ts
// exitEdges, learned; none or null: no level told as opened – a revealed level tile is told as the tile revealed). The level
// tile the event reveals of a level the exit opens is that level's clause, its × taking the reveal away.
export function exitSentences(rom: Rom, tl: number, words: SentenceWords, teleports: LevelTeleport[] = [], edges?: readonly ExitEdge[] | null,
  d: EventData = readEvents(rom), runners: Map<number, EventRunner[]> = eventRunners(rom)): ExitSentence[] {
  const map = readL1(rom), tls = readTranslevels(rom), effects = destroyEffects(rom);
  return exitChanges(rom, tl, d, runners).map((c) => {
    const destroys: Clause[] = [], reveals: Clause[] = [], told = new Set<number>();
    const opened = edges?.find((e) => e.tl === tl && e.exit === c.exit && e.event === c.event)?.opens ?? [];
    const opens: Clause[] = opened.map((o) => ({ kind: 'opens', text: `opens ${words.level(o.tl)}`, l1: [o.tile], l2: [] }));
    for (const o of opened) told.add(o.tile);
    const r = eventReveal(rom, c.event);
    if (r >= 0) {
      const into = revealedTile(rom, map[r]), remove = { kind: 'reveal' as const, tile: r };
      told.add(r);
      // (the revealed tile is the level tile of a level opened: told by that level's clause)
      const k = opened.findIndex((o) => o.tile === r);
      if (k >= 0) opens[k] = { ...opens[k], remove };
      else reveals.push({ kind: 'reveal', text: into >= 0 && into !== map[r] ? `the tile at ${cellText(r)} becomes ${words.tile(into)}` : `reveals the tile at ${cellText(r)}`, l1: [r], l2: [], remove });
    }
    for (const j of eventDestroys(rom, c.event)) {
      const cells = [j, ...destroyChanges(effects, map, j).map((c) => c.cell).filter((k) => k !== j)];
      cells.forEach((k) => told.add(k));
      const level = cells.find((k) => tls[k]);
      destroys.push({ kind: 'destroy', text: level !== undefined ? `${words.level(tls[level])} crumbles` : `the tile at ${cellText(j)} is destroyed`,
        l1: cells, l2: [], remove: { kind: 'destroy', tile: j } });
    }
    const l1 = c.l1.filter((k) => !told.has(k)), n = l1.length + c.l2.length;
    const rest: Clause[] = n ? [{ kind: 'map', text: `changes ${n} tile${n > 1 ? 's' : ''} of the map`, l1, l2: c.l2 }] : [];
    const goes: Clause[] = teleports.filter((t) => teleportExit(t.action) === c.exit).map((t) => {
      const at = l1Index(t.to.submap ? 1 : 0, t.to.x, t.to.y);
      return { kind: 'teleport', text: `Mario goes to ${tls[at] ? `${words.level(tls[at])} (${tileText(t.to)})` : tileText(t.to)}`, l1: [at], l2: [] };
    });
    return { exit: c.exit, event: c.event, clauses: [...opens, ...destroys, ...reveals, ...rest, ...goes] };
  });
}
