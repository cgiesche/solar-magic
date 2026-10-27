// What test play measures, frame by frame: the live slots of the sprite tables for the last frames (the
// meter's graph), and the moments to look at – a sprite that failed to spawn – with where Mario was then.
// Failures of a kind close together (a generator trying every frame) are one event.

import { SLOT_KINDS, type SlotKind, type SlotFailure } from './slotwatch.ts';

export type SlotCounts = Record<SlotKind, number>;
export interface FrameSample { frame: number; used: SlotCounts; failed: SlotFailure[] }
// a failed spawn: the first failure's frame, search and Mario's tile (his feet stand in it); count: failures in it
export interface PlayEvent extends SlotFailure { frame: number; count: number; tx: number; ty: number; last: number }

const MERGE = 64; // frames after a failure in which another of its kind belongs to the same event (a generator tries every 32)
const MAX_EVENTS = 200;

export class PlayLog {
  history: FrameSample[] = [];
  events: PlayEvent[] = [];
  private open = new Map<SlotKind, PlayEvent>();
  private size: number;
  constructor(size: number) { this.size = size; }

  // one emulated frame: the live slots at its end, the searches that failed in it, Mario's position (pixels)
  frame(frame: number, used: SlotCounts, failed: SlotFailure[], marioX: number, marioY: number): void {
    this.history.push({ frame, used: { ...used }, failed });
    if (this.history.length > this.size) this.history.splice(0, this.history.length - this.size);
    for (const kind of SLOT_KINDS) {
      const mine = failed.filter((f) => f.kind === kind), n = mine.length;
      if (!n) continue;
      const e = this.open.get(kind);
      if (e && frame - e.last <= MERGE && frame >= e.last) { e.count += n; e.last = frame; continue; }
      const ev = { ...mine[0], frame, count: n, tx: (marioX + 8) >> 4, ty: (marioY + 16) >> 4, last: frame };
      this.events.push(ev);
      this.open.set(kind, ev);
      if (this.events.length > MAX_EVENTS) this.events.shift();
    }
  }
}
