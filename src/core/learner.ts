// Learning emulated results on the editor's main thread (what the probe worker doesn't do, see
// probeclient.ts): a result by its key in the result cache, else learned by a job on an emulator of the
// learner's job runner (jobrunner.ts), at once or in background slices. A sliced job runs in a lane: one job of a
// lane at a time (in the order asked), on the lane's own emulator (a job may leave state there between its slices); a
// request for a key (and input) already asked for joins it. A result holds while its key, its input (state
// outside the ROM it depends on, inputs.ts) and the ROM bytes it read (romdeps.ts) are unchanged; a sliced
// job during which bytes it read changed starts over before its next step.
// A result that is no picture (picture: false) doesn't read the display data either (the Map16 tiles'
// quarters, the colors: gfxDisplaySkipMask, as the probe worker's results, ADR 0008): drawing a tile or
// changing a color keeps it. Its job runs from a boot snapshot that leaves them out too, booted on an own
// emulator; pictures (CONTEXT.md) run from the main emulator's.

import type { Rom } from './rom.ts';
import type { LevelEmulator } from './levelemu.ts';
import type { RomReads, ResultCache } from './romdeps.ts';
import { inputHash } from './inputs.ts';
import { JobRunner, type Job, type JobRun, type Keep, type Prepare, type Part } from './jobrunner.ts';

const SLICE = 12; // ms a slice of a job runs before input and drawing get through
const AT_ONCE = ''; // the lane of the emulator for work at once

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

interface Run {
  id: string; // key and input
  job: JobRun<unknown>;
  opts: LearnOptions<unknown>;
  done: ((r: unknown) => void)[];
  failed: (() => void)[];
}

interface Lane { runs: Run[]; scheduled: boolean }

export class ResultLearner {
  private d: LearnerDeps;
  private runner: JobRunner;
  private lanes = new Map<string, Lane>();
  private hashes = new WeakMap<object, string>(); // of inputs given as objects

  constructor(deps: LearnerDeps) {
    this.d = deps;
    this.runner = new JobRunner({ rom: deps.rom, results: deps.results, main: deps.main });
  }

  // The result under key for the input, else learned at once: run returns it with the ROM bytes it read
  // (emu.tracked)
  now<T>(key: string, run: (emu: LevelEmulator) => { result: T; reads: RomReads }, opts: { input?: unknown; keep?: true | 'memory'; picture?: boolean } = {}): T {
    const input = this.hash(opts.input), keep = opts.keep ?? true;
    const stored = this.runner.stored<T>(key, input, keep);
    if (stored !== undefined) return stored;
    const { result, reads } = run(this.emu(opts.picture ?? true));
    this.runner.store(key, input, keep, result, reads);
    return result;
  }

  // The result under key for opts.input (opts.keep), else undefined: the job is started (after the stored
  // results are loaded, which may hold it) and opts.done called with its result
  learn<T>(key: string, start: (emu: LevelEmulator, prepare: Prepare, part: Part) => Job<T>, opts: LearnOptions<T> = {}): T | undefined {
    const name = opts.lane ?? key, input = this.hash(opts.input), id = input === undefined ? key : `${key}#${input}`;
    let lane = this.lanes.get(name);
    if (!lane) this.lanes.set(name, (lane = { runs: [], scheduled: false }));
    if (opts.replace && lane.runs.some((r) => r.id !== id)) {
      lane.runs = lane.runs.filter((r) => r.id === id);
      this.busy(name, lane);
    }
    const keep = opts.keep ?? true, stored = this.runner.stored<T>(key, input, keep);
    if (stored !== undefined) return stored;
    let run = lane.runs.find((r) => r.id === id);
    if (!run) {
      const job = this.runner.run({ key, input, keep, picture: opts.picture ?? true, start }) as JobRun<unknown>;
      run = { id, job, opts: opts as LearnOptions<unknown>, done: [], failed: [] };
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

  // the emulator for work at once (set up from the main one's boot state; picture: false, from the boot snapshot of
  // results that are no pictures)
  emu(picture = true): LevelEmulator {
    return this.runner.emu(AT_ONCE, picture);
  }

  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts, JobRunner.tilesetPointers)
  tilesetPointers(): number[][] {
    return this.runner.tilesetPointers();
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
    const t0 = performance.now();
    try {
      for (;;) {
        const r = this.runner.step(name, run.job);
        if (r) { this.finish(name, lane, run, r.result); return; }
        if (performance.now() - t0 > SLICE) break;
      }
    } catch (e) { this.fail(name, lane, run, e); return; }
    if (lane.runs[0] === run) run.opts.progress?.();
    this.busy(name, lane);
    this.schedule(name, lane);
  }

  private finish(name: string, lane: Lane, run: Run, result: unknown): void {
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
    this.d.setBusy(name, !run ? null : run.job.label ?? (typeof label === 'function' ? label(lane.runs.length) : label ?? null));
  }
}
