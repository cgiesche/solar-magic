// Nintendo Presents (CONTEXT.md): what the logo at power-on is made of, as fields – each OBJ's position, tile and
// properties, the time it is shown, its colours, and the graphics file its tiles are from. Lunar Magic edits none
// of this.
//
// Nothing here knows where the game keeps these. The way to the screen is run again (pregame.ts replayScreen) with
// every byte's source tracked (Snes.trackSources): a byte of OAM or of CGRAM the game loaded from the ROM – from a
// table or as an instruction's operand – is a field at that ROM offset; one the game computed is shown, not edited.
// - The time: a byte of RAM the game set from the ROM before the logo shows and counts while it shows; that it is the
//   time is tried – with another value there, the logo shows that many frames longer or shorter.
// - The colours: the CGRAM entries the logo's pixels use.
// - The graphics file: the one the game read on the way whose tiles are the logo's in VRAM.
// A logo a patch draws its own way (128x128 Nintendo Presents Logo, Logo Expansion, Mode 3/8bpp Nintendo Presents
// Screen) computes what it writes or draws no OBJ: its page shows the result, with the fields that are left, or none.

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import { snesToPc } from './rom.ts';
import { GM, RAM } from './ram.ts';
import { holds, type RomReads } from './romdeps.ts';
import { decodeTile } from './gfx.ts';
import { readGfx } from './gfxfiles.ts';
import { gfxEntry, GFX_FILES } from './patches.ts';
import { replayScreen, type ReachedScreen } from './pregame.ts';

// a value the game shows and the ROM offset it reads it from (-1: computed, or not found – no field)
export interface PresentsValue { value: number; at: number }
export interface LogoObj {
  index: number; // its OAM entry
  x: PresentsValue; // on the screen (0–255)
  y: PresentsValue;
  tile: PresentsValue;
  props: PresentsValue; // YXPPCCCT: flips, priority, palette, the tile's page
  big: boolean; // the larger of the two OBJ sizes (16x16 as the game sets them)
}
// the CGRAM entry; value: its 15-bit colour, at: its low byte; shared: the other CGRAM entries the game loads from the
// same ROM word (the game's white of every palette's colour 1: not the logo's own colour)
export interface LogoColour extends PresentsValue { index: number; shared: number }
export interface PresentsLogo {
  objs: LogoObj[]; // the OBJ on the screen
  time: PresentsValue | null; // the frames the game counts while the logo shows (null: none found)
  colours: LogoColour[]; // the colours the OBJ's pixels use
  gfx: { file: number; tile: number } | null; // the graphics file the tiles are from, and the file's tile the first OBJ shows
}

const RUN_FRAMES = 900; // from the way's start until the game is past Nintendo Presents
const OBJ_SIZES = [[8, 16], [8, 32], [8, 64], [16, 32], [16, 64], [32, 64], [16, 32], [16, 32]]; // by OBSEL's bits 5–7
const TIME_STEP = 16; // the frames the time is changed by to try it

// the frames the game stays in the game mode that shows the logo, from the way's start (0: it never gets there)
function shownFrames(emu: LevelEmulator, screen: ReachedScreen): number {
  const w = emu.snes.wram;
  let n = 0;
  replayScreen(emu, screen, null, { frames: RUN_FRAMES, each: () => { if (w[RAM.gameMode] === screen.mode) n++; else if (n) return false; } });
  return n;
}

// What the logo is made of. The emulator's machine is left in the last state run.
export function learnPresents(emu: LevelEmulator, screen: ReachedScreen): PresentsLogo {
  const s = emu.snes, d = emu.rom.data, hook = s.hook;
  s.hook = null;
  try {
    // the way run again: the sources of OAM and CGRAM, the graphics files read
    const oamSrc = new Int32Array(s.oam.length).fill(-1), read = new Set<number>();
    replayScreen(emu, screen, { onOamWrite: (a) => { oamSrc[a] = s.writeSource; }, onRomRead: (o) => { read.add(o); } }, { sources: true });
    const oam = s.oam.slice(), cgram = s.cgram.slice(), cgSrc = s.cgTaint.slice(), vram = s.vram, obsel = s.ppuRegs[0x01];
    const field = (value: number, src: number): PresentsValue => ({ value, at: src >= 0 && d[src] === value ? src : -1 });
    const sizes = OBJ_SIZES[obsel >> 5], objs: LogoObj[] = [];
    for (let i = 0; i < 128; i++) {
      const hi = (oam[0x200 + (i >> 2)] >> ((i & 3) * 2)) & 3, size = sizes[hi >> 1];
      const x = oam[i * 4] - (hi & 1 ? 256 : 0), y = oam[i * 4 + 1];
      if (x <= -size || !(y < 224 || y + size > 256)) continue;
      objs.push({ index: i, x: field(oam[i * 4], oamSrc[i * 4]), y: field(y, oamSrc[i * 4 + 1]), tile: field(oam[i * 4 + 2], oamSrc[i * 4 + 2]),
        props: field(oam[i * 4 + 3], oamSrc[i * 4 + 3]), big: !!(hi >> 1) });
    }
    // the 8x8 tiles each OBJ shows, as pixels: where OBSEL has the OBJ's graphics
    const base = (obsel & 7) << 14, gap = ((obsel >> 3) & 3) << 13;
    const tilePix = (o: LogoObj): Uint8Array[] => {
      const n = sizes[+o.big] >> 3, out: Uint8Array[] = [];
      for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) {
        const t = ((o.tile.value + ty * 16) & 0xf0) | ((o.tile.value + tx) & 0x0f), px = new Uint8Array(64);
        decodeTile(vram, (base + (o.props.value & 1 ? 0x2000 + gap : 0) + t * 32) & 0xffff, 4, px);
        out.push(px);
      }
      return out;
    };
    const pix = objs.map(tilePix);
    // the colours the pixels use
    const used = new Set<number>();
    objs.forEach((o, k) => { for (const t of pix[k]) for (const p of t) if (p) used.add(128 + ((o.props.value >> 1) & 7) * 16 + p); });
    const colours: LogoColour[] = [...used].sort((a, b) => a - b).map((index) => {
      const value = cgram[index * 2] | (cgram[index * 2 + 1] << 8), lo = cgSrc[index * 2], hiSrc = cgSrc[index * 2 + 1];
      const at = lo >= 0 && hiSrc === lo + 1 && (d[lo] | (d[lo + 1] << 8)) === value ? lo : -1;
      let shared = 0;
      if (at >= 0) for (let i = 0; i < 256; i++) if (i !== index && cgSrc[i * 2] === at) shared++;
      return { index, value, at, shared };
    });
    // the graphics file: one read on the way that has the first OBJ's tiles (the others' where they are from there)
    let gfx: PresentsLogo['gfx'] = null;
    const first = pix[0];
    if (first?.some((t) => t.some((p) => p))) {
      const same = (f: Uint8Array, k: number, t: Uint8Array) => k >= 0 && (k + 1) * 64 <= f.length && t.every((p, i) => f[k * 64 + i] === p);
      const n = sizes[+objs[0].big] >> 3;
      for (let num = 0; num < GFX_FILES && !gfx; num++) {
        const e = gfxEntry(emu.rom, num);
        if (!e || !read.has(snesToPc(e.addr))) continue;
        const f = readGfx(emu.rom, num);
        for (let k = 0; k < f.tiles && !gfx; k++) {
          if (first.every((t, j) => same(f.pix, k + Math.floor(j / n) * 16 + (j % n), t))) gfx = { file: num, tile: k };
        }
      }
    }
    return { objs, time: logoTime(emu, screen), colours, gfx };
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}

// The time: a byte of RAM the game set from a ROM byte before the logo shows, and reads and writes while it shows –
// and the logo shows as many frames longer as that ROM byte is made larger.
function logoTime(emu: LevelEmulator, screen: ReachedScreen): PresentsValue | null {
  const s = emu.snes, w = s.wram, d = emu.rom.data;
  if (screen.mode !== GM.presents) return null;
  const setFrom = new Map<number, number>(), read = new Set<number>(), written = new Set<number>();
  const showing = () => w[RAM.gameMode] === screen.mode;
  let frames = 0;
  replayScreen(emu, screen, {
    onWramWrite: (a, v) => {
      if (showing()) { written.add(a); return; }
      const o = s.writeSource;
      if (o >= 0 && d[o] === v) setFrom.set(a, o); else setFrom.delete(a);
    },
    onWramRead: (a) => { if (showing()) read.add(a); },
  }, { sources: true, frames: RUN_FRAMES, each: () => { if (showing()) frames++; else if (frames) return false; } });
  const tried = new Set<number>();
  for (const [a, o] of setFrom) {
    if (!read.has(a) || !written.has(a) || tried.has(o)) continue;
    tried.add(o);
    const v = d[o], other = v > TIME_STEP ? v - TIME_STEP : v + TIME_STEP;
    let n: number;
    d[o] = other;
    try { n = shownFrames(emu, screen); } finally { d[o] = v; }
    if (n - frames === other - v) return { value: v, at: o };
  }
  return null;
}

// What the logo is made of, kept per emulator and screen while the ROM bytes the game read for it are as they were.
const kept = new WeakMap<LevelEmulator, { gen: number; reads: RomReads; screen: ReachedScreen; logo: PresentsLogo }>();
export function presentsLogo(emu: LevelEmulator, screen: ReachedScreen): PresentsLogo {
  const had = kept.get(emu);
  if (had && had.screen === screen && holds(emu.rom, had)) return had.logo;
  const r = emu.record('title screen', () => learnPresents(emu, screen));
  kept.set(emu, { gen: r.gen, reads: r.reads, screen, logo: r.result });
  return r.result;
}

// A field written: the byte the game reads it from (a colour: its two bytes).
export function writePresentsValue(rom: Rom, v: PresentsValue, value: number, bytes: 1 | 2 = 1): void {
  if (v.at < 0) throw new Error('The game does not read this from the ROM');
  if (value < 0 || value >= 1 << (bytes * 8)) throw new Error(`Not a value of ${bytes} byte${bytes > 1 ? 's' : ''}`);
  rom.writeAt(v.at, bytes === 1 ? Uint8Array.from([value]) : Uint8Array.from([value & 0xff, value >> 8]));
}

// the fields several OBJ read from one ROM byte counted once: each with the OBJ (their numbers from 1) that show it
export function sharedFields(objs: LogoObj[], of: (o: LogoObj) => PresentsValue): { field: PresentsValue; objs: number[] }[] {
  const out: { field: PresentsValue; objs: number[] }[] = [];
  objs.forEach((o, k) => {
    const f = of(o), had = f.at >= 0 ? out.find((x) => x.field.at === f.at) : undefined;
    if (had) had.objs.push(k + 1); else out.push({ field: f, objs: [k + 1] });
  });
  return out;
}
