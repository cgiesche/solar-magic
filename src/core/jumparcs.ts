// Jump arcs: where Mario gets when he jumps from a tile of the edited level, found by playing it.
// The level is loaded once without sprites (only the terrain matters) and kept as a snapshot in
// gameplay; for each arc Mario is dropped onto the tile (on a slope he stands on its surface) and
// kept there for a few frames with the speed and P-meter of a running state (measured by
// BlockProber.runStates), holds the direction (and Y when running) and B for a full
// jump, and his position is recorded every frame until he lands, dies or time runs out. Walls,
// ceilings, slopes and platforms of the level stop or catch him as in the game.

import { LevelEmulator, type LevelOverride } from './levelemu.ts';
import type { Rom } from './rom.ts';
import type { SnesState } from './snes.ts';
import { PAD, type RunStates, type RunState } from './blockprobe.ts';
import { GM, RAM, setCameraX, setCameraY, marioX, getS16, marioY, setMarioPos } from './ram.ts';

export type ArcSpeed = 'stand' | 'walk' | 'run' | 'p';
export const ARC_SPEEDS: ArcSpeed[] = ['stand', 'walk', 'run', 'p'];

export interface JumpArc {
  speed: ArcSpeed;
  dir: 1 | -1;
  pts: number[]; // x, y pairs: the middle of Mario's feet in level pixels, one per frame
  end: 'land' | 'dead' | 'time';
}

const MAX_FRAMES = 150;
const SETTLE_FRAMES = 12; // dropping Mario onto the tile before an arc
const WARM_FRAMES = 6; // on the ground with the running state before the jump
const LOAD_FRAMES = 300; // until gameplay with Mario standing (entrance animations)

export class JumpArcs {
  emu: LevelEmulator;
  private ready: SnesState | null = null;
  private height = 0; // level height in pixels (falling below ends an arc)

  constructor(rom: Rom, boot?: LevelEmulator) {
    this.emu = new LevelEmulator(rom);
    if (boot?.baseState) this.emu.adoptBoot(boot);
  }

  // Loads the level (overrides as for rendering; sprites are left out) and runs it to gameplay.
  // false when it doesn't get there.
  prepare(level: number, ov: LevelOverride, spriteHeader: number, height: number): boolean {
    this.ready = null;
    this.height = height;
    const e = this.emu;
    e.syncRom();
    const r = e.load(level, { ...ov, sprites: new Uint8Array([spriteHeader, 0xff]), byteOwner: undefined });
    if (!r.ok) return false;
    const s = e.snes, w = s.wram;
    try {
      for (let f = 0; f < LOAD_FRAMES && !(w[RAM.gameMode] === GM.level && w[RAM.marioAnim] === 0 && !w[RAM.spritesLocked]); f++) s.runFrame();
    } catch { return false; }
    if (w[RAM.gameMode] !== GM.level) return false;
    this.ready = s.saveState();
    return true;
  }

  get prepared(): boolean { return this.ready !== null; }

  // Mario (small) standing in tile (tx, ty) jumps in direction dir ('stand': from standing still,
  // holding the direction). He is dropped in at the tile top first, so on a slope he stands on its
  // surface (his feet where he lands within the tile); otherwise his feet are at the tile bottom.
  arc(tx: number, ty: number, speed: ArcSpeed, dir: 1 | -1, runs: RunStates): JumpArc {
    const s = this.emu.snes, w = s.wram;
    s.loadState(this.ready!);
    const x = tx * 16;
    let y = ty * 16 - 16;
    const cam = Math.max(0, x - 0x70), camY = Math.max(0, Math.min(this.height - 224, y - 0x70));
    setCameraX(w, cam);
    setCameraY(w, camY);
    w[RAM.powerup] = 0;
    const st: RunState = speed === 'stand' ? { vx: 0, pmeter: 0 } : runs[speed];
    const place = (resetVy = true) => {
      setMarioPos(w, x, y);
      w[RAM.marioSpeedX] = (st.vx * dir) & 0xff; if (resetVy) w[RAM.marioSpeedY] = 0; w[RAM.pMeter] = st.pmeter; w[RAM.marioDir] = dir > 0 ? 1 : 0;
    };
    const settle = () => {
      const top = ty * 16 - 32;
      setMarioPos(w, x, top);
      w[RAM.marioSpeedX] = w[RAM.marioSpeedY] = 0; s.joy1 = 0;
      // the blocked flags of the first frame are still those from before
      let last = top;
      for (let f = 0; f < SETTLE_FRAMES; f++) {
        s.runFrame();
        const my = getS16(w, RAM.marioY);
        if (my > y) return;
        if (f > 0 && (w[RAM.marioBlocked] & 4) && my === last) { y = my; return; }
        last = my;
      }
    };
    const hold = (dir > 0 ? PAD.right : PAD.left) | (speed === 'run' || speed === 'p' ? PAD.y : 0);
    const pos = () => [marioX(w) + 8, getS16(w, RAM.marioY) + 32];
    const pts: number[] = [];
    let end: JumpArc['end'] = 'time';
    try {
      // a few frames on the ground first, holding the direction and put back each time with the
      // running state: a jump needs the ground, and walking down a slope the game keeps Mario on it
      // with a Y speed it builds up (zeroed, he would lift off the slope and not jump); then B as a
      // new press
      settle();
      place();
      s.joy1 = hold;
      for (let i = 0; i < WARM_FRAMES; i++) { place(false); s.runFrame(); }
      place(false);
      pts.push(...pos());
      let air = false;
      for (let f = 0; f < MAX_FRAMES; f++) {
        s.joy1 = hold | PAD.b;
        s.runFrame();
        pts.push(...pos());
        if (w[RAM.marioAnim] === 9) { end = 'dead'; break; }
        const ground = (w[RAM.marioBlocked] & 4) !== 0;
        if (!ground) air = true;
        else if (air) { end = 'land'; break; }
        if (pts[pts.length - 1] > this.height + 32) { end = 'dead'; break; }
      }
    } catch { /* what was recorded */ }
    s.joy1 = 0;
    return { speed, dir, pts, end };
  }
}
