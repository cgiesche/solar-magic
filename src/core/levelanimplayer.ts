// The level animation's player (CONTEXT.md: level animation, animation step; #556): which step of the open level's
// animation is shown over its picture. It builds a frame for each step – the pixels the step changes of the picture
// without the animation (the base) – a slice at a time, emulating the steps not yet made as it goes ("Animations
// i/n"), and then cycles them at the game's rhythm.
//
// What it keeps to:
// - A step is shown only once all are made. With the same steps as before (the picture composed anew, an edit the
//   steps carry over to) the step shown stays: its frame is built first and shown at once, the others after, without
//   a word in the busy indicator.
// - While a level edit is open no step is emulated or checked (a drag: each of its loads would emulate steps that
//   don't carry to the next one); the frames of steps there are still built, so steps carried over keep animating.
//   It goes on when the edit ended (resume).
// - Steps carried as a guess (PlayerSteps.checked false) are checked once their frames run, one a slice. The same
//   ones go on as they are. Other ones: the base is shown, and all starts anew from it with the steps emulated – the
//   frames are diffs against the base, and the picture shown was a frame of the steps guessed.
// - A start ends everything begun before it: a slice still waiting does nothing.
// - Nothing moves while the animation is switched off (it stops) or the scheduler is held.
//
// It knows no ROM, no emulator and no DOM: the steps come through PlayerSteps (core/levelanimsteps.ts), drawing a
// step, the scheduler, the clock and whether an edit is open through PlayerPorts. It stays on the main thread with
// the render (ADR 0010).

import { changedRects, mergeRects, ANIM_STEPS_PER_SECOND, type AnimStep, type PixelChanges, type PixelRect } from './render.ts';

// what the player needs of the steps (LevelAnimSteps)
export interface PlayerSteps {
  readonly count: number; // the steps wanted
  readonly steps: AnimStep[]; // those made so far
  readonly done: boolean; // all made (or no more to come)
  readonly checked: boolean; // false: carried as a guess, to be checked
  next(): unknown; // the next step emulated
  check(): boolean | null; // the next step of a guess checked: null more to check, true all the same, false other ones
}

export interface PlayerPorts<S extends PlayerSteps> {
  later(fn: () => void): void; // a slice of background work
  every(ms: number, fn: () => void): () => void; // a clock; what it returns stops it
  editing(): boolean; // a level edit is open
  held(): boolean; // the scheduler is held: no step shown now
  on(): boolean; // the animation is switched on
  // The pixels a step changes of the base. old and cells: the frame built for the step before the base was composed
  // anew in the cells marked, to be patched there.
  draw(step: AnimStep, base: Uint32Array, old: PixelChanges | null, cells: Uint8Array | null): PixelChanges;
  // the picture to show; changed: the rectangles that differ from the one shown before (null: all of it may)
  show(img: Uint32Array, changed: PixelRect[] | null): void;
  busy(text: string | null): void;
  emulated(steps: S): void; // a step was emulated or checked: what the steps read grew
}

export class LevelAnimPlayer<S extends PlayerSteps> {
  private p: PlayerPorts<S>;
  private gen = 0;
  private set: S | null = null;
  private baseImg: Uint32Array | null = null;
  private img: Uint32Array | null = null; // the picture shown when it isn't the base: the base with a frame
  private width = 0;
  private frames: PixelChanges[] = [];
  private rects: PixelRect[][] = []; // per frame the rectangles around its pixels
  private at = -1; // the step shown (-1: none yet)
  private ready = false; // the frames are those of the base
  private waiting: (() => void) | null = null; // the slice held while an edit is open
  private stopClock: (() => void) | null = null;

  constructor(ports: PlayerPorts<S>) { this.p = ports; }

  get steps(): S | null { return this.set; }
  // the picture without the animation the frames are built against
  get base(): Uint32Array | null { return this.baseImg; }
  get phase(): number { return this.at; }
  get playing(): boolean { return !!this.stopClock; }
  // the step shown now; null when none is (the picture as rendered)
  get step(): AnimStep | null {
    return this.stopClock && this.at >= 0 ? this.set?.steps[this.at] ?? null : null;
  }

  // The animation of `steps` (null: none) over `base`, `width` pixels wide. same: the steps are those before (the
  // picture composed anew, or the steps carried over to an edit's load) – the step shown stays. cells: the base was
  // composed anew only in the cells marked: the frames built before are patched there.
  start(steps: S | null, base: Uint32Array, width: number, same = false, cells: Uint8Array | null = null): void {
    const p = this.p, gen = ++this.gen;
    const before = cells ? this.frames : [];
    if (!same) this.at = -1;
    this.set = steps;
    this.waiting = null;
    this.frames = [];
    this.rects = [];
    this.ready = false;
    this.baseImg = base;
    this.img = null;
    this.width = width;
    if (!steps?.count) { this.at = -1; this.stop(); p.busy(null); return; }
    const made = steps.steps;
    const busy = () => p.busy(steps.done ? null : `Animations ${made.length + 1}/${steps.count}`);
    // (a step is shown only once all are made: at >= 0 means all are)
    const first = this.at >= 0 && made.length ? this.at % made.length : 0;
    if (this.at >= 0) this.at = made.length ? first : -1;
    let i = 0;
    const verify = () => {
      if (gen !== this.gen) return;
      if (p.editing()) { this.waiting = verify; return; }
      const ok = steps.check();
      p.emulated(steps);
      if (ok === null) p.later(verify);
      else if (!ok) {
        p.show(base, null);
        this.start(steps, base, width);
      }
    };
    const slice = () => {
      if (gen !== this.gen) return;
      if (i === made.length && !steps.done) {
        if (p.editing()) { this.waiting = slice; p.busy(null); return; }
        steps.next();
        p.emulated(steps);
      }
      if (i < made.length) {
        const n = (first + i) % made.length;
        const f = p.draw(made[n], base, before[n] ?? null, before[n] ? cells : null);
        this.frames[n] = f;
        this.rects[n] = changedRects(f.idx, width);
        if (n === this.at) {
          const img = base.slice();
          for (let j = 0; j < f.idx.length; j++) img[f.idx[j]] = f.val[j];
          this.img = img;
          p.show(img, null);
        }
        i++;
      }
      busy();
      if (i < made.length || !steps.done) { p.later(slice); return; }
      this.ready = true;
      if (!steps.checked) p.later(verify);
      if (!this.frames.length) { this.at = -1; this.stop(); return; }
      if (!this.stopClock) this.stopClock = p.every(1000 / ANIM_STEPS_PER_SECOND, () => this.tick());
    };
    busy();
    p.later(slice);
  }

  // a level edit ended: what waited for it goes on
  resume(): void {
    const w = this.waiting;
    this.waiting = null;
    if (w) this.p.later(w);
  }

  // The clock stopped: no step is shown any more (step null – what follows the animation goes back to the picture as
  // rendered), the picture stays as it is.
  stop(): void {
    if (!this.stopClock) return;
    this.stopClock();
    this.stopClock = null;
    if (this.baseImg) this.p.show(this.img ?? this.baseImg, null);
  }

  // the clock's tick: the next step shown
  tick(): void {
    const base = this.baseImg, p = this.p;
    if (!this.ready || !this.frames.length || !base) return;
    if (!p.on()) { this.stop(); return; }
    if (p.held()) return;
    const img = this.img ?? base.slice();
    const prev = this.frames[this.at], was = prev ? this.rects[this.at] : [];
    if (prev) for (const k of prev.idx) img[k] = base[k];
    this.at = (this.at + 1) % this.frames.length;
    const f = this.frames[this.at];
    for (let j = 0; j < f.idx.length; j++) img[f.idx[j]] = f.val[j];
    this.img = img;
    // (the picture is otherwise the one before: the base's, or the last step's)
    p.show(img, mergeRects(was, this.rects[this.at]));
  }
}
