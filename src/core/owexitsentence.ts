// What passing a level does, one sentence per exit in the player's words (the Levels mode's "When beaten…", #361):
// "Normal exit: opens Iggy's Castle · Iggy's Castle crumbles · the tile at submaps 09,06 becomes 66 · Mario goes to
// Main map 0C,09". The clauses come from the exit's event – the level tile it reveals (the level it opens; until the
// levels an event opens are derived from the paths, #362, the revealed level tiles stand for them), the tiles it
// destroys, the other tile it reveals, the rest of the map it changes – and from the level's exits to the overworld
// teleporting Mario. Read only: each clause names the cells to outline, a reveal or destroy one also what removes it.

import type { Rom } from './rom.ts';
import { readL1, readTranslevels, revealedTile, destroyEffects, destroyChanges, l1Index } from './overworld.ts';
import { exitChanges, readEvents, eventRunners, type EventData, type EventRunner } from './owevents.ts';
import { eventReveal, eventDestroys, cellText } from './oweventtiles.ts';
import { tileText } from './owteleport.ts';
import type { LevelTeleport } from './owlinks.ts';
import { OW_NORMAL, OW_SECRET } from './level.ts';

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

// the sentences of translevel tl's exits whose event is the level's (as exitChanges has them, in exit order: an exit
// whose event another level's exit runs first is not the level's – a level without a secret exit has the next level's
// event there – and gets none);
// teleports: the level's exits to the overworld (owlinks.ts levelTeleports); isLevelTile: whether a layer 1 tile
// enters a level (the path kinds', learned; none: a revealed tile is never told as a level opened)
export function exitSentences(rom: Rom, tl: number, words: SentenceWords, teleports: LevelTeleport[] = [], isLevelTile?: (t: number) => boolean,
  d: EventData = readEvents(rom), runners: Map<number, EventRunner[]> = eventRunners(rom)): ExitSentence[] {
  const map = readL1(rom), tls = readTranslevels(rom), effects = destroyEffects(rom);
  return exitChanges(rom, tl, d, runners).map((c) => {
    const opens: Clause[] = [], destroys: Clause[] = [], reveals: Clause[] = [], told = new Set<number>();
    const r = eventReveal(rom, c.event);
    if (r >= 0) {
      const into = revealedTile(rom, map[r]), shown = into >= 0 ? into : map[r];
      const remove = { kind: 'reveal' as const, tile: r };
      told.add(r);
      if (tls[r] && isLevelTile?.(shown)) opens.push({ kind: 'opens', text: `opens ${words.level(tls[r])}`, l1: [r], l2: [], remove });
      else reveals.push({ kind: 'reveal', text: into >= 0 && into !== map[r] ? `the tile at ${cellText(r)} becomes ${words.tile(into)}` : `reveals the tile at ${cellText(r)}`, l1: [r], l2: [], remove });
    }
    for (const j of eventDestroys(rom, c.event)) {
      const cells = [j, ...destroyChanges(effects, map, j).map((c) => c.cell).filter((k) => k !== j)];
      cells.forEach((k) => told.add(k));
      const level = cells.find((k) => tls[k]);
      destroys.push({ kind: 'destroy', text: level !== undefined ? `${words.level(tls[level])} crumbles` : `the tile at ${cellText(j)} is destroyed`,
        l1: cells, l2: [], remove: { kind: 'destroy', tile: j } });
    }
    // (a level tile the event's own layer 1 changes put on a cell entering a level: opened too)
    for (const s of d.silent[c.event]) {
      if (s.layer !== 1 || s.loc >= 0x800 || told.has(s.loc) || !tls[s.loc] || !isLevelTile?.(s.tile) || isLevelTile(map[s.loc])) continue;
      told.add(s.loc);
      opens.push({ kind: 'opens', text: `opens ${words.level(tls[s.loc])}`, l1: [s.loc], l2: [] });
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
