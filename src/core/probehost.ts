// Runs block/sprite probes (blockprobe.ts) as a queue of jobs on its own copy of the ROM, so they
// can run in a Web Worker (ui/probeworker.ts) instead of the editor's main thread. Each finished
// job hands back the result cache entries it made (key, data and the ROM pages it read); the
// editor stores them in its own ResultCache, where they are checked against the ROM like any other.
// Longer tasks run here too, a slice at a time between the probes: the object kinds of a
// tileset (objkinds.ts), the level scan (levelscan.ts) and the camera at Mario standing at a place
// (camerareach.ts). A task the editor no longer wants is kept without running; asked for again with the same
// result, it goes on where it stood.
// After the first copy of the ROM the editor sends the ranges a change wrote: queued jobs stay, a running
// task starts over only when it read a changed byte, results are checked against the ROM as always.

import { Rom, type RomRange } from './rom.ts';
import { BlockProber } from './blockprobe.ts';
import { gfxDisplaySkipMask } from './gfxpages.ts';
import { TILESETS, tilesetPointers, pointersKey } from './tilesets.ts';
import { RomReads, type CacheEntry } from './romdeps.ts';
import { LevelEmulator } from './levelemu.ts';
import { ObjKindProbe, kindsKey, type KindLevel } from './objkinds.ts';
import { levelScanJob } from './levelscan.ts';
import { cameraAtJob } from './camerareach.ts';
import { jobId, jobKey, type ProbeJob, type ProbeMessage, type ProbeReply, type TaskMessage, type TaskType } from './probeprotocol.ts';

// the result cache key of a task's result
const taskKey = (m: TaskMessage) => (m.type === 'kinds' ? kindsKey(m.ts) : m.key);

// a longer task: what was asked, its slices (how it ended) and the ROM bytes it read so far
interface Task { msg: TaskMessage; run: Generator<void, TaskEnd>; reads: () => RomReads | null }
// a finished task's result (null: failed) and its reply, with the ROM generation and result cache entries
interface TaskEnd { result: unknown; reply: (gen: number, put: [string, CacheEntry][]) => ProbeReply }

export class ProbeHost {
  private rom: Rom | null = null;
  private prober: BlockProber | null = null;
  private gen = -1;
  private mask: { gen: number; mask: Uint8Array | null } = { gen: -1, mask: null };
  private asked = new Map<string, ProbeJob>(); // requested directly: first
  private prefetch = new Map<string, ProbeJob>();
  private tasks = new Map<TaskType, Task>(); // taking turns
  // cancelled tasks, not run: taken up again when the same result is asked for before another task of their type
  // (which would use their emulator)
  private cancelled = new Map<TaskType, Task>();
  private emus = new Map<TaskType, LevelEmulator>();
  private ptrEmu: LevelEmulator | null = null; // learns the tilesets' Map16 pointers (pointers())
  started = 0; // tasks (re)started

  // a new ROM (gen: the editor's count of changes); queued jobs and tasks are dropped
  setRom(gen: number, data: Uint8Array): void {
    this.gen = gen;
    this.asked.clear();
    this.prefetch.clear();
    this.tasks.clear();
    this.cancelled.clear();
    if (!this.rom || !this.prober) {
      this.rom = new Rom(new Uint8Array(0));
      this.rom.data = data;
      this.prober = new BlockProber(this.rom);
      const emu = this.prober.emu, rom = this.rom;
      // ROM bytes of GFX file and ExAnimation data and the display data (Map16 quarters, colors): what blocks do
      // doesn't depend on them (see gfxDisplaySkipMask)
      emu.skipMask = () => {
        if (this.mask.gen !== rom.gen) this.mask = { gen: rom.gen, mask: gfxDisplaySkipMask(rom, this.pointers()) };
        return this.mask.mask;
      };
      return;
    }
    this.rom.data = data;
    this.prober.reset(); // probe levels that read changed pages are prepared again
    this.keepHolding();
  }

  // Result cache entries set and not handed back yet (by a task's slice: the tilesets' pointers) were hashed on the
  // ROM before a change, but go with a reply of the new one, which the editor takes unchecked: kept only if they hold.
  private keepHolding(): void {
    const results = this.prober!.results;
    results.setAll(results.flush().put.filter(([, e]) => results.fp.valid(e.deps)), true);
  }

  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts), as the editor learns them (ResultLearner.tilesetPointers):
  // kept in the result cache. Learned on an own emulator, as the mask is asked for while the prober's emulator runs (and
  // what learning them reads isn't a dependency of that run); tilesetPointers leaves out the display data itself
  private pointers(): number[][] {
    const rom = this.rom!, results = this.prober!.results, reads = rom.reads;
    rom.reads = null;
    try {
      return Array.from({ length: TILESETS }, (_, ts) => {
        const known = results.get<number[]>(pointersKey(ts));
        if (known) return known;
        const { result, reads: r } = tilesetPointers(this.ptrEmu ??= new LevelEmulator(rom), ts);
        results.set(pointersKey(ts), result, results.fp.deps(r));
        return result;
      });
    } finally { rom.reads = reads; }
  }

  // The ROM changed (gen) by the bytes written at these offsets, to this size: queued jobs stay, a task that read
  // a changed byte starts over. A new size is a new ROM (the emulators would go on with the old one).
  edit(gen: number, size: number, edits: [number, Uint8Array][]): void {
    const rom = this.rom;
    if (!rom || !this.prober) return;
    if (rom.size !== size) {
      const data = new Uint8Array(size);
      data.set(rom.data.subarray(0, Math.min(size, rom.size)));
      for (const [at, b] of edits) data.set(b.subarray(0, Math.max(0, size - at)), at);
      this.setRom(gen, data);
      return;
    }
    this.gen = gen;
    const ranges: RomRange[] = [];
    for (const [at, b] of edits) {
      rom.writeAt(at, b);
      ranges.push([at, at + b.length]);
    }
    for (const t of [...this.tasks.values(), ...this.cancelled.values()]) if (t.reads()?.touches(ranges)) this.begin(t);
    this.prober.reset();
    this.keepHolding();
  }

  handle(m: ProbeMessage): void {
    switch (m.type) {
      case 'rom': this.setRom(m.gen, m.data); break;
      case 'edit': this.edit(m.gen, m.size, m.edits); break;
      case 'ask': this.ask(m.jobs); break;
      case 'prefetch': this.setPrefetch(m.jobs); break;
      case 'cancel': this.cancel(m.task); break;
      case 'kinds': case 'scan': case 'camera': this.startTask(m); break;
    }
  }

  // the task of that type is not wanted any more: it runs no further slice (kept, see startTask)
  private cancel(type: TaskType): void {
    const t = this.tasks.get(type);
    if (!t) return;
    this.tasks.delete(type);
    this.cancelled.set(type, t);
  }

  // a task asked for: replaces the running one of its type, unless that one or the cancelled one finds the same result
  // (it answers this request then, going on where it stood)
  private startTask(msg: TaskMessage): void {
    if (!this.prober) return;
    const t = this.tasks.get(msg.type) ?? this.cancelled.get(msg.type);
    this.cancelled.delete(msg.type);
    if (t && taskKey(t.msg) === taskKey(msg)) { t.msg = msg; this.tasks.set(msg.type, t); return; }
    const task: Task = { msg, run: this.run(msg, () => task), reads: () => null };
    this.started++;
    this.tasks.delete(msg.type);
    this.tasks.set(msg.type, task);
  }

  // (re)starts a task's slices
  private begin(t: Task): void {
    t.reads = () => null;
    t.run = this.run(t.msg, () => t);
    this.started++;
  }

  // a task's slices and how it ends (the task, for what it read so far, is taken when they start); the reply
  // answers the task's message when it ends (a request asking for the same result may have replaced it)
  private *run(m: TaskMessage, task: () => Task): Generator<void, TaskEnd> {
    const t = task();
    switch (m.type) {
      case 'kinds': {
        const result = yield* this.kindsTask(t, m.ts, m.level, m.layer2Pointer);
        return { result, reply: (gen, put) => ({ type: 'kinds', gen, ts: m.ts, failed: result === null, put }) };
      }
      case 'scan': {
        const result = yield* this.played(t, (emu) => levelScanJob(emu, m.level)), { id } = t.msg as typeof m;
        return { result, reply: (gen, put) => ({ type: 'scan', gen, id, result, put }) };
      }
      case 'camera': {
        const result = yield* this.played(t, (emu) => cameraAtJob(emu, m.level, m.x, m.y)), { id } = t.msg as typeof m;
        return { result, reply: (gen, put) => ({ type: 'camera', gen, id, result, put }) };
      }
    }
  }

  // a finished task's reply, with its result cache entry
  private taskDone(t: Task, { result, reply }: TaskEnd): ProbeReply {
    const p = this.prober!, key = taskKey(t.msg), put = p.results.flush().put;
    const e = result !== null && !put.some(([k]) => k === key) ? p.results.entry(key) : undefined;
    if (e) put.push([key, e]);
    return reply(this.gen, put);
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

  // the object kinds of tileset ts (a stored result while it holds); null when they could not be found
  private *kindsTask(t: Task, ts: number, level: KindLevel, layer2Pointer: number): Generator<void, unknown> {
    const p = this.prober!, key = kindsKey(ts), known = p.results.get(key);
    if (known !== undefined) return known;
    try {
      const probe = new ObjKindProbe(this.emu('kinds'), { ...level, header: { ...level.header, tileset: ts } }, layer2Pointer);
      t.reads = () => probe.reads();
      while (!probe.done) { probe.step(); yield; }
      const r = probe.result();
      p.results.set(key, r, p.results.fp.deps(probe.reads()));
      return r;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // runs a job on the task type's emulator, its result (not null) into the result cache under the task's key
  // with the ROM bytes it read; a stored result while it holds; null when it failed
  private *played<T>(t: Task, make: (emu: LevelEmulator) => Generator<void, T | null>): Generator<void, T | null> {
    const p = this.prober!, key = taskKey(t.msg), known = p.results.get(key);
    if (known !== undefined) return known as T;
    const emu = this.emu(t.msg.type);
    try {
      const job = make(emu), reads = new RomReads(this.rom!.data.length);
      t.reads = () => reads;
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
      const r = task.run.next();
      if (r.done) return this.taskDone(task, r.value);
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
      switch (job.kind) {
        case 'block': p.probe(job.tile); break;
        case 'collision': p.probeCollision(job.tile); break;
        case 'sprite': p.probeSprite(job.num); break;
        case 'runs': p.runStates(); break;
        case 'bands': p.cameraBands(job.mode, job.vscroll); break;
      }
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

// how a pump waits for its next turn (run: the turn), and a turn's start, giving whether another job fits in it
export interface PumpSchedule { wait(run: () => void): void; startTurn(): () => boolean }

// Drives a host: each turn runs its jobs while there is work and the turn lasts, hands the replies on and waits
// for the next turn while work is left. Returns where the editor's messages go (the work they make is scheduled).
export function pumpProbes(host: ProbeHost, reply: (d: ProbeReply) => void, schedule: PumpSchedule): (m: ProbeMessage) => void {
  let scheduled = false;
  const run = () => {
    scheduled = false;
    const more = schedule.startTurn();
    do {
      const d = host.next();
      if (d) reply(d);
    } while (host.pending && more());
    later();
  };
  const later = () => {
    if (scheduled || !host.pending) return;
    scheduled = true;
    schedule.wait(run);
  };
  return (m) => { host.handle(m); later(); };
}
