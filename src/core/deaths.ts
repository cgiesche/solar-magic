// Where Mario died in test play, and what killed him. A death is the game's: the frame its code sets Mario's
// animation to dying. What killed him is learned from what the code did up to then, not from the game's
// tables: the timer run out (written in the frame, now 000), Mario fallen below the screen, else what the
// code read last of two: a slot of a sprite table read for the slot in X (sprite code keeps its own slot
// there: a sprite's code touching Mario reads its position), or a tile of layer 1 (a block's code runs for
// the tile Mario touches).

import type { Snes, MemHook } from './snes.ts';
import { RAM, SPR, MAP_BASE, MAP_SIZE, LEVEL_HEIGHT, MARIO_DYING, get16, levelLoaded, map16Tile, marioX, marioY, marioTile, cameraY, spriteX, spriteY } from './ram.ts';
import { SLOT_TABLES, SLOT_KINDS, type SlotKind } from './slotwatch.ts';
import { spriteId } from './level.ts';

const BELOW_SCREEN = 0xc0; // Mario's Y on the screen from which he has fallen out of it
const SCREEN_BYTES = 0x1b0; // a horizontal level's screen in the level data (27 rows), without a height of its own
const VERTICAL_SCREEN = 0x200; // a vertical level's (16 rows of two 16-tile halves)

// per kind of slot: the tables its code reads for its own slot (number or status, position)
const OWN_TABLES: Record<SlotKind, number[]> = {
  sprite: [SPR.num, SPR.status, SPR.xLo, SPR.xHi, SPR.yLo, SPR.yHi],
  extended: [RAM.extSprites, RAM.extXLo, RAM.extXHi, RAM.extYLo, RAM.extYHi],
  cluster: [RAM.clusterSprites, RAM.clusterXLo, RAM.clusterXHi, RAM.clusterYLo, RAM.clusterYHi],
};

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
  // what the code read last in this frame: a slot for the slot in X, a layer 1 tile (its level data address)
  private last: { kind: SlotKind; i: number } | { block: number } | null = null;
  private ticked = false; // the timer was written in this frame (a level without a time limit keeps it at 000)
  private s: Snes;

  constructor(s: Snes) {
    this.s = s;
    this.hook = {
      onWramRead: (a) => this.read(a),
      onWramWrite: (a, v) => {
        if (a >= RAM.timer && a < RAM.timer + 3) this.ticked = true;
        if (a !== RAM.marioAnim) return;
        if (v === MARIO_DYING && !this.dying) this.deaths.push(this.death());
        this.dying = v === MARIO_DYING;
      },
    };
  }

  // the deaths since the last call; called once per frame (what the code read before is forgotten)
  take(): Death[] {
    const d = this.deaths;
    this.deaths = [];
    this.last = null;
    this.ticked = false;
    return d;
  }

  // the machine's state was replaced (a savestate loaded)
  reset(): void {
    this.take();
    this.dying = this.s.wram[RAM.marioAnim] === MARIO_DYING;
  }

  private read(a: number): void {
    if (a >= MAP_BASE && a < MAP_BASE + MAP_SIZE) {
      if (blockTile(this.s.wram, a)) this.last = { block: a };
      return;
    }
    const x = this.s.cpu.x & 0xff;
    for (const kind of SLOT_KINDS) {
      if (x >= SLOT_TABLES[kind].slots) continue;
      if (OWN_TABLES[kind].some((t) => a === t + x)) { this.last = { kind, i: x }; return; }
    }
  }

  private death(): Death {
    const w = this.s.wram, x = marioX(w), y = marioY(w);
    return { level: levelLoaded(w), ...marioTile(x, y), killer: this.killer(y) };
  }

  private killer(y: number): Killer {
    const w = this.s.wram, onScreen = (y - cameraY(w)) & 0xffff, last = this.last;
    if (this.ticked && w[RAM.timer] === 0 && w[RAM.timer + 1] === 0 && w[RAM.timer + 2] === 0) return { kind: 'time' };
    if (onScreen >= BELOW_SCREEN && onScreen < 0x8000) return { kind: 'pit' };
    if (!last) return { kind: 'unknown' };
    if ('block' in last) return { kind: 'block', ...blockTile(w, last.block)!, tile: map16Tile(w, last.block) };
    const { kind, i } = last;
    if (kind === 'extended') return { kind: 'sprite', slots: kind, id: w[RAM.extSprites + i], x: get16(w, RAM.extXLo + i, RAM.extXHi + i), y: get16(w, RAM.extYLo + i, RAM.extYHi + i) };
    if (kind === 'cluster') return { kind: 'sprite', slots: kind, id: w[RAM.clusterSprites + i], x: get16(w, RAM.clusterXLo + i, RAM.clusterXHi + i), y: get16(w, RAM.clusterYLo + i, RAM.clusterYHi + i) };
    // PIXI's extra bits: 8 a custom sprite, 4 its extra bit
    const eb = w[SPR.extraBits + i], custom = (eb & 8) !== 0;
    const id = spriteId({ num: custom ? w[SPR.customNum + i] : w[SPR.num + i], extra: custom ? 2 | ((eb >> 2) & 1) : 0 });
    return { kind: 'sprite', slots: 'sprite', id, x: spriteX(w, i), y: spriteY(w, i) };
  }
}

// the layer 1 tile of a level data address in the level being played; null for layer 2's data (behind the
// level's screens)
export function blockTile(w: Uint8Array, a: number): { tx: number; ty: number } | null {
  const off = a - MAP_BASE, screens = w[RAM.screens];
  const vertical = (w[RAM.screenMode] & 1) !== 0, bytes = vertical ? VERTICAL_SCREEN : get16(w, LEVEL_HEIGHT) || SCREEN_BYTES;
  const s = Math.floor(off / bytes), r = off % bytes;
  if (screens && s >= screens) return null;
  return vertical ? { tx: ((r >> 8) << 4) | (r & 15), ty: (s << 4) | ((r >> 4) & 15) } : { tx: (s << 4) | (r & 15), ty: r >> 4 };
}
