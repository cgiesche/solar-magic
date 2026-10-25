// The shared palettes: the game's palette block $00:B0A0–$00:B881 (back area colors, BG/FG/sprite
// palettes of the level header, layer 3, Mario, global colors), shared by every level without an own
// palette. Lunar Magic exports it as a raw copy (shared_palettes.pal); a package bringing one changes
// only the colors differing from the clean game's. Those are known from the editor's copy of the clean
// game's block ("SMWC"), taken when it opens the clean game, as this ROM's colors may have been edited.

import { Rom, pcToSnes } from './rom.ts';
import { hex } from './names.ts';

export const SHARED_PALETTES = 0x00b0a0;
export const SHARED_PAL_SIZE = 0x7e2; // up to $00:B881
export const SHARED_COLORS = SHARED_PAL_SIZE / 2;

// the tables of the block
export const BACK_AREA = 0x00b0a0;
export const BG_PALS = 0x00b0b0;
export const FG_PALS = 0x00b190;
export const SPR_PALS = 0x00b318;
export const PAL_SIZE = 0x18; // 12 colors: two rows of 6 (colors 2-7)

export type TableKind = 'back' | 'bg' | 'fg' | 'spr' | 'l3' | 'mario' | 'global';
export interface TableOrigin { kind: TableKind; num: number }

// the table a color at SNES address `addr` belongs to (global: none of the others)
export function tableOf(addr: number): TableOrigin {
  const inTable = (base: number, n: number, size: number) => addr >= base && addr < base + n * size;
  if (inTable(BACK_AREA, 8, 2)) return { kind: 'back', num: (addr - BACK_AREA) >> 1 };
  if (inTable(BG_PALS, 8, PAL_SIZE)) return { kind: 'bg', num: Math.floor((addr - BG_PALS) / PAL_SIZE) };
  if (addr >= 0x00b170 && addr < 0x00b190) return { kind: 'l3', num: 0 };
  if (inTable(FG_PALS, 8, PAL_SIZE)) return { kind: 'fg', num: Math.floor((addr - FG_PALS) / PAL_SIZE) };
  if (addr >= 0x00b2c8 && addr < SPR_PALS) return { kind: 'mario', num: 0 };
  if (inTable(SPR_PALS, 8, PAL_SIZE)) return { kind: 'spr', num: Math.floor((addr - SPR_PALS) / PAL_SIZE) };
  return { kind: 'global', num: 0 };
}

export function tableName(o: TableOrigin): string {
  switch (o.kind) {
    case 'back': return `Back area color ${o.num}`;
    case 'bg': return `BG palette ${o.num}`;
    case 'fg': return `FG palette ${o.num}`;
    case 'spr': return `Sprite palette ${o.num}`;
    case 'l3': return 'Layer 3 / status bar';
    case 'mario': return 'Mario';
    case 'global': return 'Global';
  }
}

// the palette rows (CGRAM) the header's palettes are loaded into, colors 2-7 of two rows
const FIRST_ROW: Partial<Record<TableKind, number>> = { bg: 0x0, fg: 0x2, spr: 0xe };
const BASE: Partial<Record<TableKind, number>> = { bg: BG_PALS, fg: FG_PALS, spr: SPR_PALS };

// shared colors (indices into the block) by their tables: "BG palette 0: colors 14–16" (the colors they
// are in a level using that palette), others by their address ("Global: $B250, $B254")
export function sharedColorNames(colors: number[]): string[] {
  const groups = new Map<string, string[]>();
  let run: { key: string; first: number; last: number; at: number } | null = null;
  const flush = () => {
    if (!run) return;
    const g = groups.get(run.key) ?? [];
    g.push(run.first === run.last ? hex(run.first, 2) : `${hex(run.first, 2)}–${hex(run.last, 2)}`);
    groups.set(run.key, g);
    run = null;
  };
  for (const i of [...colors].sort((a, b) => a - b)) {
    const addr = SHARED_PALETTES + i * 2;
    const o = tableOf(addr);
    if (o.kind === 'back') { flush(); groups.set(tableName(o), []); continue; }
    const base = BASE[o.kind];
    if (base === undefined) {
      flush();
      const k = tableName(o);
      groups.set(k, [...groups.get(k) ?? [], `$${hex(addr & 0xffff, 4)}`]);
      continue;
    }
    const w = (addr - base - o.num * PAL_SIZE) >> 1;
    const cg = (FIRST_ROW[o.kind]! + Math.floor(w / 6)) * 16 + 2 + (w % 6);
    const key = tableName(o);
    if (run && run.key === key && run.last === cg - 1 && run.at === i - 1) { run.last = cg; run.at = i; continue; }
    flush();
    run = { key, first: cg, last: cg, at: i };
  }
  flush();
  return [...groups].map(([k, v]) => {
    if (!v.length) return k;
    if (v[0].startsWith('$')) return `${k}: ${v.join(', ')}`;
    const many = v.length > 1 || v[0].includes('–');
    return `${k}: color${many ? 's' : ''} ${v.join(', ')}`;
  });
}

// ---------- the colors ----------

const wordAt = (d: Uint8Array, i: number) => d[i * 2] | (d[i * 2 + 1] << 8);

// a Lunar Magic shared palettes file: a raw copy of the block
export const isSharedPalettes = (data: Uint8Array) => data.length === SHARED_PAL_SIZE;

export function sharedColor(rom: Rom, i: number): number {
  return rom.r16(SHARED_PALETTES + i * 2);
}
export function setSharedColor(rom: Rom, i: number, c: number): void {
  rom.w16(SHARED_PALETTES + i * 2, c);
}
export function sharedColors(rom: Rom): number[] {
  return Array.from({ length: SHARED_COLORS }, (_, i) => sharedColor(rom, i));
}

// ---------- the clean game's ----------

const MAGIC = [0x53, 0x4d, 0x57, 0x43]; // "SMWC"
const VERSION = 1;

function find(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size === SHARED_PAL_SIZE + 5 && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

// keeps the clean game's colors (run when the clean game is opened, before anything changes them)
export function keepCleanSharedPalettes(rom: Rom): void {
  const old = find(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  const buf = new Uint8Array(SHARED_PAL_SIZE + 5);
  buf.set(MAGIC); buf[4] = VERSION; buf.set(rom.bytes(SHARED_PALETTES, SHARED_PAL_SIZE), 5);
  rom.allocWrite(buf);
}

// the clean game's colors, null when the ROM has no copy (the clean game itself)
export function cleanSharedPalettes(rom: Rom): Uint16Array | null {
  const p = find(rom);
  if (p < 0) return null;
  if (rom.data[p + 4] > VERSION) throw new Error('The clean game\'s palettes in the ROM are from a newer editor version');
  const d = rom.data.subarray(p + 5, p + 5 + SHARED_PAL_SIZE);
  return Uint16Array.from({ length: SHARED_COLORS }, (_, i) => wordAt(d, i));
}

// the colors of a shared palettes file differing from the clean game's (index → color); null when the
// clean game's are not known
export function changedColors(rom: Rom, data: Uint8Array): Map<number, number> | null {
  const clean = cleanSharedPalettes(rom);
  if (!clean) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < SHARED_COLORS; i++) {
    const c = wordAt(data, i);
    if (c !== clean[i]) out.set(i, c);
  }
  return out;
}
