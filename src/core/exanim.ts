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

import { snesToPc, type Rom } from './rom.ts';
import { applyPatch, uninstallPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { EXANIMATION_ASM, MEMORY_ASM } from './kobo/exanimation.ts';
import { installEditorPatch } from './patches.ts';

export const EXANIM_PATCH_NAME = 'ExAnimation (Lunar Magic format)';
const EXANIM_PATCH_NAME_OLD = 'ExAnimation (Lunar-Magic-Format)'; // name in ROMs patched before the UI was English
const LOAD_HOOK = 0x0583ad;
const NMI_HOOK = 0x00a390;
const TABLE_OFFSET = 0xea;
const GLOBAL_BANK = 0x5b;
const GLOBAL_LOW = 0x65;
export const SETTINGS = 0x03fe00;
export const ALT_FILES = 0x03bcc0;
export const ALT_FILE_MAX = 0x8000;
export const SLOTS = 0x20;

// settings bits (set = off)
export const NO_GAME_COLORS = 0x80, NO_GAME_TILES = 0x40, NO_LEVEL_LIST = 0x20, NO_GLOBAL_LIST = 0x10;

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
// whether a trigger has a second set of frames (shown while its condition holds)
export function secondSet(trigger: number): boolean {
  return (trigger >= 1 && trigger <= 5) || trigger === 7 || (trigger >= 9 && trigger <= 0x0e) || (trigger >= 0x20 && trigger <= 0x2f);
}
export function frameWords(type: number, trigger: number, framesLess1: number): number {
  if (kindOf(type) === 'rotation') return 0;
  return (framesLess1 + 1) * (secondSet(trigger) ? 2 : 1);
}

export const TYPE_NAMES: Record<number, string> = {
  0x01: '1 tile', 0x02: '2 tiles side by side', 0x03: '3 tiles', 0x04: '4 tiles side by side', 0x05: '5 tiles', 0x06: '6 tiles', 0x07: '7 tiles', 0x08: '8 tiles',
  0x09: '12 tiles', 0x0a: '16 tiles', 0x0b: '20 tiles', 0x0c: '24 tiles', 0x0d: '28 tiles', 0x0e: '32 tiles', 0x0f: '1 tile (2bpp, layer 3)',
  0x10: '2 tiles stacked (8×16)', 0x11: '16×16 (2×2 tiles)', 0x12: '32×16 (4×2 tiles)',
  0x13: 'Colors (CGRAM only)', 0x14: 'Colors (palette, fades along)', 0x15: 'Colors (until level end)', 0x16: 'Background color', 0x17: 'Background color (until level end)',
  0x18: 'Rotate colors right', 0x19: 'Rotate colors right (reversible)', 0x1a: 'Rotate colors left', 0x1b: 'Rotate colors left (reversible)',
};

export function triggerName(t: number): string {
  const fixed: Record<number, string> = {
    0x00: 'Always', 0x01: 'Blue P-switch', 0x02: 'Silver P-switch', 0x03: 'ON/OFF switch', 0x04: 'Star', 0x05: 'Time below 100',
    0x06: 'Star (one-time)', 0x07: '5 Dragon Coins', 0x08: '5 Dragon Coins (one-time)', 0x0f: 'Precision timer',
  };
  if (fixed[t] !== undefined) return fixed[t];
  if (t >= 0x09 && t <= 0x0e) return `Reserved ${t.toString(16).toUpperCase()}`;
  if (t >= 0x10 && t <= 0x1f) return `Manual ${(t - 0x10).toString(16).toUpperCase()}`;
  if (t >= 0x20 && t <= 0x2f) return `Custom ${(t - 0x20).toString(16).toUpperCase()}`;
  if (t >= 0x30 && t <= 0x4f) return `One-Shot ${(t - 0x30).toString(16).toUpperCase().padStart(2, '0')}`;
  return `$${t.toString(16)}`;
}
// what the second frame set means
export function secondSetName(t: number): string {
  return ({ 1: 'P-switch active', 2: 'P-switch active', 3: 'Switch OFF', 4: 'Star active', 5: 'Time below 100', 7: '5 Dragon Coins collected' } as Record<number, string>)[t] ?? 'Trigger on';
}

// the 8x8 tiles (4bpp: VRAM word address / 16) a tile slot writes; types 10-12 write two rows, the
// second $100 words below (tile_bytes in the engine). Colors and rotations: none.
export function slotTiles(e: ExSlot): number[] {
  if (kindOf(e.type) !== 'tiles' || e.type === 0x0f) return [];
  const first = (e.dest & 0x7fff) >> 4;
  const row = e.type === 0x10 ? 1 : e.type === 0x11 ? 2 : e.type === 0x12 ? 4 : tilesOf(e.type);
  const out = Array.from({ length: row }, (_, i) => first + i);
  if (e.type >= 0x10) out.push(...out.map((t) => t + 0x10));
  return out;
}
// a tile slot with frames past AN2 ($7EAD00-$7EB8FF, patches.ts): the BG tilemap is there
export const framesPastAn2 = (e: ExSlot) => kindOf(e.type) === 'tiles' && !(e.dest & 0x8000) && e.frames.some((f) => f >= 0xb900 && f < 0xc100);
// a slot whose frames come from the list's alternative file (ExGFX 60-63, shared by all levels)
export const usesAltFile = (e: ExSlot) => kindOf(e.type) === 'tiles' ? (e.dest & 0x8000) !== 0 : kindOf(e.type) === 'colors' && e.type < 0x16 && ((e.dest >> 8) & 0x80) !== 0;

// ---- list bytes ----
export function parseList(b: Uint8Array): { list: ExList; length: number } {
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
    const n = frameWords(type, trigger, framesLess1);
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

export function exanimLayout(rom: Rom): ExLayout | null {
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
  return applyPatch(rom, { name: EXANIM_PATCH_NAME, main: 'exanimation.asm', files: new Map([['exanimation.asm', EXANIMATION_ASM], ['memory.asm', MEMORY_ASM]]), ram: [[0x7fc003, 0xfd]] });
}

export function uninstallExAnim(rom: Rom): string[] {
  const e = listPatches(rom).find((p) => p.name === EXANIM_PATCH_NAME || p.name === EXANIM_PATCH_NAME_OLD);
  return e ? uninstallPatch(rom, e.id) : [];
}

const listAt = (rom: Rom, addr: number): ExList | null => {
  try { return parseList(rom.bytes(addr, Math.min(0x8000 - (addr & 0x7fff), 0x4000))).list; } catch { return null; }
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
export function globalListAddr(rom: Rom): number {
  const l = exanimLayout(rom);
  if (!l) return 0;
  const bank = rom.r16(l.target + GLOBAL_BANK);
  return bank ? (bank << 8) | rom.r16(l.target + GLOBAL_LOW) : 0;
}
export function readGlobalList(rom: Rom): ExList | null {
  const a = globalListAddr(rom);
  return a ? listAt(rom, a) : null;
}

// frees a list unless another level (or the global list) still points at it
function freeList(rom: Rom, addr: number, level: number | null): void {
  if (!addr) return;
  const l = exanimLayout(rom)!;
  for (let i = 0; i < 512; i++) if (i !== level && rom.r24(l.table + i * 3) === addr) return;
  if (level !== null && globalListAddr(rom) === addr) return;
  rom.freeAt(addr);
}

const hasContent = (l: ExList | null) => !!l && (l.slots.size > 0 || l.manual.size > 0 || l.customSet !== 0 || l.customKeep !== 0xffff);

// writes a level's list (null or empty: none); installs the engine if needed
export function writeLevelList(rom: Rom, level: number, list: ExList | null): void {
  if (!exanimInstalled(rom)) {
    if (!hasContent(list)) return;
    const r = installExAnim(rom);
    if (!r.ok) throw new Error(r.errors.join(' '));
  }
  const l = exanimLayout(rom)!;
  const old = levelListAddr(rom, level);
  freeList(rom, old, level);
  const p = hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0x0000ff;
  rom.w24(l.table + level * 3, p);
}

export function writeGlobalList(rom: Rom, list: ExList | null): void {
  if (!exanimInstalled(rom)) {
    if (!hasContent(list)) return;
    const r = installExAnim(rom);
    if (!r.ok) throw new Error(r.errors.join(' '));
  }
  const l = exanimLayout(rom)!;
  freeList(rom, globalListAddr(rom), null);
  const p = hasContent(list) ? rom.allocWrite(listBytes(list!)) : 0;
  rom.w16(l.target + GLOBAL_BANK, p ? p >> 8 : 0);
  rom.w16(l.target + GLOBAL_LOW, p & 0xffff);
}

export function levelSettings(rom: Rom, level: number): number {
  return exanimInstalled(rom) ? rom.r8(SETTINGS + level) : 0;
}
export function setLevelSettings(rom: Rom, level: number, v: number): void {
  if (!exanimInstalled(rom)) {
    const r = installExAnim(rom);
    if (!r.ok) throw new Error(r.errors.join(' '));
  }
  rom.w8(SETTINGS + level, v & 0xf0);
}

// ---- alternative files ExGFX 60-63 ----
export function altFileAddr(rom: Rom, n: number): number {
  if (!exanimInstalled(rom)) return 0;
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
  if (data && data.length > ALT_FILE_MAX) throw new Error('Animation graphics too large (max. 32 KB)');
  if (!exanimInstalled(rom)) {
    if (!data) return;
    const r = installExAnim(rom);
    if (!r.ok) throw new Error(r.errors.join(' '));
  }
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
  const lists = new Set<number>();
  for (let i = 0; i < 512; i++) { const a = levelListAddr(rom, i); if (a) lists.add(a); }
  const g = globalListAddr(rom);
  if (g) lists.add(g);
  for (const a of lists) {
    try { add(a, parseList(rom.bytes(a, Math.min(0x8000 - (a & 0x7fff), 0x4000))).length); } catch { /* not a list */ }
  }
  for (let n = 0; n < 4; n++) {
    const a = altFileAddr(rom, n);
    const size = a ? rom.isRatsAt(snesToPc(a) - 8) : 0;
    if (size > 0) add(a, size);
  }
  return out;
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
