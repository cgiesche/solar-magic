// Runs block/sprite probes (blockprobe.ts) as a queue of jobs on its own copy of the ROM, so they
// can run in a Web Worker (ui/probeworker.ts) instead of the editor's main thread. Each finished
// job hands back the result cache entries it made (key, data, input and the ROM pages it read); the
// editor stores them in its own ResultCache, where they are checked against the ROM like any other.
// Longer tasks run here too, as jobs of the job runner (jobrunner.ts) a step at a time between the probes: the object
// kinds of a tileset (objkinds.ts), the level scan (levelscan.ts) and the camera at Mario standing at a place
// (camerareach.ts). A task the editor no longer wants is kept without running; asked for again with the same
// result, it goes on where it stood.
// After the first copy of the ROM the editor sends the ranges a change wrote: queued jobs stay, a task starts over
// before its next step only when it read a changed byte, results are checked against the ROM as always.

import { Rom } from './rom.ts';
import { BlockProber } from './blockprobe.ts';
import { storeKey, type CacheEntry } from './romdeps.ts';
import { JobRunner, type Job, type JobRun } from './jobrunner.ts';
import { objKindsJob, kindsKey } from './objkinds.ts';
import { levelScanJob, type ScanResult } from './levelscan.ts';
import { cameraAtJob, type CameraAt } from './camerareach.ts';
import { jobId, jobKey, type ProbeJob, type ProbeMessage, type ProbeReply, type TaskMessage, type TaskType } from './probeprotocol.ts';

// a longer task: what was asked (a request asking for the same result may have replaced it) and its job
interface Task { msg: TaskMessage; run: JobRun<unknown> }

// a task's job (none of them is a picture); one that finds nothing (null) gives undefined, which isn't kept
function taskJob(m: TaskMessage): JobRun<unknown>['start'] {
  switch (m.type) {
    case 'kinds': return (emu) => objKindsJob(emu, { ...m.level, header: { ...m.level.header, tileset: m.ts } }, m.layer2Pointer);
    case 'scan': return (emu) => found(levelScanJob(emu, m.level));
    case 'camera': return (emu) => found(cameraAtJob(emu, m.level, m.x, m.y));
  }
}
function* found<T>(job: Generator<void, T | null>): Job<T | undefined> { return (yield* job) ?? undefined; }

// the result cache key of a task's result
const taskKey = (m: TaskMessage) => (m.type === 'kinds' ? kindsKey(m.ts) : m.key);

export class ProbeHost {
  private rom: Rom | null = null;
  private prober: BlockProber | null = null;
  private runner: JobRunner | null = null;
  private gen = -1;
  private asked = new Map<string, ProbeJob>(); // requested directly: first
  private prefetch = new Map<string, ProbeJob>();
  private tasks = new Map<TaskType, Task>(); // taking turns
  // cancelled tasks, not run: taken up again when the same result is asked for before another task of their type
  // (which would use their emulator)
  private cancelled = new Map<TaskType, Task>();

  // tasks' jobs (re)started
  get started(): number { return this.runner?.started ?? 0; }

  // a new ROM (gen: the editor's count of changes); queued jobs and tasks are dropped
  setRom(gen: number, data: Uint8Array): void {
    this.gen = gen;
    this.asked.clear();
    this.prefetch.clear();
    this.tasks.clear();
    this.cancelled.clear();
    if (!this.rom || !this.prober) {
      const rom = this.rom = new Rom(new Uint8Array(0));
      rom.data = data;
      this.prober = new BlockProber(rom);
      // the tasks' emulators start from the prober's boot snapshot, which leaves out the display data as the probes
      // do (ADR 0008): the prober's emulator gets the runner's mask (gfxDisplaySkipMask)
      this.runner = new JobRunner({ rom, results: this.prober.results, noDisplay: this.prober.emu });
      return;
    }
    this.rom.data = data;
    this.prober.reset(); // probe levels that read changed pages are prepared again
    this.keepHolding();
  }

  // Result cache entries set and not handed back yet (by a task's step: the tilesets' pointers) were hashed on the
  // ROM before a change, but go with a reply of the new one, which the editor takes unchecked: kept only if they hold.
  private keepHolding(): void {
    const results = this.prober!.results;
    results.setAll(results.flush().put.filter(([, e]) => results.fp.valid(e.deps)), true);
  }

  // The ROM changed (gen) by the bytes written at these offsets, to this size: queued jobs and tasks stay (a task that
  // read a changed byte starts over before its next step). A new size is a new ROM (the emulators would go on with
  // the old one).
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
    for (const [at, b] of edits) rom.writeAt(at, b);
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

  // the task of that type is not wanted any more: it runs no further step (kept, see startTask)
  private cancel(type: TaskType): void {
    const t = this.tasks.get(type);
    if (!t) return;
    this.tasks.delete(type);
    this.cancelled.set(type, t);
  }

  // a task asked for: replaces the running one of its type, unless that one or the cancelled one finds the same result
  // (it answers this request then, going on where it stood)
  private startTask(msg: TaskMessage): void {
    if (!this.runner) return;
    const t = this.tasks.get(msg.type) ?? this.cancelled.get(msg.type);
    this.cancelled.delete(msg.type);
    if (t && taskKey(t.msg) === taskKey(msg)) { t.msg = msg; this.tasks.set(msg.type, t); return; }
    const run = this.runner.run({ key: taskKey(msg), keep: true, picture: false, boot: msg.type !== 'kinds', start: taskJob(msg) });
    this.tasks.delete(msg.type);
    this.tasks.set(msg.type, { msg, run });
  }

  // a finished task's reply (result null: it failed), answering its latest request
  private taskDone(t: Task, result: unknown): ProbeReply {
    const m = t.msg, put = this.put(result === null ? null : t.run.key, t.run.input);
    switch (m.type) {
      case 'kinds': return { type: 'kinds', gen: this.gen, ts: m.ts, failed: result === null, put };
      case 'scan': return { type: 'scan', gen: this.gen, id: m.id, result: result as ScanResult | null, put };
      case 'camera': return { type: 'camera', gen: this.gen, id: m.id, result: result as CameraAt | null, put };
    }
  }

  // the result cache entries set since the last reply, with the one under key and input while it holds: a result found
  // in this cache is handed back too (the editor may have dropped it when it came, computed on an older ROM
  // generation, and would otherwise ask for it again and again)
  private put(key: string | null, input?: string): [string, CacheEntry][] {
    const results = this.prober!.results, put = results.flush().put, e = key === null ? undefined : results.entry(key, input);
    if (!e) return put;
    const k = storeKey(key!, input);
    return [...put.filter(([s]) => s !== k), [k, e]];
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
      let r: { result: unknown } | null;
      try { r = this.runner!.step(type, task.run); } catch (e) { console.error(e); r = { result: null }; }
      if (r) return this.taskDone(task, r.result ?? null);
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
    return { type: 'probe', gen: this.gen, job, put: this.put(failed ? null : jobKey(job)), failed };
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
