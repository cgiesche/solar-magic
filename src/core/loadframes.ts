// The frames of a level load, kept for the next load of the same emulator (#448, LevelEmulator.reuseLoads): an edit
// (an object dragged a tile) loads the level anew, and most of the load's frames do there what they did before. Each
// frame is recorded with what it read as it began – the WRAM and VRAM it read before writing them, the level data as
// edited it read (the emulator's overlay) and which object those bytes belong to, the console's other state but its
// large memories (Snes.saveSmall), the ROM bytes it read – and what it changed: the WRAM, VRAM and CGRAM it wrote, the
// console's small state after it, the map tiles it attributed to objects. A frame of the next load is taken over (no
// emulation) when the console reads the same there: its writes are applied and its ROM reads count as read again.
// Found by emulation: no list of what can't matter. A frame that reads VRAM, CGRAM or OAM back through their ports is
// emulated again (conservative: what those reads return isn't recorded); after a frame that couldn't be taken over,
// each following one is tried again on its own.
//
// Not recorded: SRAM – frames are taken over only while the load wrote none, and only from a load that wrote none
// (both start from the same boot snapshot, so they read the same) –, the sound unit and the PPU's renderer (a console
// with either keeps no frames: LevelEmulator.load).

import type { Snes, MemHook, SmallState } from './snes.ts';
import { joinHooks } from './snes.ts';
import { RomReads, record, countReads, holds } from './romdeps.ts';
import type { Rom } from './rom.ts';

// bytes of a memory: where, and their values
interface Bytes { at: Int32Array; val: Uint8Array }

export interface LoadFrame {
  start: SmallState; // the console's small state as the frame began
  current: number; // the object the load attributed map writes to as the frame began (-1 none)
  wramRead: Bytes; // WRAM read before the frame wrote it, as it was
  vramRead: Bytes; // VRAM read into the port's latch before the frame wrote it, as it was
  ovRead: Bytes; ovOwner: Int32Array; // level data read (the overlay) and the object each byte belongs to (NO_OWNER)
  video: boolean; // VRAM, CGRAM or OAM read through its port: never taken over
  rom: { reads: RomReads; masked: RomReads; gen: number }; // the ROM bytes it read (masked: those the skip mask left out)
  // what it did
  wram: Bytes; vram: Bytes; cgram: Bytes;
  touches: Int32Array; // pairs: object, map offset (LevelRender.touched, owner), in order
  end: SmallState;
  currentEnd: number;
}

// What a load's frames are taken over for: the same ROM image and boot snapshot, the same temporary ROM patches
// (their reads aren't recorded) and the same skip mask the reads were recorded with
export interface LoadFramesKey {
  data: Uint8Array;
  base: object;
  patches: string; // the patched ROM offsets and their values
  mask: Uint8Array | null;
}

export interface LoadFrames { key: LoadFramesKey; frames: LoadFrame[] }

export const sameKey = (a: LoadFramesKey, b: LoadFramesKey): boolean =>
  a.data === b.data && a.base === b.base && a.patches === b.patches && a.mask === b.mask;

// what a load attributes map writes to (LevelEmulator.load's object tracking)
export interface FrameOwner {
  current: number; // the object, -1 none
  byteOwner: Int32Array | undefined; // the object each overlay byte belongs to
  touch(object: number, mapOffset: number): void;
}
// an overlay byte that changes no object attribution (beyond byteOwner)
const NO_OWNER = -2;
const ownerOf = (bo: Int32Array | undefined, o: number): number => (bo && o < bo.length ? bo[o] : NO_OWNER);

// Records and replays frames on one console. One frame at a time.
export class FrameRecorder {
  private snes: Snes;
  private rom: Rom;
  private overlay: Uint8Array;
  private mask: () => Uint8Array | null;
  private stamp = 0;
  private wramRead = new Uint32Array(0x20000);
  private wramWrote = new Uint32Array(0x20000);
  private vramRead = new Uint32Array(0x10000);
  private vramWrote = new Uint32Array(0x10000);
  private cgramWrote = new Uint32Array(0x200);
  private ovRead = new Uint32Array(0x10000);
  private touches: number[] | null = null;

  // mask: the skip mask a frame's ROM reads are recorded with outside another recording (what a picture leaves out)
  constructor(snes: Snes, rom: Rom, overlay: Uint8Array, mask: () => Uint8Array | null) {
    this.snes = snes;
    this.rom = rom;
    this.overlay = overlay;
    this.mask = mask;
  }

  // the load attributed a map write (recorded while a frame runs)
  touched(object: number, mapOffset: number): void {
    this.touches?.push(object, mapOffset);
  }

  // the frame as recorded does the same on the console as it is now
  fits(f: LoadFrame, own: FrameOwner): boolean {
    if (f.video || f.current !== own.current) return false;
    const s = this.snes, ov = this.overlay, bo = own.byteOwner;
    if (!s.sameSmall(f.start) || !same(s.wram, f.wramRead) || !same(s.vram, f.vramRead) || !same(ov, f.ovRead)) return false;
    for (let i = 0; i < f.ovRead.at.length; i++) if (ownerOf(bo, f.ovRead.at[i]) !== f.ovOwner[i]) return false;
    // (the ROM bytes it read unchanged: then as of the current generation)
    const r = f.rom, a = { gen: r.gen, reads: r.reads }, b = { gen: r.gen, reads: r.masked };
    if (!holds(this.rom, a) || !holds(this.rom, b)) return false;
    r.gen = this.rom.gen;
    return true;
  }

  // what the frame did, applied; its ROM reads count for the recordings running
  replay(f: LoadFrame, own: FrameOwner): void {
    const s = this.snes;
    put(s.wram, f.wram);
    put(s.vram, f.vram);
    put(s.cgram, f.cgram);
    s.loadSmall(f.end);
    for (let i = 0; i < f.touches.length; i += 2) own.touch(f.touches[i], f.touches[i + 1]);
    own.current = f.currentEnd;
    countReads(this.rom, s, f.rom.reads);
    s.romMasked?.add(f.rom.masked);
  }

  // runs a frame, recording it
  record(own: FrameOwner): LoadFrame {
    const s = this.snes, w = s.wram, ov = this.overlay, bo = own.byteOwner;
    const st = ++this.stamp, rd = this.wramRead, wr = this.wramWrote, vr = this.vramRead, vw = this.vramWrote;
    const cw = this.cgramWrote, orr = this.ovRead;
    // (read before written: the values as the frame began)
    const wramAt: number[] = [], wramWas: number[] = [], vramAt: number[] = [], vramWas: number[] = [];
    const wramTo: number[] = [], vramTo: number[] = [], cgramTo: number[] = [], ovAt: number[] = [];
    let video = false;
    const watch: MemHook = {
      onWramRead(a) { if (wr[a] !== st && rd[a] !== st) { rd[a] = st; wramAt.push(a); wramWas.push(w[a]); } },
      onWramWrite(a) { if (wr[a] !== st) { wr[a] = st; wramTo.push(a); } },
      onVramRead(a) { if (vw[a] !== st && vr[a] !== st) { vr[a] = st; vramAt.push(a); vramWas.push(s.vram[a]); } },
      onVramWrite(a) { if (vw[a] !== st) { vw[a] = st; vramTo.push(a); } },
      onCgramWrite(a) { if (cw[a] !== st) { cw[a] = st; cgramTo.push(a); } },
      onVideoRead() { video = true; },
      onOverlayRead(o) { if (orr[o] !== st) { orr[o] = st; ovAt.push(o); } },
    };
    const start = s.saveSmall(), current = own.current, outer = s.hook, outerMasked = s.romMasked;
    const touches: number[] = [], masked = new RomReads(this.rom);
    this.touches = touches;
    // (the load's own hook first: it attributes the overlay read before the write)
    s.hook = outer ? joinHooks(outer, watch) : watch;
    s.romMasked = masked;
    let reads: { reads: RomReads; gen: number };
    try {
      reads = record(this.rom, () => s.runFrame(), { cpu: s, mask: this.mask });
    } finally {
      s.hook = outer;
      s.romMasked = outerMasked;
      outerMasked?.add(masked);
      this.touches = null;
    }
    const bytes = (at: number[], m: Uint8Array, was?: number[]): Bytes =>
      ({ at: Int32Array.from(at), val: was ? Uint8Array.from(was) : Uint8Array.from(at, (a) => m[a]) });
    return {
      start, current, video,
      wramRead: bytes(wramAt, w, wramWas), vramRead: bytes(vramAt, s.vram, vramWas),
      ovRead: bytes(ovAt, ov), ovOwner: Int32Array.from(ovAt, (o) => ownerOf(bo, o)),
      rom: { reads: reads.reads, masked, gen: reads.gen },
      wram: bytes(wramTo, w), vram: bytes(vramTo, s.vram), cgram: bytes(cgramTo, s.cgram),
      touches: Int32Array.from(touches), end: s.saveSmall(), currentEnd: own.current,
    };
  }
}

// One load's frames: each taken over from the previous load's frame at the same place when it fits, else emulated
// (and recorded, with a recorder)
export class LoadSession {
  emulated = 0; // the frames emulated
  readonly frames: LoadFrame[] = []; // with a recorder: this load's, taken over or recorded
  private rec: FrameRecorder | null;
  private before: LoadFrame[] | null;
  private own: FrameOwner;
  private snes: Snes;
  private sramWrites: number;
  private at = 0;

  // before: the previous load's frames (null: none to take over)
  constructor(snes: Snes, rec: FrameRecorder | null, before: LoadFrame[] | null, own: FrameOwner) {
    this.snes = snes;
    this.rec = rec;
    this.before = before;
    this.own = own;
    this.sramWrites = snes.sramWrites;
  }

  // the load wrote no SRAM so far
  get sramKept(): boolean {
    return this.snes.sramWrites === this.sramWrites;
  }

  frame(): void {
    const rec = this.rec;
    if (!rec) { this.snes.runFrame(); this.emulated++; return; }
    const f = this.before?.[this.at++];
    if (f && this.sramKept && rec.fits(f, this.own)) { rec.replay(f, this.own); this.frames.push(f); return; }
    this.frames.push(rec.record(this.own));
    this.emulated++;
  }
}

const same = (m: Uint8Array, b: Bytes): boolean => {
  for (let i = 0; i < b.at.length; i++) if (m[b.at[i]] !== b.val[i]) return false;
  return true;
};
const put = (m: Uint8Array, b: Bytes): void => {
  for (let i = 0; i < b.at.length; i++) m[b.at[i]] = b.val[i];
};
