// Where Mario died in test play, and what killed him. A death is the game's: the frame its code sets Mario's
// animation to dying ($71 = 9). What killed him is learned from what the code did up to then, not from the
// game's tables: the timer run out (written in the frame, now 000), Mario fallen below the screen, the code of a sprite running (the slot whose
// number the code read last – a sprite loop reads it to run the sprite's code – while X, the slot register of
// all sprite code, still holds that slot), or else the level's tile the code read last (a block's code runs
// for the tile Mario touches).

import type { Snes, MemHook } from './snes.ts';
import { RAM, SPR, MAP_BASE, MAP_SIZE, LEVEL_HEIGHT, LEVEL_LOADED, get16, marioX, marioY, cameraY, spriteX, spriteY } from './ram.ts';
import { SLOT_TABLES, SLOT_KINDS, type SlotKind } from './slotwatch.ts';

const DYING = 9;
const BELOW_SCREEN = 0xc0; // Mario's Y on screen from which he has fallen out of it (the game kills him at $C0+)
const SCREEN_BYTES = 0x1b0; // a horizontal level's screen in the level data (27 rows), without a height of its own
const VERTICAL_SCREEN = 0x200; // a vertical level's (16 rows of two 16-tile halves)

// sprite: a slot's code (a normal sprite by its id as level.ts spriteId gives it, custom ones $2xx/$3xx; an
// extended or cluster sprite by its number) and where the sprite was (pixels); block: the tile (tiles)
export type Killer =
  | { kind: 'sprite'; slots: SlotKind; id: number; x: number; y: number }
  | { kind: 'block'; tx: number; ty: number; tile: number }
  | { kind: 'pit' } | { kind: 'time' } | { kind: 'unknown' };

// a death: the level Mario was in, his tile (his feet stand in it), what killed him
export interface Death { level: number; tx: number; ty: number; killer: Killer }

export class DeathWatch {
  readonly hook: MemHook;
  private deaths: Death[] = [];
  private dying = false;
  private slot: { kind: SlotKind; i: number } | null = null; // the slot whose number was read last in this frame
  private block = -1; // the level data's low byte read last in this frame
  private ticked = false; // the timer was written in this frame (a level without a time limit keeps it at 000)
  private s: Snes;

  constructor(s: Snes) {
    this.s = s;
    this.hook = {
      onWramRead: (a) => this.read(a),
      onWramWrite: (a, v) => {
        if (a >= RAM.timer && a < RAM.timer + 3) this.ticked = true;
        if (a !== RAM.marioAnim) return;
        if (v === DYING && !this.dying) this.deaths.push(this.death());
        this.dying = v === DYING;
      },
    };
  }

  // the deaths since the last call; called once per frame (what the code read before is forgotten)
  take(): Death[] {
    const d = this.deaths;
    this.deaths = [];
    this.slot = null;
    this.block = -1;
    this.ticked = false;
    return d;
  }

  // the machine's state was replaced (a savestate loaded)
  reset(): void {
    this.take();
    this.dying = this.s.wram[RAM.marioAnim] === DYING;
  }

  private read(a: number): void {
    if (a >= MAP_BASE && a < MAP_BASE + MAP_SIZE) { this.block = a; return; }
    for (const kind of SLOT_KINDS) {
      const base = kind === 'sprite' ? SPR.num : SLOT_TABLES[kind].base, i = a - base;
      if (i >= 0 && i < SLOT_TABLES[kind].slots) { this.slot = { kind, i }; return; }
    }
  }

  private death(): Death {
    const w = this.s.wram, x = marioX(w), y = marioY(w);
    return { level: get16(w, LEVEL_LOADED - 0x7e0000), tx: (x + 8) >> 4, ty: (y + 16) >> 4, killer: this.killer(y) };
  }

  private killer(y: number): Killer {
    const w = this.s.wram;
    if (this.ticked && w[RAM.timer] === 0 && w[RAM.timer + 1] === 0 && w[RAM.timer + 2] === 0) return { kind: 'time' };
    if (y - cameraY(w) >= BELOW_SCREEN && y - cameraY(w) < 0x8000) return { kind: 'pit' };
    const sl = this.slot;
    if (sl && (this.s.cpu.x & 0xff) === sl.i) {
      if (sl.kind !== 'sprite') return { kind: 'sprite', slots: sl.kind, id: w[SLOT_TABLES[sl.kind].base + sl.i], ...slotPos(w, sl.kind, sl.i) };
      const eb = w[SPR.extraBits + sl.i];
      const id = eb & 8 ? 0x200 | ((eb & 4) << 6) | w[SPR.customNum + sl.i] : w[SPR.num + sl.i];
      return { kind: 'sprite', slots: 'sprite', id, x: spriteX(w, sl.i), y: spriteY(w, sl.i) };
    }
    if (this.block >= 0) return { kind: 'block', ...blockTile(w, this.block), tile: get16(w, this.block, this.block + 0x10000) };
    return { kind: 'unknown' };
  }
}

// an extended or cluster sprite's position (pixels)
function slotPos(w: Uint8Array, kind: SlotKind, i: number): { x: number; y: number } {
  return kind === 'extended'
    ? { x: get16(w, RAM.extXLo + i, RAM.extXHi + i), y: get16(w, RAM.extYLo + i, RAM.extYHi + i) }
    : { x: get16(w, RAM.clusterXLo + i, RAM.clusterXHi + i), y: get16(w, RAM.clusterYLo + i, RAM.clusterYHi + i) };
}

// the tile of a level data address (layer 1 of the level being played)
export function blockTile(w: Uint8Array, a: number): { tx: number; ty: number } {
  const off = a - MAP_BASE;
  if (w[RAM.screenMode] & 1) {
    const s = Math.floor(off / VERTICAL_SCREEN), r = off % VERTICAL_SCREEN;
    return { tx: ((r >> 8) << 4) | (r & 15), ty: (s << 4) | ((r >> 4) & 15) };
  }
  const bytes = get16(w, LEVEL_HEIGHT) || SCREEN_BYTES, s = Math.floor(off / bytes), r = off % bytes;
  return { tx: (s << 4) | (r & 15), ty: r >> 4 };
}
