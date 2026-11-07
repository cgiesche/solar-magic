// The editor's side of the probes (probehost.ts): asks for block, collision and sprite probes, Mario's
// run speeds and the game view's scroll bands in the current tileset, prefetches what the views shown
// want (last, quietly), and runs the object kinds, the level scan, the camera at a place and the result learner's jobs (CONTEXT.md;
// probeprotocol.ts LearnJob), all in the probe worker. It sends the ROM once, then the ranges each change
// wrote (the worker keeps its queue and restarts only tasks
// that read a changed byte; the whole ROM again, with everything still wanted, when the ROM's log of changes
// doesn't reach back), and falls back to probing on the main thread in background slices when the worker
// fails. Results go to the editor's ResultCache, also those from before a ROM change: they hold while the ROM
// bytes they read are unchanged.

import { ProbeHost, pumpProbes } from './probehost.ts';
import { jobId, jobResult, learnKeep, learnRetargets, learnParts, EDIT_STATES, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply, type KindsDone, type KindsShown, type ScanDone, type CameraDone, type LearnJob, type LearnMessage, type Learned, type Learning, type LearnLane, type ProbeBusyKey } from './probeprotocol.ts';
import { Lanes, laneId, type LaneLabel } from './lanes.ts';
import { inputHash } from './inputs.ts';
import { partKey, memoryResults, type MemoryResults, type Keep } from './jobrunner.ts';
import { storeKey, type ResultCache, type CacheEntry } from './romdeps.ts';
import type { Rom } from './rom.ts';
import { SPRITE_PROBE_END, probeable, type BlockProbe, type CollisionProbe, type SpriteProbe, type RunStates } from './blockprobe.ts';
import type { CameraBands } from './camerabands.ts';
import type { CameraAt } from './camerareach.ts';
import { kindsKey, type ObjKind, type ObjKinds, type KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';

// a learn job that failed (learnOrFailed)
export const FAILED: unique symbol = Symbol('failed');

const SLICE = 12; // ms the main thread probes at a time without a worker

type Send = (m: ProbeMessage) => void;

export interface ProbeClientDeps {
  results: ResultCache;
  cacheReady: Promise<void>; // stored results are loaded
  rom(): Pick<Rom, 'gen' | 'data' | 'changesSince'>; // the current ROM, its count of changes and what they wrote
  tileset(): number; // the tileset probes are asked for
  // the level object kinds are found with; first: its standard objects (their kinds are known first, kindsSoFar)
  kindLevel(): { level: KindLevel; layer2Pointer: number; first?: number[] };
  level?(): number; // the open level's number (another one opened while the kinds run: its objects' kinds next)
  // starts the worker (replies go to reply, failed() once it broke down); null or a throw: none
  connect?(reply: (d: ProbeReply) => void, failed: () => void): Send | null;
  later(key: string, step: () => void): void; // a background slice on the main thread (waits while a dialog is open)
  soon?(step: () => void): void; // a slice that runs while a dialog is open too (default: later's)
  setBusy(key: ProbeBusyKey, label: string | null): void;
  ready(): void; // the asked or the prefetched probes are all done
  progress?(): void; // an asked or prefetched probe is done (more may follow)
  kindsReady(): void; // object kinds asked for are known (or failed), or those of the open level's objects (kindsSoFar)
}

// a learn job asked for (ProbeClient.learn)
export interface LearnOptions<T> {
  lane: LearnLane; // its lane (one job at a time, in the order asked, lanes.ts), also the key of its busy label
  input?: unknown; // what the result depends on outside the ROM (inputs.ts)
  replace?: boolean; // drops the lane's other jobs (they are not wanted any more), also when the result is known
  label?: LaneLabel; // busy label (queued: the lane's jobs); the job's progress replaces it
  urgent?: boolean; // runs while a dialog is open (one that shows the result): matters without a worker only
  done?: (result: T) => void; // (a callback already waiting for the result isn't added again)
  failed?: () => void; // the job failed (also when it had failed before and isn't run again until the ROM changes)
  dropped?: () => void; // the job was dropped before it was done (unlearn, or replaced by another job of its lane)
  shown?: (items: unknown[] | null) => void; // what the job shows while it runs (null: it started, also over)
}

// (resent: the ROM generation it was last sent again for, a reply from an older one coming: once per generation)
interface LearnWant { msg: LearnMessage; opts: LearnOptions<unknown>; done: ((r: unknown) => void)[]; failed: (() => void)[]; dropped: (() => void)[]; resent: number }

// what a view shown wants prefetched (ProbeClient.wantPrefetch) in the current tileset: blocks, the block probes of
// Map16 tiles 000-1FF; tiles, the block and collision probes of these; sprites, the probes of all sprites
export interface PrefetchWant { blocks?: boolean; tiles?: readonly number[]; sprites?: boolean }
// the views that want a prefetch: the level editor's picker, the graphics workspace's Map16 editor
export type PrefetchOwner = 'picker' | 'map16tab';

export class ProbeClient {
  private send: Send | null = null;
  private gen = -1; // ROM generation the worker probes on
  private size = -1; // and the ROM's size
  private asked = new Map<string, ProbeJob>(); // asked for and not done yet
  private prefetched = new Map<string, ProbeJob>(); // the same, probed when nothing else is pending
  private prefetchWants = new Map<PrefetchOwner, PrefetchWant>(); // by the view wanting it (only those shown)
  private prefetchSent = false; // the worker may have a prefetch queue (one was sent with jobs)
  // probes and tilesets whose object kinds failed, forgotten whenever the ROM changes: a deliberate exception
  // to emulated results holding by the bytes they read (a failure is rare and cheap to try again)
  private failed = new Set<string>();
  private kindsWant: ProbeMessage & { type: 'kinds' } | null = null;
  private kindsFailed = new Set<number>(); // tilesets
  private levelKinds: { ts: number; kinds: Map<number, ObjKind> } | null = null; // KindsShown while the kinds run
  // the level scan and the camera at a place asked for, one of each
  private playWant = new Map<Played, { msg: ProbeMessage & { type: Played }; done: (r: unknown) => void }>();
  private lanes = new Lanes<LearnLane, LearnWant>((w) => laneId(w.msg.key, w.msg.input)); // learn jobs asked for and not done yet
  private learnFailed = new Set<string>(); // learn jobs (key and input) that failed, forgotten when the ROM changes
  private memory: MemoryResults; // learn jobs' results kept in memory only, as the worker's (checked against the ROM)
  private hostStates: string[] = []; // the levels as edited the host has whole: the latest EDIT_STATES sent so (post)
  // per key, the latest result kept as its parts put together (stored): its input, its parts and their data
  private joined = new Map<string, { input: string | undefined; parts: [string, string][]; join(d: unknown[]): unknown; data: unknown[]; result: unknown }>();
  private urges = 0; // waits a dialog shows (urge)
  private recheckUrgency: (() => void) | null = null; // without a worker: the pump re-checks its urgency
  private d: ProbeClientDeps;

  constructor(deps: ProbeClientDeps) {
    this.d = deps;
    this.memory = memoryResults(deps.results.fp);
  }

  // What a Map16 tile does when hit from below, how Mario collides with it, what a sprite id does
  // (normal sprites only, not shooters/generators): undefined while unknown, then asked for
  block(tile: number): BlockProbe | undefined { return this.probed({ kind: 'block', ts: this.d.tileset(), tile }); }
  collision(tile: number): CollisionProbe | undefined { return this.probed({ kind: 'collision', ts: this.d.tileset(), tile }); }
  sprite(num: number): SpriteProbe | undefined {
    return probeable(num) ? this.probed({ kind: 'sprite', ts: this.d.tileset(), num }) : undefined;
  }
  // as sprite, without asking for it (a view's: its prefetch brings it, wantPrefetch)
  spriteKnown(num: number): SpriteProbe | undefined {
    return probeable(num) ? jobResult<SpriteProbe>(this.d.results, { kind: 'sprite', ts: this.d.tileset(), num }) : undefined;
  }
  // a sprite's probe in tileset ts (not only the current one); null when it failed or the probes don't tell it
  spriteIn(num: number, ts: number): SpriteProbe | null | undefined {
    return probeable(num) ? this.probedOrFailed<SpriteProbe>({ kind: 'sprite', ts, num }) : null;
  }
  // a Map16 tile's probes in tileset ts (another level's image, levelimages.ts); null when they failed
  blockIn(tile: number, ts: number): BlockProbe | null | undefined { return this.probedOrFailed<BlockProbe>({ kind: 'block', ts, tile }); }
  collisionIn(tile: number, ts: number): CollisionProbe | null | undefined { return this.probedOrFailed<CollisionProbe>({ kind: 'collision', ts, tile }); }
  // Mario's run speeds; null when they could not be found
  runSpeeds(): RunStates | null | undefined { return this.probedOrFailed<RunStates>({ kind: 'runs', ts: this.d.tileset() }); }

  // where Mario is on the screen while the camera scrolls (camerabands.ts) in a level of that mode and vertical
  // scroll setting (in tileset ts: the current one, another level's for its image); null when they could not be found
  cameraBands(mode: number, vscroll: number, ts = this.d.tileset()): CameraBands | null | undefined {
    return this.probedOrFailed<CameraBands>({ kind: 'bands', ts, mode, vscroll });
  }

  // a probe's result; null when it failed
  private probedOrFailed<T>(job: ProbeJob): T | null | undefined {
    const r = this.probed<T>(job);
    return r === undefined && this.failed.has(jobId(job)) ? null : r;
  }

  private probed<T>(job: ProbeJob): T | undefined {
    const p = jobResult<T>(this.d.results, job);
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
      if (jobResult(this.d.results, job) === undefined) this.send?.({ type: 'ask', jobs: [job] });
      else this.probeDone({ type: 'probe', gen: this.gen, job, put: [], failed: false });
    });
  }

  // A view that shows probe results (a picker tab, the Map16 editor) is shown (want: what it shows, PrefetchWant) or hidden (null), named by owner:
  // the probes the shown views want are prefetched (CONTEXT.md "Prefetch"), in the worker only when nothing else is
  // pending and not counted as busy; nothing is prefetched that no view shown wants. The same want again changes
  // nothing.
  wantPrefetch(owner: PrefetchOwner, want: PrefetchWant | null): void {
    const was = this.prefetchWants.get(owner);
    if (sameWant(was, want ?? undefined)) return;
    if (want) this.prefetchWants.set(owner, want); else this.prefetchWants.delete(owner);
    this.refreshPrefetch();
  }

  // Makes the prefetch queue anew: what the shown views want (wantPrefetch) in the current tileset (the queue of
  // another tileset dropped) and not known yet; results go to the cache, so each is probed once per tileset and ROM state (the sprites once per ROM state, blockprobe.ts)
  refreshPrefetch(): void {
    this.d.cacheReady.then(() => {
      this.sync();
      const ts = this.d.tileset();
      const jobs = new Map<string, ProbeJob>();
      const add = (job: ProbeJob) => {
        const id = jobId(job);
        if (!this.failed.has(id) && !this.asked.has(id) && jobResult(this.d.results, job) === undefined) jobs.set(id, job);
      };
      const wants = [...this.prefetchWants.values()];
      for (const w of wants) for (const tile of w.tiles ?? []) { add({ kind: 'block', ts, tile }); add({ kind: 'collision', ts, tile }); }
      if (wants.some((w) => w.blocks)) for (let tile = 0; tile < 0x200; tile++) add({ kind: 'block', ts, tile });
      if (wants.some((w) => w.sprites)) for (let num = 0; num < SPRITE_PROBE_END; num++) add({ kind: 'sprite', ts, num });
      // (a queue the worker may have is replaced, also by none)
      if (!jobs.size && !this.prefetchSent) return;
      this.prefetched = jobs;
      this.prefetchSent = jobs.size > 0;
      this.send?.({ type: 'prefetch', jobs: [...jobs.values()] });
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
    const was = this.kindsWant;
    // (asked for already, for the open level: its objects first)
    if (was?.ts === ts && (!this.d.level || this.d.level() === was.level.number)) return undefined;
    const { level, layer2Pointer, first } = this.d.kindLevel();
    const msg = this.kindsWant = { type: 'kinds', ts, level, layer2Pointer, ...(first && { first }) };
    if (was?.ts !== ts) this.levelKinds = null;
    this.d.setBusy('kinds', 'Object kinds');
    // (stored results first: they may be known by then)
    this.d.cacheReady.then(() => {
      if (this.kindsWant !== msg) return;
      if (this.d.results.get(kindsKey(ts)) === undefined) this.send?.(msg);
      else this.kindsDone({ type: 'kinds', gen: this.gen, ts, failed: false, put: [] });
    });
    return undefined;
  }

  // While the object kinds of tileset ts run (kinds undefined): the kinds of the open level's objects (KindLevel's
  // first) once known, those not plain (an object not among them is plain or not known yet); undefined before
  kindsSoFar(ts = this.d.tileset()): Map<number, ObjKind> | undefined {
    return this.levelKinds?.ts === ts && this.kindsWant?.ts === ts ? this.levelKinds.kinds : undefined;
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
    const r = this.learnOrFailed<T>(key, job, opts);
    if (r !== FAILED) return r;
    opts.failed?.();
    return undefined;
  }

  // as learn, FAILED when the job failed (not asked again until the ROM changes): opts.failed is then not called, only
  // when it fails later (a caller that redraws on it isn't told again and again)
  learnOrFailed<T>(key: string, job: LearnJob, opts: LearnOptions<T>): T | typeof FAILED | undefined {
    this.sync();
    const input = opts.input === undefined ? undefined : inputHash(opts.input), id = laneId(key, input), name = opts.lane;
    const gone = opts.replace ? this.lanes.replace(name, id) : [];
    if (gone.length) {
      // (the worker drops them too: the job kept answers a replacing request, without one the lane goes)
      const kept = this.lanes.get(name)?.first;
      if (kept) this.post({ ...kept.msg, replace: true }); else this.send?.({ type: 'unlearn', lane: name });
      this.drop(gone);
    }
    const stored = this.stored<T>(key, input, job);
    if (stored !== undefined || this.learnFailed.has(id)) {
      this.learnBusy(name);
      return stored === undefined ? FAILED : stored;
    }
    const { job: want, added } = this.lanes.join(name, id, () => (
      { msg: { type: 'learn', lane: name, key, input, job, replace: !!opts.replace }, opts: opts as LearnOptions<unknown>, done: [], failed: [], dropped: [], resent: -1 }));
    if (added) {
      // (stored results first: the result may be known by then)
      this.d.cacheReady.then(() => {
        if (!this.lanes.has(name, want)) return;
        const known = this.stored(key, input, job);
        // (with the stored parts of the result: the worker learns only the others)
        if (known === undefined) this.post(this.withParts(want.msg));
        else this.learned({ type: 'learned', gen: this.gen, lane: name, key, input, result: known, failed: false, put: [] });
      });
    } else if (learnRetargets(want.msg.job, job)) {
      // (the running job takes up the other work, e.g. the levels' uses another list; after the first request, sent
      // once the stored results are loaded)
      const w = want, msg = w.msg = { ...w.msg, job };
      this.d.cacheReady.then(() => { if (w.msg === msg && this.lanes.has(name, w)) this.post(this.withParts(msg)); });
    }
    const done = opts.done as ((r: unknown) => void) | undefined;
    if (done && !want.done.includes(done)) want.done.push(done);
    if (opts.failed && !want.failed.includes(opts.failed)) want.failed.push(opts.failed);
    if (opts.dropped && !want.dropped.includes(opts.dropped)) want.dropped.push(opts.dropped);
    this.learnBusy(name);
    return undefined;
  }

  // the jobs of a lane are not wanted any more
  unlearn(name: LearnLane): void {
    const gone = this.lanes.clear(name);
    if (!gone.length) return;
    this.send?.({ type: 'unlearn', lane: name });
    this.learnBusy(name);
    this.drop(gone);
  }

  // (their askers told: they don't wait for them any more)
  private drop(gone: LearnWant[]): void {
    for (const w of gone) for (const f of w.dropped) f();
  }

  // A dialog shows a wait for probes and learn jobs (one that shows their results, or a long export): without a
  // worker they all run while it is open, as urgent learn jobs do, until the returned release is called
  urge(): () => void {
    this.sync();
    this.urges++;
    this.recheckUrgency?.();
    let held = true;
    return () => { if (held) { held = false; this.urges--; } };
  }

  // a learn job's result as kept (learnKeep: none for those the job keeps none of); one kept as its parts only put
  // together from them while all are kept for their inputs (the same result while they are the same)
  private stored<T>(key: string, input: string | undefined, job: LearnJob): T | undefined {
    const keep = learnKeep(job);
    if (keep === false) return undefined;
    const cache = this.cache(keep);
    let j = this.joined.get(key);
    if (!j || j.input !== input) {
      const p = learnParts(job);
      if (!p) return cache.get<T>(key, input);
      this.joined.set(key, j = { input, ...p, data: [], result: undefined });
      cache.delete(key); // (the whole result kept before #232, next to its parts: dropped)
    }
    const data: unknown[] = [];
    for (const [sub, i] of j.parts) {
      const d = cache.get(partKey(key, sub), i);
      if (d === undefined) return undefined;
      data.push(d);
    }
    if (j.result === undefined || data.some((d, i) => d !== j.data[i])) { j.data = data; j.result = j.join(data); }
    return j.result as T;
  }
  private cache(keep: Keep): MemoryResults | ResultCache { return keep === 'memory' ? this.memory : this.d.results; }

  // Starts the worker, and sends it what a ROM change wrote: the ranges, or the whole ROM when they aren't known
  // or the size changed (it drops its queue then: the asked jobs and tasks are sent again). The prefetch is made anew.
  private sync(): void {
    if (!this.send) { this.send = this.start(); this.hostStates = []; }
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
      this.prefetchSent = false; // (the worker dropped its queue)
      this.levelKinds = null; // (a new ROM: shown again for it)
      if (this.asked.size) this.send({ type: 'ask', jobs: [...this.asked.values()] });
      if (this.kindsWant) this.send(this.kindsWant);
      for (const w of this.playWant.values()) this.send(w.msg);
      for (const lane of this.lanes.values()) for (const w of lane.jobs) { w.resent = this.gen; this.post(this.withParts(w.msg)); }
    }
    // (what the views shown want: results that read changed ROM data are redone)
    this.d.later('probe-prefetch', () => this.refreshPrefetch());
  }

  // the worker; without one (it failed to start or broke down) the jobs run here in slices
  private start(): Send {
    try {
      const send = this.d.connect?.((d) => this.reply(d), () => {
        console.error('probe worker failed, probing on the main thread');
        this.send = this.local();
        this.hostStates = [];
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
    const send = pumpProbes(new ProbeHost(), (d) => this.reply(d), {
      wait: (run) => this.d.later('probe', run),
      // (an urgent learn job asked for, or a wait urged: a dialog that shows it doesn't hold it up)
      ...(this.d.soon && { soon: this.d.soon, urgent: () => this.urgent() }),
      startTurn: () => { const t0 = performance.now(); return () => performance.now() - t0 < SLICE; },
    });
    this.recheckUrgency = send.recheck;
    return send;
  }

  private urgent(): boolean {
    if (this.urges > 0) return true;
    for (const lane of this.lanes.values()) if (lane.jobs.some((w) => w.opts.urgent)) return true;
    return false;
  }

  private reply(d: ProbeReply): void {
    switch (d.type) {
      case 'probe': this.probeDone(d); break;
      case 'kinds': this.kindsDone(d); break;
      case 'kindsShown': this.kindsShown(d); break;
      case 'scan': case 'camera': this.playDone(d); break;
      case 'learning': this.learning(d); break;
      case 'learned': this.learned(d); break;
    }
  }

  private want(d: Learning | Learned): LearnWant | undefined { return this.lanes.find(d.lane, laneId(d.key, d.input)); }

  // a learn job's progress: what it shows (not what a step on an older ROM showed: the job runs again where it read
  // a changed byte, the result is checked), its label
  private learning(d: Learning): void {
    this.take(d);
    const w = this.want(d);
    if (!w) return;
    if (d.fresh) w.opts.shown?.(null);
    if (d.shown.length && d.gen === this.gen) w.opts.shown?.(d.shown);
    this.lanes.setProgress(d.lane, w, d.label);
    this.learnBusy(d.lane);
  }

  // (as probeDone: a result from an older ROM counts while it holds)
  private learned(d: Learned): void {
    this.take(d);
    // (one kept in memory: while it holds, also from an older ROM, and also when no longer wanted, as the others)
    if (d.memory && this.d.results.fp.valid(d.memory.deps)) this.memory.set(d.key, d.memory.data, d.memory.deps, d.input);
    const want = this.want(d);
    if (!want) return;
    if (d.gen !== this.gen && this.stored(d.key, d.input, want.msg.job) === undefined) {
      // (asked again once per generation: the worker has the new ROM by then, its reply comes for it; more replies
      // from older ones, the job finishing before each edit came, are not asked again)
      if (want.resent !== this.gen) { want.resent = this.gen; this.post(want.msg); }
      return;
    }
    if (d.failed) this.learnFailed.add(laneId(d.key, d.input));
    this.lanes.remove(d.lane, want);
    this.learnBusy(d.lane);
    // (one kept as its parts: as put together from them, the result asked again)
    const result = d.failed || learnParts(want.msg.job) === null ? d.result : this.stored(d.key, d.input, want.msg.job) ?? d.result;
    if (!d.failed) for (const f of want.done) f(result);
    else for (const f of want.failed) f();
  }

  // a learn job's request with the stored parts of its result for their current inputs (learnParts; jobrunner.ts Part):
  // a worker without them (a new one, a new ROM) learns only the others
  private withParts(msg: LearnMessage): LearnMessage {
    const p = learnParts(msg.job), keep = learnKeep(msg.job);
    if (!p || keep === false) return msg;
    const cache = this.cache(keep), parts: [string, CacheEntry][] = [];
    for (const [sub, input] of p.parts) {
      const k = partKey(msg.key, sub), e = cache.entry(k, input);
      if (e) parts.push([storeKey(k, input), { deps: e.deps, data: e.data, input }]);
    }
    return parts.length ? { ...msg, parts } : msg;
  }

  // Sends a learn job's request; the level as edited it is learned on (StateRef) whole only when the host doesn't have
  // it (it keeps the latest EDIT_STATES sent whole, as counted here), without the owners of its bytes (the host
  // serializes the level again for them)
  private post(msg: LearnMessage): void {
    if (!this.send) return;
    const j = msg.job;
    if ('state' in j && 'level' in j.state) {
      const s = j.state;
      if (this.hostStates.includes(s.id)) msg = { ...msg, job: { ...j, state: { id: s.id } } };
      else {
        this.hostStates.push(s.id);
        if (this.hostStates.length > EDIT_STATES) this.hostStates.shift();
        msg = { ...msg, job: { ...j, state: { ...s, ov: { ...s.ov, byteOwner: undefined } } } };
      }
    }
    this.send(msg);
  }

  private learnBusy(name: LearnLane): void {
    this.d.setBusy(name, this.lanes.label(name, (w) => w.opts.label));
  }

  // Results are kept whatever ROM they ran on: the cache checks them against the ROM bytes they
  // read. A job that ran on an older ROM is done only if its result still holds (otherwise it is
  // asked for once more: the worker has the new ROM by now).
  private probeDone(d: ProbeDone): void {
    this.take(d);
    const id = jobId(d.job);
    if (d.gen !== this.gen && jobResult(this.d.results, d.job) === undefined) {
      if (this.asked.has(id)) this.send?.({ type: 'ask', jobs: [d.job] });
      return;
    }
    if (d.failed && d.gen === this.gen) this.failed.add(id);
    const asked = this.asked.delete(id), prefetched = this.prefetched.delete(id);
    if (prefetched && !this.prefetched.size) this.prefetchSent = false; // (the worker's queue is done too)
    this.busy();
    if (asked || prefetched) this.d.progress?.();
    if ((asked && !this.asked.size) || (prefetched && !this.prefetched.size)) this.d.ready();
  }

  // (as probeDone: kinds from an older ROM count while their result holds)
  private kindsDone(d: KindsDone): void {
    this.take(d);
    if (this.kindsWant?.ts !== d.ts) return;
    if (d.gen !== this.gen && this.d.results.get(kindsKey(d.ts)) === undefined) { this.send?.(this.kindsWant); return; }
    if (d.failed) this.kindsFailed.add(d.ts);
    this.kindsWant = this.levelKinds = null;
    this.d.setBusy('kinds', null);
    this.d.kindsReady();
  }

  // the kinds of the open level's objects while the kinds run (kindsSoFar): those of the latest objects asked first (a
  // job started over shows them again, as found on the ROM it then has)
  private kindsShown(d: KindsShown): void {
    this.take(d);
    if (this.kindsWant?.ts !== d.ts) return;
    this.levelKinds = { ts: d.ts, kinds: new Map(d.kinds) };
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

  // the probes asked for directly (the prefetch runs quietly)
  private busy(): void {
    const n = this.asked.size;
    this.d.setBusy('probe', n ? `Block behavior (${n})` : null);
  }
}

type Played = 'scan' | 'camera'; // tasks that play a level

// (the same tiles in the same order: a view asks with the same list again)
function sameWant(a: PrefetchWant | undefined, b: PrefetchWant | undefined): boolean {
  if (!a || !b) return a === b;
  const at = a.tiles ?? [], bt = b.tiles ?? [];
  return !!a.blocks === !!b.blocks && !!a.sprites === !!b.sprites && at.length === bt.length && at.every((t, i) => t === bt[i]);
}
