// Scrollable, zoomable level canvas with editing interactions.

import { App, isBrushMode, type Marker, type LevelEdit, type Brush, type PreviewPart } from './app.ts';
import { h, attachPanZoom, toast } from './dom.ts';
import { downloadBytes } from './platform.ts';
import { hex2, hex3 } from '../core/names.ts';
import { resizeObjectSize } from '../core/objkinds.ts';
import { probeAt, spriteProbeAt, enterText, collisionText, type PosProbe, type CollisionProbe } from '../core/blockprobe.ts';
import { type LevelObject, type LevelSprite, newUid, serializeLayer1, serializeLayer2, serializeLevelSprites, spriteSizes, spriteId, EXIT_NEW } from '../core/level.ts';
import { overworldExitText } from '../core/owteleport.ts';
import { composite, invisibleTiles, type LevelImages } from '../core/render.ts';
import { layer3CellAt, layer3WordText } from '../core/layer3map.ts';
import type { ArcSpeed } from '../core/jumparcs.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { contextMenu, type MenuItem } from './menu.ts';
import { isPlacedPrefab, openSavePrefab } from './panels.ts';
import { openInsertDialog, openScreenDialog } from './tools.ts';
import { incompleteSprites } from './spritemem.ts';
import { problemsButton } from './problems.ts';
import { map16Tile } from '../core/ram.ts';
import { GAME_VIEW_W, GAME_VIEW_H, MARIO_W, MARIO_H, type CameraBands } from '../core/camerabands.ts';
import { gameViewAt } from '../core/camerareach.ts';
import { isDm16, dm16Tiles, prefabFlags } from '../core/cdm16.ts';
import { boxLabel } from '../core/objboxes.ts';
import { paintObjectBox, paintBoxName } from './objbox.ts';
import { PREFAB_EXT, readPrefab } from '../core/prefabs.ts';
import { projectId } from '../core/projectid.ts';
import { loadDeaths, killerText, killerTile, levelVersion, type DeathMark } from './deathmarks.ts';

type Drag =
  | { kind: 'move'; edit: LevelEdit; startTx: number; startTy: number; lastDx: number; lastDy: number; orig: Map<number, { x: number; y: number }> }
  | { kind: 'resize'; edit: LevelEdit; startTx: number; startTy: number; origSize: Map<number, number>; lastDw: number; lastDh: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean; far: boolean } // far: dragged, not a click
  | { kind: 'marker'; edit: LevelEdit | null; marker: Marker; offX: number; offY: number; moved: boolean } // (secondary entrances: not a level edit)
  | { kind: 'paint'; edit: LevelEdit; changed: boolean; x0: number; y0: number; lastX: number; lastY: number } // BG/layer 3 brush, stamped on a grid of cells from (x0, y0)
  | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number } // BG/layer 3 cells taken into the brush
  | { kind: 'gameView'; offX: number; offY: number }; // the game view frame, held at (offX, offY) inside it

const ARC_STYLE: Record<ArcSpeed, { color: string; label: string; dash?: boolean }> = {
  stand: { color: '#ffffff', label: 'from standing' },
  walk: { color: '#7fe0ff', label: 'walking' },
  run: { color: '#ffd84c', label: 'running' },
  p: { color: '#ff6bd5', label: 'P-speed', dash: true },
};

// the game view's scroll bands: X bands are columns of the frame, Y bands rows; the look-ahead ones outlined
// tiles that kill in the collision overlay, 8x8 px drawn in the middle of the tile
const SKULL = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'X..XX..X', 'X..XX..X', 'XXXX.XXX', '.XXXXXX.', '.X.XX.X.'];
const BAND_STYLE: Record<keyof CameraBands, { color: string; label: string; axis: 'x' | 'y'; look?: boolean }> = {
  right: { color: '255,60,60', label: 'scrolling right', axis: 'x' },
  left: { color: '60,220,90', label: 'scrolling left', axis: 'x' },
  up: { color: '70,130,255', label: 'scrolling up', axis: 'y' },
  down: { color: '190,80,255', label: 'scrolling down', axis: 'y' },
  lookRight: { color: '255,200,40', label: 'after R (look ahead)', axis: 'x', look: true },
  lookLeft: { color: '60,220,255', label: 'after L (look ahead)', axis: 'x', look: true },
};

const MARKER_STYLE: Record<Marker['kind'], { color: string; label: string; title: string }> = {
  main: { color: 'rgba(255,40,40,0.9)', label: 'M', title: 'Main entrance' },
  midway: { color: 'rgba(255,150,0,0.9)', label: 'Z', title: 'Midway point' },
  sec: { color: 'rgba(40,120,255,0.9)', label: 'S', title: 'Secondary entrance' },
};

export class LevelView {
  app: App;
  root: HTMLDivElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  levelCanvas: HTMLCanvasElement;
  hover: { tx: number; ty: number; px: number; py: number; top: number; cx: number; cy: number } | null = null; // cx/cy: the brush cell
  drag: Drag | null = null;
  status: HTMLSpanElement;
  stats: HTMLSpanElement;
  problems: ReturnType<typeof problemsButton>;
  pos: HTMLSpanElement;
  pendingFrame = 0;
  arcPin: { tx: number; ty: number } | null = null; // jump arcs stay at this tile instead of following the mouse

  constructor(app: App, statusBar: HTMLDivElement) {
    this.app = app;
    this.pos = h('span', { class: 'status-pos' });
    this.status = h('span', { class: 'status-text' });
    this.stats = h('span', { class: 'status-stats' });
    this.problems = problemsButton(app, (u) => this.revealSprites(u));
    statusBar.append(this.pos, this.status, this.stats, this.problems);
    this.canvas = h('canvas', { class: 'level-canvas' });
    this.sizer = h('div', { class: 'level-sizer' });
    this.scroller = h('div', { class: 'level-scroller', tabIndex: 0 }, this.canvas, this.sizer);
    this.root = h('div', { class: 'level-view' }, this.scroller);
    this.ctx = this.canvas.getContext('2d')!;
    this.levelCanvas = document.createElement('canvas');
    this.scroller.addEventListener('scroll', () => this.paint());
    // next frame: layout() resizes the canvas inside the observed scroller (no ResizeObserver loop error)
    new ResizeObserver(() => requestAnimationFrame(() => this.layout())).observe(this.scroller);
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    attachPanZoom(this.scroller, () => this.app.zoom, (z, ax, ay) => this.setZoom(z, { ax, ay }));
    this.scroller.addEventListener('mouseleave', () => { this.hover = null; this.idleStatus(); this.paint(); });
    app.on('render', () => { this.updateLevelImage(); this.updateStats(); });
    app.on('anim-frame', () => { this.updateLevelImage(false); });
    app.on('change', () => { this.paint(); this.updateStats(); });
    app.on('reveal', () => this.scrollToTile(app.reveal.x >> 4, app.reveal.y >> 4));
    app.on('sprites', () => this.requestPaint());
    app.on('sprite-mem', () => { this.requestPaint(); this.updateStats(); });
    app.on('mode', () => { if (!this.hover) this.idleStatus(); });
    app.on('rom-change', () => this.problems.update());
    app.on('arcs', () => this.requestPaint());
    app.on('placement-preview', () => this.requestPaint());
    app.on('picked-item', () => { this.lastPreview = null; this.requestPaint(); });
    app.on('game-view', () => this.requestPaint());
    app.on('level-scan', () => { this.problems.update(); this.requestPaint(); });
    this.idleStatus();
    app.on('probes', () => { if (this.hover && !this.drag) this.updateStatus(this.hover.tx, this.hover.ty); this.requestPaint(); this.problems.update(); });
  }

  setZoom(z: number, anchor?: { ax: number; ay: number }): void {
    z = Math.max(0.5, Math.min(4, z));
    const old = this.app.zoom;
    if (z === old) return;
    const rect = this.scroller.getBoundingClientRect();
    const ax = anchor ? anchor.ax : rect.width / 2;
    const ay = anchor ? anchor.ay : rect.height / 2;
    const lx = (this.scroller.scrollLeft + ax) / old, ly = (this.scroller.scrollTop + ay) / old;
    this.app.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.paint();
    this.app.emit('zoom');
  }

  updateLevelImage(relayout = true): void {
    const im = this.app.images;
    if (this.levelCanvas.width !== im.width || this.levelCanvas.height !== im.height) {
      this.levelCanvas.width = im.width;
      this.levelCanvas.height = im.height;
    }
    const lctx = this.levelCanvas.getContext('2d')!;
    const id = new ImageData(new Uint8ClampedArray(this.app.compositeImg.buffer.slice(0) as ArrayBuffer), im.width, im.height);
    lctx.putImageData(id, 0, 0);
    if (relayout) this.layout(); else this.requestPaint();
  }

  layout(): void {
    const im = this.app.images;
    if (!im) return;
    const z = this.app.zoom;
    this.sizer.style.width = `${im.width * z}px`;
    this.sizer.style.height = `${im.height * z}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hh = this.scroller.clientHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(hh * dpr);
    this.paint();
  }

  requestPaint(): void {
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => { this.pendingFrame = 0; this.paint(); });
  }

  // BG and layer 3 are painted with a brush on a grid of cells: BG tiles (16 px), layer 3's 8x8 tiles where
  // layer 3 is drawn (layer3map.ts)
  brushMode(): boolean {
    return isBrushMode(this.app.mode);
  }
  cellAt(px: number, py: number): { x: number; y: number } {
    if (this.app.mode !== 'l3') return { x: Math.floor(px / 16), y: Math.floor(py / 16) };
    const c = layer3CellAt(this.app.l3Grid(), px, py);
    return { x: c.cx, y: c.cy };
  }
  // the pixel rectangle of w x h cells from (x, y)
  cellBox(x: number, y: number, w: number, h: number): [number, number, number, number] {
    if (this.app.mode !== 'l3') return [x * 16, y * 16, w * 16, h * 16];
    const g = this.app.l3Grid();
    return [x * 8 - g.dx, y * 8 - g.dy, w * 8, h * 8];
  }
  brush(): Brush {
    return this.app.mode === 'l3' ? this.app.l3Brush : this.app.bgBrush;
  }
  paintCell(x: number, y: number): boolean {
    return this.app.mode === 'l3' ? this.app.paintL3Brush(x, y) : this.app.paintBrush(x, y);
  }
  // the largest brush picked from the level
  brushMax(): { w: number; h: number } {
    return this.app.mode === 'l3' ? { w: 32, h: 32 } : { w: 32, h: 27 };
  }

  tileFromEvent(e: MouseEvent): { tx: number; ty: number; px: number; py: number } {
    const rect = this.scroller.getBoundingClientRect();
    const z = this.app.zoom;
    const px = (e.clientX - rect.left + this.scroller.scrollLeft) / z;
    const py = (e.clientY - rect.top + this.scroller.scrollTop) / z;
    return { tx: Math.floor(px / 16), ty: Math.floor(py / 16), px, py };
  }

  // ---------------- painting ----------------
  paint(): void {
    const app = this.app;
    if (!app.images) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const z = app.zoom * dpr;
    const sx = this.scroller.scrollLeft * dpr, sy = this.scroller.scrollTop * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(z, 0, 0, z, -sx, -sy);
    ctx.drawImage(this.levelCanvas, 0, 0);
    const im = app.images;
    const lw = 1 / z;
    // grid
    if (app.show.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let x = 0; x <= im.width; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x, im.height); }
      for (let y = 0; y <= im.height; y += 16) { ctx.moveTo(0, y); ctx.lineTo(im.width, y); }
      ctx.stroke();
    }
    // screen boundaries
    const vertical = app.vertical;
    if (app.show.screens) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.setLineDash([4 * lw, 4 * lw]);
      ctx.lineWidth = lw;
      ctx.beginPath();
      if (vertical) for (let y = 256; y < im.height; y += 256) { ctx.moveTo(0, y); ctx.lineTo(im.width, y); }
      else for (let x = 256; x < im.width; x += 256) { ctx.moveTo(x, 0); ctx.lineTo(x, im.height); }
      ctx.stroke();
      ctx.setLineDash([]);
      // on a dark box like the exit labels, readable on light backgrounds too
      ctx.font = `${11 / app.zoom}px sans-serif`;
      const n = app.level.header.screens;
      for (let s = 0; s < n; s++) {
        const x = vertical ? 0 : s * 256, y = vertical ? s * 256 : 0, txt = hex2(s);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, y, ctx.measureText(txt).width + 4 / app.zoom, 14 / app.zoom);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, x + 2 / app.zoom, y + 11 / app.zoom);
      }
    }
    // exits
    if (app.show.exits || app.mode === 'exit') {
      const scrH = vertical ? 256 : im.height;
      if (app.mode === 'exit' && !app.exitMarker) {
        // the chosen screen, also without an exit
        const x = vertical ? 0 : app.exitScreen * 256, y = vertical ? app.exitScreen * 256 : 0;
        ctx.strokeStyle = 'rgba(255,200,0,0.9)';
        ctx.lineWidth = 2 / app.zoom;
        ctx.strokeRect(x + 1 / app.zoom, y + 1 / app.zoom, 256 - 2 / app.zoom, (vertical ? 256 : scrH) - 2 / app.zoom);
      }
      const g = app.entrances.graph();
      for (const ex of app.level.exits) {
        const x = vertical ? 0 : ex.screen * 256, y = vertical ? ex.screen * 256 : 0;
        const sel = app.mode === 'exit' && !app.exitMarker && app.exitScreen === ex.screen;
        ctx.fillStyle = sel ? 'rgba(255,200,0,0.25)' : 'rgba(255,160,0,0.08)';
        ctx.fillRect(x, y, 256, vertical ? 256 : scrH);
        const t = exitTarget(app.rom, app.level.number, ex);
        const ok = t.entrance < 0 || t.overworld || g.entrancesOf(t.to).includes(t.entrance);
        ctx.font = `bold ${12 / app.zoom}px sans-serif`;
        const line = (txt: string, i: number) => {
          const ty = y + (12 + i * 14) / app.zoom;
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(x + 18 / app.zoom, ty - 11 / app.zoom, ctx.measureText(txt).width + 4 / app.zoom, 14 / app.zoom);
          ctx.fillStyle = ok ? '#ffb000' : '#ff5050';
          ctx.fillText(txt, x + 20 / app.zoom, ty);
        };
        line(t.overworld ? 'Exit → Overworld' : `Exit → ${g.label(t.to)}`, 0);
        if (t.overworld) line(overworldExitText(app.rom, app.entrances.get(t.entrance).overworld!), 1);
        else if (t.entrance >= 0) line(ok ? `via sec. entrance ${hex3(t.entrance)}` : `sec. entrance ${hex3(t.entrance)} missing`, 1);
      }
    }
    // entrance markers (Mario's start position, drawn at his lower 16x16 half)
    ctx.font = `bold 9px sans-serif`;
    for (const m of app.markers()) {
      if (m.x >= im.width || m.y >= im.height + 32) continue;
      const st = MARKER_STYLE[m.kind];
      const dragged = this.drag?.kind === 'marker' && this.drag.marker.kind === m.kind && this.drag.marker.index === m.index;
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.arc(m.x + 8, m.y + 24, dragged ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      if (app.mode === 'exit' && app.exitMarker?.kind === m.kind && app.exitMarker.index === m.index) {
        ctx.strokeStyle = '#ffd800';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.x + 8, m.y + 24, 9.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(st.label, m.x + 5, m.y + 27.5);
      if (m.kind === 'sec') ctx.fillText(hex3(m.index), m.x + 15, m.y + 27.5);
    }
    if (app.mode === 'l2' ? app.show.layer2 : app.show.layer1) this.paintConds(ctx, lw);
    this.paintBoxes(ctx);
    if (app.show.invisible) this.paintInvisible(ctx, lw);
    if (app.show.collision) this.paintCollision(ctx);
    if (app.show.collision || app.show.layer3) this.paintTide(ctx);
    if (app.show.items) this.paintItems(ctx);
    // sprites
    if (app.show.sprites) this.paintSprites(ctx, z);
    if (app.show.sprites && app.show.items) this.paintSpriteItems(ctx);
    if (app.show.deaths) this.paintDeaths(ctx, lw);
    if (app.show.arcs) this.paintArcs(ctx);
    if (app.show.gameView) this.paintGameView(ctx);
    // selection
    if (app.mode === 'l1' || app.mode === 'l2') {
      const sel = app.selectedObjects();
      for (const o of sel) this.outlineObject(ctx, o, '#4cc2ff', lw);
    }
    // hover
    if (this.hover && !this.drag) {
      const { tx, ty } = this.hover;
      if (app.show.preview && !this.onSelection(this.hover.px, this.hover.py)) this.paintPreview(ctx, tx, ty);
      const hits = this.brushMode() ? [] : app.hitsAt(this.hover.px, this.hover.py);
      const hit = hits.find((h) => h.mode === app.mode && app.selection.has(h.item.uid)) ?? hits[0];
      if (hit && !app.selection.has(hit.item.uid)) {
        if (hit.mode === 'spr') {
          const b = app.spriteBox(hit.item as LevelSprite);
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 2 * lw;
          ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        } else this.outlineObject(ctx, hit.item as LevelObject, 'rgba(255,255,255,0.7)', lw);
      }
      // BG and layer 3: the area the brush would paint
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      if (this.brushMode()) {
        const c = this.cellAt(this.hover.px, this.hover.py), b = this.brush();
        ctx.strokeRect(...this.cellBox(c.x, c.y, b.w, b.h));
      } else ctx.strokeRect(tx * 16, ty * 16, 16, 16);
    }
    this.paintBoxNames(ctx);
    if (this.drag?.kind === 'pick') {
      const d = this.drag;
      const m = this.brushMax();
      const box = this.cellBox(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.min(Math.abs(d.x1 - d.x0) + 1, m.w), Math.min(Math.abs(d.y1 - d.y0) + 1, m.h));
      ctx.strokeStyle = '#4cc2ff';
      ctx.fillStyle = 'rgba(76,194,255,0.15)';
      ctx.lineWidth = lw;
      ctx.fillRect(...box);
      ctx.strokeRect(...box);
    }
    if (this.drag?.kind === 'band') {
      const d = this.drag;
      ctx.strokeStyle = '#4cc2ff';
      ctx.fillStyle = 'rgba(76,194,255,0.15)';
      ctx.lineWidth = lw;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (app.show.arcs) this.paintArcLegend(ctx, dpr);
    if (app.show.gameView) this.paintGameViewLegend(ctx, dpr);
    if (app.renderError) {
      ctx.fillStyle = 'rgba(200,30,30,0.85)';
      ctx.fillRect(0, 0, this.canvas.width, 22 * dpr);
      ctx.fillStyle = '#fff';
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.fillText(`Emulation: ${app.renderError}`, 8 * dpr, 15 * dpr);
    }
  }

  // conditional Direct Map16 (cdm16.ts): a flag badge on each object that depends on a flag (prefabs by their
  // tiles' flags), green while the view shows it with the flag on; where one left nothing in the level's load, its tiles dashed
  paintConds(ctx: CanvasRenderingContext2D, lw: number): void {
    const app = this.app;
    const prefabs = new Map<number, number[]>();
    ctx.font = 'bold 7px sans-serif';
    for (const o of app.currentObjects()) {
      let flags: number[];
      if (isDm16(o)) flags = o.cond ? [o.cond.flag] : [];
      else if (o.num === 0 && o.ext === PREFAB_EXT && o.prefab !== undefined) {
        if (!prefabs.has(o.prefab)) prefabs.set(o.prefab, prefabFlags(readPrefab(app.rom, o.prefab)));
        flags = prefabs.get(o.prefab)!;
      } else continue;
      if (!flags.length) continue;
      if (isDm16(o) && o.cond && !app.objectDrawn(o)) {
        ctx.strokeStyle = 'rgba(255,190,60,0.8)';
        ctx.lineWidth = lw;
        ctx.setLineDash([3 * lw, 3 * lw]);
        for (const t of dm16Tiles(o)) ctx.strokeRect((t & 0xffff) * 16 + 0.5, (t >> 16) * 16 + 0.5, 15, 15);
        ctx.setLineDash([]);
      }
      const on = flags.some((f) => app.cdm16.has(f));
      const txt = `⚑${flags.slice(0, 2).map(hex2).join(',')}${flags.length > 2 ? '…' : ''}`;
      const x = o.x * 16 + 1, y = o.y * 16 + 1, w = ctx.measureText(txt).width + 3;
      ctx.fillStyle = on ? 'rgba(30,140,60,0.9)' : 'rgba(150,90,0,0.9)';
      ctx.fillRect(x, y, w, 9);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x + 1.5, y + 7.5);
    }
  }

  // the objects of the layers shown that draw nothing (objboxes.ts): a box on their tile
  private boxLayers(): boolean[] {
    const app = this.app;
    return [false, true].filter((l2) => (l2 ? app.show.layer2 && !!app.level.layer2Objects : app.show.layer1));
  }
  paintBoxes(ctx: CanvasRenderingContext2D): void {
    for (const l2 of this.boxLayers()) for (const o of this.app.boxedObjects(l2)) paintObjectBox(ctx, o.x * 16, o.y * 16, boxLabel(o));
  }

  // beside the box of a selected or hovered object, its name where it has one
  paintBoxNames(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    const hovered = this.hover && !this.drag && !this.brushMode() ? app.hitsAt(this.hover.px, this.hover.py).map((h) => h.item) : [];
    for (const l2 of this.boxLayers()) for (const o of app.boxedObjects(l2)) {
      if (!app.selection.has(o.uid) && !hovered.includes(o)) continue;
      const name = app.boxName(o);
      if (name) paintBoxName(ctx, o.x * 16, o.y * 16, name, app.zoom);
    }
  }

  // where Mario died in test play (deathmarks.ts), by his tile inside the level (a pit's below it: its bottom row)
  deathsAt(): Map<string, { tx: number; ty: number; marks: DeathMark[] }> {
    const app = this.app, w = app.images.width >> 4, hgt = app.images.height >> 4, at = new Map<string, { tx: number; ty: number; marks: DeathMark[] }>();
    for (const d of loadDeaths(projectId(app.rom), app.level.number)) {
      const tx = Math.max(0, Math.min(w - 1, d.tx)), ty = Math.max(0, Math.min(hgt - 1, d.ty)), k = `${tx},${ty}`;
      const e = at.get(k) ?? { tx, ty, marks: [] };
      e.marks.push(d);
      at.set(k, e);
    }
    return at;
  }

  // a red cross at Mario's tile (with the number of deaths there), a dashed red box at what killed him and a
  // line to it; faded: deaths before the level was last changed (saved)
  paintDeaths(ctx: CanvasRenderingContext2D, lw: number): void {
    const app = this.app, at = this.deathsAt(), w = (app.images.width >> 4) - 1, hgt = (app.images.height >> 4) - 1;
    const now = levelVersion(app.rom, app.level.number), old = (d: DeathMark) => d.version !== now;
    if (!at.size) return;
    ctx.lineWidth = 2 * lw;
    ctx.strokeStyle = 'rgba(255,60,60,0.9)';
    ctx.setLineDash([3 * lw, 3 * lw]);
    for (const { tx, ty, marks } of at.values()) for (const d of marks) {
      const kt = killerTile(d.killer);
      if (!kt) continue;
      const k = { tx: Math.max(0, Math.min(w, kt.tx)), ty: Math.max(0, Math.min(hgt, kt.ty)) };
      ctx.globalAlpha = old(d) ? 0.35 : 1;
      ctx.strokeRect(k.tx * 16 + 1, k.ty * 16 + 1, 14, 14);
      ctx.beginPath();
      ctx.moveTo(tx * 16 + 8, ty * 16 + 8);
      ctx.lineTo(k.tx * 16 + 8, k.ty * 16 + 8);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = 'bold 8px sans-serif';
    for (const { tx, ty, marks } of at.values()) {
      const x = tx * 16, y = ty * 16;
      ctx.globalAlpha = marks.every(old) ? 0.35 : 1;
      ctx.lineCap = 'round';
      for (const [width, color] of [[4, 'rgba(0,0,0,0.7)'], [2, '#ff3c3c']] as const) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + 13, y + 13);
        ctx.moveTo(x + 13, y + 3); ctx.lineTo(x + 3, y + 13);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
      if (marks.length > 1) {
        const txt = String(marks.length);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x + 10, y - 2, ctx.measureText(txt).width + 3, 9);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, x + 11.5, y + 5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // tiles that are there but cannot be seen (render.ts invisibleTiles): areas of them tinted, their edges dashed;
  // layer 2 objects' too while layer 2 is shown
  private invisible: { images: LevelImages; l1: (x: number, y: number) => boolean; l2: (x: number, y: number) => boolean } | null = null;
  paintInvisible(ctx: CanvasRenderingContext2D, lw: number): void {
    const app = this.app, im = app.images;
    if (this.invisible?.images !== im) this.invisible = { images: im, l1: invisibleTiles(app.rom, im, false), l2: invisibleTiles(app.rom, im, true) };
    const { x0, y0, x1, y1 } = this.visibleTiles();
    const layers = [...app.show.layer1 ? [this.invisible.l1] : [], ...app.show.layer2 && app.level.layer2Objects ? [this.invisible.l2] : []];
    for (const at of layers) {
      const edges = new Path2D();
      ctx.fillStyle = 'rgba(150,70,255,0.4)';
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (!at(x, y)) continue;
        const px = x * 16, py = y * 16;
        ctx.fillRect(px, py, 16, 16);
        if (!at(x - 1, y)) { edges.moveTo(px, py); edges.lineTo(px, py + 16); }
        if (!at(x + 1, y)) { edges.moveTo(px + 16, py); edges.lineTo(px + 16, py + 16); }
        if (!at(x, y - 1)) { edges.moveTo(px, py); edges.lineTo(px + 16, py); }
        if (!at(x, y + 1)) { edges.moveTo(px, py + 16); edges.lineTo(px + 16, py + 16); }
      }
      ctx.lineWidth = 2 * lw;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke(edges);
      ctx.strokeStyle = '#e4d8ff';
      ctx.setLineDash([3 * lw, 3 * lw]);
      ctx.stroke(edges);
      ctx.setLineDash([]);
    }
  }

  outlineObject(ctx: CanvasRenderingContext2D, o: LevelObject, color: string, lw: number): void {
    const tiles = this.app.objectTiles(o);
    const set = new Set(tiles);
    ctx.fillStyle = color.startsWith('#') ? 'rgba(76,194,255,0.18)' : 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * lw;
    ctx.beginPath();
    for (const t of tiles) {
      const x = t & 0xffff, y = t >> 16;
      ctx.fillRect(x * 16, y * 16, 16, 16);
      if (!set.has((y << 16) | (x - 1))) { ctx.moveTo(x * 16, y * 16); ctx.lineTo(x * 16, y * 16 + 16); }
      if (!set.has((y << 16) | (x + 1))) { ctx.moveTo(x * 16 + 16, y * 16); ctx.lineTo(x * 16 + 16, y * 16 + 16); }
      if (!set.has(((y - 1) << 16) | x)) { ctx.moveTo(x * 16, y * 16); ctx.lineTo(x * 16 + 16, y * 16); }
      if (!set.has(((y + 1) << 16) | x)) { ctx.moveTo(x * 16, y * 16 + 16); ctx.lineTo(x * 16 + 16, y * 16 + 16); }
    }
    ctx.stroke();
    // origin marker
    ctx.fillStyle = color;
    ctx.fillRect(o.x * 16, o.y * 16, 4, 4);
    if (this.app.selection.size === 1 && this.app.selection.has(o.uid) && (o.num !== 0 || isDm16(o))) {
      const b = this.app.objectBounds(o), hs = this.handleSize();
      ctx.fillStyle = '#4cc2ff';
      ctx.fillRect(b.x1 * 16 + 11, b.y1 * 16 + 11, hs, hs);
    }
  }

  // the tile jump arcs start from: the pinned one, else the one under the mouse
  arcTile(): { tx: number; ty: number } | null {
    return this.arcPin ?? (this.hover && !this.drag ? { tx: this.hover.tx, ty: this.hover.ty } : null);
  }

  // Jump arcs from the arc tile (emulated, see jumparcs.ts): a line per speed and direction,
  // a dot where Mario lands, a red cross where he dies
  paintArcs(ctx: CanvasRenderingContext2D): void {
    const at = this.arcTile();
    if (!at) return;
    const arcs = this.app.jumpArcs(at.tx, at.ty), lw = 1.5 / this.app.zoom;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = lw;
    ctx.strokeRect(at.tx * 16, at.ty * 16, 16, 16);
    if (this.arcPin) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(at.tx * 16, at.ty * 16, 16, 16); }
    for (const a of arcs ?? []) {
      const st = ARC_STYLE[a.speed], p = a.pts;
      if (p.length < 4) continue;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 2 * lw;
      ctx.setLineDash(st.dash ? [4 * lw, 3 * lw] : []);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
      ctx.setLineDash([]);
      const ex = p[p.length - 2], ey = p[p.length - 1];
      if (a.end === 'land') {
        ctx.fillStyle = st.color;
        ctx.beginPath();
        ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (a.end === 'dead') {
        ctx.strokeStyle = '#ff4040';
        ctx.beginPath();
        ctx.moveTo(ex - 3, ey - 3); ctx.lineTo(ex + 3, ey + 3);
        ctx.moveTo(ex + 3, ey - 3); ctx.lineTo(ex - 3, ey + 3);
        ctx.stroke();
      }
    }
  }

  // which line is which, in the top left corner of the view
  paintArcLegend(ctx: CanvasRenderingContext2D, dpr: number): void {
    const kinds = Object.values(ARC_STYLE);
    ctx.font = `${11 * dpr}px sans-serif`;
    const w = 112 * dpr, lh = 15 * dpr, x = 8 * dpr, y = 8 * dpr;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, w, lh * (kinds.length + 1) + 6 * dpr);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.arcPin ? 'Jump arcs (pinned)' : 'Jump arcs', x + 6 * dpr, y + lh - 3 * dpr);
    kinds.forEach((k, i) => {
      const ly = y + lh * (i + 2) - 7 * dpr;
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash(k.dash ? [4 * dpr, 3 * dpr] : []);
      ctx.beginPath(); ctx.moveTo(x + 6 * dpr, ly); ctx.lineTo(x + 26 * dpr, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.fillText(k.label, x + 32 * dpr, ly + 4 * dpr);
    });
  }

  // the game view frame's place: the camera at Mario when it is placed by him, else where it was put (first: the
  // middle of the view), inside the level as it is now and where the game lets the camera go (a smaller level or
  // a narrower camera range moves it only while it is open)
  gameViewPos(): { x: number; y: number } {
    const app = this.app, im = app.images, z = app.zoom, cam = app.gameViewMario?.camera;
    if (cam) return cam;
    app.gameView ??= gameViewAt((this.scroller.scrollLeft + this.scroller.clientWidth / 2) / z - GAME_VIEW_W / 2,
      (this.scroller.scrollTop + this.scroller.clientHeight / 2) / z - GAME_VIEW_H / 2, im.width, im.height);
    return gameViewAt(app.gameView.x, app.gameView.y, im.width, im.height, app.cameraReach());
  }

  // the label in the frame's top left corner (level pixels; it stays the same size on the screen)
  private gameViewLabel(): { x: number; y: number; w: number; h: number; text: string } {
    const p = this.gameViewPos(), z = this.app.zoom, m = this.app.gameViewMario;
    const text = !m ? 'Game view' : m.camera === undefined ? 'Game view (emulating …)' : m.camera === null ? 'Game view (camera not found)' : 'Game view at Mario';
    return { x: p.x, y: p.y, w: (10 + text.length * 6) / z, h: 14 / z, text };
  }

  // Shift+V: the game view frame placed by Mario with his feet in the tile under the mouse
  placeGameViewByMario(): void {
    if (!this.hover) return;
    this.app.show.gameView = true;
    this.app.placeGameViewByMario(this.hover.tx * 16, (this.hover.ty + 1) * 16 - MARIO_H);
    this.paint();
  }

  // whether the pixel grabs the game view frame: its edge (a few screen pixels either side) or its label
  gameViewGrab(px: number, py: number): boolean {
    if (!this.app.show.gameView) return false;
    const p = this.gameViewPos(), m = 4 / this.app.zoom, l = this.gameViewLabel();
    const inX = px >= p.x - m && px <= p.x + GAME_VIEW_W + m, inY = py >= p.y - m && py <= p.y + GAME_VIEW_H + m;
    const edge = (inX && (Math.abs(py - p.y) <= m || Math.abs(py - p.y - GAME_VIEW_H) <= m))
      || (inY && (Math.abs(px - p.x) <= m || Math.abs(px - p.x - GAME_VIEW_W) <= m));
    return edge || (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h);
  }

  // The game view frame (camerabands.ts) over the level darkened where the camera never goes (camerareach.ts),
  // with the scroll bands inside when they are shown, and Mario when it is placed by him
  paintGameView(ctx: CanvasRenderingContext2D): void {
    const app = this.app, p = this.gameViewPos(), z = app.zoom, lw = 1 / z;
    this.paintCameraReach(ctx);
    const m = app.gameViewMario;
    if (m) {
      ctx.fillStyle = 'rgba(255,60,60,0.45)';
      ctx.fillRect(m.x, m.y, MARIO_W, MARIO_H);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * lw;
      ctx.strokeRect(m.x, m.y, MARIO_W, MARIO_H);
    }
    const bands = app.show.scrollBands ? app.scrollBands() : undefined;
    for (const [k, st] of Object.entries(BAND_STYLE) as [keyof CameraBands, (typeof BAND_STYLE)[keyof CameraBands]][]) {
      const b = bands?.[k];
      if (!b) continue;
      const [x, y, w, bh] = st.axis === 'x' ? [p.x + b.from, p.y, b.to - b.from, GAME_VIEW_H] : [p.x, p.y + b.from, GAME_VIEW_W, b.to - b.from];
      ctx.fillStyle = `rgba(${st.color},${st.look ? 0.12 : 0.22})`;
      ctx.fillRect(x, y, w, bh);
      if (st.look) {
        ctx.strokeStyle = `rgba(${st.color},0.9)`;
        ctx.lineWidth = 1.5 * lw;
        ctx.setLineDash([4 * lw, 3 * lw]);
        ctx.strokeRect(x, y, w, bh);
        ctx.setLineDash([]);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4 * lw;
    ctx.strokeRect(p.x, p.y, GAME_VIEW_W, GAME_VIEW_H);
    ctx.strokeStyle = this.drag?.kind === 'gameView' ? '#ffd800' : '#ffffff';
    ctx.lineWidth = 2 * lw;
    ctx.strokeRect(p.x, p.y, GAME_VIEW_W, GAME_VIEW_H);
    const l = this.gameViewLabel();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(l.x, l.y, l.w, l.h);
    ctx.fillStyle = '#fff';
    ctx.font = `${11 / z}px sans-serif`;
    ctx.fillText(l.text, l.x + 5 / z, l.y + 11 / z);
  }

  // the level darkened where the camera never shows it, a rectangle per run of columns (vertical levels: rows)
  // with the same span
  private paintCameraReach(ctx: CanvasRenderingContext2D): void {
    const r = this.app.cameraReach(), im = this.app.images;
    if (!r) return;
    const across = r.vertical ? im.width : im.height;
    const rect = (along: number, n: number, from: number, to: number) => {
      if (to > from) { if (r.vertical) ctx.fillRect(from, along, to - from, n); else ctx.fillRect(along, from, n, to - from); }
    };
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0, j = 0; i < r.spans.length; i = j) {
      const s = r.spans[i];
      for (j = i + 1; j < r.spans.length && r.spans[j]?.[0] === s?.[0] && r.spans[j]?.[1] === s?.[1]; j++);
      const [from, to] = s ?? [across, across];
      rect(i * 16, (j - i) * 16, 0, from);
      rect(i * 16, (j - i) * 16, to, across);
    }
  }

  // what the overlays of the game view mean, in the top right corner of the view: where the camera never goes
  // (once the level scan found it), the scroll bands when they are shown
  paintGameViewLegend(ctx: CanvasRenderingContext2D, dpr: number): void {
    const reach = this.app.cameraReach();
    const rows: { label: string; fill?: string; title?: boolean }[] = [
      { label: reach === undefined ? 'Camera reach (emulating …)' : reach === null ? 'Camera reach (not found)' : 'Camera reach', title: true },
      { label: 'never on the screen', fill: 'rgba(0,0,0,0.8)' },
    ];
    if (this.app.show.scrollBands) {
      const bands = this.app.scrollBands();
      rows.push({ label: bands === undefined ? 'Scroll bands (emulating …)' : bands === null ? 'Scroll bands (not found)' : 'Scroll bands', title: true });
      for (const k of Object.values(BAND_STYLE)) rows.push({ label: k.label, fill: `rgba(${k.color},0.8)` });
    }
    ctx.font = `${11 * dpr}px sans-serif`;
    const w = 150 * dpr, lh = 15 * dpr, x = this.canvas.width - w - 8 * dpr, y = 8 * dpr;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, w, lh * rows.length + 6 * dpr);
    rows.forEach((r, i) => {
      const ly = y + lh * (i + 1) - 3 * dpr;
      if (r.fill) {
        ctx.fillStyle = r.fill;
        ctx.fillRect(x + 6 * dpr, ly - 9 * dpr, 20 * dpr, 10 * dpr);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = dpr;
        ctx.strokeRect(x + 6 * dpr, ly - 9 * dpr, 20 * dpr, 10 * dpr);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(r.label, x + (r.fill ? 32 : 6) * dpr, ly);
    });
  }

  // pins the jump arcs to the tile under the mouse, or unpins them
  toggleArcPin(): void {
    this.arcPin = this.arcPin || !this.hover ? null : { tx: this.hover.tx, ty: this.hover.ty };
    if (this.arcPin) this.app.show.arcs = true;
    this.paint();
  }

  // tiles of layer 1 in view: x0..x1, y0..y1 (exclusive)
  private visibleTiles(): { x0: number; y0: number; x1: number; y1: number } {
    const g = this.app.images.geom1, z = this.app.zoom;
    const x0 = Math.max(0, Math.floor(this.scroller.scrollLeft / z / 16)), y0 = Math.max(0, Math.floor(this.scroller.scrollTop / z / 16));
    return { x0, y0, x1: Math.min(g.width, x0 + Math.ceil(this.scroller.clientWidth / z / 16) + 1), y1: Math.min(g.height, y0 + Math.ceil(this.scroller.clientHeight / z / 16) + 1) };
  }

  // How Mario collides with layer 1 (found by emulation): the level is dimmed, solid sides are
  // white lines where they face something passable, platforms (solid from above only) dashed,
  // slopes diagonal; red: hurts, with spikes on the sides that hurt (stronger, with a skull: kills),
  // blue: water, green with a net: climbable.
  paintCollision(ctx: CanvasRenderingContext2D): void {
    const app = this.app, g = app.images.geom1, w = app.render.wram;
    if (!app.show.layer1) return;
    const { x0, y0, x1, y1 } = this.visibleTiles();
    const info = new Map<number, CollisionProbe | undefined>();
    const at = (x: number, y: number): CollisionProbe | undefined => {
      const a = g.addr(x, y);
      if (a < 0) return undefined;
      const t = map16Tile(w, a);
      if (!info.has(t)) info.set(t, app.probes.collision(t));
      return info.get(t);
    };
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x0 * 16, y0 * 16, (x1 - x0) * 16, (y1 - y0) * 16);
    const lw = 2 / app.zoom;
    const solidLines = new Path2D(), platLines = new Path2D(), net = new Path2D(), spikes = new Path2D();
    const skulls: [number, number][] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const c = at(x, y);
      if (!c) continue;
      const px = x * 16, py = y * 16;
      const fill = c.kills ? 'rgba(255,30,30,0.6)' : c.hurtsTop || c.hurtsSide ? 'rgba(255,70,70,0.4)'
        : c.water ? 'rgba(60,140,255,0.35)' : c.climb ? 'rgba(60,220,90,0.35)' : null;
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(px, py, 16, 16); }
      if (c.kills) skulls.push([px, py]);
      else {
        // spikes on the sides that hurt, where they face something Mario can come from
        if (c.hurtsTop && !at(x, y - 1)?.bottom) this.spikeRow(spikes, px, py, 0);
        if (c.hurtsSide && !at(x - 1, y)?.right) this.spikeRow(spikes, px, py, 1);
        if (c.hurtsSide && !at(x + 1, y)?.left) this.spikeRow(spikes, px, py, 2);
      }
      if (c.climb) {
        // diagonals every 8 px, which join into a net across neighboring tiles
        for (const d of [0, 8]) {
          net.moveTo(px + d, py); net.lineTo(px + 16, py + 16 - d);
          net.moveTo(px + 16 - d, py); net.lineTo(px, py + 16 - d);
          if (d) { net.moveTo(px, py + d); net.lineTo(px + 16 - d, py + 16); net.moveTo(px + 16, py + d); net.lineTo(px + d, py + 16); }
        }
      }
      if (c.slope) {
        // the surface within the tile (steep slopes measure beyond it)
        const [l, r] = c.slope, k = (r - l) / 16, xAt = (yy: number) => (yy - l) / k;
        let xa = 0, xb = 16;
        if (k !== 0) {
          const lo = Math.min(xAt(0), xAt(16)), hi = Math.max(xAt(0), xAt(16));
          xa = Math.max(0, lo); xb = Math.min(16, hi);
        }
        const yAt = (xx: number) => Math.max(0, Math.min(16, l + k * xx));
        solidLines.moveTo(px + xa, py + yAt(xa));
        solidLines.lineTo(px + xb, py + yAt(xb));
        continue;
      }
      const full = c.bottom || c.left || c.right;
      if (c.top && !full) {
        if (!at(x, y - 1)?.bottom) { platLines.moveTo(px, py); platLines.lineTo(px + 16, py); }
        continue;
      }
      // sides facing a tile that doesn't close them off
      if (c.top && !at(x, y - 1)?.bottom) { solidLines.moveTo(px, py); solidLines.lineTo(px + 16, py); }
      if (c.bottom && !at(x, y + 1)?.top) { solidLines.moveTo(px, py + 16); solidLines.lineTo(px + 16, py + 16); }
      if (c.left && !at(x - 1, y)?.right) { solidLines.moveTo(px, py); solidLines.lineTo(px, py + 16); }
      if (c.right && !at(x + 1, y)?.left) { solidLines.moveTo(px + 16, py); solidLines.lineTo(px + 16, py + 16); }
    }
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#fff';
    ctx.stroke(solidLines);
    ctx.strokeStyle = '#7fe0ff';
    ctx.setLineDash([3 * lw, 2 * lw]);
    ctx.stroke(platLines);
    ctx.setLineDash([]);
    ctx.lineWidth = lw / 2;
    ctx.strokeStyle = 'rgba(150,255,170,0.8)';
    ctx.stroke(net);
    ctx.fillStyle = '#ffd24a';
    ctx.fill(spikes);
    ctx.fillStyle = '#fff';
    for (const [px, py] of skulls) {
      SKULL.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'X') ctx.fillRect(px + 4 + i, py + 4 + j, 1, 1); }));
    }
  }

  // three spikes along a side of the tile at (px, py), pointing out of it: 0 top, 1 left, 2 right
  private spikeRow(p: Path2D, px: number, py: number, side: number): void {
    for (const o of [0, 5, 10]) {
      const a = o + 0.5, m = o + 3, b = o + 5.5; // along the side
      const pts = side === 0 ? [[a, 4], [m, 0], [b, 4]] : side === 1 ? [[4, a], [0, m], [4, b]] : [[12, a], [16, m], [12, b]];
      p.moveTo(px + pts[0][0], py + pts[0][1]);
      for (const [qx, qy] of pts.slice(1)) p.lineTo(px + qx, py + qy);
      p.closePath();
    }
  }

  // Water of a layer 3 tide (see App.tide): in the collision overlay the area Mario swims in is
  // blue (lighter where only at high tide); a tide that rises and falls gets dashed lines at its
  // highest and lowest water line
  paintTide(ctx: CanvasRenderingContext2D): void {
    const app = this.app, t = app.tide(), im = app.images;
    if (!t) return;
    if (app.show.collision) {
      ctx.fillStyle = 'rgba(60,140,255,0.18)';
      ctx.fillRect(0, t.high, im.width, t.low - t.high);
      ctx.fillStyle = 'rgba(60,140,255,0.35)';
      ctx.fillRect(0, t.low, im.width, im.height - t.low);
    }
    if (!t.moving || t.high === t.low) return;
    const lw = 1.5 / app.zoom;
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#7fc8ff';
    ctx.setLineDash([6 * lw, 4 * lw]);
    ctx.beginPath();
    for (const y of [t.high, t.low]) { ctx.moveTo(0, y); ctx.lineTo(im.width, y); }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `bold ${11 / app.zoom}px sans-serif`;
    const x0 = this.scroller.scrollLeft / app.zoom + 8 / app.zoom;
    for (const [y, txt] of [[t.high, 'Tide: highest water'], [t.low, 'Tide: lowest water']] as [number, string][]) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x0 - 2 / app.zoom, y - 14 / app.zoom, ctx.measureText(txt).width + 4 / app.zoom, 13 / app.zoom);
      ctx.fillStyle = '#7fc8ff';
      ctx.fillText(txt, x0, y - 4 / app.zoom);
    }
  }

  // translucent image of the item a block (visible part of layer 1) or sprite gives, drawn over it
  paintItems(ctx: CanvasRenderingContext2D): void {
    const app = this.app, g = app.images.geom1, w = app.render.wram, z = app.zoom;
    if (!app.show.layer1) return;
    const x0 = Math.max(0, Math.floor(this.scroller.scrollLeft / z / 16)), y0 = Math.max(0, Math.floor(this.scroller.scrollTop / z / 16));
    const x1 = Math.min(g.width, x0 + Math.ceil(this.scroller.clientWidth / z / 16) + 1);
    const y1 = Math.min(g.height, y0 + Math.ceil(this.scroller.clientHeight / z / 16) + 1);
    ctx.globalAlpha = 0.65;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const a = g.addr(x, y);
      if (a < 0) continue;
      const p = app.probes.block(map16Tile(w, a));
      if (!p) continue;
      if (p.summary !== null) this.drawItem(ctx, probeAt(p, x), x * 16, y * 16);
      if (p.enter) this.drawEnter(ctx, p.enter, x * 16, y * 16);
    }
    ctx.globalAlpha = 1;
  }

  // arrows for the directions a tile can be entered in (pipes, doors), white in the upper right
  // corner like the items; drawn as shapes, text glyphs blur at 16 px tiles
  drawEnter(ctx: CanvasRenderingContext2D, dirs: string, x: number, y: number): void {
    const a = ctx.globalAlpha, n = dirs.length, bx = x + 16 - n * 5 - 1;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, y, n * 5 + 1, 6);
    ctx.fillStyle = '#fff';
    [...dirs].forEach((d, i) => {
      const cx = bx + 3 + i * 5, cy = y + 3; // 4x4 triangle around (cx, cy)
      const pts = d === '↓' ? [[-2, -2], [2, -2], [0, 2]] : d === '↑' ? [[-2, 2], [2, 2], [0, -2]]
        : d === '←' ? [[2, -2], [2, 2], [-2, 0]] : [[-2, -2], [-2, 2], [2, 0]];
      ctx.beginPath();
      pts.forEach(([px, py], k) => (k ? ctx.lineTo(cx + px, cy + py) : ctx.moveTo(cx + px, cy + py)));
      ctx.fill();
    });
    ctx.globalAlpha = a;
  }

  // sprites are translucent like the ghosted layers while the background or layer 3 is edited
  spriteAlpha(): number {
    return this.app.show.ghost && isBrushMode(this.app.mode) ? 0.35 : 1;
  }

  // the same for sprites that give items (flying ? blocks …), drawn over the sprite images
  paintSpriteItems(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    ctx.globalAlpha = 0.65 * this.spriteAlpha();
    for (const s of app.level.sprites) {
      const p = app.probes.sprite(spriteId(s));
      if (p?.summary) this.drawItem(ctx, spriteProbeAt(p, s.x, s.y), s.x * 16, s.y * 16);
    }
    ctx.globalAlpha = 1;
  }

  // item of a probe result at pixel (x, y); a different item for big Mario at half size, upper right
  drawItem(ctx: CanvasRenderingContext2D, r: PosProbe, x: number, y: number): void {
    const thumbs = this.app.spriteThumbs;
    const small = r.small.sprites[0], big = r.big.sprites[0];
    const main = small ?? big ?? r.stomp?.sprites[0];
    const img = main !== undefined ? thumbs?.get(main) : undefined;
    if (!img) return;
    ctx.drawImage(img, x + Number(img.dataset.ox), y + Number(img.dataset.oy));
    const alt = big !== undefined && big !== main ? thumbs?.get(big) : undefined;
    if (alt) ctx.drawImage(alt, x + 8 + Number(alt.dataset.ox) / 2, y + Number(alt.dataset.oy) / 2, alt.width / 2, alt.height / 2);
  }

  // The placement preview: what a right click at tile (tx, ty) would place, translucent. While the one at the tile
  // is learned, the last one known moves along with the mouse.
  lastPreview: { tx: number; ty: number; parts: PreviewPart[] } | null = null;
  paintPreview(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    let parts = this.app.placementPreview(tx, ty), dx = 0, dy = 0;
    if (parts) this.lastPreview = { tx, ty, parts };
    else if (this.lastPreview) ({ parts } = this.lastPreview, dx = (tx - this.lastPreview.tx) * 16, dy = (ty - this.lastPreview.ty) * 16);
    if (!parts?.length) return;
    ctx.globalAlpha = 0.6;
    for (const p of parts) {
      if (p.img) ctx.drawImage(p.img, p.x + dx, p.y + dy);
      else { ctx.fillStyle = 'rgba(255,80,200,0.5)'; ctx.fillRect(p.x + dx, p.y + dy, 16, 16); }
    }
    ctx.globalAlpha = 1;
  }

  paintSprites(ctx: CanvasRenderingContext2D, z: number): void {
    const app = this.app;
    const active = app.mode === 'spr';
    ctx.font = `bold ${9 / app.zoom * 1.2}px monospace`;
    const incomplete = new Set(incompleteSprites(app)), a = this.spriteAlpha();
    ctx.globalAlpha = a;
    for (const s of app.level.sprites) {
      const x = s.x * 16, y = s.y * 16;
      const sel = app.selection.has(s.uid) && active;
      const img = app.spriteImageOf(s);
      if (img) {
        ctx.globalAlpha = (active ? 1 : 0.85) * a;
        ctx.drawImage(img, x + Number(img.dataset.ox), y + Number(img.dataset.oy));
        ctx.globalAlpha = a;
      }
      ctx.fillStyle = sel ? 'rgba(255,80,200,0.45)' : active ? 'rgba(255,80,200,0.22)' : 'rgba(255,80,200,0.12)';
      if (!img) ctx.fillRect(x, y, 16, 16);
      ctx.strokeStyle = sel ? '#ff50c8' : 'rgba(255,80,200,0.8)';
      ctx.lineWidth = (sel ? 2 : 1) / z;
      ctx.strokeRect(x, y, 16, 16);
      if (incomplete.has(s.uid)) { // drawn incompletely (sprite memory)
        ctx.strokeStyle = '#ffa020';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(x - 2 / z, y - 2 / z, 16 + 4 / z, 16 + 4 / z);
      }
      if (!img || sel || active) {
        ctx.fillStyle = '#fff';
        ctx.fillText(hex2(s.num), x + 1, y + 8);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------- interactions ----------------
  onDown(e: MouseEvent): void {
    const app = this.app;
    if (!app.images) return;
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    // ignore scrollbar clicks
    const rect = this.scroller.getBoundingClientRect();
    if (e.clientX - rect.left > this.scroller.clientWidth || e.clientY - rect.top > this.scroller.clientHeight) return;
    this.scroller.focus();
    const { tx, ty, px, py } = this.tileFromEvent(e);
    if (e.button === 1) return;
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey)) {
      // insert picked item (BG: paint with the brush, dragging keeps painting)
      if (app.mode === 'exit') { if (e.button === 2) this.exitMenu(e, px, py, tx, ty); return; }
      if (this.brushMode()) {
        const edit = app.mode === 'l3' ? app.beginLayer3Edit() : app.beginLevelEdit(), c = this.cellAt(px, py);
        this.drag = { kind: 'paint', edit, changed: this.paintCell(c.x, c.y), x0: c.x, y0: c.y, lastX: c.x, lastY: c.y };
        if (this.drag.changed) this.scheduleRefresh();
        return;
      }
      // on the selection, or with nothing to place: the context menu
      if (e.button === 2 && (this.onSelection(px, py) || !app.placement(tx, ty))) { this.levelMenu(e.clientX, e.clientY, px, py, tx, ty); return; }
      app.placeAt(tx, ty);
      return;
    }
    if (e.button !== 0) return;
    if (!e.ctrlKey && this.gameViewGrab(px, py)) {
      const p = this.gameViewPos();
      app.gameView = p;
      app.gameViewMario = null; // (placed by hand from here)
      this.drag = { kind: 'gameView', offX: px - p.x, offY: py - p.y };
      this.updateCursor(px, py, -1);
      this.paint();
      return;
    }
    const mk = this.markerAt(px, py);
    if (mk && !e.ctrlKey) {
      if (app.mode === 'exit') app.selectEntrance(mk);
      this.drag = { kind: 'marker', edit: mk.kind !== 'sec' ? app.beginLevelEdit() : null, marker: mk, offX: px - mk.x, offY: py - mk.y, moved: false };
      this.paint();
      return;
    }
    if (this.brushMode()) {
      // click takes the tile into the brush, dragging a rectangle of tiles
      const c = this.cellAt(px, py);
      this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
      this.paint();
      return;
    }
    if (app.mode === 'exit') {
      app.selectScreen(app.vertical ? ty >> 4 : tx >> 4);
      return;
    }
    // resize handle?
    const ho = this.handleAt(px, py);
    if (ho) {
      this.drag = { kind: 'resize', edit: app.beginLevelEdit(), startTx: tx, startTy: ty, origSize: new Map([[ho.uid, ho.size]]), lastDw: 0, lastDh: 0 };
      return;
    }
    const hits = app.hitsAt(px, py);
    if (e.ctrlKey) {
      // multi-select stays within the current layer
      const own = hits.find((h) => h.mode === app.mode);
      if (own) {
        const uid = own.item.uid;
        if (app.selection.has(uid)) app.selection.delete(uid); else app.selection.add(uid);
        app.stampSelection = true;
        app.emit('change');
        return;
      }
    }
    // plain click: an already selected item keeps priority (so selections can be dragged), else the topmost.
    // Alt+click: the next item below the selected one (wrapping around)
    const selIdx = hits.findIndex((h) => h.mode === app.mode && app.selection.has(h.item.uid));
    const hit = e.altKey ? hits[(selIdx + 1) % hits.length] : hits[Math.max(0, selIdx)];
    if (hit && !e.ctrlKey) {
      if (hit.mode !== app.mode) {
        app.setMode(hit.mode, [hit.item.uid]);
        toast(`Mode: ${hit.mode === 'spr' ? 'Sprites' : hit.mode === 'l2' ? 'Layer 2' : 'Layer 1'}`);
      }
      else if (!app.selection.has(hit.item.uid)) app.selection = new Set([hit.item.uid]);
      app.stampSelection = true;
      app.emit('change');
      const items = app.mode === 'spr' ? app.selectedSprites() : app.selectedObjects();
      this.drag = { kind: 'move', edit: app.beginLevelEdit(), startTx: tx, startTy: ty, lastDx: 0, lastDy: 0, orig: new Map(items.map((o) => [o.uid, { x: o.x, y: o.y }])) };
    } else {
      if (!e.ctrlKey) app.selection.clear();
      app.stampSelection = true;
      this.drag = { kind: 'band', x0: px, y0: py, x1: px, y1: py, add: e.ctrlKey, far: false };
      app.emit('change');
    }
  }

  onMove(e: MouseEvent): void {
    const app = this.app;
    if (!app.images) return;
    const { tx, ty, px, py } = this.tileFromEvent(e);
    const inside = e.target === this.scroller || e.target === this.canvas;
    if (inside || this.drag) {
      // sprite bodies are pixel-sized, so also repaint when the item under the cursor changes
      const top = app.hitsAt(px, py)[0]?.item.uid ?? -1;
      const cell = this.brushMode() ? this.cellAt(px, py) : null;
      const moved = !this.hover || this.hover.tx !== tx || this.hover.ty !== ty || this.hover.top !== top
        || (!!cell && (cell.x !== this.hover.cx || cell.y !== this.hover.cy));
      this.hover = { tx, ty, px, py, top, cx: cell?.x ?? tx, cy: cell?.y ?? ty };
      if (moved) {
        this.updateStatus(tx, ty);
        if (!(e.buttons & 4)) this.updateCursor(px, py, top); // middle button: panning sets its own cursor
        this.requestPaint();
      }
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'band') {
      d.x1 = px; d.y1 = py;
      d.far ||= Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3;
      this.requestPaint();
    } else if (d.kind === 'gameView') {
      app.gameView = gameViewAt(px - d.offX, py - d.offY, app.images.width, app.images.height, app.cameraReach());
      this.requestPaint();
    } else if (d.kind === 'paint') {
      const b = this.brush(), c = this.cellAt(px, py);
      const x = d.x0 + Math.floor((c.x - d.x0) / b.w) * b.w, y = d.y0 + Math.floor((c.y - d.y0) / b.h) * b.h;
      if (x === d.lastX && y === d.lastY) return;
      d.lastX = x; d.lastY = y;
      if (this.paintCell(x, y)) { d.changed = true; this.scheduleRefresh(); }
    } else if (d.kind === 'pick') {
      const c = this.cellAt(px, py);
      if (d.x1 !== c.x || d.y1 !== c.y) { d.x1 = c.x; d.y1 = c.y; this.requestPaint(); }
    } else if (d.kind === 'marker') {
      if (app.moveMarker(d.marker, px - d.offX, py - d.offY)) {
        d.moved = true;
        if (d.marker.kind !== 'sec') app.changed(false); // (a secondary entrance is a ROM edit, shown by its follow-up)
      }
    } else if (d.kind === 'move') {
      const dx = tx - d.startTx, dy = ty - d.startTy;
      if (dx === d.lastDx && dy === d.lastDy) return;
      d.lastDx = dx; d.lastDy = dy;
      const items = app.mode === 'spr' ? app.selectedSprites() : app.selectedObjects();
      for (const o of items) {
        const or = d.orig.get(o.uid);
        if (!or) continue;
        o.x = or.x + dx; o.y = or.y + dy;
        app.clampObject(o);
      }
      if (app.mode === 'spr') app.changed(false);
      else this.scheduleRefresh();
    } else if (d.kind === 'resize') {
      const dw = tx - d.startTx, dh = ty - d.startTy;
      if (dw === d.lastDw && dh === d.lastDh) return;
      d.lastDw = dw; d.lastDh = dh;
      for (const o of app.selectedObjects()) {
        const s0 = d.origSize.get(o.uid);
        if (s0 === undefined) continue;
        o.size = resizeObjectSize(app.objectKind(o.num), s0, dw, dh);
      }
      this.scheduleRefresh();
    }
  }

  refreshTimer = 0;
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = requestAnimationFrame(() => {
      this.refreshTimer = 0;
      this.app.changed();
    });
  }

  onUp(_e: MouseEvent): void {
    const app = this.app;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.hover) this.updateCursor(this.hover.px, this.hover.py, this.hover.top);
    if (d.kind === 'paint') {
      if (d.changed) d.edit.commit(); else d.edit.cancel();
      return;
    }
    if (d.kind === 'gameView') { this.paint(); return; }
    if (d.kind === 'pick') {
      if (app.mode === 'l3') app.pickL3(d.x0, d.y0, d.x1, d.y1); else app.pickBg(d.x0, d.y0, d.x1, d.y1);
      if (this.hover) this.updateStatus(this.hover.tx, this.hover.ty);
      this.paint();
      return;
    }
    if (d.kind === 'marker') {
      if (!d.edit) { this.paint(); return; }
      if (!d.moved) { d.edit.cancel(); this.paint(); return; }
      d.edit.commit();
      return;
    }
    if (d.kind === 'band') {
      const x0 = Math.floor(Math.min(d.x0, d.x1) / 16), x1 = Math.floor(Math.max(d.x0, d.x1) / 16);
      const y0 = Math.floor(Math.min(d.y0, d.y1) / 16), y1 = Math.floor(Math.max(d.y0, d.y1) / 16);
      if (app.mode === 'spr') {
        const bx0 = Math.min(d.x0, d.x1), bx1 = Math.max(d.x0, d.x1), by0 = Math.min(d.y0, d.y1), by1 = Math.max(d.y0, d.y1);
        for (const s of app.level.sprites) {
          const b = app.spriteBox(s);
          if (b.x0 <= bx1 && b.x1 > bx0 && b.y0 <= by1 && b.y1 > by0) app.selection.add(s.uid);
        }
      } else if (d.far) {
        // an object is caught by its tiles (its outline), not its bounding box: slopes reach far diagonally
        for (const o of app.currentObjects()) {
          const hit = app.objectTiles(o).some(t => {
            const x = t & 0xffff, y = t >> 16;
            return x >= x0 && x <= x1 && y >= y0 && y <= y1;
          });
          if (hit) app.selection.add(o.uid);
        }
      }
      // a click into nothing (no item of any shown layer there): nothing placed by a right click any more
      if (!d.far && !d.add) app.clearPickedItem();
      app.emit('change');
      return;
    }
    if (d.kind === 'move') { if (d.lastDx || d.lastDy) d.edit.commit(); else d.edit.cancel(); return; }
    if (d.kind === 'resize') { if (d.lastDw || d.lastDh) d.edit.commit(); else d.edit.cancel(); return; }
  }

  // Esc while dragging: the drag undone (moving, resizing, painting, a level entrance) or dropped (a selection
  // box, picking tiles, the game view frame); false when there is none to cancel (moving a secondary entrance)
  cancelDrag(): boolean {
    const d = this.drag;
    if (!d || (d.kind === 'marker' && !d.edit)) return false;
    this.drag = null;
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'paint' || d.kind === 'marker') d.edit?.cancel(true);
    if (this.hover) this.updateCursor(this.hover.px, this.hover.py, this.hover.top);
    this.paint();
    return true;
  }

  // the context menu by the keyboard: at the mouse when it is over the level, else at the selection (its first
  // item) or the middle of the view
  keyMenu(): void {
    const app = this.app;
    if (app.mode !== 'l1' && app.mode !== 'l2' && app.mode !== 'spr') return;
    let px: number, py: number;
    if (this.hover) ({ px, py } = this.hover);
    else {
      const it = (app.mode === 'spr' ? app.selectedSprites() : app.selectedObjects())[0], c = this.centerTile();
      px = (it ? it.x : c.tx) * 16 + 8; py = (it ? it.y : c.ty) * 16 + 8;
    }
    const r = this.scroller.getBoundingClientRect(), z = app.zoom;
    this.levelMenu(r.left + px * z - this.scroller.scrollLeft, r.top + py * z - this.scroller.scrollTop, px, py, Math.floor(px / 16), Math.floor(py / 16));
  }

  // status bar without the mouse over the level: what the mouse does in this mode
  idleStatus(): void {
    const m = this.app.mode;
    this.pos.textContent = '';
    this.status.textContent = isBrushMode(m) ? 'Click/drag picks up tiles as brush · Right click/Shift+click paints'
      : m === 'exit' ? 'Click an entrance (M, Z, S) or screen to select it – edit it on the right under “Properties” · Drag moves entrances · Right click: new entrance, create exit …'
        : 'Click selects, drag moves, click into nothing deselects all · Right click/Shift+click places the item chosen in “Insert”, else opens the menu · Alt+click: item underneath';
  }

  updateStatus(tx: number, ty: number): void {
    const app = this.app;
    const g = app.images.geom1;
    this.pos.textContent = `X ${hex3(tx)}  Y ${hex3(ty)}  Screen ${hex2(app.vertical ? ty >> 4 : tx >> 4)}`;
    if (app.mode === 'l3') {
      const c = this.hover ? this.cellAt(this.hover.px, this.hover.py) : { x: 0, y: 0 }, t = app.l3At(c.x, c.y), b = app.l3Brush;
      const tile = layer3WordText;
      this.status.textContent = `${t < 0 ? 'Status bar (not editable)' : `Layer 3 tile ${tile(t)}${app.l3Editable(c.x, c.y) ? '' : ' (outside the level\'s layer 3 tilemap file)'}`}  ·  Brush ${b.tiles.length > 1 ? `${b.w}×${b.h}` : tile(b.tiles[0])}`;
      return;
    }
    let txt = '';
    const a = g.addr(tx, ty);
    if (a >= 0) {
      const t = map16Tile(app.render.wram, a);
      txt += `Map16 ${hex3(t)}`;
      const p = app.mode === 'bg' ? undefined : app.probes.block(t); // result arrives via 'probes'
      const sum = [p && probeAt(p, tx).summary, p && enterText(p.enter)].filter(Boolean).join(', ');
      if (sum) txt += ` (${sum})`;
      const c = app.show.collision && app.mode !== 'bg' ? app.probes.collision(t) : undefined;
      if (c) txt += ` · ${collisionText(c)}`;
      const tide = app.show.collision && app.mode !== 'bg' ? app.tide() : null;
      if (tide && ty * 16 + 8 >= tide.high) txt += ty * 16 + 8 >= tide.low ? ' · water (tide)' : ' · water at high tide';
    }
    if (app.mode === 'bg') {
      const b = app.bgBrush;
      txt += `  ·  BG-Tile ${hex3(app.bgAt(tx, ty))}  ·  Brush ${b.tiles.length > 1 ? `${b.w}×${b.h}` : hex3(b.tiles[0])}`;
      this.status.textContent = txt.replace(/^\s*·\s*/, '');
      return;
    }
    const died = app.show.deaths ? this.deathsAt().get(`${tx},${ty}`) : undefined;
    if (died) {
      const by = new Map<string, number>();
      for (const d of died.marks) { const t = killerText(d.killer, (id) => app.spriteLabel(id)); by.set(t, (by.get(t) ?? 0) + 1); }
      const now = levelVersion(app.rom, app.level.number), old = died.marks.filter((d) => d.version !== now).length;
      txt += `  · Mario died here${died.marks.length > 1 ? ` ${died.marks.length}×` : ''}${old ? ` (${old === died.marks.length ? 'all' : old} before the level was last changed)` : ''}: killed by ${[...by].map(([t, n]) => (n > 1 ? `${t} (${n}×)` : t)).join(', ')}`;
    }
    const mk = this.hover ? this.markerAt(this.hover.px, this.hover.py) : null;
    if (mk) txt += `  · ${MARKER_STYLE[mk.kind].title}${mk.kind === 'sec' ? ' ' + hex3(mk.index) : ''} (drag to move)`;
    const hits = app.hitsAt(this.hover?.px ?? tx * 16, this.hover?.py ?? ty * 16);
    for (const { mode, item } of hits) {
      const tag = hits.length > 1 ? (mode === 'spr' ? '' : mode === 'l1' ? ' (Layer 1)' : ' (Layer 2)') : '';
      if (mode === 'spr') {
        const s = item as LevelSprite;
        const p = app.probes.sprite(spriteId(s));
        const sum = p && spriteProbeAt(p, s.x, s.y).summary;
        txt += `  · ${s.extra >= 2 ? 'Custom Sprite' : 'Sprite'} ${hex2(s.num)} ${app.spriteLabel(spriteId(s))}${sum ? ` (${sum})` : ''}`;
      }
      else { const o = item as LevelObject; txt += `  · ${o.num ? 'Object ' + hex2(o.num) : 'Ext. object ' + hex2(o.ext)}${tag} ${app.objectName(o.num, o.ext)}${o.num ? ' size ' + hex2(o.size) : ''}`; }
    }
    this.status.textContent = txt.replace(/^\s*·\s*/, '');
  }

  // the resize handle stays ~8 screen pixels at any zoom
  handleSize(): number {
    return Math.max(5, 8 / this.app.zoom);
  }
  // the selected object whose resize handle is at the pixel
  handleAt(px: number, py: number): LevelObject | null {
    const app = this.app;
    if ((app.mode !== 'l1' && app.mode !== 'l2') || app.selection.size !== 1) return null;
    const o = app.selectedObjects()[0];
    if (!o || (o.num === 0 && o.ext !== 2)) return null;
    const b = app.objectBounds(o), hs = this.handleSize();
    const hx = b.x1 * 16 + 11, hy = b.y1 * 16 + 11;
    return px >= hx - 2 && px <= hx + hs + 2 && py >= hy - 2 && py <= hy + hs + 2 ? o : null;
  }
  // what a click would do, shown by the cursor
  updateCursor(px: number, py: number, top: number): void {
    const app = this.app, d = this.drag;
    let c = '';
    if (d?.kind === 'resize') c = 'nwse-resize';
    else if (d?.kind === 'marker' || d?.kind === 'move' || d?.kind === 'gameView') c = 'grabbing';
    else if (this.gameViewGrab(px, py)) c = 'grab';
    else if (this.brushMode()) c = 'crosshair';
    else if (this.markerAt(px, py)) c = 'grab';
    else if (app.mode === 'exit') c = 'pointer';
    else if (this.handleAt(px, py)) c = 'nwse-resize';
    else if (top >= 0 && app.selection.has(top)) c = 'move';
    this.scroller.style.cursor = c;
  }

  // whether the pixel is on a selected item of the current mode
  onSelection(px: number, py: number): boolean {
    return this.app.hitsAt(px, py).some((h) => h.mode === this.app.mode && this.app.selection.has(h.item.uid));
  }

  // The context menu of layer 1/2 and sprites at the pixel (client position x, y): of the selection when on it –
  // an item there not selected is selected first, as by a click – else of the spot (paste, insert, the screen)
  levelMenu(x: number, y: number, px: number, py: number, tx: number, ty: number): void {
    const app = this.app;
    if (!this.onSelection(px, py)) {
      const hit = app.hitsAt(px, py)[0];
      if (hit) {
        if (hit.mode !== app.mode) app.setMode(hit.mode, [hit.item.uid]);
        else app.selection = new Set([hit.item.uid]);
        app.stampSelection = true;
        app.emit('change');
      } else if (app.selection.size) { app.selection.clear(); app.emit('change'); }
    }
    const spr = app.mode === 'spr';
    const items: MenuItem[] = [];
    if (app.selection.size) {
      const objs = app.selectedObjects(), sprs = app.selectedSprites(), n = spr ? sprs.length : objs.length;
      const one = spr ? sprs[0] : objs[0];
      items.push({ heading: n > 1 ? `${n} ${spr ? 'sprites' : 'objects'}` : spr ? `Sprite ${hex2(one.num)} ${app.spriteLabel(spriteId(one as LevelSprite))}` : app.objectName(one.num, (one as LevelObject).ext) },
        { label: 'Cut', onClick: () => { app.copy(); app.deleteSelection(); } },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => app.copy() },
        { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: () => app.duplicateSelection() },
        { label: 'Delete', shortcut: 'Del', onClick: () => app.deleteSelection() });
      if (!spr) items.push('sep',
        { label: 'Bring to front', shortcut: 'PgUp', title: 'Drawn after all other objects', onClick: () => app.reorderSelection('front') },
        { label: 'Send to back', shortcut: 'PgDn', title: 'Drawn before all other objects', onClick: () => app.reorderSelection('back') },
        // a placed prefab alone is one already: it can only be broken up
        'sep', n === 1 && isPlacedPrefab(one as LevelObject)
          ? { label: 'Break up', title: 'Replace the prefab here with the objects it was made from, or single Direct Map16 objects where those would look different (to edit it, then “Save as prefab …” again)', onClick: () => app.explodePrefab(one as LevelObject) }
          : { label: 'Save as prefab …', onClick: () => openSavePrefab(app) });
      items.push('sep', { label: 'Properties', onClick: () => app.emit('properties') });
    } else {
      const clip = spr ? app.clipboard.sprites : app.clipboard.objects;
      items.push(
        { label: 'Paste here', shortcut: 'Ctrl+V', disabled: () => !clip?.length, onClick: () => app.paste(tx, ty) },
        { label: 'Insert by number …', shortcut: 'I', onClick: () => openInsertDialog(app, tx, ty) },
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => { app.selection = new Set((spr ? app.level.sprites : app.currentObjects()).map((o) => o.uid)); app.emit('change'); } });
      const scr = app.vertical ? ty >> 4 : tx >> 4;
      items.push(...this.exitItems(px, py, tx, ty, true),
        { label: 'Insert screen here …', disabled: () => app.level.header.screens >= 32, onClick: () => openScreenDialog(app, 'insert', scr) },
        { label: 'Delete screen …', disabled: () => app.level.header.screens <= 1, onClick: () => openScreenDialog(app, 'delete', scr) });
    }
    contextMenu(x, y, items);
  }

  // right click in mode 'exit': entrances and the screen's exit at the mouse
  exitMenu(e: MouseEvent, px: number, py: number, tx: number, ty: number): void {
    contextMenu(e.clientX, e.clientY, this.exitItems(px, py, tx, ty));
  }
  // the entrances and the screen's exit at the pixel; toExits: they switch to mode 'exit' first (from another mode)
  exitItems(px: number, py: number, tx: number, ty: number, toExits = false): MenuItem[] {
    const app = this.app;
    const scr = app.vertical ? ty >> 4 : tx >> 4;
    const ex = app.level.exits.find((x) => x.screen === scr);
    const mk = this.markerAt(px, py);
    // marker positions are Mario's top-left, the circle is drawn at his feet
    const mx = px - 8, my = py - 24;
    const items: MenuItem[] = [
      { heading: 'Entrances' },
      { label: 'New secondary entrance here', title: 'Creates an entrance with a free number that exits of other levels can point to', onClick: () => { app.newSecondaryEntrance(mx, my); } },
      { label: 'Main entrance here', onClick: () => app.placeEntrance('main', mx, my) },
      { label: 'Midway point here', title: 'Gives the midway point its own position (Lunar Magic\'s midway entrance)', onClick: () => app.placeEntrance('midway', mx, my) },
    ];
    if (mk?.kind === 'sec') items.push({ label: `Remove entrance ${hex3(mk.index)}`, onClick: () => app.removeSecondaryEntrance(mk.index) });
    items.push({ heading: `Screen ${hex2(scr)}` });
    if (ex) {
      items.push({ label: 'Edit exit', onClick: () => app.selectScreen(scr) });
      items.push({ label: '→ Open exit target', onClick: () => app.gotoExitTarget(ex) });
    } else {
      items.push({ label: 'Create exit', onClick: () => { app.selectScreen(scr); app.editLevel(() => { app.level.exits.push({ uid: newUid(), screen: scr, dest: app.level.number, secondary: false, flags: EXIT_NEW }); }, false); } });
    }
    if (toExits) for (const it of items) if (typeof it === 'object' && 'onClick' in it) { const f = it.onClick; it.onClick = () => { if (app.mode !== 'exit') app.setMode('exit'); f(); }; }
    return items;
  }

  // topmost marker whose circle contains the pixel
  markerAt(px: number, py: number): Marker | null {
    const ms = this.app.markers();
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if ((px - m.x - 8) ** 2 + (py - m.y - 24) ** 2 <= 49) return m;
    }
    return null;
  }

  // object/sprite counts and data sizes; the sprite load table ($1938) holds 128 entries
  updateStats(): void {
    const app = this.app, lv = app.level;
    if (!lv) return;
    const l1 = serializeLayer1(app.rom, lv).length, l2 = serializeLayer2(app.rom, lv)?.length;
    const spr = serializeLevelSprites(app.rom, lv).length;
    const parts = [`Objects ${lv.objects.length}${lv.layer2Objects ? ' / L2 ' + lv.layer2Objects.length : ''}`, `Sprites ${lv.sprites.length}`,
      `Data: L1 ${l1}${l2 !== undefined ? ` · L2 ${l2}` : ''} · sprites ${spr} bytes`];
    this.stats.textContent = parts.join('  ·  ');
    const over = lv.sprites.length > 128;
    this.stats.classList.toggle('warn', over);
    this.stats.title = over ? 'More than 128 sprites: the game only loads the first 128.' : '';
    this.problems.update();
  }

  // selects the sprites (sprite mode) and scrolls to the first
  revealSprites(uids: number[]): void {
    const app = this.app;
    const first = app.level.sprites.find((s) => s.uid === uids[0]);
    app.setMode('spr', uids);
    if (first) this.scrollToTile(first.x, first.y);
    this.paint();
  }

  // visible layers + sprites at 1:1 as PNG
  exportPng(): void {
    const app = this.app, im = app.images;
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const ctx = c.getContext('2d')!;
    const px = composite(im, app.show.layer1, app.show.layer2, 0, app.show.layer3); // without ghosting
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), im.width, im.height), 0, 0);
    if (app.show.sprites) for (const s of app.level.sprites) {
      const img = app.spriteImageOf(s);
      if (img) ctx.drawImage(img, s.x * 16 + Number(img.dataset.ox), s.y * 16 + Number(img.dataset.oy));
    }
    c.toBlob(async (b) => {
      if (b) downloadBytes(`level-${hex3(app.level.number)}.png`, new Uint8Array(await b.arrayBuffer()), 'image/png');
    }, 'image/png');
  }

  centerTile(): { tx: number; ty: number } {
    const z = this.app.zoom;
    return {
      tx: Math.floor((this.scroller.scrollLeft + this.scroller.clientWidth / 2) / z / 16),
      ty: Math.floor((this.scroller.scrollTop + this.scroller.clientHeight / 2) / z / 16),
    };
  }

  scrollToTile(tx: number, ty: number): void {
    const z = this.app.zoom;
    this.scroller.scrollLeft = tx * 16 * z - this.scroller.clientWidth / 2;
    this.scroller.scrollTop = ty * 16 * z - this.scroller.clientHeight / 2;
  }
}
