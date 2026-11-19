// Path tiles: what Mario does on each layer 1 tile of the overworld – walks, climbs or swims along it, takes it
// as an exit to another submap, stops on it (entering a level or not), or doesn't go there. Invisible in the
// game, so the editor draws them as an overlay. Learned by emulation, not from a list: in a new game, Mario on
// his start tile is given a way with the tile next to him and a stop tile after it, and walks there. The
// overworld looks one tile ahead as he goes: onto a path tile it gives him its pose (swimming, climbing) or
// switches to another submap (an exit); on a tile he stops at, A tells whether it enters a level or looks his place up
// in the star/pipe table (a warp: a star or pipe, owteleport.ts – it warps where the table has an entry). So a patched
// game's tiles show what they do there. The result depends on the game's code only: the overworld's data
// (overworldDataRanges, what is painted) is not read as far as the result is concerned.

import type { LevelEmulator } from './levelemu.ts';
import type { Job } from './jobrunner.ts';
import type { LeftOut } from './bootsnapshot.ts';
import { l1Index, overworldDataRanges, DIR_FLAGS, OW_L1_TILES } from './overworld.ts';
import { starTableRanges } from './owteleport.ts';
import { joinHooks } from './snes.ts';
import { RAM, GM, PAD, get16, getS16 } from './ram.ts';

export const PATH_KINDS = ['walk', 'climb', 'swim', 'exit', 'stop', 'warp', 'level', 'none'] as const;
export type PathKind = (typeof PATH_KINDS)[number];
// the kinds drawn as path tiles (a level tile shows itself)
export const isPathKind = (k: PathKind): boolean => k !== 'level' && k !== 'none';
// whether Mario stops on a tile of kind k without entering a level: a stop tile, or a star or pipe (a warp: he stops on
// it, A warps him)
export const stopsOn = (k: PathKind | undefined): boolean => k === 'stop' || k === 'warp';
// whether a layer 1 tile is a level tile: one the game enters a level from (kind 'level'), as learned here – so a
// patch changing which tiles enter levels is followed, no range of tile numbers is assumed
export type LevelTileTest = (tile: number) => boolean;
export const levelTileTest = (kinds: readonly PathKind[]): LevelTileTest => (t) => kinds[t] === 'level';
export const PATH_KIND_NAMES: Record<PathKind, string> = {
  walk: 'Path: walk', climb: 'Path: climb', swim: 'Path: swim', exit: 'Path: exit to another submap',
  stop: 'Path: Mario stops, enters no level', warp: 'Path: star or pipe, A warps', level: 'Level tile', none: 'No path',
};

const WALK_FRAMES = 90; // until Mario reached the tile after the probed one or stopped (a climb is slow)
const ENTER_FRAMES = 60; // A pressed on a tile he stopped at, until a level loads

// The overworld's data the editor writes (overworldDataRanges): left out besides by a result that loads the overworld
// and depends on the game's code only – the path kinds, the path shapes, the reveal walks (revealwalk.ts) and the
// hardcoded paths (owhardpaths.ts). Their kind of learn job names it (probeprotocol.ts LEARN_KINDS), as whoever runs
// one of them does: the job runner's recording of a job's steps is the outermost.
export const OVERWORLD_DATA: LeftOut = {
  what: 'overworld data',
  mask: (rom) => {
    const mask = new Uint8Array(rom.data.length);
    for (const [a, b] of overworldDataRanges(rom)) mask.fill(1, a, Math.min(b, mask.length));
    return mask;
  },
};

// The kind of every layer 1 tile 000–1FF (its high byte at $7FC800, overworld.ts readL1), a tile per step (the result
// learner's job). The overworld's data the editor writes isn't recorded as read (OVERWORLD_DATA).
export function pathKindsJob(emu: LevelEmulator): Job<PathKind[]> {
  return probeAll(emu);
}

function* probeAll(emu: LevelEmulator): Generator<string | void, PathKind[]> {
  emu.startGame(0);
  const s = emu.snes, w = s.wram;
  const map = w[RAM.submap] ? 1 : 0, tx = get16(w, RAM.owPlayerTileX), ty = get16(w, RAM.owPlayerTileY);
  const dx = tx + 2 < 32 ? 1 : -1, pad = dx > 0 ? PAD.right : PAD.left;
  const at = (k: number, dy = 0) => l1Index(map, tx + k * dx, ty + dy);
  // the way: his tile (translevel 1, every direction open), the probed tile (the same translevel), a stop tile
  // (his own: what is painted there matters), nothing around
  const home = at(0), tl = 1, L = RAM.owLayer1, H = RAM.owLayer1High;
  for (let dy = -1; dy <= 1; dy++) for (let k = -1; k <= 3; k++) {
    const y = ty + dy, x = tx + k * dx;
    if ((k || dy) && x >= 0 && x < 32 && y >= 0 && y < 32) w[L + at(k, dy)] = w[H + at(k, dy)] = w[RAM.owTranslevels + at(k, dy)] = 0;
  }
  w[L + at(2)] = w[L + home];
  w[H + at(2)] = w[H + home];
  w[RAM.owTranslevels + home] = w[RAM.owTranslevels + at(1)] = tl; // (the probed tile enters a level if it can)
  w[RAM.levelFlags + tl] = DIR_FLAGS.reduce<number>((a, b) => a | b, 0); // (not passed: no "no entry")
  const standing = w[RAM.owProcess], start = s.saveState();
  const kinds: PathKind[] = [], table = starTableRanges(emu.rom);
  for (let t = 0; t < OW_L1_TILES; t++) {
    s.loadState(start);
    w[L + at(1)] = t & 0xff;
    w[H + at(1)] = t >> 8;
    kinds.push(probe(emu, t, tx, dx, pad, standing, table));
    yield `Path tiles (${OW_L1_TILES - 1 - t})`;
  }
  return kinds;
}

// Mario sent from (tx) onto tile t next to him (dx): what the overworld does when it looks ahead onto it
// (table: the star/pipe table's bytes). Told by the look-ahead's writes of his tile ($1F1F: onto t, then onto the
// tile after it – he walked on over t), not by where he stands at a frame's end: code where he stops may set it
// again (Kevin's "Custom Overworld Hardcoded Paths" from his pixel position, $04952D, which the vectors of the
// swimming tiles 29 and 37 leave in t's cell)
function probe(emu: LevelEmulator, t: number, tx: number, dx: number, pad: number, standing: number, table: [number, number][]): PathKind {
  const s = emu.snes, w = s.wram;
  // the furthest tile (0 his own, 1 t, 2 the one after) the look-ahead put him on, the pose it gave him on t (the last
  // written while on t: the look-ahead onto the tile after may come in the same frame)
  let reached = 0, pose = -1;
  const outer = s.hook, ahead = {
    onWramWrite: (a: number, v: number) => {
      if (a === RAM.owPlayerTileX) reached = Math.max(reached, (v - tx) * dx);
      else if (a === RAM.owPose && reached === 1) pose = v;
    },
  };
  s.hook = outer ? joinHooks(outer, ahead) : ahead;
  let walking = -1, onT = false;
  try {
    for (let f = 0; f < WALK_FRAMES; f++) {
      s.joy1 = f < 4 ? pad : 0;
      s.runFrame();
      if (walking < 0 && w[RAM.owProcess] !== standing) walking = w[RAM.owProcess];
      if (!onT && reached >= 1) {
        // looked ahead onto t: an exit switches to another process, a path tile gives its pose
        if (w[RAM.owProcess] !== walking) return 'exit';
        onT = true;
      }
      if (reached >= 2) return pose & 0x10 ? 'climb' : pose & 0x08 ? 'swim' : 'walk';
      if (onT && w[RAM.owProcess] === standing) break; // stopped on t
      if (walking < 0 && f > 8) return 'none'; // (he starts at once when he can)
    }
  } finally { s.hook = outer; }
  if (!onT || reached !== 1) return 'none';
  // A pressed: a level loads, or the star/pipe table is read (no entry for the probed place: nothing happens then, the
  // game warps where it has one), or nothing
  let read = false;
  const base = s.hook, look = { onRomRead: (o: number) => { if (!read && table.some(([a, b]) => o >= a && o < b)) read = true; } };
  s.hook = base ? joinHooks(base, look) : look;
  try {
    for (let f = 0; f < ENTER_FRAMES; f++) {
      s.joy1 = f % 8 < 2 ? PAD.a : 0; // (pressed again and again)
      s.runFrame();
      if (w[RAM.gameMode] === GM.levelLoad) return 'level';
      if (read) return 'warp';
    }
  } finally { s.hook = base; }
  return 'stop';
}

// Path shapes: how Mario moves over a path tile, by the tile and the way he steps onto it – the game moves him by the
// tile's vector in pixels from where he is (a straight tile a tile on, a bend half a tile each way …) when it looks
// ahead onto the tile ($04971D: the target $0DC7, the sum's low 2 bits cleared), and turns him by where that ends: on
// a tile's left/right edge he goes on left or right, else on its top/bottom edge up or down, else as before ($0497F4,
// the way kept in $0DD3). His first step off a stop tile is a vector of its own ($049384: half a tile, other ones for
// some tiles), the way kept. From each tile the overworld looks ahead the way he has first (owreach.ts). Learned by
// emulation, as the path kinds: on the main map Mario walks off a stop tile onto tile t in each direction; where his
// first step ends and where the look-ahead onto t sends him give t's vectors. The result depends on the game's code
// only.
// first, walk: per tile * 4 + the way he steps onto it (DIR_NAMES order: up, down, left, right) the vector (x, y at
// index * 2, * 2 + 1); NO_SHAPE where he doesn't step onto it (tiles 00, 56 and up, no path; on page 1 100, 156 and
// up). An exit tile has vectors too: its walk vector is the one he walks on by from where the exit path table puts him
// on the other submap ($04971D after $049A24) – its axis is the exit's (owpathshape.ts exitAxis).
// pose: per tile * 4 + the way, the pose the look-ahead gives him (RAM owPose: bit 3 swimming, bit 4 climbing), -1
// where he doesn't step onto it
export interface PathShapes { first: number[]; walk: number[]; pose: number[] }
export const NO_SHAPE = -0x8000;
export const DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0];
const SHAPE_FRAMES = 40; // until the overworld looked ahead onto the tile (Mario walked half a tile)
const PADS = [PAD.up, PAD.down, PAD.left, PAD.right];
export const PATH_TILES_END = 0x56; // the tiles below are walked over (on each page of the Map16)

export function pathShapesJob(emu: LevelEmulator): Job<PathShapes> {
  return probeShapes(emu);
}

function* probeShapes(emu: LevelEmulator): Generator<string | void, PathShapes> {
  // the tile Mario starts on (a stop tile: what is painted there matters), then Mario in the middle of the main map
  // with nothing around
  emu.startGame(0);
  let w = emu.snes.wram;
  const L = RAM.owLayer1, H = RAM.owLayer1High, own = l1Index(w[RAM.submap] ? 1 : 0, get16(w, RAM.owPlayerTileX), get16(w, RAM.owPlayerTileY));
  const stop = w[L + own], stopHi = w[H + own];
  const hx = 16, hy = 16, home = l1Index(0, hx, hy);
  emu.startGameAt(home);
  const s = emu.snes;
  w = s.wram;
  for (let y = hy - 3; y <= hy + 3; y++) for (let x = hx - 3; x <= hx + 3; x++) w[L + l1Index(0, x, y)] = w[H + l1Index(0, x, y)] = w[RAM.owTranslevels + l1Index(0, x, y)] = 0;
  w[L + home] = stop;
  w[H + home] = stopHi;
  w[RAM.owTranslevels + home] = 1;
  w[RAM.levelFlags + 1] = DIR_FLAGS.reduce<number>((a, b) => a | b, 0);
  const standing = w[RAM.owProcess], start = s.saveState();
  const px = get16(w, RAM.owPlayerX), py = get16(w, RAM.owPlayerY);
  const target = () => [getS16(w, RAM.owTarget), getS16(w, RAM.owTarget + 2)];
  const out: PathShapes = {
    first: new Array(OW_L1_TILES * 8).fill(NO_SHAPE), walk: new Array(OW_L1_TILES * 8).fill(NO_SHAPE), pose: new Array(OW_L1_TILES * 4).fill(-1),
  };
  const tiles = [0, 0x100].flatMap((page) => Array.from({ length: PATH_TILES_END - 1 }, (_, k) => page + 1 + k));
  for (const t of tiles) {
    for (let d = 0; d < 4; d++) {
      s.loadState(start);
      const x1 = hx + DX[d], y1 = hy + DY[d], k = t * 4 + d;
      w[L + l1Index(0, x1, y1)] = t & 0xff;
      w[H + l1Index(0, x1, y1)] = t >> 8;
      let first: number[] | null = null;
      for (let f = 0; f < SHAPE_FRAMES; f++) {
        s.joy1 = f < 4 ? PADS[d] : 0;
        s.runFrame();
        if (!first && w[RAM.owProcess] !== standing) { first = target(); out.first[k * 2] = first[0] - px; out.first[k * 2 + 1] = first[1] - py; }
        // (the look-ahead onto it, where his first step ends, sets his tile and the next target at once)
        if (first && get16(w, RAM.owPlayerTileX) === x1 && get16(w, RAM.owPlayerTileY) === y1) {
          const [x, y] = target();
          out.walk[k * 2] = x - first[0]; out.walk[k * 2 + 1] = y - first[1];
          out.pose[k] = w[RAM.owPose];
          break;
        }
      }
    }
    yield `Path shapes (${tiles.length - 1 - tiles.indexOf(t)})`;
  }
  s.joy1 = 0;
  return out;
}

// a tile's vector stepping onto it in direction dir (v: PathShapes' first or walk), where none is known `len` pixels
// on (half a tile for a first step, a tile walking on)
export function shapeVector(v: readonly number[], t: number, dir: number, len: number): [number, number] {
  const k = (t * 4 + dir) * 2;
  return v[k] === NO_SHAPE || v[k] === undefined ? [DX[dir] * len, DY[dir] * len] : [v[k], v[k + 1]];
}
// the direction opposite to dir (DIR_NAMES order: up, down, left, right)
export const reverse = (dir: number): number => dir ^ 1;
// the direction a vector points: along x where `alongX`, else along y (DIR_NAMES order)
export const dirOf = (vx: number, vy: number, alongX: boolean): number => (alongX ? (vx < 0 ? 2 : 3) : vy < 0 ? 0 : 1);
// Mario moved by a tile's vector (vx, vy) to (x, y) (pixels, the low 2 bits cleared), going in direction dir: the
// direction he goes on in – turned on a tile's left/right edge left or right, else on its top/bottom edge up or down,
// else as before
export const turnedAt = (x: number, y: number, vx: number, vy: number, dir: number): number =>
  !(x & 15) || !(y & 15) ? dirOf(vx, vy, !(x & 15)) : dir;
