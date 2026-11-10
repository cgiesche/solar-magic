// Path validation on the overworld's map (owreach.ts): the path and level tiles Mario doesn't reach at the event
// progress dimmed (a view setting); the search's problems – dead ends, level tiles nothing leads to, events revealing
// nothing he reaches – are listed by the World check (worldcheck.ts). Searched again when the ROM, the event progress
// or what it is searched over (path kinds and shapes, the hardcoded paths, the maps at the progress and with every event passed, the saves there)
// changes; nothing is shown while one of those is learned. The search with every event passed is the same at every
// progress: kept while the ROM and what it searches are, so a step through the event list searches once (#388).

import type { OverworldView } from './overworld.ts';
import { gameL1, l1XY, OW_EVENTS, type OwRender } from '../core/overworld.ts';
import { reach, reachInput, type Reached } from '../core/owreach.ts';
import { levelTeleports } from '../core/owlinks.ts';
import type { OwTile } from '../core/owteleport.ts';
import { readStart } from '../core/owsprites.ts';
import type { ProgressSave } from '../core/owprogress.ts';
import { prefixLength, progressKey, type EventProgress } from '../core/eventset.ts';
import { RAM } from '../core/ram.ts';

export class ReachLayer {
  view: OverworldView;
  show = false; // the tiles Mario doesn't reach dimmed
  private found: { key: string; now: Reached; all: Reached } | null = null;
  // the search with every event passed and what it searched (the ROM and its generation, the map, the save, kinds,
  // shapes, the levels' exits)
  private every: { from: unknown[]; all: Reached } | null = null;
  // by ROM generation and progress: null while it is learned, undefined when it could not be (not asked again); a
  // request dropped (another progress shown, the overworld left) is forgotten, asked again when needed
  private saves = new Map<string, ProgressSave | null | undefined>();
  constructor(view: OverworldView) {
    this.view = view;
  }
  // something the search needs came
  private learned = () => {
    if (!this.view.root.isConnected) return;
    this.view.check.update();
    if (this.show) this.view.paint();
  };

  // the save at an event progress, null while it is learned or when it could not be
  private save(progress: EventProgress): ProgressSave | null {
    const key = `${this.view.app.rom.gen}:${progressKey(progress)}`;
    if (this.saves.has(key)) return this.saves.get(key) ?? null;
    const s = this.view.app.progressSave(progress, prefixLength(progress) === OW_EVENTS ? 'every' : 'shown');
    if (!(s instanceof Promise)) { this.saves.set(key, s); return s; }
    this.saves.set(key, null);
    void s.then((v) => {
      // (dropped: asked again if it is still needed, e.g. the event list back at it)
      if (v === null) { if (this.saves.get(key) === null) { this.saves.delete(key); this.learned(); } return; }
      this.saves.set(key, v);
      if (v) this.learned();
    });
    return null;
  }

  // the search at the event progress shown and with every event passed (the same object while nothing changed); null
  // while something it needs is learned
  state(): { now: Reached; all: Reached } | null {
    const v = this.view, app = v.app, rom = app.rom;
    const key = `${rom.gen}:${progressKey(v.progress)}`;
    if (this.found?.key === key) return this.found;
    if (this.saves.size > 64) this.saves.clear();
    const kinds = v.pathKinds(), shapes = app.pathShapes(this.learned), hard = kinds && app.hardWalks(kinds, this.learned);
    const shown = v.load(), every = app.overworldAllEvents(this.learned);
    const saveNow = this.save(v.progress), saveAll = this.save(OW_EVENTS);
    if (!kinds || !shapes || !hard || !shown || !every || !saveNow || !saveAll) return null;
    // where the levels' exits to the overworld teleport (per translevel, as asked)
    const graph = app.entrances.graph(), warps = new Map<number, OwTile[]>();
    const levelWarps = (tl: number) => warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl).map((t) => t.to)).get(tl)!;
    const start = readStart(rom, 0);
    const search = (r: OwRender, s: ProgressSave): Reached => {
      const inp = reachInput(rom, gameL1(r), r.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd), s.levelFlags, kinds, shapes, hard, start, levelWarps);
      return { inp, r: reach(inp) };
    };
    const from = [rom, rom.gen, every, saveAll, kinds, shapes, hard, graph];
    if (!this.every || this.every.from.some((x, k) => x !== from[k])) this.every = { from, all: search(every, saveAll) };
    this.found = { key, now: search(shown, saveNow), all: this.every.all };
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
