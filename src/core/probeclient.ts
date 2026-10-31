// The editor's side of the probes (probehost.ts): asks for block, collision and sprite probes, Mario's
// run speeds and the game view's scroll bands in the current tileset, prefetches what the palettes can
// show, and runs the object kinds, the level scan, the camera at a place and the result learner's jobs that run there
// (CONTEXT.md; the sprite images, the levels' uses, the sprite memory check, the animated tiles and colors), all in the
// probe worker. It sends the ROM once, then the ranges each change wrote (the worker keeps its queue and restarts only tasks
// that read a changed byte; the whole ROM again, with everything still wanted, when the ROM's log of changes
// doesn't reach back), and falls back to probing on the main thread in background slices when the worker
// fails. Results go to the editor's ResultCache, also those from before a ROM change: they hold while the ROM
// bytes they read are unchanged.

import { ProbeHost, pumpProbes } from './probehost.ts';
import { jobId, jobKey, learnKeep, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply, type KindsDone, type ScanDone, type CameraDone, type LearnJob, type LearnMessage, type Learned, type Learning } from './probeprotocol.ts';
import { inputHash } from './inputs.ts';
import { partKey, MemoryResults, MEMORY, type Keep } from './jobrunner.ts';
import type { ResultCache } from './romdeps.ts';
import type { Rom } from './rom.ts';
import { SPRITE_PROBE_END, probeable, type BlockProbe, type CollisionProbe, type SpriteProbe, type RunStates } from './blockprobe.ts';
import type { CameraBands } from './camerabands.ts';
import type { CameraAt } from './camerareach.ts';
import { kindsKey, type ObjKinds, type KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';

const SLICE = 12; // ms the main thread probes at a time without a worker

type Send = (m: ProbeMessage) => void;

export interface ProbeClientDeps {
  results: ResultCache;
  cacheReady: Promise<void>; // stored results are loaded
  rom(): Pick<Rom, 'gen' | 'data' | 'changesSince'>; // the current ROM, its count of changes and what they wrote
  tileset(): number; // the tileset probes are asked for
  kindLevel(): { level: KindLevel; layer2Pointer: number }; // the level object kinds are found with
  // starts the worker (replies go to reply, failed() once it broke down); null or a throw: none
  connect?(reply: (d: ProbeReply) => void, failed: () => void): Send | null;
  later(key: string, step: () => void): void; // a background slice on the main thread
  setBusy(key: string, label: string | null): void; // ('probe', 'kinds', the tasks' types, the learn jobs' lanes)
  ready(): void; // the asked or the prefetched probes are all done
  kindsReady(): void; // object kinds asked for are known (or failed)
}

// a learn job asked for (ProbeClient.learn)
export interface LearnOptions<T> {
  lane: string; // its lane (one job at a time, in the order asked), also the key of its busy label
  input?: unknown; // what the result depends on outside the ROM (inputs.ts)
  replace?: boolean; // drops the lane's other jobs (they are not wanted any more), also when the result is known
  label?: string | ((queued: number) => string); // busy label (queued: the lane's jobs); the job's progress replaces it
  done?: (result: T) => void; // (a callback already waiting for the result isn't added again)
  shown?: (items: unknown[] | null) => void; // what the job shows while it runs (null: it started, also over)
}

interface LearnWant { msg: LearnMessage; opts: LearnOptions<unknown>; done: ((r: unknown) => void)[] }
interface LearnLane { wants: LearnWant[]; progress: string | null }

export class ProbeClient {
  private send: Send | null = null;
  private gen = -1; // ROM generation the worker probes on
  private size = -1; // and the ROM's size
  private asked = new Map<string, ProbeJob>(); // asked for and not done yet
  private prefetched = new Map<string, ProbeJob>(); // the same, probed after the asked ones
  // probes and tilesets whose object kinds failed, forgotten whenever the ROM changes: a deliberate exception
  // to emulated results holding by the bytes they read (a failure is rare and cheap to try again)
  private failed = new Set<string>();
  private kindsWant: ProbeMessage & { type: 'kinds' } | null = null;
  private kindsFailed = new Set<number>(); // tilesets
  // the level scan and the camera at a place asked for, one of each
  private playWant = new Map<Played, { msg: ProbeMessage & { type: Played }; done: (r: unknown) => void }>();
  private lanes = new Map<string, LearnLane>(); // learn jobs asked for and not done yet, by lane
  private learnFailed = new Set<string>(); // learn jobs (key and input) that failed, forgotten when the ROM changes
  private memory: MemoryResults; // learn jobs' results kept in memory only, as the worker's (checked against the ROM)
  private d: ProbeClientDeps;

  constructor(deps: ProbeClientDeps) {
    this.d = deps;
    this.memory = new MemoryResults(deps.results.fp, MEMORY);
  }

  // What a Map16 tile does when hit from below, how Mario collides with it, what a sprite id does
  // (normal sprites only, not shooters/generators): undefined while unknown, then asked for
  block(tile: number): BlockProbe | undefined { return this.probed({ kind: 'block', ts: this.d.tileset(), tile }); }
  collision(tile: number): CollisionProbe | undefined { return this.probed({ kind: 'collision', ts: this.d.tileset(), tile }); }
  sprite(num: number): SpriteProbe | undefined {
    return probeable(num) ? this.probed({ kind: 'sprite', ts: this.d.tileset(), num }) : undefined;
  }
  // Mario's run speeds; null when they could not be found
  runSpeeds(): RunStates | null | undefined { return this.probedOrFailed<RunStates>({ kind: 'runs', ts: this.d.tileset() }); }

  // where Mario is on the screen while the camera scrolls (camerabands.ts) in a level of that mode and vertical
  // scroll setting; null when they could not be found
  cameraBands(mode: number, vscroll: number): CameraBands | null | undefined {
    return this.probedOrFailed<CameraBands>({ kind: 'bands', ts: this.d.tileset(), mode, vscroll });
  }

  // a probe's result; null when it failed
  private probedOrFailed<T>(job: ProbeJob): T | null | undefined {
    const r = this.probed<T>(job);
    return r === undefined && this.failed.has(jobId(job)) ? null : r;
  }

  private probed<T>(job: ProbeJob): T | undefined {
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

  // Probes everything the palette tabs can show (Map16 tiles 000-1FF plus `tiles`, all sprites; how
  // Mario collides with `tiles`) in the background, after what is asked for directly; results go to
  // the cache, so this runs once per tileset and ROM state.
  prefetch(tiles: Iterable<number> = []): void {
    this.d.cacheReady.then(() => {
      this.sync();
      const ts = this.d.tileset();
      // (the queue of another tileset is dropped)
      const jobs = new Map([...this.prefetched].filter(([, j]) => j.ts === ts));
      const add = (job: ProbeJob) => {
        const id = jobId(job);
        if (!this.failed.has(id) && !this.asked.has(id) && this.d.results.get(jobKey(job)) === undefined) jobs.set(id, job);
      };
      for (const tile of tiles) { add({ kind: 'block', ts, tile }); add({ kind: 'collision', ts, tile }); }
      for (let tile = 0; tile < 0x200; tile++) add({ kind: 'block', ts, tile });
      for (let num = 0; num < SPRITE_PROBE_END; num++) add({ kind: 'sprite', ts, num });
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

  // the scan asked for is not wanted any more (the worker stops playing it)
  cancelScan(): void {
    if (this.playWant.delete('scan')) this.send?.({ type: 'cancel', task: 'scan' });
    this.d.setBusy('scan', null);
  }

  // The camera at Mario standing at (x, y) in the level (camerareach.ts; replaces one still running); its
  // result goes to the cache under key too
  requestCamera(id: number, key: string, level: ScanLevel, x: number, y: number, done: (r: CameraAt | null) => void): void {
    this.play({ type: 'camera', id, key, level, x, y }, (r) => done(r as CameraAt | null), 'Camera');
  }

  private play(msg: ProbeMessage & { type: Played }, done: (r: unknown) => void, label: string): void {
    this.sync(); // (first: after a ROM change it would send what was wanted then)
    const want = { msg, done };
    this.playWant.set(msg.type, want);
    this.d.setBusy(msg.type, label);
    // (a stored result while it holds)
    this.d.cacheReady.then(() => {
      if (this.playWant.get(msg.type) !== want) return;
      const known = this.d.results.get(msg.key);
      if (known === undefined) this.send?.(msg);
      else this.playDone({ type: msg.type, gen: this.gen, id: msg.id, result: known, put: [] } as ScanDone | CameraDone);
    });
  }

  // The result under key for opts.input, else undefined: its job is asked for in the worker (after the stored results
  // are loaded, which may hold it), opts.done called with its result; one that failed is asked again after a ROM change
  learn<T>(key: string, job: LearnJob, opts: LearnOptions<T>): T | undefined {
    this.sync();
    const input = opts.input === undefined ? undefined : inputHash(opts.input), id = `${key}#${input}`;
    const same = (w: LearnWant) => w.msg.key === key && w.msg.input === input;
    let lane = this.lanes.get(opts.lane);
    if (!lane) this.lanes.set(opts.lane, (lane = { wants: [], progress: null }));
    if (opts.replace && lane.wants.some((w) => !same(w))) {
      // (the worker drops them too: the job kept answers a replacing request, without one the lane goes)
      lane.wants = lane.wants.filter(same);
      lane.progress = null;
      const kept = lane.wants[0];
      this.send?.(kept ? { ...kept.msg, replace: true } : { type: 'unlearn', lane: opts.lane });
    }
    const keep = learnKeep(job), stored = this.stored<T>(key, input, keep);
    if (stored !== undefined || this.learnFailed.has(id)) {
      this.learnBusy(opts.lane);
      return stored;
    }
    let want = lane.wants.find(same);
    if (!want) {
      const w: LearnWant = want = { msg: { type: 'learn', lane: opts.lane, key, input, job, replace: !!opts.replace }, opts: opts as LearnOptions<unknown>, done: [] };
      lane.wants.push(w);
      // (stored results first: the result may be known by then)
      this.d.cacheReady.then(() => {
        if (!this.lanes.get(w.msg.lane)?.wants.includes(w)) return;
        const known = this.stored(key, input, keep);
        // (with the stored parts of the result: the worker learns only the others)
        if (known === undefined) this.send?.(this.withParts(w.msg));
        else this.learned({ type: 'learned', gen: this.gen, lane: w.msg.lane, key, input, result: known, failed: false, put: [] });
      });
    }
    const done = opts.done as ((r: unknown) => void) | undefined;
    if (done && !want.done.includes(done)) want.done.push(done);
    this.learnBusy(opts.lane);
    return undefined;
  }

  // a learn job's result as kept (learnKeep: none for those the job keeps none of)
  private stored<T>(key: string, input: string | undefined, keep: Keep): T | undefined {
    return keep === false ? undefined : (keep === 'memory' ? this.memory : this.d.results).get<T>(key, input);
  }

  // Starts the worker, and sends it what a ROM change wrote: the ranges, or the whole ROM when they aren't known
  // or the size changed (it drops its queue then: the asked jobs and tasks are sent again). The prefetch is made anew.
  private sync(): void {
    if (!this.send) this.send = this.start();
    const rom = this.d.rom();
    if (this.gen === rom.gen) return;
    // (a new size is a new ROM to the worker: it starts anew)
    const changes = this.gen < 0 || rom.data.length !== this.size ? null : rom.changesSince(this.gen);
    this.gen = rom.gen;
    this.size = rom.data.length;
    this.failed.clear();
    this.kindsFailed.clear();
    this.prefetched.clear();
    this.learnFailed.clear();
    if (changes) {
      const edits = changes.map(([a, e]): [number, Uint8Array] => [a, rom.data.slice(a, e)]);
      this.send({ type: 'edit', gen: this.gen, size: this.size, edits });
    } else {
      this.send({ type: 'rom', gen: this.gen, data: rom.data.slice() });
      if (this.asked.size) this.send({ type: 'ask', jobs: [...this.asked.values()] });
      if (this.kindsWant) this.send(this.kindsWant);
      for (const w of this.playWant.values()) this.send(w.msg);
      for (const lane of this.lanes.values()) for (const w of lane.wants) this.send(this.withParts(w.msg));
    }
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
    return pumpProbes(new ProbeHost(), (d) => this.reply(d), {
      wait: (run) => this.d.later('probe', run),
      startTurn: () => { const t0 = performance.now(); return () => performance.now() - t0 < SLICE; },
    });
  }

  private reply(d: ProbeReply): void {
    switch (d.type) {
      case 'probe': this.probeDone(d); break;
      case 'kinds': this.kindsDone(d); break;
      case 'scan': case 'camera': this.playDone(d); break;
      case 'learning': this.learning(d); break;
      case 'learned': this.learned(d); break;
    }
  }

  private want(d: Learning | Learned): { lane: LearnLane; want: LearnWant } | null {
    const lane = this.lanes.get(d.lane), want = lane?.wants.find((w) => w.msg.key === d.key && w.msg.input === d.input);
    return lane && want ? { lane, want } : null;
  }

  // a learn job's progress: what it shows, its label
  private learning(d: Learning): void {
    this.take(d);
    const w = this.want(d);
    if (!w) return;
    if (d.fresh) w.want.opts.shown?.(null);
    if (d.shown.length) w.want.opts.shown?.(d.shown);
    if (w.lane.wants[0] === w.want) w.lane.progress = d.label;
    this.learnBusy(d.lane);
  }

  // (as probeDone: a result from an older ROM counts while it holds)
  private learned(d: Learned): void {
    this.take(d);
    // (one kept in memory: while it holds, also from an older ROM, and also when no longer wanted, as the others)
    if (d.memory && this.d.results.fp.valid(d.memory.deps)) this.memory.set(d.key, d.memory.data, d.memory.deps, d.input);
    const w = this.want(d);
    if (!w) return;
    const { lane, want } = w, keep = learnKeep(want.msg.job);
    if (d.gen !== this.gen && (keep === false || this.stored(d.key, d.input, keep) === undefined)) { this.send?.(want.msg); return; }
    if (d.failed) this.learnFailed.add(`${d.key}#${d.input}`);
    lane.wants.splice(lane.wants.indexOf(want), 1);
    lane.progress = null;
    this.learnBusy(d.lane);
    if (!d.failed) for (const f of want.done) f(d.result);
  }

  // a learn job's request with the stored parts of its result (jobrunner.ts Part): a worker without them (a new one, a
  // new ROM) learns only the others
  private withParts(msg: LearnMessage): LearnMessage {
    return { ...msg, parts: this.d.results.under(partKey(msg.key, '')) };
  }

  private learnBusy(name: string): void {
    const lane = this.lanes.get(name), first = lane?.wants[0], label = first?.opts.label;
    this.d.setBusy(name, !first ? null : lane.progress ?? (typeof label === 'function' ? label(lane.wants.length) : label ?? null));
  }

  // Results are kept whatever ROM they ran on: the cache checks them against the ROM bytes they
  // read. A job that ran on an older ROM is done only if its result still holds (otherwise it is
  // asked for once more: the worker has the new ROM by now).
  private probeDone(d: ProbeDone): void {
    this.take(d);
    const id = jobId(d.job);
    if (d.gen !== this.gen && this.d.results.get(jobKey(d.job)) === undefined) {
      if (this.asked.has(id)) this.send?.({ type: 'ask', jobs: [d.job] });
      return;
    }
    if (d.failed && d.gen === this.gen) this.failed.add(id);
    const asked = this.asked.delete(id), prefetched = this.prefetched.delete(id);
    this.busy();
    if ((asked && !this.asked.size) || (prefetched && !this.prefetched.size)) this.d.ready();
  }

  // (as probeDone: kinds from an older ROM count while their result holds)
  private kindsDone(d: KindsDone): void {
    this.take(d);
    if (this.kindsWant?.ts !== d.ts) return;
    if (d.gen !== this.gen && this.d.results.get(kindsKey(d.ts)) === undefined) { this.send?.(this.kindsWant); return; }
    if (d.failed) this.kindsFailed.add(d.ts);
    this.kindsWant = null;
    this.d.setBusy('kinds', null);
    this.d.kindsReady();
  }

  // (as probeDone: a result from an older ROM counts while it holds)
  private playDone(d: ScanDone | CameraDone): void {
    const want = this.playWant.get(d.type);
    this.take(d);
    if (want?.msg.id !== d.id) return;
    if (d.gen !== this.gen && this.d.results.get(want.msg.key) === undefined) { this.send?.(want.msg); return; }
    this.playWant.delete(d.type);
    this.d.setBusy(d.type, null);
    want.done(d.result);
  }

  // a reply's result cache entries; those of a job that ran on an older ROM (d.gen: the editor ROM's generation it
  // ran on, not the one last sent) are checked against the current one when first used
  private take(d: ProbeReply): void {
    this.d.results.setAll(d.put, d.gen === this.d.rom().gen);
  }

  private busy(): void {
    const n = this.asked.size + this.prefetched.size;
    this.d.setBusy('probe', n ? `Block behavior (${n})` : null);
  }
}

type Played = 'scan' | 'camera'; // tasks that play a level
