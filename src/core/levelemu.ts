// Runs the game's own level loading code to obtain the exact Map16 level layout,
// graphics (VRAM) and palettes (CGRAM) of a level, including per-tile ownership
// (which object produced which tile).

import { Snes, type SnesState, type MemHook } from './snes.ts';
import { Rom, snesToPc } from './rom.ts';
import { L1_PTRS, L2_PTRS, SPR_PTRS, SEC_HDR, LEVEL_SIZE_TABLE, mainTranslevel } from './level.ts';
import { translevelToLevel, l1XY } from './overworld.ts';
import { OW_SPRITES, OW_SPRITE_SLOTS, hasOwSpriteSlots } from './owsprites.ts';
import { editorPatch, musicPatch, BG_HOOK, HEADER_MUSIC_TABLE } from './patches.ts';
import { lt3Patches, type Lt3Place } from './layer3gfx.ts';
import { RomReads, record, countReads, unrecorded, PAGE_SHIFT, type Recorded } from './romdeps.ts';
import { BootSnapshot, recordShown, type Shows, type RecordOn } from './bootsnapshot.ts';
import { titlePictureRanges } from './titlepicture.ts';
import { FrameRecorder, LoadSession, sameKey, type FrameOwner, type LoadFrames, type LoadFramesKey } from './loadframes.ts';
import { findSpriteTables, spriteTablesHold } from './spritetables.ts';
import { applyTriggers, type TriggerView } from './extrigger.ts';
import { inputHash, levelInput } from './inputs.ts';
import { GM, RAM, SPR, MAP_BASE, MAP_SIZE, MAP_HI, CDM16_FLAGS, MUSIC_FADE, getS16, set16, setSpritePos, freezeActors } from './ram.ts';

export const OV_L1 = 0x0000; // overlay offsets

// The owners of a test level's layer 1 data bytes as LevelOverride.byteOwner (owners: per byte of the data, -1 none).
// One array for all of them, not one per load (256 KB each, a thousand loads at a level switch: #510): it holds until
// the next call, which is enough for a load – the emulator reads it only while it loads, a recorded frame copies what
// it read of it (loadframes.ts).
const testOwners = new Int32Array(0x10000).fill(-1);
let testOwnersSet = 0;
export function layer1Owners(owners: readonly number[]): Int32Array {
  testOwners.fill(-1, OV_L1, OV_L1 + testOwnersSet);
  for (let i = 0; i < owners.length; i++) testOwners[OV_L1 + i] = owners[i];
  testOwnersSet = owners.length;
  return testOwners;
}
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
// the ROM offset of one of ObjectTrace.reads
export const readOffset = (key: number): number => key % 0x800000;

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
  private romGen: number; // the ROM's generation the emulator is synced to (see sync)
  // ROM bytes whose reads by the emulated CPU don't count for record() results (GFX file and ExAnimation data,
  // gfxSkipMask; for results that are no pictures the display data too, gfxDisplaySkipMask)
  skipMask: (() => Uint8Array | null) | null = null;
  overlay = new Uint8Array(0x10000);
  // a load takes over the frames of the previous load that read the same (loadframes.ts, #448): for the emulator of a
  // view loading one level again and again (an edit, a drag's steps); emulatedFrames: how many the last load emulated
  reuseLoads = false;
  emulatedFrames = 0;
  private lastLoad: LoadFrames | null = null;
  private recorder: FrameRecorder | null = null;

  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.snes.overlay = this.overlay;
    this.romGen = rom.gen;
  }

  // the boot snapshot every load starts from (bootsnapshot.ts): booted here or taken over, shared by reference
  snapshot: BootSnapshot | null = null;

  // takes over a boot snapshot of another emulator on the same ROM (saves booting again)
  adoptBoot(snapshot: BootSnapshot | null): void {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.romGen = -1; // it may be from an older ROM: checked with the next entry
  }

  // Power on and boot to the title screen once; all level loads start from this snapshot.
  // The title screen runs the game's overworld sprite loader ($04F678) and shows none of them (their OAM tiles off
  // the screen, their RAM unused in a level; a load of the overworld runs the loader again): reads of the slot table
  // aren't recorded, so an overworld sprite edit keeps every result and the snapshot.
  // It draws the title screen picture (titlepicture.ts), of which nothing is left in a level loaded – its load writes
  // layer 3's tilemap anew and doesn't read the picture (testtitlescreen.ts): the picture's reads aren't recorded as
  // the boot's but kept on their own in the snapshot. So painting it boots the snapshot again and keeps every result
  // that doesn't show the title screen (#550); a result that does counts them (record 'title screen').
  // The per-sprite tables are found from the snapshot (spritetables.ts) when those found for the ROM no longer hold
  // (or none were): the boot's reads are then recorded by byte, and kept by byte only in the tables' pages.
  boot(): void {
    this.sync();
    const s = this.snes;
    s.powerOn();
    const masked = new RomReads(this.rom), outerMasked = s.romMasked;
    // not recorded (romSkip: also when the boot runs inside another recording, whose skip mask applies then)
    const skipped: number[] = [];
    const slots = hasOwSpriteSlots(this.rom) ? snesToPc(OW_SPRITES) : -1, slotsEnd = slots + OW_SPRITE_SLOTS * 5;
    for (let o = slots; o >= 0 && o < slotsEnd; o++) skipped.push(o);
    const picture = new RomReads(this.rom);
    for (const [a, b] of unrecorded(this.rom, () => titlePictureRanges(this.rom))) {
      picture.read(a, b - a);
      for (let o = a; o < b; o++) skipped.push(o);
    }
    for (const o of skipped) s.romSkip.add(o);
    s.romMasked = masked;
    const find = !spriteTablesHold(this.rom);
    let reads: RomReads;
    try {
      reads = record(this.rom, () => {
        let f = 0;
        while (s.wram[RAM.gameMode] !== GM.title) {
          s.runFrame();
          if (++f > 2000) throw new Error('boot did not reach title screen');
        }
      }, { cpu: s, mask: this.skipMask, counted: false, fine: find }).reads;
    } finally {
      s.romMasked = outerMasked;
      for (const o of skipped) s.romSkip.delete(o);
    }
    this.snapshot = new BootSnapshot({ state: s.saveState(), rom: this.rom.data.slice(), reads, masked, picture });
    if (find) findSpriteTables(this, reads);
    this.count(reads);
  }

  // runs fn with skipMask set to mask (a mask or a function returning one), the previous one restored
  // when it returns or throws
  withSkipMask<T>(mask: Uint8Array | null | (() => Uint8Array | null), fn: () => T): T {
    const base = this.skipMask;
    this.skipMask = typeof mask === 'function' ? mask : () => mask;
    try { return fn(); } finally { this.skipMask = base; }
  }

  // the boot snapshot, booted (again) when there is none or what the boot read changed
  bootSnapshot(): BootSnapshot {
    this.ensureBoot();
    return this.snapshot!;
  }

  // the machine at the title screen, as booted (booting first when the ROM changed what the boot read)
  bootState(): SnesState {
    return this.bootSnapshot().state;
  }

  // Runs fn recording the ROM it reads, as a result that shows `shows` counts it (bootsnapshot.ts Shows): behaviour
  // and picture what skipMask leaves in, on top of the boot's reads; a full picture the reads skipMask leaves out
  // too, fn's and the boot's (a render shows GFX file data); what shows the title screen the title screen picture's
  // bytes as well (not what only starts from the boot: a level loaded, the title screen movement's run).
  // on: what the reads are put on top of instead of the boot's, and whether they count for an enclosing record()
  // (with counted false only when given to count()).
  record<T>(shows: Shows, fn: () => T, on: RecordOn = {}): Recorded<T> {
    return recordShown(this.rom, this.snes, shows, fn, { ...on, snapshot: () => this.snapshot, mask: this.skipMask });
  }

  // reads (of a record() call not counted) count for the enclosing record() call as if read in it
  count(reads: RomReads): void {
    countReads(this.rom, this.snes, reads);
  }

  // Every entry (boot, load, startGame, call, animationFrames) first catches up with a changed ROM
  // (rom.gen): the data array may be replaced (expansion), and a change of what the boot read (a
  // patch's power-on code, e.g. Retry System's RAM setup) makes the boot snapshot stale: boot again
  // with the next load.
  private sync(): void {
    this.snes.rom = this.rom.data;
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    if (this.snapshot && !this.snapshot.holds(this.rom.data)) this.snapshot = null;
  }

  // the boot snapshot, booted (again) when there is none or what it read changed
  ensureBoot(): void {
    this.sync();
    if (!this.snapshot) this.boot();
  }

  load(level: number, ov: LevelOverride = {}): LevelRender {
    this.ensureBoot();
    const s = this.snes;
    if (!ov.continueState) s.loadState(this.snapshot!.state);
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
    // with the sound unit emulated: as the overworld does on entering a level ($0491E0), the song playing is faded
    // out for as long as the game's fade lasts before the level's music bank is uploaded. Still playing, the song
    // would go on reading its data where the upload put the new bank's, which can crash the sound driver (silent,
    // and every later upload waits for it: the overworld after dying stays black)
    if (musicCall >= 0) {
      w[RAM.musicRequest] = MUSIC_FADE;
      w[RAM.gameMode] = GM.levelFade;
      for (let f = 0; f < 120 && w[RAM.gameMode] === GM.levelFade; f++) s.runFrame();
    }
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
      this.recorder?.touched(k, o);
      owner[o] = k;
      let set = touched.get(k);
      if (!set) { set = new Set(); touched.set(k, set); }
      set.add(o);
    };
    const byteOwner = ov.byteOwner;
    // the object map writes are attributed to: the owner of the level data byte read last (a frame taken over sets it)
    const own: FrameOwner = { current: -1, byteOwner, touch: (k, o) => touch(k, o) };
    const trace: ObjectTrace | undefined = ov.trace ? { code: new Set(), reads: new Map(), writes: new Map(), rom: new Set() } : undefined;
    const cpu = s.cpu;
    let sublevels = 1; // $141A as the load set it, while the music call sees 0
    const skip = trace ? this.skipMask?.() ?? null : null; // not dependencies of the result (GFX, ExAnimation data)
    const put = (o: number, v: number, hi: boolean) => {
      let m = trace!.writes.get(own.current);
      if (!m) { m = new Map(); trace!.writes.set(own.current, m); }
      const old = m.get(o) ?? 0;
      m.set(o, hi ? (old & 0xff) | (v << 8) : (old & 0xff00) | v);
    };
    s.hook = {
      onOverlayRead(o: number) {
        if (byteOwner && o < byteOwner.length) own.current = byteOwner[o];
      },
      onWramWrite(a: number, v: number) {
        const current = own.current;
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
        if (own.current < 0) return;
        let r = trace.reads.get(own.current);
        if (!r) { r = new Set(); trace.reads.set(own.current, r); }
        r.add(cpu.opPc * 0x800000 + ro);
      } : undefined,
    };
    s.trackSources(!!ov.trackSources);
    let frames = 0;
    let ok = true;
    let error: string | undefined;
    // the frames of the previous load taken over where they read the same (#448): with reuse on, not for a game in
    // progress, a traced or source-tracked load, a watched fade-in, the sound unit or the PPU's renderer. (The mask the
    // frames' ROM reads are recorded with: an enclosing recording's, else the emulator's.)
    const reuse = this.reuseLoads && !ov.continueState && !ov.trace && !ov.trackSources && !ov.fadeHook && !s.apu && !s.ppu;
    const key: LoadFramesKey | null = reuse ? { data: rom.data, base: this.snapshot!.state, patches: saved.map(([o]) => `${o}:${rom.data[o]}`).join(),
      mask: s.romReads ? s.romSkipMask : this.skipMask?.() ?? null } : null;
    const last = this.lastLoad;
    const session = new LoadSession(s, reuse ? (this.recorder ??= new FrameRecorder(s, rom, this.overlay, () => this.skipMask?.() ?? null)) : null,
      key && last && sameKey(last.key, key) ? last.frames : null, own);
    const frame = () => session.frame();
    const run = () => {      // GM $11 loads the level; hooks only needed there. With the sound unit emulated, the upload of
      // the level music bank takes some 40 frames of it
      const loadLimit = musicCall >= 0 ? 120 : 30;
      while (w[RAM.gameMode] === GM.levelLoad && frames < loadLimit) { frame(); frames++; }
      if (ov.timer !== undefined) { w[RAM.timer] = ov.timer; w[RAM.timer + 1] = 0; w[RAM.timer + 2] = 0; }
      if (ov.exTriggers) applyTriggers(w, ov.exTriggers);
      s.hook = ov.fadeHook?.() ?? null;
      // with the sound unit emulated, the fade-in also waits for the song's upload (AddmusicK sends a
      // song with its samples then: well over 100 frames for big ones)
      const limit = s.apu ? 600 : 120;
      while (w[RAM.gameMode] < 0x13 && frames < limit) { frame(); frames++; }
      frame(); frames++;
      if (w[RAM.gameMode] < 0x13) { ok = false; error = `level load stalled in game mode ${w[RAM.gameMode].toString(16)}`; }
    };
    try {
      run();
    } catch (e) {
      ok = false;
      error = String(e);
    } finally {
      s.hook = null;
      s.trackSources(false);
      for (let i = saved.length - 1; i >= 0; i--) rom.data[saved[i][0]] = saved[i][1];
      s.romSkip.clear();
    }
    this.emulatedFrames = session.emulated;
    // (kept for the next load: a whole load that wrote no SRAM, which the frames don't record)
    this.lastLoad = key && ok && session.sramKept ? { key, frames: session.frames } : null;
    return {
      wram: s.wram.slice(),
      vram: s.vram.slice(),
      cgram: s.cgram.slice(),
      cgramSrc: ov.trackSources ? s.cgTaint.slice() : new Int32Array(0x200).fill(-1),
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
  // each submap) is centered nearest to them; the overworld is then loaded again there, so that the game's state
  // for his tile ($13C1: what A does) is as when he arrives. Not found on the overworld: Mario stays at the start.
  startGame(tl: number): void {
    this.startOn((w) => (tl > 0 ? w.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd).indexOf(tl) : -1));
  }
  // as startGame, Mario on layer 1 tile i (l1Index order; < 0: at the start position); events: the event bits
  // ($1F02, overworld.ts eventBits) of the game, set as the file is loaded and the overworld loads (as
  // OverworldEmulator.load: the game draws their layer 2 tiles at the file select, applies them to layer 1 on the load)
  startGameAt(i: number, events?: Uint8Array): void {
    this.startOn(() => i, events);
  }
  // tile: Mario's layer 1 tile on the overworld the new game reached (< 0: he stays at the start)
  private startOn(tile: (wram: Uint8Array) => number, events?: Uint8Array): void {
    this.sync();
    if (!this.snapshot) this.boot();
    const s = this.snes, w = s.wram;
    s.loadState(this.snapshot!.state);
    this.untilOverworld(true, events);
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
    // the overworld loaded again where he stands, as after a level: the game sets what it derives from his tile –
    // the tile he stands on ($13C1, read by A: a star tile 5F enters no level), his submap's view – as when he
    // arrives there (walking, $0495DE: the same read of layer 1 at his tile as the load's, $048E9B)
    this.reloadOverworld(events);
  }

  // on the overworld: loads it again as the game does after a level, so that it shows where Mario stands now (his
  // submap, the camera at him, the tile he stands on) – after his tile or submap was changed in RAM (startGame and
  // startGameAt do it for the tile they put him on); events: set again as it loads (startGameAt)
  reloadOverworld(events?: Uint8Array): void {
    this.sync();
    this.snes.wram[RAM.gameMode] = GM.overworldLoad;
    this.untilOverworld(false, events);
  }
  // a new game (startGameAt), the overworld then loaded on submap `map` as the game loads it after a level – what
  // plays there with the sound unit emulated: the submap's song from the overworld's sound bank (without AddmusicK
  // another bank than the levels'); events: as startGameAt
  loadOverworldOn(map: number, events?: Uint8Array): void {
    this.startGameAt(-1, events);
    const w = this.snes.wram;
    w[RAM.submap] = w[RAM.submap + 1] = map; // (Mario's and Luigi's; Mario stays on his tile, which the song doesn't depend on)
    this.reloadOverworld(events);
  }
  // frames until the overworld runs (newGame: through the title screen and file select, buttons pressed), no intro
  // level; events (startGameAt) set as the file and the overworld load
  private untilOverworld(newGame: boolean, events?: Uint8Array): void {
    const s = this.snes, w = s.wram;
    for (let n = 0; w[RAM.gameMode] !== GM.overworld; n++) {
      if (n > 1500) throw new Error(newGame ? 'new game did not reach the overworld' : 'the overworld did not load');
      const m = w[RAM.gameMode];
      if (events && (m === GM.playerSelect || m === GM.overworldLoad)) w.set(events, RAM.owEvents);
      if (m === GM.overworldLoad) w[RAM.introLevel] = 0; // no intro level
      s.joy1 = newGame && (n % 16) < 4 ? (m === GM.title ? 0x1000 : 0x0080) : 0;
      s.runFrame();
    }
    s.joy1 = 0;
    for (let i = 0; i < 3; i++) s.runFrame();
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
    let num = id & 0xff, status = 1;
    // the shells DA–DD and DF: the game's loader ($02A8D4, $02A976) makes them sprites 04–07 / 09 in the
    // stationary state (9) – their own numbers have no INIT or MAIN (a JSL into garbage)
    if (id < 0x100 && num >= 0xda && num <= 0xdf && num !== 0xde) {
      status = 9;
      num = num - 0xda + 4;
      if (w[RAM.specialWorld] & 0x80) num = num === 4 ? 7 : num === 5 ? 6 : num; // the special world's colours
    }
    w[SPR.num + slot] = num;
    w[SPR.status + slot] = status;
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
  // The level runs without Mario and its sprites (freezeActors, #444; from the frames that wait for gameplay on, the
  // load itself done): what it animates by itself, not what they do
  // – nor what they read of the level's tiles around them, so that moving things near them leaves the level
  // animation's steps (levelanimsteps.ts) carried; and nothing kills Mario or locks the game (its animations included)
  // for the rest of the frames.
  animationFrames(count = 8, step = 8): { vram: Uint8Array; cgram: Uint8Array }[] {
    this.sync();
    const s = this.snes, w = s.wram, out: { vram: Uint8Array; cgram: Uint8Array }[] = [];
    try {
      let guard = 0;
      while (w[RAM.gameMode] !== GM.level && guard++ < 80) { freezeActors(w); s.runFrame(); }
      for (let i = 0; i < count; i++) {
        for (let f = 0; f < step; f++) { freezeActors(w); s.runFrame(); }
        out.push({ vram: s.vram.slice(), cgram: s.cgram.slice() });
      }
    } catch { /* keep the frames we have */ }
    return out;
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
