// Runs the game's own level loading code to obtain the exact Map16 level layout,
// graphics (VRAM) and palettes (CGRAM) of a level, including per-tile ownership
// (which object produced which tile).

import { Snes, type SnesState } from './snes.ts';
import { Rom, snesToPc } from './rom.ts';
import { L1_PTRS, L2_PTRS, SPR_PTRS, mainTranslevel } from './level.ts';
import { editorPatch, musicPatch, BG_HOOK, HEADER_MUSIC_TABLE } from './patches.ts';
import { RomReads, updateBytePages, PAGE_SHIFT } from './romdeps.ts';

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
  continueState?: boolean; // load from the emulator's current state (startGame) instead of the boot snapshot
  music?: number; // the song the level plays instead of its own (all header settings and the level's music patch entry)
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

// any ROM byte read while booting differs between the booted ROM and now
function bootChanged(reads: RomReads, then: Uint8Array, now: Uint8Array): boolean {
  for (const b of reads.bytes) if (then[b] !== now[b]) return true;
  const size = 1 << PAGE_SHIFT;
  for (let p = 0; p < reads.pages.length; p++) {
    if (!reads.pages[p]) continue;
    for (let i = p * size, end = i + size; i < end; i++) if (then[i] !== now[i]) return true;
  }
  return false;
}

export const MAP_BASE = 0xc800;
export const MAP_SIZE = 0x3800;

export class LevelEmulator {
  rom: Rom;
  snes: Snes;
  baseState: SnesState | null = null;
  romGen = 0; // counts syncRom() calls: the ROM may have changed
  // ROM bytes whose reads by the emulated CPU don't count for tracked() results (GFX file data)
  skipMask: (() => Uint8Array | null) | null = null;
  overlay = new Uint8Array(0x10000);

  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.snes.overlay = this.overlay;
    updateBytePages(rom);
  }

  bootReads: RomReads | null = null; // ROM read while booting (every load starts from that state)
  private bootRom: Uint8Array | null = null; // the ROM as it was booted

  // the boot snapshot of another emulator on the same ROM (saves booting again)
  adoptBoot(other: LevelEmulator): void {
    this.baseState = other.baseState;
    this.bootReads = other.bootReads;
    this.bootRom = other.bootRom;
  }

  // Power on and boot to the title screen once; all level loads start from this snapshot.
  boot(): void {
    const s = this.snes;
    s.rom = this.rom.data;
    s.powerOn();
    this.bootReads = this.tracked(() => {
      let f = 0;
      while (s.wram[0x100] !== 0x07) {
        s.runFrame();
        if (++f > 2000) throw new Error('boot did not reach title screen');
      }
    }).reads;
    this.baseState = s.saveState();
    this.bootRom = this.rom.data.slice();
  }

  // runs fn recording the ROM it reads, on top of base (default: the boot's); the reads also
  // count for an enclosing tracked() call
  tracked<T>(fn: () => T, base: RomReads | null = this.bootReads): { result: T; reads: RomReads } {
    const s = this.snes, outer = s.romReads, outerRom = this.rom.reads, outerMask = s.romSkipMask;
    const reads = new RomReads(this.rom.data.length, base);
    s.romReads = this.rom.reads = reads; // the emulated CPU's reads and the editor code's
    if (!outer) s.romSkipMask = this.skipMask?.() ?? null;
    try {
      return { result: fn(), reads };
    } finally {
      s.romReads = outer;
      s.romSkipMask = outerMask;
      this.rom.reads = outerRom;
      outer?.add(reads);
      if (outerRom && outerRom !== outer) outerRom.add(reads);
    }
  }

  // ROM data array may be replaced (expansion); keep emulator in sync.
  // A change of what the boot read (a patch's power-on code, e.g. Retry System's RAM setup) makes
  // the boot snapshot stale: boot again with the next load.
  syncRom(): void {
    this.snes.rom = this.rom.data;
    this.romGen++;
    updateBytePages(this.rom);
    if (this.baseState && this.bootReads && this.bootRom && bootChanged(this.bootReads, this.bootRom, this.rom.data)) {
      this.baseState = null;
      this.bootReads = null;
      this.bootRom = null;
    }
  }

  load(level: number, ov: LevelOverride = {}): LevelRender {
    if (!this.baseState) this.boot();
    const s = this.snes;
    s.rom = this.rom.data;
    if (!ov.continueState) s.loadState(this.baseState!);
    const w = s.wram;
    w[0x141a] = 1;
    w[0x95] = 0;
    w[0x97] = 0;
    w[0x5b] = 0;
    w[0x19b8] = level & 0xff;
    w[0x19d8] = (level >> 8) & 1;
    w[0x0dd6] = 0;
    // level bank of screen exits; a game in progress keeps its submap where that already gives it
    if (!ov.continueState || (w[0x1f11] !== 0 ? 1 : 0) !== ((level >> 8) & 1)) w[0x1f11] = (level >> 8) & 1;
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
      saved.push([snes, rom.data[snesToPc(snes)]]);
      s.romSkip.add(snesToPc(snes)); // their content doesn't matter: reads don't count for romPages
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
    if (ov.music !== undefined) {
      for (let i = 0; i < 8; i++) patch(HEADER_MUSIC_TABLE + i, ov.music);
      const mp = musicPatch(rom);
      if (mp) patch(mp.table + level, ov.music);
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
    const skip = trace ? this.skipMask?.() ?? null : null; // not dependencies of the result (GFX, ExAnimation data)
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
        if (skip === null || skip[ro] !== 1) trace.rom.add(ro);
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
      s.romSkip.clear();
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

  // From the boot snapshot, starts a new game the way a player does (file select, intro skipped) and
  // puts Mario on the overworld tile of translevel tl, so a following load({ continueState }) plays the
  // level within a game in progress: dying costs a life and returns to the overworld there, entering
  // the tile again loads the level. Tiles of submaps get the submap whose camera view (from loading
  // each submap) is centered nearest to them. Not found on the overworld: Mario stays at the start.
  startGame(tl: number): void {
    if (!this.baseState) this.boot();
    const s = this.snes, w = s.wram;
    s.rom = this.rom.data;
    s.loadState(this.baseState!);
    s.joy1 = 0;
    for (let n = 0; w[0x100] !== 0x0e; n++) {
      if (n > 1500) throw new Error('new game did not reach the overworld');
      if (w[0x100] === 0x0b) w[0x109] = 0; // no intro level
      s.joy1 = (n % 16) < 4 ? (w[0x100] === 0x07 ? 0x1000 : 0x0080) : 0;
      s.runFrame();
    }
    s.joy1 = 0;
    for (let i = 0; i < 3; i++) s.runFrame();
    const i = tl > 0 ? w.subarray(0xd000, 0xd800).indexOf(tl) : -1; // translevel per tile ($7ED000)
    if (i < 0) return;
    const tx = ((i >> 8) & 1) * 16 + (i & 15), ty = ((i >> 9) & 1) * 16 + ((i >> 4) & 15);
    // pixel position: like the start position relative to its tile
    const px = tx * 16 + (w[0x1f17] - w[0x1f1f] * 16), py = ty * 16 + (w[0x1f19] - w[0x1f21] * 16);
    let sub = 0;
    if (i >= 0x400) {
      const ow = s.saveState();
      let best = Infinity;
      for (let k = 1; k <= 6; k++) {
        s.loadState(ow);
        w[0x1f11] = k;
        w[0x100] = 0x0b;
        for (let f = 0; w[0x100] !== 0x0e && f < 500; f++) s.runFrame();
        const cx = ((w[0x1a] | w[0x1b] << 8) << 16 >> 16) + 128, cy = ((w[0x1c] | w[0x1d] << 8) << 16 >> 16) + 112;
        const d = Math.max(Math.abs(px + 8 - cx), Math.abs(py + 8 - cy));
        if (d < best) { best = d; sub = k; }
      }
      s.loadState(ow);
    }
    for (const o of [0, 4]) { // Mario and Luigi
      w[0x1f17 + o] = px & 0xff; w[0x1f18 + o] = px >> 8;
      w[0x1f19 + o] = py & 0xff; w[0x1f1a + o] = py >> 8;
      w[0x1f1f + o] = tx; w[0x1f20 + o] = 0;
      w[0x1f21 + o] = ty; w[0x1f22 + o] = 0;
    }
    w[0x1f11] = w[0x1f12] = sub;
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

  // puts sprite id (see spriteId: custom sprites $2xx/$3xx) into slot at pixel (x, y) in gameplay; its
  // init runs in the next frame like for a sprite from level data (which it is not: $161A = $FF)
  spawnSprite(slot: number, id: number, x: number, y: number): void {
    const w = this.snes.wram;
    const num = id & 0xff;
    w[0x9e + slot] = num;
    w[0x14c8 + slot] = 1;
    w[0xe4 + slot] = x & 0xff; w[0x14e0 + slot] = x >> 8;
    w[0xd8 + slot] = y & 0xff; w[0x14d4 + slot] = y >> 8;
    w[0x161a + slot] = 0xff;
    this.call(INIT_TABLES, slot);
    if (id >= 0x200) {
      // custom sprite (PIXI): number and extra bits; its INIT sets up the tables
      w[0x1ab9e + slot] = num;
      w[0x1ab10 + slot] = 0x08 | ((id >> 6) & 0x04);
      for (const t of [0x1ab40, 0x1ab4c, 0x1ab58, 0x1ab64]) w[t + slot] = 0;
    }
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
