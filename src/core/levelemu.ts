// Runs the game's own level loading code to obtain the exact Map16 level layout,
// graphics (VRAM) and palettes (CGRAM) of a level, including per-tile ownership
// (which object produced which tile).

import { Snes, type SnesState } from './snes.ts';
import { Rom } from './rom.ts';
import { L1_PTRS, L2_PTRS, SPR_PTRS, mainTranslevel } from './level.ts';
import { editorPatch, BG_HOOK } from './patches.ts';

export const OV_L1 = 0x0000; // overlay offsets
export const OV_L2 = 0x4000;
export const OV_SPR = 0x8000;
export const OV_BG = 0xa000; // edited BG tilemap (editor format, see bg.ts)
const OV_BG_HOOK = 0xb000; // LDA #$FF : STA $6A : RTL (BG data bank = overlay)
const OV_STUB = 0xc000; // JSL stub used to call game routines
const INIT_TABLES = 0x07f7d2; // game routine that sets up a new sprite's tables (tweakers), X = slot
export const OV_BASE_SNES = 0xfe8000;

export function overlaySnes(off: number): number {
  return off < 0x8000 ? 0xfe8000 + off : 0xff8000 + (off - 0x8000);
}

export interface LevelOverride {
  layer1?: Uint8Array; // full layer 1 data incl. 5 byte header
  layer2?: Uint8Array; // layer 2 object data incl. header
  layer2Pointer?: number; // override pointer (BG tilemap) when layer2 not given
  bgData?: Uint8Array; // edited BG tilemap (bg.ts encodeBg), replaces layer2Pointer
  sprites?: Uint8Array;
  // objIndexOfByte maps overlay byte offset → object index (layer1: idx, layer2: 0x8000|idx)
  byteOwner?: Int32Array;
  secondaryHeader?: number[]; // 4 bytes
  switchPalaces?: boolean; // treat all switch palaces as pressed
  onOffSwitch?: boolean; // ON/OFF switch in the OFF state ($14AF)
  trackSources?: boolean; // record ROM provenance of CGRAM (slower)
  translevel?: number; // $13BF (messages, Yoshi coins); default: the level itself if it is a main level
  trace?: boolean; // record per object what its routine reads and writes (see ObjectTrace)
}

// What the object routines did while the level loaded (analysis, see objkinds.ts).
export interface ObjectTrace {
  code: Set<number>; // ROM offsets fetched as instructions
  reads: Map<number, Set<number>>; // object key → data reads from ROM, as pc * 2^23 + ROM offset
  writes: Map<number, Map<number, number>>; // object key → map offset → Map16 tile as written by the object
  rom: Set<number>; // every ROM offset read (code and data)
}

export interface LevelRender {
  wram: Uint8Array;
  vram: Uint8Array;
  cgram: Uint8Array;
  cgramSrc: Int32Array; // ROM offset each CGRAM byte came from (-1 unknown)
  ppuRegs: Uint8Array;
  owner: Int32Array; // per low-byte map address ($C800-$FFFF), -1 = none
  touched: Map<number, Set<number>>; // object key → map offsets written
  trace?: ObjectTrace;
  ok: boolean;
  error?: string;
  frames: number;
}

export const MAP_BASE = 0xc800;
export const MAP_SIZE = 0x3800;

export class LevelEmulator {
  rom: Rom;
  snes: Snes;
  baseState: SnesState | null = null;
  romGen = 0; // counts syncRom() calls: the ROM may have changed
  overlay = new Uint8Array(0x10000);

  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.snes.overlay = this.overlay;
  }

  // Boot to the title screen once; all level loads start from this snapshot.
  boot(): void {
    const s = this.snes;
    s.rom = this.rom.data;
    s.reset();
    let f = 0;
    while (s.wram[0x100] !== 0x07) {
      s.runFrame();
      if (++f > 2000) throw new Error('boot did not reach title screen');
    }
    this.baseState = s.saveState();
  }

  // ROM data array may be replaced (expansion); keep emulator in sync.
  syncRom(): void {
    this.snes.rom = this.rom.data;
    this.romGen++;
  }

  load(level: number, ov: LevelOverride = {}): LevelRender {
    if (!this.baseState) this.boot();
    const s = this.snes;
    s.rom = this.rom.data;
    s.loadState(this.baseState!);
    const w = s.wram;
    w[0x141a] = 1;
    w[0x95] = 0;
    w[0x97] = 0;
    w[0x5b] = 0;
    w[0x19b8] = level & 0xff;
    w[0x19d8] = (level >> 8) & 1;
    w[0x0dd6] = 0;
    w[0x1f11] = (level >> 8) & 1;
    w[0x1b93] = 0;
    w[0x0109] = 0;
    // translevel $24 (Chocolate Island 2) makes the exit-based load pick a room by time/coins instead
    const tl = ov.translevel ?? mainTranslevel(level) ?? 0;
    w[0x13bf] = tl === 0x24 ? 0 : tl;
    if (ov.switchPalaces) for (let i = 0; i < 4; i++) w[0x1f27 + i] = 1;
    if (ov.onOffSwitch) w[0x14af] = 1;
    w[0x100] = 0x11;

    // temporary pointer patches in the ROM image
    const rom = this.rom;
    const saved: [number, number][] = [];
    const patch = (snes: number, v: number) => {
      saved.push([snes, rom.r8(snes)]);
      rom.w8(snes, v);
    };
    const patch24 = (snes: number, v: number) => { patch(snes, v); patch(snes + 1, v >> 8); patch(snes + 2, v >> 16); };
    if (ov.layer1) {
      this.overlay.set(ov.layer1, OV_L1);
      patch24(L1_PTRS + level * 3, overlaySnes(OV_L1));
    }
    if (ov.layer2) {
      this.overlay.set(ov.layer2, OV_L2);
      patch24(L2_PTRS + level * 3, overlaySnes(OV_L2));
    } else if (ov.layer2Pointer !== undefined) {
      patch24(L2_PTRS + level * 3, ov.layer2Pointer);
    }
    if (ov.bgData && !ov.layer2) {
      this.overlay.set(ov.bgData, OV_BG);
      this.overlay.set([0xa9, 0xff, 0x85, 0x6a, 0x6b], OV_BG_HOOK);
      patch24(L2_PTRS + level * 3, 0xff0000 | (overlaySnes(OV_BG) & 0xffff));
      patch(BG_HOOK, 0x22);
      patch24(BG_HOOK + 1, overlaySnes(OV_BG_HOOK));
    }
    if (ov.sprites) {
      this.overlay.set(ov.sprites, OV_SPR);
      const a = overlaySnes(OV_SPR);
      patch(SPR_PTRS + level * 2, a & 0xff);
      patch(SPR_PTRS + level * 2 + 1, (a >> 8) & 0xff);
      // force sprite data bank: vanilla code is LDA #$07 : STA $D0 at $05D8F5,
      // patched ROMs have a bank table
      const p = editorPatch(rom);
      if (p) patch(p.sprBank + level, a >> 16);
      else patch(0x05d8f6, a >> 16);
    }
    if (ov.secondaryHeader) {
      for (let i = 0; i < 4; i++) patch(0x05f000 + i * 0x200 + level, ov.secondaryHeader[i]);
    }

    const owner = new Int32Array(MAP_SIZE).fill(-1);
    const touched = new Map<number, Set<number>>();
    const touch = (k: number, o: number) => {
      owner[o] = k;
      let set = touched.get(k);
      if (!set) { set = new Set(); touched.set(k, set); }
      set.add(o);
    };
    let current = -1;
    const byteOwner = ov.byteOwner;
    const trace: ObjectTrace | undefined = ov.trace ? { code: new Set(), reads: new Map(), writes: new Map(), rom: new Set() } : undefined;
    const cpu = s.cpu;
    const put = (o: number, v: number, hi: boolean) => {
      let m = trace!.writes.get(current);
      if (!m) { m = new Map(); trace!.writes.set(current, m); }
      const old = m.get(o) ?? 0;
      m.set(o, hi ? (old & 0xff) | (v << 8) : (old & 0xff00) | v);
    };
    s.hook = {
      onOverlayRead(o: number) {
        if (byteOwner && o < byteOwner.length) current = byteOwner[o];
      },
      onWramWrite(a: number, v: number) {
        if (current < 0) return;
        if (a >= MAP_BASE && a < MAP_BASE + MAP_SIZE) { touch(current, a - MAP_BASE); if (trace) put(a - MAP_BASE, v, false); }
        else if (a >= 0x10000 + MAP_BASE && a < 0x10000 + MAP_BASE + MAP_SIZE) { touch(current, a - 0x10000 - MAP_BASE); if (trace) put(a - 0x10000 - MAP_BASE, v, true); }
      },
      onRomRead: trace ? (ro: number) => {
        trace.rom.add(ro);
        if (cpu.inFetch) { trace.code.add(ro); return; }
        if (current < 0) return;
        let r = trace.reads.get(current);
        if (!r) { r = new Set(); trace.reads.set(current, r); }
        r.add(cpu.opPc * 0x800000 + ro);
      } : undefined,
    };
    s.taintOn = !!ov.trackSources;
    s.taint.fill(-1);
    s.cgTaint.fill(-1);
    s.fifoLen = 0;
    let frames = 0;
    let ok = true;
    let error: string | undefined;
    try {
      // GM $11 loads the level; hooks only needed there
      while (w[0x100] === 0x11 && frames < 30) { s.runFrame(); frames++; }
      s.hook = null;
      while (w[0x100] < 0x13 && frames < 120) { s.runFrame(); frames++; }
      s.runFrame(); frames++;
      if (w[0x100] < 0x13) { ok = false; error = `level load stalled in game mode ${w[0x100].toString(16)}`; }
    } catch (e) {
      ok = false;
      error = String(e);
    } finally {
      s.hook = null;
      s.taintOn = false;
      for (let i = saved.length - 1; i >= 0; i--) rom.w8(saved[i][0], saved[i][1]);
    }
    return {
      wram: s.wram.slice(),
      vram: s.vram.slice(),
      cgram: s.cgram.slice(),
      cgramSrc: s.cgTaint.slice(),
      ppuRegs: s.ppuRegs.slice(),
      owner,
      touched,
      trace,
      ok,
      error,
      frames,
    };
  }

  // runs a game routine (JSL addr, RTL) with X = x in 8-bit mode, then restores the CPU registers
  call(addr: number, x: number): void {
    const cpu = this.snes.cpu;
    const saved = { a: cpu.a, x: cpu.x, y: cpu.y, s: cpu.s, d: cpu.d, dbr: cpu.dbr, pbr: cpu.pbr, pc: cpu.pc, p: cpu.p, e: cpu.e, waiting: cpu.waiting };
    const stub = overlaySnes(OV_STUB);
    this.overlay.set([0x22, addr & 0xff, (addr >> 8) & 0xff, addr >> 16], OV_STUB);
    cpu.pbr = stub >> 16; cpu.pc = stub & 0xffff;
    cpu.e = false; cpu.p |= 0x30; cpu.d = 0; cpu.x = x; cpu.waiting = false;
    const end = (stub + 4) & 0xffff;
    try {
      for (let n = 0; n < 200000 && !(cpu.pbr === stub >> 16 && cpu.pc === end); n++) cpu.step();
    } finally {
      Object.assign(cpu, saved);
    }
  }

  // puts sprite num into slot at pixel (x, y) in gameplay; its init runs in the next frame like
  // for a sprite from level data (which it is not: $161A = $FF)
  spawnSprite(slot: number, num: number, x: number, y: number): void {
    const w = this.snes.wram;
    w[0x9e + slot] = num;
    w[0x14c8 + slot] = 1;
    w[0xe4 + slot] = x & 0xff; w[0x14e0 + slot] = x >> 8;
    w[0xd8 + slot] = y & 0xff; w[0x14d4 + slot] = y >> 8;
    w[0x161a + slot] = 0xff;
    this.call(INIT_TABLES, slot);
  }

  // Continues the live state left by load() into gameplay (GM $14) and snapshots VRAM/CGRAM
  // every `step` frames (tile and palette animation). Must directly follow load().
  animationFrames(count = 8, step = 8): { vram: Uint8Array; cgram: Uint8Array }[] {
    const s = this.snes, out: { vram: Uint8Array; cgram: Uint8Array }[] = [];
    try {
      let guard = 0;
      while (s.wram[0x100] !== 0x14 && guard++ < 80) s.runFrame();
      for (let i = 0; i < count; i++) {
        for (let f = 0; f < step; f++) s.runFrame();
        out.push({ vram: s.vram.slice(), cgram: s.cgram.slice() });
      }
    } catch { /* keep the frames we have */ }
    return out;
  }
}
