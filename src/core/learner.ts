// Learning emulated results on the editor's main thread (what the probe worker doesn't do, see
// probeclient.ts): a result by its key in the result cache, else learned by a job on an emulator of the
// learner's, at once or in background slices. A sliced job runs in a lane: one job of a lane at a time
// (in the order asked), on the lane's own emulator (a job may leave state there between its slices); a
// request for a key (and input) already asked for joins it. A result holds while its key, its input (state
// outside the ROM it depends on, inputs.ts) and the ROM bytes it read (romdeps.ts) are unchanged; a sliced
// job during which bytes it read changed keeps nothing and runs again.
// A result that is no picture (picture: false) doesn't read the display data either (the Map16 tiles'
// quarters, the colors: displaySkipMask, as the probe worker's results, ADR 0008): drawing a tile or
// changing a color keeps it. Its job runs from a boot snapshot that leaves them out too, booted on an own
// emulator; pictures (sprite images, thumbnails) run from the main emulator's.

import type { Rom } from './rom.ts';
import { LevelEmulator } from './levelemu.ts';
import { RomReads, type ResultCache, type RomDeps, type RomFingerprint } from './romdeps.ts';
import { inputHash } from './inputs.ts';
import { displaySkipMask } from './gfxpages.ts';
import { TILESETS, tilesetPointers, pointersKey } from './tilesets.ts';

const SLICE = 12; // ms a slice of a job runs before input and drawing get through
const MEMORY = 256; // results kept in memory only (keep: 'memory'), the latest used

// where a result goes: the result cache (stored), memory only (results that change with every edit, not
// worth storing) or nowhere (to done only)
export type Keep = boolean | 'memory';

export interface LearnerDeps {
  rom: Rom;
  results: ResultCache;
  cacheReady: Promise<void>; // stored results are loaded
  main: LevelEmulator; // the booted emulator whose boot snapshot the learner's emulators take over
  later(key: string, step: () => void): void; // a background slice (waits while a dialog is open)
  soon(step: () => void): void; // a slice that runs while a dialog is open too
  setBusy(key: string, label: string | null): void;
}

export interface LearnOptions<T> {
  lane?: string; // the lane (default: the key), also the key of its slices and of its busy label
  replace?: boolean; // drops the lane's other jobs (they are not wanted any more), also when the result is known
  input?: unknown; // what the result depends on outside the ROM (inputs.ts; treated as unchanging once given)
  keep?: Keep; // the result goes to the result cache (default: true)
  picture?: boolean; // the result shows what things look like: it reads the display data (default: true)
  urgent?: boolean; // runs while a dialog is open (one that shows the result); the same for all jobs of a lane
  label?: string | ((queued: number) => string); // busy label (queued: the lane's jobs); a job's yielded string replaces it
  done?: (result: T) => void; // (a callback already waiting for the key isn't added again)
  failed?: () => void; // the job threw
  progress?: () => void; // after each slice that didn't finish it (results come in as it runs)
}

// a job: a step per next(), the result as its return value; a yielded string is its busy label from then on
export type Job<T> = Iterator<string | void, T>;

interface Run {
  key: string;
  input: string | undefined; // its hash
  id: string; // key and input
  start: (emu: LevelEmulator) => Job<unknown>;
  opts: LearnOptions<unknown>;
  done: ((r: unknown) => void)[];
  failed: (() => void)[];
  job: Job<unknown> | null; // null until it starts (again)
  reads: RomReads;
  rom: Uint8Array; // the ROM when it started
  label: string | null; // yielded
}

interface Lane { runs: Run[]; emu: LevelEmulator | null; scheduled: boolean }

export class ResultLearner {
  private d: LearnerDeps;
  private lanes = new Map<string, Lane>();
  private atOnce: LevelEmulator | null = null;
  private noDisplay: LevelEmulator | null = null; // the boot snapshot of results that are no pictures (noDisplayBoot)
  private pointerEmu: LevelEmulator | null = null; // learns the tilesets' pointers (tilesetPointers)
  private display = { gen: -1, mask: null as Uint8Array | null }; // displayMask
  private snap = { gen: -1, data: new Uint8Array(0) }; // the ROM as jobs start with it (copied once per change)
  private memory: MemoryResults;
  private hashes = new WeakMap<object, string>(); // of inputs given as objects

  constructor(deps: LearnerDeps) {
    this.d = deps;
    this.memory = new MemoryResults(deps.results.fp, MEMORY);
  }

  // The result under key for the input, else learned at once: run returns it with the ROM bytes it read
  // (emu.tracked)
  now<T>(key: string, run: (emu: LevelEmulator) => { result: T; reads: RomReads }, opts: { input?: unknown; keep?: true | 'memory'; picture?: boolean } = {}): T {
    const input = this.hash(opts.input), keep = opts.keep ?? true;
    const stored = this.stored<T>(key, input, keep);
    if (stored !== undefined) return stored;
    const { result, reads } = run(this.emu(opts.picture ?? true));
    this.store(key, input, keep, result, reads);
    return result;
  }

  // The result under key for opts.input (opts.keep), else undefined: the job is started (after the stored
  // results are loaded, which may hold it) and opts.done called with its result
  learn<T>(key: string, start: (emu: LevelEmulator) => Job<T>, opts: LearnOptions<T> = {}): T | undefined {
    const name = opts.lane ?? key, input = this.hash(opts.input), id = input === undefined ? key : `${key}#${input}`;
    let lane = this.lanes.get(name);
    if (!lane) this.lanes.set(name, (lane = { runs: [], emu: null, scheduled: false }));
    if (opts.replace && lane.runs.some((r) => r.id !== id)) {
      lane.runs = lane.runs.filter((r) => r.id === id);
      this.busy(name, lane);
    }
    const stored = this.stored<T>(key, input, opts.keep ?? true);
    if (stored !== undefined) return stored;
    let run = lane.runs.find((r) => r.id === id);
    if (!run) {
      run = { key, input, id, start, opts: opts as LearnOptions<unknown>, done: [], failed: [], job: null, reads: new RomReads(0), rom: this.snap.data, label: null };
      lane.runs.push(run);
    }
    const done = opts.done as ((r: unknown) => void) | undefined;
    if (done && !run.done.includes(done)) run.done.push(done);
    if (opts.failed && !run.failed.includes(opts.failed)) run.failed.push(opts.failed);
    this.busy(name, lane);
    this.schedule(name, lane);
    return undefined;
  }

  // drops the jobs of a lane
  cancel(name: string): void {
    const lane = this.lanes.get(name);
    if (!lane?.runs.length) return;
    lane.runs = [];
    this.busy(name, lane);
  }

  private hash(input: unknown): string | undefined {
    if (input === undefined) return undefined;
    if (typeof input !== 'object' || input === null) return inputHash(input);
    let h = this.hashes.get(input);
    if (h === undefined) this.hashes.set(input, (h = inputHash(input)));
    return h;
  }

  private stored<T>(key: string, input: string | undefined, keep: Keep): T | undefined {
    return keep === false ? undefined : (keep === 'memory' ? this.memory : this.d.results).get<T>(key, input);
  }

  private store(key: string, input: string | undefined, keep: Keep, result: unknown, reads: RomReads): void {
    if (keep !== false) (keep === 'memory' ? this.memory : this.d.results).set(key, result, this.d.results.fp.deps(reads), input);
  }

  // the emulator for work at once (set up from the main one's boot state; picture: false, see noDisplayBoot)
  emu(picture = true): LevelEmulator {
    return (this.atOnce = this.fresh(this.atOnce, picture));
  }

  private fresh(emu: LevelEmulator | null, picture: boolean): LevelEmulator {
    let from = this.d.main;
    if (!picture) {
      this.displayMask(); // (first: the pointers it needs are learned at once)
      from = this.noDisplayBoot();
    }
    if (!emu || emu.rom !== this.d.rom) emu = new LevelEmulator(this.d.rom);
    emu.skipMask = picture ? () => this.d.main.skipMask?.() ?? null : this.displayMask;
    emu.adoptBoot(from);
    return emu;
  }

  // The bytes results that are no pictures don't read: the display data (displaySkipMask, with the tilesets'
  // pointers), the GFX file data among them; once per ROM state. Learning the pointers isn't part of the
  // result asking for the mask.
  private displayMask = (): Uint8Array | null => {
    const rom = this.d.rom, m = this.display;
    if (m.gen !== rom.gen) {
      const reads = rom.reads;
      rom.reads = null;
      try { m.mask = displaySkipMask(rom, this.tilesetPointers()); m.gen = rom.gen; } finally { rom.reads = reads; }
    }
    return m.mask;
  };

  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts), learned once and kept in the result cache
  // (their reads leave out the display data by themselves). On an own emulator: the mask is asked for while
  // other emulators of the learner's run.
  tilesetPointers(): number[][] {
    return Array.from({ length: TILESETS }, (_, ts) => {
      const key = pointersKey(ts), known = this.stored<number[]>(key, undefined, true);
      if (known !== undefined) return known;
      const { result, reads } = tilesetPointers(this.pointerEmu = this.fresh(this.pointerEmu, true), ts);
      this.store(key, undefined, true, result, reads);
      return result;
    });
  }

  // The boot snapshot for results that are no pictures: the same state as the main one's, its reads without the
  // display data (a title screen's tile or color isn't read by every such result). Booted on an own emulator, again
  // when what it read changed (a display edit too: the state holds the title screen's colors).
  private noDisplayBoot(): LevelEmulator {
    if (!this.noDisplay || this.noDisplay.rom !== this.d.rom) {
      this.noDisplay = new LevelEmulator(this.d.rom);
      this.noDisplay.skipMask = this.displayMask;
    }
    this.noDisplay.ensureBoot();
    return this.noDisplay;
  }

  private schedule(name: string, lane: Lane): void {
    if (lane.scheduled || !lane.runs.length) return;
    lane.scheduled = true;
    const step = () => { lane.scheduled = false; this.slice(name, lane); };
    const urgent = lane.runs[0].opts.urgent;
    void this.d.cacheReady.then(() => (urgent ? this.d.soon(step) : this.d.later(name, step)));
  }

  private slice(name: string, lane: Lane): void {
    const run = lane.runs[0];
    if (!run) return;
    const rom = this.d.rom;
    if (!run.job) {
      // (stored meanwhile, or loaded from storage)
      const stored = this.stored(run.key, run.input, run.opts.keep ?? true);
      if (stored !== undefined) { this.finish(name, lane, run, stored); return; }
      if (this.snap.gen !== rom.gen) this.snap = { gen: rom.gen, data: rom.data.slice() };
      run.rom = this.snap.data;
      run.reads = new RomReads(rom.data.length);
      run.label = null;
      try { run.job = run.start(lane.emu = this.fresh(lane.emu, run.opts.picture ?? true)); } catch (e) { this.fail(name, lane, run, e); return; }
    }
    const emu = lane.emu!, job = run.job!, t0 = performance.now();
    try {
      for (;;) {
        const r = emu.tracked(() => job.next());
        run.reads.add(r.reads);
        if (r.result.done) {
          if (run.reads.differ(run.rom, rom.data)) run.job = null; // learned from bytes that changed meanwhile: again
          else { this.finish(name, lane, run, r.result.value); return; }
          break;
        }
        if (typeof r.result.value === 'string') run.label = r.result.value;
        if (performance.now() - t0 > SLICE) break;
      }
    } catch (e) { this.fail(name, lane, run, e); return; }
    if (lane.runs[0] === run) run.opts.progress?.();
    this.busy(name, lane);
    this.schedule(name, lane);
  }

  private finish(name: string, lane: Lane, run: Run, result: unknown): void {
    if (run.job) this.store(run.key, run.input, run.opts.keep ?? true, result, run.reads);
    this.drop(lane, run);
    for (const f of run.done) f(result);
    this.busy(name, lane);
    this.schedule(name, lane);
  }

  private fail(name: string, lane: Lane, run: Run, e: unknown): void {
    console.error(e);
    this.drop(lane, run);
    for (const f of run.failed) f();
    this.busy(name, lane);
    this.schedule(name, lane);
  }

  private drop(lane: Lane, run: Run): void {
    const i = lane.runs.indexOf(run);
    if (i >= 0) lane.runs.splice(i, 1);
  }

  private busy(name: string, lane: Lane): void {
    const run = lane.runs[0], label = run?.opts.label;
    this.d.setBusy(name, !run ? null : run.label ?? (typeof label === 'function' ? label(lane.runs.length) : label ?? null));
  }
}

// results kept in memory only (keep: 'memory'), the latest used; checked against the ROM like the result
// cache's
class MemoryResults {
  private fp: RomFingerprint;
  private limit: number;
  private entries = new Map<string, { data: unknown; deps: RomDeps; input: string | undefined; gen: number }>();

  constructor(fp: RomFingerprint, limit: number) {
    this.fp = fp;
    this.limit = limit;
  }

  get<T>(key: string, input: string | undefined): T | undefined {
    const e = this.entries.get(key);
    if (!e || e.input !== input) return undefined;
    this.fp.sync();
    if (e.gen !== this.fp.gen) {
      if (!this.fp.valid(e.deps)) { this.entries.delete(key); return undefined; }
      e.gen = this.fp.gen;
    }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.data as T;
  }

  set(key: string, data: unknown, deps: RomDeps, input: string | undefined): void {
    this.entries.delete(key);
    this.entries.set(key, { data, deps, input, gen: this.fp.gen });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
