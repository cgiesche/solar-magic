// The editor's side of the probes (probehost.ts): asks for block, collision and sprite probes and
// Mario's run speeds in the current tileset, prefetches what the palettes can show, and runs the
// object kinds and level scan, all in the probe worker. It sends the ROM again after a change
// (the worker drops its queue then) together with everything still wanted, and falls back to
// probing on the main thread in background slices when the worker fails. Results go to the
// editor's ResultCache, also those from before a ROM change: they hold while the ROM bytes they read
// are unchanged.

import { ProbeHost, PROBE_SPRITE, PROBE_COLL, PROBE_RUNS, jobId, jobKey, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply, type KindsDone, type ScanDone } from './probehost.ts';
import type { ResultCache } from './romdeps.ts';
import type { BlockProbe, CollisionProbe, SpriteProbe, RunStates } from './blockprobe.ts';
import { kindsStillValid, type ObjKinds, type KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';

export const SPRITE_PROBE_END = 0xc9; // sprites from $C9 on are shooters, generators and run-once sprites
const SLICE = 12; // ms the main thread probes at a time without a worker

type Send = (m: ProbeMessage) => void;

export interface ProbeClientDeps {
  results: ResultCache;
  cacheReady: Promise<void>; // stored results are loaded
  rom(): { gen: number; data: Uint8Array }; // the current ROM and its count of changes
  tileset(): number; // the tileset probes are asked for
  // starts the worker (replies go to reply, failed() once it broke down); null or a throw: none
  connect?(reply: (d: ProbeReply) => void, failed: () => void): Send | null;
  later(key: string, step: () => void): void; // a background slice on the main thread
  setBusy(key: 'probe' | 'kinds' | 'scan', label: string | null): void;
  ready(): void; // the asked or the prefetched probes are all done
}

export class ProbeClient {
  private send: Send | null = null;
  private gen = -1; // ROM generation the worker probes on
  private asked = new Map<string, ProbeJob>(); // asked for and not done yet
  private prefetched = new Map<string, ProbeJob>(); // the same, probed after the asked ones
  private failed = new Set<string>();
  private kindsWant: { msg: ProbeMessage & { type: 'kinds' }; done: (k: ObjKinds | null) => void } | null = null;
  private scanWant: { msg: ProbeMessage & { type: 'scan' }; done: (r: ScanResult | null) => void } | null = null;
  private d: ProbeClientDeps;

  constructor(deps: ProbeClientDeps) { this.d = deps; }

  // What a Map16 tile does when hit from below, how Mario collides with it, what a sprite id does
  // (normal sprites only, not shooters/generators): undefined while unknown, then asked for
  block(tile: number): BlockProbe | undefined { return this.probed(tile); }
  collision(tile: number): CollisionProbe | undefined { return this.probed(PROBE_COLL | tile); }
  sprite(num: number): SpriteProbe | undefined {
    return probeable(num) ? this.probed(PROBE_SPRITE | num) : undefined;
  }
  // Mario's run speeds; null when they could not be found
  runSpeeds(): RunStates | null | undefined {
    const r = this.probed<RunStates>(PROBE_RUNS);
    return r === undefined && this.failed.has(jobId({ ts: this.d.tileset(), k: PROBE_RUNS })) ? null : r;
  }

  private probed<T>(k: number): T | undefined {
    const job = { ts: this.d.tileset(), k };
    const p = this.d.results.get<T>(jobKey(job));
    if (p === undefined) this.ask(job);
    return p;
  }

  private ask(job: ProbeJob): void {
    this.sync();
    const id = jobId(job);
    if (this.failed.has(id) || this.asked.has(id)) return;
    this.asked.set(id, job);
    this.prefetched.delete(id);
    this.busy();
    // (stored results first: the job may be known by then)
    this.d.cacheReady.then(() => {
      if (this.d.results.get(jobKey(job)) === undefined) this.send?.({ type: 'ask', jobs: [job] });
      else this.probeDone({ type: 'probe', gen: this.gen, job, put: [], failed: false });
    });
  }

  // Probes everything the palette tabs can show (Map16 tiles 000-1FF plus `tiles`, all sprites) in
  // the background, after what is asked for directly; results go to the cache, so this runs once
  // per tileset and ROM state.
  prefetch(tiles: Iterable<number> = []): void {
    this.d.cacheReady.then(() => {
      this.sync();
      const ts = this.d.tileset();
      // (the queue of another tileset is dropped)
      const jobs = new Map([...this.prefetched].filter(([, j]) => j.ts === ts));
      const add = (k: number) => {
        const job = { ts, k }, id = jobId(job);
        if (!this.failed.has(id) && !this.asked.has(id) && this.d.results.get(jobKey(job)) === undefined) jobs.set(id, job);
      };
      for (const t of tiles) add(t);
      for (let t = 0; t < 0x200; t++) add(t);
      for (let n = 0; n < SPRITE_PROBE_END; n++) add(PROBE_SPRITE | n);
      if (!jobs.size && !this.prefetched.size) return;
      this.prefetched = jobs;
      this.send?.({ type: 'prefetch', jobs: [...jobs.values()] });
      this.busy();
    });
  }

  // The object kinds of tileset ts, found with a level (replaces a request still running); done
  // gets null when the probe failed
  requestKinds(ts: number, level: KindLevel, layer2Pointer: number, done: (k: ObjKinds | null) => void): void {
    this.sync();
    this.kindsWant = { msg: { type: 'kinds', ts, level, layer2Pointer }, done };
    this.d.setBusy('kinds', 'Object kinds');
    this.send?.(this.kindsWant.msg);
  }

  // A level scan (replaces one still running); its result goes to the cache under key too
  requestScan(id: number, key: string, level: ScanLevel, done: (r: ScanResult | null) => void): void {
    this.sync(); // (first: after a ROM change it would send the scan wanted then)
    this.scanWant = { msg: { type: 'scan', id, key, level }, done };
    this.d.setBusy('scan', 'Level scan');
    this.send?.(this.scanWant.msg);
  }

  // the scan asked for is not wanted any more
  cancelScan(): void {
    this.scanWant = null;
    this.d.setBusy('scan', null);
  }

  // Starts the worker, and sends it the ROM again after a change (it drops its queue then: the
  // asked jobs are sent again, the prefetch is made anew).
  private sync(): void {
    if (!this.send) this.send = this.start();
    const rom = this.d.rom();
    if (this.gen === rom.gen) return;
    this.gen = rom.gen;
    this.failed.clear();
    this.prefetched.clear();
    this.send({ type: 'rom', gen: this.gen, data: rom.data.slice() });
    if (this.asked.size) this.send({ type: 'ask', jobs: [...this.asked.values()] });
    for (const w of [this.kindsWant, this.scanWant]) if (w) this.send(w.msg);
    this.d.later('probe-prefetch', () => this.prefetch()); // results that read changed ROM data are redone
  }

  // the worker; without one (it failed to start or broke down) the jobs run here in slices
  private start(): Send {
    try {
      const send = this.d.connect?.((d) => this.reply(d), () => {
        console.error('probe worker failed, probing on the main thread');
        this.send = this.local();
        this.gen = -1;
        this.sync();
      });
      if (send) return send;
    } catch (e) {
      console.error(e);
    }
    return this.local();
  }

  private local(): Send {
    const host = new ProbeHost();
    let scheduled = false;
    const run = () => {
      scheduled = false;
      const t0 = performance.now();
      while (performance.now() - t0 < SLICE && host.pending) {
        const d = host.next();
        if (d) this.reply(d);
      }
      schedule();
    };
    const schedule = () => {
      if (scheduled || !host.pending) return;
      scheduled = true;
      this.d.later('probe', run);
    };
    return (m) => { host.handle(m); schedule(); };
  }

  private reply(d: ProbeReply): void {
    if (d.type === 'probe') this.probeDone(d);
    else if (d.type === 'kinds') this.kindsDone(d);
    else this.scanDone(d);
  }

  // Results are kept whatever ROM they ran on: the cache checks them against the ROM bytes they
  // read. A job that ran on an older ROM is done only if its result still holds (otherwise the
  // worker, which got the jobs again with the new ROM, answers it once more).
  private probeDone(d: ProbeDone): void {
    for (const [k, e] of d.put) this.d.results.set(k, e.data, e.deps);
    const id = jobId(d.job);
    if (d.gen !== this.gen && this.d.results.get(jobKey(d.job)) === undefined) return;
    if (d.failed && d.gen === this.gen) this.failed.add(id);
    const asked = this.asked.delete(id), prefetched = this.prefetched.delete(id);
    this.busy();
    if ((asked && !this.asked.size) || (prefetched && !this.prefetched.size)) this.d.ready();
  }

  private kindsDone(d: KindsDone): void {
    const want = this.kindsWant;
    if (want?.msg.ts !== d.ts) return;
    if (d.gen !== this.gen && !(d.kinds && kindsStillValid(d.kinds, this.d.rom().data))) return;
    this.kindsWant = null;
    this.d.setBusy('kinds', null);
    want.done(d.kinds);
  }

  private scanDone(d: ScanDone): void {
    const want = this.scanWant;
    for (const [k, e] of d.put) this.d.results.set(k, e.data, e.deps);
    if (want?.msg.id !== d.id || (d.gen !== this.gen && this.d.results.get(want.msg.key) === undefined)) return;
    this.scanWant = null;
    this.d.setBusy('scan', null);
    want.done(d.result);
  }

  private busy(): void {
    const n = this.asked.size + this.prefetched.size;
    this.d.setBusy('probe', n ? `Block behavior (${n})` : null);
  }
}

// sprite ids (custom ones from 0x200) that can be probed: not shooters, generators, run-once
export function probeable(num: number): boolean {
  return num < 0x200 ? num < SPRITE_PROBE_END : (num & 0xff) < 0xc0;
}
