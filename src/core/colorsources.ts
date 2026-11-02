// Where the level's colors are loaded from (the palette tab writes a color there): a load of the level as edited that
// traces the ROM offset each CGRAM byte is filled from (trackSources). Kept while the level as edited and the ROM bytes
// its load read are unchanged, the colors' values left out of those (gfxFileColorValueSkipMask, as gfxDisplaySkipMask
// does, ADR 0008): changing a color keeps it; a level's own palette set or removed, or another palette in its header,
// traces again (the ExAnimation data counts: a color animation writes colors). On an own emulator, booted with the same
// mask (the title screen's colors are read while booting, which every load counts).

import type { Rom } from './rom.ts';
import { LevelEmulator, type LevelOverride, type LevelRender } from './levelemu.ts';
import { perRomState, bySince, type Since } from './romdeps.ts';
import { KeptResults } from './keptresults.ts';
import { gfxFileColorValueSkipMask } from './gfxpages.ts';
import { inputHash, levelInput } from './inputs.ts';

export class ColorSources {
  emu: LevelEmulator;
  traces = 0; // loads made (tests)
  private kept: KeptResults<Since>; // the latest load, by the level as edited

  constructor(rom: Rom) {
    this.emu = new LevelEmulator(rom);
    const mask = perRomState(gfxFileColorValueSkipMask);
    this.emu.skipMask = () => mask(rom);
    this.kept = new KeptResults({ validity: bySince(rom), inputsPerKey: 1 });
  }

  // the level (ov: as edited, buildOverrides) loaded with its colors' sources: the kept one while it holds
  trace(level: number, ov: LevelOverride): LevelRender {
    const emu = this.emu, input = inputHash(levelInput(level, ov)), k = this.kept.get<LevelRender>('trace', input);
    if (k) return k;
    emu.ensureBoot(); // (first: its reads are the base of the load's)
    const { result, reads, gen } = emu.tracked(() => emu.load(level, { ...ov, trackSources: true }));
    this.kept.set('trace', result, { gen, reads }, input);
    this.traces++;
    return result;
  }
}
