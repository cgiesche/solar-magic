// Learning emulated results on the editor's main thread, at once (now), on an emulator of the learner's job runner
// (jobrunner.ts); the editor learns its jobs in the probe worker instead (probeclient.ts), level loads too, and here only
// the tilesets' pointers (App.tilesetPointerTable says why); now and emu serve the tools comparing with the worker. A
// result holds while its key, its input (state outside the ROM it depends on, inputs.ts) and the ROM bytes it read
// (romdeps.ts) are unchanged.
// A result that is no picture (picture: false) doesn't read the display data either (the Map16 tiles'
// quarters, the colors: gfxDisplaySkipMask, as the probe worker's results, ADR 0008): drawing a tile or
// changing a color keeps it. It runs from a boot snapshot that leaves them out too, booted on an own
// emulator; pictures (CONTEXT.md) run from the main emulator's.

import type { Rom } from './rom.ts';
import type { LevelEmulator } from './levelemu.ts';
import type { RomReads, ResultCache } from './romdeps.ts';
import { inputHash } from './inputs.ts';
import { JobRunner } from './jobrunner.ts';

const AT_ONCE = ''; // the job runner's name of the emulator for work at once

export interface LearnerDeps {
  rom: Rom;
  results: ResultCache;
  main: LevelEmulator; // the booted emulator whose boot snapshot the learner's emulators take over
}

export class ResultLearner {
  private runner: JobRunner;
  private hashes = new WeakMap<object, string>(); // of inputs given as objects

  constructor(deps: LearnerDeps) {
    this.runner = new JobRunner({ rom: deps.rom, results: deps.results, main: deps.main });
  }

  // The result under key for the input, else learned at once: run returns it with the ROM bytes it read
  // (emu.record)
  now<T>(key: string, run: (emu: LevelEmulator) => { result: T; reads: RomReads }, opts: { input?: unknown; keep?: true | 'memory'; picture?: boolean } = {}): T {
    const input = this.hash(opts.input), keep = opts.keep ?? true;
    const stored = this.runner.stored<T>(key, input, keep);
    if (stored !== undefined) return stored;
    const { result, reads } = run(this.emu(opts.picture ?? true));
    this.runner.store(key, input, keep, result, reads);
    return result;
  }

  private hash(input: unknown): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input !== 'object' || input === null) return inputHash(input);
    let h = this.hashes.get(input);
    if (h === undefined) this.hashes.set(input, (h = inputHash(input)));
    return h;
  }

  // the emulator for work at once (set up from the main one's boot state; picture: false, from the boot snapshot of
  // results that are no pictures)
  emu(picture = true): LevelEmulator {
    return this.runner.emu(AT_ONCE, picture);
  }

  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts, JobRunner.tilesetPointers)
  tilesetPointers(): number[][] {
    return this.runner.tilesetPointers();
  }
}
