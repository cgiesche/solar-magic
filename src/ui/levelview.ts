// Scrollable, zoomable level canvas with editing interactions.

import { App, type Marker } from './app.ts';
import { h, attachPanZoom, downloadBytes } from './dom.ts';
import { spriteName, objectName, hex2, hex3, resizeObjectSize } from '../core/names.ts';
import { probeAt, enterText, type PosProbe } from '../core/blockprobe.ts';
import { type LevelObject, type LevelSprite, serializeLayer1, serializeLayer2, serializeSprites } from '../core/level.ts';
import { composite } from '../core/render.ts';

type Drag =
  | { kind: 'move'; startTx: number; startTy: number; lastDx: number; lastDy: number; orig: Map<number, { x: number; y: number }> }
  | { kind: 'resize'; startTx: number; startTy: number; origSize: Map<number, number>; lastDw: number; lastDh: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'marker'; marker: Marker; offX: number; offY: number; moved: boolean }
  | { kind: 'paint'; changed: boolean };

const MARKER_STYLE: Record<Marker['kind'], { color: string; label: string; title: string }> = {
  main: { color: 'rgba(255,40,40,0.9)', label: 'M', title: 'Haupteingang' },
  midway: { color: 'rgba(255,150,0,0.9)', label: 'Z', title: 'Zwischenziel (Screen)' },
  sec: { color: 'rgba(40,120,255,0.9)', label: 'S', title: 'Sekundärer Eingang' },
};

export class LevelView {
  app: App;
  root: HTMLDivElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  levelCanvas: HTMLCanvasElement;
  hover: { tx: number; ty: number; px: number; py: number; top: number } | null = null;
  drag: Drag | null = null;
  status: HTMLSpanElement;
  stats: HTMLSpanElement;
  pendingFrame = 0;

  constructor(app: App, statusBar: HTMLDivElement) {
    this.app = app;
    this.status = h('span', { class: 'status-text' });
    this.stats = h('span', { class: 'status-stats' });
    statusBar.append(this.status, this.stats);
    this.canvas = h('canvas', { class: 'level-canvas' });
    this.sizer = h('div', { class: 'level-sizer' });
    this.scroller = h('div', { class: 'level-scroller', tabIndex: 0 }, this.canvas, this.sizer);
    this.root = h('div', { class: 'level-view' }, this.scroller);
    this.ctx = this.canvas.getContext('2d')!;
    this.levelCanvas = document.createElement('canvas');
    this.scroller.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    attachPanZoom(this.scroller, () => this.app.zoom, (z, ax, ay) => this.setZoom(z, { ax, ay }));
    this.scroller.addEventListener('mouseleave', () => { this.hover = null; this.paint(); });
    app.on('render', () => { this.updateLevelImage(); this.updateStats(); });
    app.on('anim-frame', () => { this.updateLevelImage(false); });
    app.on('change', () => { this.paint(); this.updateStats(); });
    app.on('sprites', () => this.requestPaint());
    app.on('blockinfo', () => { if (this.hover && !this.drag) this.updateStatus(this.hover.tx, this.hover.ty); if (app.show.items) this.requestPaint(); });
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
      ctx.font = `${11 / app.zoom}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      const n = app.level.header.screens;
      for (let s = 0; s < n; s++) {
        const x = vertical ? 2 : s * 256 + 2, y = vertical ? s * 256 + 11 / app.zoom : 11 / app.zoom;
        ctx.fillText(hex2(s), x, y);
      }
    }
    // exits
    if (app.show.exits) {
      const scrH = vertical ? 256 : im.height;
      for (const ex of app.level.exits) {
        const x = vertical ? 0 : ex.screen * 256, y = vertical ? ex.screen * 256 : 0;
        const sel = app.mode === 'exit' && app.selection.has(ex.uid);
        ctx.fillStyle = sel ? 'rgba(255,200,0,0.25)' : 'rgba(255,160,0,0.08)';
        ctx.fillRect(x, y, 256, vertical ? 256 : scrH);
        ctx.fillStyle = '#ffb000';
        ctx.font = `bold ${12 / app.zoom}px sans-serif`;
        ctx.fillText(`Exit → ${ex.secondary ? 'Sek. ' : ''}${hex3(ex.dest)}`, x + 20 / app.zoom, y + 12 / app.zoom);
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
      ctx.fillStyle = '#fff';
      ctx.fillText(st.label, m.x + 5, m.y + 27.5);
      if (m.kind === 'sec') ctx.fillText(hex3(m.index), m.x + 15, m.y + 27.5);
    }
    if (app.show.items) this.paintItems(ctx);
    // sprites
    if (app.show.sprites) this.paintSprites(ctx, z);
    if (app.show.sprites && app.show.items) this.paintSpriteItems(ctx);
    // selection
    if (app.mode === 'l1' || app.mode === 'l2') {
      const sel = app.selectedObjects();
      for (const o of sel) this.outlineObject(ctx, o, '#4cc2ff', lw);
    }
    // hover
    if (this.hover && !this.drag) {
      const { tx, ty } = this.hover;
      const hits = app.mode === 'bg' ? [] : app.hitsAt(this.hover.px, this.hover.py);
      const hit = hits.find((h) => h.mode === app.mode && app.selection.has(h.item.uid)) ?? hits[0];
      if (hit && !app.selection.has(hit.item.uid)) {
        if (hit.mode === 'spr') {
          const b = app.spriteBox(hit.item as LevelSprite);
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 2 * lw;
          ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        } else this.outlineObject(ctx, hit.item as LevelObject, 'rgba(255,255,255,0.7)', lw);
      }
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(tx * 16, ty * 16, 16, 16);
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
    if (app.renderError) {
      ctx.fillStyle = 'rgba(200,30,30,0.85)';
      ctx.fillRect(0, 0, this.canvas.width, 22 * dpr);
      ctx.fillStyle = '#fff';
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.fillText(`Emulation: ${app.renderError}`, 8 * dpr, 15 * dpr);
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
    if (this.app.selection.size === 1 && this.app.selection.has(o.uid) && (o.num !== 0 || o.ext === 2)) {
      const b = this.app.objectBounds(o);
      ctx.fillStyle = '#4cc2ff';
      ctx.fillRect(b.x1 * 16 + 11, b.y1 * 16 + 11, 5, 5);
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
      const p = app.blockInfo(w[a] | (w[a + 0x10000] << 8));
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

  // the same for sprites that give items (flying ? blocks …), drawn over the sprite images
  paintSpriteItems(ctx: CanvasRenderingContext2D): void {
    const app = this.app;
    ctx.globalAlpha = 0.65;
    for (const s of app.level.sprites) {
      const p = app.spriteInfo(s.num);
      if (p?.summary) this.drawItem(ctx, probeAt(p, s.x), s.x * 16, s.y * 16);
    }
    ctx.globalAlpha = 1;
  }

  // item of a probe result at pixel (x, y); a different item for big Mario at half size, upper right
  drawItem(ctx: CanvasRenderingContext2D, r: PosProbe, x: number, y: number): void {
    const thumbs = this.app.spriteThumbs;
    const small = r.small.sprites[0], big = r.big.sprites[0];
    const main = small ?? big;
    const img = main !== undefined ? thumbs?.get(main) : undefined;
    if (!img) return;
    ctx.drawImage(img, x + Number(img.dataset.ox), y + Number(img.dataset.oy));
    const alt = big !== undefined && big !== main ? thumbs?.get(big) : undefined;
    if (alt) ctx.drawImage(alt, x + 8 + Number(alt.dataset.ox) / 2, y + Number(alt.dataset.oy) / 2, alt.width / 2, alt.height / 2);
  }

  paintSprites(ctx: CanvasRenderingContext2D, z: number): void {
    const app = this.app;
    const active = app.mode === 'spr';
    ctx.font = `bold ${9 / app.zoom * 1.2}px monospace`;
    for (const s of app.level.sprites) {
      const x = s.x * 16, y = s.y * 16;
      const sel = app.selection.has(s.uid) && active;
      const img = app.spriteThumbs?.get(s.num);
      if (img) {
        ctx.globalAlpha = active ? 1 : 0.85;
        ctx.drawImage(img, x + Number(img.dataset.ox), y + Number(img.dataset.oy));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = sel ? 'rgba(255,80,200,0.45)' : active ? 'rgba(255,80,200,0.22)' : 'rgba(255,80,200,0.12)';
      if (!img) ctx.fillRect(x, y, 16, 16);
      ctx.strokeStyle = sel ? '#ff50c8' : 'rgba(255,80,200,0.8)';
      ctx.lineWidth = (sel ? 2 : 1) / z;
      ctx.strokeRect(x, y, 16, 16);
      if (!img || sel || active) {
        ctx.fillStyle = '#fff';
        ctx.fillText(hex2(s.num), x + 1, y + 8);
      }
    }
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
    if (app.mode === 'bg' && e.button === 2) {
      // pick up the BG tile under the cursor
      app.bgTile = app.bgAt(tx, ty);
      app.emit('bgtile');
      this.updateStatus(tx, ty);
      return;
    }
    if (app.mode !== 'bg' && (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey))) {
      // insert palette item
      if (app.mode === 'exit') return;
      app.insertAt(tx, ty);
      return;
    }
    if (e.button !== 0) return;
    const mk = this.markerAt(px, py);
    if (mk && !e.ctrlKey) {
      if (mk.kind !== 'sec') app.checkpoint();
      this.drag = { kind: 'marker', marker: mk, offX: px - mk.x, offY: py - mk.y, moved: false };
      this.paint();
      return;
    }
    if (app.mode === 'bg') {
      app.checkpoint();
      this.drag = { kind: 'paint', changed: app.paintBg(tx, ty, app.bgTile) };
      if (this.drag.changed) this.scheduleRefresh();
      return;
    }
    if (app.mode === 'exit') {
      const scr = app.vertical ? ty >> 4 : tx >> 4;
      const ex = app.level.exits.find((x) => x.screen === scr);
      app.selection = new Set(ex ? [ex.uid] : []);
      app.exitScreen = scr;
      app.emit('change');
      return;
    }
    // resize handle?
    if ((app.mode === 'l1' || app.mode === 'l2') && app.selection.size === 1) {
      const o = app.selectedObjects()[0];
      if (o && (o.num !== 0 || o.ext === 2)) {
        const b = app.objectBounds(o);
        const hx = b.x1 * 16 + 11, hy = b.y1 * 16 + 11;
        if (px >= hx - 2 && px <= hx + 7 && py >= hy - 2 && py <= hy + 7) {
          app.checkpoint();
          this.drag = { kind: 'resize', startTx: tx, startTy: ty, origSize: new Map([[o.uid, o.size]]), lastDw: 0, lastDh: 0 };
          return;
        }
      }
    }
    const hits = app.hitsAt(px, py);
    if (e.ctrlKey) {
      // multi-select stays within the current layer
      const own = hits.find((h) => h.mode === app.mode);
      if (own) {
        const uid = own.item.uid;
        if (app.selection.has(uid)) app.selection.delete(uid); else app.selection.add(uid);
        app.emit('change');
        return;
      }
    }
    // plain click: an already selected item keeps priority (so selections can be dragged), else the topmost.
    // Alt+click: the next item below the selected one (wrapping around)
    const selIdx = hits.findIndex((h) => h.mode === app.mode && app.selection.has(h.item.uid));
    const hit = e.altKey ? hits[(selIdx + 1) % hits.length] : hits[Math.max(0, selIdx)];
    if (hit && !e.ctrlKey) {
      if (hit.mode !== app.mode) app.setMode(hit.mode, [hit.item.uid]);
      else if (!app.selection.has(hit.item.uid)) app.selection = new Set([hit.item.uid]);
      app.emit('change');
      const items = app.mode === 'spr' ? app.selectedSprites() : app.selectedObjects();
      app.checkpoint();
      this.drag = { kind: 'move', startTx: tx, startTy: ty, lastDx: 0, lastDy: 0, orig: new Map(items.map((o) => [o.uid, { x: o.x, y: o.y }])) };
    } else {
      if (!e.ctrlKey) app.selection.clear();
      this.drag = { kind: 'band', x0: px, y0: py, x1: px, y1: py, add: e.ctrlKey };
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
      const moved = !this.hover || this.hover.tx !== tx || this.hover.ty !== ty || this.hover.top !== top;
      this.hover = { tx, ty, px, py, top };
      if (moved) {
        this.updateStatus(tx, ty);
        this.requestPaint();
      }
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'band') {
      d.x1 = px; d.y1 = py;
      this.requestPaint();
    } else if (d.kind === 'paint') {
      if (app.paintBg(tx, ty, app.bgTile)) { d.changed = true; this.scheduleRefresh(); }
    } else if (d.kind === 'marker') {
      if (app.moveMarker(d.marker, px - d.offX, py - d.offY)) {
        d.moved = true;
        if (d.marker.kind !== 'sec') app.dirty = true;
        app.emit('change');
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
      if (app.mode === 'spr') { app.dirty = true; app.emit('change'); }
      else this.scheduleRefresh();
    } else if (d.kind === 'resize') {
      const dw = tx - d.startTx, dh = ty - d.startTy;
      if (dw === d.lastDw && dh === d.lastDh) return;
      d.lastDw = dw; d.lastDh = dh;
      for (const o of app.selectedObjects()) {
        const s0 = d.origSize.get(o.uid);
        if (s0 === undefined) continue;
        o.size = resizeObjectSize(o.num, s0, dw, dh, app.level.header.tileset);
      }
      this.scheduleRefresh();
    }
  }

  refreshTimer = 0;
  scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = requestAnimationFrame(() => {
      this.refreshTimer = 0;
      this.app.dirty = true;
      this.app.refresh();
      this.app.emit('change');
    });
  }

  onUp(_e: MouseEvent): void {
    const app = this.app;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'paint') {
      if (!d.changed) app.undoStack.pop(); else app.changed();
      return;
    }
    if (d.kind === 'marker') {
      if (d.marker.kind === 'sec') { if (d.moved) app.persist(); this.paint(); return; }
      if (!d.moved) { app.undoStack.pop(); this.paint(); return; }
      app.changed();
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
      } else if (Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3) {
        for (const o of app.currentObjects()) {
          const b = app.objectBounds(o);
          if (b.x0 <= x1 && b.x1 >= x0 && b.y0 <= y1 && b.y1 >= y0) app.selection.add(o.uid);
        }
      }
      app.emit('change');
      return;
    }
    if (d.kind === 'move' && d.lastDx === 0 && d.lastDy === 0) {
      app.undoStack.pop();
      return;
    }
    if (d.kind === 'resize' && d.lastDw === 0 && d.lastDh === 0) {
      app.undoStack.pop();
      return;
    }
    app.changed();
  }

  updateStatus(tx: number, ty: number): void {
    const app = this.app;
    const g = app.images.geom1;
    let txt = `X ${hex2(tx)}  Y ${hex2(ty)}  Screen ${hex2(app.vertical ? ty >> 4 : tx >> 4)}`;
    const a = g.addr(tx, ty);
    if (a >= 0) {
      const t = app.render.wram[a] | (app.render.wram[a + 0x10000] << 8);
      txt += `  Map16 ${hex3(t)}`;
      const p = app.mode === 'bg' ? undefined : app.blockInfo(t); // result arrives via 'blockinfo'
      const sum = [p && probeAt(p, tx).summary, p && enterText(p.enter)].filter(Boolean).join(', ');
      if (sum) txt += ` (${sum})`;
    }
    if (app.mode === 'bg') {
      txt += `  BG-Tile ${hex3(app.bgAt(tx, ty))}  ·  Pinsel ${hex3(app.bgTile)} (Klick/Ziehen malt, Rechtsklick nimmt auf)`;
      this.status.textContent = txt;
      return;
    }
    const mk = this.hover ? this.markerAt(this.hover.px, this.hover.py) : null;
    if (mk) txt += `  · ${MARKER_STYLE[mk.kind].title}${mk.kind === 'sec' ? ' ' + hex3(mk.index) : ''} (ziehen zum Verschieben)`;
    const hits = app.hitsAt(this.hover?.px ?? tx * 16, this.hover?.py ?? ty * 16);
    for (const { mode, item } of hits) {
      const tag = hits.length > 1 ? (mode === 'spr' ? '' : mode === 'l1' ? ' [L1]' : ' [L2]') : '';
      if (mode === 'spr') {
        const s = item as LevelSprite;
        const p = app.spriteInfo(s.num);
        const sum = p && probeAt(p, s.x).summary;
        txt += `  · Sprite ${hex2(s.num)} ${spriteName(s.num)}${sum ? ` (von unten: ${sum})` : ''}`;
      }
      else { const o = item as LevelObject; txt += `  · Objekt${tag} ${o.num ? hex2(o.num) : 'Ext ' + hex2(o.ext)} ${objectName(o.num, o.ext)}${o.num ? ' Größe ' + hex2(o.size) : ''}`; }
    }
    this.status.textContent = txt;
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
    const spr = serializeSprites(lv.sprites, lv.spriteHeader, app.vertical).length;
    const parts = [`Objekte ${lv.objects.length}${lv.layer2Objects ? ' / L2 ' + lv.layer2Objects.length : ''}`, `Sprites ${lv.sprites.length}`,
      `L1 ${l1} B${l2 !== undefined ? ` · L2 ${l2} B` : ''} · Spr ${spr} B`];
    this.stats.textContent = parts.join('  ·  ');
    const over = lv.sprites.length > 128;
    this.stats.classList.toggle('warn', over);
    this.stats.title = over ? 'Mehr als 128 Sprites: das Spiel lädt nur die ersten 128.' : '';
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
      const img = app.spriteThumbs?.get(s.num);
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
