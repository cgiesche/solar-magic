// What the editor (probeclient.ts) and the probe host (probehost.ts, in the probe worker) say to each other:
// the probe jobs with their ids and result cache keys, the messages the editor sends and the replies.

import type { CacheEntry } from './romdeps.ts';
import type { ResultGet } from './romdeps.ts';
import { blockKey, collisionKey, spriteKey, spriteTsKey, runsKey, cameraKey, spriteProbeIn } from './blockprobe.ts';
import type { KindLevel, ObjKind } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';
import type { CameraAt } from './camerareach.ts';
import type { SpriteLevel } from './spritegfx.ts';
import type { SpriteMemLevel } from './spritemem.ts';
import type { LevelOverride } from './levelemu.ts';
import type { Level, LevelObject, ScreenExit } from './level.ts';
import type { EditState } from './inputs.ts';
import { spriteSetParts } from './spritegfx.ts';
import type { Keep } from './jobrunner.ts';
import type { ObjSpec } from './objthumbs.ts';
import type { RunStates } from './blockprobe.ts';
import type { SizeSpec } from './objresize.ts';
import type { ArcLoad } from './jumparcs.ts';
import type { Prefab } from './prefabs.ts';
import type { PrefabSkip } from './prefabplaces.ts';
import type { OwTriggerSwitches } from './owanimview.ts';
import type { PathKind, PathShapes } from './owpaths.ts';
import type { HardWalk } from './owhardpaths.ts';
import type { EventProgress } from './eventset.ts';

// a probe in tileset ts: what a Map16 tile does, how Mario collides with it, what a sprite does, Mario's
// run speeds, the scroll bands in a level of that mode and vertical scroll setting
export type ProbeJob =
  | { kind: 'block'; ts: number; tile: number }
  | { kind: 'collision'; ts: number; tile: number }
  | { kind: 'sprite'; ts: number; num: number }
  | { kind: 'runs'; ts: number }
  | { kind: 'bands'; ts: number; mode: number; vscroll: number };

// the result cache key of a job's result
export function jobKey(j: ProbeJob): string {
  switch (j.kind) {
    case 'block': return blockKey(j.ts, j.tile);
    case 'collision': return collisionKey(j.ts, j.tile);
    case 'sprite': return spriteKey(j.num); // (for all tilesets, or saying it is kept per tileset: jobResult)
    case 'runs': return runsKey(j.ts);
    case 'bands': return cameraKey(j.ts, j.mode, j.vscroll);
  }
}
// the job's id in a queue: its result cache key (one per job), except a sprite's, which names its tileset too (its
// result may be kept per tileset, and a failure is one in that tileset): look a job's result up by jobResult, not by id
export const jobId = (j: ProbeJob): string => j.kind === 'sprite' ? spriteTsKey(j.ts, j.num) : jobKey(j);
// the job's result among results (a sprite's is kept once for all tilesets unless it read the tileset)
export function jobResult<T>(results: ResultGet, j: ProbeJob): T | undefined {
  return (j.kind === 'sprite' ? spriteProbeIn(results, j.ts, j.num) : results.get(jobKey(j))) as T | undefined;
}

export interface ProbeDone {
  type: 'probe';
  gen: number; // ROM generation the job ran on (see ProbeHost.setRom)
  job: ProbeJob;
  put: [string, CacheEntry][]; // new result cache entries
  failed: boolean;
}

// the object kinds of tileset ts, with their result cache entry (none: the probe failed)
export interface KindsDone { type: 'kinds'; gen: number; ts: number; failed: boolean; put: [string, CacheEntry][] }
// while the object kinds of tileset ts run: those of the open level's objects (the task's first), known before the rest
// (objkinds.ts objKindsJob; those not plain), with the entries set meanwhile; not kept, the result replaces them
export interface KindsShown { type: 'kindsShown'; gen: number; ts: number; kinds: [number, ObjKind][]; put: [string, CacheEntry][] }
// a level scan (id: the editor's request; result null: it failed), with its result cache entry
export interface ScanDone { type: 'scan'; gen: number; id: number; result: ScanResult | null; put: [string, CacheEntry][] }
// the camera at Mario standing at a place (id: the editor's request; result null: it failed), with its result cache entry
export interface CameraDone { type: 'camera'; gen: number; id: number; result: CameraAt | null; put: [string, CacheEntry][] }
export type ProbeReply = ProbeDone | KindsDone | KindsShown | ScanDone | CameraDone | Learned | Learning;

// A result learner job (CONTEXT.md) run here: the images of all sprites of a sprite set, the image of a sprite at a
// tile (its variant by position), the image of a custom sprite with extra bytes, the tiles of the levels not known yet
// (their uses, levelusage.ts), a level's sprite memory check, the tiles and colors animating in a level, what the four
// layer 3 settings do in a level as given (layer3.ts), the tiles of a level as edited (levelusage.ts levelTilesAll),
// the object picker's thumbnails (objthumbs.ts; keys: each object's key, objKey), the placement preview (objthumbs.ts
// placementPreviewJob: the objects placed in the level as edited, withPlaced), the jump arcs from a tile (jumparcs.ts;
// level: the hash of the level as loaded, load: what it is loaded with), what the layer 2 scroll settings do in a level
// (l2scroll.ts), what Mario does on each overworld layer 1 tile and how path tiles move him (owpaths.ts), the prefab
// suggestions (prefabsuggest.ts; open: the open level as edited) and the boxes of objects at sizes (objresize.ts;
// layer2Pointer: the level's layer 2 objects as the probe loads take them); the overworld's map at an event progress
// (overworld.ts overworldMapJob), it with the event triggers of its animations switched and the colors the game keeps
// setting there (owanimview.ts), the submaps' views (owevents.ts submapViews), the overworld sprites' images at a map
// and event progress (owsprites.ts owSpriteImages), the steps of a map's animation (owanimsteps.ts) and the save at an
// event progress (owprogress.ts progressSaves),
// layer 1 as after an event without its layer 1 changes (owevents.ts layer1Without), the World check's part the same at
// every progress shown (worldcheck.ts worldCheckJob; open: the open level with its exits as edited); whether the game
// draws the editor's messages (messagedraw.ts messageRoutine); a level's game BG as its load as saved has it
// (tilemove.ts gameBgJob), where a prefab's arrangement already is (prefabplaces.ts prefabPlacesJob; open: the open
// level as edited, skip: the objects that are no place's), whether two loads of a level draw the same tiles
// (prefabsources.ts sameTilesJob: a prefab broken up into its sources), the entrance actions that make a level slippery
// (slippery.ts slipperyJob), the object table of a tileset (objectnames.ts objectTableJob), the level scan of a level
// an image draws (levelscan.ts; the open level's own scan is a task, its result under the same key)
export type LearnJob =
  // (input: of each test level load; first: the open level's sprites, captured first, spriteSetJob)
  | { kind: 'sprites'; level: SpriteLevel; nums: number[]; input?: string; first?: number[] }
  | { kind: 'spriteAt'; level: SpriteLevel; id: number; x: number; y: number }
  | { kind: 'spriteBytes'; level: SpriteLevel; id: number; bytes: number[] }
  | { kind: 'uses'; levels: number[] }
  | { kind: 'spriteMem'; level: SpriteMemLevel }
  | { kind: 'animated'; level: number; ov: LevelOverride }
  | { kind: 'layer3'; level: number; ov: LevelOverride }
  | { kind: 'levelTiles'; state: StateRef }
  | { kind: 'thumbs'; level: Level; specs: ObjSpec[]; keys: string[]; input: string } // (input: of each of its loads, objectThumbsJob)
  | { kind: 'preview'; state: StateRef; layer2: boolean; objects: LevelObject[] }
  | { kind: 'arcs'; level: string; load: ArcLoad; tx: number; ty: number; runs: RunStates }
  | { kind: 'layer2Motions'; level: number; ov: LevelOverride }
  | { kind: 'pathKinds' }
  | { kind: 'pathShapes' }
  | { kind: 'revealWalks' }
  // the game's hardcoded paths (owhardpaths.ts) on the map with every event passed: layer 1, translevels, the tiles tried
  | { kind: 'hardWalks'; l1: number[]; tls: number[]; cells: number[] }
  | { kind: 'suggest'; levels: number[]; open?: Level }
  | { kind: 'sizes'; level: KindLevel; layer2Pointer: number; specs: SizeSpec[] }
  | { kind: 'owMap'; map: number; progress: EventProgress; special?: boolean }
  | { kind: 'owTriggers'; map: number; progress: EventProgress; special: boolean; switches: OwTriggerSwitches }
  | { kind: 'owGameColors'; map: number; progress: EventProgress; special: boolean }
  | { kind: 'owScreen'; map: number; special: boolean }
  | { kind: 'owViews' }
  | { kind: 'owSprites'; map: number; progress: EventProgress }
  | { kind: 'owCustom'; map: number; progress: EventProgress }
  | { kind: 'owLooks'; ids: number[] }
  | { kind: 'owSave'; progress: EventProgress }
  | { kind: 'owAnimated'; map: number; progress: EventProgress }
  | { kind: 'owAnimSteps'; map: number; progress: EventProgress }
  | { kind: 'owL1Without'; event: number }
  | { kind: 'owExitEdges'; kinds: PathKind[]; shapes: PathShapes; hard: HardWalk[] }
  | { kind: 'owWorldCheck'; kinds: PathKind[]; shapes: PathShapes; hard: HardWalk[]; open?: { number: number; exits: ScreenExit[] } }
  | { kind: 'msgRoutine' }
  | { kind: 'gameBg'; level: number }
  | { kind: 'prefabPlaces'; prefab: Prefab; levels: number[]; open?: Level; skip?: PrefabSkip }
  | { kind: 'sameTiles'; level: number; a: LevelOverride; b: LevelOverride }
  | { kind: 'slippery' }
  | { kind: 'objectTable'; tileset: number }
  | { kind: 'scan'; level: ScanLevel };

// The level as edited a job is learned on (inputs.ts EditState; levelTiles, preview): the probe client sends it whole
// with the first request to a host, later ones name it by its id; a host keeps the latest EDIT_STATES sent whole (the
// client knows which: it sends them in the same order)
export type StateRef = EditState | { id: string };
export const EDIT_STATES = 4;

// Whether a later request for the same result (key and input) asks the job for other work, which it then takes up as
// it runs: the levels' uses with another list of levels (the running job scans the levels the latest list still needs),
// a sprite set with other sprites first (another level opened: its sprites are captured next)
export function learnRetargets(was: LearnJob, now: LearnJob): boolean {
  if (was.kind === 'sprites' && now.kind === 'sprites') return (was.first ?? []).join() !== (now.first ?? []).join();
  return was.kind === 'uses' && now.kind === 'uses' && was.levels.join() !== now.levels.join();
}

// Whether a learn job is the open level's work (CONTEXT.md "Open level's work"): run before the asked probes, the other lanes
// and the tasks, and the prefetch (probehost.ts ProbeHost.next) – the object boxes for resizing, a sprite set while the
// loads with the open level's sprites are to come (the job says when they are done, spriteSetJob's ahead)
export function learnAhead(j: LearnJob): boolean {
  return j.kind === 'sizes' || (j.kind === 'sprites' && !!j.first?.length);
}

// Per kind of learn job where its result goes (keep, jobrunner.ts Keep) and whether it is a picture (CONTEXT.md, ADR
// 0008): the levels' uses go to the entries of each level (the job keeps none); the prefab suggestions and the object
// boxes to the editor only (it keeps them as a run's and per ROM state); the animated tiles and colors, the tiles of
// the level as edited, the placement preview and the jump arcs change with every edit (memory only); the others to the
// result cache. The overworld's jobs run on the overworld's own emulator (layer 1 without an event's changes on a ROM
// copy's), not on one booted for levels: its boot doesn't count for them (boot false, jobrunner.ts JobSpec); it has no
// skip mask, so they count the display data, the submaps' views, the save at a progress, layer 1 without an event's
// changes, the maps at every progress and the saves' level flags there, the World check (no pictures) too: marked
// pictures (ADR 0008). They change with the map
// painted, the event progress slider goes through many (memory only). A level's game BG (Map16 numbers, no picture) goes to the result cache; the places of
// a prefab and whether two loads draw the same tiles are asked for once, by a dialog or an action (to the editor only).
// A sprite set's images are kept as their parts only (whole false, learnParts).
export const LEARN_KINDS: { [K in LearnJob['kind']]: { keep: Keep; picture: boolean; boot?: false; whole?: false } } = {
  sprites: { keep: true, picture: true, whole: false },
  spriteAt: { keep: true, picture: true },
  spriteBytes: { keep: true, picture: true },
  uses: { keep: false, picture: false },
  spriteMem: { keep: true, picture: false },
  animated: { keep: 'memory', picture: true },
  layer3: { keep: true, picture: false },
  levelTiles: { keep: 'memory', picture: false },
  thumbs: { keep: true, picture: true },
  preview: { keep: 'memory', picture: true },
  arcs: { keep: 'memory', picture: false },
  layer2Motions: { keep: true, picture: false },
  pathKinds: { keep: true, picture: false },
  pathShapes: { keep: true, picture: false },
  revealWalks: { keep: true, picture: false },
  hardWalks: { keep: true, picture: false },
  suggest: { keep: false, picture: false },
  sizes: { keep: false, picture: false },
  owMap: { keep: 'memory', picture: true, boot: false },
  owTriggers: { keep: 'memory', picture: true, boot: false },
  owGameColors: { keep: 'memory', picture: true, boot: false },
  owScreen: { keep: 'memory', picture: true, boot: false },
  owViews: { keep: 'memory', picture: true, boot: false },
  owSprites: { keep: 'memory', picture: true, boot: false },
  owCustom: { keep: 'memory', picture: true, boot: false },
  owLooks: { keep: 'memory', picture: true, boot: false },
  owSave: { keep: 'memory', picture: true, boot: false },
  owAnimated: { keep: 'memory', picture: true, boot: false },
  owAnimSteps: { keep: 'memory', picture: true, boot: false },
  owL1Without: { keep: 'memory', picture: true, boot: false },
  owExitEdges: { keep: 'memory', picture: true, boot: false },
  owWorldCheck: { keep: 'memory', picture: true, boot: false },
  msgRoutine: { keep: true, picture: false },
  gameBg: { keep: true, picture: false },
  prefabPlaces: { keep: false, picture: false },
  sameTiles: { keep: false, picture: false },
  slippery: { keep: true, picture: false },
  objectTable: { keep: true, picture: false },
  scan: { keep: true, picture: false },
};
export const learnKeep = (j: LearnJob): Keep => LEARN_KINDS[j.kind].keep;

// The parts a result kept as its parts only (whole: false; jobrunner.ts Part) is put together from: their sub keys and
// inputs, and how. A sprite set's images are kept per test level load (spriteSetJob), not again as the whole set.
export function learnParts(j: LearnJob): { parts: [string, string][]; join(data: unknown[]): unknown } | null {
  if (j.kind !== 'sprites' || LEARN_KINDS[j.kind].whole !== false) return null;
  return { parts: spriteSetParts(j.nums, j.input).map((p) => [p.sub, p.input]), join: (data) => (data as unknown[][]).flat() };
}

// The lanes of learn jobs (lanes.ts): the editor's fixed set, a lane per custom overworld sprite map (owc and the map).
// Their names are busy keys too (ProbeBusyKey), so none is a task's type.
export type LearnLane =
  | 'sprites' | 'variants' | 'bytes' | 'spritemem' | 'animated' | 'layer3' | 'l2' | 'lt' | 'uses' | 'arcs' | 'thumbs'
  | 'placement' | 'sizes' | 'prefab-suggest' | 'msgr' | 'level-png' | 'level-images' | 'gamebg' | 'prefab-places'
  | 'breakup' | 'slippery' | 'otab'
  | 'ow' | 'owpick' | 'owpk3' | 'owsh' | 'owreach' | 'owrw' | 'owhw' | 'owlw' | 'owmb' | 'owps' | 'owpn' | 'owpa' | 'owxe' | 'owwc' | 'owv' | 'owt' | 'owgc' | 'ows' | 'owbs' | 'owbt' | 'owl' | 'owan' | 'owas' | `owc${number}`;

// Who asks for the save at an event progress (owSave, App.progressSave) and the lane it is asked in (#388): a test play
// (owps: it waits for its own), the event progress shown (owpn: a new one replaces the one asked before, clicking
// through the event list queues no save per progress), every event passed (owpa: the same at every progress shown)
export type SaveAsker = 'test' | 'shown' | 'every';
export const SAVE_LANES: Record<SaveAsker, { lane: LearnLane; replace: boolean }> = {
  test: { lane: 'owps', replace: false }, shown: { lane: 'owpn', replace: true }, every: { lane: 'owpa', replace: false },
};
// the overworld view's lanes of seconds of work, unlearned when the overworld is left (App.overworldLeft): the shown
// progress's saves, the World check, the exits' arrows, the map's animation (not a test play's save)
export const OW_LEFT_LANES: LearnLane[] = ['owpn', 'owpa', 'owwc', 'owxe', 'owas'];

// what the probe client shows as busy: the probes, the tasks, the learn jobs' lanes
export type ProbeBusyKey = 'probe' | TaskType | LearnLane;
// (no lane is named as a task: compile error otherwise)
const NO_TASK_LANE: [LearnLane & TaskType] extends [never] ? true : never = true;
void NO_TASK_LANE;

// a learn job asked for: its result under key and input (the hash of what it depends on outside the ROM, inputs.ts),
// learned in a lane (one job at a time, in the order asked); replace drops the lane's other jobs; parts: the editor's
// stored entries of the result's parts for their current inputs (learnParts; jobrunner.ts Part, by stored key)
export interface LearnMessage { type: 'learn'; lane: LearnLane; key: string; input?: string; job: LearnJob; replace: boolean; parts?: [string, CacheEntry][] }

// a learn job's result (failed: it threw, result null), with its result cache entry (memory: the entry of one kept in
// memory only, learnKeep)
export interface Learned {
  type: 'learned'; gen: number; lane: LearnLane; key: string; input?: string; result: unknown; failed: boolean; put: [string, CacheEntry][]; memory?: CacheEntry;
}
// a step of a learn job that didn't finish it: its progress label, what it shows meanwhile (the job's items since the
// last reply; fresh: it started (over) since then, what it showed before goes) and the entries set meanwhile
export interface Learning {
  type: 'learning'; gen: number; lane: LearnLane; key: string; input?: string; label: string | null; fresh: boolean; shown: unknown[]; put: [string, CacheEntry][];
}

// the longer tasks; those the editor can say it doesn't want any more
export type TaskType = 'kinds' | 'scan' | 'camera';
export type CancelableTask = 'scan';

// what the editor sends: the ROM (the whole of it, or the bytes a change wrote at their offsets and the new
// size), jobs asked for, the prefetch queue, the longer tasks (a new one replaces the running one of its
// type, unless it asks for the same result) and that the task of a type is not wanted any more, learn jobs and that
// the jobs of a lane are not wanted any more
export type ProbeMessage =
  | { type: 'rom'; gen: number; data: Uint8Array }
  | { type: 'edit'; gen: number; size: number; edits: [number, Uint8Array][] }
  | { type: 'ask'; jobs: ProbeJob[] }
  | { type: 'prefetch'; jobs: ProbeJob[] }
  // (first: the open level's standard objects, their kinds known first, KindsShown)
  | { type: 'kinds'; ts: number; level: KindLevel; layer2Pointer: number; first?: number[] }
  | { type: 'scan'; id: number; key: string; level: ScanLevel }
  | { type: 'camera'; id: number; key: string; level: ScanLevel; x: number; y: number }
  | { type: 'cancel'; task: CancelableTask }
  | LearnMessage
  | { type: 'unlearn'; lane: LearnLane };

export type TaskMessage = ProbeMessage & { type: TaskType };

// The probe workers (ADR 0016): at most three, each a probe host of its own. Which one a message goes to is fixed by
// what it is for (the probes, a task, a lane): the object kinds have the second worker, the sprites' lanes (their
// images, variants, bytes and the sprite memory check) the third, everything else the first; with fewer workers the
// last one has what the missing ones would (two: the kinds and the sprites' lanes on the second; one: everything).
// Jobs that share what a host keeps between them (probehost.ts LearnState: the levels' uses and the block prober with
// the saves at an event progress, the overworld's loads) are on the same worker; results reach the other's jobs
// through the editor.
export const PROBE_WORKERS = 3;
const WORKER_OF: Partial<Record<ProbeBusyKey, number>> = { kinds: 1, sprites: 2, variants: 2, bytes: 2, spritemem: 2 };
export function probeWorker(key: ProbeBusyKey, workers: number): number { return Math.max(0, Math.min(WORKER_OF[key] ?? 0, workers - 1)); }
// the workers to start on a machine with that many logical cores: one per two of them (the main thread and the browser
// need theirs), so two from four cores on, three from six
export function probeWorkersFor(cores: number): number { return Math.max(1, Math.min(PROBE_WORKERS, Math.floor(cores / 2) || 1)); }
// what a message is for (the ROM and its changes are for every worker)
export type RoutedMessage = Exclude<ProbeMessage, { type: 'rom' | 'edit' }>;
export function messageFor(m: RoutedMessage): ProbeBusyKey {
  switch (m.type) {
    case 'ask': case 'prefetch': return 'probe';
    case 'cancel': return m.task;
    case 'learn': case 'unlearn': return m.lane;
    default: return m.type;
  }
}
