// Path validation on the overworld's map (owreach.ts): the path and level tiles Mario doesn't reach at the event
// progress dimmed (a view setting), and the problems – dead ends, level tiles nothing leads to, events revealing
// nothing he reaches – in a list in the status bar. Searched again when the ROM, the event progress or what it is
// searched over (path kinds and shapes, the maps at the progress and with every event passed, the saves there)
// changes; nothing is shown while one of those is learned.

import type { OverworldView } from './overworld.ts';
import { problemListButton } from './problems.ts';
import { gameL1, l1XY, OW_EVENTS, type OwRender } from '../core/overworld.ts';
import { reach, reachInput, reachProblems, type Reached, type ReachProblem } from '../core/owreach.ts';
import { levelTeleports } from '../core/owlinks.ts';
import { tileText, type OwTile } from '../core/owteleport.ts';
import { readStart } from '../core/owsprites.ts';
import type { ProgressSave } from '../core/owprogress.ts';
import { RAM } from '../core/ram.ts';

export class ReachLayer {
  view: OverworldView;
  show = false; // the tiles Mario doesn't reach dimmed
  button: ReturnType<typeof problemListButton<ReachProblem>>;
  private found: { key: string; now: Reached; all: Reached; problems: ReachProblem[] } | null = null;
  // by ROM generation and progress: null while it is learned, undefined when it could not be (not asked again)
  private saves = new Map<string, ProgressSave | null | undefined>();
  constructor(view: OverworldView) {
    this.view = view;
    this.button = problemListButton<ReachProblem>({
      title: 'Problems of the overworld\'s paths', heading: 'Problems of the paths', collect: () => this.state()?.problems ?? [],
      canOpen: () => true, open: (p) => this.view.showTile(p.tile),
    });
  }
  // something the search needs came
  private learned = () => {
    if (!this.view.root.isConnected) return;
    this.button.update();
    if (this.show) this.view.paint();
  };

  // the save at an event progress, null while it is learned or when it could not be
  private save(progress: number): ProgressSave | null {
    const key = `${this.view.app.rom.gen}:${progress}`;
    if (this.saves.has(key)) return this.saves.get(key) ?? null;
    const s = this.view.app.progressSave(progress);
    if (!(s instanceof Promise)) { this.saves.set(key, s); return s; }
    this.saves.set(key, null);
    void s.then((v) => { this.saves.set(key, v); if (v) this.learned(); });
    return null;
  }

  // the search at the event progress shown and with every event passed, with its problems; null while something it
  // needs is learned
  state(): { now: Reached; all: Reached; problems: ReachProblem[] } | null {
    const v = this.view, app = v.app, rom = app.rom;
    const key = `${rom.gen}:${v.progress}`;
    if (this.found?.key === key) return this.found;
    if (this.saves.size > 64) this.saves.clear();
    const kinds = v.pathKinds(), shapes = app.pathShapes(this.learned);
    const shown = v.load(), every = app.overworldAllEvents(this.learned);
    const saveNow = this.save(v.progress), saveAll = this.save(OW_EVENTS);
    if (!kinds || !shapes || !shown || !every || !saveNow || !saveAll) return null;
    // where the levels' exits to the overworld teleport (per translevel, as asked)
    const graph = app.entrances.graph(), warps = new Map<number, OwTile[]>();
    const levelWarps = (tl: number) => warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl).map((t) => t.to)).get(tl)!;
    const start = readStart(rom, 0);
    const search = (r: OwRender, s: ProgressSave): Reached => {
      const inp = reachInput(rom, gameL1(r), r.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd), s.levelFlags, kinds, shapes, start, levelWarps);
      return { inp, r: reach(inp) };
    };
    const now = search(shown, saveNow), all = search(every, saveAll);
    const place = (i: number) => tileText({ submap: v.submapAt(i), ...l1XY(i) });
    this.found = { key, now, all, problems: reachProblems(rom, now, all, place) };
    return this.found;
  }

  // the path and level tiles of the region shown Mario doesn't reach at the event progress, dimmed
  paint(ctx: CanvasRenderingContext2D): void {
    if (!this.show) return;
    const st = this.state();
    if (!st) return;
    const { l1, kinds } = st.now.inp, base = this.view.region * 0x400;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (let k = 0; k < 0x400; k++) {
      const i = base + k;
      if (kinds[l1[i]] === 'none' || st.now.r.tiles[i]) continue;
      const { x, y } = l1XY(i);
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  }

  // what the status bar says of tile i: not reached at the event progress
  status(i: number): string {
    const st = this.show ? this.state() : null;
    if (!st || st.now.inp.kinds[st.now.inp.l1[i]] === 'none' || st.now.r.tiles[i]) return '';
    return 'Mario doesn\'t get here at this event progress';
  }
}
