// The boot snapshot (CONTEXT.md): the machine at the title screen as booted, the ROM it was booted on and the ROM
// bytes the boot read, sorted by what they are. Every emulated result starts from it; what the result shows (Shows)
// says which of the boot's reads it counts, each counting the one before's and more:
//   behaviour     no picture: code and tables
//   picture       the display data too (ADR 0008); graphics file contents are its input
//   full picture  the graphics file data the game read from the ROM too (the open level's picture, its animation steps)
//   title screen  the title screen picture's bytes too (a pre-game screen's machine, a menu's text)
// Emulators on one ROM share a snapshot by reference (LevelEmulator.adoptBoot); it is never changed, a stale one is
// replaced by booting again.
// Behaviour and picture still differ by the skip mask of the emulator recording (LevelEmulator.skipMask: the boot's
// recorded reads are what its mask left in), not here; the mask moves in with #552.

import type { Rom } from './rom.ts';
import type { Snes, SnesState } from './snes.ts';
import { L3_MAP_VRAM, L3_MAP_WORDS } from './layer3map.ts';
import { RomReads, record, type Recorded, type RecordingCpu } from './romdeps.ts';

export type Shows = 'behaviour' | 'picture' | 'full picture' | 'title screen';

export interface BootParts {
  state: SnesState; // the machine at the title screen
  rom: Uint8Array; // the ROM as it was booted
  reads: RomReads; // the boot's recorded reads (what its skip mask left in): every result counts them
  masked: RomReads; // the reads its skip mask left out: GFX files uploaded on the title screen stay in VRAM, and a level with the same files doesn't upload them again
  picture: RomReads; // the title screen picture's bytes (titlepicture.ts), which the boot draws and a level's load writes over
}

export class BootSnapshot {
  readonly state: SnesState;
  readonly rom: Uint8Array;
  readonly reads: RomReads;
  readonly masked: RomReads;
  readonly picture: RomReads;

  constructor(p: BootParts) {
    this.state = p.state;
    this.rom = p.rom;
    this.reads = p.reads;
    this.masked = p.masked;
    this.picture = p.picture;
  }

  // it still holds for a ROM image: no byte the boot read differs from the ROM as booted, of any kind (the state
  // holds the title screen's graphics and its picture). Else it is stale: booted again
  holds(now: Uint8Array): boolean {
    return !this.reads.differ(this.rom, now) && !this.masked.differ(this.rom, now) && !this.picture.differ(this.rom, now);
  }

  // the boot's reads a result showing `shows` counts, added to its reads
  addTo(reads: RomReads, shows: Shows): void {
    reads.add(this.reads);
    if (shows === 'full picture' || shows === 'title screen') reads.add(this.masked);
    if (shows === 'title screen') reads.add(this.picture);
  }

  // The title screen picture as booted put back into the machine (its VRAM) of a kept result that doesn't show it (a
  // full picture: kept when the picture is painted): the cells of layer 3's tilemap the result left as the machine it
  // started from had them (first: that machine's VRAM, the boot's of then) are this boot's.
  putPictureBack(vram: Uint8Array, first: Uint8Array): void {
    const boot = this.state.vram as Uint8Array;
    for (let a = L3_MAP_VRAM * 2; a < (L3_MAP_VRAM + L3_MAP_WORDS) * 2; a += 2)
      if (vram[a] === first[a] && vram[a + 1] === first[a + 1]) { vram[a] = boot[a]; vram[a + 1] = boot[a + 1]; }
  }
}

// the emulated CPU of a recording that says what it shows: the reads its skip mask leaves out are recorded apart
export type ShowingCpu = RecordingCpu & Pick<Snes, 'romMasked'>;

// what a result's reads are put on top of, and whether they count around it
export interface RecordOn {
  // the reads the result counts as its own: the boot's (default, by what it shows), none (null: reads kept apart from
  // the boot's), an earlier result's (a probe on top of its level's)
  base?: RomReads | null;
  counted?: boolean; // the reads count for the recording around it (default; else only as given to countReads)
}

export interface ShownOptions extends RecordOn {
  snapshot: () => BootSnapshot | null; // the boot snapshot the result starts from (asked again after fn, which may boot)
  mask: (() => Uint8Array | null) | null; // the CPU's reads left out (the emulator's skip mask; a full picture counts them too)
}

// Runs fn recording the ROM bytes it reads (romdeps.ts record), as a result showing `shows` counts them: on top of
// the boot's recorded reads; a full picture also the reads the skip mask leaves out, fn's and the boot's (a render
// shows GFX file data); what shows the title screen the title screen picture's bytes too. With a base given (RecordOn)
// nothing of the boot's is added.
export function recordShown<T>(rom: Rom, cpu: ShowingCpu, shows: Shows, fn: () => T, o: ShownOptions): Recorded<T> {
  const onBoot = o.base === undefined;
  const opts = { cpu, base: onBoot ? o.snapshot()?.reads ?? null : o.base, mask: o.mask, counted: o.counted };
  if (shows === 'behaviour' || shows === 'picture') return record(rom, fn, opts);
  const outer = cpu.romMasked, masked = new RomReads(rom);
  cpu.romMasked = masked;
  try {
    const r = record(rom, fn, opts);
    r.reads.add(masked);
    if (onBoot) o.snapshot()?.addTo(r.reads, shows);
    return r;
  } finally { cpu.romMasked = outer; }
}
