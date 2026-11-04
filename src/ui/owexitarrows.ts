// The exits' arrows in the Levels mode (View → "Exit arrows", on by default; owexitedges.ts): from each level tile an
// arrow to each level its exits open – solid for the normal exit, dashed for a secret one, ending at the link leaving
// the submap when the level is on another; an exit opening nothing Mario reaches a short red stub – a grey
// dotted one when Mario doesn't reach its level even with every event passed (nothing can't be told). Hovering one
// says what it is in the status bar; the "When beaten…" sentences tell the same levels. Learned in the probe worker
// once per ROM edit (passableEdgesJob: the searches at every event progress over the maps built from the events and
// the saves' level flags, the rule with the events still passable without an exit's event), from the path kinds and
// shapes; nothing is drawn while those are first learned. After an edit the arrows learned before stay drawn, dimmed, until
// the new ones come (#388); the "When beaten…" sentences tell no levels meanwhile, marked as being learned.

import type { OverworldView } from './overworld.ts';
import { arrow } from './owlinkview.ts';
import { l1XY, EXIT_NAMES, MAP_NAMES, translevelToLevel } from '../core/overworld.ts';
import type { ExitEdge } from '../core/owexitedges.ts';
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
  // the probe worker's edges for the ROM generation (not asked again while it holds; of an older one: drawn dimmed)
  private passable: { rom: object; gen: number; edges: ExitEdge[] } | null = null;
  private asked = -1; // the ROM generation they were asked for at (until something comes: not asked again each paint)
  constructor(private view: OverworldView) {}

  // something the edges need came (the arrows and the "When beaten…" sentences show them)
  private learned = () => {
    this.asked = -1;
    if (!this.view.root.isConnected || this.view.mode !== 'levels') return;
    if (this.show) this.view.paint();
    if (this.edges()) this.view.buildSide(); // (the sentences tell them once they are found)
  };

  // the edges of the ROM as it is (the probe worker's), null while they or something they need are learned (also the
  // "When beaten…" sentences')
  edges(): ExitEdge[] | null {
    const v = this.view, app = v.app, rom = app.rom;
    if (this.passable?.gen === rom.gen) return this.passable.edges;
    const kinds = v.pathKinds(), shapes = app.pathShapes(this.learned);
    if (!kinds || !shapes || this.asked === rom.gen) return null;
    // (dropped: the overworld left, asked again when shown)
    const passable = app.overworldExitEdges(kinds, shapes, this.learned, () => { this.asked = -1; });
    if (passable) { this.passable = { rom, gen: rom.gen, edges: passable }; return passable; }
    this.asked = rom.gen;
    return null;
  }

  // the edges drawn: the ROM's as it is, else while they are learned those learned before an edit (stale: dimmed)
  private drawn(): { edges: ExitEdge[]; stale: boolean } | null {
    const edges = this.edges(), p = this.passable;
    if (edges) return { edges, stale: false };
    return p && p.rom === this.view.app.rom ? { edges: p.edges, stale: true } : null;
  }

  // the lines of the region shown: arrows, stubs (fanned out by exit), an arrow to the other region as a short one
  // labelled with the level; stale: the edges learned before an edit
  private lines(): { lines: Drawn[]; stale: boolean } {
    const d = this.drawn();
    if (!d) return { lines: [], stale: false };
    const { edges, stale } = d, rom = this.view.app.rom, region = this.view.region, out: Drawn[] = [];
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
    if (stale) for (const l of out) l.text += ' (before the last edit: being learned again)';
    return { lines: out, stale };
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
    const { lines, stale } = this.lines(), hot = this.hovered(lines, this.view.mouse);
    ctx.save();
    if (stale) ctx.globalAlpha = 0.4;
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
    ctx.restore();
  }

  // what the status bar says of the line under the mouse ('' none)
  status(): string {
    return this.show ? this.hovered(this.lines().lines, this.view.mouse)?.text ?? '' : '';
  }
}
