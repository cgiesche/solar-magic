// The reveal walk: when an exit of a level is first passed, after its event, the overworld walks the path from the
// level tile in the direction set for the exit (overworld.ts exitDirections) to the next level tile and enables
// there the direction leading back. The game skips it for some translevels (in the clean game Yoshi's House and the
// switch palaces): passing them runs their event and enables the direction from the tile, but the level tile the
// path leads to gets no way back. It skips it too for an exit that runs no event ($1DEA = FF: the level's base event
// "No event" – its secret exit 1 runs the event after it, 00): the overworld handles the exit at once ($13D9 1 → 5),
// enabling no direction at all – neither from the tile nor back to it. Learned by emulation, not from the game's list
// or code: a level is passed with each exit and, when the overworld stands with the exit not yet handled, its tile is
// given each translevel in turn; the overworld's process in the frame after tells whether it walks (or, with no path
// there, stands) or skips the walk ($13D9 = 5, ram.ts OW_PROCESS.noRevealWalk). And passed with each exit with no
// event to run: whether the overworld goes from handling the exit straight to skipping the walk. So a patched game
// is followed. The result depends on the game's code only: the overworld's data (overworldDataRanges, what is
// painted, the base events) is not read as far as the result is concerned.

import type { LevelEmulator } from './levelemu.ts';
import type { Job } from './jobrunner.ts';
import { PlaySession } from './playsession.ts';
import { MAX_TRANSLEVEL, EXIT_NAMES, OW_MAIN_TILES, NO_EVENT } from './overworld.ts';
import { RAM, GM, OW_PROCESS } from './ram.ts';

// the exits (bit k: exit k, 0 normal, 1–3 the secret exits) whose first pass skips the reveal walk: per translevel
// 0–5F (the game's list), and those of a level whose base event is "No event" (any translevel)
export type RevealWalkSkips = { translevels: number[]; noEvent: number };
// whether exit `exit` of a level with base event `base` (overworld.ts baseEvent) is handled without running an event,
// so without the reveal walk and enabling no direction
export const handledWithoutEvent = (skips: RevealWalkSkips, exit: number, base: number): boolean => base === NO_EVENT && (skips.noEvent >> exit & 1) !== 0;
// whether exit `exit` of translevel tl, its base event `base`, skips the reveal walk
export const skipsRevealWalk = (skips: RevealWalkSkips, tl: number, exit: number, base: number): boolean =>
  ((skips.translevels[tl] ?? 0) >> exit & 1) !== 0 || handledWithoutEvent(skips, exit, base);

const TRY_TILES = 8; // level tiles tried until one enters a level
const HANDLE_FRAMES = 1000; // the overworld loaded after the level, its event run, until it stands with the exit

// (as pathKindsJob, the overworld's data the editor writes isn't recorded as read: owpaths.ts OVERWORLD_DATA)
export function revealWalkJob(emu: LevelEmulator): Job<RevealWalkSkips> {
  return learn(emu);
}

function* learn(emu: LevelEmulator): Generator<string | void, RevealWalkSkips> {
  // a level tile of the main map in a new game (the first that enters a level), the level entered
  emu.startGame(0);
  const tiles = [...emu.snes.wram.subarray(RAM.owTranslevels, RAM.owTranslevels + OW_MAIN_TILES).keys()]
    .filter((i) => emu.snes.wram[RAM.owTranslevels + i]).slice(0, TRY_TILES);
  let p: PlaySession | null = null, tile = -1, standing = -1; // (the process of Mario standing on it)
  for (const i of tiles) {
    const s = PlaySession.overworld(emu, i);
    standing = s.wram[RAM.owProcess];
    if (s.enter()) { p = s; tile = i; break; }
  }
  if (!p) throw new Error('no level tile entered a level');
  const ps = p, w = ps.wram, inLevel = ps.save();
  const skips: RevealWalkSkips = { translevels: new Array(MAX_TRANSLEVEL + 1).fill(0), noEvent: 0 };
  // as a goal: the level passed with the exit (1 normal, 2–4 the secret exits), the base event `event`
  const pass = (exit: number, event: number) => {
    ps.load(inLevel);
    w[RAM.owEvent] = event;
    w[RAM.levelExit] = exit + 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
    w[RAM.gameMode] = GM.overworldReturn;
  };
  for (let exit = 0; exit < EXIT_NAMES.length; exit++) {
    // with no event: the overworld loaded after the level, the process it goes on to once it has handled the exit
    // ($13D9 0 loading, 1 handling the exit, then 5 skipping the walk or another: running the event, walking …)
    pass(exit, NO_EVENT);
    let f = 0;
    while (f++ < HANDLE_FRAMES && !(w[RAM.gameMode] === GM.overworld && w[RAM.owProcess] > OW_PROCESS.handleExit)) p.frame();
    if (f > HANDLE_FRAMES) throw new Error(`the overworld didn't handle exit ${exit + 1} with no event`);
    if (w[RAM.owProcess] === OW_PROCESS.noRevealWalk) skips.noEvent |= 1 << exit;
    // with an event to run (00): the overworld until it stands with the exit not yet handled
    pass(exit, 0);
    f = 0;
    while (f++ < HANDLE_FRAMES && !(w[RAM.gameMode] === GM.overworld && w[RAM.owProcess] === standing && w[RAM.levelExit])) p.frame();
    if (f > HANDLE_FRAMES) throw new Error(`the overworld didn't handle exit ${exit + 1}`);
    const at = p.save();
    for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) {
      p.load(at);
      w[RAM.owTranslevels + tile] = w[RAM.translevel] = tl;
      p.frame();
      if (w[RAM.owProcess] === OW_PROCESS.noRevealWalk) skips.translevels[tl] |= 1 << exit;
    }
    yield `Reveal walks (${EXIT_NAMES[exit]})`;
  }
  return skips;
}
