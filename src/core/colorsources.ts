// Where the level's colors are loaded from (the palette tab writes a color there): a load of the level as edited that
// traces the ROM offset each CGRAM byte is filled from (trackSources). Kept while the level as edited and the ROM bytes
// its load read are unchanged, the colors' values left out of those (gfxFileColorValueSkipMask, as gfxDisplaySkipMask
// does, ADR 0008): changing a color keeps it; a level's own palette set or removed, or another palette in its header,
// traces again (the ExAnimation data counts: a color animation writes colors). On an own emulator, booted with the same
// mask (the title screen's colors are read while booting, which every load counts).

import type { Rom } from './rom.ts';
import { LevelEmulator, type LevelOverride, type LevelRender } from './levelemu.ts';
import type { RomReads } from './romdeps.ts';
import { gfxFileColorValueSkipMask } from './gfxpages.ts';
import { inputHash, levelInput } from './inputs.ts';

export class ColorSources {
  emu: LevelEmulator;
  traces = 0; // loads made (tests)
  private kept: { key: string; gen: number; reads: RomReads; r: LevelRender } | null = null;
  private mask = { gen: -1, mask: null as Uint8Array | null };

  constructor(rom: Rom) {
    this.emu = new LevelEmulator(rom);
    this.emu.skipMask = () => {
      const m = this.mask;
      if (m.gen !== rom.gen) { m.mask = gfxFileColorValueSkipMask(rom); m.gen = rom.gen; }
      return m.mask;
    };
  }

  // the level (ov: as edited, buildOverrides) loaded with its colors' sources: the kept one while it holds
  trace(level: number, ov: LevelOverride): LevelRender {
    const emu = this.emu, rom = emu.rom, key = inputHash(levelInput(level, ov)), k = this.kept;
    const changes = k?.key === key ? rom.changesSince(k.gen) : null;
    if (k && changes && !k.reads.touches(changes)) {
      k.gen = rom.gen;
      return k.r;
    }
    emu.ensureBoot(); // (first: its reads are the base of the load's)
    const gen = rom.gen, { result, reads } = emu.tracked(() => emu.load(level, { ...ov, trackSources: true }));
    this.traces++;
    this.kept = { key, gen, reads, r: result };
    return result;
  }
}
