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

import type { Rom } from './rom.ts';
import { loadLevel, readSecondaryEntrance, OW_SECRET } from './level.ts';
import { ExitGraph } from './exitgraph.ts';
import { MAX_TRANSLEVEL, translevelToLevel } from './overworld.ts';
import { perRomState } from './romdeps.ts';

const KEYHOLE = 0x0e, GOAL_TAPE = 0x7b;
// an overworld exit's action passing the level by secret exit 1–3 (the game's $0DD5: OW_SECRET + exit - 1), else 0
const secretOfAction = (a: number): number => (a >= OW_SECRET && a < OW_SECRET + 3 ? a - OW_SECRET + 1 : 0);

// per translevel (1–5F) the secret exits (1–3) shown, none listed for a translevel without
export const shownSecretExits = perRomState((rom: Rom): Map<number, Set<number>> => {
  const g = new ExitGraph(rom), out = new Map<number, Set<number>>(), secretIn = new Map<number, Set<number>>();
  const secretExitsIn = (m: number): Set<number> => {
    let s = secretIn.get(m);
    if (s) return s;
    secretIn.set(m, s = new Set());
    let sprites;
    try { sprites = loadLevel(rom, m).sprites; } catch { return s; }
    // (a custom sprite – extra bit 1 – is none of the game's)
    for (const p of sprites) if (!(p.extra & 2) && (p.num === KEYHOLE || (p.num === GOAL_TAPE && p.extra & 1))) s.add(1);
    for (const e of g.exits) {
      if (e.from !== m || !e.overworld) continue;
      const o = readSecondaryEntrance(rom, e.entrance).overworld;
      if (o && !o.ownEvent && secretOfAction(o.action)) s.add(secretOfAction(o.action));
    }
    return s;
  };
  for (let tl = 1; tl <= MAX_TRANSLEVEL; tl++) {
    const s = new Set(g.reachedFrom(translevelToLevel(tl)).flatMap((m) => [...secretExitsIn(m)]));
    if (s.size) out.set(tl, s);
  }
  return out;
});
