// The game's hardcoded paths (CONTEXT.md "Hardcoded path"): ways Mario walks off a level or stop tile where no tile
// next to him is one he walks onto – the game looks his translevel (or, for one entry, his place) and the direction up
// in tables of its code ($049301 ff., $049078 …) and moves him by their steps, over tiles the map needn't have.
// Learned by emulation, not read from the tables: Lunar Magic's "Allow hardcoded default layer 1 paths" (a BRA over the
// lookup at $049307, owoptions.ts) turns them all off, a patch (Kevin's "Custom Overworld Hardcoded Paths", hooking
// $049312) brings its own tables and rules – the game's code says which it takes. Mario is put on each candidate tile
// of the map as the game has it with every event passed (a tile with a translevel, a level, stop, star or pipe tile),
// with every direction open and the tile next to him in the direction emptied (00: no path tile, so the game looks a
// hardcoded path up), and walks off; while the game's flag is set ($1B78, RAM.owHardcodedPath – a patch may store more
// than 1 there) the tiles he steps onto are the path's, the tile he stands on after it where it leads.
// The result depends on the game's code and on the map it is given (layer 1 and the translevels, the job's input: a
// step may take the map's own tile, $58): the overworld's data in the ROM is not recorded as read (owpaths.ts OVERWORLD_DATA).

import type { LevelEmulator } from './levelemu.ts';
import type { Job } from './jobrunner.ts';
import type { Rom } from './rom.ts';
import { l1Index, l1XY, MAX_TRANSLEVEL, readTranslevels } from './overworld.ts';
import { layer1AtEveryProgress } from './owcellhistory.ts';
import { stopsOn, DX, DY, type PathKind } from './owpaths.ts';
import { RAM, GM, PAD, get16, getS16, set16 } from './ram.ts';

// A hardcoded path the game walks from layer 1 tile `from` (l1Index order) in direction `dir` (DIR_NAMES order: up,
// down, left, right): the tiles stepped onto on the way (in order, the last stop not among them), the tile he stops
// on (`to`, -1: he doesn't get anywhere in time) and the direction he steps onto it in (`arrive`)
export interface HardWalk { from: number; dir: number; path: number[]; to: number; arrive: number }

const PADS = [PAD.up, PAD.down, PAD.left, PAD.right];
const START_FRAMES = 12; // until the game started a walk (it starts at once when it can)
const WALK_FRAMES = 1500; // until Mario stands again (a long path, slowly)
const SUBMAPS = 7; // the main map and the 6 submaps (overworld.ts MAP_NAMES)

// the tiles worth trying (l1Index): those with a translevel, and those Mario stops on (a level, stop, star or pipe tile:
// `stops`, from the path kinds) – on the map with every event passed
export function hardWalkCandidates(l1: ArrayLike<number>, tls: ArrayLike<number>, stops: (tile: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < l1.length; i++) if (tls[i] || stops(l1[i])) out.push(i);
  return out;
}

// what the hardcoded paths of a ROM are learned on (hardWalksJob): its layer 1 with every event passed (built from the
// events, owcellhistory.ts), its translevels, the candidate tiles there (kinds: the path kinds)
export function hardWalksInput(rom: Rom, kinds: readonly PathKind[]): { l1: number[]; tls: number[]; cells: number[] } {
  const l1 = layer1AtEveryProgress(rom).at(-1)!, tls = readTranslevels(rom);
  return { l1: Array.from(l1), tls: Array.from(tls), cells: hardWalkCandidates(l1, tls, (t) => kinds[t] === 'level' || stopsOn(kinds[t])) };
}

// The hardcoded paths from the candidate tiles (hardWalkCandidates) of the map l1 / tls (l1Index order; layer 1 with
// every event passed, the translevels), each direction tried; a step per 64 tiles (the result learner's job)
export function hardWalksJob(emu: LevelEmulator, l1: ArrayLike<number>, tls: ArrayLike<number>, cells: readonly number[]): Job<HardWalk[]> {
  return learn(emu, l1, tls, cells);
}

function* learn(emu: LevelEmulator, l1: ArrayLike<number>, tls: ArrayLike<number>, cells: readonly number[]): Generator<string | void, HardWalk[]> {
  emu.startGame(0);
  const s = emu.snes, w = s.wram;
  const standing = w[RAM.owProcess];
  // (Mario's pixel position relative to his tile, as at the start)
  const ox = get16(w, RAM.owPlayerX) - get16(w, RAM.owPlayerTileX) * 16, oy = get16(w, RAM.owPlayerY) - get16(w, RAM.owPlayerTileY) * 16;
  // the overworld loaded on each map (the main map, the submaps): its state and the middle of its view, the map
  // given (a submap's tile is tried on the submap whose view is nearest, as LevelEmulator.startGameAt does)
  const ow = s.saveState(), maps: { state: ReturnType<typeof s.saveState>; cx: number; cy: number }[] = [];
  for (let k = 0; k < SUBMAPS; k++) {
    s.loadState(ow);
    w[RAM.submap] = w[RAM.submap + 1] = k;
    w[RAM.gameMode] = GM.overworldLoad;
    for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 500; f++) s.runFrame();
    for (let f = 0; f < 3; f++) s.runFrame();
    for (let i = 0; i < 0x800; i++) {
      w[RAM.owLayer1 + i] = l1[i] & 0xff;
      w[RAM.owLayer1High + i] = l1[i] >> 8;
      w[RAM.owTranslevels + i] = tls[i];
    }
    w.fill(0x0f, RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1); // every direction open (and nothing passed)
    maps.push({ state: s.saveState(), cx: getS16(w, RAM.layer1X) + 128, cy: getS16(w, RAM.layer1Y) + 112 });
  }
  const mapOf = (i: number) => {
    if (i < 0x400) return 0;
    const { x, y } = l1XY(i);
    let best = Infinity, sub = 1;
    for (let k = 1; k < SUBMAPS; k++) {
      const d = Math.max(Math.abs(x * 16 + 8 - maps[k].cx), Math.abs(y * 16 + 8 - maps[k].cy));
      if (d < best) { best = d; sub = k; }
    }
    return sub;
  };
  const flag = () => w[RAM.owHardcodedPath] | w[RAM.owHardcodedPath + 1];
  const out: HardWalk[] = [];
  for (let c = 0; c < cells.length; c++) {
    const i = cells[c], { x, y } = l1XY(i), region = i >> 10;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      s.loadState(maps[mapOf(i)].state);
      for (const o of [0, RAM.owPlayerStride]) { // Mario and Luigi
        set16(w, RAM.owPlayerX + o, x * 16 + ox); set16(w, RAM.owPlayerY + o, y * 16 + oy);
        set16(w, RAM.owPlayerTileX + o, x); set16(w, RAM.owPlayerTileY + o, y);
      }
      if (nx >= 0 && ny >= 0 && nx < 32 && ny < 32) {
        const n = l1Index(region, nx, ny);
        w[RAM.owLayer1 + n] = w[RAM.owLayer1High + n] = 0;
      }
      const walk = probe(d, i, region);
      if (walk) out.push(walk);
    }
    if (c % 64 === 63) yield `Hardcoded paths (${cells.length - 1 - c})`;
  }
  return out;

  // Mario walks off his tile i in direction d: the hardcoded path, if the game takes one
  function probe(d: number, i: number, region: number): HardWalk | null {
    const tile = () => l1Index(region, get16(w, RAM.owPlayerTileX), get16(w, RAM.owPlayerTileY));
    let on = false;
    for (let f = 0; f < START_FRAMES && !on; f++) {
      s.joy1 = f < 4 ? PADS[d] : 0;
      s.runFrame();
      on = flag() !== 0;
    }
    s.joy1 = 0;
    if (!on) return null;
    const path: number[] = [];
    let cur = i;
    for (let f = 0; f < WALK_FRAMES; f++) {
      s.runFrame();
      const t = tile();
      if (t !== cur) { path.push(t); cur = t; }
      if (!flag() && w[RAM.owProcess] === standing) {
        const to = path.pop() ?? -1, before = path.at(-1) ?? i;
        return { from: i, dir: d, path, to, arrive: to < 0 ? d : stepDir(before, to) };
      }
    }
    return { from: i, dir: d, path, to: -1, arrive: path.length > 1 ? stepDir(path.at(-2)!, path.at(-1)!) : d };
  }
}

// the direction from tile a to the tile b next to it (DIR_NAMES order)
export function stepDir(a: number, b: number): number {
  const p = l1XY(a), q = l1XY(b);
  return q.y < p.y ? 0 : q.y > p.y ? 1 : q.x < p.x ? 2 : 3;
}
