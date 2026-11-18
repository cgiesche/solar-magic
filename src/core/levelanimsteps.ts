// The level's animation steps (App.startAnimation, #440): the console's VRAM and CGRAM every few frames as the level
// loaded runs on (LevelEmulator.animationFrames), emulated one at a time, together with what they depend on – the ROM
// bytes they read and what they read of the console as the load left it. An edit loads the level anew; the steps
// carry over to the new load (no emulation) while nothing they read changed: its ROM bytes, the WRAM they read before
// writing it, the level's data as edited they read (the emulator's overlay), the console's other state (registers,
// timing, sound), the video memory (all of it when they read it back through its ports, else only where they write
// it). VRAM and CGRAM bytes they never write are the new load's (a level's tilemaps moved in VRAM). Found by
// emulation: no list of what can't matter. The level runs without Mario and its sprites
// (LevelEmulator.animationFrames, #444), so the steps don't read the level's tiles around them: things moved there
// carry too.
// What they read is conservative: a byte read counts though the code masks it away (a 16-bit load of a loader's
// leftover: every object added to the end leaves another one), what a sprite at the level's start leaves in the
// sprite memory counts though only the picture's sprites follow from it. Steps something they read changed for are
// carried all the same, as a guess, and checked: emulated anew one at a time and compared (check) – the same ones
// stay (the animation runs on as it was), different ones are replaced by those emulated.

import type { LevelEmulator } from './levelemu.ts';
import type { MemHook, SnesState } from './snes.ts';
import { joinHooks } from './snes.ts';
import { RomReads, holds, type Recorded } from './romdeps.ts';
import type { AnimStep } from './render.ts';
import { RAM, markFrozenActors } from './ram.ts';

const STEP_FRAMES = 8; // the frames of a step (the overworld's too: owanimsteps.ts ANIM_STEP_FRAMES)

// what the steps read of the console as the load left it, and where they write its video memory
interface StepDeps {
  wramRead: Set<number>; // WRAM read before the steps wrote it
  wramWritten: Uint8Array; // (1: written by a step)
  vramWritten: Uint8Array;
  cgramWritten: Uint8Array;
  videoRead: boolean; // VRAM, CGRAM or OAM read through its port
  overlayRead: Set<number>; // the emulator's overlay (the level's data as edited, LevelEmulator.overlay)
}

export class LevelAnimSteps {
  readonly count: number; // the steps wanted (fewer once the game fails: done)
  readonly steps: AnimStep[];
  private emu: LevelEmulator;
  private start: SnesState; // the console as the load left it
  private overlay: Uint8Array; // the overlay as the load left it
  private state: SnesState | null; // where the next step goes on from (null: no more)
  private recorded: Recorded<void>; // the ROM bytes the steps read
  private deps: StepDeps;
  // carried as a guess (carry): the set carried from, the steps emulated anew so far (as many are checked)
  private unchecked: { from: LevelAnimSteps; made: AnimStep[] } | null = null;

  // the steps of the level emu just loaded (must directly follow its load), count of them
  constructor(emu: LevelEmulator, count: number) {
    this.emu = emu;
    this.count = count;
    this.start = emu.snes.saveState();
    this.overlay = emu.overlay.slice();
    this.state = count > 0 ? this.start : null;
    this.steps = [];
    this.recorded = { result: undefined, reads: new RomReads(emu.rom), gen: emu.rom.gen };
    // (animationFrames itself looks at the game mode, past the hooks, and sets the frozen actors' bytes before every
    // frame: what the load left there isn't read)
    const wramWritten = new Uint8Array(0x20000);
    markFrozenActors(wramWritten);
    this.deps = { wramRead: new Set([RAM.gameMode]), wramWritten, vramWritten: new Uint8Array(0x10000),
      cgramWritten: new Uint8Array(0x200), videoRead: false, overlayRead: new Set() };
  }

  // all steps emulated (or the game failed), or carried
  get done(): boolean {
    return !!this.unchecked || !this.state || this.steps.length >= this.count;
  }

  // the steps are the new load's for sure: emulated, or carried with nothing they read changed (false: a guess, see check)
  get checked(): boolean {
    return !this.unchecked;
  }

  // the ROM bytes the steps emulated so far read
  get reads(): RomReads {
    return this.recorded.reads;
  }

  // emulates the next step: null when there are no more (all made, the game failed); other loads in between don't
  // disturb it
  next(): AnimStep | null {
    if (this.done) return null;
    const step = this.emulate();
    if (step) this.steps.push(step);
    return step;
  }

  // Checks the next step of a set carried as a guess by emulating it: null while there are more to check, true when
  // all are the ones emulated (the set is as one emulated: what it read is the new load's), false when one differs –
  // the steps are then those emulated so far, the others to be made (next)
  check(): boolean | null {
    const u = this.unchecked;
    if (!u) return true;
    const at = u.made.length, was = this.steps[at] ?? null;
    const step = this.state && at < this.count ? this.emulate() : null;
    if (step) u.made.push(step);
    if (step && was && bytes(step.vram, was.vram) && bytes(step.cgram, was.cgram)) return null;
    this.unchecked = null;
    if (!step && !was) return true;
    this.steps.length = 0;
    this.steps.push(...u.made);
    return false;
  }

  private emulate(): AnimStep | null {
    const s = this.emu.snes, d = this.deps, outer = s.hook;
    const watch: MemHook = {
      onWramRead: (a) => { if (!d.wramWritten[a]) d.wramRead.add(a); },
      onWramWrite: (a) => { d.wramWritten[a] = 1; },
      onVramWrite: (a) => { d.vramWritten[a] = 1; },
      onCgramWrite: (a) => { d.cgramWritten[a] = 1; },
      onVideoRead: () => { d.videoRead = true; },
      onOverlayRead: (o) => { d.overlayRead.add(o); },
    };
    s.loadState(this.state!);
    s.hook = outer ? joinHooks(outer, watch) : watch;
    let step: AnimStep | null;
    try {
      const r = this.emu.recordAll(() => this.emu.animationFrames(1, STEP_FRAMES)[0] ?? null);
      this.recorded.reads.add(r.reads);
      step = r.result;
    } finally { s.hook = outer; }
    this.state = step && s.saveState();
    return step;
  }

  // These steps for the level emu just loaded anew (must directly follow its load), count wanted: without emulation
  // when all are made and the ROM bytes they read are the same, their VRAM and CGRAM the new load's where they don't
  // write them; null when they must be emulated again. For sure when nothing they read of the console as the load
  // left it changed either – else a guess to be checked (checked, check)
  carry(emu: LevelEmulator, count: number): LevelAnimSteps | null {
    // (a guess not checked through: carried from the set it was made from)
    if (this.unchecked) return this.unchecked.from.carry(emu, count);
    if (emu !== this.emu || count !== this.count || !this.done || !holds(emu.rom, this.recorded)) return null;
    const now = emu.snes.saveState(), was = this.start, d = this.deps;
    const vram = changed(was.vram as Uint8Array, now.vram as Uint8Array, d.vramWritten, d.videoRead);
    const cgram = changed(was.cgram as Uint8Array, now.cgram as Uint8Array, d.cgramWritten, d.videoRead);
    const ww = was.wram as Uint8Array, wn = now.wram as Uint8Array;
    const sure = vram.sure && cgram.sure && [...d.wramRead].every((a) => ww[a] === wn[a])
      && [...d.overlayRead].every((o) => this.overlay[o] === emu.overlay[o])
      && Object.keys(was).every((k) => k === 'wram' || k === 'vram' || k === 'cgram' || same(was[k], now[k]));
    const out = new LevelAnimSteps(emu, count);
    if (sure) {
      // (shared with this set: nothing changes them once all steps are made)
      out.recorded = this.recorded;
      out.deps = d;
      out.state = null;
    } else out.unchecked = { from: this, made: [] };
    // a step's arrays kept while the new load's differ nowhere it shows them (what the pickers learned of it holds)
    const patch = (a: Uint8Array, at: number[], from: Uint8Array) => {
      if (!at.length) return a;
      const c = a.slice();
      for (const k of at) c[k] = from[k];
      return c;
    };
    let lastIn: Uint8Array | null = null, lastOut: Uint8Array | null = null;
    for (const st of this.steps) {
      // (a VRAM shared by two steps stays shared)
      const v: Uint8Array = st.vram === lastIn ? lastOut! : patch(st.vram, vram.at, now.vram as Uint8Array);
      lastIn = st.vram;
      lastOut = v;
      const c = patch(st.cgram, cgram.at, now.cgram as Uint8Array);
      out.steps.push(vram.at.length || cgram.at.length ? { vram: v, cgram: c } : st);
    }
    return out;
  }
}

// where video memory differs between two loads outside of what the steps write; sure: the steps can't show another
// difference (none where they write it, none at all when they read it back)
function changed(was: Uint8Array, now: Uint8Array, written: Uint8Array, read: boolean): { at: number[]; sure: boolean } {
  const at: number[] = [];
  let sure = true;
  for (let k = 0; k < was.length; k++) {
    if (was[k] === now[k]) continue;
    if (read || written[k]) sure = false;
    if (!written[k]) at.push(k);
  }
  return { at, sure };
}

function bytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

// two values of a saved console state (SnesState) the same: its arrays by content, the sound unit's and PPU's states
// field by field
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((v, k) => v === b[k]);
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    return same(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
    return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
  }
  return false;
}
