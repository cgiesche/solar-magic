// The boot snapshot (CONTEXT.md): the machine at the title screen as booted, the ROM it was booted on and the ROM
// bytes the boot read, kept by what a result leaves out of them. Every emulated result starts from it; what the result
// shows (Shows) says which of the boot's reads it counts, each counting the one before's and more:
//   behaviour     no picture: code and tables
//   picture       the display data too (ADR 0008); graphics file contents are its input
//   full picture  the graphics file data the game read from the ROM too (the open level's picture, its animation steps)
//   title screen  the title screen picture's bytes too (a pre-game screen's machine, a menu's text)
// What a result leaves out follows from what it shows too (leaving): behaviour the display data with the graphics file
// and ExAnimation data, a picture the graphics file and ExAnimation data only; a full picture counts what a picture
// leaves out as well. A result may name bytes it leaves out besides (LeftOut). No emulator is given a skip mask.
// Emulators on one ROM share a snapshot by reference (LevelEmulator.adoptBoot); a stale one is replaced by booting
// again. The boot's reads are what its recording left in: a snapshot is booted leaving out what the result booting
// it does, and the same boot is run once more, on a machine of its own, for the first result that leaves out other
// bytes (recorded: behaviour beside pictures, about 0.1 s); those reads are kept with the snapshot. One boot whose
// reads are sorted afterwards isn't possible: reads are recorded by page (romdeps.ts), ADR 0008 says more.

import type { Rom } from './rom.ts';
import type { Snes, SnesState } from './snes.ts';
import { L3_MAP_VRAM, L3_MAP_WORDS } from './layer3map.ts';
import { RomReads, record, perRomState, type Recorded, type RecordingCpu } from './romdeps.ts';
import { keptGfxSkipMask, gfxDisplaySkipMask } from './gfxpages.ts';
import { editorPatch } from './patches.ts';

export type Shows = 'behaviour' | 'picture' | 'full picture' | 'title screen';

// the boot's reads as one of its recordings has them
export interface BootReads {
  reads: RomReads; // those recorded (what its skip mask left in): every result leaving out the same counts them
  masked: RomReads; // the reads its skip mask left out: GFX files uploaded on the title screen stay in VRAM, and a level with the same files doesn't upload them again
}

export interface BootParts extends BootReads {
  state: SnesState; // the machine at the title screen
  rom: Uint8Array; // the ROM as it was booted
  leaves: string; // what its recorded reads leave out (Leaving.boot)
  picture: RomReads; // the title screen picture's bytes (titlepicture.ts), which the boot draws and a level's load writes over
}

export class BootSnapshot implements BootReads {
  readonly state: SnesState;
  readonly rom: Uint8Array;
  readonly leaves: string;
  readonly reads: RomReads;
  readonly masked: RomReads;
  readonly picture: RomReads;
  private others = new Map<string, BootReads>(); // the same boot's reads recorded leaving out other bytes, by what

  constructor(p: BootParts) {
    this.state = p.state;
    this.rom = p.rom;
    this.leaves = p.leaves;
    this.reads = p.reads;
    this.masked = p.masked;
    this.picture = p.picture;
  }

  // The boot's reads recorded leaving out what `leaves` names: this snapshot's own, else those of the same boot run
  // once more (again: on another machine, recorded so), kept from then on. The machine is the same either way: what is
  // left out acts on the recording only.
  recorded(leaves: string, again: () => BootReads): BootReads {
    if (leaves === this.leaves) return this;
    let r = this.others.get(leaves);
    if (!r) this.others.set(leaves, (r = again()));
    return r;
  }

  // it still holds for a ROM image: no byte the boot read differs from the ROM as booted, of any kind (the state
  // holds the title screen's graphics and its picture). Else it is stale: booted again
  holds(now: Uint8Array): boolean {
    return !this.reads.differ(this.rom, now) && !this.masked.differ(this.rom, now) && !this.picture.differ(this.rom, now);
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

// Bytes a result leaves out besides what its shows does (RecordOn.leavesOut): the game reads them on the way, the
// result doesn't depend on them.
export interface LeftOut {
  what: string; // their name
  mask: (rom: Rom) => Uint8Array; // 1: left out (of the ROM's size; asked once per ROM state, what it reads isn't recorded)
  // the boot's reads leave them out too (a result on an emulator of its own; else the boot's count as its shows says:
  // the title screen read them as every other result's boot did)
  boot?: true;
}

// where the bytes lie that a result leaves out by what it shows, in a ROM state (1: left out; null: nowhere)
export interface Places {
  picture: (rom: Rom) => Uint8Array | null; // the graphics file and ExAnimation data (gfxpages.ts gfxSkipMask)
  behaviour: (rom: Rom) => Uint8Array | null; // they and the display data (gfxDisplaySkipMask)
}

const NO_TILESETS = (): number[][] => [];
const displayMasks = new WeakMap<() => number[][], (rom: Rom) => Uint8Array | null>(); // by who knows the tilesets' pointers

// The places in a ROM, each mask kept per ROM state. tilesets: per tileset the pointers of FG Map16 tiles 000-1FF
// (tilesets.ts), learned by emulation and kept by who gives them (jobrunner.ts): where the tilesets' tile data lies.
// Without them behaviour leaves out the display data whose place the ROM's layout says, not those tiles' quarters.
// In a ROM without the editor's patch nothing is left out (gfxpages.ts keptGfxSkipMask).
export function places(tilesets: (() => number[][]) | null = null): Places {
  const t = tilesets ?? NO_TILESETS;
  let display = displayMasks.get(t);
  if (!display) displayMasks.set(t, (display = perRomState((rom) => editorPatch(rom) ? gfxDisplaySkipMask(rom, t()) : null)));
  return { picture: keptGfxSkipMask, behaviour: display };
}

// What a recording leaves out. The outermost recording of an emulator decides it by what it shows and what it leaves
// out besides; a recording inside it leaves out the same (the emulated CPU has one skip mask), whatever it names.
export interface Leaving {
  mask: Uint8Array | null; // the CPU's reads it leaves out
  alone: boolean; // the mask is only what a full picture leaves out besides: none of the reads it leaves out count
  boot: string; // the boot's recording its reads are put on top of (BootSnapshot.recorded): leaving out the same
  bootToo: boolean; // that recording leaves out what the result does besides (LeftOut.boot)
  bootMask: Uint8Array | null; // the mask of that recording: a boot inside the result's is recorded with it
}

const full = (shows: Shows) => shows === 'full picture' || shows === 'title screen';
const besidesMasks = new WeakMap<LeftOut, (rom: Rom) => Uint8Array>(); // per ROM state
const unions = new WeakMap<Uint8Array, WeakMap<Uint8Array, Uint8Array>>(); // a shows' mask with one left out besides

function besidesMask(rom: Rom, o: LeftOut): Uint8Array {
  let m = besidesMasks.get(o);
  if (!m) besidesMasks.set(o, (m = perRomState(o.mask)));
  return m(rom);
}

function union(a: Uint8Array | null, b: Uint8Array): Uint8Array {
  if (!a) return b;
  let of = unions.get(a);
  if (!of) unions.set(a, (of = new WeakMap()));
  let u = of.get(b);
  if (!u) {
    u = a.slice();
    for (let i = 0, n = Math.min(u.length, b.length); i < n; i++) if (b[i] === 1) u[i] = 1;
    of.set(b, u);
  }
  return u;
}

// What a result showing `shows` leaves out in the ROM as it is now: behaviour the display data with the graphics file
// and ExAnimation data, anything else the graphics file and ExAnimation data (a full picture counts them all the
// same: kept apart while it is recorded, recordShown), and with them what it leaves out besides. A full picture
// leaving out bytes besides leaves out those only.
export function leaving(rom: Rom, shows: Shows, at: Places, besides?: LeftOut | null): Leaving {
  // (where behaviour leaves out no more than a picture – no patch, nothing left out – it is recorded as one: one boot)
  const kind = shows === 'behaviour' && at.behaviour(rom) !== at.picture(rom) ? 'behaviour' : 'picture', of = at[kind](rom);
  if (!besides) return { mask: of, alone: false, boot: kind, bootToo: false, bootMask: of };
  const b = besidesMask(rom, besides), alone = full(shows), mask = alone ? b : union(of, b);
  if (!besides.boot) return { mask, alone, boot: kind, bootToo: false, bootMask: of };
  return { mask, alone, boot: `${alone ? 'full picture' : kind}+${besides.what}`, bootToo: true, bootMask: mask };
}

// what a result's reads are put on top of, what it leaves out besides, and whether they count around it
export interface RecordOn {
  // the reads the result counts as its own: the boot's (default, by what it shows), none (null: reads kept apart from
  // the boot's), an earlier result's (a probe on top of its level's)
  base?: RomReads | null;
  leavesOut?: LeftOut; // bytes it leaves out besides what its shows does (of the outermost recording only)
  counted?: boolean; // the reads count for the recording around it (default; else only as given to countReads)
}

export interface ShownOptions extends RecordOn {
  leaving: Leaving; // what the outermost recording leaves out (leaving): the result's own, or the one's around it
  snapshot: () => BootSnapshot | null; // the boot snapshot the result starts from (asked again after fn, which may boot)
  again: () => BootReads; // the boot run once more, recorded as leaving.boot says (BootSnapshot.recorded)
}

// Runs fn recording the ROM bytes it reads (romdeps.ts record), as a result showing `shows` counts them: without
// those `leaving` leaves out, on top of the boot's reads recorded leaving out the same. A full picture also counts
// the reads the mask leaves out, fn's and the boot's (a render shows GFX file data) – not those it leaves out besides;
// what shows the title screen the title screen picture's bytes too. With a base given (RecordOn) nothing of the
// boot's is added.
export function recordShown<T>(rom: Rom, cpu: ShowingCpu, shows: Shows, fn: () => T, o: ShownOptions): Recorded<T> {
  const l = o.leaving, onBoot = o.base === undefined, whole = full(shows) && !l.bootToo;
  // (every read of the boot is in any of its recordings: the snapshot's own serves a result counting them all)
  const boot = (): BootReads | null => { const s = o.snapshot(); return !s ? null : whole ? s : s.recorded(l.boot, o.again); };
  const opts = { cpu, base: onBoot ? boot()?.reads ?? null : o.base, mask: () => l.mask, counted: o.counted };
  if (!full(shows)) return record(rom, fn, opts);
  const outer = cpu.romMasked, masked = new RomReads(rom);
  cpu.romMasked = masked;
  try {
    const r = record(rom, fn, opts);
    if (!l.alone) r.reads.add(masked);
    const b = onBoot ? boot() : null;
    if (b) {
      r.reads.add(b.reads);
      if (whole) r.reads.add(b.masked);
      if (shows === 'title screen') r.reads.add(o.snapshot()!.picture);
    }
    return r;
  } finally { cpu.romMasked = outer; }
}
