// The game view frame (Lunar Magic's Game View Screen): what the player sees, a 256x224 screen over the level,
// with bands where Mario is on that screen while the camera scrolls right, left, up and down, and while it
// follows him after L or R moved it ahead. The bands are learned by moving Mario in a probe level with the open
// level's mode and vertical scroll setting (BlockProber.cameraBands) and reading his position on the screen in
// the frames the camera moves, not from a table: walking, running and at P-speed for the horizontal ones;
// climbing a vine and jumping up a staircase (as he rises in the game), and falling onto a floor (from the top,
// and after the climb) for the vertical ones; walking on after L/R panned the screen for the look-ahead. Where
// the setting keeps the camera still, it never moves and there is no band.

import type { Snes } from './snes.ts';
import { RAM, getS16 } from './ram.ts';
import { PAD } from './blockprobe.ts';

export const GAME_VIEW_W = 256, GAME_VIEW_H = 224;
export const MARIO_W = 16, MARIO_H = 32; // big Mario's box from his position

// screen pixels [from, to): X for right, left, lookRight and lookLeft, Y for up and down; null: the camera never
// moved that way
export interface Band { from: number; to: number }
export interface CameraBands {
  right: Band | null; left: Band | null; up: Band | null; down: Band | null;
  lookRight: Band | null; lookLeft: Band | null; // walking right after R, left after L
}

// The probe level the bands are learned in: empty, with the open level's mode and vertical scroll setting
export interface BandStage {
  width: number; height: number; // in pixels
  floor: number; climb: number; // Map16 tiles Mario stands on and climbs in (found by trying); -1: none
  // a fresh level: Mario (big) at pixel (x, y), in the air, the camera at (cx, cy) as far as the level lets it
  start(x: number, y: number, cx: number, cy: number): Snes;
  put(tx: number, ty: number, tile: number): void;
}

const PAN_FRAMES = 100; // holding L/R until the screen has panned
const WALK_FRAMES = 150, RUN_FRAMES = 240; // running: up to P-speed
const FALL_FRAMES = 240, CLIMB_FRAMES = 480, STAIRS_FRAMES = 600;
const STEP_W = 4, STEP_H = 2; // the staircase: tiles across and up a step

type Dir = 'right' | 'left' | 'up' | 'down';

export function measureCameraBands(st: BandStage): CameraBands {
  // runs frames with the joypad from pad(f), recording Mario's screen position in the frames the camera moved
  // toward dir
  const run = (s: Snes, frames: number, pad: (f: number) => number, dir: Dir, acc: number[]) => {
    const w = s.wram, axis = dir === 'right' || dir === 'left' ? RAM.layer1X : RAM.layer1Y, sign = dir === 'right' || dir === 'down' ? 1 : -1;
    const mario = axis === RAM.layer1X ? RAM.marioX : RAM.marioY;
    let cam = getS16(w, axis);
    try {
      for (let f = 0; f < frames; f++) {
        s.joy1 = pad(f);
        s.runFrame();
        const c = getS16(w, axis);
        if ((c - cam) * sign > 0) acc.push(getS16(w, mario) - c);
        cam = c;
        if (w[RAM.marioAnim] === 9) break; // died
      }
    } finally { s.joy1 = 0; }
  };
  const band = (acc: number[], size: number): Band | null => (acc.length ? { from: Math.min(...acc), to: Math.max(...acc) + size } : null);
  const rows = st.height >> 4, cols = st.width >> 4, fy = rows - 2; // the floor's row, near the bottom
  const groundY = fy * 16 - MARIO_H, bottom = st.height - GAME_VIEW_H;
  const floor = (from = 0, to = cols) => { for (let c = from; c < to; c++) st.put(c, fy, st.floor); };
  // starting far from the level's ends both ways, as far as it is wide
  const margin = Math.min(0x300, (st.width - GAME_VIEW_W) >> 2) & ~15;
  const fromX = (dir: 'right' | 'left') => (dir === 'right' ? margin : st.width - margin - MARIO_W);
  const around = (x: number) => x - 0x70;
  const horizontal = (dir: 'right' | 'left', look: boolean): Band | null => {
    const acc: number[] = [], hold = dir === 'right' ? PAD.right : PAD.left;
    // from standing, and (not after L/R) turning around after walking the other way: the camera catches up then
    for (const turn of look ? [false] : [false, true]) for (const [pad, frames] of [[hold, WALK_FRAMES], [hold | PAD.y, RUN_FRAMES]]) {
      // (L/R from the middle: at a level's end the camera may have no room to pan)
      const x = look ? (st.width >> 1) & ~15 : fromX(dir), s = st.start(x, groundY, around(x), bottom);
      floor();
      run(s, 1, () => 0, dir, []); // (the game keeps the camera inside the level first)
      if (look) { const p = dir === 'right' ? PAD.r : PAD.l; run(s, PAN_FRAMES, (f) => (f < PAN_FRAMES - 10 ? p : 0), dir, []); }
      if (turn) run(s, WALK_FRAMES, () => (dir === 'right' ? PAD.left : PAD.right), dir, []);
      run(s, frames, () => pad, dir, acc);
    }
    return band(acc, MARIO_W);
  };
  const x0 = fromX('right');
  // rising as in the game, climbing a vine from the floor up to the top and jumping up a staircase; falling
  // from the top of the level with the camera put there and, as in the game, after the climb, onto the floor
  const upAcc: number[] = [], downAcc: number[] = [];
  if (st.climb >= 0) {
    const s = st.start(x0, groundY, around(x0), bottom);
    floor();
    for (let r = 0; r < fy; r++) st.put(x0 >> 4, r, st.climb);
    run(s, 1, () => 0, 'up', []);
    run(s, CLIMB_FRAMES, () => PAD.up, 'up', upAcc);
    run(s, 10, (f) => (f < 2 ? PAD.b : 0), 'down', downAcc); // jumping off
    run(s, FALL_FRAMES, () => 0, 'down', downAcc);
  }
  {
    const s = st.start(x0, groundY, around(x0), bottom), w = s.wram, c0 = (x0 >> 4) + 3;
    floor();
    for (let c = c0; c < cols; c++) {
      const top = fy - Math.floor((c - c0) / STEP_W + 1) * STEP_H;
      if (top < 2) break;
      for (let r = top; r < fy; r++) st.put(c, r, st.floor);
    }
    run(s, 1, () => 0, 'up', []);
    // walking right, B held in the air and let go a frame on the ground, so he jumps again
    let held = 0;
    run(s, STAIRS_FRAMES, () => PAD.right | (w[RAM.marioInAir] || !(held++ & 1) ? PAD.b : 0), 'up', upAcc);
  }
  {
    const s = st.start(x0, 16, around(x0), 0);
    floor();
    run(s, 1, () => 0, 'down', []);
    run(s, FALL_FRAMES, () => 0, 'down', downAcc);
  }
  return {
    right: horizontal('right', false), left: horizontal('left', false),
    up: band(upAcc, MARIO_H), down: band(downAcc, MARIO_H),
    lookRight: horizontal('right', true), lookLeft: horizontal('left', true),
  };
}
