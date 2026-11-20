// The level animation's player (core/levelanimplayer.ts, #556, #441): which step is shown over the level's picture.
// Fed with steps that are numbers in a tiny picture, a scheduler and a clock turned by hand: a step shown only once
// all are made, "Animations i/n" while steps are emulated; the step shown kept over a picture composed anew and an
// edit the steps carry over to, its frame built first and shown at once, no word in the busy indicator (#440); no
// step emulated or checked while a level edit is open, steps there animating on (#452); steps carried as a guess
// checked a slice at a time and going on when they are the same (#519), else all anew from the picture without the
// animation (5efdb69); a start ending what was begun before; the frames patched in the cells composed anew;
// switched off and held.
// node tools/testlevelanimplayer.ts
import { LevelAnimPlayer, type PlayerSteps, type PlayerPorts } from '../src/core/levelanimplayer.ts';
import type { AnimStep, PixelChanges } from '../src/core/render.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// A step is a color: it paints pixel 1 of the picture with it (and pixel 2 when the color is even).
const stepOf = (c: number): AnimStep => ({ vram: Uint8Array.of(c), cgram: new Uint8Array(0) });
const colorOf = (s: AnimStep) => s.vram[0];

class Steps implements PlayerSteps {
  count: number;
  steps: AnimStep[] = [];
  todo: number[]; // the colors of the steps still to emulate
  guess: number[] | null = null; // carried as a guess: the colors the steps really have
  private checkedTo = 0;
  emulations = 0;
  constructor(made: number[], todo: number[] = []) {
    this.steps = made.map(stepOf);
    this.todo = todo;
    this.count = made.length + todo.length;
  }
  get done(): boolean { return !!this.guess || !this.todo.length; }
  get checked(): boolean { return !this.guess; }
  next(): void {
    if (this.done) return;
    this.emulations++;
    this.steps.push(stepOf(this.todo.shift()!));
  }
  check(): boolean | null {
    const g = this.guess;
    if (!g) return true;
    this.emulations++;
    const at = this.checkedTo++;
    if (colorOf(this.steps[at]) === g[at]) {
      if (this.checkedTo < g.length) return null;
      this.guess = null;
      return true;
    }
    // other ones: those emulated so far, the others to be made
    this.steps.length = 0;
    this.steps.push(...g.slice(0, at + 1).map(stepOf));
    this.todo = g.slice(at + 1);
    this.guess = null;
    return false;
  }
}

function setup() {
  const w = {
    queue: [] as (() => void)[], clock: null as (() => void) | null, clocks: 0,
    editing: false, held: false, on: true,
    shown: [] as { img: number[]; changed: number | null }[], busy: [] as (string | null)[], emulated: 0,
    draws: [] as { color: number; old: boolean; cells: boolean }[],
    // the scheduler's slices run until none waits
    run(max = 100): void { for (let i = 0; i < max && this.queue.length; i++) this.queue.shift()!(); },
    slice(): void { this.queue.shift()?.(); },
    last(): number[] | null { return this.shown.length ? this.shown[this.shown.length - 1].img : null; },
  };
  const ports: PlayerPorts<Steps> = {
    later: (fn) => { w.queue.push(fn); },
    every: (_ms, fn) => { w.clock = fn; w.clocks++; return () => { w.clock = null; }; },
    editing: () => w.editing,
    held: () => w.held,
    on: () => w.on,
    draw: (step, base, old, cells) => {
      const c = colorOf(step);
      w.draws.push({ color: c, old: !!old, cells: !!cells });
      const idx = c % 2 ? [1] : [1, 2];
      return { idx: Uint32Array.from(idx), val: Uint32Array.from(idx.map(() => c)) } as PixelChanges;
    },
    show: (img, changed) => { w.shown.push({ img: [...img], changed: changed ? changed.length : null }); },
    busy: (t) => { w.busy.push(t); },
    emulated: () => { w.emulated++; },
  };
  return { w, player: new LevelAnimPlayer<Steps>(ports) };
}
const BASE = () => Uint32Array.of(9, 9, 9, 9);
const eq = (a: number[] | null, b: number[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
const tick = (w: ReturnType<typeof setup>['w']) => w.clock?.();

// ---------- steps emulated, then cycled ----------
{
  const { w, player } = setup();
  const s = new Steps([], [1, 2, 3]);
  player.start(s, BASE(), 4);
  check(w.busy[0] === 'Animations 1/3' && !player.playing, 'started: "Animations 1/3", nothing plays yet');
  w.slice(); w.slice();
  check(s.emulations === 2 && w.shown.length === 0 && player.step === null, 'a step is not shown before all are made');
  check(w.busy[w.busy.length - 1] === 'Animations 3/3', 'the busy indicator counts the steps emulated');
  w.run();
  check(s.emulations === 3 && w.emulated === 3 && w.busy[w.busy.length - 1] === null && player.playing, 'all made: the indicator ends, the clock runs');
  check(w.shown.length === 0 && player.phase === -1, 'the first step comes with the clock\'s tick');
  tick(w);
  check(eq(w.last(), [9, 1, 9, 9]) && player.phase === 0 && colorOf(player.step!) === 1, 'tick: step 0 over the base');
  tick(w);
  check(eq(w.last(), [9, 2, 2, 9]) && w.shown[1].changed !== null, 'tick: step 1, with the rectangles that changed');
  tick(w);
  check(eq(w.last(), [9, 3, 9, 9]), 'tick: the step before taken back to the base where the next doesn\'t paint');
  tick(w);
  check(eq(w.last(), [9, 1, 9, 9]) && player.phase === 0, 'the steps come round');
}

// ---------- no steps ----------
{
  const { w, player } = setup();
  player.start(new Steps([], [1]), BASE(), 4);
  w.run(); tick(w);
  const n = w.shown.length;
  player.start(null, BASE(), 4);
  check(!player.playing && player.step === null && w.shown.length === n + 1 && eq(w.last(), [9, 9, 9, 9]) && w.busy[w.busy.length - 1] === null,
    'a level without animation: the clock stops, the picture is the base, no step');
  w.run(); tick(w);
  check(w.shown.length === n + 1, 'and nothing comes after');
}

// ---------- the step shown kept (#440) ----------
{
  const { w, player } = setup();
  const s = new Steps([], [1, 2, 3]);
  player.start(s, BASE(), 4);
  w.run(); tick(w); tick(w);
  w.shown.length = 0; w.busy.length = 0; w.draws.length = 0;
  // the picture composed anew (a picker's mark, the edit mode): the same steps
  const base = Uint32Array.of(7, 7, 7, 7);
  player.start(s, base, 4, true);
  check(player.phase === 1 && colorOf(player.step!) === 2, 'the picture composed anew: the step shown stays');
  w.slice();
  check(w.draws[0].color === 2 && eq(w.last(), [7, 2, 2, 7]) && w.shown[0].changed === null, 'its frame is built first and shown at once');
  w.run();
  check(w.draws.map((d) => d.color).join() === '2,3,1' && w.shown.length === 1, 'the others after it, none of them shown');
  check(w.busy.every((b) => b === null) && s.emulations === 3 && w.clocks === 1, 'no word in the busy indicator, nothing emulated, the clock ran on');
  tick(w);
  check(eq(w.last(), [7, 3, 7, 7]) && player.phase === 2, 'the next tick goes on from the step shown');
  // other steps (another level): from the start
  player.start(new Steps([], [5]), BASE(), 4);
  check(player.phase === -1 && player.step === null, 'other steps: no step shown until they are made');
}

// ---------- the frames patched after an edit ----------
{
  const { w, player } = setup();
  const s = new Steps([], [1, 2]);
  player.start(s, BASE(), 4);
  w.run(); tick(w);
  w.draws.length = 0;
  const cells = Uint8Array.of(1);
  player.start(s, BASE(), 4, true, cells);
  w.run();
  check(w.draws.length === 2 && w.draws.every((d) => d.old && d.cells), 'an edit the steps carry over to: each frame built before is patched in the cells composed anew');
  w.draws.length = 0;
  player.start(s, BASE(), 4, true);
  w.run();
  check(w.draws.every((d) => !d.old && !d.cells), 'the picture composed anew as a whole: the frames built anew');
}

// ---------- a level edit open (#452) ----------
{
  const { w, player } = setup();
  const s = new Steps([], [1, 2, 3]);
  player.start(s, BASE(), 4);
  w.slice();
  w.editing = true;
  w.run();
  check(s.emulations === 1 && w.queue.length === 0 && w.busy[w.busy.length - 1] === null, 'an edit open: no step emulated, the indicator off');
  player.resume();
  w.run();
  check(s.emulations === 1, 'resumed with the edit still open: held again');
  w.editing = false;
  player.resume();
  w.run();
  check(s.emulations === 3 && player.playing, 'the edit ended: the steps are made on');
  // steps carried over keep animating while dragging
  tick(w);
  w.editing = true;
  w.shown.length = 0;
  player.start(s, BASE(), 4, true);
  w.run(); tick(w);
  check(w.shown.length === 2 && player.phase === 1 && s.emulations === 3, 'steps all made animate on while an edit is open');
  player.resume();
  check(w.queue.length === 0, 'nothing waited: resume does nothing');
}

// ---------- steps carried as a guess (#519, 5efdb69) ----------
{
  const { w, player } = setup();
  const s = new Steps([1, 2, 3]);
  player.start(s, BASE(), 4);
  w.run(); tick(w); tick(w);
  // an object added: the same steps, as a guess that holds
  const g = new Steps([1, 2, 3]);
  g.guess = [1, 2, 3];
  w.shown.length = 0; w.busy.length = 0;
  player.start(g, BASE(), 4, true);
  w.slice(); w.slice(); w.slice();
  check(g.emulations === 0 && player.playing, 'a guess: its frames run before it is checked');
  w.slice();
  check(g.emulations === 1 && w.queue.length === 1, 'checked a step a slice');
  w.editing = true;
  w.run();
  check(g.emulations === 1 && w.queue.length === 0, 'not checked while an edit is open');
  w.editing = false;
  player.resume();
  w.run();
  check(g.emulations === 3 && g.checked && w.emulated === 3, 'checked through once the edit ended; what it read told');
  check(player.phase === 1 && w.shown.length === 1 && w.busy.every((b) => b === null), 'the same steps: the animation goes on as it was, no word in the indicator');
  tick(w);
  check(eq(w.last(), [9, 3, 9, 9]), 'and on with the next step');
}
{
  const { w, player } = setup();
  const s = new Steps([1, 2, 3]);
  player.start(s, BASE(), 4);
  w.run(); tick(w); tick(w);
  // another level opened: the steps before as a guess that doesn't hold (the second differs)
  const g = new Steps([1, 2, 3]);
  g.guess = [1, 5, 7];
  w.shown.length = 0; w.busy.length = 0; w.draws.length = 0;
  player.start(g, BASE(), 4, true);
  w.slice(); w.slice(); w.slice();
  check(eq(w.last(), [9, 2, 2, 9]), 'a guess: the step shown is the guessed one\'s frame');
  w.slice(); w.slice();
  check(eq(w.last(), [9, 9, 9, 9]) && w.shown[w.shown.length - 1].changed === null && player.phase === -1, 'the guess was wrong: the base is shown, no step');
  check(w.busy[w.busy.length - 1] === 'Animations 3/3', 'and the steps are made on, said in the indicator');
  w.draws.length = 0;
  w.run();
  check(w.draws.map((d) => d.color).join() === '1,5,7' && w.draws.every((d) => !d.old), 'all frames built anew against the base, from the steps emulated');
  tick(w); tick(w);
  check(eq(w.last(), [9, 5, 9, 9]) && w.clocks === 1, 'the steps emulated play');
}

// ---------- a start ends what was begun ----------
{
  const { w, player } = setup();
  const a = new Steps([], [1, 2, 3]), b = new Steps([], [5]);
  player.start(a, BASE(), 4);
  w.slice();
  player.start(b, BASE(), 4);
  w.run();
  check(a.emulations === 1 && b.emulations === 1, 'a slice of the start before does nothing');
  tick(w);
  check(eq(w.last(), [9, 5, 9, 9]), 'the steps started last play');
  // an edit's held slice of the start before is dropped too
  const c = new Steps([], [1, 2]);
  w.editing = true;
  player.start(c, BASE(), 4);
  w.run();
  player.start(b, BASE(), 4, true);
  w.editing = false;
  player.resume();
  w.run();
  check(c.emulations === 0, 'what an edit held of the start before is not resumed');
}

// ---------- switched off, held ----------
{
  const { w, player } = setup();
  player.start(new Steps([], [1, 2]), BASE(), 4);
  w.run(); tick(w);
  w.held = true;
  tick(w);
  check(player.phase === 0 && w.shown.length === 1, 'the scheduler held: the step stays');
  w.held = false;
  w.on = false;
  tick(w);
  check(!player.playing && player.step === null && w.shown.length === 2 && w.shown[1].changed === null && eq(w.last(), [9, 1, 9, 9]),
    'switched off: the clock stops, no step, the picture told as changed and left as it is');
  player.stop();
  check(w.shown.length === 2, 'stopped once');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
