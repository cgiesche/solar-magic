// The reveal walk: when an exit of a level is first passed, after its event, the overworld walks the path from the
// level tile in the direction set for the exit (overworld.ts exitDirections) to the next level tile and enables
// there the direction leading back. The game skips it for some translevels (in the clean game Yoshi's House and the
// switch palaces): passing them runs their event and enables the direction from the tile, but the level tile the
// path leads to gets no way back. Learned by emulation, not from the game's list: a level
// is passed with each exit and, when the overworld stands with the exit not yet handled, its tile is given each
// translevel in turn; the overworld's process in the frame after tells whether it walks (or, with no path there, stands) or skips
// the walk ($13D9 = 5, ram.ts OW_PROCESS.noRevealWalk). So a patched game's list is followed. The result depends on
// the game's code only: the overworld's data (overworldDataRanges, what is painted) is not read as far as the result
// is concerned.

import type { LevelEmulator } from './levelemu.ts';
import type { Job } from './jobrunner.ts';
import { PlaySession } from './playsession.ts';
import { MAX_TRANSLEVEL, EXIT_NAMES, OW_MAIN_TILES } from './overworld.ts';
import { maskOverworldData } from './owpaths.ts';
import { RAM, GM, OW_PROCESS } from './ram.ts';

// per translevel 0–5F, the exits (bit k: exit k, 0 normal, 1–3 the secret exits) whose first pass skips the reveal walk
export type RevealWalkSkips = number[];
export const skipsRevealWalk = (skips: RevealWalkSkips, tl: number, exit: number): boolean => ((skips[tl] ?? 0) >> exit & 1) !== 0;

const TRY_TILES = 8; // level tiles tried until one enters a level
const HANDLE_FRAMES = 1000; // the overworld loaded after the level, its event run, until it stands with the exit

// (as pathKindsJob, the overworld's data the editor writes isn't recorded as read, restored when it ends)
export function revealWalkJob(emu: LevelEmulator): Job<RevealWalkSkips> {
  return learn(emu, maskOverworldData(emu));
}

function* learn(emu: LevelEmulator, end: () => void): Generator<string | void, RevealWalkSkips> {
  try {
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
    const w = p.wram, inLevel = p.save();
    const skips: RevealWalkSkips = new Array(MAX_TRANSLEVEL + 1).fill(0);
    for (let exit = 0; exit < EXIT_NAMES.length; exit++) {
      // as a goal: the level passed with the exit (1 normal, 2–4 the secret exits), the overworld loaded after it
      p.load(inLevel);
      // (an event to run, 00 – the level's own may be none, and the overworld then handles the exit without the walk)
      w[RAM.owEvent] = 0;
      w[RAM.levelExit] = exit + 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
      w[RAM.gameMode] = GM.overworldReturn;
      let f = 0;
      while (f++ < HANDLE_FRAMES && !(w[RAM.gameMode] === GM.overworld && w[RAM.owProcess] === standing && w[RAM.levelExit])) p.frame();
      if (f > HANDLE_FRAMES) throw new Error(`the overworld didn't handle exit ${exit + 1}`);
      const at = p.save();
      for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) {
        p.load(at);
        w[RAM.owTranslevels + tile] = w[RAM.translevel] = tl;
        p.frame();
        if (w[RAM.owProcess] === OW_PROCESS.noRevealWalk) skips[tl] |= 1 << exit;
      }
      yield `Reveal walks (${EXIT_NAMES[exit]})`;
    }
    return skips;
  } finally { end(); }
}
