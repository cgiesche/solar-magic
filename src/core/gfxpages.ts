// GFX file data in the ROM. The graphics only reach VRAM, so results found out by emulation (block
// behaviour, object kinds) don't depend on them: reads of these bytes aren't recorded (see
// LevelEmulator.skipMask) and drawing in a GFX file keeps the results. Sprite images do depend on
// the sprite graphics: their key holds a hash of the sprite files instead.
// The same for the ExAnimation data (pointer table, settings, lists, alternative files): editing an
// animation keeps the block probes (whose test level may be the level being animated).

import { snesToPc, type Rom } from './rom.ts';
import { gfxEntry } from './patches.ts';
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
    for (let i = 0; i < 0x100; i++) {
      const r = fileRange(rom, i);
      if (r) mask.fill(1, r[0], r[1]);
    }
    for (const [a, b] of exanimDataRanges(rom)) mask.fill(1, a, b);
    mask.fill(1, 0x7fdc, 0x7fe0); // checksum: rewritten whenever the ROM is stored, some sprites read it as a table
    return mask;
  } finally { rom.reads = reads; }
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
