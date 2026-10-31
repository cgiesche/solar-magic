// What the editor (probeclient.ts) and the probe host (probehost.ts, in the probe worker) say to each other:
// the probe jobs with their ids and result cache keys, the messages the editor sends and the replies.

import type { CacheEntry } from './romdeps.ts';
import { blockKey, collisionKey, spriteKey, runsKey, cameraKey } from './blockprobe.ts';
import type { KindLevel } from './objkinds.ts';
import type { ScanLevel, ScanResult } from './levelscan.ts';
import type { CameraAt } from './camerareach.ts';

// a probe in tileset ts: what a Map16 tile does, how Mario collides with it, what a sprite does, Mario's
// run speeds, the game view's scroll bands in a level of that mode and vertical scroll setting
export type ProbeJob =
  | { kind: 'block'; ts: number; tile: number }
  | { kind: 'collision'; ts: number; tile: number }
  | { kind: 'sprite'; ts: number; num: number }
  | { kind: 'runs'; ts: number }
  | { kind: 'camera'; ts: number; mode: number; vscroll: number };

// the job's id in a queue (one per job)
export function jobId(j: ProbeJob): string {
  switch (j.kind) {
    case 'block': return `${j.ts}:${j.tile}`;
    case 'collision': return `${j.ts}:c${j.tile}`;
    case 'sprite': return `${j.ts}:s${j.num}`;
    case 'runs': return `${j.ts}:r`;
    case 'camera': return `${j.ts}:m${j.mode}.${j.vscroll}`;
  }
}

// the result cache key of a job's result
export function jobKey(j: ProbeJob): string {
  switch (j.kind) {
    case 'block': return blockKey(j.ts, j.tile);
    case 'collision': return collisionKey(j.ts, j.tile);
    case 'sprite': return spriteKey(j.ts, j.num);
    case 'runs': return runsKey(j.ts);
    case 'camera': return cameraKey(j.ts, j.mode, j.vscroll);
  }
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
// a level scan (id: the editor's request; result null: it failed), with its result cache entry
export interface ScanDone { type: 'scan'; gen: number; id: number; result: ScanResult | null; put: [string, CacheEntry][] }
// the camera at Mario standing at a place (id: the editor's request; result null: it failed), with its result cache entry
export interface CameraDone { type: 'camera'; gen: number; id: number; result: CameraAt | null; put: [string, CacheEntry][] }
export type ProbeReply = ProbeDone | KindsDone | ScanDone | CameraDone;

// the longer tasks; those the editor can say it doesn't want any more
export type TaskType = 'kinds' | 'scan' | 'camera';
export type CancelableTask = 'scan';

// what the editor sends: the ROM (the whole of it, or the bytes a change wrote at their offsets and the new
// size), jobs asked for, the prefetch queue, the longer tasks (a new one replaces the running one of its
// type, unless it asks for the same result) and that the task of a type is not wanted any more
export type ProbeMessage =
  | { type: 'rom'; gen: number; data: Uint8Array }
  | { type: 'edit'; gen: number; size: number; edits: [number, Uint8Array][] }
  | { type: 'ask'; jobs: ProbeJob[] }
  | { type: 'prefetch'; jobs: ProbeJob[] }
  | { type: 'kinds'; ts: number; level: KindLevel; layer2Pointer: number }
  | { type: 'scan'; id: number; key: string; level: ScanLevel }
  | { type: 'camera'; id: number; key: string; level: ScanLevel; x: number; y: number }
  | { type: 'cancel'; task: CancelableTask };

export type TaskMessage = ProbeMessage & { type: TaskType };
