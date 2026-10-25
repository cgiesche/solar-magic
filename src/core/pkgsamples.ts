// A package's sample levels (see CONTEXT.md: Sample level): which of its Lunar Magic level files (.mwl)
// are offered, and as which level. One alone is the sample level for the current level. Of several, each
// is offered as the level of its own number (the one it was exported from), except those belonging to
// what is not part of the package:
// - the title screen's level: the level the game loads for its title screen (found by booting it);
// - a level the package's overworld moved there: the package's overworld (Lunar Magic data, a BPS from
//   the clean game) has a level tile enter it where the same tile of this ROM's overworld enters another
//   level (the Romhack Races baserom's Yoshi's Island 1, moved from 105 to 112 for its info level).
// Placed at its own number, a sample level also takes its graphics slots from its level file.

import type { Rom } from './rom.ts';
import { mwlSections } from './mwl.ts';
import type { MwlLevel } from './bgpack.ts';
import { titleScreenLevel } from './levelemu.ts';
import { levelTileLevels } from './overworld.ts';
import { cleanGameBps, cleanGameBytes, known } from './cleangame.ts';
import { levelSlots } from './gfxslots.ts';
import { gfxEntry } from './patches.ts';

// level: the level it is offered as (null: the current one); left: why it is not offered (null: it is)
export interface PlannedSample { file: string; level: number | null; left: string | null }

const hx = (v: number, d = 3) => v.toString(16).toUpperCase().padStart(d, '0');
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function planSamples(rom: Rom, files: Map<string, Uint8Array>, mwls: string[]): PlannedSample[] {
  if (mwls.length <= 1) return mwls.map((file) => ({ file, level: null, left: null }));
  const title = titleScreenLevel(rom);
  const moved = movedLevels(rom, files);
  const taken = new Set<number>();
  return mwls.map((file): PlannedSample => {
    let level: number;
    try { level = mwlSections(files.get(file)!).number; } catch (e) { return { file, level: null, left: `${base(file)}: ${e instanceof Error ? e.message : e}` }; }
    const m = moved.get(level);
    const left = level === title ? `Level ${hx(level)} is the title screen's – not part of the package.`
      : m ? `Level ${hx(level)} is the overworld's: ${base(m.bps)} has the level tile entering level ${hx(m.from)} here enter it – the overworld is not part of the package.`
      : taken.has(level) ? `Level ${hx(level)}: another level file of the package is for it.`
      : null;
    if (!left) taken.add(level);
    return { file, level, left };
  });
}

// level → the level this ROM's overworld enters from the tile where a BPS of the upload (the package's
// overworld) enters it instead, and that BPS
function movedLevels(rom: Rom, files: Map<string, Uint8Array>): Map<number, { from: number; bps: string }> {
  const out = new Map<number, { from: number; bps: string }>();
  let here: Map<number, number> | null;
  try { here = levelTileLevels(rom); } catch { here = null; }
  if (!here) return out;
  const clean = cleanGameBytes(rom) ?? (() => null);
  for (const [file, d] of files) {
    if (!/\.bps$/i.test(file)) continue;
    const target = cleanGameBps(d, clean);
    if (!target) continue;
    let theirs: Map<number, number> | null | 'not known';
    try { theirs = known(() => levelTileLevels(target)); } catch { theirs = null; } // (no overworld of its own)
    if (!theirs || theirs === 'not known') continue;
    for (const [tile, level] of theirs) {
      const from = here.get(tile);
      if (from !== undefined && from !== level && !out.has(level)) out.set(level, { from, bps: file });
    }
  }
  return out;
}

// the graphics slots of a sample level at its own number (level `level`, its header's tileset and sprite
// set): the level file's (Lunar Magic's GFX bypass, its layer 3 bypass), the package's ExGFX by the number
// it got (`gfx`), another file by its number when this ROM has it; the default where the file has none
// (7F) or one that neither has (a note)
export function sampleSlots(rom: Rom, level: number, header: { tileset: number; spriteGfx: number }, mwl: MwlLevel,
  gfx: { lmNum: number | null; num: number }[], notes: string[]): { slot: string; num: number }[] {
  const out: { slot: string; num: number }[] = [];
  for (const s of levelSlots(rom, level, header)) {
    if (s.kind === 'lt3' || (s.kind === 'lg' && !mwl.layer3.gfx)) { out.push({ slot: s.name, num: 0xff }); continue; }
    const n = mwl.gfx.get(s.name);
    const mine = gfx.find((g) => g.lmNum === n);
    let num = 0xff;
    if (mine) num = mine.num;
    else if (n !== undefined && n !== 0x7f && n !== s.def) {
      if (gfxEntry(rom, n)) num = n;
      else notes.push(`Level ${hx(level)}: its ${s.name} file ${hx(n)} is neither the package's nor this ROM's – the default`);
    }
    out.push({ slot: s.name, num });
  }
  return out;
}
