// Scrollable, zoomable level canvas with editing interactions.

import { App } from './app.ts';
import { h } from './dom.ts';
import { spriteName, objectName, hex2, hex3 } from '../core/names.ts';
import type { LevelObject, LevelSprite } from '../core/level.ts';

type Drag =
  | { kind: 'move'; startTx: number; startTy: number; lastDx: number; lastDy: number; orig: Map<number, { x: number; y: number }> }
  | { kind: 'resize'; startTx: number; startTy: number; origSize: Map<number, number>; lastDw: number; lastDh: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean };

export class LevelView {
  app: App;
  root: HTMLDivElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  levelCanvas: HTMLCanvasElement;
  hover: { tx: number; ty: number } | null = null;
  drag: Drag | null = null;
  status: HTMLDivElement;
  pendingFrame = 0;
  spriteImages: Map<number, HTMLCanvasElement> | null = null;

  constructor(app: App, status: HTMLDivElement) {
    this.app = app;
    this.status = status;
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
    this.scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.setZoom(this.app.zoom * (e.deltaY < 0 ? 2 : 0.5), e);
      }
    }, { passive: false });
    this.scroller.addEventListener('mouseleave', () => { this.hover = null; this.paint(); });
    app.on('render', () => this.updateLevelImage());
    app.on('change', () => this.paint());
  }

  setZoom(z: number, anchor?: MouseEvent): void {
    z = Math.max(0.5, Math.min(4, z));
    const old = this.app.zoom;
    if (z === old) return;
    const rect = this.scroller.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - rect.left : rect.width / 2;
    const ay = anchor ? anchor.clientY - rect.top : rect.height / 2;
    const lx = (this.scroller.scrollLeft + ax) / old, ly = (this.scroller.scrollTop + ay) / old;
    this.app.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.paint();
    this.app.emit('zoom');
  }

  updateLevelImage(): void {
    const im = this.app.images;
    if (this.levelCanvas.width !== im.width || this.levelCanvas.height !== im.height) {
      this.levelCanvas.width = im.width;
      this.levelCanvas.height = im.height;
    }
    const lctx = this.levelCanvas.getContext('2d')!;
    const id = new ImageData(new Uint8ClampedArray(this.app.compositeImg.buffer.slice(0) as ArrayBuffer), im.width, im.height);
    lctx.putImageData(id, 0, 0);
    this.layout();
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
    // entrance marker
    // sprites
    if (app.show.sprites) this.paintSprites(ctx, z);
    // selection
    if (app.mode === 'l1' || app.mode === 'l2') {
      const sel = app.selectedObjects();
      for (const o of sel) this.outlineObject(ctx, o, '#4cc2ff', lw);
    }
    // hover
    if (this.hover && !this.drag) {
      const { tx, ty } = this.hover;
      if (app.mode === 'l1' || app.mode === 'l2') {
        const o = app.objectAt(tx, ty);
        if (o && !app.selection.has(o.uid)) this.outlineObject(ctx, o, 'rgba(255,255,255,0.7)', lw);
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
    if (this.app.selection.size === 1 && this.app.selection.has(o.uid) && o.num !== 0) {
      const b = this.app.objectBounds(o);
      ctx.fillStyle = '#4cc2ff';
      ctx.fillRect(b.x1 * 16 + 11, b.y1 * 16 + 11, 5, 5);
    }
  }

  paintSprites(ctx: CanvasRenderingContext2D, z: number): void {
    const app = this.app;
    const active = app.mode === 'spr';
    ctx.font = `bold ${9 / app.zoom * 1.2}px monospace`;
    for (const s of app.level.sprites) {
      const x = s.x * 16, y = s.y * 16;
      const sel = app.selection.has(s.uid) && active;
      const img = this.spriteImages?.get(s.num);
      if (img) {
        ctx.globalAlpha = active ? 1 : 0.8;
        ctx.drawImage(img, x + 8 - img.width / 2 + (img.dataset.ox ? Number(img.dataset.ox) : 0), y + 16 - img.height + (img.dataset.oy ? Number(img.dataset.oy) : 0));
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
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey)) {
      // insert palette item
      if (app.mode === 'exit') return;
      app.insertAt(tx, ty);
      return;
    }
    if (e.button !== 0) return;
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
      if (o && o.num !== 0) {
        const b = app.objectBounds(o);
        const hx = b.x1 * 16 + 11, hy = b.y1 * 16 + 11;
        if (px >= hx - 2 && px <= hx + 7 && py >= hy - 2 && py <= hy + 7) {
          app.checkpoint();
          this.drag = { kind: 'resize', startTx: tx, startTy: ty, origSize: new Map([[o.uid, o.size]]), lastDw: 0, lastDh: 0 };
          return;
        }
      }
    }
    let hit: LevelObject | LevelSprite | null = null;
    if (app.mode === 'spr') hit = app.spriteAt(tx, ty);
    else hit = app.objectAt(tx, ty);
    if (hit) {
      if (e.ctrlKey) {
        if (app.selection.has(hit.uid)) app.selection.delete(hit.uid); else app.selection.add(hit.uid);
        app.emit('change');
        return;
      }
      if (!app.selection.has(hit.uid)) app.selection = new Set([hit.uid]);
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
      if (!this.hover || this.hover.tx !== tx || this.hover.ty !== ty) {
        this.hover = { tx, ty };
        this.updateStatus(tx, ty);
        this.requestPaint();
      }
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'band') {
      d.x1 = px; d.y1 = py;
      this.requestPaint();
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
        const w = Math.max(0, Math.min(15, (s0 & 15) + dw));
        const hh = Math.max(0, Math.min(15, (s0 >> 4) + dh));
        o.size = (hh << 4) | w;
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
    if (d.kind === 'band') {
      const x0 = Math.floor(Math.min(d.x0, d.x1) / 16), x1 = Math.floor(Math.max(d.x0, d.x1) / 16);
      const y0 = Math.floor(Math.min(d.y0, d.y1) / 16), y1 = Math.floor(Math.max(d.y0, d.y1) / 16);
      if (app.mode === 'spr') {
        for (const s of app.level.sprites) if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) app.selection.add(s.uid);
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
    }
    if (app.mode === 'spr') {
      const s = app.spriteAt(tx, ty);
      if (s) txt += `  · Sprite ${hex2(s.num)} ${spriteName(s.num)}`;
    } else {
      const o = app.objectAt(tx, ty);
      if (o) txt += `  · Objekt ${o.num ? hex2(o.num) : 'Ext ' + hex2(o.ext)} ${objectName(o.num, o.ext)}${o.num ? ' Größe ' + hex2(o.size) : ''}`;
    }
    this.status.textContent = txt;
  }

  scrollToTile(tx: number, ty: number): void {
    const z = this.app.zoom;
    this.scroller.scrollLeft = tx * 16 * z - this.scroller.clientWidth / 2;
    this.scroller.scrollTop = ty * 16 * z - this.scroller.clientHeight / 2;
  }
}
