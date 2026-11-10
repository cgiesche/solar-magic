// The frames of a level load, kept for the next load of the same emulator (#448, LevelEmulator.reuseLoads): an edit
// (an object dragged a tile) loads the level anew, and most of the load's frames do there what they did before. Each
// frame is recorded with what it read of the console as it began – the WRAM it read before writing it, the level data
// as edited it read (the emulator's overlay) and which object those bytes belong to, the console's other state but its
// large memories (Snes.saveSmall) – and what it changed: the WRAM, VRAM and CGRAM it wrote, the console's small state
// after it, the map tiles it attributed to objects. A frame of the next load is taken over (no emulation) when the
// console reads the same there: its writes are applied. Found by emulation: no list of what can't matter. A frame
// that reads VRAM, CGRAM or OAM back through their ports is emulated again (conservative: its reads of video memory
// aren't recorded); so is everything after a frame that couldn't be taken over, frame by frame, until one reads the
// same again. The ROM bytes the load read are those of the frames emulated and of the load before (kept: a frame
// taken over read what it read then).
//
// Not recorded: SRAM (a load writing it keeps no frames), the sound unit and the PPU's renderer (a console with
// either keeps none: LevelEmulator.load).

import type { Snes, MemHook, SmallState } from './snes.ts';
import { joinHooks } from './snes.ts';
import type { RomReads } from './romdeps.ts';

export interface LoadFrame {
  start: SmallState; // the console's small state as the frame began
  current: number; // the object the load attributed map writes to as the frame began (-1 none)
  wramAt: Int32Array; wramWas: Uint8Array; // WRAM read before the frame wrote it, and its value
  ovAt: Int32Array; ovWas: Uint8Array; ovOwner: Int32Array; // overlay bytes read, their values and objects (-2: none)
  video: boolean; // VRAM, CGRAM or OAM read through its port: never taken over
  // what it did
  wramTo: Int32Array; wramVal: Uint8Array;
  vramTo: Int32Array; vramVal: Uint8Array;
  cgramTo: Int32Array; cgramVal: Uint8Array;
  touches: Int32Array; // pairs: object, map offset (LevelRender.touched, owner), in order
  end: SmallState;
  currentEnd: number;
}

// What a load's frames are taken over for: the same ROM image and boot snapshot, the same temporary ROM patches
// (their reads aren't recorded) and skip mask; the ROM bytes the frames read are unchanged (holds)
export interface LoadFramesKey {
  data: Uint8Array;
  base: unknown;
  patches: string;
  mask: Uint8Array | null;
}

export interface LoadFrames {
  key: LoadFramesKey;
  frames: LoadFrame[];
  gen: number;
  reads: RomReads; // the ROM bytes the frames read (the skip mask's left out)
  masked: RomReads; // those the skip mask left out
}

export const sameKey = (a: LoadFramesKey, b: LoadFramesKey): boolean =>
  a.data === b.data && a.base === b.base && a.patches === b.patches && a.mask === b.mask;

// what a load attributes map writes to (LevelEmulator.load's object tracking)
export interface FrameOwner {
  current: number;
  byteOwner: Int32Array | undefined;
  touch(k: number, o: number): void;
}

// Records and replays frames on one console. One frame at a time.
export class FrameRecorder {
  private snes: Snes;
  private overlay: Uint8Array;
  private stamp = 0;
  private wramRead = new Uint32Array(0x20000);
  private wramWrote = new Uint32Array(0x20000);
  private vramWrote = new Uint32Array(0x10000);
  private cgramWrote = new Uint32Array(0x200);
  private ovRead = new Uint32Array(0x10000);
  private touches: number[] | null = null;

  constructor(snes: Snes, overlay: Uint8Array) {
    this.snes = snes;
    this.overlay = overlay;
  }

  // the load attributed a map write (recorded while a frame runs)
  touched(k: number, o: number): void {
    this.touches?.push(k, o);
  }

  // the frame as recorded does the same on the console as it is now
  fits(f: LoadFrame, own: FrameOwner): boolean {
    if (f.video || f.current !== own.current) return false;
    const s = this.snes, w = s.wram, ov = this.overlay, bo = own.byteOwner;
    if (!s.sameSmall(f.start)) return false;
    for (let i = 0; i < f.wramAt.length; i++) if (w[f.wramAt[i]] !== f.wramWas[i]) return false;
    for (let i = 0; i < f.ovAt.length; i++) {
      const o = f.ovAt[i];
      if (ov[o] !== f.ovWas[i] || ownerOf(bo, o) !== f.ovOwner[i]) return false;
    }
    return true;
  }

  // what the frame did, applied
  replay(f: LoadFrame, own: FrameOwner): void {
    const s = this.snes;
    for (let i = 0; i < f.wramTo.length; i++) s.wram[f.wramTo[i]] = f.wramVal[i];
    for (let i = 0; i < f.vramTo.length; i++) s.vram[f.vramTo[i]] = f.vramVal[i];
    for (let i = 0; i < f.cgramTo.length; i++) s.cgram[f.cgramTo[i]] = f.cgramVal[i];
    s.loadSmall(f.end);
    for (let i = 0; i < f.touches.length; i += 2) own.touch(f.touches[i], f.touches[i + 1]);
    own.current = f.currentEnd;
  }

  // runs a frame, recording it
  record(own: FrameOwner): LoadFrame {
    const s = this.snes, w = s.wram, ov = this.overlay, bo = own.byteOwner;
    const st = ++this.stamp, rd = this.wramRead, wr = this.wramWrote, vw = this.vramWrote, cw = this.cgramWrote, orr = this.ovRead;
    const wramAt: number[] = [], wramWas: number[] = [], wramTo: number[] = [], vramTo: number[] = [], cgramTo: number[] = [];
    const ovAt: number[] = [], ovWas: number[] = [], ovOwner: number[] = [];
    let video = false;
    const watch: MemHook = {
      onWramRead(a) { if (wr[a] !== st && rd[a] !== st) { rd[a] = st; wramAt.push(a); wramWas.push(w[a]); } },
      onWramWrite(a) { if (wr[a] !== st) { wr[a] = st; wramTo.push(a); } },
      onVramWrite(a) { if (vw[a] !== st) { vw[a] = st; vramTo.push(a); } },
      onCgramWrite(a) { if (cw[a] !== st) { cw[a] = st; cgramTo.push(a); } },
      onVideoRead() { video = true; },
      onOverlayRead(o) { if (orr[o] !== st) { orr[o] = st; ovAt.push(o); ovWas.push(ov[o]); ovOwner.push(ownerOf(bo, o)); } },
    };
    const start = s.saveSmall(), current = own.current, outer = s.hook;
    const touches: number[] = [];
    this.touches = touches;
    // (the load's own hook first: it attributes the overlay read before the write)
    s.hook = outer ? joinHooks(outer, watch) : watch;
    try { s.runFrame(); } finally { s.hook = outer; this.touches = null; }
    const vals = (to: number[], m: Uint8Array) => Uint8Array.from(to, (a) => m[a]);
    return {
      start, current, video,
      wramAt: Int32Array.from(wramAt), wramWas: Uint8Array.from(wramWas),
      ovAt: Int32Array.from(ovAt), ovWas: Uint8Array.from(ovWas), ovOwner: Int32Array.from(ovOwner),
      wramTo: Int32Array.from(wramTo), wramVal: vals(wramTo, w),
      vramTo: Int32Array.from(vramTo), vramVal: vals(vramTo, s.vram),
      cgramTo: Int32Array.from(cgramTo), cgramVal: vals(cgramTo, s.cgram),
      touches: Int32Array.from(touches), end: s.saveSmall(), currentEnd: own.current,
    };
  }
}

// the object an overlay byte belongs to as the load's tracking sees it (-2: it changes none)
const ownerOf = (bo: Int32Array | undefined, o: number): number => (bo && o < bo.length ? bo[o] : -2);
