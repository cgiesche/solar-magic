// What the editor (probeclient.ts) and the probe host (probehost.ts, in the probe worker) say to each other:
// the probe jobs with their ids and result cache keys, the messages the editor sends and the replies.

import type { CacheEntry } from './romdeps.ts';
import { blockKey, collisionKey, spriteKey, runsKey, cameraKey } from './blockprobe.ts';
import type { KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';
import type { CameraAt } from './camerareach.ts';
import type { SpriteLevel } from './spritegfx.ts';
import type { SpriteMemLevel } from './spritemem.ts';
import type { LevelOverride } from './levelemu.ts';
import type { Level } from './level.ts';
import type { Keep } from './jobrunner.ts';
import type { ObjSpec } from './objthumbs.ts';
import type { RunStates } from './blockprobe.ts';
import type { SizeSpec } from './objresize.ts';

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
    case 'sprite': return spriteKey(j.ts, j.num);
    case 'runs': return runsKey(j.ts);
    case 'bands': return cameraKey(j.ts, j.mode, j.vscroll);
  }
}
// the job's id in a queue: its result cache key (one per job)
export const jobId = jobKey;

export interface ProbeDone {
  type: 'probe';
  gen: number; // ROM generation the job ran on (see ProbeHost.setRom)
  job: ProbeJob;
  put: [string, CacheEntry][]; // new result cache entries
  failed: boolean;
}

// the object kinds of tileset ts, with their result cache entry (none: the probe failed)
export interface KindsDone { type: 'kinds'; gen: number; ts: number; failed: boolean; put: [string, CacheEntry][] }
// a level scan (id: the editor's request; result null: it failed), with its result cache entry
export interface ScanDone { type: 'scan'; gen: number; id: number; result: ScanResult | null; put: [string, CacheEntry][] }
// the camera at Mario standing at a place (id: the editor's request; result null: it failed), with its result cache entry
export interface CameraDone { type: 'camera'; gen: number; id: number; result: CameraAt | null; put: [string, CacheEntry][] }
export type ProbeReply = ProbeDone | KindsDone | ScanDone | CameraDone | Learned | Learning;

// A result learner job (CONTEXT.md) run here: the images of all sprites of a sprite set, the image of a sprite at a
// tile (its variant by position), the image of a custom sprite with extra bytes, the tiles of the levels not known yet
// (their uses, levelusage.ts), a level's sprite memory check, the tiles and colors animating in a level, what the four
// layer 3 settings do in a level as given (layer3.ts), the tiles of a level as edited (levelusage.ts levelTilesAll),
// the object picker's thumbnails (objthumbs.ts; keys: each object's key, objKey), the placement preview (objthumbs.ts
// placementPreviewJob), the jump arcs from a tile (jumparcs.ts; level: the hash of the level as loaded, load: what it
// is loaded with), what the layer 2 scroll settings do in a level (l2scroll.ts), what Mario does on each overworld
// layer 1 tile (owpaths.ts), the prefab suggestions (prefabsuggest.ts; open: the open level as edited) and the boxes
// of objects at sizes (objresize.ts; layer2Pointer: the level's layer 2 objects as the probe loads take them); the
// overworld's map at an event progress (overworld.ts overworldMapJob), the submaps' views (owevents.ts submapViews),
// the overworld sprites' images at a map and event progress (owsprites.ts owSpriteImages) and the save at an event
// progress (owprogress.ts progressSaves), layer 1 as after an event without its layer 1 changes (owevents.ts
// layer1Without)
export type LearnJob =
  | { kind: 'sprites'; level: SpriteLevel; nums: number[]; input?: string } // (input: of each test level load, spriteSetJob)
  | { kind: 'spriteAt'; level: SpriteLevel; id: number; x: number; y: number }
  | { kind: 'spriteBytes'; level: SpriteLevel; id: number; bytes: number[] }
  | { kind: 'uses'; levels: number[] }
  | { kind: 'spriteMem'; level: SpriteMemLevel }
  | { kind: 'animated'; level: number; ov: LevelOverride }
  | { kind: 'layer3'; level: number; ov: LevelOverride }
  | { kind: 'levelTiles'; level: Level; ov: LevelOverride }
  | { kind: 'thumbs'; level: Level; specs: ObjSpec[]; keys: string[] }
  | { kind: 'preview'; level: Level; ov: LevelOverride; layer2: boolean; placed: number[] }
  | { kind: 'arcs'; level: string; load: [number, LevelOverride, number, number]; tx: number; ty: number; runs: RunStates }
  | { kind: 'layer2Motions'; level: number; ov: LevelOverride }
  | { kind: 'pathKinds' }
  | { kind: 'suggest'; levels: number[]; open?: Level }
  | { kind: 'sizes'; level: KindLevel; layer2Pointer: number; specs: SizeSpec[] }
  | { kind: 'owMap'; map: number; progress: number }
  | { kind: 'owViews' }
  | { kind: 'owSprites'; map: number; progress: number }
  | { kind: 'owCustom'; map: number; progress: number }
  | { kind: 'owLooks'; ids: number[] }
  | { kind: 'owSave'; progress: number }
  | { kind: 'owL1Without'; event: number };

// Per kind of learn job where its result goes (keep, jobrunner.ts Keep) and whether it is a picture (CONTEXT.md, ADR
// 0008): the levels' uses go to the entries of each level (the job keeps none); the prefab suggestions and the object
// boxes to the editor only (it keeps them as a run's and per ROM state); the animated tiles and colors, the tiles of
// the level as edited, the placement preview and the jump arcs change with every edit (memory only); the others to the
// result cache. The overworld's jobs run on the overworld's own emulator (layer 1 without an event's changes on a ROM
// copy's), not on one booted for levels: its boot doesn't count for them (boot false, jobrunner.ts JobSpec); it has no
// skip mask, so they count the display data, the submaps' views, the save at a progress and layer 1 without an event's
// changes (no pictures) too: marked pictures (ADR 0008). They change with the map painted, the event progress slider
// goes through many (memory only)
export const LEARN_KINDS: { [K in LearnJob['kind']]: { keep: Keep; picture: boolean; boot?: false } } = {
  sprites: { keep: true, picture: true },
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
  suggest: { keep: false, picture: false },
  sizes: { keep: false, picture: false },
  owMap: { keep: 'memory', picture: true, boot: false },
  owViews: { keep: 'memory', picture: true, boot: false },
  owSprites: { keep: 'memory', picture: true, boot: false },
  owCustom: { keep: 'memory', picture: true, boot: false },
  owLooks: { keep: 'memory', picture: true, boot: false },
  owSave: { keep: 'memory', picture: true, boot: false },
  owL1Without: { keep: 'memory', picture: true, boot: false },
};
export const learnKeep = (j: LearnJob): Keep => LEARN_KINDS[j.kind].keep;

// a learn job asked for: its result under key and input (the hash of what it depends on outside the ROM, inputs.ts),
// learned in a lane (one job at a time, in the order asked); replace drops the lane's other jobs; parts: the editor's
// stored entries of the result's parts (jobrunner.ts Part, by stored key; checked when first used)
export interface LearnMessage { type: 'learn'; lane: string; key: string; input?: string; job: LearnJob; replace: boolean; parts?: [string, CacheEntry][] }

// a learn job's result (failed: it threw, result null), with its result cache entry (memory: the entry of one kept in
// memory only, learnKeep)
export interface Learned {
  type: 'learned'; gen: number; lane: string; key: string; input?: string; result: unknown; failed: boolean; put: [string, CacheEntry][]; memory?: CacheEntry;
}
// a step of a learn job that didn't finish it: its progress label, what it shows meanwhile (the job's items since the
// last reply; fresh: it started (over) since then, what it showed before goes) and the entries set meanwhile
export interface Learning {
  type: 'learning'; gen: number; lane: string; key: string; input?: string; label: string | null; fresh: boolean; shown: unknown[]; put: [string, CacheEntry][];
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
  | { type: 'kinds'; ts: number; level: KindLevel; layer2Pointer: number }
  | { type: 'scan'; id: number; key: string; level: ScanLevel }
  | { type: 'camera'; id: number; key: string; level: ScanLevel; x: number; y: number }
  | { type: 'cancel'; task: CancelableTask }
  | LearnMessage
  | { type: 'unlearn'; lane: string };

export type TaskMessage = ProbeMessage & { type: TaskType };
