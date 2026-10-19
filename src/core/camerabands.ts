// The game view frame (Lunar Magic's Game View Screen): what the player sees, a 256x224 screen over the level,
// with bands where Mario is on that screen while the camera scrolls right, left, up and down, and while it
// follows him after L or R moved it ahead. The bands are learned by moving Mario in the probe level
// (BlockProber.cameraBands) and reading his position on the screen in the frames the camera moves, not from a
// table: walking, running and at P-speed for the horizontal ones, rising at two speeds and falling for the
// vertical ones (the level scrolling vertically), walking on after L/R panned the screen for the look-ahead.

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

const PAN_FRAMES = 100; // holding L/R until the screen has panned
const WALK_FRAMES = 150, RUN_FRAMES = 240; // running: up to P-speed

// The probe level for one measurement, in gameplay: Mario (big) at pixel X x with the camera's X around him,
// standing on a floor across the level; or (air) in the air without one, screenY below the camera's top,
// which is at the top (camTop) or the bottom of the level
export type BandStart = (x: number, air?: { screenY: number; camTop: boolean }) => Snes;

export function measureCameraBands(start: BandStart): CameraBands {
  // runs frames with the joypad from pad(f) (and before(f) each frame), recording Mario's screen position in
  // the frames the camera moved toward dir
  const run = (s: Snes, frames: number, pad: (f: number) => number, dir: 'right' | 'left' | 'up' | 'down', acc: number[], before?: () => void) => {
    const w = s.wram, axis = dir === 'right' || dir === 'left' ? RAM.layer1X : RAM.layer1Y, sign = dir === 'right' || dir === 'down' ? 1 : -1;
    const mario = axis === RAM.layer1X ? RAM.marioX : RAM.marioY;
    let cam = getS16(w, axis);
    try {
      for (let f = 0; f < frames; f++) {
        s.joy1 = pad(f);
        before?.();
        s.runFrame();
        const c = getS16(w, axis);
        if ((c - cam) * sign > 0) acc.push(getS16(w, mario) - c);
        cam = c;
        if (w[RAM.marioAnim] === 9) break; // died
      }
    } finally { s.joy1 = 0; }
  };
  const band = (acc: number[], size: number): Band | null => (acc.length ? { from: Math.min(...acc), to: Math.max(...acc) + size } : null);
  const LEFT_X = 0x300, RIGHT_X = 0x1000; // starting far from the level's ends both ways
  const horizontal = (dir: 'right' | 'left', look: boolean): Band | null => {
    const acc: number[] = [], hold = dir === 'right' ? PAD.right : PAD.left;
    // from standing, and (not after L/R) turning around after walking the other way: the camera catches up then
    for (const turn of look ? [false] : [false, true]) for (const [pad, frames] of [[hold, WALK_FRAMES], [hold | PAD.y, RUN_FRAMES]]) {
      const s = start(dir === 'right' ? LEFT_X : RIGHT_X);
      if (look) { const p = dir === 'right' ? PAD.r : PAD.l; run(s, PAN_FRAMES, (f) => (f < PAN_FRAMES - 10 ? p : 0), dir, []); }
      if (turn) run(s, WALK_FRAMES, () => (dir === 'right' ? PAD.left : PAD.right), dir, []);
      run(s, frames, () => pad, dir, acc);
    }
    return band(acc, MARIO_W);
  };
  const vertical = (dir: 'up' | 'down'): Band | null => {
    const acc: number[] = [];
    if (dir === 'down') {
      const s = start(LEFT_X, { screenY: 16, camTop: true });
      setScrollAlways(s);
      run(s, 1, () => 0, 'down', []);
      run(s, 120, () => 0, 'down', acc);
    } else for (const vy of [-0x20, -0x40]) {
      const s = start(LEFT_X, { screenY: 160, camTop: false });
      setScrollAlways(s);
      run(s, 1, () => 0, 'up', []); // (the game keeps the camera inside the level first)
      // the camera scrolls up only while the game lets it ($1404: Mario flying, climbing …)
      run(s, 120, () => 0, 'up', acc, () => { s.wram[RAM.marioSpeedY] = vy & 0xff; s.wram[RAM.scrollUp] = 1; });
    }
    return band(acc, MARIO_H);
  };
  return {
    right: horizontal('right', false), left: horizontal('left', false),
    up: vertical('up'), down: vertical('down'),
    lookRight: horizontal('right', true), lookLeft: horizontal('left', true),
  };
}

// the level scrolls vertically all the time (the header's vertical scroll "always")
function setScrollAlways(s: Snes): void { s.wram[RAM.scrollV] = 1; }

// where the frame goes when it is put at level pixel (x, y): on the 8x8 grid, inside a level of w x h pixels
export function gameViewAt(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const at = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, max), Math.round(v / 8) * 8));
  return { x: at(x, w - GAME_VIEW_W), y: at(y, h - GAME_VIEW_H) };
}
