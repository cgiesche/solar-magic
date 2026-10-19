// Runs block/sprite probes (blockprobe.ts) as a queue of jobs on its own copy of the ROM, so they
// can run in a Web Worker (ui/probeworker.ts) instead of the editor's main thread. Each finished
// job hands back the result cache entries it made (key, data and the ROM pages it read); the
// editor stores them in its own ResultCache, where they are checked against the ROM like any other.
// Longer tasks run here too, a slice at a time between the probes: the object kinds of a
// tileset (objkinds.ts), the level scan (levelscan.ts) and the camera at Mario standing at a place
// (camerareach.ts).

import { Rom } from './rom.ts';
import { BlockProber, blockKey, collisionKey, spriteKey, runsKey, cameraKey } from './blockprobe.ts';
import { gfxSkipMask } from './gfxpages.ts';
import { RomReads, type CacheEntry } from './romdeps.ts';
import { LevelEmulator } from './levelemu.ts';
import { ObjKindProbe, kindsKey, type KindLevel } from './objkinds.ts';
import { levelScanJob, type ScanLevel, type ScanResult } from './levelscan.ts';
import { cameraAtJob } from './camerareach.ts';

// job keys: Map16 tile; sprites as PROBE_SPRITE | num, collision as PROBE_COLL | tile, Mario's
// run speeds as PROBE_RUNS, the game view's scroll bands as PROBE_CAMERA
export const PROBE_SPRITE = 0x10000;
export const PROBE_COLL = 0x20000;
export const PROBE_RUNS = 0x40000;
export const PROBE_CAMERA = 0x80000;

export interface ProbeJob { ts: number; k: number }

export interface ProbeDone {
  type: 'probe';
  gen: number; // ROM generation the job ran on (see setRom)
  job: ProbeJob;
  put: [string, CacheEntry][]; // new result cache entries
  failed: boolean;
}

// the object kinds of tileset ts, with their result cache entry (none: the probe failed)
export interface KindsDone { type: 'kinds'; gen: number; ts: number; failed: boolean; put: [string, CacheEntry][] }
// a level scan (id: the editor's request; result null: it failed), with its result cache entry
export interface ScanDone { type: 'scan'; gen: number; id: number; result: ScanResult | null; put: [string, CacheEntry][] }
// the camera at Mario standing at a place (id: the editor's request; result null: it failed), with its result cache entry
export interface CameraDone { type: 'camera'; gen: number; id: number; result: { x: number; y: number } | null; put: [string, CacheEntry][] }
export type ProbeReply = ProbeDone | KindsDone | ScanDone | CameraDone;

// what the editor sends: the ROM (again after each change), jobs asked for, the prefetch queue,
// the longer tasks (a new one replaces the running one of its type)
export type ProbeMessage =
  | { type: 'rom'; gen: number; data: Uint8Array }
  | { type: 'ask'; jobs: ProbeJob[] }
  | { type: 'prefetch'; jobs: ProbeJob[] }
  | { type: 'kinds'; ts: number; level: KindLevel; layer2Pointer: number }
  | { type: 'scan'; id: number; key: string; level: ScanLevel }
  | { type: 'camera'; id: number; key: string; level: ScanLevel; x: number; y: number };

export const jobId = (j: ProbeJob) => `${j.ts}:${j.k}`;

type TaskType = 'kinds' | 'scan' | 'camera';

// the result cache key of a job's result
export function jobKey({ ts, k }: ProbeJob): string {
  if (k & PROBE_CAMERA) return cameraKey(ts);
  if (k & PROBE_RUNS) return runsKey(ts);
  if (k & PROBE_SPRITE) return spriteKey(ts, k & 0x3ff);
  if (k & PROBE_COLL) return collisionKey(ts, k & 0xffff);
  return blockKey(ts, k);
}

export class ProbeHost {
  private rom: Rom | null = null;
  private prober: BlockProber | null = null;
  private gen = -1;
  private mask: { gen: number; mask: Uint8Array | null } = { gen: -1, mask: null };
  private asked = new Map<string, ProbeJob>(); // requested directly: first
  private prefetch = new Map<string, ProbeJob>();
  private tasks = new Map<TaskType, Generator<void, ProbeReply>>(); // taking turns
  private emus = new Map<TaskType, LevelEmulator>();

  // the ROM changed (gen: the editor's count of changes); queued jobs are dropped
  setRom(gen: number, data: Uint8Array): void {
    this.gen = gen;
    this.asked.clear();
    this.prefetch.clear();
    this.tasks.clear();
    if (!this.rom || !this.prober) {
      this.rom = new Rom(new Uint8Array(0));
      this.rom.data = data;
      this.prober = new BlockProber(this.rom);
      const emu = this.prober.emu, rom = this.rom;
      // ROM bytes of GFX file data: emulated results don't depend on them (see App.gfxSkipMask)
      emu.skipMask = () => {
        if (this.mask.gen !== rom.gen) this.mask = { gen: rom.gen, mask: gfxSkipMask(rom) };
        return this.mask.mask;
      };
      return;
    }
    this.rom.data = data;
    this.prober.reset(); // probe levels that read changed pages are prepared again
  }

  handle(m: ProbeMessage): void {
    if (m.type === 'rom') this.setRom(m.gen, m.data);
    else if (m.type === 'ask') this.ask(m.jobs);
    else if (m.type === 'prefetch') this.setPrefetch(m.jobs);
    else if (m.type === 'kinds') this.startTask('kinds', this.kindsTask(m.ts, m.level, m.layer2Pointer));
    else if (m.type === 'scan') this.startTask('scan', this.scanTask(m.id, m.key, m.level));
    else this.startTask('camera', this.cameraTask(m.id, m.key, m.level, m.x, m.y));
  }

  private startTask(type: TaskType, task: Generator<void, ProbeReply>): void {
    if (!this.prober) return;
    this.tasks.delete(type);
    this.tasks.set(type, task);
  }

  // an own emulator per task type (the prober's keeps its prepared probe levels), from the
  // prober's boot snapshot once there is one
  private emu(type: TaskType): LevelEmulator {
    const p = this.prober!;
    let e = this.emus.get(type);
    if (!e) {
      e = new LevelEmulator(this.rom!);
      e.skipMask = p.emu.skipMask;
      this.emus.set(type, e);
    }
    if (!e.baseState && p.emu.baseState) e.adoptBoot(p.emu);
    return e;
  }

  private *kindsTask(ts: number, level: KindLevel, layer2Pointer: number): Generator<void, ProbeReply> {
    const p = this.prober!;
    let failed = true;
    try {
      const probe = new ObjKindProbe(this.emu('kinds'), { ...level, header: { ...level.header, tileset: ts } }, layer2Pointer);
      while (!probe.done) { probe.step(); yield; }
      p.results.set(kindsKey(ts), probe.result(), p.results.fp.deps(probe.reads()));
      failed = false;
    } catch (e) {
      console.error(e);
    }
    return { type: 'kinds', gen: this.gen, ts, failed, put: p.results.flush().put };
  }

  private *scanTask(id: number, key: string, level: ScanLevel): Generator<void, ProbeReply> {
    const result: ScanResult | null = yield* this.played('scan', key, (emu) => levelScanJob(emu, level));
    return { type: 'scan', gen: this.gen, id, result, put: this.prober!.results.flush().put };
  }

  private *cameraTask(id: number, key: string, level: ScanLevel, x: number, y: number): Generator<void, ProbeReply> {
    const result = yield* this.played('camera', key, (emu) => cameraAtJob(emu, level, x, y));
    return { type: 'camera', gen: this.gen, id, result, put: this.prober!.results.flush().put };
  }

  // runs a job on the task type's emulator, its result (not null) into the result cache under key with the
  // ROM bytes it read; null when it failed
  private *played<T>(type: TaskType, key: string, make: (emu: LevelEmulator) => Generator<void, T | null>): Generator<void, T | null> {
    const p = this.prober!, emu = this.emu(type);
    try {
      const job = make(emu), reads = new RomReads(this.rom!.data.length);
      for (;;) {
        const r = emu.tracked(() => job.next());
        reads.add(r.reads);
        if (r.result.done) {
          if (r.result.value !== null) p.results.set(key, r.result.value, p.results.fp.deps(reads));
          return r.result.value;
        }
        yield;
      }
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // queues jobs asked for directly (before all prefetched ones)
  ask(jobs: ProbeJob[]): void {
    for (const j of jobs) {
      const id = jobId(j);
      this.prefetch.delete(id);
      this.asked.set(id, j);
    }
  }

  // replaces the prefetch queue
  setPrefetch(jobs: ProbeJob[]): void {
    this.prefetch = new Map(jobs.map((j) => [jobId(j), j]));
    for (const id of this.asked.keys()) this.prefetch.delete(id);
  }

  get pending(): number { return this.asked.size + this.tasks.size + this.prefetch.size; }

  // runs the next job (asked probes, then a slice of a longer task, then prefetched probes); null
  // when nothing finished
  next(): ProbeReply | null {
    if (!this.asked.size && this.tasks.size) {
      const [type, task] = this.tasks.entries().next().value!;
      this.tasks.delete(type);
      const r = task.next();
      if (r.done) return r.value;
      this.tasks.set(type, task); // (the other task's turn next)
      return null;
    }
    const p = this.prober;
    const q = this.asked.size ? this.asked : this.prefetch;
    const [id, job] = q.entries().next().value ?? [];
    if (!p || !id || !job) return null;
    q.delete(id);
    let failed = false;
    try {
      p.use(job.ts);
      const k = job.k;
      if (k & PROBE_CAMERA) p.cameraBands();
      else if (k & PROBE_RUNS) p.runStates();
      else if (k & PROBE_SPRITE) p.probeSprite(k & 0x3ff);
      else if (k & PROBE_COLL) p.probeCollision(k & 0xffff);
      else p.probe(k);
    } catch (e) {
      console.error(e);
      failed = true;
    }
    const put = p.results.flush().put, key = jobKey(job);
    // a result found in this cache is handed back too: the editor may have dropped it when it came
    // (computed on an older ROM generation) and would otherwise ask for it again and again
    const e = !failed && !put.some(([k]) => k === key) ? p.results.entry(key) : undefined;
    if (e) put.push([key, e]);
    return { type: 'probe', gen: this.gen, job, put, failed };
  }
}
