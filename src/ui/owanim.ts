// The overworld map's animation (#420, core/owanimsteps.ts) played in the overworld view: the steps of the submap at
// the event progress shown learned in the probe worker (App.owAnimSteps; the busy indicator says "Animations n/m"
// meanwhile, the map still), then shown one after the other in the game's rhythm as the level's (7.5 steps a second,
// App.animTick), while View → "Animation" is on (App.setAnimation) and the view is in the page. Learned anew when the
// submap, the event progress or the ROM changes; a ROM edit keeps showing the steps it had until the new ones come
// (painting changes no 8x8 tile or color: no pause while painting). The view's map and its pickers (pickeranim.ts)
// follow it: an AnimSource.

import type { App } from './app.ts';
import { sameProgress, type EventProgress } from '../core/eventset.ts';
import type { AnimSource } from './pickeranim.ts';
import { ANIM_STEPS_PER_SECOND, type AnimStep, type PictureAnimation } from '../core/render.ts';
import type { RomRead } from '../core/exanim.ts';
import type { OwRender } from '../core/overworld.ts';
import { OwTileAnimation } from '../core/owanimsteps.ts';

const STILL: PictureAnimation = { redraw: () => false };

export class OwAnimPlayer implements AnimSource {
  private app: App;
  private alive: () => boolean; // the view is in the page
  private at: { map: number; progress: EventProgress; rom: RomRead } | null = null; // what the steps are of
  private steps: AnimStep[] | null = null; // null while learned (none before)
  private anim: OwTileAnimation | null = null; // for the load the view draws with
  private phase = -1;
  private timer = 0;
  private listeners = new Set<() => void>();

  constructor(app: App, alive: () => boolean) {
    this.app = app;
    this.alive = alive;
    app.on('animation', () => {
      if (!this.alive()) return;
      if (app.view.show.anim) this.ask(); else this.stop();
    });
  }

  on(_ev: 'anim-frame', fn: () => void): void {
    this.listeners.add(fn);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }

  // the view draws map `map` at event progress `progress` with load `r` (its map's at the progress, or the one drawn
  // last while that is emulated): the steps of that map and progress, asked for (again: the ROM may have changed)
  follow(map: number, progress: EventProgress, r: OwRender): void {
    const rom = this.app.rom;
    if (this.anim?.r !== r) this.anim = new OwTileAnimation(rom, r);
    if (this.at?.map !== map || !sameProgress(this.at.progress, progress) || this.at.rom !== rom) {
      this.stop();
      this.steps = null;
      this.at = { map, progress, rom };
    }
    if (this.app.view.show.anim) this.ask();
  }

  private ask(): void {
    const at = this.at;
    if (!at) return;
    const known = this.app.owAnimSteps(at.map, at.progress, (s) => { if (this.at === at) this.learned(s); });
    if (known) this.learned(known);
  }
  private learned(steps: AnimStep[]): void {
    if (steps === this.steps && this.timer) return;
    const was = this.steps;
    this.steps = steps;
    if (was !== steps) this.phase = -1;
    if (!this.alive() || !this.app.view.show.anim) return;
    // (nothing animates: the still map)
    const anim = this.anim;
    if (!anim || !steps.some((s) => anim.stepChanges(s))) { this.stop(); return; }
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 1000 / ANIM_STEPS_PER_SECOND);
  }

  private tick(): void {
    if (!this.alive() || !this.app.view.show.anim || !this.steps?.length) { this.stop(); return; }
    if (this.app.scheduler.held()) return;
    this.phase = (this.phase + 1) % this.steps.length;
    this.emit();
  }

  // stopped: the still map and pickers again
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = 0;
    this.phase = -1;
    this.emit();
  }

  // the step shown now; null when none is (the still map)
  animStep(): AnimStep | null {
    return this.timer && this.phase >= 0 ? this.steps?.[this.phase] ?? null : null;
  }
  // what draws the steps on pixels drawn with the load the view draws with
  tileAnimation(): PictureAnimation {
    return this.anim ?? STILL;
  }
  // the steps' drawing for load r (null: the steps are drawn for another one)
  animationFor(r: OwRender): OwTileAnimation | null {
    return this.anim?.r === r ? this.anim : null;
  }
}
