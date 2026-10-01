// GFX file data in the ROM. The graphics only reach VRAM, so results found out by emulation (block
// behaviour, object kinds) don't depend on them: reads of these bytes aren't recorded (see
// LevelEmulator.skipMask) and drawing in a GFX file keeps the results. Sprite images do depend on
// the sprite graphics: their key holds a hash of the sprite files instead.

import { snesToPc, type Rom } from './rom.ts';
import { gfxEntry, hasEditorPatch, VANILLA_GFX } from './patches.ts';
import { lz2Decompress } from './lz2.ts';

// [start, end) ROM offsets of a file's data
function fileRange(rom: Rom, i: number): [number, number] | null {
  const e = gfxEntry(rom, i);
  if (!e) return null;
  const pc = snesToPc(e.addr);
  if (pc >= rom.data.length) return null;
  try { return [pc, Math.min(rom.data.length, pc + (e.raw ? 0x1000 : lz2Decompress(rom.data, pc).size))]; } catch { return null; }
}

// 1 for every byte of GFX file data
export function gfxSkipMask(rom: Rom): Uint8Array {
  const mask = new Uint8Array(rom.data.length);
  const n = hasEditorPatch(rom) ? 0x100 : VANILLA_GFX;
  for (let i = 0; i < n; i++) {
    const r = fileRange(rom, i);
    if (r) mask.fill(1, r[0], r[1]);
  }
  return mask;
}

// content hash of some GFX files (0xFF = none)
export function gfxFilesHash(rom: Rom, files: number[]): number {
  let h = 0x811c9dc5;
  for (const f of files) {
    h = Math.imul(h ^ f, 0x01000193);
    const r = f === 0xff ? null : fileRange(rom, f);
    if (!r) continue;
    for (let o = r[0]; o < r[1]; o++) h = Math.imul(h ^ rom.data[o], 0x01000193);
  }
  return h >>> 0;
}
