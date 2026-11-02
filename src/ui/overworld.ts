// Overworld editor view.

import type { App } from './app.ts';
import type { Watch } from '../core/romwatch.ts';
import { StateMemo } from '../core/romdeps.ts';
import { h, toast, select, checkbox, hexInput, attachPanZoom, zoomControl, pixelZoomSteps, snapZoom, attachRectPick, emptyState } from './dom.ts';
import {
  type OwRender, gameL1, gameL2, readL1, writeL1, readL2, writeL2, l1Index, l1XY, l2Index, readTranslevels, writeTranslevels, readMaps,
  placeTile, sharedTranslevels, enterableLevels, translevelToLevel, MAP_NAMES,
  translevelUse, resetTranslevel, baseEvent, setBaseEvent, eventNames, exitDirections, setExitDirection, DIR_ARROWS, DIR_NAMES, EXIT_NAMES, NO_EVENT,
  initialFlags, setInitialFlags, FLAG, DIR_FLAGS, OW_EVENTS, revealEvents, setRevealEvents, revealAt, revealedTile, revealEventCount,
  readRevealList, writeRevealList, destroyEffects, destroySettingAt, destroyEvent, setDestroyEvent, readDestroyList, freeTranslevel, levelTilesOf, OW_L1_TILES,
  eventBits,
} from '../core/overworld.ts';
import { hasMessages, isBlank, readMessage } from '../core/messages.ts';
import { messageRoutineNote, messageRoutineUnknown, MESSAGE_ROUTINE_CHECKING } from '../core/messagedraw.ts';
import { levelName, hasLevelName } from '../core/levelnames.ts';
import { levelNameField } from './levelnamefield.ts';
import {
  readEvents, writeEvents, applyEvents, paintEvent, reorderSteps, eventRunners, eventTitle, eventPlace, submapOf, pieceTiles, isBig, l2XY,
  paintEventL1, eventL1Tiles, exitChanges, type EventData, type EventRunner, type Rect, type ExitChanges,
} from '../core/owevents.ts';
import { isPathKind, PATH_KIND_NAMES, type PathKind } from '../core/owpaths.ts';
import { skipsRevealWalk } from '../core/revealwalk.ts';
import type { OwSpriteView } from '../core/owsprites.ts';
import { LinkLayer } from './owlinkview.ts';
import { SpriteLayer } from './owspriteview.ts';
import { levelTeleports, locationUses, type LevelTeleport } from '../core/owlinks.ts';
import { tileText } from '../core/owteleport.ts';
import { owActionShort } from '../core/level.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { menuButton } from './menu.ts';
import { levelPicker } from './levelpicker.ts';
import { fillPixels, fitScale, sized, previewSheet, hidePickerPreview } from './pickerview.ts';
import { mainTranslevel } from '../core/level.ts';
import { RAM, map16Pointer } from '../core/ram.ts';
import { loadMusicProject, submapSongs, submapMusic, setSubmapMusic, songHex, type SongInfo } from '../core/music.ts';
import { songLabel, playButton } from './musicdialog.ts';
import { musicPlayer, submapMusicLabel } from './musicplayer.ts';
import type { Rom } from '../core/rom.ts';
import { OW_OPTIONS, owOption, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, revealStepFrames, MAX_REVEAL_SPEED, DEFAULT_REVEAL_SPEED, submapLightning, setSubmapLightning, LIGHTNING_TITLE, lightningEditLabel } from '../core/owoptions.ts';

// a w×h block of L1 tiles (16x16) or L2 tilemap entries (8x8), row-major; L1 tiles picked up from the map carry
// their translevels (`tls`, 0 none), so a level tile placed with them enters the same level
type Brush = { kind: 'l1' | 'l2'; w: number; h: number; entries: number[]; tls?: number[] };
type Drag =
  | { kind: 'paint'; layer: 'l1' | 'l2'; x0: number; y0: number; lastX: number; lastY: number } // brush stamped on a grid from (x0, y0)
  | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number }; // map cells taken into the brush

// the 512x512 image of a map region (0 the main map, 1 the submaps): layer 2 (`l2`), then layer 1 (`l1`, null: the
// state after the events in `r`); undefined leaves a layer out
export function drawOwMap(rom: Rom, r: OwRender, region: number, l1: Uint8Array | null | undefined, l2: Uint16Array | undefined): Uint32Array {
  const W = 512;
  const img = new Uint32Array(W * W);
  const tc = new TileCache(r.vram, r.cgram, 0);
  if (l2) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) blit8(img, W, W, tc.get(l2[l2Index(region, x, y)]), x * 8, y * 8);
  if (l1 !== undefined) {
    const src = l1 ?? r.wram.subarray(RAM.owLayer1, RAM.owLayer1End);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) drawL1Tile(rom, img, tc, r, src[l1Index(region, x, y)], x * 16, y * 16);
  }
  return img;
}
export function putImage(canvas: HTMLCanvasElement, img: Uint32Array, W = 512): void {
  canvas.width = W; canvas.height = img.length / W;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.createImageData(W, img.length / W);
  const px = new Uint32Array(id.data.buffer);
  for (let i = 0; i < px.length; i++) px[i] = img[i] || 0xff000000;
  ctx.putImageData(id, 0, 0);
}
function drawL1Tile(rom: Rom, img: Uint32Array, tc: TileCache, r: OwRender, t: number, px: number, py: number, W = 512, H = 512): void {
  const p = map16Pointer(r.wram, t);
  const w = [0, 1, 2, 3].map((q) => rom.r16(0x050000 | (p + q * 2)));
  blit8(img, W, H, tc.get(w[0]), px, py);
  blit8(img, W, H, tc.get(w[1]), px, py + 8);
  blit8(img, W, H, tc.get(w[2]), px + 8, py);
  blit8(img, W, H, tc.get(w[3]), px + 8, py + 8);
}

// what the timeline shows: an animated step, a silent one, the layer 1 changes
type StepKind = 'step' | 'silent' | 'l1';

// the level picker's note for a level no tile enters: what a tile choosing it gets (translevelUse)
function freeNote(rom: Rom, tl: number): string {
  if (translevelUse(rom, tl) === 2) return 'free · has a level';
  const has = [hasLevelName(rom, tl) && 'name', baseEvent(rom, tl) !== NO_EVENT && 'event', hasMessages(rom, tl) && 'message'].filter(Boolean);
  return has.length ? `free · has ${has.join(', ')}` : 'free';
}

// what an exit the game skips the reveal walk for does (revealwalk.ts)
const NO_REVEAL_WALK = 'the level tile the path leads to gets no way back here (as after Yoshi\'s House and the switch palaces in the clean game)';

export class OverworldView {
  app: App;
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  left: HTMLDivElement;
  canvas: HTMLCanvasElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  status: HTMLDivElement;
  private statusText = h('span', { class: 'status-text' });
  private statusStats = h('span', { class: 'status-stats' });
  private palPanel = h('div', { class: 'panel ow-pal-panel' });
  private palPixels = 0; // the screen pixels per pixel the paint sheet is drawn at (0: none shown)
  private props = h('div', { class: 'panel props' });
  private tlList = h('div', { class: 'level-list' });
  private tlCount = h('span', { class: 'hint' });
  private eventsBadge = h('div', { class: 'ow-badge' });
  private eventsSlider = h('input', { type: 'range', class: 'ow-events', min: 0, max: OW_EVENTS, step: 1 });
  private eventsLabel = h('span', { class: 'ow-events-name' });
  map = 0;
  private watch: Watch; // the ROM bytes the view was built from (romwatch.ts)
  // The map as the game shows it is emulated in the probe worker (App.overworldMap): until the load of the map at the
  // event progress comes, the map drawn last stays (last: its load, of map `map`, with the maps as in the ROM then;
  // stale: something was built from another load or none, built again when it comes; afterShown: what waits for the
  // map shown, as the game shows it)
  private last: { r: OwRender; map: number; rom: { l1: Uint8Array; l2: Uint16Array } } | null = null;
  private stale = false;
  private afterShown: (() => void) | null = null;
  private shownViews: Rect[] | null = null;
  private pendingTile = -1; // a tile to show (showTile) once the submaps' views are known
  // the maps as in the ROM, with the stroke being painted (written to the ROM when it ends); tls: the translevel
  // of each layer 1 tile; rom: the maps as in the ROM; shown: as the game shows them at the event progress, the
  // tiles of the stroke being painted as painted (it goes to the map before events)
  l1: Uint8Array;
  l2: Uint16Array;
  rom: { l1: Uint8Array; l2: Uint16Array };
  shown: { l1: Uint8Array; l2: Uint16Array };
  tls: Uint8Array;
  mode: 'l1' | 'l2' | 'links' | 'sprites' = 'l1';
  showL1 = true;
  showL2 = true;
  showLinks = false; // the links' arrows also while painting (always in the links mode)
  links = new LinkLayer(this);
  showSprites = false; // the sprites also while painting (always in the sprites mode)
  sprites = new SpriteLayer(this);
  // event progress: the map shown with events 0 … progress-1 passed (a view setting kept per ROM, not in the ROM)
  progress = 0;
  // the event being painted (both layers shown and painted as after it), -1 none: the map before events
  event = -1;
  // l1: layer 1 as after it (the game's at the event progress just after it, game; null until its load comes), with the
  // stroke being painted; without: layer 1 as after it without its layer 1 changes (what a stroke is compared with,
  // App.layer1Without; undefined while it is emulated, null when it could not be). Layer 1 is painted once both come
  private ev: {
    data: EventData; before: Uint16Array; after: Uint16Array; l1: Uint8Array | null; game: Uint8Array | null; without: Uint8Array | null | undefined;
    runners: Map<number, EventRunner[]>;
  } | null = null;
  private hoverStep: { kind: StepKind; k: number } | null = null;
  private playing: { start: number; before: HTMLCanvasElement; stepMs: number; fade: boolean } | null = null;
  private timeline = h('div', { class: 'ow-timeline' });
  showGrid = false;
  showPaths = false;
  // whole screen pixels per SNES pixel (pixelZoomSteps): 200 % or the nearest level of the screen's scale
  zoom = snapZoom(2, pixelZoomSteps());
  private zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z), undefined, undefined, pixelZoomSteps);
  brush: Brush = { kind: 'l1', w: 1, h: 1, entries: [0x56] };
  l2Pal = 0;
  hover: { x: number; y: number } | null = null;
  drag: Drag | null = null;
  selected = -1; // the layer 1 tile shown in the properties (l1Index)
  mapCanvas = document.createElement('canvas');
  // set by the host: open a level in the level editor
  onOpenLevel: (n: number) => void = () => {};
  onNav: () => void = () => {};
  // the graphics workspace on a submap's graphics (shown at an event progress)
  onEditGraphics: (map: number, progress: number) => void = () => {};

  constructor(app: App) {
    this.app = app;
    this.l1 = readL1(app.rom);
    this.l2 = readL2(app.rom);
    this.rom = { l1: this.l1.slice(), l2: this.l2.slice() };
    this.shown = this.rom;
    this.tls = readTranslevels(app.rom);
    this.canvas = h('canvas', { class: 'level-canvas' });
    this.sizer = h('div', { class: 'level-sizer' });
    this.scroller = h('div', { class: 'level-scroller', tabIndex: 0 }, this.canvas, this.sizer);
    this.status = h('div', { class: 'statusbar' }, this.statusText, this.statusStats);
    this.side = h('div', { class: 'ow-side' }, this.palPanel, this.props);
    this.bar = h('div', { class: 'ctxbar' });
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' },
      h('div', { class: 'panel-title' }, 'Level tiles', this.tlCount), this.tlList));
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller, this.eventsBadge), this.timeline, this.status);
    this.scroller.addEventListener('scroll', () => this.paint());
    // next frame: layout() resizes the canvas inside the observed scroller (no ResizeObserver loop error); the zoom
    // follows a screen of another scale (the browser's zoom changed: the scroller has other CSS pixels)
    new ResizeObserver(() => requestAnimationFrame(() => {
      const z = snapZoom(this.zoom, pixelZoomSteps());
      if (Math.abs(z - this.zoom) > 1e-6) this.setZoom(z); else this.layout();
    })).observe(this.scroller);
    // the paint sheet follows the panel's width, drawn anew when it needs other screen pixels per pixel
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.palPixels && fillPixels(this.palWidth(), this.mode === 'l1' ? 256 : 128) !== this.palPixels) this.buildSide(); })).observe(this.palPanel);
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    this.scroller.addEventListener('dblclick', (e) => this.onDouble(e));
    this.scroller.addEventListener('mouseleave', () => { if (!this.drag) { this.hover = null; this.updateStatus(); this.paint(); } });
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay), undefined, undefined, pixelZoomSteps);
    this.eventsSlider.addEventListener('input', () => this.setProgress(+this.eventsSlider.value));
    // a ROM edit (a stroke ended, a name chosen) or undo/redo that changed what the view was built from (its watch):
    // shown as in the ROM (a stroke being painted is dropped)
    this.watch = app.watchRom(() => {
      if (!this.root.isConnected) return;
      if (this.drag?.kind === 'paint') this.drag = null;
      this.sync();
    });
    // any ROM edit: the map's load asked for again if it no longer holds (drawn when it comes)
    app.on('rom-change', () => { if (this.root.isConnected) this.render(); });
    // whether the game draws the editor's messages came (the level tile's message boxes)
    app.on('message-routine', () => { if (this.root.isConnected) this.sync(); });
  }

  setZoom(z: number, ax = this.scroller.clientWidth / 2, ay = this.scroller.clientHeight / 2): void {
    z = snapZoom(z, pixelZoomSteps());
    const lx = (this.scroller.scrollLeft + ax) / this.zoom, ly = (this.scroller.scrollTop + ay) / this.zoom;
    this.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.zoomCtl.update();
  }

  // the map cells of the mode: layer 2's 8x8 tiles, else layer 1's 16x16
  get cellSize(): number {
    return this.mode === 'l2' ? 8 : 16;
  }

  get region(): number {
    return this.map > 0 ? 1 : 0;
  }

  // the load of the map at the event progress, undefined while it is emulated (asked for: it is shown when it comes)
  private load(): OwRender | undefined {
    const r = this.app.overworldMap(this.map, this.progress, this.loaded);
    if (r) this.last = { r, map: this.map, rom: this.rom };
    return r;
  }
  private loaded = () => {
    if (!this.root.isConnected) return;
    this.redrawMap();
    if (this.stale) { this.stale = false; this.buildSide(); this.buildLeft(); }
    this.updateStatus();
  };
  // the map's load for drawing tiles: the map at the event progress, while it is emulated the one drawn last (null:
  // none yet)
  render(): OwRender | null {
    const r = this.load();
    if (!r) this.stale = true;
    return r ?? this.last?.r ?? null;
  }
  // the submaps' views, as when the overworld was shown (learned in the probe worker, kept while the ROM bytes they read
  // are unchanged); null until they come
  get views(): Rect[] | null {
    return (this.shownViews ??= this.app.submapViews(this.viewsLearned) ?? null);
  }
  private viewsLearned = (v: Rect[]) => {
    if (!this.root.isConnected || this.shownViews) return;
    this.shownViews = v;
    this.buildTimeline();
    this.paint();
    if (this.pendingTile >= 0) { const i = this.pendingTile; this.pendingTile = -1; this.showTile(i); }
  };
  // the submap layer 1 tile i is on; while the submaps' views are learned the first of its region (0 or 1): only for
  // what is drawn, edits wait for the views (onDown)
  submapAt(i: number): number {
    const v = this.views;
    return v ? submapOf(v, i) : i >= 0x400 ? 1 : 0;
  }
  // the sprites' images at the map and event progress (owsprites.ts), undefined while they are emulated
  owSprites(): OwSpriteView[] | undefined {
    return this.app.overworldSprites(this.map, this.progress, this.spritesLearned);
  }
  private spritesLearned = () => {
    if (!this.root.isConnected) return;
    this.paint();
    if (this.mode === 'sprites') this.buildProps();
  };

  // ---------------- drawing ----------------
  // the map at the event progress; while its load is emulated the last load of this map, with what was painted since
  // (another map's: the image drawn last stays)
  // (what it reads watched too: drawn again on its own after the last sync)
  redrawMap(): void {
    this.watch.add(() => this.redrawMapNow());
  }
  private redrawMapNow(): void {
    const exact = this.load(), last = exact ? null : this.last?.map === this.map ? this.last : null;
    if (!exact && !last) { this.paint(); return; }
    const r = exact ?? last!.r, from = exact ? this.rom : last!.rom;
    const base = this.region * 0x1000, game1 = gameL1(r), game2 = gameL2(r);
    if (exact && this.ev && !this.ev.l1) { this.ev.l1 = game1.slice(); this.ev.game = game1.slice(); }
    this.shown = {
      l1: this.ev?.l1 ?? this.l1.map((t, i) => (t !== from.l1[i] ? t : game1[i])),
      l2: this.ev ? this.ev.after : this.l2.map((t, i) => (t !== from.l2[i] || i < base || i >= base + 0x1000 ? t : game2[i - base])),
    };
    const img = drawOwMap(this.app.rom, r, this.region, this.showL1 ? this.shown.l1 : undefined, this.showL2 ? this.shown.l2 : undefined);
    putImage(this.mapCanvas, img);
    this.paint();
    if (!exact) return;
    const after = this.afterShown;
    this.afterShown = null;
    after?.();
  }

  drawL1Tile(img: Uint32Array, tc: TileCache, r: OwRender, t: number, px: number, py: number, W = 512, H = 512): void {
    drawL1Tile(this.app.rom, img, tc, r, t, px, py, W, H);
  }

  layout(): void {
    const z = this.zoom;
    this.sizer.style.width = `${512 * z}px`;
    this.sizer.style.height = `${512 * z}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hh = this.scroller.clientHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(hh * dpr);
    this.paint();
  }

  paint(): void {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    // whole screen pixels per SNES pixel (half one zoomed out the most), on whole screen pixels
    const z = Math.round(this.zoom * dpr * 2) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(z, 0, 0, z, -Math.round(this.scroller.scrollLeft * dpr), -Math.round(this.scroller.scrollTop * dpr));
    const lw = 1 / z;
    if (this.playing) this.paintPlay(ctx);
    else ctx.drawImage(this.mapCanvas, 0, 0);
    if (this.showGrid) {
      const step = this.cellSize;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i <= 512; i += step) { ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.moveTo(0, i); ctx.lineTo(512, i); }
      ctx.stroke();
    }
    // level tile labels: the level each enters (in orange where another tile enters it too)
    const shared = sharedTranslevels(this.l1, this.tls, this.isLevelTile);
    ctx.font = `bold ${8}px monospace`;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y), tl = this.tls[i];
      if (!this.isLevelTile(this.l1[i])) continue;
      ctx.fillStyle = i === this.selected ? 'rgba(76,194,255,0.85)' : shared.has(tl) || !tl ? 'rgba(230,120,0,0.85)' : 'rgba(0,0,0,0.6)';
      ctx.fillRect(x * 16, y * 16 + 10, 16, 7);
      ctx.fillStyle = '#fff';
      ctx.fillText(tl ? hex(translevelToLevel(tl), 3) : '---', x * 16 + 1, y * 16 + 16);
    }
    if (this.showPaths) this.paintPaths(lw);
    if (this.mode === 'sprites' || this.showSprites) this.sprites.paint(ctx, lw);
    if (this.mode === 'links' || this.showLinks) this.links.paint(ctx, lw);
    if (this.mode !== 'links' && this.mode !== 'sprites') this.paintSelected(lw);
    this.paintStep(lw);
    const s = this.cellSize;
    if (this.mode === 'sprites') {
      // the sprites show what is under the mouse
    } else if (this.mode === 'links') {
      if (this.hover) {
        ctx.strokeStyle = 'rgba(255,255,0,0.9)';
        ctx.lineWidth = lw;
        ctx.strokeRect(this.hover.x * 16, this.hover.y * 16, 16, 16);
      }
    } else if (this.drag?.kind === 'pick') {
      const r = this.pickRect(this.drag);
      ctx.strokeStyle = '#4cc2ff';
      ctx.fillStyle = 'rgba(76,194,255,0.15)';
      ctx.lineWidth = lw;
      ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    } else if (this.hover) {
      // the area the brush would paint
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(this.hover.x * s, this.hover.y * s, this.brush.w * s, this.brush.h * s);
    }
  }

  // the kinds of the layer 1 tiles, as the game sees them (null while they are learned)
  private kinds: { gen: number; kinds: PathKind[] } | null = null;
  // (the level tiles come with them: their labels, the list, the selected tile's settings)
  private kindsLearned = () => { if (!this.root.isConnected) return; this.paint(); this.updateStatus(); this.buildSide(); this.buildLeft(); };
  pathKinds(): PathKind[] | null {
    const gen = this.app.rom.gen;
    if (this.kinds?.gen !== gen) {
      const kinds = this.app.pathKinds(this.kindsLearned);
      if (!kinds) return null;
      this.kinds = { gen, kinds };
    }
    return this.kinds.kinds;
  }
  // (the selected level tile's settings say which exits skip the reveal walk once that is learned)
  private revealWalksLearned = () => { if (this.root.isConnected) this.buildSide(); };
  // whether layer 1 tile t is a level tile (owpaths.ts levelTileTest; none while the path tiles are learned)
  isLevelTile = (t: number): boolean => this.pathKinds()?.[t] === 'level';

  // the path tiles of the map shown, a mark per kind (as Lunar Magic's "Layer 1 Mario Paths"): walk green, climb
  // green with rungs, swim blue, exit red, stop a cross
  paintPaths(lw: number): void {
    const kinds = this.pathKinds();
    if (!kinds) return;
    const ctx = this.canvas.getContext('2d')!, l1 = this.shown.l1;
    const fill = { walk: 'rgba(90,230,100,0.7)', climb: 'rgba(90,230,100,0.7)', swim: 'rgba(60,140,255,0.75)', exit: 'rgba(235,60,60,0.8)' } as Record<PathKind, string>;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const k = kinds[l1[l1Index(this.region, x, y)]];
      if (!isPathKind(k)) continue;
      const px = x * 16, py = y * 16;
      if (k === 'stop') {
        for (const [c, w] of [['rgba(0,0,0,0.8)', 4], ['#fff', 2]] as [string, number][]) {
          ctx.strokeStyle = c;
          ctx.lineWidth = w * lw;
          ctx.beginPath();
          ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + 12, py + 12); ctx.moveTo(px + 12, py + 4); ctx.lineTo(px + 4, py + 12);
          ctx.stroke();
        }
        continue;
      }
      ctx.fillStyle = fill[k];
      ctx.fillRect(px + 2, py + 2, 12, 12);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.5 * lw;
      ctx.strokeRect(px + 2, py + 2, 12, 12);
      if (k === 'climb') {
        ctx.lineWidth = 2 * lw;
        ctx.beginPath();
        for (const ry of [5, 8, 11]) { ctx.moveTo(px + 2, py + ry); ctx.lineTo(px + 14, py + ry); }
        ctx.stroke();
      }
    }
  }

  // the selected tile outlined; a level tile's exits as arrows in the directions they enable (labelled N, 1–3)
  paintSelected(lw: number): void {
    const i = this.selected;
    if (i < 0 || (i >= 0x400) !== (this.region === 1)) return;
    const ctx = this.canvas.getContext('2d')!, { x, y } = l1XY(i), cx = x * 16 + 8, cy = y * 16 + 8;
    ctx.strokeStyle = '#4cc2ff';
    ctx.lineWidth = 2 * lw;
    ctx.strokeRect(x * 16, y * 16, 16, 16);
    const tl = this.tls[i];
    if (!this.isLevelTile(this.l1[i]) || !tl) return;
    this.paintExitResults(ctx, lw, i, tl);
    const dirs = exitDirections(this.app.rom, tl);
    const step = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 4; d++) {
      const exits = dirs.flatMap((v, k) => (v === d ? [k ? String(k) : 'N'] : []));
      if (!exits.length) continue;
      const [dx, dy] = step[d], px = -dy, py = dx; // (px, py) across the arrow
      const x0 = cx + dx * 9, y0 = cy + dy * 9, x1 = cx + dx * 24, y1 = cy + dy * 24;
      for (const [c, w] of [['rgba(0,0,0,0.7)', 4], ['#ffd34c', 2]] as [string, number][]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w * lw;
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.moveTo(x1 - dx * 4 + px * 3, y1 - dy * 4 + py * 3); ctx.lineTo(x1, y1); ctx.lineTo(x1 - dx * 4 - px * 3, y1 - dy * 4 - py * 3);
        ctx.stroke();
      }
      const label = exits.join(''), tx = cx + dx * 17 + px * 6, ty = cy + dy * 17 + py * 6;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(tx - label.length * 2.2 - 1, ty - 4, label.length * 4.4 + 2, 8);
      ctx.fillStyle = '#ffd34c';
      ctx.fillText(label, tx, ty);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // what passing the selected level's exits does (per ROM change): the tiles each exit's event changes, the
  // locations its exits to the overworld teleport to (the levels' exits as the level editor knows them, its open
  // level as edited; read only when a location is used)
  // (kept per ROM state and translevel, what they read counted for the view's watch)
  private exitInfo = new StateMemo<{ changes: ExitChanges[]; teleports: LevelTeleport[] }>();
  exitResults(tl: number): { changes: ExitChanges[]; teleports: LevelTeleport[] } {
    const rom = this.app.rom;
    return this.exitInfo.get(rom, tl, () => {
      const teleports = locationUses(rom).size ? levelTeleports(rom, this.app.entrances.graph(), tl) : [];
      return { changes: exitChanges(rom, tl), teleports };
    });
  }
  // the selected level tile's exits on the map: the tiles each one's event changes outlined (labelled N, 1–3 at
  // the first), the teleports of its exits to the overworld as dashed arrows
  paintExitResults(ctx: CanvasRenderingContext2D, lw: number, i: number, tl: number): void {
    const { changes, teleports } = this.exitResults(tl), region = this.region;
    const colors = ['#ffd34c', '#ff8c4c', '#ff6bd5', '#8cff6b'];
    ctx.font = 'bold 7px monospace';
    for (const c of changes) {
      const color = colors[c.exit], name = c.exit ? String(c.exit) : 'N';
      ctx.strokeStyle = color;
      ctx.fillStyle = color + '33';
      ctx.lineWidth = lw;
      const l1 = c.l1.filter((k) => (k >= 0x400) === (region === 1)), l2 = c.l2.filter((k) => k >> 12 === region);
      for (const k of l1) { const p = l1XY(k); ctx.fillRect(p.x * 16, p.y * 16, 16, 16); ctx.strokeRect(p.x * 16 + 0.5, p.y * 16 + 0.5, 15, 15); }
      for (const k of l2) { const p = l2XY(k); ctx.fillRect(p.x * 8, p.y * 8, 8, 8); }
      const first = l1.length ? (() => { const p = l1XY(l1[0]); return { x: p.x * 16, y: p.y * 16 }; })() : l2.length ? (() => { const p = l2XY(l2[0]); return { x: p.x * 8, y: p.y * 8 }; })() : null;
      if (!first) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(first.x, first.y - 8, 7, 8);
      ctx.fillStyle = color;
      ctx.fillText(name, first.x + 1, first.y - 1);
    }
    const from = l1XY(i);
    for (const t of teleports) {
      if ((t.to.submap ? 1 : 0) !== region) continue;
      const x0 = from.x * 16 + 8, y0 = from.y * 16 + 8, x1 = t.to.x * 16 + 8, y1 = t.to.y * 16 + 8;
      for (const [c, w] of [['rgba(0,0,0,0.75)', 3.5], ['#4cc2ff', 1.5]] as [string, number][]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w * lw;
        ctx.setLineDash([8 * lw, 6 * lw]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x1, y1, 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // ---------------- interaction ----------------
  // the map's pixel under the mouse
  point(e: MouseEvent): { x: number; y: number } {
    const rc = this.scroller.getBoundingClientRect();
    return { x: Math.floor((e.clientX - rc.left + this.scroller.scrollLeft) / this.zoom), y: Math.floor((e.clientY - rc.top + this.scroller.scrollTop) / this.zoom) };
  }

  cell(e: MouseEvent, s = this.cellSize): { x: number; y: number } {
    const p = this.point(e);
    return { x: Math.floor(p.x / s), y: Math.floor(p.y / s) };
  }

  // same buttons as in the level editor: click/drag takes tiles into the brush, right-click/Shift+click paints
  onDown(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const rc = this.scroller.getBoundingClientRect();
    if (e.clientX - rc.left > this.scroller.clientWidth || e.clientY - rc.top > this.scroller.clientHeight) return;
    const c = this.cell(e);
    // (links and moved starts are written with the submap of their tiles: not before the submaps' views are known)
    if ((this.mode === 'links' || this.mode === 'sprites') && !this.views) return;
    if (this.mode === 'links') { if (e.button === 0) this.links.down(c.x, c.y); return; }
    if (this.mode === 'sprites') { if (e.button === 0) { const p = this.point(e); this.sprites.down(p.x, p.y); } return; }
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey)) {
      // (a level tile painted gets a translevel: not before the level tiles are known)
      if (this.mode === 'l1' && !this.pathKinds()) { toast('The path tiles are still being learned – layer 1 can be painted in a moment.'); return; }
      if (this.mode === 'l1' && this.ev?.without === null) { toast('Layer 1 can\'t be painted on this event: the map without its layer 1 changes could not be emulated.', 'error'); return; }
      if (this.mode === 'l1' && this.ev && !this.evL1Ready()) { toast('The map after the event is still being emulated – layer 1 can be painted in a moment.'); return; }
      this.drag = { kind: 'paint', layer: this.mode, x0: c.x, y0: c.y, lastX: c.x, lastY: c.y };
      this.paintAt(c.x, c.y);
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey || (this.mode === 'l1' && e.ctrlKey)) { this.info(c.x, c.y); return; }
    this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    this.paint();
  }

  // a double click on a level tile opens its level (the overworld's entry in the navigation keeps the tile); level
  // tiles are layer 1's 16x16 cells in every mode
  onDouble(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const { x, y } = this.cell(e, 16);
    if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
    const i = l1Index(this.region, x, y), tl = this.tls[i];
    if (!this.isLevelTile(this.l1[i]) || !tl) return;
    this.drag = null;
    this.selectTile(i, false);
    this.onOpenLevel(translevelToLevel(tl));
  }

  onMove(e: MouseEvent): void {
    const inside = e.target === this.scroller || e.target === this.canvas;
    const d = this.drag;
    if (this.sprites.drag) { const p = this.point(e); this.sprites.move(p.x, p.y, e.shiftKey); return; }
    if (!inside && !d && !this.links.drag) return;
    const c = this.cell(e);
    if (this.hover && this.hover.x === c.x && this.hover.y === c.y) return;
    this.hover = c;
    this.updateStatus();
    if (this.links.drag) { this.links.move(c.x, c.y); return; }
    if (d?.kind === 'paint') {
      const x = d.x0 + Math.floor((c.x - d.x0) / this.brush.w) * this.brush.w, y = d.y0 + Math.floor((c.y - d.y0) / this.brush.h) * this.brush.h;
      if (x !== d.lastX || y !== d.lastY) { d.lastX = x; d.lastY = y; this.paintAt(x, y); return; }
    } else if (d?.kind === 'pick') { d.x1 = c.x; d.y1 = c.y; }
    this.paint();
  }

  onUp(e: MouseEvent): void {
    if (this.links.drag) { this.links.up(); return; }
    if (this.sprites.drag) { const p = this.point(e); this.sprites.up(p.x, p.y); return; }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'pick') this.pick(this.pickRect(d));
    else this.endStroke(d.layer);
  }

  // the picked rectangle, clamped to the map (32x32 L1 tiles, 64x64 L2 tiles)
  pickRect(d: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number; w: number; h: number } {
    const n = this.mode === 'l1' ? 32 : 64;
    const cl = (v: number) => Math.max(0, Math.min(n - 1, v));
    const x0 = cl(Math.min(d.x0, d.x1)), x1 = cl(Math.max(d.x0, d.x1)), y0 = cl(Math.min(d.y0, d.y1)), y1 = cl(Math.max(d.y0, d.y1));
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // a stroke is one ROM edit, written when it ends (layer 1 where it changed with the translevels of its level tiles,
  // layer 2 in place when it fits)
  endStroke(layer: 'l1' | 'l2'): void {
    const rom = this.app.rom;
    if (layer === 'l2' && this.ev) { this.endEventStroke(); return; }
    if (layer === 'l1' && this.ev) { this.endEventL1Stroke(); return; }
    const before = layer === 'l1' ? sharedTranslevels(readL1(rom), readTranslevels(rom), this.isLevelTile) : new Map<number, number[]>();
    const l1 = this.l1, l2 = this.l2, tls = this.tls, old = this.rom;
    try {
      this.app.romEdit(layer === 'l1' ? 'Paint layer 1' : 'Paint layer 2', () => {
        if (layer === 'l2') { writeL2(rom, this.l2); return; }
        writeL1(rom, l1);
        writeTranslevels(rom, tls);
      });
    } catch (e) {
      toast(`Not painted: ${e instanceof Error ? e.message : e}`, 'error');
      this.sync();
      return;
    }
    // shown again at the event progress (once its load comes): painted tiles an event changes are on the map before
    // events only
    const covered = () => {
      const n = layer === 'l1' ? l1.filter((v, i) => v !== old.l1[i] && this.shown.l1[i] !== v).length
        : l2.filter((v, i) => v !== old.l2[i] && this.shown.l2[i] !== v).length;
      if (n) toast(`${n} painted tile${n > 1 ? 's are' : ' is'} changed by events at this event progress – painting changes the map before events (fewer events: ,)`);
    };
    if (this.load()) covered(); // (known at once: the ROM edit's sync drew it)
    else this.afterShown = covered;
    if (layer !== 'l1') return;
    const added = [...sharedTranslevels(l1, tls, this.isLevelTile)].filter(([tl, at]) => (before.get(tl)?.length ?? 0) < at.length);
    if (added.length) toast(`${added.map(([tl, at]) => `Level ${hex(translevelToLevel(tl), 3)} is entered from ${at.length} tiles`).join(', ')} – to move a level tile, paint over the old one.`);
    if (l1.some((v, i) => this.isLevelTile(v) && !tls[i])) toast('Every level (001–024, 101–13B) is already entered from a level tile – the new level tile enters none; choose its level in the properties.');
  }

  paintAt(x: number, y: number): void {
    const b = this.brush;
    if (b.kind !== this.mode) return;
    if (this.mode === 'l1' && this.ev && !this.evL1Ready()) return; // (the maps the event is painted with are still emulated)
    const n = this.mode === 'l1' ? 32 : 64;
    let changed = false;
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const v = b.entries[dy * b.w + dx];
      if (this.mode === 'l1' && this.ev?.l1) {
        // as after the event: the translevels stay, a level tile where none is gets one
        const i = l1Index(this.region, xx, yy), into = this.ev.l1, carried = b.tls?.[dy * b.w + dx] ?? 0;
        const tl = this.isLevelTile(v) && !this.tls[i] ? carried || freeTranslevel(this.tls, (n) => translevelUse(this.app.rom, n)) : this.tls[i];
        if (into[i] === v && tl === this.tls[i]) continue;
        into[i] = v;
        this.tls[i] = tl;
        changed = true;
      } else if (this.mode === 'l1') {
        const i = l1Index(this.region, xx, yy), carried = b.tls?.[dy * b.w + dx] ?? 0;
        if (this.l1[i] === v && (!carried || this.tls[i] === carried)) continue;
        placeTile(this.l1, this.tls, i, v, this.isLevelTile, carried, (tl) => translevelUse(this.app.rom, tl));
        changed = true;
      } else {
        const i = l2Index(this.region, xx, yy), into = this.ev ? this.ev.after : this.l2;
        if (into[i] !== v) { into[i] = v; changed = true; }
      }
    }
    if (!changed) return;
    this.redrawMap();
    if (this.mode === 'l1') this.buildLeft();
  }

  pick(r: { x: number; y: number; w: number; h: number }): void {
    const src = this.mode === 'l2' ? this.shown.l2 : this.shown.l1;
    const idx = this.mode === 'l2' ? l2Index : l1Index;
    const at = Array.from({ length: r.w * r.h }, (_, i) => idx(this.region, r.x + (i % r.w), r.y + Math.floor(i / r.w)));
    const entries = at.map((i) => src[i]);
    this.brush = { kind: this.mode === 'l2' ? 'l2' : 'l1', w: r.w, h: r.h, entries, tls: this.mode === 'l1' ? at.map((i, k) => (this.isLevelTile(entries[k]) ? this.tls[i] : 0)) : undefined };
    this.buildSide();
    this.paint();
  }

  info(x: number, y: number): void {
    if (this.mode !== 'l1') { toast('Tile settings are available on layer 1 (paths/levels)'); return; }
    if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
    this.selectTile(l1Index(this.region, x, y), false);
  }

  // shows layer 1 tile i (l1Index) selected, on the submap it is on
  showTile(i: number): void {
    const views = this.views;
    if (!views) { this.pendingTile = i; return; } // (shown when they come)
    this.setMap(submapOf(views, i));
    this.selectTile(i, true);
  }

  // selects a layer 1 tile (a level tile in the list, any tile by Alt/Ctrl+click; l1Index); center: scroll the map to it
  selectTile(i: number, center: boolean): void {
    this.selected = i;
    if (center && i >= 0) {
      const { x, y } = l1XY(i);
      this.scroller.scrollLeft = (x * 16 + 8) * this.zoom - this.scroller.clientWidth / 2;
      this.scroller.scrollTop = (y * 16 + 8) * this.zoom - this.scroller.clientHeight / 2;
    }
    this.buildProps();
    this.buildLeft();
    this.paint();
  }

  // (what it reads watched too: drawn again on its own after the last sync)
  updateStatus(): void {
    this.watch.add(() => this.updateStatusNow());
  }
  private updateStatusNow(): void {
    const c = this.hover;
    const b = this.brush;
    this.scroller.title = ''; // the kind of the path tile under the mouse
    this.statusStats.textContent = b.kind === this.mode ? `Brush ${b.w}×${b.h}` : '';
    if (this.mode === 'sprites' && !c) {
      this.statusText.textContent = 'Click: select a sprite, a start position (M, L) or a Koopa Kid\'s place (K1–K3) · Drag moves it (8 pixels, 1 with Shift) · Delete empties a sprite slot';
      return;
    }
    if (this.mode === 'links' && (this.links.status() || !c)) {
      this.statusText.textContent = this.links.status() ?? 'Drag from a star, pipe or exit path tile to where it leads · Click: select · Drag an end of the selected arrow to move it · Delete removes it';
      return;
    }
    if (!c) {
      this.statusText.textContent = this.ev
        ? `Painting layer ${this.mode === 'l1' ? 1 : 2} as after ${eventTitle(this.ev.runners, this.event)} · Click/drag picks up tiles · Right click/Shift+click paints · Esc: the map before events`
        : 'Click/drag picks up tiles · Right click/Shift+click paints · Alt/Ctrl+click: tile settings';
      return;
    }
    let t = `X ${hex(c.x, 2)}  Y ${hex(c.y, 2)}`;
    if (this.mode !== 'l2') {
      if (c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32) {
        const i = l1Index(this.region, c.x, c.y), shown = this.shown.l1[i];
        t += `  ·  Tile ${hex(shown, 2)}`;
        if (this.ev && eventL1Tiles(this.ev.data, this.event).includes(i)) t += ' (by this event)';
        else if (shown !== this.l1[i]) t += ` (by events, ${hex(this.l1[i], 2)} before)`;
        const tl = this.tls[i];
        if (this.isLevelTile(this.l1[i])) t += tl ? `  ·  Level ${hex(translevelToLevel(tl), 3)} “${levelName(this.app.rom, tl)}”` : '  ·  Enters no level';
        const k = this.showPaths ? this.pathKinds()?.[shown] : undefined;
        if (k && isPathKind(k)) { t += `  ·  ${PATH_KIND_NAMES[k]}`; this.scroller.title = PATH_KIND_NAMES[k]; }
      }
    } else if (c.x >= 0 && c.y >= 0 && c.x < 64 && c.y < 64) {
      const i = l2Index(this.region, c.x, c.y), shown = this.shown.l2[i];
      t += `  ·  Entry ${hex(shown, 4)}`;
      if (this.ev) { if (shown !== this.ev.before[i]) t += ` (by this event, ${hex(this.ev.before[i], 4)} before)`; }
      else if (shown !== this.l2[i]) t += ` (by events, ${hex(this.l2[i], 4)} before)`;
    }
    this.statusText.textContent = t;
  }

  // ---------------- event progress ----------------
  // events 0 … n-1 passed (clamped to none … all), kept for the ROM
  setProgress(n: number): void {
    n = clampProgress(n);
    if (n === this.progress) return;
    this.afterShown = null; // (a note for the map shown before)
    if (this.event >= 0) { this.event = -1; this.syncEvent(); this.buildBar(); }
    this.progress = n;
    storeProgress(this.app.romName, n);
    this.showProgress();
    this.redrawMap();
    this.updateStatus();
  }
  private names = new StateMemo<Map<number, string>>(); // the events' names (per ROM state, reads counted)
  // the slider, the last event passed with the exit that runs it, the badge on the map
  showProgress(): void {
    const rom = this.app.rom, n = this.progress;
    const names = this.names.get(rom, null, () => eventNames(rom));
    const e = n - 1, last = n ? `${hex(e, 2)} ${names.get(e) ?? '(run by no level exit)'}` : '';
    this.eventsSlider.value = String(n);
    this.eventsLabel.textContent = n === 0 ? 'none' : n === OW_EVENTS ? 'all' : `up to ${last}`;
    this.eventsLabel.title = last;
    this.eventsBadge.textContent = `Event progress: ${n === OW_EVENTS ? 'all' : `up to ${hex(e, 2)}`}`;
    this.eventsBadge.classList.toggle('show', n > 0);
  }

  // ---------------- painting an event ----------------
  // event e painted (-1: none): layer 2 shown and painted as after it, the event progress just after it
  setEvent(e: number): void {
    this.stopPlay();
    this.event = e;
    this.hoverStep = null;
    if (e >= 0) {
      this.progress = e + 1;
      storeProgress(this.app.romName, this.progress);
    }
    this.syncEvent();
    this.buildBar();
    this.buildSide();
    this.redrawMap();
    this.updateStatus();
  }
  // the event's steps, the maps before and after it, from the ROM
  private syncEvent(): void {
    const e = this.event;
    if (e < 0) { this.ev = null; this.buildTimeline(); return; }
    const rom = this.app.rom, data = readEvents(rom), base = readL2(rom), before = applyEvents(base, data, 0, e);
    const ev = this.ev = { data, before, after: applyEvents(before, data, e, e + 1), l1: null, game: null, without: undefined as Uint8Array | null | undefined, runners: eventRunners(rom) };
    ev.without = this.app.layer1Without(e, (v) => { if (this.ev === ev) ev.without = v; });
    this.buildTimeline();
  }
  // layer 1 can be painted on the event: the maps after it with and without its layer 1 changes came
  private evL1Ready(): boolean {
    return !!this.ev?.l1 && !!this.ev.without;
  }
  // (null while the submaps' views are learned)
  private place(e: number) {
    const views = this.views;
    return views && eventPlace(this.ev!.runners, views, e, this.map);
  }
  // the events by the level exit that runs them (by level, then exit), those no level on the map runs by number
  eventPicker(): HTMLSelectElement {
    const runners = eventRunners(this.app.rom);
    const first = (e: number) => runners.get(e)?.[0];
    const events = Array.from({ length: OW_EVENTS }, (_, e) => e).sort((a, b) => {
      const ra = first(a), rb = first(b);
      if (!ra || !rb) return ra ? -1 : rb ? 1 : a - b;
      return translevelToLevel(ra.tl) - translevelToLevel(rb.tl) || ra.exit - rb.exit;
    });
    const s = select([[-1, 'Map before events'], ...events.map((e) => [e, first(e) ? `${eventTitle(runners, e)} (${hex(e, 2)})` : eventTitle(runners, e)] as [number, string])],
      this.event, (v) => this.setEvent(v));
    s.classList.add('ow-event-pick');
    return s;
  }
  // a stroke on layer 2 while an event is painted: its steps found again, one ROM edit
  endEventStroke(): void {
    const rom = this.app.rom, e = this.event, after = this.ev!.after, place = this.place(e);
    try {
      if (!place) throw new Error('the submaps are still being loaded, try again');
      this.app.romEdit(`${eventTitle(this.ev!.runners, e)}: paint`, () => writeEvents(rom, paintEvent(readEvents(rom), readL2(rom), e, after, place)));
    } catch (err) {
      toast(`Not painted: ${err instanceof Error ? err.message : err}`, 'error');
      this.sync();
    }
  }
  // a stroke on layer 1 while an event is painted: its layer 1 changes found again (the map after it without them,
  // emulated in the probe worker before the stroke: none is painted without it), with the translevels of level tiles
  // it placed where none was; one ROM edit
  endEventL1Stroke(): void {
    const rom = this.app.rom, e = this.event, after = this.ev!.l1, game = this.ev!.game, without = this.ev!.without, tls = this.tls;
    if (!after || !game || !without) return;
    const painted = new Set([...after.keys()].filter((i) => after[i] !== game[i]));
    try {
      this.app.romEdit(`${eventTitle(this.ev!.runners, e)}: paint layer 1`, () => {
        writeEvents(rom, paintEventL1(readEvents(rom), e, after, without, painted));
        writeTranslevels(rom, tls);
      });
    } catch (err) {
      toast(`Not painted: ${err instanceof Error ? err.message : err}`, 'error');
      this.sync();
    }
  }
  private editSteps(what: string, order: number[]): void {
    const rom = this.app.rom, e = this.event;
    this.app.romEdit(`${eventTitle(this.ev!.runners, e)}: ${what}`, () => writeEvents(rom, reorderSteps(readEvents(rom), e, order)));
  }

  // the steps under the map: the animated ones in their order (drag to reorder), the silent ones, the layer 1
  // changes; hovering one outlines its tiles
  buildTimeline(): void {
    const ev = this.ev, e = this.event;
    this.timeline.classList.toggle('show', !!ev);
    if (!ev) { this.timeline.replaceChildren(); return; }
    const steps = ev.data.steps[e], silent = ev.data.silent[e].filter((s) => s.layer === 2);
    const run = ev.runners.get(e)?.[0], where = MAP_NAMES[run ? this.submapAt(run.tile) : this.map];
    const l1 = eventL1Tiles(ev.data, e), l1Here = l1.filter((i) => (i >= 0x400) === (this.region === 1)).length;
    const hover = (kind: StepKind, k: number) => ({
      onmouseenter: () => { this.hoverStep = { kind, k }; this.paint(); },
      onmouseleave: () => { this.hoverStep = null; this.paint(); },
    });
    let dragged = -1;
    const chip = (k: number) => {
      const p = steps[k];
      const el = h('div', { class: 'ow-step', draggable: true, title: `Step ${k + 1}: ${isBig(ev.data, p.at) ? '6×6' : '2×2'} tiles – drag to change the order`, ...hover('step', k),
        ondragstart: (de: DragEvent) => { dragged = k; de.dataTransfer?.setData('text/plain', String(k)); },
        ondragover: (de: DragEvent) => { de.preventDefault(); el.classList.add('drop'); },
        ondragleave: () => el.classList.remove('drop'),
        ondrop: (de: DragEvent) => {
          de.preventDefault();
          el.classList.remove('drop');
          if (dragged < 0 || dragged === k) return;
          const order = steps.map((_, i) => i).filter((i) => i !== dragged);
          order.splice(order.indexOf(k) + (dragged < k ? 1 : 0), 0, dragged);
          this.editSteps('step order', order);
        } }, String(k + 1), h('span', { class: 'hint' }, isBig(ev.data, p.at) ? ' 6×6' : ' 2×2'));
      return el;
    };
    this.timeline.replaceChildren(
      h('div', { class: 'ow-timeline-head' },
        h('b', null, eventTitle(ev.runners, e)), h('span', { class: 'hint' }, ` · event ${hex(e, 2)} · the map as after it – the editor finds its steps`),
        h('span', { class: 'grow' }),
        h('button', { title: 'Show the steps as the game does (path fade)', disabled: !steps.length, onclick: () => this.play() }, '▶ Play'),
        h('button', { title: 'The steps in the opposite order (from the other end of the path)', disabled: steps.length < 2,
          onclick: () => this.editSteps('steps reversed', steps.map((_, i) => steps.length - 1 - i)) }, '⇄ Reverse'),
        h('button', { title: 'Back to the map before events (Esc)', onclick: () => this.setEvent(-1) }, 'Done')),
      h('div', { class: 'ow-steps' },
        h('span', { class: 'hint' }, steps.length ? `Steps on ${where}:` : `No steps on ${where}`),
        ...steps.map((_, k) => chip(k)),
        silent.length ? h('span', { class: 'hint' }, ' Silent (other submaps):') : null,
        ...silent.map((s, k) => h('div', { class: 'ow-step silent', title: `Written at once when the event ends (${isBig(ev.data, s.tile) ? '6×6' : '2×2'} tiles on another submap)`, ...hover('silent', k) }, '·')),
        l1.length ? h('div', { class: 'ow-step silent', ...hover('l1', 0),
          title: 'Layer 1 tiles the event changes (paint layer 1 while the event is chosen): written at once when it ends, shown when the map is loaded again – for other submaps and tiles not seen (paths)' },
        `Layer 1: ${l1.length} tile${l1.length > 1 ? 's' : ''}${l1Here < l1.length ? ` (${l1Here} here)` : ''}`) : null),
    );
  }

  // the tiles of the step hovered in the timeline, outlined
  paintStep(lw: number): void {
    const ev = this.ev, s = this.hoverStep;
    if (!ev || !s) return;
    const ctx = this.canvas.getContext('2d')!;
    ctx.strokeStyle = '#ffd34c';
    ctx.fillStyle = 'rgba(255,211,76,0.25)';
    ctx.lineWidth = 1.5 * lw;
    if (s.kind === 'l1') {
      for (const i of eventL1Tiles(ev.data, this.event)) {
        if ((i >= 0x400) !== (this.region === 1)) continue;
        const { x, y } = l1XY(i);
        ctx.fillRect(x * 16, y * 16, 16, 16);
        ctx.strokeRect(x * 16, y * 16, 16, 16);
      }
      return;
    }
    const p = s.kind === 'silent' ? (() => { const v = ev.data.silent[this.event].filter((x) => x.layer === 2)[s.k]; return v && { at: v.tile, pos: v.loc }; })() : ev.data.steps[this.event][s.k];
    if (!p) return;
    for (const i of pieceTiles(ev.data, p)) {
      const c = l2XY(i);
      if (c.r !== this.region) continue;
      ctx.fillRect(c.x * 8, c.y * 8, 8, 8);
      ctx.strokeRect(c.x * 8, c.y * 8, 8, 8);
    }
  }

  // the steps shown as the game does: the map before the event, each step fading in after the one before (14 frames
  // each, as measured in the game) – or, with the path fade off, appearing at the reveal speed; silent ones are on
  // other submaps
  play(): void {
    const ev = this.ev;
    if (!ev) return;
    const before = document.createElement('canvas'), r = this.render();
    if (!r) return;
    putImage(before, drawOwMap(this.app.rom, r, this.region, this.showL1 ? this.shown.l1 : undefined, this.showL2 ? ev.before : undefined));
    const rom = this.app.rom;
    this.playing = { start: performance.now(), before, stepMs: revealStepFrames(rom) * 1000 / 60, fade: owOptionValue(rom, 'pathFade') !== false };
    const tick = () => {
      if (!this.playing) return;
      this.paint();
      if (performance.now() - this.playing.start > (ev.data.steps[this.event].length + 2) * this.playing.stepMs) this.stopPlay();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stopPlay(): void {
    if (!this.playing) return;
    this.playing = null;
    this.paint();
  }
  paintPlay(ctx: CanvasRenderingContext2D): void {
    const ev = this.ev!, pl = this.playing!, t = (performance.now() - pl.start) / pl.stepMs;
    ctx.drawImage(pl.before, 0, 0);
    const steps = ev.data.steps[this.event];
    const show = (p: { at: number; pos: number }, alpha: number) => {
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      for (const i of pieceTiles(ev.data, p)) {
        const c = l2XY(i);
        if (c.r === this.region) ctx.drawImage(this.mapCanvas, c.x * 8, c.y * 8, 8, 8, c.x * 8, c.y * 8, 8, 8);
      }
    };
    steps.forEach((p, k) => { if (t > k) show(p, pl.fade ? t - k : 1); });
    ctx.globalAlpha = 1;
  }

  setMap(n: number): void {
    if (n === this.map) return;
    this.afterShown = null; // (a note for the map shown before)
    this.map = n;
    this.selected = -1;
    this.redrawMap();
    this.buildBar();
    this.buildSide();
    this.buildLeft();
    this.onNav();
  }

  // ---------------- context bar (map, layer, view, zoom) ----------------
  buildBar(): void {
    const setMode = (m: 'l1' | 'l2' | 'links' | 'sprites') => {
      if (this.mode === m) return;
      this.mode = m;
      if ((m === 'l1' || m === 'l2') && this.brush.kind !== m) this.brush = { kind: m, w: 1, h: 1, entries: [m === 'l1' ? 0x56 : 0] };
      this.buildBar();
      this.buildSide();
      this.updateStatus();
      this.paint();
    };
    const view = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string, shortcut?: string) =>
      ({ label, title, shortcut, checked: get, onToggle: (v: boolean) => { set(v); this.redrawMap(); this.updateStatus(); } });
    this.zoomCtl.update();
    this.showProgress();
    this.bar.replaceChildren(
      h('label', { class: 'row' }, 'Map ', select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), this.map, (v) => this.setMap(v))),
      h('span', { class: 'sep' }),
      h('div', { class: 'btn-group' },
        h('button', { class: this.mode === 'l1' ? 'active' : '', title: 'Layer 1 (1)', onclick: () => setMode('l1') }, 'Layer 1 (paths/levels)'),
        h('button', { class: this.mode === 'l2' ? 'active' : '', title: 'Layer 2 (2)', onclick: () => setMode('l2') }, 'Layer 2 (terrain)'),
        h('button', { class: this.mode === 'links' ? 'active' : '', title: 'Overworld links (3): stars, pipes and exit paths leading elsewhere, drawn as arrows; drag from a tile to where it leads', onclick: () => setMode('links') }, 'Overworld links'),
        h('button', { class: this.mode === 'sprites' ? 'active' : '', title: 'Sprites (4): the overworld\'s sprites as the game shows them at the event progress, the start positions and the Koopa Kids\' places; drag to move', onclick: () => setMode('sprites') }, 'Sprites')),
      h('span', { class: 'sep' }),
      menuButton({ label: 'View', items: [
        { heading: 'Layers' },
        view('Layer 1', () => this.showL1, (v) => (this.showL1 = v)),
        view('Layer 2', () => this.showL2, (v) => (this.showL2 = v)),
        { heading: 'Guides' },
        view('Grid', () => this.showGrid, (v) => (this.showGrid = v), undefined, 'G'),
        view('Path tiles', () => this.showPaths, (v) => (this.showPaths = v),
          'Layer 1 tiles Mario walks, climbs (rungs) or swims along (blue), exits to another submap on (red) or stops on without entering a level (cross) – invisible in the game; what each does is learned from the game\'s code'),
        view('Sprites', () => this.showSprites, (v) => (this.showSprites = v),
          'The overworld\'s sprites as the game shows them at the event progress (always shown in the Sprites mode)'),
        view('Sprite shadows', () => this.sprites.showShadows, (v) => (this.sprites.showShadows = v), 'A shadow on the ground under each sprite'),
        view('Sprite height marks', () => this.sprites.showHeights, (v) => (this.sprites.showHeights = v), 'A line from a flying sprite\'s position up to it'),
        view('Overworld links', () => this.showLinks, (v) => (this.showLinks = v),
          'Stars, pipes and exit paths leading elsewhere as arrows (always shown in the Overworld links mode), the locations exits to the overworld teleport to and the Koopa Kids\' places dashed'),
      ] }),
      h('span', { class: 'sep' }),
      h('label', { class: 'row', title: 'Event progress: the overworld as after loading a save in which the events up to this one passed, applied in their number order as the game does (a view setting, not in the ROM) – painting changes the map before events · , and . : one event back/further' },
        'Events ', this.eventsSlider, this.eventsLabel),
      h('label', { class: 'row', title: 'Paint an event: the map as it looks after the event – the editor finds its steps (layer 2 animated on the submap of the level running it, silent elsewhere; layer 1 silent); the map before it is the event progress just below it' },
        'Paint ', this.eventPicker()),
      h('span', { class: 'sep' }),
      this.zoomCtl.root,
    );
  }

  // keys while the overworld is shown; false: not handled
  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && this.mode === 'sprites') {
      if (k === 'c') return this.sprites.copy();
      if (k === 'v') return this.sprites.paste();
      if (k === 'd') return this.sprites.duplicate();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === 'escape' && this.mode === 'sprites' && this.sprites.picked !== null) { this.sprites.pick(null); return true; }
    if (k === 'escape' && this.mode === 'links' && this.links.cancelPending()) return true;
    if (k === 'escape' && this.event >= 0) { this.setEvent(-1); return true; }
    if (k === 'g') { this.showGrid = !this.showGrid; this.paint(); return true; }
    if (k === 'm' && this.selected >= 0 && (this.mode === 'l1' || this.mode === 'l2')) { this.editTile(this.selected); return true; }
    if (k === ',' || k === '.') { this.setProgress(this.progress + (k === ',' ? -1 : 1)); return true; }
    if (k >= '1' && k <= '4') { (this.bar.querySelectorAll('.btn-group button')[+k - 1] as HTMLButtonElement).click(); return true; }
    if ((k === 'delete' || k === 'backspace') && this.mode === 'sprites') return this.sprites.remove();
    if ((k === 'delete' || k === 'backspace') && this.mode === 'links') return this.links.remove();
    return false;
  }

  // ---------------- left: level tiles of the map ----------------
  // (what it reads watched too: drawn again on its own after the last sync)
  buildLeft(): void {
    this.watch.add(() => this.buildLeftNow());
  }
  private buildLeftNow(): void {
    const shared = sharedTranslevels(this.l1, this.tls, this.isLevelTile);
    const items: HTMLElement[] = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y), tl = this.tls[i];
      if (!this.isLevelTile(this.l1[i])) continue;
      const lvl = translevelToLevel(tl), name = tl ? levelName(this.app.rom, tl) : '(enters no level)';
      const cur = i === this.selected, warn = shared.has(tl) || !tl;
      const el = h('div', { class: `level-item${cur ? ' current' : ''}`, title: `${name}\n${warn && tl ? 'Another level tile enters this level too\n' : ''}Click: select · Double click: open in the level editor`,
        onclick: () => this.selectTile(i, true), ondblclick: () => { if (tl) { this.selectTile(i, false); this.onOpenLevel(lvl); } } },
        tl ? hex(lvl, 3) : '---', h('span', { class: 'lname' }, ` ${name}`), warn ? h('span', { class: 'warn-text' }, ' ⚠') : null);
      items.push(el);
      if (cur) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    this.tlCount.textContent = String(items.length);
    this.tlList.replaceChildren(...(items.length ? items : [emptyState('This map has no level tiles (56–80).')]));
  }

  // ---------------- right: palette, properties ----------------
  // (what it reads watched too: drawn again on its own after the last sync)
  buildSide(): void {
    this.watch.add(() => this.buildSideNow());
  }
  private buildSideNow(): void {
    const scroll = this.palPanel.scrollTop;
    hidePickerPreview(this.palPanel);
    this.palPixels = 0;
    this.palPanel.replaceChildren(...(this.mode === 'sprites' ? this.sprites.palette()
      : this.mode === 'links' ? [h('div', { class: 'panel-title' }, 'Overworld links'), this.linkLegend()] : [
      h('div', { class: 'panel-title' }, 'Paint', h('span', { class: 'hint' }, 'Right click/Shift+click paints')),
      this.mode === 'l1' ? this.l1Palette() : this.l2Palette()]));
    this.palPanel.scrollTop = scroll;
    this.buildProps();
  }

  private revealListOpen = false;
  buildProps(): void {
    if (this.mode === 'links') { this.props.replaceChildren(h('div', { class: 'panel-title' }, 'Overworld link'), this.links.props()); return; }
    if (this.mode === 'sprites') { this.props.replaceChildren(h('div', { class: 'panel-title' }, 'Sprite'), this.sprites.props()); return; }
    this.props.replaceChildren(h('div', { class: 'panel-title' }, 'Properties'),
      this.mapSettings(),
      this.selected >= 0 ? this.tileInfo(this.selected) : emptyState('Select a level tile in the list on the left, or any tile with Alt/Ctrl+click on the map.'),
      this.revealList(),
      this.optionsPanel());
  }

  // the game's overworld options (Lunar Magic's "Extra Options", core/owoptions.ts): each switch one ROM edit
  private optionsOpen = false;
  private optionsPanel(): HTMLElement {
    const rom = this.app.rom;
    const rows: HTMLElement[] = [];
    for (const o of OW_OPTIONS) {
      if (o.sub && owOptionValue(rom, o.sub.of) !== o.sub.when) continue;
      const v = owOptionValue(rom, o.id);
      if (v === null) { rows.push(h('div', { class: 'row hint warn-text', title: o.title }, `⚠ ${o.label}: its code was changed by a patch`)); continue; }
      const c = checkbox(o.label, o.title, v, (on) => this.app.romEdit(`${o.label}: ${on ? 'on' : 'off'}`, () => setOwOption(rom, o.id, on)));
      if (o.needs && owOptionValue(rom, o.needs) === false) {
        c.querySelector('input')!.disabled = true;
        c.title += ` – no effect while "${owOption(o.needs).label}" is off`;
      }
      if (o.sub) c.classList.add('ow-option-sub');
      rows.push(c);
      const speed = o.id === 'pathFade' ? revealSpeed(rom) : null;
      if (speed !== null) {
        const inp = hexInput(speed, 2, (n) => this.app.romEdit('Path reveal speed', () => setRevealSpeed(rom, n)), MAX_REVEAL_SPEED, (n) => n >= 1 || 'at least 1');
        inp.title = `How fast each step of an event's path appears: added to a counter every frame, a step at 40 (${DEFAULT_REVEAL_SPEED.toString(16).toUpperCase()}: Lunar Magic's default; 40: a step every 3 frames)`;
        rows.push(h('div', { class: 'prop ow-option-sub' }, h('label', null, 'Path reveal speed'), inp));
      }
    }
    // the game's lightning (color 4·7), per submap: each one ROM edit of the same byte
    if (submapLightning(rom, 0) === null) rows.push(h('div', { class: 'row hint warn-text', title: LIGHTNING_TITLE }, '⚠ Lightning: its code was changed by a patch'));
    else {
      rows.push(h('div', { class: 'row hint' }, 'Lightning (color 4·7) on'));
      MAP_NAMES.forEach((name, m) => {
        const c = checkbox(name, LIGHTNING_TITLE, !!submapLightning(rom, m), (on) => this.app.romEdit(lightningEditLabel(name, on), () => setSubmapLightning(rom, m, on)));
        c.classList.add('ow-option-sub');
        rows.push(c);
      });
    }
    const d = h('details', { class: 'ow-reveals', open: this.optionsOpen, ontoggle: () => (this.optionsOpen = d.open) },
      h('summary', null, 'Overworld options', h('span', { class: 'hint' }, ' · the game\'s switches')), ...rows);
    return d;
  }

  // the settings of the map shown: its song (one ROM edit), from the ROM's songs as for levels
  private mapSettings(): HTMLElement {
    const rom = this.app.rom, map = this.map, cur = submapMusic(rom, map);
    let songs: SongInfo[];
    try { songs = submapSongs(rom, loadMusicProject(rom)); } catch { songs = submapSongs(rom); } // (names of custom songs missing)
    const opts = songs.map((s): [number, string] => [s.num, songLabel(s)]);
    if (!songs.some((s) => s.num === cur)) opts.push([cur, songHex(cur)]);
    // listening: the overworld loaded on this map at the event progress shown, as the game plays its song
    const label = submapMusicLabel(map);
    const listen = () => void musicPlayer.playSubmap(this.app, map, label, eventBits(this.progress)).then(() => {
      if (musicPlayer.error) toast(`Could not play: ${musicPlayer.error}`, 'error');
    });
    const sel = select(opts, cur, (v) => {
      this.app.romEdit(`Music of ${MAP_NAMES[map]}`, () => setSubmapMusic(rom, map, v));
      if (musicPlayer.label === label) listen(); // the new song
    });
    sel.title = `The song ${MAP_NAMES[map]} plays – when the overworld loads there and when Mario comes from another map (songs come with packages; with AddmusicK all of its songs)`;
    const play = playButton(label, listen, `Listen: the overworld on ${MAP_NAMES[map]}, as the game plays its song`);
    return h('div', { class: 'ow-info' }, h('div', { class: 'prop' }, h('label', null, 'Map music'), sel, play),
      h('button', { onclick: () => this.onEditGraphics(map, this.progress), title: `${MAP_NAMES[map]}'s own palettes, graphics files, layer 3 and animations in the graphics workspace` }, 'Edit graphics of this submap'));
  }

  // what the overworld links mode's arrows mean
  private linkLegend(): HTMLElement {
    const row = (color: string, text: string, dashed = false) => h('div', { class: 'row' },
      h('span', { class: 'ow-legend', style: `border-top: 2px ${dashed ? 'dashed' : 'solid'} ${color}` }), text);
    return h('div', { class: 'ow-info' },
      row('#c58cff', 'Star / pipe'), row('#ff6b6b', 'Exit path to another submap'),
      row('#4cc2ff', 'Location an exit to the overworld teleports to', true), row('#ffa94c', 'Where a Koopa Kid puts Mario', true),
      h('div', { class: 'hint' }, 'One head: one-way, two heads: both ways.'));
  }

  // a layer 1 tile drawn (16x16) for the lists
  private tileImage(t: number): HTMLCanvasElement {
    const r = this.render(), c = h('canvas', { width: 16, height: 16, class: 'ow-tile' }), ctx = c.getContext('2d')!;
    const id = ctx.createImageData(16, 16), px = new Uint32Array(id.data.buffer);
    px.fill(0xff181818);
    if (r) this.drawL1Tile(px, new TileCache(r.vram, r.cgram, 0), r, t, 0, 0, 16, 16);
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // the overworld's reveal list (Lunar Magic's "Edit Reveal Tile List"): which tile a revealed tile becomes; the
  // selected tile's entry marked
  revealList(): HTMLElement {
    const rom = this.app.rom, list = readRevealList(rom), sel = this.selected >= 0 ? this.l1[this.selected] : -1;
    const set = (k: number, p: { from?: number; to?: number }) =>
      this.app.romEdit('Reveal list', () => writeRevealList(rom, list.map((q, n) => (n === k ? { ...q, ...p } : q))));
    const last = (t: number) => { for (let k = list.length - 1; k >= 0; k--) if (list[k].from === t) return k; return -1; };
    const d = h('details', { class: 'ow-reveals', open: this.revealListOpen, ontoggle: () => (this.revealListOpen = d.open) },
      h('summary', null, 'Reveal list', h('span', { class: 'hint' }, ' · which tile a revealed tile becomes')),
      h('div', { class: 'ow-reveal-rows' }, ...list.map((p, k) => h('div', {
        class: `row ow-reveal${k === last(sel) ? ' current' : ''}`,
        title: last(p.from) !== k ? `Tile ${hex(p.from, 2)} has a later entry: this one is not used` : `A tile ${hex(p.from, 2)} an event reveals becomes ${hex(p.to, 2)}`,
      }, this.tileImage(p.from), hexInput(p.from, 2, (v) => set(k, { from: v })), '→', this.tileImage(p.to), hexInput(p.to, 2, (v) => set(k, { to: v })),
      last(p.from) !== k ? h('span', { class: 'hint warn-text' }, '⚠') : null))));
    return d;
  }

  // the level tile at i: the level it enters (chosen from the levels; the translevel only shown), its name
  levelInfo(i: number): HTMLElement {
    const rom = this.app.rom, tl = this.tls[i], { x, y } = l1XY(i);
    const where = (k: number) => { const p = l1XY(k); return `${k >= 0x400 ? 'submaps' : 'main map'} ${hex(p.x, 2)},${hex(p.y, 2)}`; };
    const others = levelTilesOf(this.l1, this.tls, tl, this.isLevelTile).filter((k) => k !== i);
    const onMap = (t: number) => this.tls.findIndex((v, k) => v === t && k !== i && this.isLevelTile(this.l1[k]));
    const levels = enterableLevels();
    const choose = levelPicker(this.app, tl ? translevelToLevel(tl) : levels[0], (lvl) => {
      const t = mainTranslevel(lvl)!;
      if (t === tl) return;
      const next = this.tls.slice();
      next[i] = t;
      this.app.romEdit(`Level tile ${hex(x, 2)},${hex(y, 2)}: level ${hex(lvl, 3)}`, () => writeTranslevels(rom, next));
    }, { levels, note: (lvl) => { const t = mainTranslevel(lvl)!, k = onMap(t); return k >= 0 ? `on ${where(k)}` : t === tl ? '' : freeNote(rom, t); } });
    const head = [
      h('div', { class: 'prop' }, h('label', null, 'Enters level'), choose),
      h('div', { class: 'hint' }, `Tile ${hex(x, 2)},${hex(y, 2)}${tl ? ` · translevel ${hex(tl, 2)}` : ''}`),
      ...others.map((k) => h('div', { class: 'hint warn-text' }, `⚠ The level tile at ${where(k)} enters this level too.`)),
    ];
    if (!tl) return h('div', { class: 'ow-info' }, ...head, h('div', { class: 'hint warn-text' }, '⚠ This level tile enters no level.'));
    const lvl = translevelToLevel(tl);
    const ev = baseEvent(rom, tl), msgs = [1, 2].filter((n) => !isBlank(readMessage(rom, tl, n)));
    // (a package drawing the message boxes: the editor's messages are not what players see; checked meanwhile)
    const routine = this.app.messageRoutine();
    const shown = msgs.length ? msgs.map((n) => `message ${n}`).join(', ') : 'none';
    return h('div', { class: 'ow-info' }, ...head,
      ...levelNameField(this.app, tl, this.render()),
      // the level's other settings (kept when its tiles are painted over, shown to every new tile entering it)
      ...this.levelSettings(tl),
      ...this.exitResultRows(tl),
      h('div', { class: 'prop' }, h('label', null, 'Message boxes'), !routine ? h('span', { class: 'hint', title: MESSAGE_ROUTINE_CHECKING }, `${shown} · checking…`)
        : routine.game === false ? h('span', { class: 'warn-text', title: messageRoutineNote(routine) }, '⚠ drawn by a package')
        : routine.game === null ? h('span', { class: 'warn-text', title: messageRoutineUnknown(routine) }, `${shown} · ⚠ not checked`)
        : h('span', null, shown),
        h('button', { onclick: () => { this.onOpenLevel(lvl); this.app.openMessages(tl, 1); }, title: 'Edit the level\'s two messages beside the level' }, 'Edit …')),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.onOpenLevel(lvl), title: 'Open in the level editor (also by double click in the list)' }, `Edit level ${hex(lvl, 3)}`),
        hasLevelName(rom, tl) || ev !== NO_EVENT || msgs.length || exitDirections(rom, tl).some((d) => d) || initialFlags(rom, tl)
          ? h('button', { onclick: () => this.app.romEdit(`Level ${hex(lvl, 3)}: settings reset`, () => resetTranslevel(rom, tl)),
            title: 'No name, no base event, every exit enabling up, no message box, no initial flags – the level\'s data stays' }, 'Reset settings') : null),
    );
  }

  // what the level's exits do on the map (drawn there): the tiles each exit's event changes, its teleports
  exitResultRows(tl: number): HTMLElement[] {
    const { changes, teleports } = this.exitResults(tl);
    if (!changes.length && !teleports.length) return [];
    const where = (l1: number[], l2: number[]) => [...new Set([...l1.map((k) => (k >= 0x400 ? 1 : 0)), ...l2.map((k) => k >> 12)])].map((r) => (r ? 'submaps' : 'main map')).join(', ');
    return [
      h('div', { class: 'hint' }, 'Passing it (outlined on the map):'),
      ...changes.map((c) => h('div', { class: 'hint' }, `${EXIT_NAMES[c.exit]}: event ${hex(c.event, 2)} changes ${c.l1.length + c.l2.length ? `${c.l1.length ? `${c.l1.length} layer 1` : ''}${c.l1.length && c.l2.length ? ' and ' : ''}${c.l2.length ? `${c.l2.length} layer 2` : ''} tiles (${where(c.l1, c.l2)})` : 'nothing'}`)),
      ...teleports.map((t) => h('div', { class: 'hint' }, `Exit to the overworld (entrance ${hex(t.entrance, 3)}, ${owActionShort(t.action)}): teleports to ${tileText(t.to)} (dashed)`)),
    ];
  }

  // the selected tile: a level tile's settings, and for every tile the events that reveal it
  tileInfo(i: number): HTMLElement {
    const { x, y } = l1XY(i), t = this.l1[i];
    const info = this.isLevelTile(t) ? this.levelInfo(i) : h('div', { class: 'ow-info' }, h('div', { class: 'hint' }, `Tile ${hex(x, 2)},${hex(y, 2)} · ${hex(t, 2)} (not a level tile)`));
    info.append(h('div', { class: 'row' }, h('button', { title: 'Edit which 8x8 tiles make this layer 1 tile, in the Map16 tab (M) – for every place of the tile on all maps', onclick: () => this.editTile(i) }, `Edit tile ${hex(t, 2)} in Map16 …`)),
      ...this.revealSettings(i), ...this.destroySettings(i));
    return info;
  }
  // the Map16 tab on layer 1 tile i's tile (as in the ROM), drawn as on this map at the event progress
  private editTile(i: number): void {
    const t = this.l1[i];
    if (t >= OW_L1_TILES) { toast(`Tile ${hex(t, 2)} is past the overworld's layer 1 tiles (00–${hex(OW_L1_TILES - 1, 2)})`); return; }
    this.app.editTile(t, 'ow', { submap: this.map, progress: this.progress });
  }

  // the events by the level exit that runs them, the number as detail
  private eventLabel(names: Map<number, string>, e: number): string {
    return `${names.get(e) ?? 'No level runs it'} · ${hex(e, 2)}`;
  }

  // the base event, the direction each exit enables, the initial flags of translevel tl (each change one ROM edit).
  // An exit the game skips the reveal walk for (revealwalk.ts) still enables its direction but reveals no path: said
  // so beside it (nothing while that is learned)
  levelSettings(tl: number): HTMLElement[] {
    const rom = this.app.rom, lvl = hex(translevelToLevel(tl), 3), ev = baseEvent(rom, tl), names = eventNames(rom);
    const edit = (what: string, f: () => void) => this.app.romEdit(`Level ${lvl}: ${what}`, f);
    const events = select([[NO_EVENT, 'No event'], ...Array.from({ length: OW_EVENTS }, (_, e) => [e, this.eventLabel(names, e)] as [number, string])], ev,
      (v) => edit('base event', () => setBaseEvent(rom, tl, v)));
    events.title = 'The event passing the level runs: its normal exit this one, secret exit n the one n after it';
    const dirs = exitDirections(rom, tl);
    const skips = this.app.revealWalkSkips(this.revealWalksLearned);
    const exits = EXIT_NAMES.map((name, k) => {
      const run = ev === NO_EVENT ? 'no event' : ev + k < OW_EVENTS ? `event ${hex(ev + k, 2)}` : 'no event (past the last)';
      const s = select(DIR_NAMES.map((n, d) => [d, `${DIR_ARROWS[d]} ${n}`] as [number, string]), dirs[k], (v) => edit(`${name.toLowerCase()} direction`, () => setExitDirection(rom, tl, k, v)));
      const skip = !!skips && skipsRevealWalk(skips, tl, k);
      s.title = `${name}: runs ${run} and enables walking in this direction from the tile` +
        (skip ? `; ${NO_REVEAL_WALK}` : '; when first passed, the level tile the path leads to gets the way back');
      return h('div', { class: 'prop' }, h('label', { title: `Runs ${run}` }, name), s,
        skip ? h('span', { class: 'hint', title: `The game skips the reveal walk for this level: ${NO_REVEAL_WALK}` }, 'no reveal walk') : null);
    });
    const flags = initialFlags(rom, tl);
    const flag = (label: string, bit: number, title: string) => checkbox(label, title, (flags & bit) !== 0,
      (on) => edit('initial flags', () => setInitialFlags(rom, tl, on ? flags | bit : flags & ~bit)));
    return [
      h('div', { class: 'prop' }, h('label', null, 'Base event'), events),
      h('div', { class: 'hint' }, 'Direction each exit enables (arrows on the map):'),
      ...exits,
      h('div', { class: 'hint' }, 'At the start of a new game:'),
      h('div', { class: 'grid4' },
        ...DIR_NAMES.map((d, k) => flag(DIR_ARROWS[k], DIR_FLAGS[k], `Mario may walk ${d} from the tile from the start`))),
      flag('Passed', FLAG.passed, 'The level counts as passed: Start+Select leaves it, "no entry" applies – runs no event'),
      flag('Midway point obtained', FLAG.midway, 'The level starts at its midway entrance'),
      flag('No entry if passed', FLAG.noEntry, 'Once passed, the level can\'t be entered again'),
      flag('Save prompt when passed', FLAG.savePrompt, 'Passing the level brings up the save prompt (as castles and switch palaces do)'),
    ];
  }

  // the events that reveal layer 1 tile i (Lunar Magic's "reveal this tile on events"): one tile per event
  revealSettings(i: number): HTMLElement[] {
    const rom = this.app.rom, { x, y } = l1XY(i), t = this.l1[i], into = revealedTile(rom, t), names = eventNames(rom);
    if (!i) return [h('div', { class: 'hint' }, 'The top left tile of the main map can\'t be revealed (0 stands for none).')];
    const evs = revealEvents(rom, i);
    const set = (list: number[]) => this.app.romEdit(`Tile ${hex(x, 2)},${hex(y, 2)}: revealed on events`, () => setRevealEvents(rom, i, list));
    const where = (k: number) => { const p = l1XY(k); return `${k >= 0x400 ? 'submaps' : 'main map'} ${hex(p.x, 2)},${hex(p.y, 2)}`; };
    const add = select([[-1, 'Add an event…'], ...Array.from({ length: revealEventCount(rom) }, (_, e) => e).filter((e) => !evs.includes(e))
      .map((e) => { const k = revealAt(rom, e); return [e, `${this.eventLabel(names, e)}${k ? ` (reveals ${where(k)})` : ''}`] as [number, string]; })], -1,
    (e) => { if (e >= 0) set([...evs, e].sort((a, b) => a - b)); });
    add.title = 'An event reveals one tile: one that reveals another tile moves here';
    return [
      h('div', { class: 'prop' }, h('label', null, 'Revealed on'), add),
      ...evs.map((e) => h('div', { class: 'row' }, h('span', { class: 'hint' }, this.eventLabel(names, e)),
        h('button', { title: 'This event no longer reveals the tile', onclick: () => set(evs.filter((v) => v !== e)) }, '×'))),
      ...(!evs.length ? [] : [into < 0 ? h('div', { class: 'hint warn-text' }, `⚠ Tile ${hex(t, 2)} is not in the reveal list: revealing it changes nothing.`)
        : h('div', { class: 'hint' }, `Revealed, tile ${hex(t, 2)} becomes ${hex(into, 2)}.`)]),
    ];
  }

  // the event destroying tile i (Lunar Magic's "Destroy Level Tile Settings") – on a tile the game destroys (what it
  // does learned by emulation), also on the level tile below a castle's top; one tile per event
  destroySettings(i: number): HTMLElement[] {
    const rom = this.app.rom, effects = destroyEffects(rom), names = eventNames(rom);
    const { at: j, tile: t } = destroySettingAt(rom, this.l1, this.shown.l1, i);
    if (j < 0) return [];
    const { x, y } = l1XY(j), ev = destroyEvent(rom, j);
    const where = (k: number) => { const p = l1XY(k); return `${k >= 0x400 ? 'submaps' : 'main map'} ${hex(p.x, 2)},${hex(p.y, 2)}`; };
    const other = new Map(readDestroyList(rom).filter((d) => d.event !== NO_EVENT && d.tile !== j).map((d) => [d.event, d.tile]));
    const pick = select([[NO_EVENT, 'No event'], ...Array.from({ length: OW_EVENTS }, (_, e) => [e, `${this.eventLabel(names, e)}${other.has(e) ? ` (destroys ${where(other.get(e)!)})` : ''}`] as [number, string])], ev, (v) => {
      try {
        this.app.romEdit(`Tile ${hex(x, 2)},${hex(y, 2)}: destroyed on event`, () => setDestroyEvent(rom, j, v));
      } catch (err) { toast(`Not set: ${err instanceof Error ? err.message : err}`, 'error'); this.buildProps(); }
    });
    pick.title = 'The event that destroys this tile when it passes (as castles and fortresses): an event destroys one tile, one destroying another moves here';
    const side = (c: { dx: number; dy: number }) => (c.dy > 0 ? 'below' : c.dy < 0 ? 'above' : c.dx > 0 ? 'right of it' : 'left of it');
    const changes = t === undefined ? [] : effects[t].map((c) => `${c.dx || c.dy ? `the tile ${side(c)} ` : ''}becomes ${hex(c.tile, 2)}`);
    return [
      h('div', { class: 'prop' }, h('label', null, 'Destroyed on'), pick),
      j !== i ? h('div', { class: 'hint' }, `The setting of the tile at ${where(j)}, whose destroy changes this one too (a castle's top).`) : null,
      ev !== NO_EVENT && t !== undefined ? h('div', { class: 'hint' }, `Destroyed, tile ${hex(t, 2)} ${changes.join(', ')}.`) : null,
      ev !== NO_EVENT && t === undefined ? h('div', { class: 'hint warn-text' }, '⚠ The game destroys no such tile: destroying it changes nothing.') : null,
    ].filter((v): v is HTMLDivElement => !!v);
  }

  // palette sheet with the brush outlined (when it is a rectangle of the sheet) and rectangle picking;
  // any other brush (taken from the map, flipped) is shown as a preview instead
  // the paint panel's width inside its padding, which the sheet fills
  private palWidth(): number {
    const st = getComputedStyle(this.palPanel);
    return this.palPanel.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
  }

  sheetPalette(sheet: HTMLCanvasElement, cls: string, cols: number, rows: number, cell: number, sheetValue: (x: number, y: number) => number,
    preview: (ctx: CanvasRenderingContext2D) => void, describe: (r: { x: number; y: number; w: number; h: number }) => string[]): HTMLElement {
    const b = this.brush;
    const k = this.palPixels = fillPixels(this.palWidth(), sheet.width), scale = this.palWidth() / sheet.width;
    const c = h('canvas', { width: sheet.width * k, height: sheet.height * k, class: `${cls} sheet-fill` });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const draw = (r: { x: number; y: number; w: number; h: number } | null) => {
      ctx.drawImage(sheet, 0, 0);
      if (!r) return;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = cell / 8;
      ctx.strokeRect(r.x * cell + ctx.lineWidth / 2, r.y * cell + ctx.lineWidth / 2, r.w * cell - ctx.lineWidth, r.h * cell - ctx.lineWidth);
    };
    let at: { x: number; y: number; w: number; h: number } | null = null;
    if (b.kind === this.mode) {
      for (let i = 0; i < cols * rows && !at; i++) {
        const x = i % cols, y = Math.floor(i / cols);
        if (x + b.w <= cols && y + b.h <= rows && b.entries.every((v, j) => v === sheetValue(x + (j % b.w), y + Math.floor(j / b.w)))) at = { x, y, w: b.w, h: b.h };
      }
    }
    draw(at);
    attachRectPick(c, cols, rows, draw, (r) => {
      this.brush = { kind: this.mode === 'l2' ? 'l2' : 'l1', w: r.w, h: r.h, entries: Array.from({ length: r.w * r.h }, (_, j) => sheetValue(r.x + (j % r.w), r.y + Math.floor(j / r.w))) };
      this.buildSide();
    });
    previewSheet(c, () => sheet, cols, rows, cell, scale, describe);
    const out = h('div', null);
    if (!at && b.kind === this.mode) {
      const p = h('canvas', { width: b.w * cell, height: b.h * cell, class: 'ow-brush' });
      preview(p.getContext('2d')!);
      sized(p, fitScale(p.width, p.height, sheet.width * scale, sheet.width * scale, scale));
      out.append(h('div', { class: 'hint' }, `Brush ${b.w}×${b.h}:`), h('div', { class: 'row' }, p));
    }
    out.append(c);
    return out;
  }

  l1Palette(): HTMLElement {
    const r = this.render();
    if (!r) return h('div', { class: 'hint' }, 'Loading the overworld…');
    const tc = new TileCache(r.vram, r.cgram, 0);
    const tiles = (list: number[], w: number, W: number, H: number) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      px.fill(0xff181818);
      list.forEach((t, i) => this.drawL1Tile(px, tc, r, t, (i % w) * 16, Math.floor(i / w) * 16, W, H));
      ctx.putImageData(id, 0, 0);
      return c;
    };
    const sheet = tiles(Array.from({ length: 256 }, (_, t) => t), 16, 256, 256);
    const b = this.brush;
    const one = b.kind === 'l1' && b.entries.length === 1;
    return h('div', null,
      h('div', { class: 'hint' }, `${one ? `Tile ${hex(b.entries[0], 2)}` : b.kind === 'l1' ? `Block ${b.w}×${b.h}` : ''} · Level tiles: 56–80`),
      this.sheetPalette(sheet, 'ow-pal', 16, 16, 16, (x, y) => y * 16 + x,
        (ctx) => ctx.drawImage(tiles(b.entries, b.w, b.w * 16, b.h * 16), 0, 0),
        (q) => [q.w * q.h > 1 ? `Block ${q.w}×${q.h} from tile ${hex(q.y * 16 + q.x, 2)}` : `Tile ${hex(q.y * 16 + q.x, 2)}`]));
  }

  l2Palette(): HTMLElement {
    const r = this.render();
    if (!r) return h('div', { class: 'hint' }, 'Loading the overworld…');
    const tc = new TileCache(r.vram, r.cgram, 0);
    const entries = (list: number[], w: number, W: number, H: number) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      px.fill(0xff181818);
      list.forEach((v, i) => blit8(px, W, H, tc.get(v), (i % w) * 8, Math.floor(i / w) * 8));
      ctx.putImageData(id, 0, 0);
      return c;
    };
    const sheet = entries(Array.from({ length: 1024 }, (_, t) => t | (this.l2Pal << 10)), 16, 128, 512);
    const b = this.brush;
    const brushInfo = b.kind === 'l2' ? `Brush ${b.w}×${b.h}: ${b.entries.slice(0, 16).map((v) => hex(v, 4)).join(' ')}${b.entries.length > 16 ? ' …' : ''}` : '';
    // X-flip mirrors every row of the block, Y-flip the order of the rows
    const flip = (bit: number, label: string) => h('button', {
      onclick: () => {
        const br = this.brush;
        if (br.kind !== 'l2') return;
        const rows = Array.from({ length: br.h }, (_, y) => br.entries.slice(y * br.w, (y + 1) * br.w).map((v) => v ^ bit));
        if (bit === 0x4000) rows.forEach((row) => row.reverse());
        if (bit === 0x8000) rows.reverse();
        br.entries = rows.flat();
        this.buildSide();
      },
    }, label);
    const pal = h('div', { class: 'ow-pal-scroll' }, this.sheetPalette(sheet, 'ow-pal8', 16, 64, 8, (x, y) => (y * 16 + x) | (this.l2Pal << 10),
      (ctx) => ctx.drawImage(entries(b.entries, b.w, b.w * 8, b.h * 8), 0, 0),
      (q) => [q.w * q.h > 1 ? `Block ${q.w}×${q.h} from tile ${hex(q.y * 16 + q.x, 3)}` : `Tile ${hex(q.y * 16 + q.x, 3)}`]));
    return h('div', null,
      h('div', { class: 'prop' }, h('label', null, 'Palette'), select(Array.from({ length: 8 }, (_, i) => [i, String(i)] as [number, string]), this.l2Pal, (v) => { this.l2Pal = v; this.buildSide(); })),
      h('div', { class: 'row' }, flip(0x4000, 'X-Flip'), flip(0x8000, 'Y-Flip'), flip(0x2000, 'Priority')),
      h('div', { class: 'hint mono' }, brushInfo),
      pal);
  }

  // the maps again from the ROM (the kept loads stay where the ROM edits changed nothing they read)
  // the view built from the ROM, watching what it read
  sync(): void {
    this.watch.run(() => this.build());
  }
  private build(): void {
    const m = readMaps(this.app.rom);
    this.l1 = m.l1;
    this.l2 = m.l2;
    this.rom = { l1: this.l1.slice(), l2: this.l2.slice() };
    this.tls = m.tls;
    this.stopPlay();
    this.syncEvent();
    this.buildSide();
    this.buildLeft();
    this.redrawMap();
    this.updateStatus();
  }

  show(): void {
    this.shownViews = null;
    this.pendingTile = -1;
    this.afterShown = null;
    void this.views; // (asked for now: the links, sprites and events need them)
    this.event = -1;
    this.progress = loadProgress(this.app.romName);
    // (the map drawn last may be another ROM's: not shown while this one's load is emulated)
    this.last = null;
    if (!this.load()) putImage(this.mapCanvas, new Uint32Array(512 * 512));
    this.buildBar();
    this.sync();
    this.layout();
  }
}

// the event progress kept per ROM (by its name) in the browser
const PROGRESS_PREF = 'ow-event-progress:';
const clampProgress = (n: number) => Math.max(0, Math.min(OW_EVENTS, n));
function loadProgress(rom: string): number {
  try { return clampProgress(Number(localStorage.getItem(PROGRESS_PREF + rom)) || 0); } catch { return 0; }
}
function storeProgress(rom: string, n: number): void {
  try { if (n) localStorage.setItem(PROGRESS_PREF + rom, String(n)); else localStorage.removeItem(PROGRESS_PREF + rom); } catch { /* no storage */ }
}

