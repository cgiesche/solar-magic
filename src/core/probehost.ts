// Runs block/sprite probes (blockprobe.ts) as a queue of jobs on its own copy of the ROM, so they
// can run in a Web Worker (ui/probeworker.ts) instead of the editor's main thread. Each finished
// job hands back the result cache entries it made (key, data and the ROM pages it read); the
// editor stores them in its own ResultCache, where they are checked against the ROM like any other.

import { Rom } from './rom.ts';
import { BlockProber, blockKey, collisionKey, spriteKey, runsKey } from './blockprobe.ts';
import { gfxSkipMask } from './gfxpages.ts';
import type { CacheEntry } from './romdeps.ts';

// job keys: Map16 tile; sprites as PROBE_SPRITE | num, collision as PROBE_COLL | tile, Mario's
// run speeds as PROBE_RUNS
export const PROBE_SPRITE = 0x10000;
export const PROBE_COLL = 0x20000;
export const PROBE_RUNS = 0x40000;

export interface ProbeJob { ts: number; k: number }

export interface ProbeDone {
  gen: number; // ROM generation the job ran on (see setRom)
  job: ProbeJob;
  put: [string, CacheEntry][]; // new result cache entries
  failed: boolean;
}

// what the editor sends: the ROM (again after each change), jobs asked for, the prefetch queue
export type ProbeMessage =
  | { type: 'rom'; gen: number; data: Uint8Array }
  | { type: 'ask'; jobs: ProbeJob[] }
  | { type: 'prefetch'; jobs: ProbeJob[] };

export const jobId = (j: ProbeJob) => `${j.ts}:${j.k}`;

// the result cache key of a job's result
export function jobKey({ ts, k }: ProbeJob): string {
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

  // the ROM changed (gen: the editor's count of changes); queued jobs are dropped
  setRom(gen: number, data: Uint8Array): void {
    this.gen = gen;
    this.asked.clear();
    this.prefetch.clear();
    if (!this.rom || !this.prober) {
      this.rom = new Rom(new Uint8Array(0));
      this.rom.data = data;
      this.prober = new BlockProber(this.rom);
      const emu = this.prober.emu, rom = this.rom;
      // ROM bytes of GFX file data: emulated results don't depend on them (see App.gfxSkipMask)
      emu.skipMask = () => {
        if (this.mask.gen !== emu.romGen) this.mask = { gen: emu.romGen, mask: gfxSkipMask(rom) };
        return this.mask.mask;
      };
      return;
    }
    this.rom.data = data;
    this.prober.reset(); // syncs the emulator's ROM
  }

  handle(m: ProbeMessage): void {
    if (m.type === 'rom') this.setRom(m.gen, m.data);
    else if (m.type === 'ask') this.ask(m.jobs);
    else this.setPrefetch(m.jobs);
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

  get pending(): number { return this.asked.size + this.prefetch.size; }

  // runs the next job; null when there is none
  next(): ProbeDone | null {
    const p = this.prober;
    const q = this.asked.size ? this.asked : this.prefetch;
    const [id, job] = q.entries().next().value ?? [];
    if (!p || !id || !job) return null;
    q.delete(id);
    let failed = false;
    try {
      p.use(job.ts);
      const k = job.k;
      if (k & PROBE_RUNS) p.runStates();
      else if (k & PROBE_SPRITE) p.probeSprite(k & 0x3ff);
      else if (k & PROBE_COLL) p.probeCollision(k & 0xffff);
      else p.probe(k);
    } catch (e) {
      console.error(e);
      failed = true;
    }
    return { gen: this.gen, job, put: p.results.flush().put, failed };
  }
}
