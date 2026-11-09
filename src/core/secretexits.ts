// The secret exits the ROM shows a level has (#383): what in its level data, or in that of a level played from it
// (its exits leading there, exitgraph.ts reachedFrom), passes it by a secret exit –
// - a keyhole (sprite 0E): secret exit 1
// - a goal tape (sprite 7B) with its extra bit set: secret exit 1 (the clean game's secret goal tapes: Donut Ghost
//   House, Cheese Bridge, Chocolate Island 3, Vanilla Secret 1, Forest Ghost House; the others have it clear)
// - an exit through Lunar Magic's secondary entrance to the overworld whose action passes it by secret exit 1–3 (with
//   the tile's base event, not one of its own: level.ts OverworldExit)
// Not shown: a secret exit passed otherwise – by code, the game's own (the clean game's Donut Secret House and
// Chocolate Island 2 have secret exits nothing in their levels' data shows) or a hack's (custom sprites, blocks,
// UberASM). owevents.ts eventRunners therefore also names an event that is no level's base event and changes
// something by the secret exit 1 it is the base event + 1 of.
// In the same walk: the exits to the overworld with a base event of their own those levels take (ownEventExits, #429)
// – each runs its event from the translevel, as eventRunners names it.

import type { Rom } from './rom.ts';
import { loadLevel, readSecondaryEntrance, OW_NORMAL, OW_SECRET } from './level.ts';
import { ExitGraph } from './exitgraph.ts';
import { MAX_TRANSLEVEL, translevelToLevel } from './overworld.ts';
import { perRomState } from './romdeps.ts';

const KEYHOLE = 0x0e, GOAL_TAPE = 0x7b;
// the level exit (0 normal, 1–3 the secret exits) an overworld exit's action passes the level by (the game's $0DD5:
// the exit + 1, as the exit's code sets it – levelheight.ts OverworldExit), else -1 (nothing passed, the turn ended)
export const exitOfAction = (a: number): number => (a >= OW_NORMAL && a < OW_SECRET + 3 ? a - OW_NORMAL : -1);

// an exit to the overworld (level.ts OverworldExit) with a base event of its own, in a level played from a translevel:
// its level (the entrance's, Lunar Magic's "to Overworld [XXX]"), the level exit its action passes (exitOfAction) and
// its base event (the event run: owevents.ts exitEvent of the two)
export interface OwnEventExit { level: number; exit: number; base: number }

// per translevel (1–5F) the secret exits (1–3) shown, none listed for a translevel without
export const shownSecretExits = (rom: Rom): Map<number, Set<number>> => levelExitScan(rom).shown;
// per translevel (1–5F) the exits to the overworld with a base event of their own in the levels played from it (its
// level and those its exits lead to, exitgraph.ts reachedFrom) that pass it (an action passing the level by an exit),
// each once; none listed for a translevel without
export const ownEventExits = (rom: Rom): Map<number, OwnEventExit[]> => levelExitScan(rom).ownEvent;

const addOwn = (list: OwnEventExit[], x: OwnEventExit) => {
  if (!list.some((y) => y.level === x.level && y.exit === x.exit && y.base === x.base)) list.push(x);
};
// what the levels played from each translevel show of their exits (one walk over the levels for both)
const levelExitScan = perRomState((rom: Rom) => {
  const g = new ExitGraph(rom), shown = new Map<number, Set<number>>(), ownEvent = new Map<number, OwnEventExit[]>();
  const secretIn = new Map<number, Set<number>>(), ownIn = new Map<number, OwnEventExit[]>();
  const scan = (m: number) => {
    if (secretIn.has(m)) return;
    const s = new Set<number>(), own: OwnEventExit[] = [];
    secretIn.set(m, s); ownIn.set(m, own);
    let sprites: { num: number; extra: number }[] = [];
    try { sprites = loadLevel(rom, m).sprites; } catch { /* (a level that doesn't load: its exits none either) */ }
    // (a custom sprite – extra bit 1 – is none of the game's)
    for (const p of sprites) if (!(p.extra & 2) && (p.num === KEYHOLE || (p.num === GOAL_TAPE && p.extra & 1))) s.add(1);
    for (const e of g.exits) {
      if (e.from !== m || !e.overworld) continue;
      const ent = readSecondaryEntrance(rom, e.entrance), o = ent.overworld, exit = o ? exitOfAction(o.action) : -1;
      if (!o || exit < 0) continue;
      if (!o.ownEvent) { if (exit) s.add(exit); } else addOwn(own, { level: ent.destLevel, exit, base: o.event });
    }
  };
  for (let tl = 1; tl <= MAX_TRANSLEVEL; tl++) {
    const s = new Set<number>(), own: OwnEventExit[] = [];
    for (const m of g.reachedFrom(translevelToLevel(tl))) {
      scan(m);
      for (const x of secretIn.get(m)!) s.add(x);
      for (const x of ownIn.get(m)!) addOwn(own, x);
    }
    if (s.size) shown.set(tl, s);
    if (own.length) ownEvent.set(tl, own);
  }
  return { shown, ownEvent };
});
