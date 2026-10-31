// Path tiles: what Mario does on each layer 1 tile of the overworld – walks, climbs or swims along it, takes it
// as an exit to another submap, stops on it (entering a level or not), or doesn't go there. Invisible in the
// game, so the editor draws them as an overlay. Learned by emulation, not from a list: in a new game, Mario on
// his start tile is given a way with the tile next to him and a stop tile after it, and walks there. The
// overworld looks one tile ahead as he goes: onto a path tile it gives him its pose (swimming, climbing) or
// switches to another submap (an exit); on a tile he stops at, A tells whether it enters a level. So a patched
// game's tiles show what they do there. The result depends on the game's code only: the overworld's data
// (overworldDataRanges, what is painted) is not read as far as the result is concerned.

import type { LevelEmulator } from './levelemu.ts';
import type { Job } from './learner.ts';
import { l1Index, overworldDataRanges, OW_L1, DIR_FLAGS } from './overworld.ts';
import { RAM, GM, PAD, get16 } from './ram.ts';

export const PATH_KINDS = ['walk', 'climb', 'swim', 'exit', 'stop', 'level', 'none'] as const;
export type PathKind = (typeof PATH_KINDS)[number];
// the kinds drawn as path tiles (a level tile shows itself)
export const isPathKind = (k: PathKind): boolean => k !== 'level' && k !== 'none';
export const PATH_KIND_NAMES: Record<PathKind, string> = {
  walk: 'Path: walk', climb: 'Path: climb', swim: 'Path: swim', exit: 'Path: exit to another submap',
  stop: 'Path: Mario stops, enters no level', level: 'Level tile', none: 'No path',
};

const WALK_FRAMES = 90; // until Mario reached the tile after the probed one or stopped (a climb is slow)
const ENTER_FRAMES = 60; // A pressed on a tile he stopped at, until a level loads

// The kind of every layer 1 tile 00–FF, a tile per step (the result learner's job). The overworld's data the
// editor writes isn't recorded as read (emu.skipMask, restored when it ends: not withSkipMask, the learner's
// tracked() around each step reads it).
export function pathKindsJob(emu: LevelEmulator): Job<PathKind[]> {
  const base = emu.skipMask, mask = base?.()?.slice() ?? new Uint8Array(emu.rom.data.length);
  for (const [a, b] of overworldDataRanges(emu.rom)) mask.fill(1, a, Math.min(b, mask.length));
  emu.skipMask = () => mask;
  return probeAll(emu, () => { emu.skipMask = base; });
}

function* probeAll(emu: LevelEmulator, end: () => void): Generator<string | void, PathKind[]> {
  try {
    emu.startGame(0);
    const s = emu.snes, w = s.wram;
    const map = w[RAM.submap] ? 1 : 0, tx = get16(w, RAM.owPlayerTileX), ty = get16(w, RAM.owPlayerTileY);
    const dx = tx + 2 < 32 ? 1 : -1, pad = dx > 0 ? PAD.right : PAD.left;
    const at = (k: number, dy = 0) => l1Index(map, tx + k * dx, ty + dy);
    // the way: his tile (translevel 1, every direction open), the probed tile (the same translevel), a stop tile
    // (his own, read: what is painted there matters), nothing around
    const home = at(0), tl = 1, stop = emu.rom.r8(OW_L1 + home);
    for (let dy = -1; dy <= 1; dy++) for (let k = -1; k <= 3; k++) {
      const y = ty + dy, x = tx + k * dx;
      if ((k || dy) && x >= 0 && x < 32 && y >= 0 && y < 32) w[RAM.owLayer1 + at(k, dy)] = w[RAM.owTranslevels + at(k, dy)] = 0;
    }
    w[RAM.owLayer1 + at(2)] = stop;
    w[RAM.owTranslevels + home] = w[RAM.owTranslevels + at(1)] = tl; // (the probed tile enters a level if it can)
    w[RAM.levelFlags + tl] = DIR_FLAGS.reduce<number>((a, b) => a | b, 0); // (not passed: no "no entry")
    const standing = w[RAM.owProcess], start = s.saveState();
    const kinds: PathKind[] = [];
    for (let t = 0; t < 0x100; t++) {
      s.loadState(start);
      w[RAM.owLayer1 + at(1)] = t;
      kinds.push(probe(emu, t, tx, dx, pad, standing));
      yield `Path tiles (${0xff - t})`;
    }
    return kinds;
  } finally { end(); }
}

// Mario sent from (tx) onto tile t next to him (dx): what the overworld does when it looks ahead onto it
function probe(emu: LevelEmulator, t: number, tx: number, dx: number, pad: number, standing: number): PathKind {
  const s = emu.snes, w = s.wram;
  const tileX = () => (get16(w, RAM.owPlayerTileX) - tx) * dx;
  let walking = -1, pose = -1;
  for (let f = 0; f < WALK_FRAMES; f++) {
    s.joy1 = f < 4 ? pad : 0;
    s.runFrame();
    if (walking < 0 && w[RAM.owProcess] !== standing) walking = w[RAM.owProcess];
    if (pose < 0 && tileX() === 1) {
      // looking ahead onto t: an exit switches to another process, a path tile gives its pose
      if (w[RAM.owProcess] !== walking) return 'exit';
      pose = w[RAM.owPose];
    }
    if (tileX() === 2) return pose & 0x10 ? 'climb' : pose & 0x08 ? 'swim' : 'walk';
    if (pose >= 0 && w[RAM.owProcess] === standing) break; // stopped on t
    if (walking < 0 && f > 8) return 'none'; // (he starts at once when he can)
  }
  if (pose < 0 || tileX() !== 1) return 'none';
  for (let f = 0; f < ENTER_FRAMES; f++) {
    s.joy1 = f % 8 < 2 ? PAD.a : 0; // (pressed again and again)
    s.runFrame();
    if (w[RAM.gameMode] === GM.levelLoad) return 'level';
  }
  return 'stop';
}
