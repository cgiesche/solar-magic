// The layer 1 mode's route brush, "Path (auto)" above the layer 1 sheet (CONTEXT.md "Route"): with it as the brush a
// right drag (or Shift+drag, ADR 0011's paint buttons) from a cell through cells (each next to the one before; dragged
// back over the route it shortens) draws a route; a left click picks tiles as always, which ends it (the tiles
// picked are the brush), P goes back and forth between it and the last tile brush. The route shows the tiles the
// editor chooses for it (owroute.ts routeTiles) – a cell no tile fits in red, why in the status bar. Released, the tiles are written as one
// ROM edit into the progress chosen ("Map after": the event's layer 1 changes, else the map before events), as a
// stroke, and a level tile at an end whose exit runs the event gets that exit's direction (owroute.ts writeRoute). A
// stop tile it puts takes a level without level tile and without name, base event or messages (its translevel: the
// ways Mario walks off it), refused where none is left.
// Layer 2 is not touched.

import type { OverworldView } from './overworld.ts';
import { drawPathMark } from './overworld.ts';
import { toast } from './dom.ts';
import { refusalWords, refusedToast } from './owrefusal.ts';
import { l1Index, l1XY, exitDirections, DIR_NAMES, EXIT_NAMES, translevelToLevel } from '../core/overworld.ts';
import { pathWays } from '../core/owpathshape.ts';
import { routeTiles, routeExits, routeKind, writeRoute, stopTranslevels, type RouteTiles, type StopTranslevels } from '../core/owroute.ts';
import { hex } from '../core/names.ts';

export class PathTool {
  on = false; // the route brush chosen (the layer 1 mode's right button draws routes)
  private route: number[] | null = null; // the route being drawn (l1Index), its tiles
  private solved: RouteTiles | null = null;
  private stopTls: StopTranslevels | null = null; // (the translevels a stop may take, read once per drag)
  constructor(private view: OverworldView) {}

  // why a route can't be drawn now (null: it can): not before the path kinds and shapes are learned and, with an
  // event chosen, its maps are emulated (the event's layer 1 changes are written as the Levels mode's)
  private blocked(): string | null {
    const v = this.view;
    if (!v.pathKinds() || !v.pathShapes()) return 'The path tiles are still being learned – routes can be drawn in a moment.';
    const ev = v.levelEvent();
    if (typeof ev !== 'string') return null;
    return ev.includes('could not') ? 'Routes can\'t be drawn in this event: the map without its layer 1 changes could not be emulated.'
      : 'The map after the event is still being emulated – routes can be drawn in a moment.';
  }

  get drawing(): boolean { return !!this.route; }

  // pressed on cell (x, y): a route begins there
  down(x: number, y: number): void {
    const why = this.blocked();
    if (why) { toast(why); return; }
    if (!this.inside(x, y)) return;
    this.route = [l1Index(this.view.region, x, y)];
    this.stopTls = stopTranslevels(this.view.app.rom, this.view.tls);
    this.solved = this.solve(this.route);
    this.shown();
  }
  // dragged onto cell (x, y): the route goes on to it (in steps to cells next to each other), back over it shortens
  move(x: number, y: number): void {
    const r = this.route;
    if (!r) return;
    x = Math.max(0, Math.min(31, x)); y = Math.max(0, Math.min(31, y));
    const target = l1Index(this.view.region, x, y), back = r.indexOf(target);
    if (back >= 0) r.length = back + 1; // (dragged back onto the route: shortened to there)
    else if ((target >> 10) !== (r[0] >> 10)) return; // (another map shown meanwhile)
    for (;;) {
      const last = l1XY(r[r.length - 1]);
      if (last.x === x && last.y === y) break;
      // (a fast drag: steps towards the mouse, along the longer way first, the other where that runs into the route)
      const dx = Math.sign(x - last.x), dy = Math.sign(y - last.y), longX = Math.abs(x - last.x) >= Math.abs(y - last.y);
      const steps = [longX ? [dx, 0] : [0, dy], longX ? [0, dy] : [dx, 0]].filter(([sx, sy]) => sx || sy)
        .map(([sx, sy]) => l1Index(this.view.region, last.x + sx, last.y + sy));
      const c = steps.find((c) => !r.includes(c)) ?? steps[0], k = r.indexOf(c);
      if (k >= 0) r.length = k + 1; else r.push(c);
    }
    this.solved = this.solve(r);
    this.shown();
  }
  // released: the route written (one ROM edit), or refused (why) – solved again on the map as it is now (an undo or
  // another event chosen during the drag)
  up(): void {
    const r = this.route;
    this.route = this.solved = this.stopTls = null;
    this.shown();
    if (!r || r.length < 2) return;
    const why = this.blocked();
    if (why) { toast(why, 'error'); return; }
    const solved = this.solve(r), ev = this.view.levelEvent(), e = this.view.event, rom = this.view.app.rom;
    if (solved.refusal) { toast(`Route not drawn: ${this.refusalText(solved)}`, 'error'); return; }
    if (typeof ev === 'string') return; // (blocked said so)
    // (nothing to write: the tiles there already, the exits' directions set)
    const turned = routeExits(rom, r, ev).filter((x) => exitDirections(rom, x.tl)[x.exit] !== x.dir);
    if (!turned.length && solved.tiles.every((t, k) => t === null || t === this.view.levelL1()[r[k]])) return;
    let taken: number[] = [];
    try {
      this.view.app.romEdit(e >= 0 ? `Path (after event ${hex(e, 2)})` : 'Path', () => { taken = writeRoute(rom, r, solved, ev).taken; });
    } catch (err) {
      refusedToast(this.view.app.rom, err, 'Route not drawn: ');
      this.view.sync();
      return;
    }
    if (taken.length) toast(`The route's ${taken.length > 1 ? `${taken.length} stop tiles take levels` : 'stop tile takes level'} ${taken.map((tl) => hex(translevelToLevel(tl), 3)).join(', ')} (without level tile before): Mario walks off a stop in the ways its level opens.`);
    for (const exit of turned) toast(`Level ${hex(translevelToLevel(exit.tl), 3)}: ${EXIT_NAMES[exit.exit].toLowerCase()} now opens ${DIR_NAMES[exit.dir]} (the route)`);
  }
  // Esc: the route dropped; false: none
  cancel(): boolean {
    if (!this.route) return false;
    this.route = this.solved = this.stopTls = null;
    this.shown();
    return true;
  }

  // the route's tiles as the editor chooses them, on layer 1 as shown (after the event chosen)
  private solve(r: readonly number[]): RouteTiles {
    const v = this.view, kinds = v.pathKinds()!, l1 = v.levelL1();
    return routeTiles(r, { l1, kinds, shapes: v.pathShapes()!, prefer: routeKind(r, l1, kinds), stopTranslevels: this.stopTls ?? stopTranslevels(v.app.rom, v.tls) });
  }
  private shown(): void {
    this.view.paint();
    this.view.updateStatus();
  }

  private inside(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < 32 && y < 32; }
  private refusalText(s: RouteTiles): string {
    const f = s.refusal!, { x, y } = l1XY(f.cell);
    const alt = [f.stop && 'a stop tile there would work', f.turns.length && `a turn ${f.turns.map((d) => DIR_NAMES[d]).join(' or ')} would`].filter(Boolean);
    const { reason: why, instead } = refusalWords(this.view.app.rom, f.why);
    return `${hex(x, 2)},${hex(y, 2)}: ${why.charAt(0).toUpperCase() + why.slice(1)}${alt.length ? ` (${alt.join(', ')})` : ''}${instead ? ` – ${instead}` : ''}`;
  }

  // the status bar while a route is drawn (null: none)
  status(): string | null {
    if (!this.route) return this.on ? 'Path (auto): Click/drag picks up tiles · Right click/Shift+drag draws the route, the editor chooses its tiles (back over it shortens it) · release writes them · Esc cancels · P: the last tile brush' : null;
    const s = this.solved;
    return s?.refusal ? `Route of ${this.route.length} cells · ${this.refusalText(s)}` : `Route of ${this.route.length} cells · release writes its tiles · Esc cancels`;
  }

  // the route: its cells outlined, the tiles chosen as path marks (with their ways), a cell no tile fits in red
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    const r = this.route, s = this.solved;
    if (!r || !s) return;
    const v = this.view, kinds = v.pathKinds(), shapes = v.pathShapes();
    if (!kinds) return;
    const bad = s.refusal ? s.refusal.at : -1;
    r.forEach((c, k) => {
      if ((c >= 0x400) !== (v.region === 1)) return;
      const { x, y } = l1XY(c), t = s.tiles[k];
      ctx.fillStyle = k === bad ? 'rgba(235,40,40,0.55)' : 'rgba(255,255,255,0.18)';
      ctx.fillRect(x * 16, y * 16, 16, 16);
      if (t !== null && k !== bad) drawPathMark(ctx, kinds[t], x * 16, y * 16, lw, pathWays(t, kinds[t], shapes));
      ctx.strokeStyle = k === bad ? '#ff3030' : 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(x * 16 + 0.5 * lw, y * 16 + 0.5 * lw, 16 - lw, 16 - lw);
    });
  }
}
