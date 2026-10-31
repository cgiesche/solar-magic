// Runs the game's own level loading code to obtain the exact Map16 level layout,
// graphics (VRAM) and palettes (CGRAM) of a level, including per-tile ownership
// (which object produced which tile).

import { Snes, type SnesState, type MemHook } from './snes.ts';
import { Rom, snesToPc } from './rom.ts';
import { L1_PTRS, L2_PTRS, SPR_PTRS, SEC_HDR, LEVEL_SIZE_TABLE, mainTranslevel } from './level.ts';
import { translevelToLevel, l1XY } from './overworld.ts';
import { editorPatch, musicPatch, BG_HOOK, HEADER_MUSIC_TABLE } from './patches.ts';
import { lt3Patches, type Lt3Place } from './layer3gfx.ts';
import { RomReads, updateBytePages, PAGE_SHIFT } from './romdeps.ts';
import { applyTriggers, type TriggerView } from './extrigger.ts';
import { inputHash, levelInput } from './inputs.ts';
import { GM, RAM, SPR, MAP_BASE, MAP_SIZE, MAP_HI, CDM16_FLAGS, getS16, set16, setSpritePos } from './ram.ts';

export const OV_L1 = 0x0000; // overlay offsets
export const OV_L2 = 0x4000;
export const OV_SPR = 0x8000;
export const OV_BG = 0xa000; // edited BG tilemap (editor format, see bg.ts)
const OV_BG_HOOK = 0xb000; // LDA #$FF : STA $6A : RTL (BG data bank = overlay)
const OV_STUB = 0xc000; // JSL stub used to call game routines
const OV_L3 = 0xd000; // an edited layer 3 tilemap as the level's LT3 file (0x2000 bytes, see layer3map.ts)
const INIT_TABLES = 0x07f7d2; // game routine that sets up a new sprite's tables (tweakers), X = slot
// where the level load calls the upload of the level music bank (JSR $8134, 3 bytes; AddmusicK's
// patch makes it NOPs): it uploads when the level is entered from the overworld ($141A = 0). Loads
// here go by screen exit ($141A = 1), so the sound unit would keep the title/overworld bank, whose
// songs have the same numbers
const LEVEL_MUSIC_CALL = 0x009702;
export const OV_BASE_SNES = 0xfe8000;

export function overlaySnes(off: number): number {
  return off < 0x8000 ? 0xfe8000 + off : 0xff8000 + (off - 0x8000);
}

export interface LevelOverride {
  layer1?: Uint8Array; // full layer 1 data incl. 5 byte header
  layer2?: Uint8Array; // layer 2 object data incl. header
  layer2Pointer?: number; // override pointer (BG tilemap) when layer2 not given
  bgData?: Uint8Array; // edited BG tilemap (bg.ts encodeBg), replaces layer2Pointer
  layer3?: { data: Uint8Array; place: Lt3Place }; // edited layer 3 tilemap: the level's LT3 file (0x2000 bytes) and where it goes
  sprites?: Uint8Array;
  // objIndexOfByte maps overlay byte offset → object index (layer1: idx, layer2: 0x8000|idx)
  byteOwner?: Int32Array;
  secondaryHeader?: number[]; // the bytes of SEC_HDR (missing ones: 0)
  switchPalaces?: boolean; // treat all switch palaces as pressed
  onOffSwitch?: boolean; // ON/OFF switch in the OFF state ($14AF)
  cdm16Flags?: Uint8Array; // the conditional Direct Map16 flags (CDM16_FLAGS, cdm16.ts flagBytes) the level loads with
  timer?: number; // the timer's hundreds once the level has loaded (the game sets them only coming from the overworld)
  exTriggers?: TriggerView; // ExAnimation triggers set once the level's load has set its own (extrigger.ts)
  trackSources?: boolean; // record ROM provenance of CGRAM (slower)
  translevel?: number; // $13BF (messages, Yoshi coins); default: the level itself if it is a main level
  midway?: boolean; // enter the translevel's level from the overworld with its midway point touched (a main level)
  fromOverworld?: boolean; // enter the translevel's level from the overworld (a main level): only then the game sets up its midway point ($13CD)
  trace?: boolean; // record per object what its routine reads and writes (see ObjectTrace)
  continueState?: boolean; // load from the emulator's current state (startGame) instead of the boot snapshot
  music?: number; // the song the level plays instead of its own (all header settings and the level's music patch entry)
  fadeHook?: () => MemHook; // watches the frames after GM $11 (level start, fade-in: sprites run their first frames there), made when GM $11 is done
}

// the level and a hash of the level as edited (its input, inputs.ts), for result cache keys of what is learned
// by playing it
export function levelDataKey(level: number, ov: LevelOverride): string {
  return `${level}:${inputHash(levelInput(level, ov))}`;
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

export { MAP_BASE, MAP_SIZE };

export class LevelEmulator {
  rom: Rom;
  snes: Snes;
  baseState: SnesState | null = null;
  private romGen: number; // the ROM's generation the emulator is synced to (see sync)
  // ROM bytes whose reads by the emulated CPU don't count for tracked() results (GFX file and ExAnimation data,
  // gfxSkipMask; for results that are no pictures the display data too, gfxDisplaySkipMask)
  skipMask: (() => Uint8Array | null) | null = null;
  overlay = new Uint8Array(0x10000);

  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.snes.overlay = this.overlay;
    this.romGen = rom.gen;
    updateBytePages(rom);
  }

  bootReads: RomReads | null = null; // ROM read while booting (every load starts from that state)
  // the reads the boot's skipMask left out: GFX files uploaded on the title screen stay in VRAM, and a
  // level with the same files doesn't upload them again – a change makes the snapshot stale as well
  private bootMasked: RomReads | null = null;
  private bootRom: Uint8Array | null = null; // the ROM as it was booted

  // the boot snapshot of another emulator on the same ROM (saves booting again)
  adoptBoot(other: LevelEmulator): void {
    this.baseState = other.baseState;
    this.bootReads = other.bootReads;
    this.bootMasked = other.bootMasked;
    this.bootRom = other.bootRom;
    this.romGen = -1; // it may be from an older ROM: checked with the next entry
  }

  // Power on and boot to the title screen once; all level loads start from this snapshot.
  boot(): void {
    this.sync();
    const s = this.snes;
    s.powerOn();
    const masked = new RomReads(this.rom.data.length), outerMasked = s.romMasked;
    s.romMasked = masked;
    try {
      this.bootReads = this.tracked(() => {
        let f = 0;
        while (s.wram[RAM.gameMode] !== GM.title) {
          s.runFrame();
          if (++f > 2000) throw new Error('boot did not reach title screen');
        }
      }).reads;
    } finally { s.romMasked = outerMasked; }
    this.bootMasked = masked;
    this.baseState = s.saveState();
    this.bootRom = this.rom.data.slice();
  }

  // runs fn with skipMask set to mask (a mask or a function returning one), the previous one restored
  // when it returns or throws
  withSkipMask<T>(mask: Uint8Array | null | (() => Uint8Array | null), fn: () => T): T {
    const base = this.skipMask;
    this.skipMask = typeof mask === 'function' ? mask : () => mask;
    try { return fn(); } finally { this.skipMask = base; }
  }

  // runs fn recording the ROM it reads, on top of base (default: the boot's); the reads also
  // count for an enclosing tracked() call (with counted false only when given to count())
  tracked<T>(fn: () => T, base: RomReads | null = this.bootReads, counted = true): { result: T; reads: RomReads } {
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
      if (counted) this.count(reads);
    }
  }

  // reads (of a tracked() call not counted) count for the enclosing tracked() call as if read in it
  count(reads: RomReads): void {
    const outer = this.snes.romReads, outerRom = this.rom.reads;
    outer?.add(reads);
    if (outerRom && outerRom !== outer) outerRom.add(reads);
  }

  // runs fn recording every ROM byte it and the boot it starts from read, those skipMask leaves out too: what
  // fn's outcome depends on (a render shows GFX file data)
  recordAll<T>(fn: () => T): { result: T; reads: RomReads } {
    const s = this.snes, outer = s.romMasked, masked = new RomReads(this.rom.data.length);
    s.romMasked = masked;
    try {
      const r = this.tracked(fn);
      r.reads.add(masked);
      if (this.bootReads) r.reads.add(this.bootReads);
      if (this.bootMasked) r.reads.add(this.bootMasked);
      return r;
    } finally { s.romMasked = outer; }
  }

  // Every entry (boot, load, startGame, call, animationFrames) first catches up with a changed ROM
  // (rom.gen): the data array may be replaced (expansion), and a change of what the boot read (a
  // patch's power-on code, e.g. Retry System's RAM setup) makes the boot snapshot stale: boot again
  // with the next load. The byte pages are computed again when another ROM's were computed since (a
  // check only, when they are this ROM state's).
  private sync(): void {
    this.snes.rom = this.rom.data;
    updateBytePages(this.rom);
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    if (this.baseState && this.bootReads && this.bootRom &&
      (this.bootReads.differ(this.bootRom, this.rom.data) || this.bootMasked?.differ(this.bootRom, this.rom.data))) {
      this.baseState = null;
      this.bootReads = null;
      this.bootMasked = null;
      this.bootRom = null;
    }
  }

  // the boot snapshot, booted (again) when there is none or what it read changed
  ensureBoot(): void {
    this.sync();
    if (!this.baseState) this.boot();
  }

  load(level: number, ov: LevelOverride = {}): LevelRender {
    this.ensureBoot();
    const s = this.snes;
    if (!ov.continueState) s.loadState(this.baseState!);
    const w = s.wram;
    w[RAM.marioX + 1] = 0;
    w[RAM.marioY + 1] = 0;
    w[RAM.screenMode] = 0;
    w[RAM.screenExitLo] = level & 0xff;
    w[RAM.screenExitHi] = (level >> 8) & 1;
    w[RAM.currentPlayer] = 0;
    // the submap (old-style screen exits take the target's high bit from it): the level's bank; a game in
    // progress keeps its own
    if (!ov.continueState) w[RAM.submap] = (level >> 8) & 1;
    w[RAM.useSecondaryExit] = 0;
    w[RAM.introLevel] = 0;
    // coming from the title screen or overworld, the game's call of the music bank upload sees $141A
    // as on entering a level from there (the routine checks the other conditions itself)
    const musicCall = s.apu && w[RAM.sublevelCount] === 0 ? snesToPc(LEVEL_MUSIC_CALL) : -1;
    // and no level song playing, as the overworld load leaves it ($00A0B9; the title screen's demo
    // level set one, so the level's song wouldn't start if it was the same)
    if (musicCall >= 0) w[RAM.levelMusic] = 0;
    w[RAM.sublevelCount] = 1;
    // translevel $24 (Chocolate Island 2) makes the exit-based load pick a room by time/coins instead
    const tl = ov.translevel ?? mainTranslevel(level) ?? 0;
    w[RAM.translevel] = tl === 0x24 ? 0 : tl;
    if (ov.midway || ov.fromOverworld) {
      // from the overworld ($141A 0) the game takes the translevel from the overworld tile Mario is on ($05D84D)
      const p = w[RAM.currentPlayer], tx = w[RAM.owPlayerTileX + p], ty = w[RAM.owPlayerTileY + p];
      const i = (tx & 15) | ((tx & 16) << 4) | ((ty & 15) << 4) | ((ty & 16) << 5) | (w[RAM.submap + (p >> 2)] & 15 ? 0x400 : 0);
      w[RAM.owTranslevels + i] = tl;
      w[RAM.sublevelCount] = 0;
      if (ov.midway) w[RAM.levelFlags + tl] |= 0x40;
    }
    if (ov.switchPalaces) for (let i = 0; i < 4; i++) w[RAM.switchPalaces + i] = 1;
    if (ov.onOffSwitch) w[RAM.onOff] = 1;
    if (ov.cdm16Flags) w.set(ov.cdm16Flags.subarray(0, CDM16_FLAGS[1]), CDM16_FLAGS[0] - 0x7e0000);
    w[RAM.gameMode] = GM.levelLoad;

    // temporary pointer patches in the ROM image, taken back after the load: written past rom.w8, as they are
    // no change of the ROM (rom.gen) – the probe worker would be sent it again, dropping its queue
    const rom = this.rom;
    const saved: [number, number][] = [];
    const patch = (snes: number, v: number) => {
      const o = snesToPc(snes);
      saved.push([o, rom.data[o]]);
      s.romSkip.add(o); // their content doesn't matter: reads don't count for romPages
      rom.data[o] = v & 0xff;
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
    if (ov.layer3) {
      this.overlay.set(ov.layer3.data, OV_L3);
      for (const [a, v] of lt3Patches(rom, level, overlaySnes(OV_L3), ov.layer3.place)) patch(a, v);
    }
    if (ov.sprites) {
      this.overlay.set(ov.sprites, OV_SPR);
      const a = overlaySnes(OV_SPR);
      patch(SPR_PTRS + level * 2, a & 0xff);
      patch(SPR_PTRS + level * 2 + 1, (a >> 8) & 0xff);
      // sprite data bank: the editor patch's bank table
      const p = editorPatch(rom);
      if (p) patch(p.sprBank + level, a >> 16);
      else patch(0x05d8f6, a >> 16); // a clean ROM (tests): vanilla LDA #$07 : STA $D0 at $05D8F5
    }
    // bytes a secondary header leaves out are 0 (probes' test levels: the game's level size, paired
    // layer 2 rates); layer 1 data without one is in the game's layout (the game's size)
    if (ov.secondaryHeader) SEC_HDR.forEach((t, i) => patch(t + level, ov.secondaryHeader![i] ?? 0));
    else if (ov.layer1) patch(LEVEL_SIZE_TABLE + level, 0);
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
    let sublevels = 1; // $141A as the load set it, while the music call sees 0
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
        else if (a >= MAP_HI + MAP_BASE && a < MAP_HI + MAP_BASE + MAP_SIZE) { touch(current, a - MAP_HI - MAP_BASE); if (trace) put(a - MAP_HI - MAP_BASE, v, true); }
      },
      onRomRead: trace || musicCall >= 0 ? (ro: number) => {
        // after the call $141A is back as the load set it: 0 entered from the overworld, where the game decides
        // by it whether a level's no-Yoshi intro plays its walk into the castle or ghost house
        if (cpu.inFetch && ro === musicCall) { sublevels = w[RAM.sublevelCount]; w[RAM.sublevelCount] = 0; }
        else if (cpu.inFetch && ro === musicCall + 3) w[RAM.sublevelCount] = sublevels;
        if (!trace) return;
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
      // GM $11 loads the level; hooks only needed there. With the sound unit emulated, the upload of
      // the level music bank takes some 40 frames of it
      const loadLimit = musicCall >= 0 ? 120 : 30;
      while (w[RAM.gameMode] === GM.levelLoad && frames < loadLimit) { s.runFrame(); frames++; }
      if (ov.timer !== undefined) { w[RAM.timer] = ov.timer; w[RAM.timer + 1] = 0; w[RAM.timer + 2] = 0; }
      if (ov.exTriggers) applyTriggers(w, ov.exTriggers);
      s.hook = ov.fadeHook?.() ?? null;
      // with the sound unit emulated, the fade-in also waits for the song's upload (AddmusicK sends a
      // song with its samples then: well over 100 frames for big ones)
      const limit = s.apu ? 600 : 120;
      while (w[RAM.gameMode] < 0x13 && frames < limit) { s.runFrame(); frames++; }
      s.runFrame(); frames++;
      if (w[RAM.gameMode] < 0x13) { ok = false; error = `level load stalled in game mode ${w[RAM.gameMode].toString(16)}`; }
    } catch (e) {
      ok = false;
      error = String(e);
    } finally {
      s.hook = null;
      s.taintOn = false;
      for (let i = saved.length - 1; i >= 0; i--) rom.data[saved[i][0]] = saved[i][1];
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
    this.startOn((w) => (tl > 0 ? w.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd).indexOf(tl) : -1));
  }
  // as startGame, Mario on layer 1 tile i (l1Index order)
  startGameAt(i: number): void {
    this.startOn(() => i);
  }
  // tile: Mario's layer 1 tile on the overworld the new game reached (< 0: he stays at the start)
  private startOn(tile: (wram: Uint8Array) => number): void {
    this.sync();
    if (!this.baseState) this.boot();
    const s = this.snes, w = s.wram;
    s.loadState(this.baseState!);
    s.joy1 = 0;
    for (let n = 0; w[RAM.gameMode] !== GM.overworld; n++) {
      if (n > 1500) throw new Error('new game did not reach the overworld');
      if (w[RAM.gameMode] === GM.overworldLoad) w[RAM.introLevel] = 0; // no intro level
      s.joy1 = (n % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
      s.runFrame();
    }
    s.joy1 = 0;
    for (let i = 0; i < 3; i++) s.runFrame();
    const i = tile(w);
    if (i < 0) return;
    const { x: tx, y: ty } = l1XY(i);
    // pixel position: like the start position relative to its tile
    const px = tx * 16 + (w[RAM.owPlayerX] - w[RAM.owPlayerTileX] * 16), py = ty * 16 + (w[RAM.owPlayerY] - w[RAM.owPlayerTileY] * 16);
    let sub = 0;
    if (i >= 0x400) {
      const ow = s.saveState();
      let best = Infinity;
      for (let k = 1; k <= 6; k++) {
        s.loadState(ow);
        w[RAM.submap] = k;
        w[RAM.gameMode] = GM.overworldLoad;
        for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 500; f++) s.runFrame();
        const cx = getS16(w, RAM.layer1X) + 128, cy = getS16(w, RAM.layer1Y) + 112;
        const d = Math.max(Math.abs(px + 8 - cx), Math.abs(py + 8 - cy));
        if (d < best) { best = d; sub = k; }
      }
      s.loadState(ow);
    }
    for (const o of [0, RAM.owPlayerStride]) { // Mario and Luigi
      set16(w, RAM.owPlayerX + o, px); set16(w, RAM.owPlayerY + o, py);
      set16(w, RAM.owPlayerTileX + o, tx); set16(w, RAM.owPlayerTileY + o, ty);
    }
    w[RAM.submap] = w[RAM.submap + 1] = sub;
  }

  // loads level n of translevel tl within the game startGame(tl) began: entered from the overworld tile as in
  // the game – only then the game sets up the midway point ($13CD), so that its tape counts; a sub-level
  // through its main level. (Translevel 0 is on no tile; $24 picks a room by time and coins.)
  loadInGame(n: number, tl: number, ov: LevelOverride = {}): LevelRender {
    const main = tl && tl !== 0x24 ? translevelToLevel(tl) : -1;
    if (main >= 0 && main !== n) this.load(main, { translevel: tl, continueState: true, fromOverworld: true });
    return this.load(n, { ...ov, translevel: tl, continueState: true, fromOverworld: main === n });
  }

  // runs a game routine (JSL addr, RTL) with X = x in 8-bit mode, then restores the CPU registers
  call(addr: number, x: number): void {
    this.sync();
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
    w[SPR.num + slot] = num;
    w[SPR.status + slot] = 1;
    setSpritePos(w, slot, x, y);
    w[SPR.loadIndex + slot] = 0xff;
    this.call(INIT_TABLES, slot);
    if (id >= 0x200) {
      // custom sprite (PIXI): number and extra bits; its INIT sets up the tables
      w[SPR.customNum + slot] = num;
      w[SPR.extraBits + slot] = 0x08 | ((id >> 6) & 0x04);
      for (const t of SPR.extraBytes) w[t + slot] = 0;
    }
  }

  // Continues the live state left by load() into gameplay (GM $14) and snapshots VRAM/CGRAM
  // every `step` frames (tile and palette animation). Must directly follow load().
  // Mario is kept invulnerable as after a hit: a sprite walking into him would kill him and the game
  // (its animations included) freeze for the rest of the frames.
  animationFrames(count = 8, step = 8): { vram: Uint8Array; cgram: Uint8Array }[] {
    this.sync();
    const s = this.snes, out: { vram: Uint8Array; cgram: Uint8Array }[] = [];
    try {
      let guard = 0;
      while (s.wram[RAM.gameMode] !== GM.level && guard++ < 80) s.runFrame();
      for (let i = 0; i < count; i++) {
        for (let f = 0; f < step; f++) { s.wram[RAM.hurtTimer] = 2; s.runFrame(); }
        out.push({ vram: s.vram.slice(), cgram: s.cgram.slice() });
      }
    } catch { /* keep the frames we have */ }
    return out;
  }

  // the images of animationFrames one at a time, for background slices: each call runs `step` frames on from
  // where the last one stopped – other loads in between don't disturb it; null once the game fails
  animationSteps(step = 8): () => { vram: Uint8Array; cgram: Uint8Array } | null {
    let state: SnesState | null = this.snes.saveState();
    return () => {
      if (!state) return null;
      this.snes.loadState(state);
      const f = this.animationFrames(1, step)[0] ?? null;
      state = f && this.snes.saveState();
      return f;
    };
  }
}

// The 8x8 tiles (layer 1 tile numbers) and colors that change in level n (ov) over 16 times 4 frames (none when it
// fails): the animated tiles and colors (a picture, the result learner's job, CONTEXT.md)
export interface Animated { tiles: Set<number>; colors: Set<number> }
export function* animatedJob(emu: LevelEmulator, n: number, ov: LevelOverride): Generator<never, Animated> {
  const tiles = new Set<number>(), colors = new Set<number>();
  try {
    const r = emu.load(n, ov);
    const frames = emu.animationFrames(16, 4);
    const base = (r.ppuRegs[0x0b] & 0x0f) << 13;
    for (const f of frames) {
      for (let t = 0; t < 0x400; t++) {
        const o = (base + t * 32) & 0xffff;
        for (let b = 0; b < 32; b++) if (f.vram[o + b] !== r.vram[o + b]) { tiles.add(t); break; }
      }
      for (let c = 0; c < 256; c++) if (f.cgram[c * 2] !== r.cgram[c * 2] || f.cgram[c * 2 + 1] !== r.cgram[c * 2 + 1]) colors.add(c);
    }
  } catch (e) { console.error(e); return { tiles: new Set(), colors: new Set() }; }
  return { tiles, colors };
}

// the level the game loads for its title screen (the entry of the layer 1 pointer table it reads while
// booting), null when it reads none; emulated once per ROM state
const titleLevels = new WeakMap<Rom, { gen: number; level: number | null }>();
export function titleScreenLevel(rom: Rom): number | null {
  const had = titleLevels.get(rom);
  if (had?.gen === rom.gen) return had.level;
  const e = new LevelEmulator(rom), table = snesToPc(L1_PTRS);
  let level: number | null = null;
  e.snes.hook = { onRomRead: (o) => { if (level === null && o >= table && o < table + 0x200 * 3) level = Math.floor((o - table) / 3); } };
  try { e.boot(); } catch { level = null; }
  titleLevels.set(rom, { gen: rom.gen, level });
  return level;
}
