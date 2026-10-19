// The editor's side of the probes (probehost.ts): asks for block, collision and sprite probes, Mario's
// run speeds and the game view's scroll bands in the current tileset, prefetches what the palettes can
// show, and runs the object kinds, the level scan and the camera at a place, all in the probe worker. It sends the ROM again after a change
// (the worker drops its queue then) together with everything still wanted, and falls back to
// probing on the main thread in background slices when the worker fails. Results go to the
// editor's ResultCache, also those from before a ROM change: they hold while the ROM bytes they read
// are unchanged.

import { ProbeHost, PROBE_SPRITE, PROBE_COLL, PROBE_RUNS, PROBE_CAMERA, jobId, jobKey, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply, type KindsDone, type ScanDone, type CameraDone } from './probehost.ts';
import type { ResultCache } from './romdeps.ts';
import type { BlockProbe, CollisionProbe, SpriteProbe, RunStates } from './blockprobe.ts';
import type { CameraBands } from './camerabands.ts';
import { kindsKey, type ObjKinds, type KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';

export const SPRITE_PROBE_END = 0xc9; // sprites from $C9 on are shooters, generators and run-once sprites
const SLICE = 12; // ms the main thread probes at a time without a worker

type Send = (m: ProbeMessage) => void;

export interface ProbeClientDeps {
  results: ResultCache;
  cacheReady: Promise<void>; // stored results are loaded
  rom(): { gen: number; data: Uint8Array }; // the current ROM and its count of changes
  tileset(): number; // the tileset probes are asked for
  kindLevel(): { level: KindLevel; layer2Pointer: number }; // the level object kinds are found with
  // starts the worker (replies go to reply, failed() once it broke down); null or a throw: none
  connect?(reply: (d: ProbeReply) => void, failed: () => void): Send | null;
  later(key: string, step: () => void): void; // a background slice on the main thread
  setBusy(key: 'probe' | 'kinds' | Played, label: string | null): void;
  ready(): void; // the asked or the prefetched probes are all done
  kindsReady(): void; // object kinds asked for are known (or failed)
}

export class ProbeClient {
  private send: Send | null = null;
  private gen = -1; // ROM generation the worker probes on
  private asked = new Map<string, ProbeJob>(); // asked for and not done yet
  private prefetched = new Map<string, ProbeJob>(); // the same, probed after the asked ones
  private failed = new Set<string>();
  private kindsWant: ProbeMessage & { type: 'kinds' } | null = null;
  private kindsFailed = new Set<number>(); // tilesets (until the ROM changes)
  // the level scan and the camera at a place asked for, one of each
  private playWant = new Map<Played, { msg: ProbeMessage & { type: Played }; done: (r: unknown) => void }>();
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
  runSpeeds(): RunStates | null | undefined { return this.probedOrFailed<RunStates>(PROBE_RUNS); }

  // where Mario is on the screen while the camera scrolls (camerabands.ts); null when they could not be found
  cameraBands(): CameraBands | null | undefined { return this.probedOrFailed<CameraBands>(PROBE_CAMERA); }

  // a probe's result; null when it failed
  private probedOrFailed<T>(k: number): T | null | undefined {
    const r = this.probed<T>(k);
    return r === undefined && this.failed.has(jobId({ ts: this.d.tileset(), k })) ? null : r;
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

  // What the nibbles of standard objects mean in tileset ts (objkinds.ts): undefined while unknown,
  // then asked for (replacing kinds of another tileset still running); null when they could not be
  // found
  kinds(ts = this.d.tileset()): ObjKinds | null | undefined {
    const k = this.d.results.get<ObjKinds>(kindsKey(ts));
    if (k !== undefined) return k;
    this.sync();
    if (this.kindsFailed.has(ts)) return null;
    if (this.kindsWant?.ts === ts) return undefined;
    const { level, layer2Pointer } = this.d.kindLevel();
    const msg = this.kindsWant = { type: 'kinds', ts, level, layer2Pointer };
    this.d.setBusy('kinds', 'Object kinds');
    // (stored results first: they may be known by then)
    this.d.cacheReady.then(() => {
      if (this.kindsWant !== msg) return;
      if (this.d.results.get(kindsKey(ts)) === undefined) this.send?.(msg);
      else this.kindsDone({ type: 'kinds', gen: this.gen, ts, failed: false, put: [] });
    });
    return undefined;
  }

  // A level scan (replaces one still running); its result goes to the cache under key too
  requestScan(id: number, key: string, level: ScanLevel, done: (r: ScanResult | null) => void): void {
    this.play({ type: 'scan', id, key, level }, (r) => done(r as ScanResult | null), 'Level scan');
  }

  // the scan asked for is not wanted any more
  cancelScan(): void {
    this.playWant.delete('scan');
    this.d.setBusy('scan', null);
  }

  // The camera at Mario standing at (x, y) in the level (camerareach.ts; replaces one still running); its
  // result goes to the cache under key too
  requestCamera(id: number, key: string, level: ScanLevel, x: number, y: number, done: (r: { x: number; y: number } | null) => void): void {
    this.play({ type: 'camera', id, key, level, x, y }, (r) => done(r as { x: number; y: number } | null), 'Camera');
  }

  private play(msg: ProbeMessage & { type: Played }, done: (r: unknown) => void, label: string): void {
    this.sync(); // (first: after a ROM change it would send what was wanted then)
    this.playWant.set(msg.type, { msg, done });
    this.d.setBusy(msg.type, label);
    this.send?.(msg);
  }

  // Starts the worker, and sends it the ROM again after a change (it drops its queue then: the
  // asked jobs are sent again, the prefetch is made anew).
  private sync(): void {
    if (!this.send) this.send = this.start();
    const rom = this.d.rom();
    if (this.gen === rom.gen) return;
    this.gen = rom.gen;
    this.failed.clear();
    this.kindsFailed.clear();
    this.prefetched.clear();
    this.send({ type: 'rom', gen: this.gen, data: rom.data.slice() });
    if (this.asked.size) this.send({ type: 'ask', jobs: [...this.asked.values()] });
    if (this.kindsWant) this.send(this.kindsWant);
    for (const w of this.playWant.values()) this.send(w.msg);
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
    else this.playDone(d);
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

  // (as probeDone: kinds from an older ROM count while their result holds)
  private kindsDone(d: KindsDone): void {
    for (const [k, e] of d.put) this.d.results.set(k, e.data, e.deps);
    if (this.kindsWant?.ts !== d.ts) return;
    if (d.gen !== this.gen && this.d.results.get(kindsKey(d.ts)) === undefined) return;
    if (d.failed) this.kindsFailed.add(d.ts);
    this.kindsWant = null;
    this.d.setBusy('kinds', null);
    this.d.kindsReady();
  }

  // (as probeDone: a result from an older ROM counts while it holds)
  private playDone(d: ScanDone | CameraDone): void {
    const want = this.playWant.get(d.type);
    for (const [k, e] of d.put) this.d.results.set(k, e.data, e.deps);
    if (want?.msg.id !== d.id || (d.gen !== this.gen && this.d.results.get(want.msg.key) === undefined)) return;
    this.playWant.delete(d.type);
    this.d.setBusy(d.type, null);
    want.done(d.result);
  }

  private busy(): void {
    const n = this.asked.size + this.prefetched.size;
    this.d.setBusy('probe', n ? `Block behavior (${n})` : null);
  }
}

type Played = 'scan' | 'camera'; // tasks that play a level

// sprite ids (custom ones from 0x200) that can be probed: not shooters, generators, run-once
export function probeable(num: number): boolean {
  return num < 0x200 ? num < SPRITE_PROBE_END : (num & 0xff) < 0xc0;
}
