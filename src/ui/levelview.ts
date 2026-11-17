// Scrollable, zoomable level canvas with editing interactions.

import { App, isBrushMode, type Marker, type LevelEdit, type Brush, type PreviewPart } from './app.ts';
import { h, attachPanZoom, toast } from './dom.ts';
import { BrushDrag, drawBrushFrame } from './brushsurface.ts';
import { paintOverlays, openOverlay, boxLayers, deathsAt, gameViewLabelBox, gameViewIn, BAND_STYLE, type SpriteDraw, MARKER_STYLE, type GameViewFrame, ARC_STYLE, type ArcsDraw } from './leveloverlays.ts';
import { hex2, hex3 } from '../core/names.ts';
import type { PixelRect } from '../core/render.ts';
import { type Grab } from '../core/objresize.ts';
import type { MoveDrag, ResizeDrag } from '../core/levelmodel.ts';
import { probeAt, spriteProbeAt, enterText, collisionText, collisionIn, switchText, SWITCH_STATES, SWITCH_NAME } from '../core/blockprobe.ts';
import { type LevelObject, type LevelSprite, newUid, serializeLayer1, serializeLayer2, serializeLevelSprites, spriteSizes, spriteId, EXIT_NEW } from '../core/level.ts';
import { layer3CellAt, layer3WordText } from '../core/layer3map.ts';
import { contextMenu, type MenuItem } from './menu.ts';
import { isPlacedPrefab, openSavePrefab } from './panels.ts';
import { openInsertDialog, openScreenDialog } from './tools.ts';
import { incompleteSprites, leftOutSprites } from './spritemem.ts';
import { problemsButton } from './problems.ts';
import { spriteOpens, messageOfBox, messageLabel, showMessageHover, hideMessageHover } from './messagepanel.ts';
import { GAME_VIEW_W, GAME_VIEW_H, MARIO_H } from '../core/camerabands.ts';
import { gameViewAt } from '../core/camerareach.ts';
import { paintBoxName } from './objbox.ts';
import { projectId } from '../core/projectid.ts';
import { loadDeaths, killerText, levelVersion, type DeathMark } from './deathmarks.ts';
import { MARK, onTokensChanged, rgba, uiToken } from './marks.ts';

type Drag =
  | { kind: 'move'; move: MoveDrag; startTx: number; startTy: number } // the selection (levelmodel.ts)
  | { kind: 'resize'; resize: ResizeDrag } // the selected objects by a handle (levelmodel.ts)
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean; far: boolean } // far: dragged, not a click
  | { kind: 'marker'; edit: LevelEdit | null; marker: Marker; offX: number; offY: number; moved: boolean } // (secondary entrances: not a level edit)
  | { kind: 'brush' } // BG/layer 3: a stroke or a pick (brushDrag)
  | { kind: 'gameView'; offX: number; offY: number }; // the game view frame, held at (offX, offY) inside it

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
  // BG and layer 3 painted with a brush (brushsurface.ts, ADR 0011); a stroke is one level edit
  private stroke: { edit: LevelEdit; changed: boolean } | null = null;
  private brushDrag = new BrushDrag({
    brush: () => this.brush(),
    stamp: (x, y) => this.paintCell(x, y),
    changed: () => { if (this.stroke) this.stroke.changed = true; this.scheduleRefresh(); },
    end: () => { const s = this.stroke; this.stroke = null; if (s?.changed) s.edit.commit(); else s?.edit.cancel(); },
    cancel: () => { this.stroke?.edit.cancel(true); this.stroke = null; },
    pick: (r) => {
      const app = this.app;
      if (app.model.mode === 'l3') app.pickL3(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1); else app.pickBg(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1);
      if (this.hover) this.updateStatus(this.hover.tx, this.hover.ty);
    },
  });
  status: HTMLSpanElement;
  stats: HTMLSpanElement;
  problems: ReturnType<typeof problemsButton>;
  pos: HTMLSpanElement;
  pendingFrame = 0;
  // the level image on levelCanvas is not the one to show: it changed while the view was out of the page (another
  // workspace shown, #504); given to the canvas whole with the next paint in the page
  private imageStale = false;
  arcPin: { tx: number; ty: number } | null = null; // jump arcs stay at this tile instead of following the mouse

  constructor(app: App, statusBar: HTMLDivElement) {
    onTokensChanged(() => this.paint()); // (the backdrop is a UI token: another theme)
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
    attachPanZoom(this.scroller, () => this.app.view.zoom, (z, ax, ay) => this.setZoom(z, { ax, ay }));
    this.scroller.addEventListener('mouseleave', () => { this.hover = null; this.idleStatus(); this.paint(); hideMessageHover(); });
    // a message box sprite: the panel on the message it opens
    this.scroller.addEventListener('dblclick', (e) => {
      const s = this.messageSpriteAt(e), m = s ? spriteOpens(app, s) : 0;
      if (!m) return;
      const t = messageOfBox(app, m);
      hideMessageHover();
      app.openMessages(t.translevel, t.msg);
    });
    app.on('render', () => { this.updateLevelImage(); this.updateStats(); });
    app.on('anim-frame', () => this.showAnimFrame());
    // (painted once per display frame: a drag step renders and changes, the mouse moves, #452)
    app.on('change', () => { this.requestPaint(); this.updateStats(); });
    app.on('reveal', () => this.scrollToTile(app.reveal.x >> 4, app.reveal.y >> 4));
    app.on('sprites', () => this.requestPaint());
    app.on('sprite-mem', () => { this.requestPaint(); this.updateStats(); });
    app.on('mode', () => { if (!this.hover) this.idleStatus(); });
    app.on('rom-change', () => this.updateProblems());
    app.on('message-routine', () => this.updateProblems());
    app.on('arcs', () => this.requestPaint());
    app.on('sizes', () => {
      // (a resize that started before the sizes were known: its objects' drivers as emulated from now on, the edges
      // grabbed those the grabbed object's drivers move)
      const d = this.drag;
      if (d?.kind === 'resize') d.resize.learned();
      this.requestPaint();
      if (this.hover) this.updateCursor(this.hover.px, this.hover.py, this.hover.top);
    });
    app.on('placement-preview', () => this.requestPaint());
    app.on('picked-item', () => { this.lastPreview = null; this.requestPaint(); });
    app.on('game-view', () => this.requestPaint());
    app.on('level-scan', () => { this.updateProblems(); this.requestPaint(); });
    this.idleStatus();
    app.on('probes', () => { if (this.hover && !this.drag) this.updateStatus(this.hover.tx, this.hover.ty); this.requestPaint(); this.updateProblems(); });
  }

  setZoom(z: number, anchor?: { ax: number; ay: number }): void {
    z = Math.max(0.5, Math.min(4, z));
    const old = this.app.view.zoom;
    if (z === old) return;
    const rect = this.scroller.getBoundingClientRect();
    const ax = anchor ? anchor.ax : rect.width / 2;
    const ay = anchor ? anchor.ay : rect.height / 2;
    const lx = (this.scroller.scrollLeft + ax) / old, ly = (this.scroller.scrollTop + ay) / old;
    this.app.view.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.paint();
    this.app.emit('zoom');
  }

  // the level image (App.compositeImg) is another one: given to levelCanvas whole – once the view is in the page
  // again when it is not (another workspace shown: no upload for a picture nobody sees)
  updateLevelImage(relayout = true): void {
    if (this.root.isConnected) this.putLevelImage(null); else this.imageStale = true;
    if (relayout) this.layout(); else this.requestPaint();
  }

  // the animation's next step (or its stop): only the rectangles it changed given to levelCanvas (App.animChanged),
  // nothing while the view is out of the page – the picture as it is then is shown whole once it is back
  private showAnimFrame(): void {
    if (!this.root.isConnected) { this.imageStale = true; return; }
    const rects = this.imageStale ? null : this.app.animChanged;
    if (rects && !rects.length) return;
    this.putLevelImage(rects);
    this.requestPaint();
  }

  // App.compositeImg on levelCanvas: whole, or only its rectangles `rects` (the rest is on it already)
  private putLevelImage(rects: PixelRect[] | null): void {
    const im = this.app.images;
    if (this.levelCanvas.width !== im.width || this.levelCanvas.height !== im.height) {
      this.levelCanvas.width = im.width;
      this.levelCanvas.height = im.height;
      rects = null;
    }
    const lctx = this.levelCanvas.getContext('2d')!;
    // putImageData copies the pixels: the image is only viewed, not copied first
    const c = this.app.compositeImg;
    const id = new ImageData(new Uint8ClampedArray(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength), im.width, im.height);
    if (rects) for (const r of rects) lctx.putImageData(id, 0, 0, r.x, r.y, r.w, r.h);
    else lctx.putImageData(id, 0, 0);
    if (!rects) this.imageStale = false;
  }

  // the scroll area sized to the level, the canvas to the view: painted at once when that cleared it (its size
  // changed), else with the next display frame
  layout(): void {
    const im = this.app.images;
    if (!im) return;
    const z = this.app.view.zoom;
    const sw = `${im.width * z}px`, sh = `${im.height * z}px`;
    if (this.sizer.style.width !== sw) this.sizer.style.width = sw;
    if (this.sizer.style.height !== sh) this.sizer.style.height = sh;
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hh = this.scroller.clientHeight;
    const cw = Math.floor(w * dpr), ch = Math.floor(hh * dpr);
    if (this.canvas.style.width !== `${w}px`) this.canvas.style.width = `${w}px`;
    if (this.canvas.style.height !== `${hh}px`) this.canvas.style.height = `${hh}px`;
    if (this.canvas.width === cw && this.canvas.height === ch) { this.requestPaint(); return; }
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.paint();
  }

  // painted with the next display frame (once, however often asked before; a drag step's refresh due then paints)
  requestPaint(): void {
    if (this.pendingFrame || this.refreshTimer) return;
    this.pendingFrame = requestAnimationFrame(() => { this.pendingFrame = 0; this.paint(); });
  }

  // BG and layer 3 are painted with a brush on a grid of cells: BG tiles (16 px), layer 3's 8x8 tiles where
  // layer 3 is drawn (layer3map.ts)
  brushMode(): boolean {
    return isBrushMode(this.app.model.mode);
  }
  cellAt(px: number, py: number): { x: number; y: number } {
    if (this.app.model.mode !== 'l3') return { x: Math.floor(px / 16), y: Math.floor(py / 16) };
    const c = layer3CellAt(this.app.l3Grid(), px, py);
    return { x: c.cx, y: c.cy };
  }
  // the pixel rectangle of w x h cells from (x, y)
  cellBox(x: number, y: number, w: number, h: number): [number, number, number, number] {
    if (this.app.model.mode !== 'l3') return [x * 16, y * 16, w * 16, h * 16];
    const g = this.app.l3Grid();
    return [x * 8 - g.dx, y * 8 - g.dy, w * 8, h * 8];
  }
  brush(): Brush {
    return this.app.model.mode === 'l3' ? this.app.l3Brush : this.app.bgBrush;
  }
  paintCell(x: number, y: number): boolean {
    return this.app.model.mode === 'l3' ? this.app.paintL3Brush(x, y) : this.app.paintBrush(x, y);
  }
  // the largest brush picked from the level
  brushMax(): { w: number; h: number } {
    return this.app.model.mode === 'l3' ? { w: 32, h: 32 } : { w: 32, h: 27 };
  }

  // the sprite under the mouse, when it is one
  messageSpriteAt(e: MouseEvent): LevelSprite | null {
    const { px, py } = this.tileFromEvent(e);
    return (this.app.hitsAt(px, py).find((x) => x.mode === 'spr')?.item as LevelSprite | undefined) ?? null;
  }
  // a message box sprite under the mouse: the message it opens beside it
  hoverMessage(e: MouseEvent): void {
    const s = this.drag || e.buttons ? null : this.messageSpriteAt(e), m = s ? spriteOpens(this.app, s) : 0;
    if (!m) { hideMessageHover(); return; }
    const t = messageOfBox(this.app, m);
    showMessageHover(this.app, e, t.translevel, t.msg, `Opens ${messageLabel(t.translevel, t.msg).replace(/^M/, 'm')}`);
  }

  tileFromEvent(e: MouseEvent): { tx: number; ty: number; px: number; py: number } {
    const rect = this.scroller.getBoundingClientRect();
    const z = this.app.view.zoom;
    const px = (e.clientX - rect.left + this.scroller.scrollLeft) / z;
    const py = (e.clientY - rect.top + this.scroller.scrollTop) / z;
    return { tx: Math.floor(px / 16), ty: Math.floor(py / 16), px, py };
  }

  // ---------------- painting ----------------
  // painted now (a paint requested for the next display frame is then not needed)
  paint(): void {
    const app = this.app;
    if (!app.images) return;
    if (this.pendingFrame) { cancelAnimationFrame(this.pendingFrame); this.pendingFrame = 0; }
    // (back in the page: the level image as it is now, changed meanwhile)
    if (this.imageStale && this.root.isConnected) this.putLevelImage(null);
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const z = app.view.zoom * dpr;
    const sx = this.scroller.scrollLeft * dpr, sy = this.scroller.scrollTop * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = uiToken('--canvas-bg', '#15171b');
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(z, 0, 0, z, -sx, -sy);
    ctx.drawImage(this.levelCanvas, 0, 0);
    const im = app.images;
    const lw = 1 / z;
    const choosing = app.model.mode === 'exit' && !app.exitMarker;
    paintOverlays(ctx, app, openOverlay(app), {
      show: app.view.show, lw, px: 1 / app.view.zoom, area: this.visibleTiles(), width: im.width, height: im.height, screens: app.level.header.screens,
      exits: app.view.show.exits || app.model.mode === 'exit', chosenExit: choosing ? app.exitScreen : -1,
      marker: (m) => ({
        big: this.drag?.kind === 'marker' && this.drag.marker.kind === m.kind && this.drag.marker.index === m.index,
        ring: app.model.mode === 'exit' && app.exitMarker?.kind === m.kind && app.exitMarker.index === m.index,
      }),
      layer2: app.model.mode === 'l2', tideLabelX: this.scroller.scrollLeft / app.view.zoom + 8 / app.view.zoom, spriteAlpha: this.spriteAlpha(),
      sprites: this.spriteDraw(), arcs: app.view.show.arcs ? this.arcsDraw() : undefined, gameView: app.view.show.gameView ? this.gameViewFrame() : undefined,
    });
    // selection
    if (app.model.mode === 'l1' || app.model.mode === 'l2') {
      const sel = app.model.selectedObjects();
      for (const o of sel) this.outlineObject(ctx, o, MARK.select, lw);
      for (const o of this.handleObjects()) this.paintHandles(ctx, o, lw);
    }
    // hover
    if (this.hover && !this.drag) {
      const { tx, ty } = this.hover;
      if (app.view.show.preview && !this.onSelection(this.hover.px, this.hover.py)) this.paintPreview(ctx, tx, ty);
      const hits = this.brushMode() ? [] : app.hitsAt(this.hover.px, this.hover.py);
      const hit = hits.find((h) => h.mode === app.model.mode && app.model.selection.has(h.item.uid)) ?? hits[0];
      if (hit && !app.model.selection.has(hit.item.uid)) {
        if (hit.mode === 'spr') {
          const b = app.spriteBox(hit.item as LevelSprite);
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 2 * lw;
          ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        } else this.outlineObject(ctx, hit.item as LevelObject, 'rgba(255,255,255,0.7)', lw);
      }
      // BG and layer 3: the area the brush would paint
      if (this.brushMode()) {
        const r = this.brushDrag.hoverFrame(this.cellAt(this.hover.px, this.hover.py));
        drawBrushFrame(ctx, 'hover', this.cellBox(r.x, r.y, r.w, r.h), lw);
      } else {
        ctx.strokeStyle = 'rgba(255,255,0,0.9)';
        ctx.lineWidth = lw;
        ctx.strokeRect(tx * 16, ty * 16, 16, 16);
      }
    }
    this.paintBoxNames(ctx);
    const picked = this.brushDrag.pickFrame();
    if (picked) {
      // (as large as a brush gets)
      const r = picked, m = this.brushMax();
      drawBrushFrame(ctx, 'pick', this.cellBox(r.x, r.y, Math.min(r.w, m.w), Math.min(r.h, m.h)), lw);
    }
    if (this.drag?.kind === 'band') {
      const d = this.drag;
      ctx.strokeStyle = MARK.select;
      ctx.fillStyle = rgba(MARK.select, 0.15);
      ctx.lineWidth = lw;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (app.view.show.arcs) this.paintArcLegend(ctx, dpr);
    if (app.view.show.gameView) this.paintGameViewLegend(ctx, dpr);
    if (app.renderError) {
      ctx.fillStyle = 'rgba(200,30,30,0.85)';
      ctx.fillRect(0, 0, this.canvas.width, 22 * dpr);
      ctx.fillStyle = '#fff';
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.fillText(`Emulation: ${app.renderError}`, 8 * dpr, 15 * dpr);
    }
  }

  // beside the box of a selected or hovered object, its name where it has one
  paintBoxNames(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    const hovered = this.hover && !this.drag && !this.brushMode() ? app.hitsAt(this.hover.px, this.hover.py).map((h) => h.item) : [];
    for (const l2 of boxLayers(app.view.show, app.level)) for (const o of app.boxedObjects(l2)) {
      if (!app.model.selection.has(o.uid) && !hovered.includes(o)) continue;
      const name = app.boxName(o);
      if (name) paintBoxName(ctx, o.x * 16, o.y * 16, name, app.view.zoom);
    }
  }

  // where Mario died in test play, by his tile (leveloverlays.ts)
  deathsAt(): Map<string, { tx: number; ty: number; marks: DeathMark[] }> {
    return deathsAt({ images: this.app.images, deaths: loadDeaths(projectId(this.app.rom), this.app.level.number) });
  }

  outlineObject(ctx: CanvasRenderingContext2D, o: LevelObject, color: string, lw: number): void {
    const tiles = this.app.objectTiles(o);
    const set = new Set(tiles);
    ctx.fillStyle = color.startsWith('#') ? rgba(MARK.select, 0.18) : 'rgba(255,255,255,0.12)';
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
  }

  // resize handles on the corners and the middles of the edges, those of the axes the object can be resized on
  paintHandles(ctx: CanvasRenderingContext2D, o: LevelObject, lw: number): void {
    const b = this.app.objectBounds(o), d = this.app.resizeDrivers(o), hs = this.handleSize();
    const xs = [b.x0 * 16, (b.x0 + b.x1 + 1) * 8, (b.x1 + 1) * 16], ys = [b.y0 * 16, (b.y0 + b.y1 + 1) * 8, (b.y1 + 1) * 16];
    ctx.fillStyle = MARK.select;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = lw;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if ((i === 1 && j === 1) || (i !== 1 && !d.x) || (j !== 1 && !d.y)) continue;
      ctx.fillRect(xs[i] - hs / 2, ys[j] - hs / 2, hs, hs);
      ctx.strokeRect(xs[i] - hs / 2, ys[j] - hs / 2, hs, hs);
    }
  }

  // the tile jump arcs start from: the pinned one, else the one under the mouse
  arcTile(): { tx: number; ty: number } | null {
    return this.arcPin ?? (this.hover && !this.drag ? { tx: this.hover.tx, ty: this.hover.ty } : null);
  }

  // what the jump arcs are drawn from: the arc tile, whether it is pinned and its arcs (undefined while emulated)
  arcsDraw(): ArcsDraw | undefined {
    const at = this.arcTile();
    return at ? { ...at, pinned: !!this.arcPin, arcs: this.app.jumpArcs(at.tx, at.ty) } : undefined;
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

  // the game view frame (leveloverlays.ts gameViewIn), put first in the middle of the view; a smaller level or a
  // narrower camera range moves it only while it is open
  gameViewFrame(): GameViewFrame {
    const app = this.app, im = app.images, z = app.view.zoom;
    app.view.gameView ??= gameViewAt((this.scroller.scrollLeft + this.scroller.clientWidth / 2) / z - GAME_VIEW_W / 2,
      (this.scroller.scrollTop + this.scroller.clientHeight / 2) / z - GAME_VIEW_H / 2, im.width, im.height);
    return gameViewIn(app, { level: app.level, images: im, reach: app.cameraReach() }, this.drag?.kind === 'gameView');
  }

  // Shift+V: the game view frame placed by Mario with his feet in the tile under the mouse
  placeGameViewByMario(): void {
    if (!this.hover) return;
    this.app.view.show.gameView = true;
    this.app.placeGameViewByMario(this.hover.tx * 16, (this.hover.ty + 1) * 16 - MARIO_H);
    this.paint();
  }

  // whether the pixel grabs the game view frame: its edge (a few screen pixels either side) or its label
  gameViewGrab(px: number, py: number): boolean {
    if (!this.app.view.show.gameView) return false;
    const p = this.gameViewFrame(), m = 4 / this.app.view.zoom, l = gameViewLabelBox(p, 1 / this.app.view.zoom);
    const inX = px >= p.x - m && px <= p.x + GAME_VIEW_W + m, inY = py >= p.y - m && py <= p.y + GAME_VIEW_H + m;
    const edge = (inX && (Math.abs(py - p.y) <= m || Math.abs(py - p.y - GAME_VIEW_H) <= m))
      || (inY && (Math.abs(px - p.x) <= m || Math.abs(px - p.x - GAME_VIEW_W) <= m));
    return edge || (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h);
  }

  // what the overlays of the game view mean, in the top right corner of the view: where the camera never goes
  // (once the level scan found it), the scroll bands when they are shown
  paintGameViewLegend(ctx: CanvasRenderingContext2D, dpr: number): void {
    const reach = this.app.cameraReach();
    const rows: { label: string; fill?: string; title?: boolean }[] = [
      { label: reach === undefined ? 'Camera reach (emulating …)' : reach === null ? 'Camera reach (not found)' : 'Camera reach', title: true },
      { label: 'never on the screen', fill: 'rgba(0,0,0,0.8)' },
    ];
    if (this.app.view.show.scrollBands) {
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
    if (this.arcPin) this.app.view.show.arcs = true;
    this.paint();
  }

  // tiles of layer 1 in view: x0..x1, y0..y1 (exclusive)
  private visibleTiles(): { x0: number; y0: number; x1: number; y1: number } {
    const g = this.app.images.geom1, z = this.app.view.zoom;
    const x0 = Math.max(0, Math.floor(this.scroller.scrollLeft / z / 16)), y0 = Math.max(0, Math.floor(this.scroller.scrollTop / z / 16));
    return { x0, y0, x1: Math.min(g.width, x0 + Math.ceil(this.scroller.clientWidth / z / 16) + 1), y1: Math.min(g.height, y0 + Math.ceil(this.scroller.clientHeight / z / 16) + 1) };
  }

  // sprites are translucent like the ghosted layers while the background or layer 3 is edited
  spriteAlpha(): number {
    return this.app.view.show.ghost && isBrushMode(this.app.model.mode) ? 0.35 : 1;
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

  // the sprites as the level view draws them (leveloverlays.ts paintSprites)
  spriteDraw(): SpriteDraw {
    const app = this.app, active = app.model.mode === 'spr';
    return { image: (s) => app.spriteImageOf(s), imageAlpha: active ? 1 : 0.85, active, selected: (s) => app.model.selection.has(s.uid), incomplete: new Set(incompleteSprites(app)), missing: new Set(leftOutSprites(app)) };
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
      if (app.model.mode === 'exit') { if (e.button === 2) this.exitMenu(e, px, py, tx, ty); return; }
      if (this.brushMode()) {
        this.drag = { kind: 'brush' };
        this.stroke = { edit: app.model.mode === 'l3' ? app.beginLayer3Edit() : app.beginLevelEdit(), changed: false };
        this.brushDrag.startPaint(this.cellAt(px, py));
        return;
      }
      // on the selection, or with nothing to place: the context menu
      if (e.button === 2 && (this.onSelection(px, py) || !app.model.placement(tx, ty))) { this.levelMenu(e.clientX, e.clientY, px, py, tx, ty); return; }
      app.placeAt(tx, ty);
      return;
    }
    if (e.button !== 0) return;
    if (!e.ctrlKey && this.gameViewGrab(px, py)) {
      const f = this.gameViewFrame(), p = { x: f.x, y: f.y };
      app.view.gameView = p;
      app.view.gameViewMario = null; // (placed by hand from here)
      this.drag = { kind: 'gameView', offX: px - p.x, offY: py - p.y };
      this.updateCursor(px, py, -1);
      this.paint();
      return;
    }
    const mk = this.markerAt(px, py);
    if (mk && !e.ctrlKey) {
      if (app.model.mode === 'exit') app.selectEntrance(mk);
      this.drag = { kind: 'marker', edit: mk.kind !== 'sec' ? app.beginLevelEdit() : null, marker: mk, offX: px - mk.x, offY: py - mk.y, moved: false };
      this.paint();
      return;
    }
    if (this.brushMode()) {
      // click takes the tile into the brush, dragging a rectangle of tiles
      this.drag = { kind: 'brush' };
      this.brushDrag.startPick(this.cellAt(px, py));
      this.paint();
      return;
    }
    if (app.model.mode === 'exit') {
      app.selectScreen(app.vertical ? ty >> 4 : tx >> 4);
      return;
    }
    // resize handle? (all selected objects resized on the grabbed edges, their sizes emulated first)
    const ho = this.handleAt(px, py);
    if (ho) {
      const objs = app.model.selectedObjects().filter((o) => app.resizable(o));
      app.probeSizes(objs);
      const resize = app.model.beginResize(objs, ho.o, ho.grab, (o) => app.resizeDrivers(o), (o) => app.sizeBoxes(o), (o) => app.kindOf(o));
      if (resize) {
        this.drag = { kind: 'resize', resize };
        this.updateCursor(px, py, -1);
        this.resizeStatus();
        return;
      }
    }
    const hits = app.hitsAt(px, py);
    if (e.ctrlKey) {
      // multi-select stays within the current layer
      const own = hits.find((h) => h.mode === app.model.mode);
      if (own) {
        app.model.toggle(own.item.uid);
        return;
      }
    }
    // plain click: an already selected item keeps priority (so selections can be dragged), else the topmost.
    // Alt+click: the next item below the selected one (wrapping around)
    const selIdx = hits.findIndex((h) => h.mode === app.model.mode && app.model.selection.has(h.item.uid));
    const hit = e.altKey ? hits[(selIdx + 1) % hits.length] : hits[Math.max(0, selIdx)];
    if (hit && !e.ctrlKey) {
      if (hit.mode !== app.model.mode) {
        app.setMode(hit.mode, [hit.item.uid]);
        toast(`Mode: ${hit.mode === 'spr' ? 'Sprites' : hit.mode === 'l2' ? 'Layer 2' : 'Layer 1'}`);
      }
      app.model.pick(hit.item.uid);
      const move = app.model.beginMove();
      if (move) this.drag = { kind: 'move', move, startTx: tx, startTy: ty };
    } else {
      this.drag = { kind: 'band', x0: px, y0: py, x1: px, y1: py, add: e.ctrlKey, far: false };
      app.model.beginBox(e.ctrlKey);
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
        this.requestPaint();
      }
      // (every pixel: the resize handles are narrower than a tile; middle button: panning sets its own cursor)
      if (!(e.buttons & 4)) this.updateCursor(px, py, top);
      this.hoverMessage(e);
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'band') {
      d.x1 = px; d.y1 = py;
      d.far ||= Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3;
      this.requestPaint();
    } else if (d.kind === 'gameView') {
      app.view.gameView = gameViewAt(px - d.offX, py - d.offY, app.images.width, app.images.height, app.cameraReach());
      this.requestPaint();
    } else if (d.kind === 'brush') {
      if (this.brushDrag.move(this.cellAt(px, py))) this.requestPaint();
    } else if (d.kind === 'marker') {
      if (app.moveMarker(d.marker, px - d.offX, py - d.offY)) {
        d.moved = true;
        if (d.marker.kind !== 'sec') app.changed(false); // (a secondary entrance is a ROM edit, shown by its follow-up)
      }
    } else if (d.kind === 'move') {
      if (!d.move.to(tx - d.startTx, ty - d.startTy)) return;
      if (app.model.mode === 'spr') app.changed(false);
      else this.scheduleRefresh();
    } else if (d.kind === 'resize') {
      // the grabbed object aims at the mouse, the others move the same edges by as many tiles
      if (!d.resize.aim(tx, ty)) return;
      this.resizeStatus();
      this.scheduleRefresh();
    }
  }

  // a drag step's refresh, with the next display frame: the view painted then, once, as changed (a paint requested
  // before waits for it: it would show the level before the step, #452)
  refreshTimer = 0;
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    if (this.pendingFrame) { cancelAnimationFrame(this.pendingFrame); this.pendingFrame = 0; }
    this.refreshTimer = requestAnimationFrame(() => {
      this.refreshTimer = 0;
      try { this.app.changed(); } finally { this.paint(); }
    });
  }

  onUp(_e: MouseEvent): void {
    const app = this.app;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.dragEnded();
    if (this.hover) this.updateCursor(this.hover.px, this.hover.py, this.hover.top);
    if (d.kind === 'brush') {
      const picked = this.brushDrag.picking;
      this.brushDrag.up();
      if (picked) this.paint();
      return;
    }
    if (d.kind === 'gameView') { this.paint(); return; }
    if (d.kind === 'marker') {
      if (!d.edit) { this.paint(); return; }
      if (!d.moved) { d.edit.cancel(); this.paint(); return; }
      d.edit.commit();
      return;
    }
    if (d.kind === 'band') {
      const x0 = Math.floor(Math.min(d.x0, d.x1) / 16), x1 = Math.floor(Math.max(d.x0, d.x1) / 16);
      const y0 = Math.floor(Math.min(d.y0, d.y1) / 16), y1 = Math.floor(Math.max(d.y0, d.y1) / 16);
      const caught: number[] = [];
      if (app.model.mode === 'spr') {
        const bx0 = Math.min(d.x0, d.x1), bx1 = Math.max(d.x0, d.x1), by0 = Math.min(d.y0, d.y1), by1 = Math.max(d.y0, d.y1);
        for (const s of app.level.sprites) {
          const b = app.spriteBox(s);
          if (b.x0 <= bx1 && b.x1 > bx0 && b.y0 <= by1 && b.y1 > by0) caught.push(s.uid);
        }
      } else if (d.far) {
        // an object is caught by its tiles (its outline), not its bounding box: slopes reach far diagonally
        for (const o of app.objectsInBox(x0, y0, x1, y1)) caught.push(o.uid);
      }
      // a click into nothing (no item of any shown layer there): nothing placed by a right click any more
      if (!d.far && !d.add) app.clearPickedItem();
      app.model.addToSelection(caught);
      return;
    }
    if (d.kind === 'move') { d.move.end(); return; }
    if (d.kind === 'resize') { d.resize.end(); return; }
  }

  // Esc while dragging: the drag undone (moving, resizing, painting, a level entrance) or dropped (a selection
  // box, picking tiles, the game view frame); false when there is none to cancel (moving a secondary entrance)
  cancelDrag(): boolean {
    const d = this.drag;
    if (!d || (d.kind === 'marker' && !d.edit)) return false;
    this.drag = null;
    this.dragEnded();
    if (d.kind === 'move') d.move.cancel();
    else if (d.kind === 'resize') d.resize.cancel();
    else if (d.kind === 'brush') this.brushDrag.cancel();
    else if (d.kind === 'marker') d.edit?.cancel(true);
    if (this.hover) this.updateCursor(this.hover.px, this.hover.py, this.hover.top);
    this.paint();
    return true;
  }

  // the context menu by the keyboard: at the mouse when it is over the level, else at the selection (its first
  // item) or the middle of the view
  keyMenu(): void {
    const app = this.app;
    if (app.model.mode !== 'l1' && app.model.mode !== 'l2' && app.model.mode !== 'spr') return;
    let px: number, py: number;
    if (this.hover) ({ px, py } = this.hover);
    else {
      const it = (app.model.mode === 'spr' ? app.model.selectedSprites() : app.model.selectedObjects())[0], c = this.centerTile();
      px = (it ? it.x : c.tx) * 16 + 8; py = (it ? it.y : c.ty) * 16 + 8;
    }
    const r = this.scroller.getBoundingClientRect(), z = app.view.zoom;
    this.levelMenu(r.left + px * z - this.scroller.scrollLeft, r.top + py * z - this.scroller.scrollTop, px, py, Math.floor(px / 16), Math.floor(py / 16));
  }

  // status bar without the mouse over the level: what the mouse does in this mode
  idleStatus(): void {
    const m = this.app.model.mode;
    this.pos.textContent = '';
    this.status.textContent = isBrushMode(m) ? 'Click/drag picks up tiles as brush · Right click/Shift+click paints'
      : m === 'exit' ? 'Click an entrance (M, Z, S) or screen to select it – edit it on the right under “Properties” · Drag moves entrances · Right click: new entrance, create exit …'
        : 'Click selects, drag moves, click into nothing deselects all · Right click/Shift+click places the picked item, else opens the menu · Alt+click: item underneath';
  }

  updateStatus(tx: number, ty: number): void {
    const app = this.app;
    this.pos.textContent = `X ${hex3(tx)}  Y ${hex3(ty)}  Screen ${hex2(app.vertical ? ty >> 4 : tx >> 4)}`;
    if (this.drag?.kind === 'resize') { this.resizeStatus(); return; }
    if (app.model.mode === 'l3') {
      const c = this.hover ? this.cellAt(this.hover.px, this.hover.py) : { x: 0, y: 0 }, t = app.l3At(c.x, c.y), b = app.l3Brush;
      const tile = layer3WordText;
      this.status.textContent = `${t < 0 ? 'Status bar (not editable)' : `Layer 3 tile ${tile(t)}${app.l3Editable(c.x, c.y) ? '' : ' (outside the level\'s layer 3 tilemap file)'}`}  ·  Brush ${b.tiles.length > 1 ? `${b.w}×${b.h}` : tile(b.tiles[0])}`;
      return;
    }
    let txt = '';
    const t = app.query.tileAt(tx, ty);
    if (t >= 0) {
      txt += `Map16 ${hex3(t)}`;
      const p = app.model.mode === 'bg' ? undefined : app.probes.block(t); // result arrives via 'probes'
      const sum = [p && probeAt(p, tx).summary, p && enterText(p.enter)].filter(Boolean).join(', ');
      if (sum) txt += ` (${sum})`;
      const c = app.view.show.collision && app.model.mode !== 'bg' ? app.probes.collision(t) : undefined;
      if (c) {
        // in the view's switch states; the others, and without a switch when the view's change it
        const on = app.viewSwitches(), shown = collisionIn(c, on);
        const other = [...SWITCH_STATES.filter((sw) => !on.includes(sw) && c.switched[sw]).map((sw) => `${SWITCH_NAME[sw]}: ${switchText(c, sw)}`),
          ...(shown !== c ? [`without switches: ${collisionText(c)}`] : [])];
        txt += ` · ${collisionText(shown)}${other.length ? ` (${other.join(' · ')})` : ''}`;
      }
      const tide = app.view.show.collision && app.model.mode !== 'bg' ? app.tide() : null;
      if (tide && ty * 16 + 8 >= tide.high) txt += ty * 16 + 8 >= tide.low ? ' · water (tide)' : ' · water at high tide';
    }
    if (app.model.mode === 'bg') {
      const b = app.bgBrush;
      txt += `  ·  BG-Tile ${hex3(app.bgAt(tx, ty))}  ·  Brush ${b.tiles.length > 1 ? `${b.w}×${b.h}` : hex3(b.tiles[0])}`;
      this.status.textContent = txt.replace(/^\s*·\s*/, '');
      return;
    }
    const died = app.view.show.deaths ? this.deathsAt().get(`${tx},${ty}`) : undefined;
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
      else { const o = item as LevelObject; txt += `  · ${o.num ? 'Object ' + hex2(o.num) : 'Ext. object ' + hex2(o.ext)}${tag} ${app.objectName(o.num, o.ext)}${o.num ? ' size ' + hex2(app.sizedByte(o)) : ''}`; }
    }
    this.status.textContent = txt.replace(/^\s*·\s*/, '');
  }

  // the resize handles stay ~7 screen pixels at any zoom
  handleSize(): number {
    return 7 / this.app.view.zoom;
  }
  // the selected objects that show resize handles: all up to 32 selected, else the one under the mouse
  handleObjects(): LevelObject[] {
    const app = this.app;
    if (app.model.mode !== 'l1' && app.model.mode !== 'l2') return [];
    const objs = app.model.selectedObjects().filter((o) => app.resizable(o));
    if (objs.length <= 32) return objs;
    const d = this.drag, top = this.hover?.top;
    return objs.filter((o) => (d?.kind === 'resize' ? o.uid === d.resize.uid : o.uid === top));
  }
  // The object whose resize handle is at the pixel and the edges it grabs: each edge along its whole length, in a
  // band reaching a little inside the object and more outside (its inside stays for moving), the corners where
  // two meet; the topmost object first. Only the axes the object can be resized on.
  handleAt(px: number, py: number): { o: LevelObject; grab: Grab } | null {
    const u = 1 / this.app.view.zoom, objs = this.handleObjects();
    const side = (p: number, a: number, b: number): -1 | 0 | 1 | null =>
      p >= a - 5 * u && p < a + 2 * u ? -1 : p > b - 2 * u && p <= b + 5 * u ? 1 : p >= a && p <= b ? 0 : null;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i], b = this.app.objectBounds(o), d = this.app.resizeDrivers(o);
      const sx = side(px, b.x0 * 16, (b.x1 + 1) * 16), sy = side(py, b.y0 * 16, (b.y1 + 1) * 16);
      if (sx === null || sy === null) continue;
      const hx = d.x ? sx : 0, hy = d.y ? sy : 0;
      if (hx || hy) return { o, grab: { hx, hy } };
    }
    return null;
  }
  // the cursor of resizing on edges
  resizeCursor(g: Grab): string {
    return !g.hx ? 'ns-resize' : !g.hy ? 'ew-resize' : g.hx === g.hy ? 'nwse-resize' : 'nesw-resize';
  }
  // the size and tiles of the grabbed object while resizing
  resizeStatus(): void {
    const d = this.drag;
    if (d?.kind !== 'resize') return;
    const o = this.app.model.selectedObjects().find((o) => o.uid === d.resize.uid), size = o && this.app.sizedByte(o), b = o && this.app.sizeBoxes(o)(size!);
    if (!o || !b) return;
    this.status.textContent = `Resizing: size ${hex2(size!)} · ${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1} tiles`;
  }
  // what a click would do, shown by the cursor
  updateCursor(px: number, py: number, top: number): void {
    const app = this.app, d = this.drag;
    let c = '', ho: ReturnType<LevelView['handleAt']>;
    if (d?.kind === 'resize') c = this.resizeCursor(d.resize.grab);
    else if (d?.kind === 'marker' || d?.kind === 'move' || d?.kind === 'gameView') c = 'grabbing';
    else if (this.gameViewGrab(px, py)) c = 'grab';
    else if (this.brushMode()) c = 'crosshair';
    else if (this.markerAt(px, py)) c = 'grab';
    else if (app.model.mode === 'exit') c = 'pointer';
    else if ((ho = this.handleAt(px, py))) c = this.resizeCursor(ho.grab);
    else if (top >= 0 && app.model.selection.has(top)) c = 'move';
    this.scroller.style.cursor = c;
  }

  // whether the pixel is on a selected item of the current mode
  onSelection(px: number, py: number): boolean {
    return this.app.hitsAt(px, py).some((h) => h.mode === this.app.model.mode && this.app.model.selection.has(h.item.uid));
  }

  // The context menu of layer 1/2 and sprites at the pixel (client position x, y): of the selection when on it –
  // an item there not selected is selected first, as by a click – else of the spot (paste, insert, the screen)
  levelMenu(x: number, y: number, px: number, py: number, tx: number, ty: number): void {
    const app = this.app;
    if (!this.onSelection(px, py)) {
      const hit = app.hitsAt(px, py)[0];
      if (hit) {
        if (hit.mode !== app.model.mode) app.setMode(hit.mode, [hit.item.uid]);
        app.model.pick(hit.item.uid);
      } else app.model.clearSelection();
    }
    const spr = app.model.mode === 'spr';
    const items: MenuItem[] = [];
    if (app.model.selection.size) {
      const objs = app.model.selectedObjects(), sprs = app.model.selectedSprites(), n = spr ? sprs.length : objs.length;
      const one = spr ? sprs[0] : objs[0];
      items.push({ heading: n > 1 ? `${n} ${spr ? 'sprites' : 'objects'}` : spr ? `Sprite ${hex2(one.num)} ${app.spriteLabel(spriteId(one as LevelSprite))}` : app.objectName(one.num, (one as LevelObject).ext) },
        { label: 'Cut', onClick: () => { app.model.copy(); app.model.deleteSelection(); } },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => app.model.copy() },
        { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: () => app.duplicateSelection() },
        { label: 'Delete', shortcut: 'Del', onClick: () => app.model.deleteSelection() });
      if (!spr) items.push('sep',
        { label: 'Bring to front', shortcut: 'PgUp', title: 'Drawn after all other objects', onClick: () => app.model.reorderSelection('front') },
        { label: 'Send to back', shortcut: 'PgDn', title: 'Drawn before all other objects', onClick: () => app.model.reorderSelection('back') },
        // a placed prefab alone is one already: it can only be broken up
        'sep', n === 1 && isPlacedPrefab(one as LevelObject)
          ? { label: 'Break up', title: 'Replace the prefab here with the objects it was made from, or single Direct Map16 objects where those would look different (to edit it, then “Save as prefab …” again)', onClick: () => app.explodePrefab(one as LevelObject) }
          : { label: 'Save as prefab …', onClick: () => openSavePrefab(app) });
      items.push('sep', { label: 'Properties', onClick: () => app.emit('properties') });
    } else {
      const clip = spr ? app.model.clipboard.sprites : app.model.clipboard.objects;
      items.push(
        { label: 'Paste here', shortcut: 'Ctrl+V', disabled: () => !clip?.length, onClick: () => app.paste(tx, ty) },
        { label: 'Insert by number …', shortcut: 'I', onClick: () => openInsertDialog(app, tx, ty) },
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => app.model.selectAll() });
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
      items.push({ label: 'Open exit target', onClick: () => app.gotoExitTarget(ex) });
    } else {
      items.push({ label: 'Create exit', onClick: () => { app.selectScreen(scr); app.editLevel(() => { app.level.exits.push({ uid: newUid(), screen: scr, dest: app.level.number, secondary: false, flags: EXIT_NEW }); }, false); } });
    }
    if (toExits) for (const it of items) if (typeof it === 'object' && 'onClick' in it) { const f = it.onClick; it.onClick = () => { if (app.model.mode !== 'exit') app.setMode('exit'); f(); }; }
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
    this.updateProblems();
  }
  // the problems checked anew – while dragging once it ends (the checks take longer than a step of the drag, #445)
  private problemsStale = false;
  private updateProblems(): void {
    this.problemsStale = !!this.drag;
    if (!this.drag) this.problems.update();
  }
  // a drag ended: the problems checked, unless what ended it did (a change)
  private dragEnded(): void {
    queueMicrotask(() => { if (this.problemsStale && !this.drag) this.updateProblems(); });
  }

  // selects the sprites (sprite mode) and scrolls to the first
  revealSprites(uids: number[]): void {
    const app = this.app;
    const first = app.level.sprites.find((s) => s.uid === uids[0]);
    app.setMode('spr', uids);
    if (first) this.scrollToTile(first.x, first.y);
    this.paint();
  }

  centerTile(): { tx: number; ty: number } {
    const z = this.app.view.zoom;
    return {
      tx: Math.floor((this.scroller.scrollLeft + this.scroller.clientWidth / 2) / z / 16),
      ty: Math.floor((this.scroller.scrollTop + this.scroller.clientHeight / 2) / z / 16),
    };
  }

  scrollToTile(tx: number, ty: number): void {
    const z = this.app.view.zoom;
    this.scroller.scrollLeft = tx * 16 * z - this.scroller.clientWidth / 2;
    this.scroller.scrollTop = ty * 16 * z - this.scroller.clientHeight / 2;
  }
}
