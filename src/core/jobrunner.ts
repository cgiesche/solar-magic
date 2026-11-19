// The emulated job runner under the result learner (CONTEXT.md), on the editor's main thread (learner.ts) and in the
// probe worker (probehost.ts): runs a job a step at a time on an emulator of its own, with the ROM bytes it reads
// tracked, and keeps its result under its key and input while they are unchanged (romdeps.ts). A job during which
// bytes it read changed starts over before its next step (or before its result is kept). Which job runs next and how
// long a turn lasts is the owner's.
// An emulator per lane, set up from a boot snapshot: pictures (CONTEXT.md) from the main one's, results that are no
// pictures from one that leaves out the display data too (the Map16 tiles' quarters, the colors: gfxDisplaySkipMask,
// ADR 0008), so that drawing a tile or changing a color keeps them. A lane's emulator keeps a prepared state (a level
// loaded) for the later jobs there while the bytes preparing it read are unchanged.

import type { Rom } from './rom.ts';
import { LevelEmulator } from './levelemu.ts';
import { RomReads, holds, perRomState, byFingerprint, type ResultCache, type RomDeps, type RomFingerprint, type Recorded, type Since } from './romdeps.ts';
import type { Shows } from './bootsnapshot.ts';
import { KeptResults } from './keptresults.ts';
import { gfxSkipMask, gfxDisplaySkipMask } from './gfxpages.ts';
import { TILESETS, tilesetPointers, pointersKey } from './tilesets.ts';

export const MEMORY = 256; // keys whose results are kept in memory only (keep: 'memory'), the latest used
export const MEMORY_CONTENTS = 2; // their results per input: of the latest ROM states (an undo, a redo, #386)

// a job: a step per next(), the result as its return value (undefined: none, nothing kept); a yielded string is its
// label from then on. It doesn't write the ROM: a write to a byte it read starts it over (also one written back)
export type Job<T> = Iterator<string | void, T>;

// Runs a job to its end at once: what it yields between steps (a progress label) is ignored.
export function runJob<T>(job: Generator<unknown, T>): T {
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// where a result goes: the result cache (stored), memory only (results that change with every edit, not
// worth storing) or nowhere (to the owner only)
export type Keep = boolean | 'memory';

// the state kept on a job's emulator under key while the bytes preparing it read are unchanged (they count for the
// job), else prepare's (null: none kept); one per emulator
export type Prepare = <S>(key: string, prepare: () => S | null) => S | null;

// A part of a job's result kept on its own (under partKey(the job's key, sub) and its own input, as the job's result
// is kept) with the bytes it read: the stored one while they are unchanged (learned: false), else learn's (undefined:
// none, nothing kept). Its reads count for the job too, so a change one part read learns the job again, which takes
// the other parts as stored.
export type Part = <S>(sub: string, input: string | undefined, learn: () => S | undefined) => { result: S | undefined; learned: boolean };
export const partKey = (key: string, sub: string) => `${key}/${sub}`;

// what a job learns
export interface JobSpec<T> {
  key: string;
  input?: string; // the hash of what the result depends on outside the ROM (inputs.ts)
  keep: Keep;
  picture: boolean; // the result shows what things look like: it reads the display data
  boot?: boolean; // the boot snapshot's reads count for the result (default: true)
  whole?: false; // the result isn't kept itself, only its parts (Part), which give it put together (keep: theirs)
  start: (emu: LevelEmulator, prepare: Prepare, part: Part) => Job<T>;
}

// what a job's result shows (bootsnapshot.ts): a picture or behaviour, by its spec
const shows = (r: JobSpec<unknown>): Shows => r.picture ? 'picture' : 'behaviour';

// a job asked for: not started yet (job null), or running with the bytes it read so far, as of the ROM generation gen
export interface JobRun<T> extends JobSpec<T>, Since {
  job: Job<T> | null;
  emu: LevelEmulator | null;
  label: string | null; // yielded
}

export interface RunnerDeps {
  rom: Rom;
  results: ResultCache;
  main?: LevelEmulator; // the booted emulator whose boot snapshot pictures start from (default: an own one)
  noDisplay?: LevelEmulator; // the one whose boot snapshot the others start from (default: an own one; its skip mask is set)
}

// a lane emulator's prepared state (result) under its key, with what preparing it read
interface Prepared extends Recorded<unknown> { key: string }

// where results are kept (the result cache or the runner's memory results)
interface KeptStore {
  get<T>(key: string, input?: string): T | undefined;
  entry(key: string, input?: string): { deps: RomDeps; data: unknown } | undefined;
  set(key: string, data: unknown, deps: RomDeps, input?: string): void;
}

export class JobRunner {
  private d: RunnerDeps;
  readonly memory: MemoryResults;
  private emus = new Map<string, LevelEmulator>(); // by lane
  private main: LevelEmulator | null = null; // own, without deps.main
  private gfxMask = perRomState(gfxSkipMask); // its skip mask
  private noDisplay: LevelEmulator | null = null; // own, without deps.noDisplay
  private pointerEmu: LevelEmulator | null = null; // learns the tilesets' pointers (tilesetPointers)
  private display = perRomState((rom) => gfxDisplaySkipMask(rom, this.tilesetPointers())); // displayMask
  private preps = new WeakMap<LevelEmulator, Prepared>(); // by emulator
  started = 0; // jobs (re)started

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.memory = memoryResults(deps.results.fp);
    if (deps.noDisplay) deps.noDisplay.skipMask = this.displayMask;
  }

  run<T>(spec: JobSpec<T>): JobRun<T> {
    return { ...spec, job: null, emu: null, reads: new RomReads(this.d.rom), gen: -1, label: null };
  }

  // Runs a step of the job (its first one: a stored result, else the job started on the lane's emulator); its
  // result when it ended, else null. The job starts over first when bytes it read changed since its last step.
  step<T>(lane: string, r: JobRun<T>): { result: T } | null {
    const rom = this.d.rom;
    if (r.job && !holds(rom, r)) r.job = null;
    if (!r.job) {
      // (stored meanwhile, or loaded from storage)
      const stored = r.whole === false ? undefined : this.stored<T>(r.key, r.input, r.keep);
      if (stored !== undefined) return { result: stored };
      const emu = r.emu = this.emu(lane, r.picture);
      r.reads = new RomReads(rom);
      r.label = null;
      r.job = r.start(emu, (key, prepare) => this.prepared(r, emu, key, prepare), (sub, input, learn) => this.part(r, emu, sub, input, learn));
      this.started++;
    }
    r.gen = rom.gen;
    const emu = r.emu!, job = r.job, t = emu.record(shows(r), () => job.next(), r.boot === false ? { base: null } : {});
    r.reads.add(t.reads);
    if (!t.result.done) {
      if (typeof t.result.value === 'string') r.label = t.result.value;
      return null;
    }
    r.job = null;
    if (!holds(rom, r)) return null; // (the job wrote bytes it read: again)
    if (t.result.value !== undefined && r.whole !== false) this.store(r.key, r.input, r.keep, t.result.value, r.reads);
    return { result: t.result.value };
  }

  // (inside a job's step)
  private prepared<S>(r: JobRun<unknown>, emu: LevelEmulator, key: string, prepare: () => S | null): S | null {
    const p = this.preps.get(emu);
    if (p?.key === key && holds(this.d.rom, p)) {
      emu.count(p.reads);
      return p.result as S;
    }
    this.preps.delete(emu);
    const t = emu.record(shows(r), prepare);
    if (t.result !== null) this.preps.set(emu, { ...t, key });
    return t.result;
  }

  // (inside a job's step)
  private part<S>(r: JobRun<unknown>, emu: LevelEmulator, sub: string, input: string | undefined, learn: () => S | undefined): { result: S | undefined; learned: boolean } {
    const key = partKey(r.key, sub), e = this.storeFor(r.keep)?.entry(key, input);
    if (e) {
      const reads = new RomReads(this.d.rom);
      reads.addDeps(e.deps);
      emu.count(reads);
      return { result: e.data as S, learned: false };
    }
    const t = emu.record(shows(r), learn, r.boot === false ? { base: null } : {});
    if (t.result !== undefined) this.store(key, input, r.keep, t.result, t.reads);
    return { result: t.result, learned: true };
  }

  // where results kept so go (none: not kept)
  private storeFor(keep: Keep): KeptStore | undefined {
    return keep === false ? undefined : keep === 'memory' ? this.memory : this.d.results;
  }

  stored<T>(key: string, input: string | undefined, keep: Keep): T | undefined {
    return this.storeFor(keep)?.get<T>(key, input);
  }

  store(key: string, input: string | undefined, keep: Keep, result: unknown, reads: RomReads): void {
    this.storeFor(keep)?.set(key, result, this.d.results.fp.deps(reads), input);
  }

  // the lane's emulator, set up from the boot snapshot for pictures or for results that are no pictures (noDisplayBoot)
  emu(lane: string, picture: boolean): LevelEmulator {
    const emu = this.fresh(this.emus.get(lane) ?? null, picture);
    this.emus.set(lane, emu);
    return emu;
  }

  private fresh(emu: LevelEmulator | null, picture: boolean): LevelEmulator {
    if (!picture) this.displayMask(); // (first: the pointers it needs are learned at once)
    const from = picture ? this.mainBoot() : this.noDisplayBoot();
    if (!emu || emu.rom !== this.d.rom) emu = new LevelEmulator(this.d.rom);
    emu.skipMask = picture ? () => from.skipMask?.() ?? null : this.displayMask;
    emu.adoptBoot(from.snapshot);
    return emu;
  }

  // The main boot snapshot: deps.main's, else an own one leaving out the GFX file data (gfxSkipMask) as the editor's
  private mainBoot(): LevelEmulator {
    if (this.d.main) return this.d.main;
    const rom = this.d.rom;
    if (!this.main || this.main.rom !== rom) {
      this.main = new LevelEmulator(rom);
      this.main.skipMask = () => this.gfxMask(rom);
    }
    this.main.ensureBoot();
    return this.main;
  }

  // The bytes results that are no pictures don't read: the display data (gfxDisplaySkipMask, with the tilesets'
  // pointers), the GFX file data among them; once per ROM state. Learning the pointers isn't part of the
  // result asking for the mask.
  displayMask = (): Uint8Array | null => this.display(this.d.rom);

  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts), learned once and kept in the result cache.
  // No picture, though learned from the main boot snapshot as pictures are: the boot snapshot of results that are
  // no pictures needs the mask, which needs these pointers. Their reads leave out the display data by themselves,
  // without the boot's reads (tilesetPointers). On an own emulator: the mask is asked for while the lanes' run.
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
  // display data (a title screen's tile or color isn't read by every such result). Booted on its own emulator, again
  // when what it read changed (a display edit too: the state holds the title screen's colors).
  private noDisplayBoot(): LevelEmulator {
    let e = this.d.noDisplay ?? this.noDisplay;
    if (!e || e.rom !== this.d.rom) {
      this.noDisplay = e = new LevelEmulator(this.d.rom);
      e.skipMask = this.displayMask;
    }
    e.ensureBoot();
    return e;
  }
}

// results kept in memory only (keep: 'memory'), the latest used keys (MEMORY); checked against the ROM like the result
// cache's, a key keeping the results of its latest used INPUTS_PER_KEY inputs as there, each on the latest
// MEMORY_CONTENTS ROM states it was made on (an undo finds the result before the edit, the client asks no job)
export type MemoryResults = KeptResults<RomDeps>;
export const memoryResults = (fp: RomFingerprint, limit = MEMORY): MemoryResults => new KeptResults({ validity: byFingerprint(fp), limit, contents: MEMORY_CONTENTS });
