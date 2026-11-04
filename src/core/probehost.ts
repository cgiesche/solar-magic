// Runs block/sprite probes (blockprobe.ts) as a queue of jobs on its own copy of the ROM, so they
// can run in a Web Worker (ui/probeworker.ts) instead of the editor's main thread. Each finished
// job hands back the result cache entries it made (key, data, input and the ROM pages it read); the
// editor stores them in its own ResultCache, where they are checked against the ROM like any other.
// Longer tasks run here too, as jobs of the job runner (jobrunner.ts) a step at a time between the probes: the object
// kinds of a tileset (objkinds.ts), the level scan (levelscan.ts) and the camera at Mario standing at a place
// (camerareach.ts). A task the editor no longer wants is kept without running; asked for again with the same
// result, it goes on where it stood. The result learner's jobs (CONTEXT.md; probeprotocol.ts LearnJob: the sprite images,
// the levels' uses, the sprite memory check, the animated tiles and colors, the layer 3 kinds, the tiles of the level as
// edited, the object thumbnails, the placement preview, the jump arcs, the layer 2 motions, the overworld path kinds, the
// prefab suggestions, the object boxes for resizing, the overworld's maps, submap views, sprite images and exit edges,
// the World check, the levels' game BGs, a prefab's places, the loads comparing a broken up prefab, the slippery entrance actions, the object
// tables) run here too, in lanes (one job at a time, a request replacing the lane's others drops them), taking turns
// with the tasks; they choose whether the display data counts for them (pictures: it does; the probes and tasks: it
// doesn't, ADR 0008).
// The level as edited the tiles of the level and the placement preview are learned on comes whole once (then named by
// its id, probeprotocol.ts StateRef), the latest few kept.
// After the first copy of the ROM the editor sends the ranges a change wrote: queued jobs stay, a task starts over
// before its next step only when it read a changed byte, results are checked against the ROM as always.

import { Rom } from './rom.ts';
import { BlockProber } from './blockprobe.ts';
import { storeKey, type CacheEntry } from './romdeps.ts';
import { JobRunner, type Job, type JobRun } from './jobrunner.ts';
import { objKindsJob, kindsKey } from './objkinds.ts';
import { levelScanJob, type ScanResult } from './levelscan.ts';
import { cameraAtJob, type CameraAt } from './camerareach.ts';
import { spriteSetJob, spriteAtJob, spriteBytesJob } from './spritegfx.ts';
import { LevelUses, levelUsesJob, levelTilesJob, levelOverride } from './levelusage.ts';
import { layer3KindsJob } from './layer3.ts';
import { SpriteGroupResults, spriteMemCheckJob } from './spritemem.ts';
import { owAnimatedJob } from './owanimated.ts';
import { animatedJob, type LevelEmulator } from './levelemu.ts';
import { objectThumbsJob, placementPreviewJob, withPlaced } from './objthumbs.ts';
import { jumpArcsJob } from './jumparcs.ts';
import { layer2MotionsJob } from './l2scroll.ts';
import { pathKindsJob, pathShapesJob } from './owpaths.ts';
import { passableEdgesJob } from './owexitedges.ts';
import { worldCheckJob } from './worldcheck.ts';
import { revealWalkJob } from './revealwalk.ts';
import { KeptSuggestions, prefabSuggestionsJob } from './prefabsuggest.ts';
import { SizeProbe, sizesJob } from './objresize.ts';
import { OverworldEmulator, OverworldLoads, overworldMapJob, OW_LOADS_KEPT } from './overworld.ts';
import { submapViewsJob, layer1WithoutJob, EventL1Copy } from './owevents.ts';
import { owSpritesJob, owCustomJob, owLooksJob } from './owsprites.ts';
import { owTriggerJob, owGameColorsJob } from './owanimview.ts';
import { owScreenJob } from './owlayer3.ts';
import { progressSaveJob, progressFlagsJob } from './owprogress.ts';
import { messageRoutineJob } from './messagedraw.ts';
import { gameBgJob } from './tilemove.ts';
import { prefabPlacesJob } from './prefabplaces.ts';
import { sameTilesJob } from './prefabsources.ts';
import { slipperyJob } from './slippery.ts';
import { objectTableJob } from './objectnames.ts';
import { inputHash, type EditState } from './inputs.ts';
import { Lane, Lanes, laneId } from './lanes.ts';
import { jobId, jobKey, learnKeep, LEARN_KINDS, EDIT_STATES, type StateRef, type ProbeJob, type ProbeMessage, type ProbeReply, type TaskMessage, type TaskType, type LearnJob, type LearnMessage, type LearnLane } from './probeprotocol.ts';

// a longer task: what was asked (a request asking for the same result may have replaced it) and its job
interface Task { msg: TaskMessage; run: JobRun<unknown> }

// a task's job (none of them is a picture); one that finds nothing (null) gives undefined, which isn't kept
function taskJob(m: TaskMessage): (emu: LevelEmulator) => Job<unknown> {
  switch (m.type) {
    case 'kinds': return (emu) => objKindsJob(emu, { ...m.level, header: { ...m.level.header, tileset: m.ts } }, m.layer2Pointer);
    case 'scan': return (emu) => found(levelScanJob(emu, m.level));
    case 'camera': return (emu) => found(cameraAtJob(emu, m.level, m.x, m.y));
  }
}
function* found<T>(job: Generator<void, T | null>): Job<T | undefined> { return (yield* job) ?? undefined; }

// what learn jobs keep between them: the levels' uses (the entries of each level), the results of single sprite
// groups (the sprite memory check's), the results of single levels of the prefab suggestions and the object boxes
// probed in a level (dropped when the ROM changes, as the editor keeps them per ROM state), the overworld's loads (each
// kept while the ROM bytes it read are unchanged; made when first used), the ROM copy layer 1 without an event's
// changes is emulated on (owevents.ts EventL1Copy; made when first used); the ROM; the block prober (the switch tiles
// of the save at an event progress)
interface LearnState {
  prober: BlockProber; uses: LevelUses; groups: SpriteGroupResults; suggest: KeptSuggestions; sizes: { key: string; probe: SizeProbe } | null; ow: OverworldLoads | null; l1Copy: EventL1Copy | null; rom: Rom;
}
const owLoads = (state: LearnState) => (state.ow ??= new OverworldLoads(new OverworldEmulator(state.rom), OW_LOADS_KEPT));

// a learn job's job; show takes what it shows while it runs (null: it started, also over); latest: the job of the latest
// request it answers (learnRetargets: the levels' uses take up its list as they run)
function learnJob(j: LearnJob, state: LearnState, show: (items: unknown[] | null) => void, latest: () => LearnJob = () => j): JobRun<unknown>['start'] {
  switch (j.kind) {
    case 'sprites': return (emu, _p, part) => spriteSetJob(emu, j.level, j.nums, show, part, j.input);
    case 'spriteAt': return (emu) => spriteAtJob(emu, j.level, j.id, j.x, j.y);
    case 'spriteBytes': return (emu) => spriteBytesJob(emu, j.level, j.id, j.bytes);
    case 'uses': return (emu) => levelUsesJob(state.uses, emu, () => (latest() as typeof j).levels, show);
    case 'spriteMem': return (emu) => spriteMemCheckJob(emu, j.level, state.groups);
    case 'animated': return (emu) => animatedJob(emu, j.level, j.ov);
    case 'layer3': return (emu) => layer3KindsJob(emu, j.level, j.ov);
    case 'levelTiles': return (emu) => {
      // (the owners of its bytes as the client's, serialized again here: not sent)
      const s = sent(j.state), ov = s.ov.byteOwner ? s.ov : { ...s.ov, byteOwner: levelOverride(state.rom, s.level).byteOwner };
      return levelTilesJob(state.rom, emu, s.level, ov);
    };
    case 'thumbs': {
      const keys = new Map(j.specs.map((s, i) => [s, j.keys[i]]));
      return (emu) => objectThumbsJob(state.rom, emu, j.level, j.specs, (s) => keys.get(s)!);
    }
    case 'preview': return (emu) => {
      const p = withPlaced(state.rom, sent(j.state), j.layer2, j.objects);
      return placementPreviewJob(state.rom, emu, p.level, p.ov, j.layer2, p.placed);
    };
    case 'arcs': return (emu, prepare) => jumpArcsJob(emu, prepare, j.level, j.load, j.tx, j.ty, j.runs);
    case 'layer2Motions': return function* (emu) { return (yield* layer2MotionsJob(emu, j.level, j.ov)).result; };
    case 'pathKinds': return (emu) => pathKindsJob(emu);
    case 'pathShapes': return (emu) => pathShapesJob(emu);
    case 'revealWalks': return (emu) => revealWalkJob(emu);
    case 'suggest': return (emu) => prefabSuggestionsJob(state.rom, emu, state.suggest, j.levels, j.open);
    case 'sizes': return (emu) => {
      const key = `${j.level.number}:${inputHash(j.level.header)}:${j.layer2Pointer}`;
      if (state.sizes?.key !== key) state.sizes = { key, probe: new SizeProbe(state.rom, j.level, j.layer2Pointer) };
      return sizesJob(state.sizes.probe, emu, j.specs);
    };
    case 'owMap': return () => overworldMapJob(owLoads(state), j.map, j.progress, !!j.special);
    case 'owTriggers': return () => owTriggerJob(owLoads(state), j.map, j.progress, j.special, j.switches);
    case 'owScreen': return () => owScreenJob(owLoads(state), j.map, j.special);
    case 'owGameColors': return () => owGameColorsJob(owLoads(state), j.map, j.progress, j.special);
    case 'owViews': return () => submapViewsJob(owLoads(state));
    case 'owSprites': return () => owSpritesJob(owLoads(state), j.map, j.progress);
    case 'owCustom': return () => owCustomJob(owLoads(state), j.map, j.progress);
    case 'owLooks': return () => owLooksJob(owLoads(state), j.ids);
    case 'owAnimated': return () => owAnimatedJob(owLoads(state), j.map, j.progress);
    case 'owSave': return (emu) => progressSaveJob(owLoads(state), j.progress, { uses: state.uses, emu, prober: state.prober });
    case 'owL1Without': return () => layer1WithoutJob(state.l1Copy ??= new EventL1Copy(), state.rom, j.event);
    case 'owProgressFlags': return () => progressFlagsJob(owLoads(state));
    case 'owExitEdges': return () => passableEdgesJob(state.rom, owLoads(state), j.kinds, j.shapes);
    case 'owWorldCheck': return () => worldCheckJob(state.rom, owLoads(state), j.kinds, j.shapes, j.open);
    case 'msgRoutine': return (emu) => messageRoutineJob(state.rom, emu);
    case 'gameBg': return (emu) => gameBgJob(emu, j.level);
    case 'prefabPlaces': return (emu) => prefabPlacesJob(state.rom, emu, j.prefab, j.levels, j.open, j.skip);
    case 'sameTiles': return (emu) => sameTilesJob(emu, j.level, j.a, j.b);
    case 'slippery': return (emu) => slipperyJob(emu);
    case 'objectTable': return (emu) => objectTableJob(emu, j.tileset);
    case 'scan': return (emu) => levelScanJob(emu, j.level);
  }
}

// the level as edited a job names (the host has it whole when the job is asked for, ProbeHost.learn; else the job fails)
function sent(s: StateRef): EditState {
  if ('level' in s) return s;
  throw new Error(`level as edited ${s.id} not sent`);
}

// a learn job asked for: the latest request for its result, its job and what it showed since the last reply
interface Learn { msg: LearnMessage; run: JobRun<unknown>; fresh: boolean; shown: unknown[] }
// what takes turns: the tasks and the lanes with jobs (a lane's first job runs; its name is its emulator's, as a task's
// type is: a lane is named as no task, ProbeBusyKey)
type Turn = Task | Lane<LearnLane, Learn>;

// the result cache key of a task's result
const taskKey = (m: TaskMessage) => (m.type === 'kinds' ? kindsKey(m.ts) : m.key);

export class ProbeHost {
  private rom: Rom | null = null;
  private prober: BlockProber | null = null;
  private runner: JobRunner | null = null;
  private state: LearnState | null = null;
  private gen = -1;
  private asked = new Map<string, ProbeJob>(); // requested directly: first
  private prefetch = new Map<string, ProbeJob>();
  private tasks = new Map<TaskType, Task>(); // running, by type
  private lanes = new Lanes<LearnLane, Learn>((l) => laneId(l.msg.key, l.msg.input));
  private turns = new Set<Turn>(); // the running tasks and the lanes with jobs, in turn (the next first)
  // cancelled tasks, not run: taken up again when the same result is asked for before another task of their type
  // (which would use their emulator)
  private cancelled = new Map<TaskType, Task>();
  private turned = false; // the last job run was a turn's (prefetched probes take turns with them)
  private states = new Map<string, EditState>(); // the levels as edited sent whole, the latest EDIT_STATES (kept over ROMs)

  // tasks' jobs (re)started
  get started(): number { return this.runner?.started ?? 0; }

  // a new ROM (gen: the editor's count of changes); queued jobs and tasks are dropped
  setRom(gen: number, data: Uint8Array): void {
    this.gen = gen;
    this.asked.clear();
    this.prefetch.clear();
    this.tasks.clear();
    this.lanes.clearAll();
    this.turns.clear();
    this.cancelled.clear();
    if (!this.rom || !this.prober) {
      const rom = this.rom = new Rom(new Uint8Array(0));
      rom.data = data;
      this.prober = new BlockProber(rom);
      // the tasks' emulators start from the prober's boot snapshot, which leaves out the display data as the probes
      // do (ADR 0008): the prober's emulator gets the runner's mask (gfxDisplaySkipMask)
      this.runner = new JobRunner({ rom, results: this.prober.results, noDisplay: this.prober.emu });
      const fp = this.prober.results.fp;
      this.state = { prober: this.prober, uses: new LevelUses(rom, this.prober.results), groups: new SpriteGroupResults(fp), suggest: new KeptSuggestions(fp), sizes: null, ow: null, l1Copy: null, rom };
      return;
    }
    this.rom.data = data;
    this.state!.sizes = null;
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
    this.state!.sizes = null;
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
      case 'learn': this.learn(m); break;
      case 'unlearn': this.unlearn(m.lane); break;
    }
  }

  // a learn job asked for: queued in its lane, unless the lane has one for the same result (it answers this request
  // then); replace drops the lane's other jobs
  private learn(msg: LearnMessage): void {
    if (!this.runner) return;
    msg = this.withState(msg);
    const id = laneId(msg.key, msg.input), runner = this.runner, state = this.state!;
    if (msg.replace) this.lanes.replace(msg.lane, id);
    if (msg.parts) this.prober!.results.load(msg.parts); // (not handed back: the editor has them)
    const { job, added, lane } = this.lanes.join(msg.lane, id, () => {
      const show = (items: unknown[] | null) => { if (items === null) { l.fresh = true; l.shown = []; } else l.shown.push(...items); };
      // (a job starting over runs for the latest request, the levels' uses take up its list as they run)
      const start: JobRun<unknown>['start'] = (emu, p, part) => learnJob(l.msg.job, state, show, () => l.msg.job)(emu, p, part);
      const l: Learn = { msg, fresh: false, shown: [], run: runner.run({ key: msg.key, input: msg.input, ...LEARN_KINDS[msg.job.kind], start }) };
      return l;
    });
    if (!added) job.msg = msg;
    this.turns.add(lane); // (one with jobs keeps its turn)
  }

  // the request with the level as edited it names whole: kept when sent whole (the latest EDIT_STATES, in the order
  // first sent, as the client counts them), else the one kept
  private withState(msg: LearnMessage): LearnMessage {
    const j = msg.job;
    if (!('state' in j)) return msg;
    const s = j.state;
    if ('level' in s) {
      const had = this.states.has(s.id);
      this.states.set(s.id, s);
      if (!had && this.states.size > EDIT_STATES) this.states.delete(this.states.keys().next().value!);
      return msg;
    }
    const known = this.states.get(s.id);
    return known ? { ...msg, job: { ...j, state: known } } : msg;
  }

  // the jobs of a lane are not wanted any more
  private unlearn(name: LearnLane): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    this.lanes.clear(name);
    this.turns.delete(lane);
  }

  // a step of the lane's first job: its result when it ended, else its progress
  private learnStep(lane: Lane<LearnLane, Learn>, l: Learn): ProbeReply {
    const m = l.msg;
    let r: { result: unknown } | null, failed = false;
    try { r = this.runner!.step(lane.name, l.run); } catch (e) { console.error(e); r = { result: null }; failed = true; }
    if (r) {
      this.lanes.remove(lane.name, l);
      // (a result kept as its parts only: its parts are among the entries set)
      const keep = failed || LEARN_KINDS[m.job.kind].whole === false ? false : learnKeep(m.job);
      const memory = keep !== 'memory' ? undefined : this.runner!.memory.entry(m.key, m.input);
      return {
        type: 'learned', gen: this.gen, lane: m.lane, key: m.key, input: m.input, result: failed ? null : r.result, failed,
        put: [...this.put(keep !== true ? null : m.key, m.input), ...this.usesKnown(m.job)], ...(memory && { memory: { ...memory, input: m.input } }),
      };
    }
    const d: ProbeReply = { type: 'learning', gen: this.gen, lane: m.lane, key: m.key, input: m.input, label: l.run.label, fresh: l.fresh, shown: l.shown, put: this.put(null) };
    l.fresh = false;
    l.shown = [];
    return d;
  }

  // The entries of the levels' uses asked for that this cache holds, also those not set since the last reply: the
  // editor asked for them as it doesn't have them (it may have dropped one, computed on an older ROM generation), and
  // would otherwise ask again and again
  private usesKnown(j: LearnJob): [string, CacheEntry][] {
    if (j.kind !== 'uses') return [];
    return j.levels.flatMap((n) => { const e = this.state!.uses.entry(n); return e ? [e] : []; });
  }

  // the task of that type is not wanted any more: it runs no further step (kept, see startTask)
  private cancel(type: TaskType): void {
    const t = this.tasks.get(type);
    if (!t) return;
    this.tasks.delete(type);
    this.turns.delete(t);
    this.cancelled.set(type, t);
  }

  // a task asked for: replaces the running one of its type, unless that one or the cancelled one finds the same result
  // (it answers this request then, going on where it stood)
  private startTask(msg: TaskMessage): void {
    if (!this.runner) return;
    const running = this.tasks.get(msg.type), t = running ?? this.cancelled.get(msg.type);
    this.cancelled.delete(msg.type);
    if (t && taskKey(t.msg) === taskKey(msg)) { t.msg = msg; this.setTask(t); return; } // (a running one keeps its turn)
    if (running) this.turns.delete(running); // (the new one's turn comes last)
    // (a job starting over runs for the latest request)
    const task: Task = { msg, run: this.runner.run({ key: taskKey(msg), keep: true, picture: false, boot: msg.type !== 'kinds', start: (emu) => taskJob(task.msg)(emu) }) };
    this.setTask(task);
  }

  private setTask(t: Task): void {
    this.tasks.set(t.msg.type, t);
    this.turns.add(t);
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

  get pending(): number { return this.asked.size + this.turns.size + this.prefetch.size; }

  // runs the next job (asked probes, then a step of a longer task or a learn job taking turns with a prefetched probe,
  // so a long one, as the levels' uses, doesn't hold up what the palettes show); null when nothing finished (a learn
  // job's step gives its progress)
  next(): ProbeReply | null {
    this.turned = !this.asked.size && this.turns.size > 0 && !(this.turned && this.prefetch.size);
    if (this.turned) {
      const [turn] = this.turns;
      this.turns.delete(turn);
      if (turn instanceof Lane) {
        const first = turn.first;
        if (!first) return null; // (all done)
        const d = this.learnStep(turn, first);
        if (turn.first) this.turns.add(turn); // (the next turn's next)
        return d;
      }
      const type = turn.msg.type;
      let r: { result: unknown } | null;
      try { r = this.runner!.step(type, turn.run); } catch (e) { console.error(e); r = { result: null }; }
      if (r) { this.tasks.delete(type); return this.taskDone(turn, r.result ?? null); }
      this.turns.add(turn); // (the next turn's next)
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

// how a pump waits for its next turn (run: the turn), and a turn's start, giving whether another job fits in it; while
// urgent work is asked for (urgent), the next turn comes by soon (also when a turn by wait is held up)
export interface PumpSchedule { wait(run: () => void): void; startTurn(): () => boolean; soon?(run: () => void): void; urgent?(): boolean }

// Drives a host: each turn runs its jobs while there is work and the turn lasts, hands the replies on and waits
// for the next turn while work is left. Returns where the editor's messages go (the work they make is scheduled), and
// recheck(): the urgency changed (a turn waiting for the background slices is taken soon instead)
export function pumpProbes(host: ProbeHost, reply: (d: ProbeReply) => void, schedule: PumpSchedule): ((m: ProbeMessage) => void) & { recheck(): void } {
  let scheduled = false, urged = false;
  const run = () => {
    scheduled = urged = false;
    const more = schedule.startTurn();
    do {
      const d = host.next();
      if (d) reply(d);
    } while (host.pending && more());
    later();
  };
  const later = () => {
    if (!host.pending) return;
    const urgent = !!schedule.soon && !!schedule.urgent?.();
    if (scheduled && (urged || !urgent)) return;
    scheduled = true;
    urged = urgent;
    if (urgent) schedule.soon!(run); else schedule.wait(run);
  };
  return Object.assign((m: ProbeMessage) => { host.handle(m); later(); }, { recheck: later });
}
