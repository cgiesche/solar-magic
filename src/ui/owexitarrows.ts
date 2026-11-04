// The exits' arrows in the Levels mode (View → "Exit arrows", on by default; owexitedges.ts): from each level tile an
// arrow to each level its exits open – solid for the normal exit, dashed for a secret one, ending at the link leaving
// the submap when the level is on another; an exit opening nothing Mario reaches a short red stub – a grey
// dotted one when Mario doesn't reach its level even with every event passed (nothing can't be told). Hovering one
// says what it is in the status bar. Derived once per ROM edit from the maps at every event progress (learned in the
// probe worker), the path kinds and shapes; nothing is drawn while those are learned.

import type { OverworldView } from './overworld.ts';
import { arrow } from './owlinkview.ts';
import { l1XY, EXIT_NAMES, MAP_NAMES, translevelToLevel } from '../core/overworld.ts';
import { exitEdges, progressInput, type ExitEdge } from '../core/owexitedges.ts';
import { levelName } from '../core/levelnames.ts';
import { hex } from '../core/names.ts';

const COLORS = { normal: '#7ee07e', secret: '#ffe14c', none: '#ff4a4a', unknown: '#9aa0a6' };
// the middle of layer 1 tile i (l1Index) in the map's pixels
const center = (i: number) => { const { x, y } = l1XY(i); return { x: x * 16 + 8, y: y * 16 + 8 }; };
type Pt = { x: number; y: number };
// a line drawn: its ends, how, what hovering it says
interface Drawn { p: Pt; q: Pt; color: string; dashed: boolean; head: boolean; text: string }

export class ExitArrowLayer {
  show = true; // drawn in the Levels mode
  // the edges found, for the ROM generation and the maps (by identity: learned again) they were found with
  private found: { key: string; mapsUsed: unknown; edges: ExitEdge[] } | null = null;
  constructor(private view: OverworldView) {}

  // something the edges need came
  private learned = () => {
    if (!this.view.root.isConnected) return;
    if (this.show && this.view.mode === 'levels') this.view.paint();
  };

  // the edges of the ROM as it is, null while something they need is learned
  private edges(): ExitEdge[] | null {
    const v = this.view, app = v.app, rom = app.rom;
    const kinds = v.pathKinds(), shapes = app.pathShapes(this.learned), maps = app.overworldProgressMaps(this.learned);
    if (!kinds || !shapes || !maps || !v.views) return null;
    const key = `${rom.gen}`;
    if (this.found?.key === key && this.found.mapsUsed === maps) return this.found.edges;
    const edges = exitEdges(rom, progressInput(rom, maps, kinds, shapes, app.entrances.graph()), (i) => v.submapAt(i));
    this.found = { key, mapsUsed: maps, edges };
    return edges;
  }

  // the lines of the region shown: arrows, stubs (fanned out by exit), an arrow to the other region as a short one
  // labelled with the level
  private lines(): Drawn[] {
    const edges = this.edges();
    if (!edges) return [];
    const rom = this.view.app.rom, region = this.view.region, out: Drawn[] = [];
    const levelText = (tl: number) => `${levelName(rom, tl)} (${hex(translevelToLevel(tl), 3)})`;
    const stub = (from: number, k: number): Pt => { const p = center(from), a = -Math.PI / 4 + (k - 1.5) * 0.45; return { x: p.x + Math.cos(a) * 14, y: p.y + Math.sin(a) * 14 }; };
    for (const e of edges) {
      if (e.from >> 10 !== region) continue;
      const exit = `${EXIT_NAMES[e.exit]} of ${levelText(e.tl)}`, p = center(e.from), dashed = e.exit > 0;
      if (!e.reached && !e.opens.length) {
        out.push({ p, q: stub(e.from, e.exit), color: COLORS.unknown, dashed: true, head: false,
          text: `${exit} (event ${hex(e.event, 2)}): what it opens can't be told – Mario doesn't reach the level, not even with every event passed` });
        continue;
      }
      if (!e.opens.length) {
        out.push({ p, q: stub(e.from, e.exit), color: COLORS.none, dashed, head: false, text: `${exit} opens nothing Mario reaches (event ${hex(e.event, 2)})` });
        continue;
      }
      for (const o of e.opens) {
        const via = o.end !== o.tile ? ` – on ${MAP_NAMES[this.view.submapAt(o.tile)]}, by way of this link` : '';
        const text = `${exit} opens ${levelText(o.tl)}${via}`, color = dashed ? COLORS.secret : COLORS.normal;
        if (o.end >> 10 === region) out.push({ p, q: center(o.end), color, dashed, head: true, text });
        else out.push({ p, q: stub(e.from, e.exit), color, dashed, head: true, text });
      }
    }
    return out;
  }

  // the line under the map pixel m (within 3 pixels; the nearest), null none
  private hovered(lines: Drawn[], m: Pt | null): Drawn | null {
    if (!m) return null;
    let best: Drawn | null = null, nearest = 3;
    for (const l of lines) {
      const dx = l.q.x - l.p.x, dy = l.q.y - l.p.y, n = dx * dx + dy * dy;
      // (not near its start: a level tile's lines all start there)
      if (Math.hypot(m.x + 0.5 - l.p.x, m.y + 0.5 - l.p.y) < 6) continue;
      const t = n ? Math.max(0, Math.min(1, ((m.x + 0.5 - l.p.x) * dx + (m.y + 0.5 - l.p.y) * dy) / n)) : 0;
      const d = Math.hypot(l.p.x + t * dx - m.x - 0.5, l.p.y + t * dy - m.y - 0.5);
      if (d <= nearest) { nearest = d; best = l; }
    }
    return best;
  }

  // the lines of the region shown, the one under the mouse highlighted (arrows as the links', stubs without a head)
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    if (!this.show) return;
    const lines = this.lines(), hot = this.hovered(lines, this.view.mouse);
    for (const l of lines) {
      if (l.head) { arrow(ctx, lw, l.p, l.q, l.color, false, l === hot, l.dashed); continue; }
      for (const [c, w] of [['rgba(0,0,0,0.75)', l === hot ? 5 : 3.5], [l === hot ? '#fff' : l.color, l === hot ? 2.5 : 1.5]] as [string, number][]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w * lw;
        ctx.setLineDash(l.dashed ? [3 * lw, 2 * lw] : []);
        ctx.beginPath();
        ctx.moveTo(l.p.x, l.p.y); ctx.lineTo(l.q.x, l.q.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // what the status bar says of the line under the mouse ('' none)
  status(): string {
    return this.show ? this.hovered(this.lines(), this.view.mouse)?.text ?? '' : '';
  }
}
