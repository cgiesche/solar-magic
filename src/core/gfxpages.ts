// GFX file data in the ROM. The graphics only reach VRAM, so results found out by emulation (block
// behaviour, object kinds) don't depend on them: reads of these bytes aren't recorded (see
// LevelEmulator.skipMask) and drawing in a GFX file keeps the results. Sprite images do depend on
// the sprite graphics: their key holds a hash of the sprite files instead.
// The same for the ExAnimation data (pointer table, settings, lists, alternative files): editing an
// animation keeps the block probes (whose test level may be the level being animated).
// For what blocks do (block probes, probehost.ts) also the Map16 tiles' 8x8 tile words and the colors: they only
// reach VRAM and CGRAM as well, so drawing a tile or changing a palette keeps them (displaySkipMask). Not for the
// editor's other results: object thumbnails show them.

import { snesToPc, type Rom } from './rom.ts';
import { gfxEntry, GFX_FILES, GFX_NONE, customPalettePatch, PALETTE_SIZE } from './patches.ts';
import { map16Ext, EXT_FIRST, EXT_TILES } from './map16ext.ts';
import { bgMap16Ext, bgTileAddr, BG_EXT_FIRST, BG_EXT_TILES } from './bgmap16.ts';
import { SHARED_PALETTES, SHARED_PAL_SIZE } from './sharedpal.ts';
import { lz2Decompress } from './lz2.ts';
import { exanimDataRanges } from './exanim.ts';

// [start, end) ROM offsets of a file's data
function fileRange(rom: Rom, i: number): [number, number] | null {
  const e = gfxEntry(rom, i);
  if (!e) return null;
  const pc = snesToPc(e.addr);
  if (pc >= rom.data.length) return null;
  try { return [pc, Math.min(rom.data.length, pc + (e.raw ? e.size : lz2Decompress(rom.data, pc).size))]; } catch { return null; }
}

// 1 for every byte of GFX file data and ExAnimation data (and the checksum). Often built lazily inside a tracked computation: reading the
// pointer tables here isn't a dependency of its result (else a new ExGFX file would drop them all)
export function gfxSkipMask(rom: Rom): Uint8Array {
  const reads = rom.reads;
  rom.reads = null;
  try {
    const mask = new Uint8Array(rom.data.length);
    for (let i = 0; i < GFX_FILES; i++) {
      const r = fileRange(rom, i);
      if (r) mask.fill(1, r[0], r[1]);
    }
    for (const [a, b] of exanimDataRanges(rom)) mask.fill(1, a, b);
    mask.fill(1, 0x7fdc, 0x7fe0); // checksum: rewritten whenever the ROM is stored, some sprites read it as a table
    return mask;
  } finally { rom.reads = reads; }
}

const LEVELS = 0x200;

// gfxSkipMask and every byte that only says what blocks look like: the quarters (8x8 tile words) of the FG Map16 tiles (ptrs:
// the pointers of tiles 000-1FF per tileset, tilesetPointers; the extended tiles' table) and the BG Map16 tiles, the
// shared palettes and the levels' own palettes (their pointers too: a level without one only takes the shared
// colors). Built like gfxSkipMask: its reads aren't a dependency.
export function displaySkipMask(rom: Rom, ptrs: number[][]): Uint8Array {
  const mask = gfxSkipMask(rom);
  const reads = rom.reads;
  rom.reads = null;
  try {
    const fill = (snes: number, len: number) => { const o = snesToPc(snes); if (o < mask.length) mask.fill(1, o, Math.min(o + len, mask.length)); };
    for (const ps of ptrs) for (const p of ps) if (p >= 0x8000) fill(0x0d0000 | p, 8);
    const fg = map16Ext(rom);
    if (fg) fill(fg.gfx, (EXT_TILES - EXT_FIRST) * 8);
    fill(bgTileAddr(rom, 0)!, BG_EXT_FIRST * 8);
    const bg = bgMap16Ext(rom);
    if (bg) fill(bg.gfx, (BG_EXT_TILES - BG_EXT_FIRST) * 8);
    fill(SHARED_PALETTES, SHARED_PAL_SIZE);
    const pal = customPalettePatch(rom);
    if (pal) {
      fill(pal.table, LEVELS * 3);
      for (let l = 0; l < LEVELS; l++) { const a = rom.r24(pal.table + l * 3); if (a) fill(a, PALETTE_SIZE); }
    }
    return mask;
  } finally { rom.reads = reads; }
}

// content hash of some GFX files (0FF = none)
export function gfxFilesHash(rom: Rom, files: number[]): number {
  let h = 0x811c9dc5;
  for (const f of files) {
    h = Math.imul(h ^ f, 0x01000193);
    const r = f === GFX_NONE ? null : fileRange(rom, f);
    if (!r) continue;
    for (let o = r[0]; o < r[1]; o++) h = Math.imul(h ^ rom.data[o], 0x01000193);
  }
  return h >>> 0;
}
