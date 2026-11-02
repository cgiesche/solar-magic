// GFX file data in the ROM. The graphics only reach VRAM, so results found out by emulation (block
// behaviour, object kinds) don't depend on them: reads of these bytes aren't recorded (see
// LevelEmulator.skipMask) and drawing in a GFX file keeps the results. Nor are reads of the files' pointer
// entries: they only lead to the data (an LZ2 file that grows when drawn in is moved to free space, which
// changes its entry). Sprite images do depend on the sprite graphics: their key holds a hash of the sprite
// files' content instead.
// The same for the ExAnimation data (pointer table, settings, lists, alternative files): editing an
// animation keeps the block probes (whose test level may be the level being animated).
// For what blocks do (block probes, probehost.ts) and the editor's other results that are no pictures (learner.ts)
// also the display data (the Map16 quarters and the colors): they only reach VRAM and CGRAM as well, so drawing a
// tile or changing a palette keeps them (gfxDisplaySkipMask). Not for pictures (CONTEXT.md): they show them.
// Where the level's colors are loaded from (the palette tab) leaves out the GFX file data and the colors' values
// (gfxFileColorValueSkipMask): changing a color keeps it.

import { snesToPc, type Rom } from './rom.ts';
import { editorPatch, gfxEntry, GFX_FILES, GFX_NONE, customPalettePatch, PALETTE_SIZE } from './patches.ts';
import { map16Ext, EXT_FIRST, EXT_TILES } from './map16ext.ts';
import { bgMap16Ext, bgTileAddr, BG_EXT_FIRST, BG_EXT_TILES } from './bgmap16.ts';
import { SHARED_PALETTES, SHARED_PAL_SIZE } from './sharedpal.ts';
import { lz2Decompress } from './lz2.ts';
import { exanimDataRanges } from './exanim.ts';
import { submapPaletteRanges } from './submapgfx.ts';
import { unrecorded } from './romdeps.ts';

// [start, end) ROM offsets of a file's data
export function gfxFileRange(rom: Rom, i: number): [number, number] | null {
  const e = gfxEntry(rom, i);
  if (!e) return null;
  const pc = snesToPc(e.addr);
  if (pc >= rom.data.length) return null;
  try { return [pc, Math.min(rom.data.length, pc + (e.raw ? e.size : lz2Decompress(rom.data, pc).size))]; } catch { return null; }
}

// 1 for every byte of GFX file data and the files' pointer entries (and the checksum). Its reads aren't a dependency
// (see gfxSkipMask).
function gfxFileMask(rom: Rom): Uint8Array {
  return unrecorded(rom, () => {
    const mask = new Uint8Array(rom.data.length);
    for (let i = 0; i < GFX_FILES; i++) {
      const r = gfxFileRange(rom, i);
      if (r) mask.fill(1, r[0], r[1]);
    }
    const p = editorPatch(rom);
    if (p) for (const t of [p.gfxLo, p.gfxHi, p.gfxBank, p.gfxFlags]) { const o = snesToPc(t); mask.fill(1, o, o + GFX_FILES); }
    mask.fill(1, 0x7fdc, 0x7fe0); // checksum: rewritten whenever the ROM is stored, some sprites read it as a table
    return mask;
  });
}

// marks the ExAnimation data in a mask. Its reads aren't a dependency (see gfxSkipMask).
function addExanim(rom: Rom, mask: Uint8Array): Uint8Array {
  return unrecorded(rom, () => {
    for (const [a, b] of exanimDataRanges(rom)) mask.fill(1, a, b);
    return mask;
  });
}

// 1 for every byte of GFX file data, the files' pointer entries and ExAnimation data (and the checksum). Often built lazily
// inside a tracked computation: reading the pointer tables here isn't a dependency of its result (else a new ExGFX file
// would drop them all)
export function gfxSkipMask(rom: Rom): Uint8Array {
  return addExanim(rom, gfxFileMask(rom));
}

const LEVELS = 0x200;

// fills the bytes at a SNES address into a mask
function fillSnes(mask: Uint8Array, snes: number, len: number): void {
  const o = snesToPc(snes);
  if (o < mask.length) mask.fill(1, o, Math.min(o + len, mask.length));
}

// The GFX file data with its pointer entries (and the checksum) and the colors' values: the shared palettes, the
// levels' own palettes and the submaps' (submapgfx.ts) – not the own palettes' pointers, they say where a level's colors come from (see ColorSources),
// nor the ExAnimation data, a color animation writes colors too. Built like gfxSkipMask: its reads aren't a dependency.
export function gfxFileColorValueSkipMask(rom: Rom): Uint8Array {
  const mask = gfxFileMask(rom);
  return unrecorded(rom, () => {
    fillSnes(mask, SHARED_PALETTES, SHARED_PAL_SIZE);
    const pal = customPalettePatch(rom);
    if (pal) for (let l = 0; l < LEVELS; l++) { const a = rom.r24(pal.table + l * 3); if (a) fillSnes(mask, a, PALETTE_SIZE); }
    for (const [a, b] of submapPaletteRanges(rom)) mask.fill(1, a, Math.min(b, mask.length));
    return mask;
  });
}

// gfxSkipMask's bytes and the display data: the colors' values (gfxFileColorValueSkipMask), the quarters of the FG
// Map16 tiles (ptrs: the pointers of tiles 000-1FF per tileset, tilesetPointers; the extended tiles' table) and the
// BG Map16 tiles, and the levels' own palettes' pointers too (a level without one only takes the shared colors).
// Built like gfxSkipMask: its reads aren't a dependency.
export function gfxDisplaySkipMask(rom: Rom, ptrs: number[][]): Uint8Array {
  const mask = addExanim(rom, gfxFileColorValueSkipMask(rom));
  return unrecorded(rom, () => {
    const fill = (snes: number, len: number) => fillSnes(mask, snes, len);
    for (const ps of ptrs) for (const p of ps) if (p >= 0x8000) fill(0x0d0000 | p, 8);
    const fg = map16Ext(rom);
    if (fg) fill(fg.gfx, (EXT_TILES - EXT_FIRST) * 8);
    fill(bgTileAddr(rom, 0)!, BG_EXT_FIRST * 8);
    const bg = bgMap16Ext(rom);
    if (bg) fill(bg.gfx, (BG_EXT_TILES - BG_EXT_FIRST) * 8);
    const pal = customPalettePatch(rom);
    if (pal) fill(pal.table, LEVELS * 3);
    return mask;
  });
}

// content hash of some GFX files (0FF = none): their data and their flags entry (how the data is stored), not
// their place
export function gfxFilesHash(rom: Rom, files: number[]): number {
  const p = editorPatch(rom)!; // (gfxFileRange needs it too)
  let h = 0x811c9dc5;
  for (const f of files) {
    h = Math.imul(h ^ f, 0x01000193);
    const r = f === GFX_NONE ? null : gfxFileRange(rom, f);
    if (!r) continue;
    h = Math.imul(h ^ rom.r8(p.gfxFlags + f), 0x01000193);
    for (let o = r[0]; o < r[1]; o++) h = Math.imul(h ^ rom.data[o], 0x01000193);
  }
  return h >>> 0;
}
