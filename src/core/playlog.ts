// What test play measures, frame by frame: the live slots of the sprite tables and the CPU's load for the last
// frames (the meter's graphs), and the moments to look at – a sprite that failed to spawn, a lag frame – with
// where Mario was then, and Mario's deaths. Failures of a kind close together (a generator trying every frame), and lag frames
// close together (a heavy spot), are one event.

import { LINES_PER_FRAME } from './snes.ts';
import { GM, marioTile } from './ram.ts';
import { SLOT_KINDS, type SlotKind, type SlotFailure } from './slotwatch.ts';
import type { Death } from './deaths.ts';

export type SlotCounts = Record<SlotKind, number>;
// busy: the CPU's load (see cpuLoad)
export interface FrameSample { frame: number; used: SlotCounts; failed: SlotFailure[]; busy: number }
// a moment: its first frame, Mario's tile then (his feet stand in it) and the level he was in (when known), count:
// frames (or failures) in it, its last frame
export interface Moment { frame: number; count: number; tx: number; ty: number; level?: number; last: number }
export interface PlayEvent extends SlotFailure, Moment {}
export type LagEvent = Moment;
export interface DeathEvent extends Death { frame: number }

export const LAG = -1;
const MERGE = 64; // frames after a failure in which another of its kind belongs to the same event (a generator tries every 32)
const LAG_MERGE = 30; // frames after a lag frame in which another belongs to the same event
const MAX_EVENTS = 200;

// The CPU's load in the frame that just ran, from busy: scanlines from the NMI until the game waited for the next
// one (Snes.busyLines, -1: it never waited). LAG: the level's frame wasn't done before the next NMI (a lag frame,
// the game slows down); the frames the game spends elsewhere (loading, fading) count as fully busy but are no
// lag of the level. The load is measured up to the frame's NMI, the game mode read after the frame: it is the
// level's frame when the game was in the level's mode before it (modeBefore) and after it (modeAfter), so the last
// loading frame, whose game mode turns to the level's after the NMI, is none.
export function cpuLoad(busy: number, modeBefore: number, modeAfter: number): number {
  if (busy >= 0) return busy;
  return modeBefore === GM.level && modeAfter === GM.level ? LAG : LINES_PER_FRAME;
}

// the log after a frame, to go back to (PlayLog.rewindTo): the events, lag events and deaths pushed so far, the
// open events with their count and last frame then (only open events change)
interface LogMark {
  frame: number;
  pushed: { events: number; lags: number; deaths: number };
  lagFrames: number;
  open: [SlotKind, PlayEvent, number, number][];
  openLag: [LagEvent, number, number] | null;
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
  private pushed = { events: 0, lags: 0, deaths: 0 };
  private marks: LogMark[] = [];
  private keep: number;
  // size: the frames sampled; keep: the latest frames the log can go back to (rewindTo)
  constructor(size: number, keep = 0) { this.size = size; this.keep = keep; }

  // the frames go on from elsewhere (a savestate loaded): a failure or lag frame from now on is an event of its
  // own, the log can't go back before it
  cut(): void { this.open.clear(); this.openLag = null; this.marks = []; }

  // back to the end of a frame kept (the game rewound to it): what was logged after it dropped, the open events as
  // then; the deaths dropped (null: the frame isn't kept, nothing done)
  rewindTo(frame: number): DeathEvent[] | null {
    const i = this.marks.findIndex((m) => m.frame === frame);
    if (i < 0) return null;
    const m = this.marks[i];
    this.marks.length = i + 1;
    this.history = this.history.filter((h) => h.frame <= frame);
    const back = <T>(list: T[], n: number) => list.splice(Math.max(0, list.length - n));
    back(this.events, this.pushed.events - m.pushed.events);
    back(this.lags, this.pushed.lags - m.pushed.lags);
    const gone = back(this.deaths, this.pushed.deaths - m.pushed.deaths);
    this.pushed = { ...m.pushed };
    this.lagFrames = m.lagFrames;
    this.open = new Map(m.open.map(([kind, e, count, last]) => { e.count = count; e.last = last; return [kind, e]; }));
    this.openLag = m.openLag && Object.assign(m.openLag[0], { count: m.openLag[1], last: m.openLag[2] });
    return gone;
  }

  private mark(frame: number): void {
    if (!this.keep) return;
    this.marks.push({
      frame, pushed: { ...this.pushed }, lagFrames: this.lagFrames,
      open: [...this.open].map(([kind, e]) => [kind, e, e.count, e.last]),
      openLag: this.openLag && [this.openLag, this.openLag.count, this.openLag.last],
    });
    if (this.marks.length > this.keep) this.marks.splice(0, this.marks.length - this.keep);
  }

  // one emulated frame: the live slots at its end, the searches that failed in it, the CPU's load (cpuLoad),
  // Mario's position (pixels), the level being played (when known; moments in another level are others)
  frame(frame: number, used: SlotCounts, failed: SlotFailure[], busy: number, marioX: number, marioY: number, level?: number): void {
    this.history.push({ frame, used: { ...used }, failed, busy });
    if (this.history.length > this.size) this.history.splice(0, this.history.length - this.size);
    const at = (count: number): Moment => ({ frame, count, ...marioTile(marioX, marioY), ...(level === undefined ? {} : { level }), last: frame });
    const near = (e: Moment | null | undefined, within: number): e is Moment => !!e && frame - e.last <= within && frame >= e.last && e.level === level;
    for (const kind of SLOT_KINDS) {
      const mine = failed.filter((f) => f.kind === kind), n = mine.length;
      if (!n) continue;
      const e = this.open.get(kind);
      if (near(e, MERGE)) { e.count += n; e.last = frame; continue; }
      const ev = { ...mine[0], ...at(n) };
      this.open.set(kind, ev);
      this.pushed.events++;
      const old = push(this.events, ev);
      if (old && this.open.get(old.kind) === old) this.open.delete(old.kind);
    }
    if (busy === LAG) {
      this.lagFrames++;
      if (near(this.openLag, LAG_MERGE)) { this.openLag.count++; this.openLag.last = frame; }
      else {
        this.openLag = at(1);
        push(this.lags, this.openLag);
        this.pushed.lags++;
      }
    }
    this.mark(frame);
  }

  // Mario died in the frame (after frame() of it); the event logged
  died(frame: number, d: Death): DeathEvent {
    const e = { ...d, frame };
    push(this.deaths, e);
    this.pushed.deaths++;
    const m = this.marks[this.marks.length - 1];
    if (m?.frame === frame) m.pushed.deaths++;
    return e;
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
