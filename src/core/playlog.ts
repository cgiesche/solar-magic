// What test play measures, frame by frame: the live slots of the sprite tables and the CPU's load for the last
// frames (the meter's graphs), and the moments to look at – a sprite that failed to spawn, a lag frame – with
// where Mario was then, and Mario's deaths. Failures of a kind close together (a generator trying every frame), and lag frames
// close together (a heavy spot), are one event.

import { LINES_PER_FRAME, type Snes } from './snes.ts';
import { GM, RAM, marioTile } from './ram.ts';
import { SLOT_KINDS, type SlotKind, type SlotFailure } from './slotwatch.ts';
import type { Death } from './deaths.ts';

export type SlotCounts = Record<SlotKind, number>;
// busy: the CPU's load (see cpuLoad)
export interface FrameSample { frame: number; used: SlotCounts; failed: SlotFailure[]; busy: number }
// a moment: its first frame, Mario's tile then (his feet stand in it), count: frames (or failures) in it, its last frame
export interface Moment { frame: number; count: number; tx: number; ty: number; last: number }
export interface PlayEvent extends SlotFailure, Moment {}
export type LagEvent = Moment;
export interface DeathEvent extends Death { frame: number }

export const LAG = -1;
const MERGE = 64; // frames after a failure in which another of its kind belongs to the same event (a generator tries every 32)
const LAG_MERGE = 30; // frames after a lag frame in which another belongs to the same event
const MAX_EVENTS = 200;

// The CPU's load in the frame that just ran: scanlines from the NMI until the game waited for the next one
// (Snes.busyLines). LAG: the level's frame wasn't done before the next NMI (a lag frame, the game slows
// down); the frames the game spends elsewhere (loading, fading) count as fully busy but are no lag of the
// level. The load is measured up to the frame's NMI, the game mode read after the frame: it is the level's
// frame when the game was in the level's mode before it (modeBefore) and after it, so the last loading
// frame, whose game mode turns to the level's after the NMI, is none.
export function cpuLoad(s: Snes, modeBefore: number): number {
  if (s.busyLines >= 0) return s.busyLines;
  return modeBefore === GM.level && s.wram[RAM.gameMode] === GM.level ? LAG : LINES_PER_FRAME;
}

export class PlayLog {
  history: FrameSample[] = [];
  events: PlayEvent[] = [];
  lags: LagEvent[] = [];
  deaths: DeathEvent[] = [];
  lagFrames = 0;
  private open = new Map<SlotKind, PlayEvent>();
  private openLag: LagEvent | null = null;
  private size: number;
  constructor(size: number) { this.size = size; }

  // the frames go on from elsewhere (a savestate loaded): a failure or lag frame from now on is an event of its own
  cut(): void { this.open.clear(); this.openLag = null; }

  // one emulated frame: the live slots at its end, the searches that failed in it, the CPU's load (cpuLoad),
  // Mario's position (pixels)
  frame(frame: number, used: SlotCounts, failed: SlotFailure[], busy: number, marioX: number, marioY: number): void {
    this.history.push({ frame, used: { ...used }, failed, busy });
    if (this.history.length > this.size) this.history.splice(0, this.history.length - this.size);
    const at = (count: number): Moment => ({ frame, count, ...marioTile(marioX, marioY), last: frame });
    const near = (e: Moment | null | undefined, within: number): e is Moment => !!e && frame - e.last <= within && frame >= e.last;
    for (const kind of SLOT_KINDS) {
      const mine = failed.filter((f) => f.kind === kind), n = mine.length;
      if (!n) continue;
      const e = this.open.get(kind);
      if (near(e, MERGE)) { e.count += n; e.last = frame; continue; }
      const ev = { ...mine[0], ...at(n) };
      this.open.set(kind, ev);
      const old = push(this.events, ev);
      if (old && this.open.get(old.kind) === old) this.open.delete(old.kind);
    }
    if (busy !== LAG) return;
    this.lagFrames++;
    if (near(this.openLag, LAG_MERGE)) { this.openLag.count++; this.openLag.last = frame; return; }
    this.openLag = at(1);
    push(this.lags, this.openLag);
  }

  // Mario died in the frame
  died(frame: number, d: Death): void {
    push(this.deaths, { ...d, frame });
  }

  // the lag event with the most lag frames (the first of equals)
  worstLag(): LagEvent | null {
    return this.lags.reduce<LagEvent | null>((w, e) => (!w || e.count > w.count ? e : w), null);
  }
}

// adds an event; the oldest, dropped beyond MAX_EVENTS
function push<T>(list: T[], e: T): T | undefined {
  list.push(e);
  return list.length > MAX_EVENTS ? list.shift() : undefined;
}
