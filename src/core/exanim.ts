// ExAnimation in Lunar Magic's layout (format: smwspeedruns' "Level Data Format", Kobo's notes):
// animated tiles and colors per level and globally, run by the engine in kobo/exanimation.ts (or Lunar
// Magic's own, which keeps the same tables). Lunar Magic edits ROMs with either.
//
//  - the JSL at $0583AD leads to the engine's block T: at T+$EA the address of 512 3-byte pointers to
//    the levels' lists ($0000FF: none), at T+$5B the global list's bank times $100 (0: none), at T+$65
//    its low word
//  - $03FE00: a settings byte per level, PTLG---- (game's color flashing, game's tile animation, level
//    list, global list; each off when set)
//  - $03BCC0: 3-byte pointers to the "alternative files" ExGFX 60-63 (uncompressed 4bpp, RATS blocks)
//  - a list: slots used, alternative file (0-3), custom triggers kept / set at the load (16 bits each),
//    manual triggers set (16 bits) and their frames, then a 16-bit offset per slot (from the first
//    offset, 0 = unused); an entry: type, trigger, frames less one, 16-bit destination, 16-bit frames
//  - the overworld (Lunar Magic's overworld ExAnimation, help ov_overworld_ex20*.htm): the JSL at $048086 leads to
//    the engine's overworld block O: at O+$4A the address of a settings byte per submap, at O+$57 the overworld's
//    global list's address >> 8 (0: none) and at O+$61 its low word, at O+$E1 the address of 7 3-byte pointers to
//    the submaps' lists ($0000FF: none) – read from Lunar Magic's code in ROMs it saved
//    (docs/research/lunar-magic-submap-graphics.md). Its lists are a level's, but for triggers 01-08: Lunar Magic's
//    "Event Manual 8-F", holding while the event whose number manual frame 8-F has is passed, each with a second set.

import { snesToPc, type Rom } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches, hashBytes, type RamClaim } from './patchreg.ts';
import { CDM16_FLAGS } from './ram.ts';
import { EXANIMATION_ASM, MEMORY_ASM } from './kobo/exanimation.ts';
import { installEditorPatch } from './patches.ts';

export const EXANIM_PATCH_NAME = 'ExAnimation (Lunar Magic format)';
const LOAD_HOOK = 0x0583ad;
const NMI_HOOK = 0x00a390;
const TABLE_OFFSET = 0xea;
const GLOBAL_BANK = 0x5b;
const GLOBAL_LOW = 0x65;
export const SETTINGS = 0x03fe00;
export const ALT_FILES = 0x03bcc0;
export const ALT_FILE_MAX = 0x7fe0; // 1023 tiles: a RATS block within one bank
export const SLOTS = 0x20;

// settings bits (set = off)
export const NO_GAME_COLORS = 0x80, NO_GAME_TILES = 0x40, NO_LEVEL_LIST = 0x20, NO_GLOBAL_LIST = 0x10;
// a submap's settings bits (set = off): the game's tiles, its own list (NO_LEVEL_LIST) and the overworld's global
// list as a level's, and the level dots' colors 6D and 7D (Lunar Magic's), the lightning, color 47 (the editor's own
// bit: Lunar Magic's code reads none)
export const NO_DOT_COLORS = 0x80, NO_LIGHTNING = 0x08;

export interface ExSlot {
  type: number; // 01-1B
  trigger: number; // 00-4F
  framesLess1: number;
  // tiles: VRAM word address, bit 15 = sources in the alternative file; colors: first color, high byte
  // colors less one (bit 15 = alternative file)
  dest: number;
  frames: number[]; // twice as many with a second set, none for rotations
}

export interface ExList {
  count: number; // slots it says it uses
  altFile: number; // 0-3 = ExGFX 60-63
  customKeep: number;
  customSet: number;
  manual: Map<number, number>; // manual trigger -> frame set at the load
  slots: Map<number, ExSlot>;
}

export function emptyList(): ExList {
  return { count: 0, altFile: 0, customKeep: 0xffff, customSet: 0, manual: new Map(), slots: new Map() };
}

// ---- types and triggers ----
export type SlotKind = 'tiles' | 'colors' | 'rotation';
export function kindOf(type: number): SlotKind | null {
  if (type >= 0x01 && type <= 0x12) return 'tiles';
  if (type >= 0x13 && type <= 0x17) return 'colors';
  if (type >= 0x18 && type <= 0x1b) return 'rotation';
  return null;
}
// tiles (8x8, 32 bytes each) a tile type uploads; 0F: one 2bpp tile
export function tilesOf(type: number): number {
  if (type >= 1 && type <= 8) return type;
  if (type >= 9 && type <= 0x0e) return [12, 16, 20, 24, 28, 32][type - 9];
  if (type === 0x10) return 2;
  if (type === 0x11) return 4;
  if (type === 0x12) return 8;
  return 1;
}
// tile shape of a type: columns, rows (rows are $100 VRAM words = 16 tiles apart)
export function shapeOf(type: number): { w: number; h: number } {
  if (type === 0x10) return { w: 1, h: 2 };
  if (type === 0x11) return { w: 2, h: 2 };
  if (type === 0x12) return { w: 4, h: 2 };
  return { w: tilesOf(type), h: 1 };
}
// VRAM tiles (numbers from the layer character base charWord) the tile slots of a level's list and
// the global one overwrite, with the slots that do it
export function exanimTiles(rom: Rom, level: number, charWord: number): Map<number, { global: boolean; slot: number }[]> {
  const out = new Map<number, { global: boolean; slot: number }[]>();
  const lists: [boolean, ExList | null][] = [[false, readLevelList(rom, level)], [true, readGlobalList(rom)]];
  for (const [global, l] of lists) {
    if (!l) continue;
    for (const [slot, sl] of l.slots) {
      if (kindOf(sl.type) !== 'tiles') continue;
      const t0 = ((sl.dest & 0x7fff) - charWord) >> 4, shape = shapeOf(sl.type);
      for (let y = 0; y < shape.h; y++) for (let x = 0; x < shape.w; x++) {
        const t = t0 + y * 16 + x;
        if (t < 0 || t >= 0x400) continue;
        let a = out.get(t);
        if (!a) out.set(t, a = []);
        a.push({ global, slot });
      }
    }
  }
  return out;
}
// colors (CGRAM index) the color and rotation slots of a level's list and the global one rewrite,
// with the slots that do it: the first color and the colors less one (bit 7: the alternative file),
// the back area color (types 16, 17) is color 0
export function exanimColors(rom: Rom, level: number): Map<number, { global: boolean; slot: number }[]> {
  const out = new Map<number, { global: boolean; slot: number }[]>();
  const lists: [boolean, ExList | null][] = [[false, readLevelList(rom, level)], [true, readGlobalList(rom)]];
  for (const [global, l] of lists) {
    if (!l) continue;
    for (const [slot, sl] of l.slots) {
      const kind = kindOf(sl.type);
      if (kind !== 'colors' && kind !== 'rotation') continue;
      const back = sl.type === 0x16 || sl.type === 0x17;
      const first = back ? 0 : sl.dest & 0xff, n = back ? 1 : ((sl.dest >> 8) & 0x7f) + 1;
      for (let c = first; c < Math.min(256, first + n); c++) {
        let a = out.get(c);
        if (!a) out.set(c, a = []);
        a.push({ global, slot });
      }
    }
  }
  return out;
}
// whether a trigger has a second set of frames (shown while its condition holds); ow: in an overworld list, where
// 06 and 08 are event triggers as 01-05 and 07
export function secondSet(trigger: number, ow = false): boolean {
  return (trigger >= 1 && trigger <= 5) || trigger === 7 || (trigger >= 9 && trigger <= 0x0e) || (trigger >= 0x20 && trigger <= 0x2f) || (ow && (trigger === 6 || trigger === 8));
}
export function frameWords(type: number, trigger: number, framesLess1: number, ow = false): number {
  if (kindOf(type) === 'rotation') return 0;
  return (framesLess1 + 1) * (secondSet(trigger, ow) ? 2 : 1);
}
// an overworld event trigger (01-08: Lunar Magic's "Event Manual 8-F") and the manual frame holding its event
export const isEventTrigger = (t: number) => t >= 1 && t <= 8;
export const eventManual = (t: number) => t + 7;

export const TYPE_NAMES: Record<number, string> = {
  0x01: '1 tile', 0x02: '2 tiles side by side', 0x03: '3 tiles', 0x04: '4 tiles side by side', 0x05: '5 tiles', 0x06: '6 tiles', 0x07: '7 tiles', 0x08: '8 tiles',
  0x09: '12 tiles', 0x0a: '16 tiles', 0x0b: '20 tiles', 0x0c: '24 tiles', 0x0d: '28 tiles', 0x0e: '32 tiles', 0x0f: '1 tile (2bpp, layer 3)',
  0x10: '2 tiles stacked (8×16)', 0x11: '16×16 (2×2 tiles)', 0x12: '32×16 (4×2 tiles)',
  0x13: 'Colors (CGRAM only)', 0x14: 'Colors (palette, fades along)', 0x15: 'Colors (until level end)', 0x16: 'Background color', 0x17: 'Background color (until level end)',
  0x18: 'Rotate colors right', 0x19: 'Rotate colors right, reverse on trigger', 0x1a: 'Rotate colors left', 0x1b: 'Rotate colors left, reverse on trigger',
};

export function triggerName(t: number, ow = false): string {
  if (ow && isEventTrigger(t)) return `Event Manual ${eventManual(t).toString(16).toUpperCase()}`;
  const fixed: Record<number, string> = {
    0x00: 'Always', 0x01: 'Blue P-switch', 0x02: 'Silver P-switch', 0x03: 'ON/OFF switch', 0x04: 'Star', 0x05: 'Time below 100',
    0x06: 'Time below 100 (one shot)', 0x07: '5 Dragon Coins', 0x08: '5 Dragon Coins (one shot)', 0x0f: 'Precision timer',
  };
  if (fixed[t] !== undefined) return fixed[t];
  if (t >= 0x09 && t <= 0x0e) return `Reserved ${t.toString(16).toUpperCase()}`;
  if (t >= 0x10 && t <= 0x1f) return `Manual ${(t - 0x10).toString(16).toUpperCase()}`;
  if (t >= 0x20 && t <= 0x2f) return `Custom ${(t - 0x20).toString(16).toUpperCase()}`;
  if (t >= 0x30 && t <= 0x4f) return `One-Shot ${(t - 0x30).toString(16).toUpperCase().padStart(2, '0')}`;
  return `$${t.toString(16)}`;
}
// what the second frame set means
export function secondSetName(t: number, ow = false): string {
  if (ow && isEventTrigger(t)) return `the event of Manual ${eventManual(t).toString(16).toUpperCase()} passed`;
  return ({ 1: 'P-switch active', 2: 'P-switch active', 3: 'Switch OFF', 4: 'Star active', 5: 'Time below 100', 7: '5 Dragon Coins collected' } as Record<number, string>)[t] ?? `${triggerName(t)} on`;
}

// ---- color rotations (types 18-1B, LM help: level_ex20.htm) ----
// The colors first .. first + count - 1 (2-0x80), the destination's low byte and the colors less one;
// a step every delay (frames less one + 1) runs of the slot, which runs every 8 game frames.
export const ROTATION_MAX = 0x80;
export function rotationRange(e: ExSlot): { first: number; count: number } {
  return { first: e.dest & 0xff, count: ((e.dest >> 8) & 0x7f) + 1 };
}
export function setRotationRange(e: ExSlot, first: number, count: number): void {
  e.dest = (first & 0xff) | ((Math.max(2, Math.min(ROTATION_MAX, count)) - 1) << 8);
}
export const reversesOnTrigger = (type: number) => type === 0x19 || type === 0x1b;
export const stepsPerSecond = (delay: number) => 60 / 8 / delay;
// the way a rotation turns while its trigger holds or not, null while it waits: right (18, 19) or left
// (1A, 1B); 18 and 1A run only while their trigger holds (always without one or with the precision
// timer, 0F), 19 and 1B turn the other way while it holds (the engine's rotation)
export function rotationStep(type: number, trigger: number, holds: boolean): 'right' | 'left' | null {
  const right = type < 0x1a, none = trigger === 0 || trigger === 0x0f;
  if (!reversesOnTrigger(type)) return none || holds ? (right ? 'right' : 'left') : null;
  return right !== (holds && !none) ? 'right' : 'left';
}
// colors after `steps` steps: right moves each to the next one, the last to the first
export function rotated<T>(colors: T[], dir: 'right' | 'left', steps: number): T[] {
  const n = colors.length;
  if (!n) return [];
  const k = ((dir === 'right' ? -steps : steps) % n + n) % n;
  return colors.map((_, i) => colors[(i + k) % n]);
}

// the colors of a rotation's range that never change in CGRAM images taken every 8 game frames while
// it runs `dir` with `delay`, though the rotation would have brought other colors there: the game
// sets them itself, so they do not turn there
export function heldColors(cgrams: Uint8Array[], first: number, count: number, dir: 'right' | 'left', delay: number): number[] {
  const word = (cg: Uint8Array, c: number) => cg[c * 2] | (cg[c * 2 + 1] << 8);
  const n = Math.min(count, 256 - first), out: number[] = [];
  if (!cgrams.length) return [];
  const start = Array.from({ length: n }, (_, i) => word(cgrams[0], first + i));
  const expect = cgrams.map((_, k) => rotated(start, dir, Math.floor(k / delay)));
  for (let i = 0; i < n; i++) {
    const held = cgrams.every((cg) => word(cg, first + i) === start[i]);
    if (held && expect.some((e) => e[i] !== start[i])) out.push(first + i);
  }
  return out;
}

// 8-frame steps after which the slots of the lists show the same again, a multiple of `base` (at most
// `max`); a rotation waiting for its trigger counts as running
export function exanimPeriod(lists: (ExList | null)[], max = 64, base = 1): number {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  let p = base;
  for (const l of lists) for (const e of l?.slots.values() ?? []) {
    const n = kindOf(e.type) === 'rotation' ? rotationRange(e).count * (e.framesLess1 + 1) : e.framesLess1 + 1;
    p = p / gcd(p, n) * n;
    if (p >= max) return max;
  }
  return p;
}

// the 8x8 tiles (4bpp: VRAM word address / 16) a tile slot writes; types 10-12 write two rows, the
// second $100 words below (tile_bytes in the engine). Colors and rotations: none.
// the colors a color slot writes (destination's high byte: the colors less one)
export const slotColors = (e: ExSlot) => ((e.dest >> 8) & 0x7f) + 1;
// the bytes a list at `addr` may take: the rest of its bank, at most 16 KB
export const listMaxLength = (addr: number) => Math.min(0x8000 - (addr & 0x7fff), 0x4000);

export function slotTiles(e: ExSlot): number[] {
  if (kindOf(e.type) !== 'tiles' || e.type === 0x0f) return [];
  const first = (e.dest & 0x7fff) >> 4;
  const row = e.type === 0x10 ? 1 : e.type === 0x11 ? 2 : e.type === 0x12 ? 4 : tilesOf(e.type);
  const out = Array.from({ length: row }, (_, i) => first + i);
  if (e.type >= 0x10) out.push(...out.map((t) => t + 0x10));
  return out;
}
// a slot whose frames come from the list's alternative file (ExGFX 60-63, shared by all levels)
export const usesAltFile = (e: ExSlot) => kindOf(e.type) === 'tiles' ? (e.dest & 0x8000) !== 0 : kindOf(e.type) === 'colors' && e.type < 0x16 && ((e.dest >> 8) & 0x80) !== 0;

// ---- list bytes ----
// (ow: an overworld list, its triggers 06 and 08 with a second set)
export function parseList(b: Uint8Array, ow = false): { list: ExList; length: number } {
  const get = (i: number) => { if (i >= b.length) throw new Error('ExAnimation list truncated'); return b[i]; };
  const word = (i: number) => get(i) | (get(i + 1) << 8);
  const count = get(0);
  if (count > SLOTS) throw new Error('ExAnimation list: too many slots');
  const list: ExList = { count, altFile: get(1), customKeep: word(2), customSet: word(4), manual: new Map(), slots: new Map() };
  const mask = word(6);
  let at = 8;
  for (let t = 0; t < 16; t++) if (mask & (1 << t)) list.manual.set(t, get(at++));
  const base = at;
  let end = base + 2 * count;
  for (let s = 0; s < count; s++) {
    const off = word(base + 2 * s);
    if (!off) continue;
    const p = base + off;
    const type = get(p), trigger = get(p + 1), framesLess1 = get(p + 2), dest = word(p + 3);
    if (!kindOf(type)) throw new Error(`ExAnimation list: unknown type ${type.toString(16)} in slot ${s.toString(16)}`);
    const n = frameWords(type, trigger, framesLess1, ow);
    const frames = Array.from({ length: n }, (_, i) => word(p + 5 + 2 * i));
    end = Math.max(end, p + 5 + 2 * n);
    list.slots.set(s, { type, trigger, framesLess1, dest, frames });
  }
  return { list, length: end };
}

export function slotsUsed(l: ExList): number {
  return Math.max(l.count, ...[...l.slots.keys()].map((s) => s + 1), 0);
}

export function listBytes(l: ExList): Uint8Array {
  const count = slotsUsed(l);
  const out: number[] = [count, l.altFile, l.customKeep & 0xff, l.customKeep >> 8, l.customSet & 0xff, l.customSet >> 8];
  const keys = [...l.manual.keys()].sort((a, b) => a - b);
  const mask = keys.reduce((m, t) => m | (1 << t), 0);
  out.push(mask & 0xff, mask >> 8, ...keys.map((k) => l.manual.get(k)!));
  const offsets: number[] = [], body: number[] = [];
  for (let s = 0; s < count; s++) {
    const e = l.slots.get(s);
    if (!e) { offsets.push(0, 0); continue; }
    const o = 2 * count + body.length;
    offsets.push(o & 0xff, o >> 8);
    body.push(e.type, e.trigger, e.framesLess1, e.dest & 0xff, (e.dest >> 8) & 0xff);
    for (const f of e.frames) body.push(f & 0xff, (f >> 8) & 0xff);
  }
  return Uint8Array.from([...out, ...offsets, ...body]);
}

// ---- tables in the ROM ----
export interface ExLayout { target: number; table: number }
// (also a ROM read otherwise than from its image: Lunar Magic's in a BPS, globalanim.ts)
export type RomRead = Pick<Rom, 'r8' | 'r16' | 'r24'>;

export function exanimLayout(rom: RomRead): ExLayout | null {
  if (rom.r8(LOAD_HOOK) !== 0x22) return null;
  const target = rom.r24(LOAD_HOOK + 1);
  const table = rom.r24(target + TABLE_OFFSET);
  if (((table >> 8) & 0xff) === 0) return null; // older layout (Lunar Magic 1.6x/2.41): not supported
  return { target, table };
}

// Lunar Magic keeps an engine whose NMI hook is a JSL
export function exanimInstalled(rom: Rom): boolean {
  return rom.r8(NMI_HOOK) === 0x22 && exanimLayout(rom) !== null;
}

export function installExAnim(rom: Rom): ApplyResult {
  if (exanimInstalled(rom)) return { ok: true, errors: [], warnings: [], prints: [] };
  if (rom.r8(LOAD_HOOK) === 0x22 || rom.r8(NMI_HOOK) === 0x22) {
    return { ok: false, errors: ['The ROM already has an ExAnimation in an older Lunar Magic format (or another patch at $0583AD/$00A390) – not supported.'], warnings: [], prints: [] };
  }
  installEditorPatch(rom); // keeps the level number in $010B, which the engine reads (as Lunar Magic's does)
  // the RAM of Lunar Magic's block at $7FC000 the engine uses, around the conditional Direct Map16 flags (shared:
  // the editor patch reads them, community code sets them; cdm16.ts)
  const [cf, cn] = CDM16_FLAGS;
  const ram: RamClaim[] = [[0x7fc003, cf - 0x7fc003], [cf, cn, 1], [cf + cn, 0x7fc100 - cf - cn]];
  return applyPatch(rom, { name: EXANIM_PATCH_NAME, main: 'exanimation.asm', files: new Map([['exanimation.asm', EXANIMATION_ASM], ['memory.asm', MEMORY_ASM]]), kind: 'exanim', ram });
}

// the registry entry of the engine
export function exanimEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'exanim') ?? null;
}


const listAt = (rom: Rom, addr: number, ow = false): ExList | null => {
  try { return parseList(rom.bytes(addr, listMaxLength(addr)), ow).list; } catch { return null; }
};

export function levelListAddr(rom: Rom, level: number): number {
  const l = exanimLayout(rom);
  if (!l) return 0;
  const p = rom.r24(l.table + level * 3);
  return ((p >> 8) & 0xff) === 0 || (p & 0xffff) === 0xffff ? 0 : p;
}
export function readLevelList(rom: Rom, level: number): ExList | null {
  const a = levelListAddr(rom, level);
  return a ? listAt(rom, a) : null;
}
export function globalListAddr(rom: RomRead): number {
  const l = exanimLayout(rom);
  if (!l) return 0;
  const bank = rom.r16(l.target + GLOBAL_BANK);
  return bank ? (bank << 8) | rom.r16(l.target + GLOBAL_LOW) : 0;
}
export function readGlobalList(rom: Rom): ExList | null {
  const a = globalListAddr(rom);
  return a ? listAt(rom, a) : null;
}

// frees list `self`'s at `addr` unless another list (a level's, a submap's, a global one) still points at it
function freeList(rom: Rom, addr: number, self: ExListRef): void {
  if (!addr) return;
  if (listRefs(rom).some((r) => !sameRef(r, self) && listAddr(rom, r) === addr)) return;
  rom.freeAt(addr);
}

const hasContent = (l: ExList | null) => !!l && (l.slots.size > 0 || l.manual.size > 0 || l.customSet !== 0 || l.customKeep !== 0xffff);

// writes a level's list (null or empty: none)
export function writeLevelList(rom: Rom, level: number, list: ExList | null): void {
  const l = exanimLayout(rom)!;
  const old = levelListAddr(rom, level);
  freeList(rom, old, { kind: 'level', n: level });
  const p = hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0x0000ff;
  rom.w24(l.table + level * 3, p);
}

export function writeGlobalList(rom: Rom, list: ExList | null): void {
  const l = exanimLayout(rom)!;
  freeList(rom, globalListAddr(rom), { kind: 'global' });
  const p = hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0;
  rom.w16(l.target + GLOBAL_BANK, p ? p >> 8 : 0);
  rom.w16(l.target + GLOBAL_LOW, p & 0xffff);
}

export function levelSettings(rom: Rom, level: number): number {
  return rom.r8(SETTINGS + level);
}
export function setLevelSettings(rom: Rom, level: number, v: number): void {
  rom.w8(SETTINGS + level, v & 0xf0);
}

// ---- the overworld's lists ----
const OW_HOOK = 0x048086;
const OW_SETTINGS_AT = 0x4a, OW_GLOBAL_HIGH = 0x57, OW_GLOBAL_LOW = 0x61, OW_TABLE_AT = 0xe1;
export const SUBMAP_LISTS = 7;
export interface OwExLayout { target: number; settings: number; table: number }
export function owExanimLayout(rom: RomRead): OwExLayout | null {
  if (rom.r8(OW_HOOK) !== 0x22) return null;
  const target = rom.r24(OW_HOOK + 1);
  return { target, settings: rom.r24(target + OW_SETTINGS_AT), table: rom.r24(target + OW_TABLE_AT) };
}
export function submapListAddr(rom: Rom, submap: number): number {
  const l = owExanimLayout(rom);
  if (!l) return 0;
  const p = rom.r24(l.table + submap * 3);
  return ((p >> 8) & 0xff) === 0 || (p & 0xffff) === 0xffff ? 0 : p;
}
export function readSubmapList(rom: Rom, submap: number): ExList | null {
  const a = submapListAddr(rom, submap);
  return a ? listAt(rom, a, true) : null;
}
export function writeSubmapList(rom: Rom, submap: number, list: ExList | null): void {
  const l = owExanimLayout(rom)!;
  freeList(rom, submapListAddr(rom, submap), { kind: 'submap', n: submap });
  rom.w24(l.table + submap * 3, hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0x0000ff);
}
export function owGlobalListAddr(rom: RomRead): number {
  const l = owExanimLayout(rom);
  if (!l) return 0;
  const high = rom.r16(l.target + OW_GLOBAL_HIGH);
  return high ? (high << 8) | rom.r16(l.target + OW_GLOBAL_LOW) : 0;
}
export function readOwGlobalList(rom: Rom): ExList | null {
  const a = owGlobalListAddr(rom);
  return a ? listAt(rom, a, true) : null;
}
export function writeOwGlobalList(rom: Rom, list: ExList | null): void {
  const l = owExanimLayout(rom)!;
  freeList(rom, owGlobalListAddr(rom), { kind: 'owGlobal' });
  const p = hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0;
  rom.w16(l.target + OW_GLOBAL_HIGH, p ? p >> 8 : 0);
  rom.w16(l.target + OW_GLOBAL_LOW, p & 0xffff);
}
export function submapAnimSettings(rom: Rom, submap: number): number {
  return rom.r8(owExanimLayout(rom)!.settings + submap);
}
export function setSubmapAnimSettings(rom: Rom, submap: number, v: number): void {
  rom.w8(owExanimLayout(rom)!.settings + submap, v & 0xf8);
}

// ---- every list by one name ----
// a level's list, the levels' global one, a submap's, the overworld's global one
export type ExListRef = { kind: 'level'; n: number } | { kind: 'global' } | { kind: 'submap'; n: number } | { kind: 'owGlobal' };
export const isOwList = (r: ExListRef) => r.kind === 'submap' || r.kind === 'owGlobal';
const sameRef = (a: ExListRef, b: ExListRef) => a.kind === b.kind && ('n' in a ? a.n === (b as { n: number }).n : true);
// every list there is a place for
export function listRefs(rom: Rom): ExListRef[] {
  const out: ExListRef[] = [...Array.from({ length: 512 }, (_, n): ExListRef => ({ kind: 'level', n })), { kind: 'global' }];
  if (owExanimLayout(rom)) out.push(...Array.from({ length: SUBMAP_LISTS }, (_, n): ExListRef => ({ kind: 'submap', n })), { kind: 'owGlobal' });
  return out;
}
export function listAddr(rom: Rom, r: ExListRef): number {
  switch (r.kind) {
    case 'level': return levelListAddr(rom, r.n);
    case 'global': return globalListAddr(rom);
    case 'submap': return submapListAddr(rom, r.n);
    case 'owGlobal': return owGlobalListAddr(rom);
  }
}
export function readList(rom: Rom, r: ExListRef): ExList | null {
  const a = listAddr(rom, r);
  return a ? listAt(rom, a, isOwList(r)) : null;
}
export function writeList(rom: Rom, r: ExListRef, list: ExList | null): void {
  switch (r.kind) {
    case 'level': writeLevelList(rom, r.n, list); break;
    case 'global': writeGlobalList(rom, list); break;
    case 'submap': writeSubmapList(rom, r.n, list); break;
    case 'owGlobal': writeOwGlobalList(rom, list); break;
  }
}

// ---- alternative files ExGFX 60-63 ----
export function altFileAddr(rom: Rom, n: number): number {
  const p = rom.r24(ALT_FILES + n * 3);
  return p === 0 || p === 0xffffff ? 0 : p;
}
export function readAltFile(rom: Rom, n: number): Uint8Array | null {
  const a = altFileAddr(rom, n);
  if (!a) return null;
  const size = rom.isRatsAt(snesToPc(a) - 8);
  return size > 0 ? rom.bytes(a, size) : null;
}
export function writeAltFile(rom: Rom, n: number, data: Uint8Array | null): void {
  if (data && data.length > ALT_FILE_MAX) throw new Error('Animation graphics too large (max. 1023 tiles)');
  const old = altFileAddr(rom, n);
  if (old && data && rom.isRatsAt(snesToPc(old) - 8) === data.length) { rom.writeBytes(old, data); return; } // same size: in place
  if (old) rom.freeAt(old);
  rom.w24(ALT_FILES + n * 3, data ? rom.allocWrite(data) : 0);
}


// [start, end) ROM offsets of the data the engine reads (pointer table, settings, lists, alternative
// files): it only reaches VRAM and CGRAM, so emulated results don't depend on it (see gfxpages.ts)
export function exanimDataRanges(rom: Rom): [number, number][] {
  const l = exanimLayout(rom);
  if (!l || rom.r8(NMI_HOOK) !== 0x22) return [];
  const out: [number, number][] = [];
  const add = (snes: number, len: number) => {
    const o = snesToPc(snes);
    if (o >= 0 && o < rom.data.length) out.push([o, Math.min(rom.data.length, o + len)]);
  };
  add(l.table, 512 * 3);
  add(SETTINGS, 0x200);
  add(ALT_FILES, 4 * 3);
  const ow = owExanimLayout(rom);
  if (ow) { add(ow.table, SUBMAP_LISTS * 3); add(ow.settings, SUBMAP_LISTS); }
  const lists = new Map<number, boolean>();
  for (const r of listRefs(rom)) { const a = listAddr(rom, r); if (a) lists.set(a, isOwList(r)); }
  for (const [a, owList] of lists) {
    try { add(a, parseList(rom.bytes(a, listMaxLength(a)), owList).length); } catch { /* not a list */ }
  }
  for (let n = 0; n < 4; n++) {
    const a = altFileAddr(rom, n);
    const size = a ? rom.isRatsAt(snesToPc(a) - 8) : 0;
    if (size > 0) add(a, size);
  }
  return out;
}

// [start, end) ROM offsets of the overworld's ExAnimation data: its tables and lists (also in exanimDataRanges), which
// overworld results that are no picture leave out (overworld.ts overworldDataRanges)
export function owExanimDataRanges(rom: Rom): [number, number][] {
  const ow = owExanimLayout(rom);
  if (!ow) return [];
  const out: [number, number][] = [];
  const add = (snes: number, len: number) => { const o = snesToPc(snes); if (o >= 0 && o < rom.data.length) out.push([o, Math.min(rom.data.length, o + len)]); };
  add(ow.table, SUBMAP_LISTS * 3);
  add(ow.settings, SUBMAP_LISTS);
  for (const a of new Set([...Array.from({ length: SUBMAP_LISTS }, (_, i) => submapListAddr(rom, i)), owGlobalListAddr(rom)])) {
    if (!a) continue;
    try { add(a, parseList(rom.bytes(a, listMaxLength(a)), true).length); } catch { /* not a list */ }
  }
  return out;
}

// a hash of what a level's animations copy at its load from the ExAnimation data, whose bytes an emulated
// result reads without recording them (exanimDataRanges): the level's settings and, per list in effect (the
// level's, the global one), its slots and the parts of its Anim graphic their frames read – every frame, which
// one shows at the load depends on the triggers. Frames from RAM aren't in it: the game's graphics there
// (GFX33, loaded by its own pointer, not the file table) are read as recorded. Anim graphics no list in effect
// reads aren't in it either.
export function levelAnimHash(rom: Rom, level: number): number {
  if (!exanimInstalled(rom)) return 0;
  const settings = levelSettings(rom, level), parts: Uint8Array[] = [Uint8Array.of(settings)];
  for (const l of [settings & NO_LEVEL_LIST ? null : readLevelList(rom, level), settings & NO_GLOBAL_LIST ? null : readGlobalList(rom)]) {
    parts.push(Uint8Array.of(l ? 1 : 0));
    if (!l) continue;
    parts.push(listBytes(l));
    const alt = readAltFile(rom, l.altFile);
    if (!alt) continue;
    for (const e of l.slots.values()) {
      if (!usesAltFile(e)) continue;
      const len = altFrameBytes(e);
      for (const f of e.frames) parts.push(alt.subarray(f, f + len));
    }
  }
  return hashBytes(parts);
}

// adds slots to a level's list, in its free slots (its own slots stay); returns the slot numbers used
export function addLevelSlots(rom: Rom, level: number, slots: ExSlot[]): number[] {
  if (!slots.length) return [];
  const list = readLevelList(rom, level) ?? emptyList();
  const used: number[] = [];
  for (const e of slots) {
    let k = 0;
    while (k < SLOTS && list.slots.has(k)) k++;
    if (k >= SLOTS) throw new Error(`No free ExAnimation slot left in level ${level.toString(16).toUpperCase().padStart(3, '0')}`);
    list.slots.set(k, { ...e, frames: [...e.frames] });
    used.push(k);
  }
  list.count = slotsUsed(list);
  writeLevelList(rom, level, list);
  return used;
}

// adds slots to the global list, in its free slots (its own slots stay); per slot the number used, null
// when no slot was free
export function addGlobalSlots(rom: Rom, slots: ExSlot[]): (number | null)[] {
  if (!slots.length) return [];
  const list = readGlobalList(rom) ?? emptyList();
  const used = slots.map((e) => {
    let k = 0;
    while (k < SLOTS && list.slots.has(k)) k++;
    if (k >= SLOTS) return null;
    list.slots.set(k, { ...e, frames: [...e.frames] });
    return k;
  });
  list.count = slotsUsed(list);
  writeGlobalList(rom, list);
  return used;
}

// ---- frames from elsewhere into an alternative file ----
// Lunar Magic's AN2: a level's 4 KB ExGFX file in RAM from $7EAD00, where a slot's RAM frames point
export const AN2_FRAMES = 0xad00, AN2_FRAMES_END = 0xbd00;
export const altFileName = (n: number) => `Anim graphic ${'ABCD'[n]}`;
const frameBytes = (type: number) => type === 0x0f ? 16 : tilesOf(type) * 32;
// the bytes a frame of a slot reading its Anim graphic takes there (one color: none, the frame is the color itself)
const altFrameBytes = (e: ExSlot) => kindOf(e.type) === 'tiles' ? frameBytes(e.type) : slotColors(e) === 1 ? 0 : slotColors(e) * 2;
const tileSlotFromAn2 = (e: ExSlot) => kindOf(e.type) === 'tiles' && !(e.dest & 0x8000) && e.frames.some((f) => f >= AN2_FRAMES && f < AN2_FRAMES_END);

// the alternative file a level's tile slots take their frames from (its list's; 0 without one)
export function levelAltFile(rom: Rom, level: number): number {
  return readLevelList(rom, level)?.altFile ?? 0;
}

// the lists whose tile slots take frames from alternative file `n`: levels, the global list, submaps, the overworld's
// global list
export function altFileUsers(rom: Rom, n: number): { levels: number[]; global: boolean; submaps: number[]; owGlobal: boolean } {
  const uses = (l: ExList | null) => !!l && l.altFile === n && [...l.slots.values()].some((e) => kindOf(e.type) === 'tiles' && (e.dest & 0x8000) !== 0);
  const levels: number[] = [], submaps: number[] = [];
  for (let i = 0; i < 512; i++) if (uses(readLevelList(rom, i))) levels.push(i);
  for (let i = 0; i < SUBMAP_LISTS; i++) if (uses(readSubmapList(rom, i))) submaps.push(i);
  return { levels, global: uses(readGlobalList(rom)), submaps, owGlobal: uses(readOwGlobalList(rom)) };
}

// the end of what the slots of all lists (levels and the global one, or `global` in its place, the submaps and the
// overworld's global one) read from Anim graphic `n`
export function altFileExtent(rom: Rom, n: number, global: ExList | null = readGlobalList(rom)): number {
  let end = 0;
  const lists = [...Array.from({ length: 512 }, (_, i) => readLevelList(rom, i)), global,
    ...Array.from({ length: SUBMAP_LISTS }, (_, i) => readSubmapList(rom, i)), readOwGlobalList(rom)];
  for (const l of lists) {
    if (!l || l.altFile !== n) continue;
    for (const e of l.slots.values()) {
      if (!usesAltFile(e) || !e.frames.length) continue;
      const len = altFrameBytes(e);
      if (len) end = Math.max(end, Math.max(...e.frames) + len);
    }
  }
  return end;
}

// slots of another list (a level file's, or one reading AN2) taking their frames from alternative file
// `file`: the frames they use from AN2 (`src.an2`) or from their own alternative file (`src.alt`; also a
// color slot's, the part of the file its frames read kept together) are
// copied into it (a frame already there is used again) and the slots point there. A slot's other RAM
// frames (the game's graphics, e.g. GFX33 from $7E7D00) come along from `src.ram`, the level's WRAM
// after its load; slots without AN2 frames keep reading RAM unless `allRam`. Without `alt` the slots'
// alternative file is `file` already and they stay. Per slot the new one, or null where its frames are
// missing or do not fit (with a note).
export function localizeFrames(rom: Rom, slots: ExSlot[], src: { an2?: Uint8Array | null; alt?: Uint8Array | null; ram?: Uint8Array | null }, file: number, allRam = false): { slots: (ExSlot | null)[]; notes: string[] } {
  const foreign = 'alt' in src;
  let data = readAltFile(rom, file) ?? new Uint8Array(0);
  const start = data;
  const out: (ExSlot | null)[] = [], notes: string[] = [];
  const place = (b: Uint8Array): number => {
    for (let o = 0; o + b.length <= data.length; o += Math.min(b.length, 32)) if (b.every((v, i) => data[o + i] === v)) return o;
    const o = data.length, grown = new Uint8Array(o + ((b.length + 31) & ~31));
    grown.set(data); grown.set(b, o);
    data = grown;
    return o;
  };
  for (const e of slots) {
    out.push(null);
    const tiles = kindOf(e.type) === 'tiles';
    const fromAlt = foreign && usesAltFile(e), fromAn2 = tileSlotFromAn2(e) || (allRam && tiles && !(e.dest & 0x8000));
    if (!fromAlt && !fromAn2) { out[out.length - 1] = { ...e, frames: [...e.frames] }; continue; }
    if (fromAlt && !tiles) {
      // colors: the part of the file the frames read, kept together (one color is the frame itself)
      const n = slotColors(e);
      if (n === 1) { out[out.length - 1] = { ...e, frames: [...e.frames] }; continue; }
      const lo = Math.min(...e.frames), hi = Math.max(...e.frames) + n * 2;
      if (!src.alt || hi > src.alt.length) { notes.push('An ExAnimation slot takes colors from an alternative file (ExGFX 60-63) that is missing – left out'); continue; }
      const before = data;
      const at = place(src.alt.subarray(lo, hi));
      if (data.length > ALT_FILE_MAX) { data = before; notes.push(`${altFileName(file)} is full (1023 tiles) – an ExAnimation slot left out`); continue; }
      out[out.length - 1] = { ...e, frames: e.frames.map((f) => at + f - lo) };
      continue;
    }
    const len = frameBytes(e.type);
    // the bytes of a frame, null when its source is missing
    const bytes = (f: number): Uint8Array | null => {
      const [from, at] = fromAlt ? [src.alt, f] : f >= AN2_FRAMES && f < AN2_FRAMES_END ? [src.an2, f - AN2_FRAMES] : [src.ram, f];
      return from && at + len <= from.length ? from.subarray(at, at + len) : null;
    };
    const got = e.frames.map(bytes);
    if (got.some((b) => !b)) {
      const what = fromAlt ? 'an alternative file (ExGFX 60-63)' : e.frames.every((f) => f >= AN2_FRAMES && f < AN2_FRAMES_END) || !src.an2 ? 'AN2' : 'RAM';
      notes.push(`An ExAnimation slot takes frames from ${what} that ${what === 'RAM' ? 'is not known here' : 'is missing'} – left out`);
      continue;
    }
    const before = data;
    const frames = got.map((b) => place(b!));
    if (data.length > ALT_FILE_MAX) { data = before; notes.push(`${altFileName(file)} is full (1023 tiles) – an ExAnimation slot left out`); continue; }
    out[out.length - 1] = { ...e, dest: e.dest | 0x8000, frames };
  }
  if (data !== start) writeAltFile(rom, file, data);
  return { slots: out, notes };
}
