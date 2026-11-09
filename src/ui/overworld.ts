// Overworld editor view.

import type { App } from './app.ts';
import type { Watch } from '../core/romwatch.ts';
import { StateMemo } from '../core/romdeps.ts';
import { syncBowsieMaxTile } from '../core/bowsie.ts';
import { h, toast, choose, select, checkbox, hexInput, attachPanZoom, zoomControl, pixelZoomSteps, snapZoom, attachRectPick, emptyState, putImage, type CellRect } from './dom.ts';
import { BrushDrag, drawBrushFrame, paintButton } from './brushsurface.ts';
import {
  type OwRender, gameL1, readL1, readL2, l1Index, l1XY, l2Index, readTranslevels, writeTranslevels, readMaps,
  sharedTranslevels, translevelToLevel, MAP_NAMES,
  resetTranslevel, baseEvent, setBaseEvent, eventNames, exitDirections, setExitDirection, DIR_ARROWS, DIR_NAMES, EXIT_NAMES, NO_EVENT,
  initialFlags, setInitialFlags, FLAG, DIR_FLAGS, OW_EVENTS, revealEvents, revealedTile, revealEventCount,
  readRevealList, writeRevealList, destroyEffects, destroySettingAt, readDestroyList, hasDestroyPatch, levelTilesOf, OW_L1_TILES,
  eventBits, drawOwMap, drawL1Tile, owTileCaches, owShownAt, owMapAt, owShownCopies,
} from '../core/overworld.ts';
import { isBlank, readMessage } from '../core/messages.ts';
import { messageRoutineNote, messageRoutineUnknown, MESSAGE_ROUTINE_CHECKING } from '../core/messagedraw.ts';
import { levelName, hasLevelName, levelNamePatch } from '../core/levelnames.ts';
import { levelNameField } from './levelnamefield.ts';
import {
  readEvents, writeEvents, applyEvents, reorderSteps, eventRunners, exitEvent, eventTitle, eventWords, playthroughStrip, stepEvent, eventPlace, submapOf, submapShown, pieceTiles, isBig, l2XY,
  eventL1Tiles, exitChanges, type EventData, type EventRunner, type Rect, type ExitChanges, type StripEntry,
} from '../core/owevents.ts';
import { OverworldStroke, shownMaps } from '../core/owstroke.ts';
import { PathTool } from './owpathtool.ts';
import { isPathKind, type PathKind, type PathShapes } from '../core/owpaths.ts';
import { mapWays, usualWays, pathTileText, type PathWay } from '../core/owpathshape.ts';
import { emptyL1Tiles, freeL1Tiles, sheetPages, l1TileLines, l1Hex, l1BrushEntries, NO_TILE, SHEET_COLS, type SheetPage } from '../core/owl1sheet.ts';
import { findL2Brush, l2BrushPalettes, l2SharedBits, l2SheetEntry, L2_SHEET_COLS, L2_SHEET_ROWS, L2_FLIP_X, L2_FLIP_Y, L2_PRIORITY, type SheetMark } from '../core/owl2sheet.ts';
import { mapPieces, piecesAt, replacePiece, samePiece, gridInside, l2Block, PIECE_COLS } from '../core/owl2pieces.ts';
import { skipsRevealWalk, handledWithoutEvent } from '../core/revealwalk.ts';
import type { OwSpriteView } from '../core/owsprites.ts';
import { LinkLayer } from './owlinkview.ts';
import { LevelTileLayer, tilePlace } from './owlevelview.ts';
import { LevelNameEditor } from './owlevelname.ts';
import { ownsTranslevel, starOrPipe, starDirs, giveStarTranslevel, type StarPaths } from '../core/owstars.ts';
import { levelsWithoutTile, type LevelTileEvent } from '../core/owleveltiles.ts';
import {
  eventReveal, eventDestroys, revealRefusal, destroyRefusal, addReveal, removeReveal, addDestroy, removeDestroy, cellText, revealPickCheck, destroyPickCheck,
} from '../core/oweventtiles.ts';
import { refusalToast, refusedToast, refusalWords, refusalText, type RefusalFix } from './owrefusal.ts';
import { editFix } from './owfixes.ts';
import type { OwRefusalData } from '../core/owrefusal.ts';
import { revealPairFor, addRevealPair, newL1Tile, tileCopiesOf000, takeTileCopy } from '../core/owfixes.ts';
import { SpriteLayer } from './owspriteview.ts';
import { CellHistoryPopup, tileWords } from './owcellhistoryview.ts';
import { exitSentences, teleportExit, type Clause } from '../core/owexitsentence.ts';
import { owBudgets, type Budget, type BudgetKey } from '../core/owbudget.ts';
import { budgetGauge, budgetBlocked, budgetRow } from './budgetgauge.ts';
import { levelTeleports, locationUses, type LevelTeleport } from '../core/owlinks.ts';
import { tileText } from '../core/owteleport.ts';
import { owActionShort } from '../core/level.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { menuButton, contextMenu } from './menu.ts';
import { fillPixels, fitScale, sized, previewSheet, hidePickerPreview, showPickerPreview, crop } from './pickerview.ts';
import { loadMusicProject, submapSongs, submapMusic, setSubmapMusic, songHex, type SongInfo } from '../core/music.ts';
import { songLabel, playButton } from './musicdialog.ts';
import { musicPlayer, submapMusicLabel } from './musicplayer.ts';
import type { Rom } from '../core/rom.ts';
import { ReachLayer } from './owreachview.ts';
import { ExitArrowLayer } from './owexitarrows.ts';
import { WorldCheck } from './worldcheck.ts';
import { layerStrengths, isLayerMode, type OwMode, type LayerStrengths } from '../core/owlayers.ts';
import { OW_OPTIONS, owOption, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, revealStepFrames, MAX_REVEAL_SPEED, DEFAULT_REVEAL_SPEED, submapLightning, setSubmapLightning, LIGHTNING_TITLE, lightningEditLabel } from '../core/owoptions.ts';
import { boolPref, numberPref, prefFamily } from './prefs.ts';
import { antsMenuItem, AntsOverlay, type AntsMark } from './ants.ts';
import { animationMenuItem } from './viewmenu.ts';
import { OwAnimPlayer } from './owanim.ts';
import { animateTiles } from './pickeranim.ts';

// a w×h block of L1 tiles (16x16) or L2 tilemap entries (8x8), row-major; a L1 brush has no level tiles (NO_TILE
// where one was picked: they are objects on layer 1, placed with a look from the picker's "Levels", ADR 0012)
type Layer = 'l1' | 'l2';
type Brush = { kind: Layer; w: number; h: number; entries: number[] };
// the layer 1 brush to begin with: tile 000
const FIRST_L1_TILE = 0x00;

// a pick's checks (#348): its key and what they read besides the ROM (dep, by identity: the same pick, the same checks),
// the check of a cell (l1Index) made when needed
export type PickCheck = { key: string; dep?: unknown; make: () => (i: number) => OwRefusalData | null };

// what the timeline shows: an animated step, a silent one, the layer 1 changes, the tile revealed, a tile destroyed
type StepKind = 'step' | 'silent' | 'l1' | 'reveal' | 'destroy';

// what an exit the game skips the reveal walk for does (revealwalk.ts)
const NO_WAY_BACK = 'the level tile the path leads to gets no way back to this one';
const NO_REVEAL_WALK = `The game skips the reveal walk for this level: ${NO_WAY_BACK} (as after Yoshi's House and the switch palaces in the clean game)`;
// … and for an exit that runs no event (the game handles it at once): no direction enabled either
const NO_EVENT_WALK = `It runs no event, so the game enables no direction from the tile and skips the reveal walk: ${NO_WAY_BACK}`;
// (the level tiles are known with the path tile kinds: until then the list and a selected tile say so – exitpanel.ts says the same)
const LEVEL_TILES_LEARNED = 'The overworld\'s level tiles are being learned …';
const LEVEL_TILES_BRUSH = 'Level tiles are no brush tiles: choose a look under "Levels" above the sheet and right click a cell to place one';
// the hatching of level tiles in the layer 1 mode (on the map and in the sheet)
const LEVEL_HATCH = 'rgba(255,255,255,0.45)';
// the cells of size n at `at` (their top left corners) hatched with diagonal lines, lw wide
function hatchCells(ctx: CanvasRenderingContext2D, at: { x: number; y: number }[], n: number, lw: number): void {
  ctx.strokeStyle = LEVEL_HATCH;
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (const { x, y } of at) for (let d = n / 4; d < 2 * n; d += n / 4) {
    ctx.moveTo(x + Math.max(0, d - n), y + Math.min(n, d));
    ctx.lineTo(x + Math.min(n, d), y + Math.max(0, d - n));
  }
  ctx.stroke();
}

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
  map = 0;
  private watch: Watch; // the ROM bytes the view was built from (romwatch.ts)
  // The map as the game shows it is emulated in the probe worker (App.overworldMap): until the load of the map at the
  // event progress comes, the map drawn last stays (last: its load, of map `map`, with the maps as in the ROM then;
  // stale: something was built from another load or none, built again when it comes)
  private last: { r: OwRender; map: number; rom: { l1: Uint16Array; l2: Uint16Array } } | null = null;
  private stale = false;
  private stroke: OverworldStroke | null = null; // the stroke on layer 1 or 2 being painted
  private shownViews: Rect[] | null = null;
  private pendingTile = -1; // a tile to show (showTile) once the submaps' views are known
  // the maps as in the ROM, with the stroke being painted (written to the ROM when it ends); tls: the translevel
  // of each layer 1 tile (as in the ROM: strokes leave it); rom: the maps as in the ROM; shown: as the game shows them at the event progress, the
  // tiles of the stroke being painted as painted (it goes to the map before events)
  l1: Uint16Array;
  l2: Uint16Array;
  rom: { l1: Uint16Array; l2: Uint16Array };
  shown: { l1: Uint16Array; l2: Uint16Array };
  tls: Uint8Array;
  mode: OwMode = 'l1';
  dimL2 = dimL2Pref.get(); // layer 2 dimmed while layer 1 is painted (View → Layers, kept in the browser)
  l1InL2 = l1InL2Pref.get(); // layer 1 shown (dimmed) while layer 2 is painted (View → Layers, kept in the browser)
  private solo = false; // Q held: layer 2 hidden while layer 1 is painted; layer 1 the other way while layer 2 is
  private openPage1 = false; // page 1 of the layer 1 sheet shown though none of its tiles is the ROM's own
  links = new LinkLayer(this);
  showSprites = false; // the sprites also while painting (always in the sprites mode)
  sprites = new SpriteLayer(this);
  levelTiles = new LevelTileLayer(this); // the level tiles as objects on top of layer 1 (the layer 1 mode)
  nameEditor = new LevelNameEditor(this); // the selected level tile's name, edited in place (the layer 1 mode)
  pathTool = new PathTool(this); // the layer 1 mode's route brush, "Path (auto)": routes dragged, their tiles chosen
  reach = new ReachLayer(this); // path validation: the tiles Mario doesn't reach dimmed
  check = new WorldCheck(this); // the World check: the status bar button, the panel of problems
  exits = new ExitArrowLayer(this); // the layer 1 mode's arrows from a level tile to the levels its exits open
  cellHistory = new CellHistoryPopup(this); // a cell's history over the game, the mouse resting on it
  // a change of a cell's history being moved to another event (owcellhistoryview.ts): the cells that would move,
  // outlined on the map (refused: hatched red)
  movePreview: { cells: number[]; refused: boolean } | null = null;
  // the event the map is shown and painted as after (both layers; the playthrough strip under the map), -1: the map before events
  // (kept per ROM in the browser, not in the ROM)
  event = -1;
  // event progress: the map shown with events 0 … progress-1 passed, those up to the event shown
  get progress(): number {
    return this.event + 1;
  }
  // l1: layer 1 as after it (the game's at the event progress just after it, game; null until its load comes), with the
  // stroke being painted; without: layer 1 as after it without its layer 1 changes (what a stroke is compared with,
  // App.layer1Without; undefined while it is emulated, null when it could not be). Layer 1 is painted once both come
  private ev: {
    data: EventData; before: Uint16Array; after: Uint16Array; l1: Uint16Array | null; game: Uint16Array | null; without: Uint16Array | null | undefined;
    runners: Map<number, EventRunner[]>;
  } | null = null;
  private hoverStep: { kind: StepKind; k: number } | null = null;
  private hoverClause: Clause | null = null; // the "When beaten…" clause hovered (its tiles outlined)
  // a reveal or destroy being added to the event in the timeline: the cell clicked on the map (at -1 until then), for
  // a reveal then the tile it becomes picked in the layer 1 sheet
  private eventPick: { kind: 'reveal' | 'destroy'; at: number } | null = null;
  // the layer 2 selection: the rectangle last picked from layer 2 (larger than a piece), where "Replace piece…" replaces
  // the pieces wholly inside it (null: the submap's view)
  private l2Sel: CellRect | null = null;
  // "Replace piece…" (#370) under way: the piece to replace being picked (from: null), then the new one
  private replacing: { from: number[] | null } | null = null;
  private playing: { start: number; before: HTMLCanvasElement; stepMs: number; fade: boolean } | null = null;
  private timeline = h('div', { class: 'ow-timeline' });
  // the playthrough strip choosing the event (buildStrip), its chips scrolled horizontally
  private strip = h('div', { class: 'ow-strip' });
  private stripList = h('div', { class: 'ow-strip-list' });
  showGrid = false;
  // whole screen pixels per SNES pixel (pixelZoomSteps): 200 % or the nearest level of the screen's scale
  zoom = snapZoom(2, pixelZoomSteps());
  private zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z), undefined, undefined, pixelZoomSteps);
  brush: Brush = { kind: 'l1', w: 1, h: 1, entries: [FIRST_L1_TILE] };
  l2Pal = 0;
  hover: { x: number; y: number } | null = null;
  mouse: { x: number; y: number } | null = null; // the map's pixel under the mouse (on the map)
  // layers 1 and 2 painted with a brush (brushsurface.ts, ADR 0011): a stroke (owstroke.ts) or cells picked
  private brushDrag = new BrushDrag({
    brush: () => this.brush,
    stamp: (x, y) => this.paintAt(x, y),
    changed: () => { this.redrawMap(); if (this.mode === 'l1') this.buildLeft(); },
    end: () => this.endStroke(),
    cancel: () => {
      this.stroke?.cancel();
      this.stroke = null;
      this.redrawMap();
      if (this.mode === 'l1') this.buildLeft();
    },
    pick: (r) => this.pick(this.clampRect(r)),
  });
  selected = -1; // the layer 1 tile shown in the properties (l1Index)
  mapCanvas = document.createElement('canvas'); // the map as shown: its layers at their strengths (composeMap)
  private l1Canvas = document.createElement('canvas'); // layer 1 alone (transparent where it has no pixel)
  get l1Image(): HTMLCanvasElement { return this.l1Canvas; }
  private l2Canvas = document.createElement('canvas'); // layer 2 alone (black where it has no pixel)
  // the layers as the load draws them (drawOwMap), the still map: put on their canvases as the animation's step shown
  // has them (putLayers)
  private layerPx: { r: OwRender; l1: Uint32Array; l2: Uint32Array } | null = null;
  // the map's animation (owanim.ts; View → "Animation"): the map and the pickers follow it
  anim: OwAnimPlayer;
  // set by the host: open a level in the level editor
  onOpenLevel: (n: number) => void = () => {};
  onNav: () => void = () => {};
  // the graphics workspace on a submap's graphics (shown at an event progress)
  onEditGraphics: (map: number, progress: number) => void = () => {};
  onEditBorder: (map: number) => void = () => {};
  // test play from the selected tile at the event progress (the strip's button, as key T)
  onTestPlay: () => void = () => {};

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
    this.status = h('div', { class: 'statusbar' }, this.statusText, this.statusStats, this.check.button);
    this.side = h('div', { class: 'ow-side' }, this.check.root, this.palPanel, this.props);
    this.bar = h('div', { class: 'ctxbar' });
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' },
      h('div', { class: 'panel-title' }, 'Level tiles', this.tlCount), this.tlList));
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller, this.eventsBadge), this.strip, this.timeline, this.status);
    this.scroller.addEventListener('scroll', () => { this.cellHistory.close(); this.paint(); });
    new ResizeObserver(() => this.stripToChosen()).observe(this.stripList);
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
    // a level dragged from the list ("Without level tile") onto the map: placed on the cell it is dropped on
    this.scroller.addEventListener('dragover', (e) => {
      if (!this.levelTiles.dragged || this.mode !== 'l1') return;
      e.preventDefault();
      const c = this.cell(e, 16);
      this.mouse = this.point(e);
      if (this.hover?.x !== c.x || this.hover?.y !== c.y) { this.hover = c; this.updateStatus(); this.paint(); }
    });
    this.scroller.addEventListener('drop', (e) => { if (!this.levelTiles.dragged) return; e.preventDefault(); const c = this.cell(e, 16); this.levelTiles.drop(c.x, c.y); });
    this.scroller.addEventListener('mouseleave', () => { this.cellHistory.hover(-1, 0, 0, false); this.mouse = null; if (!this.brushDrag.active) { this.hover = null; this.updateStatus(); this.paint(); } });
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    // Q released (or the window left, its keyup never comes): the layer not painted shown again
    window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'q') this.setSolo(false); });
    window.addEventListener('blur', () => this.setSolo(false));
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay), undefined, undefined, pixelZoomSteps);
    // the map's animation: its next step (or the still map) on the map, also while painting
    this.anim = new OwAnimPlayer(app, () => this.root.isConnected);
    this.anim.on('anim-frame', () => { if (this.root.isConnected && this.putLayers()) { this.composeMap(); this.paint(); } });
    // a ROM edit (a stroke ended, a name chosen) or undo/redo that changed what the view was built from (its watch):
    // shown as in the ROM (a stroke being painted is dropped)
    this.watch = app.watchRom(() => {
      if (!this.root.isConnected) return;
      if (this.brushDrag.painting) { this.brushDrag.drop(); this.stroke = null; }
      this.sync();
    });
    // any ROM edit: the map's load asked for again if it no longer holds (drawn when it comes); the World check checks
    // again (also after an edit the view's watch doesn't follow)
    app.on('rom-change', () => { if (this.root.isConnected) { this.render(); this.check.update(); } });
    // whether the game draws the editor's messages came (the level tile's message boxes)
    app.on('message-routine', () => { if (this.root.isConnected) this.sync(); });
  }

  setZoom(z: number, ax = this.scroller.clientWidth / 2, ay = this.scroller.clientHeight / 2): void {
    this.cellHistory.close();
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
  // the mode's cells: layer 1's 32x32, layer 2's 64x64
  private get cells(): { w: number; h: number } {
    return this.mode === 'l2' ? { w: 64, h: 64 } : { w: 32, h: 32 };
  }

  get region(): number {
    return this.map > 0 ? 1 : 0;
  }

  // the load of the map at the event progress, undefined while it is emulated (asked for: it is shown when it comes)
  load(): OwRender | undefined {
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
    if (this.mode === 'l2') this.buildSide(); // (the pieces on this map)
    this.paint();
    if (this.pendingTile >= 0) { const i = this.pendingTile; this.pendingTile = -1; this.showTile(i); }
  };
  // the submap layer 1 tile i is on when only the tile is known (submapOf: ambiguous where the submaps' views overlap);
  // while the submaps' views are learned the first of its region (0 or 1): only for what is drawn, edits wait for the
  // views (onDown)
  submapAt(i: number): number {
    const v = this.views;
    return v ? submapOf(v, i) : i >= 0x400 ? 1 : 0;
  }
  // the submap of layer 1 tile i where the user acts on the map: the one shown when i shows in its view (submapShown),
  // else as submapAt
  submapHere(i: number): number {
    const v = this.views;
    return v ? submapShown(v, i, this.map) : this.submapAt(i);
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
    if (exact && this.ev && !this.ev.l1) { this.ev.l1 = gameL1(r); this.ev.game = this.ev.l1.slice(); }
    this.shown = shownMaps(r, this.region, this, from, this.ev);
    const tcs = owTileCaches(r), rom = this.app.rom;
    this.layerPx = { r, l1: drawOwMap(rom, r, this.region, this.shown.l1, undefined, tcs), l2: drawOwMap(rom, r, this.region, undefined, this.shown.l2, tcs) };
    this.anim.follow(this.map, this.progress, r);
    this.putLayers(true);
    this.composeMap();
    this.paint();
    this.check.update();
  }

  // the layers on their canvases, as the animation's step shown has them (the still map when none is): whether one
  // changed (always: both are put anyway); a layer that shows as before is not put again
  private putLayers(always = false): boolean {
    const p = this.layerPx;
    if (!p) return false;
    const step = this.anim.animStep(), anim = step && this.anim.animationFor(p.r);
    const l1 = (anim && step && anim.stepLayer(p.l1, 1, this.region, this.shown.l1, step)) || p.l1;
    const l2 = (anim && step && anim.stepLayer(p.l2, 2, this.region, this.shown.l2, step)) || p.l2;
    const was = this.layersPut;
    this.layersPut = { l1, l2 };
    const put1 = always || was?.l1 !== l1, put2 = always || was?.l2 !== l2;
    if (put1) putImage(this.l1Canvas, l1, 512, 0);
    if (put2) putImage(this.l2Canvas, l2);
    return put1 || put2;
  }
  private layersPut: { l1: Uint32Array; l2: Uint32Array } | null = null; // what putLayers put last

  // the map image from its layers, each at the strength the mode, Q and the view switches give it (layerStrengths)
  private composeMap(): void {
    composeLayers(this.mapCanvas, this.l1Canvas, this.l2Canvas, this.strengths());
  }
  private strengths(): LayerStrengths {
    return layerStrengths({ mode: this.mode, dimL2: this.dimL2, l1InL2: this.l1InL2, solo: this.solo });
  }
  // Q held (or released): layer 2 hidden while layer 1 is painted, layer 1 switched the other way while layer 2 is (or
  // back again)
  private setSolo(on: boolean): void {
    if (this.solo === on) return;
    this.solo = on;
    this.composeMap();
    this.paint();
    this.updateStatus();
  }

  drawL1Tile(img: Uint32Array, tc: TileCache, t: number, px: number, py: number, W = 512, H = 512): void {
    drawL1Tile(this.app.rom, img, tc, t, px, py, W, H);
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
    this.nameEditor.place();
    // (the map's pixels where owShownAt shows them: the submaps' region moved, wrapping)
    for (const o of owShownCopies(this.region)) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 512, 512);
      ctx.clip();
      ctx.translate(o.x, o.y);
      this.paintMap(ctx, lw);
      ctx.restore();
    }
  }
  // what paint draws in the map's pixels
  private paintMap(ctx: CanvasRenderingContext2D, lw: number): void {
    if (this.playing) this.paintPlay(ctx);
    else ctx.drawImage(this.mapCanvas, 0, 0);
    // (layer 1's overlays – unreached tiles, level numbers, path marks – at its strength: dimmed or gone with it)
    const s1 = this.strengths();
    if (!this.playing && s1.l1) { ctx.globalAlpha = s1.l1; this.reach.paint(ctx); ctx.globalAlpha = 1; }
    if (this.showGrid) {
      const step = this.cellSize;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i <= 512; i += step) { ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.moveTo(0, i); ctx.lineTo(512, i); }
      ctx.stroke();
    }
    // level tile labels: the level each enters (in orange where another tile enters it too); on layer 1 hatched (a
    // stroke leaves them: they are objects on top of it)
    const levels = this.levelL1(), shared = sharedTranslevels(levels, this.tls, this.isLevelTile);
    if (this.mode === 'l1') this.hatchLevelTiles(ctx, levels, lw);
    ctx.font = `bold ${8}px monospace`;
    ctx.globalAlpha = s1.l1;
    if (s1.l1) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y), tl = this.tls[i];
      if (!this.isLevelTile(levels[i])) continue;
      ctx.fillStyle = i === this.selected ? 'rgba(76,194,255,0.85)' : shared.has(tl) || !tl ? 'rgba(230,120,0,0.85)' : 'rgba(0,0,0,0.6)';
      ctx.fillRect(x * 16, y * 16 + 10, 16, 7);
      ctx.fillStyle = '#fff';
      ctx.fillText(tl ? hex(translevelToLevel(tl), 3) : '---', x * 16 + 1, y * 16 + 16);
    }
    ctx.globalAlpha = s1.marks;
    if (s1.marks) this.paintPaths(lw);
    ctx.globalAlpha = 1;
    if (this.mode === 'sprites' || this.showSprites) this.sprites.paint(ctx, lw);
    // (the overworld links: layer 1's objects, its marks and the selected tile's arrows, dimmed or gone with it, #413)
    if (this.mode !== 'sprites' && s1.l1) { ctx.globalAlpha = s1.l1; this.links.paint(ctx, lw); ctx.globalAlpha = 1; }
    if (this.mode !== 'sprites' && s1.l1) this.paintSelected(lw);
    this.nameEditor.paint(ctx, lw);
    this.hatchRefused(ctx, lw);
    this.paintMovePreview(ctx, lw);
    this.paintStep(lw);
    const s = this.cellSize;
    if (this.mode === 'l1') this.exits.paint(ctx, lw);
    if (this.mode === 'sprites') {
      // the sprites show what is under the mouse
    } else if (this.levelTiles.moving) {
      this.levelTiles.paint(ctx, lw);
    } else if (this.links.pending || this.links.drag) {
      if (this.hover) drawBrushFrame(ctx, 'hover', [this.hover.x * 16, this.hover.y * 16, 16, 16], lw);
    } else {
      // the cells being picked, else the area the brush would paint (a look as the brush, or a level tile under the
      // mouse: the one cell)
      const at = this.hover, one = !!at && (this.lookBrush >= 0 || (this.mode === 'l1' && this.levelTiles.at(at.x, at.y)));
      const pick = this.brushDrag.pickFrame(), r = pick ? this.clampRect(pick) : at && (one ? { x: at.x, y: at.y, w: 1, h: 1 } : this.brushDrag.hoverFrame(at));
      const sel = !pick ? this.l2Sel : null; // (the layer 2 selection: where "Replace piece…" replaces)
      if (sel) drawBrushFrame(ctx, 'selection', [sel.x * s, sel.y * s, sel.w * s, sel.h * s], lw);
      // (a piece being picked for "Replace piece…": the grid cell under the mouse)
      if (this.replacing && this.hover && !pick) drawBrushFrame(ctx, 'hover', [(this.hover.x & ~1) * s, (this.hover.y & ~1) * s, 2 * s, 2 * s], lw);
      else if (r && (pick || one || !this.routeBrush)) drawBrushFrame(ctx, pick ? 'pick' : 'hover', [r.x * s, r.y * s, r.w * s, r.h * s], lw);
      if (this.mode === 'l1') this.pathTool.paint(ctx, lw);
    }
  }

  // ---- a pick pending (#348) ----
  // While a cell is to be picked – the tile a reveal or destroy is added to, where a level tile is dragged or a level
  // dropped, a link's target – the cells it would refuse are hatched, the reason shown over them; a click there is
  // refused as before. Each pick's checks (core: revealPickCheck, destroyPickCheck, moveLevelTileCheck,
  // placeLevelTileCheck, linkTargetCheck) run once per cell of the map shown, kept while the pick and the ROM stay.
  private pickMemo: { key: string; dep: unknown; gen: number; region: number; why: (OwRefusalData | null)[] } | null = null;
  private pickCheck(): PickCheck | null {
    const rom = this.app.rom, pick = this.eventPick, e = this.event;
    if (pick && pick.at < 0) return pick.kind === 'reveal' ? { key: `reveal:${e}`, make: () => revealPickCheck(rom, e) }
      : { key: `destroy:${e}`, dep: this.shown.l1, make: () => destroyPickCheck(rom, e, this.shown.l1) };
    if (this.levelTiles.moving) return this.levelTiles.pickCheck();
    if (this.links.drag || this.links.pending) return this.links.pickCheck();
    return null;
  }
  // why each cell of the map shown (l1Index − region × 0x400) can't be picked (null: it can); null: no pick pending
  pickRefusals(): (OwRefusalData | null)[] | null {
    const p = this.pickCheck();
    if (!p) return null;
    const gen = this.app.rom.gen, m = this.pickMemo, region = this.region;
    if (m && m.key === p.key && m.dep === p.dep && m.gen === gen && m.region === region) return m.why;
    const check = p.make(), base = region * 0x400;
    const why = Array.from({ length: 0x400 }, (_, k) => check(base + k));
    this.pickMemo = { key: p.key, dep: p.dep, gen, region, why };
    return why;
  }
  // why the cell under the mouse can't be picked (null: it can, or no pick pending)
  // (a level tile dragged off the map lands on the edge: that cell's)
  private pickRefusalAtMouse(): OwRefusalData | null {
    const m = this.mouse, clamp = (v: number) => Math.max(0, Math.min(31, Math.floor(v / 16)));
    if (!m || (!this.levelTiles.drag && (m.x < 0 || m.y < 0 || m.x >= 512 || m.y >= 512))) return null;
    const why = this.pickRefusals();
    return why ? why[l1Index(0, clamp(m.x), clamp(m.y))] : null;
  }
  private hatchRefused(ctx: CanvasRenderingContext2D, lw: number): void {
    const why = this.pickRefusals();
    if (!why) return;
    const at: { x: number; y: number }[] = [];
    why.forEach((w, k) => { if (w) { const p = l1XY(k); at.push({ x: p.x * 16, y: p.y * 16 }); } });
    hatchCells(ctx, at, 16, lw);
  }

  // the level tiles of layer 1 `levels` on the map shown lightly hatched
  private hatchLevelTiles(ctx: CanvasRenderingContext2D, levels: ArrayLike<number>, lw: number): void {
    const at: { x: number; y: number }[] = [];
    const links = this.links.cells(); // (link ends too: objects as well, #413)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y);
      if (this.isLevelTile(levels[i]) || links.has(i)) at.push({ x: x * 16, y: y * 16 });
    }
    hatchCells(ctx, at, 16, lw);
  }

  // the kinds of the layer 1 tiles, as the game sees them (null while they are learned)
  private kinds: { gen: number; kinds: PathKind[] } | null = null;
  // (the level tiles come with them: their labels, the list, the selected tile's settings)
  private kindsLearned = () => { if (!this.root.isConnected) return; this.paint(); this.updateStatus(); this.buildSide(); this.buildLeft(); this.check.update(); };
  pathKinds(): PathKind[] | null {
    const gen = this.app.rom.gen;
    if (this.kinds?.gen !== gen) {
      const kinds = this.app.pathKinds(this.kindsLearned);
      if (!kinds) return null;
      this.kinds = { gen, kinds };
    }
    return this.kinds.kinds;
  }
  // how the path tiles move Mario (owpaths.ts path shapes: the lines of their marks, the popup's words; null while they
  // are learned)
  private shapes: { gen: number; shapes: PathShapes } | null = null;
  private shapesLearned = () => { if (!this.root.isConnected) return; this.paint(); this.updateStatus(); if (this.mode === 'l1') this.buildSide(); };
  pathShapes(): PathShapes | null {
    const gen = this.app.rom.gen;
    if (this.shapes?.gen !== gen) {
      const shapes = this.app.pathShapes(this.shapesLearned);
      if (!shapes) return null;
      this.shapes = { gen, shapes };
    }
    return this.shapes.shapes;
  }
  // (the selected level tile's settings say which exits skip the reveal walk once that is learned)
  private revealWalksLearned = () => { if (this.root.isConnected) this.buildSide(); };
  // what the stars' translevels follow (owstars.ts): the path kinds and shapes (null while the kinds are learned)
  starPaths(): StarPaths | null {
    const kinds = this.pathKinds();
    return kinds && { kinds, shapes: this.pathShapes() };
  }
  // whether layer 1 tile t is a level tile (owpaths.ts levelTileTest; none while the path tiles are learned)
  isLevelTile = (t: number): boolean => this.pathKinds()?.[t] === 'level';
  // a ROM limit's budget (owbudget.ts; per submap: the one shown), for the gauge beside the action it stops
  // (kept per ROM state, submap and whether the path kinds are known; what they read counted for the view's watch)
  private budgetMemo = new StateMemo<Budget[]>();
  budget(key: BudgetKey): Budget | undefined {
    const kinds = this.pathKinds();
    return this.budgetMemo.get(this.app.rom, `${this.map}:${kinds ? 1 : 0}`, () => owBudgets(this.app.rom, this.map, kinds)).find((b) => b.key === key);
  }

  // the path tiles of the map shown, a mark per kind (as Lunar Magic's "Layer 1 Mario Paths"): walk green, climb
  // green with rungs, swim blue, exit red, stop a cross; the tile's shape as lines (once the shapes are learned): where
  // Mario walks over the cell (owpathshape.ts mapWays: a straight tile at the height the tile before leaves him), else
  // the tile's usual lines (usualWays)
  paintPaths(lw: number): void {
    const kinds = this.pathKinds();
    if (!kinds) return;
    const ctx = this.canvas.getContext('2d')!, l1 = this.shown.l1, shapes = this.pathShapes(), walked = this.walkedWays();
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y), t = l1[i], k = kinds[t];
      if (isPathKind(k)) drawPathMark(ctx, k, x * 16, y * 16, lw, walked.get(i) ?? usualWays(t, k, shapes, l1, walked));
    }
  }
  // the ways Mario takes over each path tile of the maps shown (owpathshape.ts mapWays; none while the path kinds and
  // shapes are learned)
  walkedWays(l1: ArrayLike<number> = this.shown.l1): Map<number, PathWay[]> {
    const kinds = this.pathKinds(), shapes = this.pathShapes();
    return kinds && shapes ? mapWays(l1, kinds, shapes) : new Map();
  }

  // the cells a change being moved from a cell's history takes along (green; red where the move is refused)
  private paintMovePreview(ctx: CanvasRenderingContext2D, lw: number): void {
    const m = this.movePreview;
    if (!m) return;
    ctx.lineWidth = 2 * lw;
    ctx.strokeStyle = m.refused ? '#ff5050' : '#5cff7a';
    ctx.fillStyle = m.refused ? 'rgba(255,80,80,0.25)' : 'rgba(92,255,122,0.25)';
    for (const i of m.cells) {
      if ((i >= 0x400) !== (this.region === 1)) continue;
      const { x, y } = l1XY(i);
      ctx.fillRect(x * 16, y * 16, 16, 16);
      ctx.strokeRect(x * 16 + lw, y * 16 + lw, 16 - 2 * lw, 16 - 2 * lw);
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
    if (!this.isLevelTile(this.levelL1()[i]) || !tl) return;
    this.paintExitResults(ctx, lw, i, tl);
    this.paintClause(ctx, lw);
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
  // the map's pixel under the mouse (owMapAt)
  point(e: MouseEvent): { x: number; y: number } {
    const rc = this.scroller.getBoundingClientRect();
    return owMapAt(this.region, Math.floor((e.clientX - rc.left + this.scroller.scrollLeft) / this.zoom), Math.floor((e.clientY - rc.top + this.scroller.scrollTop) / this.zoom));
  }

  // the mode's cell under the mouse (with `s`: the map's cells of that size)
  cell(e: MouseEvent, s?: number): { x: number; y: number } {
    const p = this.point(e), z = s ?? this.cellSize;
    return { x: Math.floor(p.x / z), y: Math.floor(p.y / z) };
  }

  // same buttons as in the level editor: click/drag takes tiles into the brush, right-click/Shift+click paints
  onDown(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const rc = this.scroller.getBoundingClientRect();
    if (e.clientX - rc.left > this.scroller.clientWidth || e.clientY - rc.top > this.scroller.clientHeight) return;
    // a reveal or destroy being added: the tile clicked
    if (this.eventPick && this.eventPick.at < 0 && e.button === 0) { const p = this.cell(e, 16); this.pickEventCell(p.x, p.y); return; }
    const c = this.cell(e);
    // "Replace piece…": the piece clicked on the map (the 16-pixel grid's cell under the mouse)
    if (this.replacing && e.button === 0) {
      if (c.x >= 0 && c.y >= 0 && c.x < this.cells.w && c.y < this.cells.h) this.pickReplace(l2Block(this.paintedL2(), this.region, c.x & ~1, c.y & ~1));
      return;
    }
    // (moved starts are written with the submap of their tiles: not before the submaps' views are known)
    if (this.mode === 'sprites' && !this.views) return;
    if (this.mode === 'sprites') { if (e.button === 0) { const p = this.point(e); this.sprites.down(p.x, p.y); } return; }
    // the overworld links (#413): a tile to link to chosen (pending), the selected link's other end, location or Koopa
    // Kid's place dragged
    if (e.button === 0 && this.links.pickPending(c.x, c.y, e.clientX, e.clientY)) return;
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey;
    if (this.mode === 'l1' && e.button === 0 && plain && this.links.grab(c.x, c.y)) return;
    // (a name being typed: the click closes it, written; a click on the selected level tile's name edits it)
    if (this.mode === 'l1' && e.button === 0 && this.nameEditor.down(this.point(e))) return;
    // the level tiles, objects on top of layer 1 (ADR 0012)
    this.menuAt = null;
    if (this.mode === 'l1') {
      const level = this.levelTiles.at(c.x, c.y);
      // a right click (or Shift+click) on a level tile, any brush: its menu (the route brush: once released without a
      // drag – a route may start there)
      if (paintButton(e) && level) {
        const menu = { cx: e.clientX, cy: e.clientY, x: c.x, y: c.y };
        if (this.routeBrush) { this.pathTool.down(c.x, c.y); if (this.pathTool.drawing) { this.menuAt = menu; return; } }
        this.levelTiles.menu(menu.cx, menu.cy, menu.x, menu.y);
        return;
      }
      // a link end (not a level tile): an object too – a right click its menu, a click selects it (#413)
      const cell = c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32 ? l1Index(this.region, c.x, c.y) : -1;
      if (!level && cell >= 0 && this.links.cells().has(cell)) {
        if (paintButton(e)) {
          // (the route brush: once released without a drag – a route may start there)
          if (this.routeBrush) { this.pathTool.down(c.x, c.y); if (this.pathTool.drawing) { this.menuAt = { cx: e.clientX, cy: e.clientY, x: c.x, y: c.y }; return; } }
          this.linkMenu(cell, e.clientX, e.clientY);
          return;
        }
        if (e.button === 0 && plain) { this.selectTile(cell, false); return; }
      }
      // a look as the brush: "Place level here…" with it (a drag places nothing more)
      if (paintButton(e) && this.lookBrush >= 0) {
        if (c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32) this.levelTiles.placeDialog(l1Index(this.region, c.x, c.y), this.lookBrush);
        return;
      }
      // a click on a level tile selects it, a drag moves it (a pick starts beside one)
      if (e.button === 0 && level && !e.shiftKey && !e.altKey && !e.ctrlKey) { this.levelTiles.down(c.x, c.y); this.updateStatus(); this.paint(); return; }
      // (a pick beside one: the level tile selected no longer – Delete would remove it unseen)
      if (e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && this.selected >= 0 && this.isLevelTile(this.levelL1()[this.selected])) this.selectTile(-1, false);
    }
    if (paintButton(e)) {
      // (the route brush: the route drawn)
      if (this.routeBrush) { this.pathTool.down(c.x, c.y); return; }
      // (a stroke leaves level tiles alone: not before the level tiles are known)
      if (this.mode === 'l1' && !this.pathKinds()) { toast('The path tiles are still being learned – layer 1 can be painted in a moment.'); return; }
      if (this.mode === 'l1' && this.ev?.without === null) { toast('Layer 1 can\'t be painted on this event: the map without its layer 1 changes could not be emulated.', 'error'); return; }
      if (this.mode === 'l1' && this.ev && !this.evL1Ready()) { toast('The map after the event is still being emulated – layer 1 can be painted in a moment.'); return; }
      this.stroke = this.newStroke(this.mode);
      this.brushDrag.startPaint(c);
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey || (this.mode === 'l1' && e.ctrlKey)) { this.info(c.x, c.y); return; }
    this.brushDrag.startPick(c);
    this.paint();
  }

  // a double click on a level tile opens its level (the overworld's entry in the navigation keeps the tile); level
  // tiles are layer 1's 16x16 cells in every mode
  onDouble(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const { x, y } = this.cell(e, 16);
    if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
    const i = l1Index(this.region, x, y), tl = this.tls[i];
    if (!this.isLevelTile(this.levelL1()[i]) || !tl) return;
    this.brushDrag.drop();
    this.selectTile(i, false);
    this.onOpenLevel(translevelToLevel(tl));
  }

  onMove(e: MouseEvent): void {
    const inside = e.target === this.scroller || e.target === this.canvas;
    if (inside) {
      this.mouse = this.point(e);
      const c = this.cell(e, 16), on = c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32;
      this.cellHistory.hover(on ? l1Index(this.region, c.x, c.y) : -1, e.clientX, e.clientY, e.buttons !== 0 || this.dragging() || !!this.sprites.drag);
    }
    if (this.sprites.drag) { const p = this.point(e); this.sprites.move(p.x, p.y, e.shiftKey); return; }
    if (!inside && !this.dragging()) return;
    const c = this.cell(e);
    if (this.hover && this.hover.x === c.x && this.hover.y === c.y) return;
    this.hover = c;
    this.menuAt = null; // (dragged: a route, no menu)
    if (this.levelTiles.drag) this.levelTiles.move(c.x, c.y);
    this.updateStatus();
    if (this.links.drag) { this.links.move(c.x, c.y); return; }
    if (this.levelTiles.moving) { this.paint(); return; }
    if (this.pathTool.drawing) { this.pathTool.move(c.x, c.y); return; }
    this.brushDrag.move(c);
    this.paint();
  }

  // a stroke, a pick, a link or a level tile or a route being dragged (followed off the map too)
  private dragging(): boolean {
    return this.brushDrag.active || !!this.links.drag || !!this.levelTiles.drag || this.pathTool.drawing;
  }

  onUp(e: MouseEvent): void {
    if (this.links.drag) { this.links.up(e.clientX, e.clientY); return; }
    if (this.sprites.drag) { const p = this.point(e); this.sprites.up(p.x, p.y); return; }
    if (this.levelTiles.drag) { this.levelTiles.up(e.altKey); return; }
    if (this.pathTool.drawing) {
      this.pathTool.up();
      const m = this.menuAt;
      this.menuAt = null;
      // (a right click on a level tile or link end with the route brush)
      if (m) { if (this.levelTiles.at(m.x, m.y)) this.levelTiles.menu(m.cx, m.cy, m.x, m.y); else this.linkMenu(l1Index(this.region, m.x, m.y), m.cx, m.cy); }
      return;
    }
    this.brushDrag.up();
  }
  // a right press on a level tile or link end with the route brush: its menu once released without a drag (null: none, or dragged)
  private menuAt: { cx: number; cy: number; x: number; y: number } | null = null;

  // a picked rectangle clamped to the mode's cells
  clampRect(r: CellRect): CellRect {
    const n = this.cells, x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(n.w - 1, r.x + r.w - 1), y1 = Math.min(n.h - 1, r.y + r.h - 1);
    return { x: Math.min(x0, n.w - 1), y: Math.min(y0, n.h - 1), w: Math.max(1, x1 - x0 + 1), h: Math.max(1, y1 - y0 + 1) };
  }

  // a stroke on layer `layer` begun: into the map before events, or as after the event chosen in the playthrough strip
  private newStroke(layer: 'l1' | 'l2'): OverworldStroke {
    return new OverworldStroke(this.app.rom, layer, this, this.isLevelTile,
      this.ev && { event: this.event, after: this.ev.after, l1: this.ev.l1, game: this.ev.game, without: this.ev.without, place: () => this.place(this.event) },
      layer === 'l1' ? this.starPaths() : null, layer === 'l1' ? (i) => this.links.cells().has(i) : undefined);
  }

  // the layer 2 a stroke paints: as after the event chosen in the playthrough strip, or the map before events
  private paintedL2(): Uint16Array {
    return this.ev ? this.ev.after : this.l2;
  }

  // "Replace piece…" (#370): the piece to replace picked, then the new one (on the map or in "Pieces on this map")
  private startReplace(): void {
    this.replacing = { from: null };
    this.buildSide();
    this.updateStatus();
  }
  // Esc or the button again: nothing replaced; false: none under way
  private cancelReplace(): boolean {
    if (!this.replacing) return false;
    this.replacing = null;
    this.buildSide();
    this.updateStatus();
    this.paint();
    return true;
  }
  private pickReplace(p: number[]): void {
    const r = this.replacing;
    if (!r) return;
    if (!r.from) r.from = p.slice();
    else { this.replacing = null; void this.replacePieces(r.from, p); }
    this.buildSide();
    this.updateStatus();
    this.paint();
  }
  // every piece `from` on its grid wholly inside the layer 2 selection (none: the submap's whole view, after a
  // confirmation naming the count) becomes `to` (core/owl2pieces.ts replacePiece): one stroke, one ROM edit; in an
  // event painted as the map after it
  private async replacePieces(from: number[], to: number[]): Promise<void> {
    if (samePiece(from, to)) { refusalToast(this.app.rom, { kind: 'pieceSame' }); return; }
    const views = this.views;
    if (!views) { toast('The submaps are still being loaded, try again'); return; }
    const sel = this.l2Sel, inside = sel && gridInside(sel);
    if (sel && !inside) { refusalToast(this.app.rom, { kind: 'pieceNoneInside' }); return; }
    const area = () => inside ?? views[this.map];
    const n = piecesAt(this.paintedL2(), this.region, area(), from).length;
    if (!n) { refusalToast(this.app.rom, { kind: 'pieceNotFound', selection: !!sel }); return; }
    if (!sel) {
      const map = this.map, ev = this.event;
      const ok = await choose('Replace piece', `Replace ${n === 1 ? 'the 1 piece' : `all ${n} pieces`} of this kind on the whole map${this.ev ? ` (as after event ${hex(this.event, 2)})` : ''} with the new one? (undoable; to replace only in a part of the map, select a rectangle on it first)`,
        [{ label: `Replace ${n}`, primary: true }, { label: 'Cancel' }]);
      if (ok !== 0 || map !== this.map || ev !== this.event || this.brushDrag.painting) return;
    }
    const stroke = this.stroke = this.newStroke('l2');
    const done = replacePiece(this.paintedL2(), this.region, area(), from, to, (x, y, v) => stroke.paint(this.region, x, y, v));
    if (!done) { this.stroke = null; stroke.cancel(); return; }
    if (this.endStroke(this.ev ? `${eventTitle(eventRunners(this.app.rom), this.event)}: replace layer 2 piece` : 'Replace layer 2 piece'))
      toast(`Replaced ${done} piece${done === 1 ? '' : 's'}`);
  }

  // a stroke is one ROM edit, written when it ends (owstroke.ts)
  endStroke(label?: string): boolean {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke) return false;
    const end = stroke.end();
    if (!end.write) return false;
    try {
      this.app.romEdit(label ?? end.label, end.write);
      return true;
    } catch (e) {
      refusedToast(this.app.rom, e, 'Not painted: ');
      this.sync();
      return false;
    }
  }

  // the brush stamped at cell (x, y) into the stroke; whether a cell changed
  paintAt(x: number, y: number): boolean {
    const b = this.brush;
    if (b.kind !== this.mode) return false;
    if (this.mode === 'l1' && this.ev && !this.evL1Ready()) return false; // (the maps the event is painted with are still emulated)
    const n = this.cells;
    let changed = false;
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n.w || yy >= n.h) continue;
      const v = b.entries[dy * b.w + dx];
      if (this.stroke?.paint(this.region, xx, yy, v)) changed = true;
    }
    return changed;
  }

  // cells picked from the map as the brush; on layer 1 level tiles left out (ADR 0012: objects on top of layer 1) – one
  // cell picked that is a level tile selects it
  pick(r: { x: number; y: number; w: number; h: number }): void {
    const src = this.mode === 'l2' ? this.shown.l2 : this.shown.l1;
    const idx = this.mode === 'l2' ? l2Index : l1Index;
    const at = Array.from({ length: r.w * r.h }, (_, i) => idx(this.region, r.x + (i % r.w), r.y + Math.floor(i / r.w)));
    let entries = at.map((i) => src[i]);
    if (this.mode === 'l1') {
      const levels = this.levelL1();
      if (at.length === 1 && this.isLevelTile(levels[at[0]])) { this.selectTile(at[0], false); return; }
      const left = l1BrushEntries(at.map((i, k) => (this.isLevelTile(levels[i]) ? levels[i] : entries[k])), this.isLevelTile);
      if (!left) { toast(LEVEL_TILES_BRUSH); this.paint(); return; }
      entries = left;
    }
    this.brush = { kind: this.mode === 'l2' ? 'l2' : 'l1', w: r.w, h: r.h, entries };
    this.endRouteBrush();
    if (this.mode === 'l2') {
      const p = l2BrushPalettes(entries);
      if (p.length === 1) this.l2Pal = p[0]; // (the sheet in the brush's palette)
      this.l2Sel = r.w * r.h > 4 ? { ...r } : null; // (a click, a piece picked as the brush: no selection)
    }
    this.revealMark = true;
    this.buildSide();
    this.paint();
  }

  info(x: number, y: number): void {
    if (this.mode !== 'l1') { toast('Tile settings are available on layer 1'); return; }
    if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
    this.selectTile(l1Index(this.region, x, y), false);
  }

  // shows layer 1 tile i (l1Index) selected, on the submap it is on (only the tile known: submapOf, as the World
  // check's problems name it)
  showTile(i: number): void {
    const views = this.views;
    if (!views) { this.pendingTile = i; return; } // (shown when they come)
    this.setMap(submapOf(views, i));
    this.selectTile(i, true);
  }

  // selects a layer 1 tile (a level tile in the list, any tile by Alt/Ctrl+click; l1Index); center: scroll the map to it
  selectTile(i: number, center: boolean): void {
    if (i !== this.selected) this.nameEditor.close(true);
    this.selected = i;
    this.links.selectAt(i);
    if (center && i >= 0) {
      const t = l1XY(i), { x, y } = owShownAt(this.region, t.x * 16 + 8, t.y * 16 + 8);
      this.scroller.scrollLeft = x * this.zoom - this.scroller.clientWidth / 2;
      this.scroller.scrollTop = y * this.zoom - this.scroller.clientHeight / 2;
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
    const look = this.lookBrush;
    this.statusStats.textContent = this.routeBrush ? 'Brush Path (auto)' : look >= 0 ? `Brush Level tile ${l1Hex(look)}` : b.kind === this.mode ? `Brush ${b.w}×${b.h}` : '';
    // (a pick pending: a cell it would refuse says why)
    const refused = this.pickRefusalAtMouse();
    // (a link to a tile on another map pending: the next click on the map chooses it)
    this.scroller.style.cursor = refused ? 'not-allowed' : this.links.pending ? 'crosshair' : '';
    if (refused) {
      this.scroller.title = refusalText(this.app.rom, refused);
      this.statusText.textContent = `Can't pick this tile: ${refusalWords(this.app.rom, refused).reason}`;
      return;
    }
    if (this.eventPick) {
      this.statusText.textContent = this.eventPick.at < 0 ? `Click the tile the event ${this.eventPick.kind === 'reveal' ? 'reveals' : 'destroys'} · Esc cancels`
        : 'Click the tile it becomes in the layer 1 sheet · Esc cancels';
      return;
    }
    if (this.replacing) {
      this.statusText.textContent = `${this.replacing.from ? 'Click the new piece' : 'Click the piece to replace'} on the map or in “Pieces on this map” · Esc cancels`;
      return;
    }
    const route = this.mode === 'l1' ? this.pathTool.status() : null;
    if (route && (this.pathTool.drawing || !c)) { this.statusText.textContent = route; return; }
    if (this.mode === 'sprites' && !c) {
      this.statusText.textContent = 'Click: select a sprite, a start position (M, L) or a Koopa Kid\'s place (K1–K3) · Drag moves it (8 pixels, 1 with Shift) · Delete empties a sprite slot';
      return;
    }
    const moving = this.levelTiles.status();
    if (moving) { this.statusText.textContent = moving; return; }
    const exit = this.mode === 'l1' ? this.exits.status() : '';
    if (exit) { this.statusText.textContent = exit; return; }
    if (look >= 0 && !c) {
      this.statusText.textContent = `Level tile ${l1Hex(look)}: Right click/Shift+click on a cell places a level there (Place level here…) · Click/drag picks up tiles (the tile brush again) · P: the route brush`;
      return;
    }
    const linking = this.links.status();
    if (linking) { this.statusText.textContent = linking; return; }
    if (!c) {
      const solo = this.mode === 'l1' ? ' · Hold Q: hide layer 2' : this.mode === 'l2' ? ` · Hold Q: ${this.l1InL2 ? 'hide' : 'show'} layer 1` : '';
      this.statusText.textContent = this.ev
        ? `Painting layer ${this.mode === 'l1' ? 1 : 2} as after ${eventTitle(this.ev.runners, this.event)} · Click/drag picks up tiles · Right click/Shift+click paints · Esc: the map before events${solo}`
        : `Click/drag picks up tiles · Right click/Shift+click paints · Alt/Ctrl+click: tile settings${this.mode === 'l1' ? ' · Level tiles: click selects, drag moves, right click: menu, Delete removes' : ''}${solo}`;
      return;
    }
    let t = `X ${hex(c.x, 2)}  Y ${hex(c.y, 2)}`;
    if (this.mode !== 'l2') {
      if (c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32) {
        const i = l1Index(this.region, c.x, c.y), shown = this.shown.l1[i];
        t += `  ·  Tile ${l1Hex(shown)}`;
        if (this.ev && eventL1Tiles(this.ev.data, this.event).includes(i)) t += ' (by this event)';
        else if (shown !== this.l1[i]) t += ` (by events, ${l1Hex(this.l1[i])} before)`;
        const tl = this.tls[i];
        if (this.isLevelTile(this.levelL1()[i])) {
          t += tl ? `  ·  Level ${hex(translevelToLevel(tl), 3)} “${levelName(this.app.rom, tl)}”` : '  ·  Enters no level';
          if (this.mode === 'l1') t += '  ·  Click: select · Drag: move · Right click: menu · Double click: open';
        }
        const s1 = this.strengths(), k = s1.marks ? this.pathKinds()?.[shown] : undefined;
        if (k && isPathKind(k)) {
          const what = pathTileText(shown, k, this.pathShapes());
          t += `  ·  ${what}`;
          this.scroller.title = what;
        }
        const unreached = s1.l1 ? this.reach.status(i) : '';
        if (unreached) t += `  ·  ${unreached}`;
      }
    } else if (c.x >= 0 && c.y >= 0 && c.x < 64 && c.y < 64) {
      const i = l2Index(this.region, c.x, c.y), shown = this.shown.l2[i];
      t += `  ·  Entry ${hex(shown, 4)}`;
      if (this.ev) { if (shown !== this.ev.before[i]) t += ` (by this event, ${hex(this.ev.before[i], 4)} before)`; }
      else if (shown !== this.l2[i]) t += ` (by events, ${hex(this.l2[i], 4)} before)`;
      // (layer 1's words with it: the path tile and whether Mario gets there, while layer 1 is shown)
      const s1 = this.strengths(), j = l1Index(this.region, c.x >> 1, c.y >> 1), k = s1.marks ? this.pathKinds()?.[this.shown.l1[j]] : undefined;
      if (k && isPathKind(k)) t += `  ·  ${pathTileText(this.shown.l1[j], k, this.pathShapes())}`;
      const unreached = s1.l1 ? this.reach.status(j) : '';
      if (unreached) t += `  ·  ${unreached}`;
    }
    this.statusText.textContent = t;
  }

  // ---------------- the event shown and painted ----------------
  // the badge on the map: the layer painted (in its colour) and where painting goes – on layer 1 also the level tiles'
  // changes – (or, in the sprites mode, the event the map is shown after)
  private showEventBadge(): void {
    const e = this.event, painting = isLayerMode(this.mode);
    const layer = this.mode === 'l1' ? 'Layer 1 (paths, levels & links)' : 'Layer 2', verb = 'painting';
    this.eventsBadge.classList.toggle('show', e >= 0 || painting);
    this.eventsBadge.classList.toggle('ow-l1', this.mode === 'l1');
    this.eventsBadge.classList.toggle('ow-l2', this.mode === 'l2');
    if (e < 0) { if (painting) this.eventsBadge.textContent = `${layer} · ${verb} the map before events`; return; }
    const title = `${eventWords(eventRunners(this.app.rom), e, this.levelWords)} (event ${hex(e, 2)})`;
    this.eventsBadge.textContent = painting ? `${layer} · ${verb} into ${title}` : `The map as after ${title}`;
  }

  // ---------------- painting an event ----------------
  // the map shown and painted as after event e (-1: the map before events), the event progress just after it
  setEvent(e: number): void {
    if (e === this.event) return;
    this.stopPlay();
    this.event = e;
    this.hoverStep = null;
    this.hoverClause = null;
    this.eventPick = null;
    storeEvent(this.app.romName, e);
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
    const ev = this.ev = { data, before, after: applyEvents(before, data, e, e + 1), l1: null, game: null, without: undefined as Uint16Array | null | undefined, runners: eventRunners(rom) };
    ev.without = this.app.layer1Without(e, (v) => { if (this.ev === ev) ev.without = v; });
    this.buildTimeline();
  }
  // layer 1 can be painted on the event: the maps after it with and without its layer 1 changes came
  private evL1Ready(): boolean {
    return !!this.ev?.l1 && !!this.ev.without;
  }
  // the layer 1 the level tiles are edited on: as after the event chosen (while it is emulated the map before events),
  // else the map before events
  levelL1(): Uint16Array {
    return this.ev?.l1 ?? this.l1;
  }
  // the event level tiles are placed, moved and removed in (owleveltiles.ts LevelTileEvent): null on the map before
  // events; a string while it can't be (why)
  levelEvent(): LevelTileEvent | string | null {
    const ev = this.ev;
    if (!ev) return null;
    if (ev.without === null) return 'Level tiles can\'t be changed in this event: the map without its layer 1 changes could not be emulated.';
    if (!ev.l1 || !ev.without) return 'The map after the event is still being emulated – level tiles can be changed in a moment.';
    return { event: this.event, after: ev.l1, without: ev.without, isLevelTile: this.isLevelTile };
  }
  // (null while the submaps' views are learned)
  private place(e: number) {
    const views = this.views;
    return views && eventPlace(this.ev!.runners, views, e, this.map);
  }
  // a level by its name ("Level 105" while it has none): the words the strip and the badge name a level exit in
  levelWords = (tl: number): string => hasLevelName(this.app.rom, tl) ? levelName(this.app.rom, tl) : `Level ${hex(translevelToLevel(tl), 3)}`;
  // The playthrough strip under the map (ADR 0013): "Before events", then every event in number order labelled by the
  // level exit running it (playthroughStrip), the chosen one marked with "▶ Test play from here" after it; ‹ › (, .)
  // one back/further, scrolled to keep the chosen one in view
  private buildStrip(): void {
    const list = this.stripList;
    const chip = (x: StripEntry) => h('button', {
      class: `ow-strip-chip${x.event === this.event ? ' active' : ''}${x.event >= 0 && !x.number ? ' unrun' : ''}`,
      'data-event': String(x.event), // (a change dragged from a cell's history drops on it)
      title: `${x.label}${x.others.length ? ` (also run by ${x.others.join(', ')})` : ''} – the map as after loading a save in which the events up to this one passed, in their number order as the game does; what is painted goes into ${x.event < 0 ? 'the map before events' : 'this event'}`,
      onclick: () => this.setEvent(x.event),
    }, x.label, x.number ? h('small', null, ` ${x.number}`) : null);
    const items = playthroughStrip(eventRunners(this.app.rom), this.levelWords).flatMap((x) => x.event !== this.event ? [chip(x)]
      : [chip(x), h('button', { class: 'ow-strip-test', title: 'Test play from the selected tile with a save at this progress (T)', onclick: () => this.onTestPlay() }, '▶ Test play from here')]);
    list.replaceChildren(...items);
    const step = (d: number, label: string, title: string) => h('button', { class: 'ow-strip-step', title, disabled: stepEvent(this.event, d) === this.event, onclick: () => this.setEvent(stepEvent(this.event, d)) }, label);
    this.strip.replaceChildren(step(-1, '‹', 'One event back (,)'), list, step(1, '›', 'One event further (.)'));
    this.stripToChosen();
  }
  // the chosen entry and its test play button scrolled into the strip's view (also when the strip comes into sight:
  // built while hidden it has no width)
  private stripToChosen(): void {
    const list = this.stripList, at = list.querySelector<HTMLElement>('.active'), end = list.querySelector<HTMLElement>('.ow-strip-test') ?? at;
    if (!at || !end || !list.clientWidth) return;
    const view = list.getBoundingClientRect(), from = at.getBoundingClientRect().left - view.left, to = end.getBoundingClientRect().right - view.left;
    if (from < 0 || to > view.width) list.scrollLeft += from - Math.max(0, (view.width - (to - from)) / 3);
  }
  private editSteps(what: string, order: number[]): void {
    const rom = this.app.rom, e = this.event;
    this.app.romEdit(`${eventTitle(this.ev!.runners, e)}: ${what}`, () => writeEvents(rom, reorderSteps(readEvents(rom), e, order)));
  }

  // the steps under the map: the animated ones in their order (drag to reorder), the silent ones, the layer 1
  // changes, the tile the event reveals and those it destroys; hovering one outlines its tiles
  // (what it reads watched too: built again on its own after the last sync)
  buildTimeline(): void {
    this.watch.add(() => this.buildTimelineNow());
  }
  private buildTimelineNow(): void {
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
        budgetGauge(this.budget('eventStorage'), 'Tile storage'),
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
      h('div', { class: 'ow-steps' }, ...this.tileChanges(hover)),
    );
  }

  // the tile the event reveals and those it destroys, each with a remove button (a click shows the tile), "+ Reveal"
  // and "+ Destroy" – or, while one is added, what to pick
  private tileChanges(hover: (kind: StepKind, k: number) => object): (HTMLElement | null)[] {
    const rom = this.app.rom, e = this.event, pick = this.eventPick;
    if (pick) {
      const at = pick.at, into = at >= 0 ? revealedTile(rom, this.l1[at]) : -1;
      return [
        h('span', { class: 'hint' }, at < 0 ? `Click the tile on the map the event ${pick.kind === 'reveal' ? 'reveals' : 'destroys'}`
          : `Pick in the layer 1 sheet the tile ${l1Hex(this.l1[at])} at ${cellText(at)} becomes when revealed`),
        at >= 0 && into >= 0 ? h('button', { title: 'Reveal it into what the reveal list turns its tile into', onclick: () => this.pickReveal(into) }, `Becomes ${l1Hex(into)} (as the reveal list has it)`) : null,
        h('button', { title: 'Add nothing (Esc)', onclick: () => this.cancelEventPick() }, 'Cancel'),
      ];
    }
    const reveal = eventReveal(rom, e), destroys = hasDestroyPatch(rom) ? eventDestroys(rom, e) : [];
    const entry = (kind: StepKind, k: number, i: number, text: string, title: string, what: string, remove: () => void) =>
      h('div', { class: 'ow-step silent ow-tile-change', title: `${title} – click to show it`, ...hover(kind, k), onclick: () => this.showTile(i) }, text,
        h('button', { class: 'link-btn', title: `The event no longer ${what} it`, onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.tileEdit(`no longer ${what} ${cellText(i)}`, remove); } }, '×'));
    const into = reveal >= 0 ? revealedTile(rom, this.l1[reveal]) : -1, noReveal = revealRefusal(rom, e);
    return [
      reveal >= 0 ? entry('reveal', 0, reveal, `Reveals tile at ${cellText(reveal)}: ${l1Hex(this.l1[reveal])} → ${into < 0 ? '(not in the reveal list)' : l1Hex(into)}`,
        'The tile the event reveals: turned into its counterpart of the reveal list when the event passes', 'reveals', () => removeReveal(rom, e)) : null,
      ...destroys.map((i, k) => entry('destroy', k, i, `Destroys tile ${l1Hex(this.l1[i])} at ${cellText(i)}`,
        'A tile the event destroys (a castle, fortress or switch palace collapsing) when it passes', 'destroys', () => removeDestroy(rom, e, i))),
      h('button', { title: 'The event reveals a tile: click it on the map, then pick what it becomes in the layer 1 sheet (an event reveals one tile)', onclick: () => this.startEventPick('reveal') }, '+ Reveal'),
      e < revealEventCount(rom) ? budgetGauge(this.budget('revealPairs')) : budgetBlocked('reveals none', noReveal ? refusalText(rom, noReveal) : ''),
      hasDestroyPatch(rom) ? h('button', { title: 'The event destroys a tile (a castle, fortress or switch palace): click it on the map (an event destroys one tile, 0x18 in all)', onclick: () => this.startEventPick('destroy') }, '+ Destroy') : null,
      budgetGauge(this.budget('destroys')),
    ];
  }
  // a reveal or destroy edit of event e (the chosen one), one ROM edit; refused with the reason (and the way out `fix`
  // gives)
  private tileEdit(what: string, f: () => void, e = this.event, fix?: (r: OwRefusalData, label: string) => RefusalFix | undefined): boolean {
    const label = `${eventTitle(eventRunners(this.app.rom), e)}: ${what}`;
    try {
      this.app.romEdit(label, f);
      return true;
    } catch (err) {
      refusedToast(this.app.rom, err, 'Not changed: ', fix && ((r) => fix(r, label)));
      return false;
    }
  }
  // "+ Reveal", "+ Destroy": a click on the map picks the tile (the game's limits refused first, with the reason); a
  // reveal's tile is then picked in the layer 1 sheet (the layer 1 mode shown)
  private startEventPick(kind: 'reveal' | 'destroy'): void {
    const rom = this.app.rom, why = kind === 'reveal' ? revealRefusal(rom, this.event) : destroyRefusal(rom, this.event);
    if (why) { refusalToast(rom, why); return; }
    this.eventPick = { kind, at: -1 };
    this.buildTimeline();
    this.updateStatus();
    this.paint();
  }
  // Esc: no reveal or destroy added; false: none being added
  cancelEventPick(): boolean {
    if (!this.eventPick) return false;
    this.eventPick = null;
    this.buildTimeline();
    this.updateStatus();
    this.buildSide();
    this.paint();
    return true;
  }
  // the tile clicked on the map while a reveal or destroy is added (x, y: layer 1 cell); a destroy is set where the
  // game destroys it (a castle's level tile: its top, destroySettingAt)
  private pickEventCell(x: number, y: number): void {
    const pick = this.eventPick!, rom = this.app.rom;
    if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
    const i = l1Index(this.region, x, y);
    if (pick.kind === 'reveal') {
      const why = this.pickRefusals()?.[i - this.region * 0x400];
      if (why) { refusalToast(rom, why); return; }
      this.eventPick = { kind: 'reveal', at: i };
      if (this.mode !== 'l1') this.bar.querySelector<HTMLButtonElement>('.btn-group button.ow-l1')?.click(); else this.buildSide();
      this.buildTimeline();
      this.updateStatus();
      this.paint();
      return;
    }
    this.eventPick = null;
    this.tileEdit(`destroys ${cellText(i)}`, () => addDestroy(rom, this.event, i, this.shown.l1));
    this.buildTimeline();
    this.updateStatus();
    this.paint();
  }
  // the tile the revealed one becomes, picked in the layer 1 sheet (or as the reveal list has it)
  private pickReveal(into: number): void {
    const at = this.eventPick?.at ?? -1;
    if (at < 0) return;
    this.eventPick = null;
    const t = this.l1[at];
    // (no pair of the reveal list gives the tile: one added, then the reveal)
    const rom = this.app.rom, e = this.event, refresh = () => { this.buildTimeline(); this.updateStatus(); this.buildSide(); };
    const pairFix = (r: OwRefusalData, label: string) => {
      const k = r.kind === 'revealNoSource' ? revealPairFor(rom, t, into) : -1;
      return k < 0 ? undefined : editFix(this.app, label,
        `Adds "tile ${l1Hex(t)} becomes ${l1Hex(into)}" to the reveal list, in a pair that never applies (its tile on no map or a later pair's: pair ${k + 1}), then the reveal – one undo step`,
        () => addRevealPair(rom, t, into), () => addReveal(rom, e, at, into), refresh);
    };
    if (this.tileEdit(`reveals ${cellText(at)}`, () => addReveal(rom, e, at, into), e, pairFix) && readL1(rom)[at] !== t)
      toast(`Tile ${l1Hex(t)} at ${cellText(at)} does not become ${l1Hex(into)}: it is now tile ${l1Hex(readL1(this.app.rom)[at])} on the map before events, which the reveal list turns into it.`);
    this.buildTimeline();
    this.updateStatus();
    this.buildSide();
  }

  // the tiles of the step hovered in the timeline, outlined
  paintStep(lw: number): void {
    const ev = this.ev, s = this.hoverStep, at = this.eventPick?.at ?? -1;
    if (!ev || (!s && at < 0)) return;
    const ctx = this.canvas.getContext('2d')!;
    ctx.strokeStyle = '#ffd34c';
    ctx.fillStyle = 'rgba(255,211,76,0.25)';
    ctx.lineWidth = 1.5 * lw;
    // (the tile a reveal is being added to)
    if (at >= 0 && (at >= 0x400) === (this.region === 1)) { const p = l1XY(at); ctx.strokeRect(p.x * 16, p.y * 16, 16, 16); }
    if (!s) return;
    if (s.kind === 'reveal' || s.kind === 'destroy') {
      const rom = this.app.rom, i = s.kind === 'reveal' ? eventReveal(rom, this.event) : eventDestroys(rom, this.event)[s.k];
      if (i === undefined || i < 0) return;
      // (a destroy: the tiles it changes too, a castle's level tile below its top)
      // (the tile as the game may see it: before events, else as shown at the event progress)
      const o = l1XY(i), effects = s.kind === 'destroy' ? destroyEffects(rom) : [];
      const t = [this.l1[i], this.shown.l1[i]].find((v) => effects[v]?.length);
      const cells = t === undefined ? [] : effects[t].map((c) => ({ x: o.x + c.dx, y: o.y + c.dy }));
      if ((i >= 0x400) !== (this.region === 1)) return;
      for (const c of [o, ...cells]) {
        ctx.fillRect(c.x * 16, c.y * 16, 16, 16);
        ctx.strokeRect(c.x * 16, c.y * 16, 16, 16);
      }
      return;
    }
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
    const l1 = document.createElement('canvas'), l2 = document.createElement('canvas');
    putMapLayers(l1, l2, this.app.rom, r, this.region, this.shown.l1, ev.before);
    composeLayers(before, l1, l2, this.strengths());
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
    this.nameEditor.close(true);
    this.cellHistory.close();
    this.map = n;
    this.selected = -1;
    this.links.selectAt(-1);
    this.l2Sel = null;
    this.replacing = null;
    this.redrawMap();
    this.buildBar();
    this.buildSide();
    this.buildLeft();
    this.onNav();
  }

  // ---------------- context bar (map, layer, view, zoom) ----------------
  setMode(m: OwMode): void {
    if (this.mode === m) return;
    this.nameEditor.close(true);
    this.cellHistory.close();
    this.mode = m;
    this.links.cancelPending(); // (the next click on the map no longer chooses a link's tile)
    this.levelTiles.cancel();
    this.pathTool.cancel();
    if (m !== 'l1' && (this.eventPick?.at ?? -1) >= 0) this.cancelEventPick(); // (the tile a reveal becomes is picked in the layer 1 sheet)
    if (m !== 'l2') { this.replacing = null; this.l2Sel = null; }
    this.buildLeft(); // (levels without a level tile are dragged onto the map in the layer 1 mode)
    if (isLayerMode(m) && this.brush.kind !== m) this.brush = { kind: m, w: 1, h: 1, entries: [m === 'l1' ? FIRST_L1_TILE : 0] };
    this.buildBar();
    this.buildSide();
    this.updateStatus();
    this.composeMap();
    this.paint();
  }
  // the layer 1 mode's route brush is the brush (owpathtool.ts: right drags draw routes)
  get routeBrush(): boolean { return this.mode === 'l1' && this.pathTool.on; }
  // the level tile look that is the layer 1 mode's brush (the picker's "Levels": a right click places a level; -1: none)
  get lookBrush(): number { return this.mode === 'l1' ? this.levelTiles.look : -1; }
  // tiles picked into the layer 1 brush: the route brush or a look as the brush ends (the tiles are the brush)
  private endRouteBrush(): void {
    if (this.mode !== 'l1' || (!this.pathTool.on && this.levelTiles.look < 0)) return;
    this.pathTool.on = false;
    this.levelTiles.look = -1;
    this.updateStatus();
  }
  // the layer 1 mode's route brush chosen, or the last tile brush again (P, the "Path (auto)" row)
  private setRouteBrush(on: boolean): void {
    this.pathTool.cancel();
    this.pathTool.on = on;
    this.levelTiles.look = -1;
    this.buildSide();
    this.updateStatus();
    this.paint();
  }
  // a level tile look as the layer 1 mode's brush (the picker's "Levels")
  private setLookBrush(t: number): void {
    this.pathTool.cancel();
    this.pathTool.on = false;
    this.levelTiles.look = t;
    this.buildSide();
    this.updateStatus();
    this.paint();
  }
  buildBar(): void {
    const view = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string, shortcut?: string) =>
      ({ label, title, shortcut, checked: get, onToggle: (v: boolean) => { set(v); this.redrawMap(); this.updateStatus(); } });
    this.zoomCtl.update();
    this.showEventBadge();
    this.bar.replaceChildren(
      h('label', { class: 'row' }, 'Map ', select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), this.map, (v) => this.setMap(v))),
      h('span', { class: 'sep' }),
      h('div', { class: 'btn-group' },
        h('button', { class: `ow-l1${this.mode === 'l1' ? ' active' : ''}`, title: 'Layer 1 (1): paths painted as tiles, the level tiles objects on top (hatched) – click selects one, drag moves it, right click: its menu, Delete removes it; placed with a look from "Levels" in the picker; the overworld links\' tiles objects too (marked, right click: Link to…, Remove link) · the path tiles marked; layer 2 dimmed (View → Layers), hold Q to hide it', onclick: () => this.setMode('l1') }, 'Layer 1 (paths, levels & links)'),
        h('button', { class: `ow-l2${this.mode === 'l2' ? ' active' : ''}`, title: 'Layer 2 (2) · layer 1 with its path marks dimmed or hidden (View → Layers), hold Q for the other', onclick: () => this.setMode('l2') }, 'Layer 2 (terrain)'),
        h('button', { class: this.mode === 'sprites' ? 'active' : '', title: 'Sprites (3): the overworld\'s sprites as the game shows them at the event progress, the start positions and the Koopa Kids\' places; drag to move', onclick: () => this.setMode('sprites') }, 'Sprites')),
      h('span', { class: 'sep' }),
      menuButton({ label: 'View', items: [
        { heading: 'Layers' },
        { label: 'Dim layer 2 while painting layer 1', title: 'In the layer 1 mode layer 2 drawn dimmed, else at full strength (Q held hides it)', checked: () => this.dimL2,
          onToggle: (v: boolean) => { this.dimL2 = v; dimL2Pref.set(v); this.composeMap(); this.paint(); } },
        { label: 'Layer 1 while painting layer 2', title: 'In the layer 2 mode layer 1 – its tiles, path marks, level numbers and unreached tiles – drawn dimmed, else not at all (Q held: the other way)', checked: () => this.l1InL2,
          onToggle: (v: boolean) => { this.l1InL2 = v; l1InL2Pref.set(v); this.composeMap(); this.paint(); this.updateStatus(); } },
        { heading: 'Guides' },
        view('Grid', () => this.showGrid, (v) => (this.showGrid = v), undefined, 'G'),
        view('Unreached tiles', () => this.reach.show, (v) => (this.reach.show = v),
          'Path and level tiles Mario can\'t get to at this event progress dimmed – searched along the paths as the game moves him (what each tile does learned from the game\'s code), with the level flags of a save at the progress; the problems of the paths are in the status bar'),
        view('Exit arrows', () => this.exits.show, (v) => (this.exits.show = v),
          'On layer 1 (the selected level tile\'s always): from each level tile an arrow to each level its exits open (solid the normal exit, dashed a secret one; to another submap ending at the link leading there), a red stub for an exit opening nothing Mario reaches – exit E opens level B when Mario reaches B at the event progress after E\'s event and not at the one before (events pass in number order)'),
        view('Sprites', () => this.showSprites, (v) => (this.showSprites = v),
          'The overworld\'s sprites as the game shows them at the event progress (always shown in the Sprites mode)'),
        view('Sprite shadows', () => this.sprites.showShadows, (v) => (this.sprites.showShadows = v), 'A shadow on the ground under each sprite'),
        view('Sprite height marks', () => this.sprites.showHeights, (v) => (this.sprites.showHeights = v), 'A line from a flying sprite\'s position up to it'),
        { label: 'Cell history', title: 'The mouse resting on a cell for a moment shows what each event changes there over the game; a click on an entry shows the map as after it in the strip',
          checked: () => this.cellHistory.on, onToggle: (v: boolean) => this.cellHistory.setOn(v) },
        view('Link arrows', () => this.links.show, (v) => (this.links.show = v),
          'Every overworld link as an arrow (else the selected tile\'s): stars, pipes and exit paths leading elsewhere, the locations exits to the overworld teleport to and the Koopa Kids\' places dashed'),
        antsMenuItem(),
        animationMenuItem(this.app),
      ] }),
      h('span', { class: 'sep' }),
      this.zoomCtl.root,
    );
    this.buildStrip();
  }

  // keys while the overworld is shown; false: not handled
  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && this.mode === 'sprites') {
      if (k === 'c') return this.sprites.copy();
      if (k === 'v') return this.sprites.paste();
      if (k === 'd') return this.sprites.duplicate();
    }
    // (Esc with any modifier: a stroke is never left running)
    if (k === 'escape' && this.brushDrag.cancel()) { this.paint(); return true; }
    if (k === 'escape' && this.cellHistory.cancelMove()) return true;
    if (k === 'escape' && this.levelTiles.cancel()) return true;
    if (k === 'escape' && this.nameEditor.cancel()) return true;
    if (k === 'escape' && this.pathTool.cancel()) return true;
    if (k === 'escape' && this.cancelEventPick()) return true;
    if (k === 'escape' && this.cancelReplace()) return true;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === 'escape' && this.mode === 'sprites' && this.sprites.unpick()) return true;
    if (k === 'escape' && this.links.cancelPending()) { this.paint(); return true; }
    if (k === 'escape' && this.event >= 0) { this.setEvent(-1); return true; }
    if (k === 'p' && this.mode === 'l1') { this.setRouteBrush(!this.pathTool.on); return true; }
    if (k === 'g') { this.showGrid = !this.showGrid; this.paint(); return true; }
    if (k === 'q' && isLayerMode(this.mode)) { this.setSolo(true); return true; }
    if (k === 'm' && this.selected >= 0 && isLayerMode(this.mode)) { this.editTile(this.selected); return true; }
    if (k === ',' || k === '.') { this.setEvent(stepEvent(this.event, k === ',' ? -1 : 1)); return true; }
    if (k >= '1' && k <= '3') { (this.bar.querySelectorAll('.btn-group button')[+k - 1] as HTMLButtonElement).click(); return true; }
    if ((k === 'delete' || k === 'backspace') && this.mode === 'sprites') return this.sprites.remove();
    if ((k === 'delete' || k === 'backspace') && this.mode === 'l1') return this.levelTiles.remove() || this.links.remove();
    return false;
  }

  // ---------------- left: level tiles of the map ----------------
  // (what it reads watched too: drawn again on its own after the last sync)
  buildLeft(): void {
    this.watch.add(() => this.buildLeftNow());
  }
  private buildLeftNow(): void {
    // (while the path tiles are learned which tiles are level tiles is not known: said so, not "none")
    if (!this.pathKinds()) {
      this.tlCount.textContent = '…';
      this.tlList.replaceChildren(emptyState(LEVEL_TILES_LEARNED));
      return;
    }
    const levels = this.levelL1(), shared = sharedTranslevels(levels, this.tls, this.isLevelTile);
    const items: HTMLElement[] = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y), tl = this.tls[i];
      if (!this.isLevelTile(levels[i])) continue;
      const lvl = translevelToLevel(tl), name = tl ? levelName(this.app.rom, tl) : '(enters no level)';
      const cur = i === this.selected, warn = shared.has(tl) || !tl;
      const el = h('div', { class: `level-item${cur ? ' current' : ''}`, title: `${name}\n${warn && tl ? 'Another level tile enters this level too\n' : ''}Click: select · Double click: open in the level editor`,
        onclick: () => this.selectTile(i, true), ondblclick: () => { if (tl) { this.selectTile(i, false); this.onOpenLevel(lvl); } } },
        tl ? hex(lvl, 3) : '---', h('span', { class: 'lname' }, ` ${name}`), warn ? h('span', { class: 'warn-text' }, ' ⚠') : null);
      items.push(el);
      if (cur) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    this.tlCount.textContent = String(items.length);
    // the levels no level tile on any map enters (their settings kept with their translevels): dragged onto the map
    const without = levelsWithoutTile(this.tls);
    this.tlList.replaceChildren(...(items.length ? items : [emptyState('This map has no level tiles.')]),
      ...(without.length ? [h('div', { class: 'gt-list-head', title: 'Levels no level tile on any map enters – drag one onto the map to place it' }, `Without level tile (${without.length})`),
        ...this.levelTiles.withoutTile(without)] : []));
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
    this.palPanel.replaceChildren(...(this.mode === 'sprites' ? this.sprites.palette() : [
      h('div', { class: 'panel-title' }, 'Paint', h('span', { class: 'hint' }, 'Right click/Shift+click paints')),
      this.mode === 'l1' ? this.l1Palette() : this.l2Palette()]));
    this.palPanel.scrollTop = scroll;
    this.buildProps();
  }

  // the mode's properties (of what is selected), under them the global settings in two sections shown in every mode:
  // "Map" (the map shown: music, graphics, border; open by default) and "Overworld" (the game's options, the reveal
  // list; collapsed by default) – each open or closed for the session
  private mapOpen = true;
  private overworldOpen = false;
  private revealListOpen = false;
  buildProps(): void {
    const links = this.mode === 'l1' && this.selected >= 0 ? this.links.props() : null;
    const own = this.mode === 'sprites' ? [h('div', { class: 'panel-title' }, 'Sprite'), this.sprites.props()]
      : [h('div', { class: 'panel-title' }, 'Properties'),
        this.selected >= 0 ? this.tileInfo(this.selected) : emptyState(this.mode === 'l1' ? 'Click a level tile on the map or in the list on the left, or any tile with Alt/Ctrl+click.'
          : 'Select a level tile in the list on the left, or any tile with Alt/Ctrl+click on the map.'),
        ...links ? [links] : [], ...this.mode === 'l1' ? [this.linkLegend()] : []];
    const map = h('details', { class: 'ow-section', open: this.mapOpen, ontoggle: () => (this.mapOpen = map.open) },
      h('summary', { title: `The settings of the map shown (${MAP_NAMES[this.map]})` }, 'Map', h('span', { class: 'hint' }, ` · ${MAP_NAMES[this.map]}`)),
      this.mapSettings());
    const ow = h('details', { class: 'ow-section', open: this.overworldOpen, ontoggle: () => (this.overworldOpen = ow.open) },
      h('summary', { title: 'The settings of the whole overworld' }, 'Overworld'),
      this.optionsPanel(), this.revealList());
    this.props.replaceChildren(...own, map, ow);
  }

  // the game's overworld options (Lunar Magic's "Extra Options", core/owoptions.ts): each switch one ROM edit
  private optionsPanel(): HTMLElement {
    const rom = this.app.rom;
    const rows: HTMLElement[] = [];
    for (const o of OW_OPTIONS) {
      if (o.sub && owOptionValue(rom, o.sub.of) !== o.sub.when) continue;
      const v = owOptionValue(rom, o.id);
      if (v === null) { rows.push(h('div', { class: 'row hint warn-text', title: o.title }, `⚠ ${o.label}: its code was changed by a patch`)); continue; }
      // (the path fade: BOWSIE re-inserted with or without MaxTile; refused when that fails)
      const c = checkbox(o.label, o.title, v, (on) => {
        try {
          const warnings = this.app.romEdit(`${o.label}: ${on ? 'on' : 'off'}`, () => { setOwOption(rom, o.id, on); return o.id === 'pathFade' ? syncBowsieMaxTile(rom) : []; });
          if (warnings.length) toast(warnings.join(' '));
        } catch (e) { refusedToast(rom, e); this.buildProps(); }
      });
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
    return h('div', { class: 'ow-info' }, h('div', { class: 'hint' }, 'Options · the game\'s switches'), ...rows);
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
      h('button', { onclick: () => this.onEditGraphics(map, this.progress), title: `${MAP_NAMES[map]}'s own palettes, graphics files, layer 3 graphics and animations in the graphics workspace` }, 'Edit graphics of this submap'),
      h('button', { onclick: () => this.onEditBorder(map), title: `${MAP_NAMES[map]}'s border (layer 3, fixed on the screen) in the Game workspace` }, 'Edit border of this submap'));
  }

  // the layer 1 picker's "Levels" (ADR 0012): the level tiles' looks – one chosen as the brush, a right click on a cell
  // places a level with it –, the budget of levels with a level tile
  private levelsSection(): HTMLElement {
    const look = this.lookBrush;
    return h('div', { class: 'ow-info' },
      h('div', { class: 'hint ow-page', title: 'Level tiles are objects on top of layer 1 – the only place they are changed –, each change one ROM edit of the map before events, or with an event chosen in the strip under the map a layer 1 change of the event (the tile changed from the event on). Click one on the map to select it, drag it to move it (it swaps with the tile there, its level and settings go with it), Delete leaves the stop tile 81 (the level keeps its settings, listed under "Without level tile"), right click for its menu' },
        'Levels', h('span', { class: 'hint' }, look >= 0 ? ` · Right click/Shift+click a cell: Place level here… (look ${l1Hex(look)})` : ' · choose a look, then right click a cell')),
      this.levelTiles.lookPicker(look, (t) => this.setLookBrush(t)),
      budgetRow('Levels with a level tile', this.budget('translevels')));
  }

  // what the overworld links' arrows mean, the tables' budgets
  private linkLegend(): HTMLElement {
    const row = (color: string, text: string, dashed = false) => h('div', { class: 'row' },
      h('span', { class: 'ow-legend', style: `border-top: 2px ${dashed ? 'dashed' : 'solid'} ${color}` }), text);
    return h('div', { class: 'ow-info' },
      row('#c58cff', 'Star / pipe'), row('#ff6b6b', 'Exit path to another submap'),
      row('#4cc2ff', 'Location an exit to the overworld teleports to', true), row('#ffa94c', 'Where a Koopa Kid puts Mario', true),
      h('div', { class: 'hint' }, 'One head: one-way, two heads: both ways.'),
      budgetRow('Star / pipe entries', this.budget('stars')),
      budgetRow('Exit path entries', this.budget('exitPaths')));
  }

  // the menu of link end i (not a level tile: its menu has these too) at the cursor cx, cy: link it, remove its links
  private linkMenu(i: number, cx: number, cy: number): void {
    const items = this.links.menuItems(i), { x, y } = l1XY(i);
    this.selectTile(i, false);
    if (items.length) contextMenu(cx, cy, [{ heading: `Tile ${hex(x, 2)},${hex(y, 2)} · ${l1Hex(this.levelL1()[i])}` }, ...items]);
  }

  // a layer 1 tile drawn (16x16) for the lists
  tileImage(t: number): HTMLCanvasElement {
    const r = this.render(), c = h('canvas', { width: 16, height: 16, class: 'ow-tile' }), ctx = c.getContext('2d')!;
    const id = ctx.createImageData(16, 16), px = new Uint32Array(id.data.buffer);
    px.fill(0xff181818);
    if (r) this.drawL1Tile(px, owTileCaches(r).l1, t, 0, 0, 16, 16);
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
    const others = levelTilesOf(this.levelL1(), this.tls, tl, this.isLevelTile).filter((k) => k !== i);
    const choose = this.levelTiles.levelChoice(tl || 1, i, (t) => {
      if (t === tl) return;
      const next = this.tls.slice();
      next[i] = t;
      this.app.romEdit(`Level tile ${hex(x, 2)},${hex(y, 2)}: level ${hex(translevelToLevel(t), 3)}`, () => writeTranslevels(rom, next));
    });
    const head = [
      h('div', { class: 'prop' }, h('label', null, 'Enters level'), choose),
      h('div', { class: 'hint' }, `Tile ${hex(x, 2)},${hex(y, 2)}${tl ? ` · translevel ${hex(tl, 2)}` : ''}`),
      ...others.map((k) => h('div', { class: 'hint warn-text' }, `⚠ The level tile at ${tilePlace(k)} enters this level too.`)),
      h('div', { class: 'prop' }, h('label', { title: 'The level tiles\' looks: the visible tiles the game enters a level on, and one drawn on layer 2 – the tile changes, its level stays' }, 'Look')),
      this.levelTiles.lookPicker(this.levelL1()[i], (t) => this.levelTiles.setLook(i, t)),
    ];
    if (!tl) return h('div', { class: 'ow-info' }, ...head, h('div', { class: 'hint warn-text' }, '⚠ This level tile enters no level.'));
    head.push(...this.levelTiles.crumbleRow(i, tl));
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

  // "When beaten…": a sentence per exit of what passing it does (owexitsentence.ts; the levels it opens as its arrows,
  // none told while they are learned: said so), in the player's words, the event number after it. Hovering a clause
  // outlines its tiles on the map, a click shows the map as after the exit's event in the strip, × on a reveal or
  // destroy takes it away (one ROM edit); an exit whose event changes nothing "opens nothing yet". Exits to the overworld passing none of the exits (ending the turn) are told below.
  exitResultRows(tl: number): HTMLElement[] {
    const rom = this.app.rom, { teleports } = this.exitResults(tl), runners = eventRunners(rom), kinds = this.pathKinds(), edges = this.exits.edges();
    this.hoverClause = null; // (built anew: the clause hovered is gone)
    const sentences = exitSentences(rom, tl, { level: this.levelWords, tile: (t) => tileWords(kinds, t) }, teleports, edges);
    if (!sentences.length && !teleports.length) return [];
    const clause = (c: Clause, e: number) => h('span', {
      class: 'ow-clause', title: 'Shows the map as after this exit\'s event in the strip',
      onmouseenter: () => { this.hoverClause = c; this.paint(); },
      onmouseleave: () => { this.hoverClause = null; this.paint(); },
      onclick: () => this.setEvent(e),
    }, c.text, c.remove ? h('button', {
      class: 'link-btn', title: `The event no longer ${c.remove.kind === 'reveal' ? 'reveals' : 'destroys'} the tile at ${cellText(c.remove.tile)}`,
      onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.removeEventTile(e, c.remove!); },
    }, '×') : null);
    // (an exit to the overworld passing an exit without a sentence, or none of them)
    const others = teleports.filter((t) => !sentences.some((x) => x.exit === teleportExit(t.action)));
    // (where an exit to the overworld teleports to: moved by a click on the tile – the pick pending, #413)
    const move = (t: LevelTeleport) => h('button', { class: 'link-btn', title: `Choose the tile location ${hex(t.location, 2)} teleports to (the next click, on any map; Esc cancels)`,
      onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.links.pending = { move: { sel: { kind: 'location', i: t.location }, target: true } }; this.paint(); this.updateStatus(); } }, 'Move…');
    return [
      h('div', { class: 'hint' }, 'When beaten… (outlined on the map, a click shows it in the strip):'),
      ...(edges ? [] : [h('div', { class: 'hint' }, 'The levels the exits open: being learned …')]),
      ...sentences.map((x) => h('div', { class: 'ow-sentence' },
        h('b', null, `${EXIT_NAMES[x.exit]}: `),
        ...(x.clauses.length ? x.clauses.flatMap((c, k) => (k ? [' · ', clause(c, x.event)] : [clause(c, x.event)]))
          : [h('span', { class: 'ow-clause', title: 'Its event changes nothing on the map – shows the map as after it in the strip', onclick: () => this.setEvent(x.event) }, 'opens nothing yet')]),
        h('span', { class: 'hint', title: eventTitle(runners, x.event) }, ` · event ${hex(x.event, 2)}`),
        ...teleports.filter((t) => teleportExit(t.action) === x.exit).map((t) => [' ', move(t)]).flat())),
      ...others.map((t) => h('div', { class: 'hint' }, `Exit to the overworld (entrance ${hex(t.entrance, 3)}, ${owActionShort(t.action)}): Mario goes to ${tileText(t.to)} (dashed) `, move(t))),
    ];
  }
  // the reveal or destroy of a "When beaten…" clause taken away from event e, one ROM edit (refused: why)
  private removeEventTile(e: number, r: NonNullable<Clause['remove']>): void {
    const rom = this.app.rom;
    this.hoverClause = null;
    this.tileEdit(`no longer ${r.kind === 'reveal' ? 'reveals' : 'destroys'} ${cellText(r.tile)}`, () => (r.kind === 'reveal' ? removeReveal(rom, e) : removeDestroy(rom, e, r.tile)), e);
  }
  // the cells of the "When beaten…" clause hovered, outlined (on the region shown)
  private paintClause(ctx: CanvasRenderingContext2D, lw: number): void {
    const c = this.hoverClause;
    if (!c) return;
    ctx.strokeStyle = '#ffd34c';
    ctx.fillStyle = 'rgba(255,211,76,0.35)';
    ctx.lineWidth = 1.5 * lw;
    for (const k of c.l1) {
      if ((k >= 0x400) !== (this.region === 1)) continue;
      const p = l1XY(k);
      ctx.fillRect(p.x * 16, p.y * 16, 16, 16);
      ctx.strokeRect(p.x * 16, p.y * 16, 16, 16);
    }
    for (const k of c.l2) { if (k >> 12 !== this.region) continue; const p = l2XY(k); ctx.fillRect(p.x * 8, p.y * 8, 8, 8); }
  }

  // the selected tile: a level tile's settings, and for every tile the events that reveal it
  tileInfo(i: number): HTMLElement {
    const { x, y } = l1XY(i), t = this.levelL1()[i];
    const known = !!this.pathKinds(); // (whether it is a level tile: not known while the path tiles are learned)
    const info = this.isLevelTile(t) ? this.levelInfo(i) : known && ownsTranslevel(t) ? this.starInfo(i)
      : h('div', { class: 'ow-info' }, h('div', { class: 'hint' }, `Tile ${hex(x, 2)},${hex(y, 2)} · ${l1Hex(t)}${known ? ' (not a level tile)' : ''}`),
        known ? null : h('div', { class: 'hint' }, LEVEL_TILES_LEARNED));
    info.append(h('div', { class: 'row' }, h('button', { title: 'Edit which 8x8 tiles make this layer 1 tile, in the Map16 tab (M) – for every place of the tile on all maps', onclick: () => this.editTile(i) }, `Edit tile ${l1Hex(t)} in Map16 …`)),
      ...this.revealSettings(i), ...this.destroySettings(i));
    return info;
  }
  // the star or pipe 5B at i (owstars.ts ownsTranslevel): what the game uses its translevel for – the ways Mario walks
  // off it (its initial flags, each a switch) and the status bar's name (typed in the box under it on the map:
  // LevelNameEditor); no level settings, it enters no level. Without a translevel of its own: said why that matters,
  // one given by a button
  private starInfo(i: number): HTMLElement {
    const rom = this.app.rom, tl = this.tls[i], { x, y } = l1XY(i), t = this.levelL1()[i], paths = this.starPaths()!;
    const what = starOrPipe(t), What = what === 'star' ? 'Star' : 'Pipe';
    const head = h('div', { class: 'hint' }, `${What} · tile ${hex(x, 2)},${hex(y, 2)} · ${l1Hex(t)}${tl ? ` · translevel ${hex(tl, 2)}` : ''} – A takes Mario where its link leads (Links), it enters no level`);
    const gauge = budgetRow('Levels on the overworld (level tiles, stops, stars and pipes)', this.budget('translevels'));
    if (!tl) {
      return h('div', { class: 'ow-info' }, head,
        h('div', { class: 'hint warn-text' }, '⚠ No translevel of its own: Mario walks off it only in the ways translevel 00\'s flags open – shared with every tile without one – and the status bar shows a blank name.'),
        h('div', { class: 'row' }, h('button', {
          title: `A free translevel without name, base event or messages, its flags the ways the paths next to the ${what} lead (as a ${what} painted gets one)`,
          onclick: () => {
            try { this.app.romEdit(`${What} ${hex(x, 2)},${hex(y, 2)}: translevel`, () => giveStarTranslevel(rom, i, this.levelL1(), paths)); }
            catch (e) { refusedToast(rom, e, 'No translevel given: '); }
          },
        }, 'Give it a translevel')), gauge);
    }
    const flags = initialFlags(rom, tl), ways = starDirs(this.levelL1(), i, paths);
    const switches = DIR_NAMES.map((n, d) => checkbox(` ${DIR_ARROWS[d]}`,
      `${n}: ${flags & DIR_FLAGS[d] ? 'open' : 'closed'} from a new game on${ways.includes(d) ? '' : ' – no path leads that way'}${!(flags & DIR_FLAGS[d]) && ways.includes(d) ? ' (a path leads that way: Mario arriving by it opens it; until then the World check may call it a dead end)' : ''}`,
      (flags & DIR_FLAGS[d]) !== 0,
      (on) => this.app.romEdit(`${What} ${hex(x, 2)},${hex(y, 2)}: ways off`, () => setInitialFlags(rom, tl, on ? flags | DIR_FLAGS[d] : flags & ~DIR_FLAGS[d]))));
    const others = [...this.tls.keys()].filter((k) => k !== i && this.tls[k] === tl);
    return h('div', { class: 'ow-info' }, head,
      h('div', { class: 'prop' }, h('label', { title: `The ways Mario walks off the ${what} in a new game (its translevel's initial flags): arriving by a path opens the way back, the reveal walk of a level whose path leads here too` }, 'Mario walks off'), ...switches),
      h('div', { class: 'prop' }, h('label', { title: `The name the status bar shows while Mario stands on the ${what} (its translevel's), drawn in the box under it` }, 'Status bar'),
        h('span', null, hasLevelName(rom, tl) ? levelName(rom, tl) : '(blank)'),
        levelNamePatch(rom) ? h('button', { title: `Type the name in the box under the ${what}, in the map's font (Enter writes it, Esc drops it)`, onclick: () => this.nameEditor.openStar() }, 'Edit…') : null),
      ...others.map((k) => h('div', { class: 'hint warn-text' }, `⚠ The tile at ${tilePlace(k)} has this translevel too: the ways and the name are both's.`)),
      gauge);
  }
  // "New tile…": the first free layer 1 tile in the Map16 tab; none: refused – a copy of tile 000 on a map taken
  // (its places get 000 itself) where there is one
  private newTile(): void {
    const rom = this.app.rom, kinds = this.pathKinds(), open = (t: number) => this.app.editTile(t, 'ow', { submap: this.map, progress: this.progress });
    if (!kinds) return;
    try { open(newL1Tile(rom, kinds)); } catch (e) {
      refusedToast(rom, e, 'Not opened: ', () => { const c = tileCopiesOf000(rom, kinds)[0]; return c === undefined ? undefined : editFix(this.app, `Take tile ${l1Hex(c)}`,
        `Tile ${l1Hex(c)} looks and acts like tile ${l1Hex(0)}: its places on the maps get ${l1Hex(0)} itself (nothing changes in the game), and ${l1Hex(c)} is free for a new look`,
        () => takeTileCopy(rom, c), undefined, () => open(c)); });
    }
  }
  // the Map16 tab on layer 1 tile i's tile (as in the ROM), drawn as on this map at the event progress
  private editTile(i: number): void {
    const t = this.l1[i];
    if (t >= OW_L1_TILES) { refusalToast(this.app.rom, { kind: 'l1TilePast', tile: t, tiles: OW_L1_TILES }); return; }
    this.app.editTile(t, 'ow', { submap: this.map, progress: this.progress });
  }

  // the events by the level exit that runs them, the number as detail
  private eventLabel(names: Map<number, string>, e: number): string {
    return `${names.get(e) ?? 'No level runs it'} · ${hex(e, 2)}`;
  }

  // the base event, the direction each exit enables, the initial flags of translevel tl (each change one ROM edit).
  // An exit the game skips the reveal walk for (revealwalk.ts) still enables its direction but reveals no path – one
  // that runs no event enables no direction either: said so beside it (nothing while that is learned)
  levelSettings(tl: number): HTMLElement[] {
    const rom = this.app.rom, lvl = hex(translevelToLevel(tl), 3), ev = baseEvent(rom, tl), names = eventNames(rom);
    const edit = (what: string, f: () => void) => this.app.romEdit(`Level ${lvl}: ${what}`, f);
    const events = select([[NO_EVENT, 'No event'], ...Array.from({ length: OW_EVENTS }, (_, e) => [e, this.eventLabel(names, e)] as [number, string])], ev,
      (v) => edit('base event', () => setBaseEvent(rom, tl, v)));
    events.title = 'The event passing the level runs: its normal exit this one, secret exit n the one n after it';
    const dirs = exitDirections(rom, tl);
    const skips = this.app.revealWalkSkips(this.revealWalksLearned);
    const exits = EXIT_NAMES.map((name, k) => {
      // (with "No event" an exit the game doesn't handle at once runs the event after FF – secret exit 1 event 00)
      const e = exitEvent(ev, k);
      const run = ev === NO_EVENT ? (skips && !handledWithoutEvent(skips, k, ev) && e >= 0 ? `event ${hex(e, 2)}` : 'no event')
        : e >= 0 ? `event ${hex(e, 2)}` : 'no event (past the last)';
      const s = select(DIR_NAMES.map((n, d) => [d, `${DIR_ARROWS[d]} ${n}`] as [number, string]), dirs[k], (v) => edit(`${name.toLowerCase()} direction`, () => setExitDirection(rom, tl, k, v)));
      // why the exit skips the reveal walk (null: it walks, or that is being learned)
      const why = !skips ? null : handledWithoutEvent(skips, k, ev) ? NO_EVENT_WALK : skipsRevealWalk(skips, tl, k, ev) ? NO_REVEAL_WALK : null;
      s.title = why === NO_EVENT_WALK ? `${name}: ${why}` : `${name}: runs ${run} and enables walking in this direction from the tile` +
        (why ? `. ${why}` : skips ? '; when first passed, the level tile the path leads to gets the way back' : '');
      return h('div', { class: 'prop' }, h('label', { title: `Runs ${run}` }, name), s,
        why ? h('span', { class: 'hint', title: why }, 'no reveal walk') : null);
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

  // an event as a link choosing it in the strip (where its reveals and destroys are edited)
  private eventLink(names: Map<number, string>, e: number): HTMLElement {
    return h('button', { class: 'link-btn', title: 'Show the map after this event – its reveals and destroys are edited in its timeline', onclick: () => this.setEvent(e) }, this.eventLabel(names, e));
  }

  // the events that reveal layer 1 tile i (Lunar Magic's "reveal this tile on events"), each a link to the event:
  // reveals are added and removed in the event's timeline
  revealSettings(i: number): HTMLElement[] {
    const rom = this.app.rom, t = this.l1[i], into = revealedTile(rom, t), names = eventNames(rom);
    const evs = i ? revealEvents(rom, i) : [];
    if (!evs.length) return [h('div', { class: 'hint' }, 'Revealed on no event (an event reveals a tile: "+ Reveal" in its timeline under the strip).')];
    return [
      h('div', { class: 'prop' }, h('label', null, 'Revealed on'), h('div', null, ...evs.map((e) => h('div', null, this.eventLink(names, e))))),
      into < 0 ? h('div', { class: 'hint warn-text' }, `⚠ Tile ${l1Hex(t)} is not in the reveal list: revealing it changes nothing.`)
        : h('div', { class: 'hint' }, `Revealed, tile ${l1Hex(t)} becomes ${l1Hex(into)}.`),
    ];
  }

  // the events destroying tile i (Lunar Magic's "Destroy Level Tile Settings") – on a tile the game destroys (what it
  // does learned by emulation), also on the level tile below a castle's top – each a link to the event: destroys are
  // added and removed in the event's timeline
  destroySettings(i: number): HTMLElement[] {
    const rom = this.app.rom;
    if (!hasDestroyPatch(rom)) return [];
    const effects = destroyEffects(rom), names = eventNames(rom);
    const { at: j, tile: t } = destroySettingAt(rom, this.l1, this.shown.l1, i);
    const evs = j < 0 ? [] : readDestroyList(rom).filter((d) => d.event !== NO_EVENT && d.tile === j).map((d) => d.event);
    if (!evs.length) return j < 0 ? [] : [h('div', { class: 'hint' }, 'Destroyed on no event (an event destroys a tile: "+ Destroy" in its timeline under the strip).')];
    const side = (c: { dx: number; dy: number }) => (c.dy > 0 ? 'below' : c.dy < 0 ? 'above' : c.dx > 0 ? 'right of it' : 'left of it');
    const changes = t === undefined ? [] : effects[t].map((c) => `${c.dx || c.dy ? `the tile ${side(c)} ` : ''}becomes ${l1Hex(c.tile)}`);
    return [
      h('div', { class: 'prop' }, h('label', null, 'Destroyed on'), h('div', null, ...evs.map((e) => h('div', null, this.eventLink(names, e))))),
      j !== i ? h('div', { class: 'hint' }, `Set on the tile at ${cellText(j)}, whose destroy changes this one too (a castle's top).`) : null,
      t !== undefined ? h('div', { class: 'hint' }, `Destroyed, tile ${l1Hex(t)} ${changes.join(', ')}.`)
        : h('div', { class: 'hint warn-text' }, '⚠ The game destroys no such tile: destroying it changes nothing.'),
    ].filter((v): v is HTMLDivElement => !!v);
  }

  private revealMark = false; // a brush picked from the map: its mark in the sheet scrolled into view
  // the paint panel's width inside its padding, which the sheet fills
  private palWidth(): number {
    const st = getComputedStyle(this.palPanel);
    return this.palPanel.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
  }

  // where the brush is a rectangle of exactly its entries in a cols×rows sheet (null: nowhere; a layer 1 brush's
  // NO_TILE where a level tile is)
  private sheetRect(cols: number, rows: number, sheetValue: (x: number, y: number) => number): SheetMark | null {
    const b = this.brush;
    const fits = (v: number, t: number) => v === t || (v === NO_TILE && this.isLevelTile(t));
    for (let i = 0; i < cols * rows; i++) {
      const x = i % cols, y = Math.floor(i / cols);
      if (x + b.w <= cols && y + b.h <= rows && b.entries.every((v, j) => fits(v, sheetValue(x + (j % b.w), y + Math.floor(j / b.w))))) return { kind: 'rect', x, y, w: b.w, h: b.h, flip: 0 };
    }
    return null;
  }

  // palette sheet with the brush outlined and rectangle picking. `locate` finds the brush in the sheet (layer 1: a
  // rectangle of exactly its entries, sheetRect; layer 2: also mirrored, else its 8x8 tiles each outlined thin –
  // core/owl2sheet.ts). A brush not there as it is (taken from the map, flipped) is also shown as a preview. marks:
  // what is drawn over the sheet's pixels in its coordinates (layer 1: the path marks), drawn at the size shown so its
  // lines stay sharp – not scaled up from the sheet's pixels; preview draws the brush the same way
  // The sheet and the brush's preview follow the map's animation (pickeranim.ts): `sheet` is a SheetPicture, `preview`
  // gives the brush's
  sheetPalette(sheet: SheetPicture, cls: string, cols: number, rows: number, cell: number, sheetValue: (x: number, y: number) => number,
    preview: () => SheetPicture, describe: (r: { x: number; y: number; w: number; h: number }) => string[],
    locate: () => SheetMark | null, marks?: (ctx: CanvasRenderingContext2D) => void): HTMLElement {
    const b = this.brush;
    const { c, ctx, k, scale, ants } = this.sheetCanvas(sheet.c, cls);
    // (the route brush or a look chosen: no tile brush marked)
    const tileBrush = b.kind === this.mode && !this.routeBrush && this.lookBrush < 0;
    const mark = tileBrush ? locate() : null;
    const at = mark?.kind === 'rect' ? mark : null;
    const drawSheet = () => { ctx.drawImage(sheet.c, 0, 0); marks?.(ctx); };
    drawSheet();
    this.animate(sheet, c, drawSheet);
    // r: the rectangle being picked (null: the brush's mark: its rectangle, or its 8x8 tiles each), running on the overlay
    const draw = (r: { x: number; y: number; w: number; h: number } | null) => {
      if (!r && mark?.kind === 'tiles') { ants.set(mark.cells.map((t) => cellMark({ x: t.x, y: t.y, w: 1, h: 1 }, cell))); return; }
      r ??= at;
      ants.set(r ? [cellMark(r, cell)] : []);
    };
    draw(null);
    attachRectPick(c, cols, rows, draw, (r) => {
      // (a reveal being added: the tile it becomes)
      if (this.mode === 'l1' && (this.eventPick?.at ?? -1) >= 0) { this.pickReveal(sheetValue(r.x, r.y)); return; }
      let entries: number[] | null = Array.from({ length: r.w * r.h }, (_, j) => sheetValue(r.x + (j % r.w), r.y + Math.floor(j / r.w)));
      // (layer 1: level tiles left out, none but them: refused – one level tile picked is chosen as a look)
      if (this.mode === 'l1' && entries.length === 1 && this.isLevelTile(entries[0])) { this.setLookBrush(entries[0]); return; }
      if (this.mode === 'l1') entries = l1BrushEntries(entries, this.isLevelTile);
      if (!entries) { toast(LEVEL_TILES_BRUSH); draw(null); return; }
      this.brush = { kind: this.mode === 'l2' ? 'l2' : 'l1', w: r.w, h: r.h, entries };
      this.endRouteBrush();
      this.buildSide();
      this.paint();
    });
    previewSheet(c, () => sheet.c, cols, rows, cell, scale, describe, undefined, marks);
    const out = h('div', null);
    if ((!at || at.flip) && tileBrush) {
      // (drawn at the sheet's pixels per pixel, as the sheet)
      const p = h('canvas', { width: b.w * cell * k, height: b.h * cell * k, class: 'ow-brush' }), pc = p.getContext('2d')!;
      pc.imageSmoothingEnabled = false;
      pc.setTransform(k, 0, 0, k, 0, 0);
      const brush = preview(), drawBrush = () => { pc.drawImage(brush.c, 0, 0); brush.marks?.(pc); };
      drawBrush();
      this.animate(brush, p, drawBrush);
      sized(p, fitScale(b.w * cell, b.h * cell, sheet.c.width * scale, sheet.c.width * scale, scale) / k);
      out.append(h('div', { class: 'hint' }, `Brush ${b.w}×${b.h}:`), h('div', { class: 'row' }, p));
    }
    out.append(ants.root);
    // a brush picked from the map: the panel scrolled to its mark when it is out of sight (laid out on the next frame)
    if (mark && this.revealMark) {
      this.revealMark = false;
      const y0 = (mark.kind === 'rect' ? mark.y : Math.min(...mark.cells.map((t) => t.y))) * cell;
      const y1 = mark.kind === 'rect' ? (mark.y + mark.h) * cell : (Math.max(...mark.cells.map((t) => t.y)) + 1) * cell;
      requestAnimationFrame(() => {
        if (!c.isConnected) return;
        const rc = c.getBoundingClientRect(), pr = this.palPanel.getBoundingClientRect(), s = rc.height / sheet.c.height;
        const top = rc.top + y0 * s, bottom = rc.top + y1 * s;
        if (top < pr.top || bottom > pr.bottom) this.palPanel.scrollTop += top - pr.top - pr.height / 3;
      });
    }
    return out;
  }

  // the layer 1 sheet (owl1sheet.ts): pages 0 and 1 (tiles 100–1FF do where Mario walks what 00–FF do) in number
  // order, 16 a row; transparent pixels on a checkerboard, a path tile invisible in the game with its mark as on the map,
  // a visible tile doing something with a border of its colour (none while the kinds are learned);
  // the rows of free tiles at a page's end folded into one row (page 1 whole while none of its tiles is the ROM's own,
  // "Show page 1" opens it: its invisible path and level tiles acting as page 0's)
  l1Palette(): HTMLElement {
    const r = this.render();
    if (!r) return h('div', { class: 'hint' }, 'Loading the overworld…');
    const tc = owTileCaches(r).l1, kinds = this.pathKinds(), shapes = this.pathShapes(), walked = this.walkedWays();
    const empty = emptyL1Tiles(this.app.rom), free = freeL1Tiles(empty, kinds);
    // the tiles of `list` (w a row) on a W×H canvas, their marks apart (drawn by sheetPalette at the size shown)
    const tiles = (list: number[], w: number, W: number, H: number): SheetPicture => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      list.forEach((t, i) => { if (t !== NO_TILE) this.drawL1Tile(px, tc, t, (i % w) * 16, Math.floor(i / w) * 16, W, H); });
      // (whether each cell has a pixel, before the checkerboard fills the others)
      const seen = list.map((_, i) => {
        const x0 = (i % w) * 16, y0 = Math.floor(i / w) * 16;
        for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 16; x++) if (px[y * W + x]) return true;
        return false;
      });
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!px[y * W + x]) px[y * W + x] = checker(x, y);
      ctx.putImageData(id, 0, 0);
      const marks = (m: CanvasRenderingContext2D) => {
        if (kinds) list.forEach((t, i) => {
          const k = kinds[t], x = (i % w) * 16, y = Math.floor(i / w) * 16;
          if (!seen[i] && isPathKind(k)) drawPathMark(m, k, x, y, 0.5, usualWays(t, k, shapes, this.shown.l1, walked));
          else if (KIND_BORDER[k]) { m.strokeStyle = KIND_BORDER[k]; m.lineWidth = 1; m.strokeRect(x + 0.5, y + 0.5, 15, 15); }
        });
        // the level tiles hatched (no brush tiles: objects on layer 1, placed with a look from "Levels")
        hatchCells(m, list.flatMap((t, i) => (this.isLevelTile(t) ? [{ x: (i % w) * 16, y: Math.floor(i / w) * 16 }] : [])), 16, 1);
      };
      return { c, marks, cells: listCells(list, w, 16, (t) => t !== NO_TILE), layer: 1, backAt: checker };
    };
    const b = this.brush, route = this.routeBrush, look = this.lookBrush;
    const one = b.kind === 'l1' && b.entries.length === 1;
    const page = (p: SheetPage) => {
      const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : 's'}`;
      const fold = p.folded || p.hidden || (p.page && this.openPage1) ? h('div', { class: 'row ow-fold' },
        h('span', { class: 'hint' }, [p.folded ? n(p.folded, 'free tile') : '', p.hidden ? `${n(p.hidden, 'invisible path/level tile')} acting as page 0's` : ''].filter(Boolean).join(' · ')),
        p.firstFree >= 0 ? h('button', { title: `Edit tile ${l1Hex(p.firstFree)}, the first free one, in the Map16 tab`,
          onclick: () => this.app.editTile(p.firstFree, 'ow', { submap: this.map, progress: this.progress }) }, 'New tile…') : null,
        p.page && (p.hidden || this.openPage1) ? h('button', { onclick: () => { this.openPage1 = !this.openPage1; this.buildSide(); } }, this.openPage1 ? 'Fold page 1' : 'Show page 1') : null) : null;
      if (!p.rows) return [fold];
      const sheet = tiles(Array.from({ length: p.rows * SHEET_COLS }, (_, k) => p.first + k), SHEET_COLS, SHEET_COLS * 16, p.rows * 16);
      const at = (x: number, y: number) => p.first + y * SHEET_COLS + x;
      return [this.sheetPalette(sheet, 'ow-pal', SHEET_COLS, p.rows, 16, at,
        () => tiles(b.entries, b.w, b.w * 16, b.h * 16),
        (q) => (q.w * q.h > 1 ? [`Block ${q.w}×${q.h} from tile ${l1Hex(at(q.x, q.y))}`]
          : [`Tile ${l1Hex(at(q.x, q.y))}`, ...l1TileLines(at(q.x, q.y), kinds, free[at(q.x, q.y)], shapes)]),
        () => this.sheetRect(SHEET_COLS, p.rows, at), sheet.marks), fold];
    };
    const [p0, p1] = sheetPages(empty, free, this.openPage1);
    return h('div', null,
      h('div', { class: 'row budget-row' }, h('span', { class: 'hint' }, route ? 'Path (auto)' : look >= 0 ? `Level tile ${l1Hex(look)}` : one ? `Tile ${l1Hex(b.entries[0])}` : b.kind === 'l1' ? `Block ${b.w}×${b.h}` : ''),
        budgetGauge(this.budget('l1Tiles'))),
      // (a star or pipe 5B painted takes a translevel of its own: owstars.ts; a stop a route puts too)
      route ? budgetRow('A stop tile a route puts takes a level of its own', this.budget('translevels'))
        : b.kind === 'l1' && b.entries.some(ownsTranslevel) ? budgetRow('A star or pipe takes a level of its own', this.budget('translevels')) : null,
      // (no free tile on either page: the button says why, with the way out)
      kinds && p0.firstFree < 0 && p1.firstFree < 0 ? h('div', { class: 'row' }, h('button', { title: 'No layer 1 tile is free for a new look: says why, with a way out where there is one', onclick: () => this.newTile() }, 'New tile…')) : null,
      // the route brush (owpathtool.ts): a row of its own above the sheet, framed while it is the brush
      h('button', { class: `ow-route-brush${route ? ' active' : ''}`, onclick: () => this.setRouteBrush(true),
        title: 'Path (auto) (P): Click/drag picks up tiles (the tile brush again) · Right click/Shift+drag draws Mario\'s route – the editor chooses the path tiles (a cell none fits in red, why in the status bar); released, they go into the map shown ("Map after": the event\'s layer 1 changes), and a level tile at an end gets the direction of its exit running the event · P: the last tile brush again' },
        'Path (auto)', h('span', { class: 'hint' }, 'Right click/Shift+drag draws the route · P')),
      this.levelsSection(),
      ...page(p0),
      h('div', { class: 'hint ow-page' }, 'Page 1 (100–1FF): acts like 00–FF where Mario walks'),
      ...page(p1));
  }

  l2Palette(): HTMLElement {
    const r = this.render();
    if (!r) return h('div', { class: 'hint' }, 'Loading the overworld…');
    const tc = owTileCaches(r).l2;
    const entries = (list: number[], w: number, W: number, H: number): SheetPicture => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      px.fill(L2_SHEET_BACK);
      list.forEach((v, i) => { if (v >= 0) blit8(px, W, H, tc.get(v), (i % w) * 8, Math.floor(i / w) * 8); }); // (-1: none)
      ctx.putImageData(id, 0, 0);
      return { c, cells: listCells(list, w, 8, (v) => v >= 0), layer: 2, back: L2_SHEET_BACK };
    };
    const sheet = () => entries(Array.from({ length: L2_SHEET_COLS * L2_SHEET_ROWS }, (_, t) => l2SheetEntry(t % L2_SHEET_COLS, Math.floor(t / L2_SHEET_COLS), this.l2Pal)), L2_SHEET_COLS, L2_SHEET_COLS * 8, L2_SHEET_ROWS * 8);
    const b = this.brush;
    const pals = b.kind === 'l2' ? l2BrushPalettes(b.entries) : [];
    const brushInfo = b.kind === 'l2' ? `Brush ${b.w}×${b.h}${pals.length > 1 ? ` (palettes ${pals.join(', ')})` : ''}: ${b.entries.slice(0, 16).map((v) => hex(v, 4)).join(' ')}${b.entries.length > 16 ? ' …' : ''}` : '';
    // the flip buttons pressed where every entry of the brush has the bit
    const bits = b.kind === 'l2' ? l2SharedBits(b.entries) : 0;
    const flip = (bit: number, label: string) => {
      const btn = this.flipButton('l2', bit, label);
      btn.classList.toggle('active', !!(bits & bit));
      return btn;
    };
    // the 8x8 sheet (built only while shown)
    const pal = () => h('div', { class: 'ow-pal-scroll' }, this.sheetPalette(sheet(), 'ow-pal8', L2_SHEET_COLS, L2_SHEET_ROWS, 8, (x, y) => l2SheetEntry(x, y, this.l2Pal),
      () => entries(b.entries, b.w, b.w * 8, b.h * 8),
      (q) => [q.w * q.h > 1 ? `Block ${q.w}×${q.h} from tile ${hex(q.y * L2_SHEET_COLS + q.x, 3)}` : `Tile ${hex(q.y * L2_SHEET_COLS + q.x, 3)}`],
      () => findL2Brush(b, this.l2Pal)));
    if (!this.l2TilesOpen) this.revealMark = false; // (no 8x8 sheet to scroll to)
    return h('div', null,
      h('div', { class: 'row' }, flip(L2_FLIP_X, 'X-Flip'), flip(L2_FLIP_Y, 'Y-Flip'), flip(L2_PRIORITY, 'Priority')),
      h('div', { class: 'hint mono' }, brushInfo),
      h('div', { class: 'hint ow-page' }, 'Pieces on this map (16×16, the most used first)'),
      this.replaceRow(),
      this.piecesSheet(entries),
      h('div', { class: 'row ow-fold' }, h('span', { class: 'hint' }, '8×8 tiles'),
        h('button', { onclick: () => { this.l2TilesOpen = !this.l2TilesOpen; this.buildSide(); } }, this.l2TilesOpen ? 'Fold' : 'Show')),
      ...(this.l2TilesOpen ? [
        h('div', { class: 'prop' }, h('label', null, 'Palette'), select(Array.from({ length: 8 }, (_, i) => [i, String(i)] as [number, string]), this.l2Pal, (v) => { this.l2Pal = v; this.buildSide(); })),
        pal()] : []));
  }

  // "Replace piece…" and where it replaces: the selection (the rectangle last picked from the map, × drops it) or the
  // whole map; while under way which piece is picked next
  private replaceRow(): HTMLElement {
    const sel = this.l2Sel, r = this.replacing;
    return h('div', { class: 'row' },
      h('button', {
        class: r ? 'active' : '', onclick: () => { if (!this.cancelReplace()) this.startReplace(); },
        title: 'Every piece of one kind (on its 16-pixel grid) in the selection becomes another one: click the piece to replace, then the new one – on the map or below. Without a selection: the whole map, after a confirmation. One undo step; with an event chosen in the playthrough strip painted into the event',
      }, 'Replace piece…'),
      h('span', { class: 'hint' }, r ? (r.from ? 'now the new piece' : 'click the piece to replace') : sel ? `in the selection ${sel.w}×${sel.h}` : 'on the whole map'),
      ...(sel && !r ? [h('button', { title: 'Drop the selection: replace on the whole map', onclick: () => { this.l2Sel = null; this.buildSide(); this.paint(); } }, '×')] : []));
  }
  private l2TilesOpen = true; // the 8x8 sheet below the pieces shown (folded: the pieces alone)
  // "Pieces on this map" (#337, core/owl2pieces.ts): the 2x2 entry blocks on the 16-pixel grid of the submap's view (the
  // main map whole) in the map before events, each once, the most used first, PIECE_COLS a row; a click takes one as the
  // brush (2x2: painted on its grid), no rectangle over several (they are not neighbours); the brush outlined where it is
  // one; the hover popup (at any size: the count is shown nowhere else) the piece's use and entries.
  // `drawEntries` draws a list of entries w a row (-1 none)
  private piecesSheet(drawEntries: (list: number[], w: number, W: number, H: number) => SheetPicture): HTMLElement {
    const views = this.views;
    if (!views) return h('div', { class: 'hint' }, 'Finding the submaps\' views…');
    const pieces = mapPieces(this.rom.l2, this.region, views[this.map]);
    const rows = Math.max(1, Math.ceil(pieces.length / PIECE_COLS)), w = PIECE_COLS * 2;
    const list = new Array<number>(w * rows * 2).fill(-1);
    pieces.forEach((p, i) => p.entries.forEach((v, k) => { list[(Math.floor(i / PIECE_COLS) * 2 + (k >> 1)) * w + (i % PIECE_COLS) * 2 + (k & 1)] = v; }));
    const picture = drawEntries(list, w, w * 8, rows * 16), sheet = picture.c;
    const { c, ctx, ants } = this.sheetCanvas(sheet, 'ow-pal8');
    const b = this.brush;
    const at = b.kind === 'l2' && b.w === 2 && b.h === 2 ? pieces.findIndex((p) => p.entries.every((v, j) => v === b.entries[j])) : -1;
    // (the piece to replace, picked: in its own colour, both running)
    const from = this.replacing?.from, fi = from ? pieces.findIndex((p) => samePiece(p.entries, from)) : -1;
    ctx.drawImage(sheet, 0, 0);
    this.animate(picture, c, () => ctx.drawImage(sheet, 0, 0));
    ants.set([...(at >= 0 ? [cellMark(pieceBox(at), 16)] : []), ...(fi >= 0 ? [cellMark(pieceBox(fi), 16, REPLACED_PIECE)] : [])]);
    const cellAt = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / PIECE_COLS)), y = Math.floor((e.clientY - rc.top) / (rc.height / rows));
      return { x, y, p: x >= 0 && x < PIECE_COLS ? pieces[y * PIECE_COLS + x] : undefined };
    };
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const { p } = cellAt(e);
      if (!p) return;
      hidePickerPreview(c);
      if (this.replacing) { this.pickReplace(p.entries); return; }
      this.brush = { kind: 'l2', w: 2, h: 2, entries: p.entries.slice() };
      this.buildSide();
    });
    c.addEventListener('mousemove', (e) => {
      const { x, y, p } = cellAt(e);
      if (!p) { hidePickerPreview(c); return; }
      showPickerPreview(c, e, crop(sheet, x * 16, y * 16, 16, 16), [`Piece used ${p.count} time${p.count === 1 ? '' : 's'} on this map`, p.entries.map((v) => hex(v, 4)).join(' ')]);
    });
    c.addEventListener('mouseleave', () => hidePickerPreview(c));
    return ants.root;
  }

  // a sheet's canvas filling the paint panel (in whole pixels of the sheet's), drawn in the sheet's pixels
  // (ants: the running outlines' overlay, marks in sheet pixels; its root goes onto the page)
  private sheetCanvas(sheet: HTMLCanvasElement, cls: string): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; k: number; scale: number; ants: AntsOverlay } {
    const k = this.palPixels = fillPixels(this.palWidth(), sheet.width), scale = this.palWidth() / sheet.width;
    const c = h('canvas', { width: sheet.width * k, height: sheet.height * k, class: `${cls} sheet-fill` });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return { c, ctx, k, scale, ants: new AntsOverlay(c, () => ({ w: sheet.width, h: sheet.height })) };
  }

  // a sheet's picture follows the map's animation (pickeranim.ts) while `on` is in the page, shown() drawing it there again
  private animate(p: SheetPicture, on: HTMLElement, shown: () => void): void {
    animateTiles(this.anim, p.c, p.cells, { bg: p.layer === 2, back: p.back, backAt: p.backAt, on, shown });
  }

  // a button flipping the brush of layer `kind` (tilemap entries): X-flip mirrors every row of the block, Y-flip the
  // order of the rows; the priority bit toggled
  private flipButton(kind: Layer, bit: number, label: string): HTMLButtonElement {
    return h('button', {
      onclick: () => {
        const br = this.brush;
        if (br.kind !== kind) return;
        const rows = Array.from({ length: br.h }, (_, y) => br.entries.slice(y * br.w, (y + 1) * br.w).map((v) => v ^ bit));
        if (bit === L2_FLIP_X) rows.forEach((row) => row.reverse());
        if (bit === L2_FLIP_Y) rows.reverse();
        br.entries = rows.flat();
        this.buildSide();
      },
    }, label);
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
    this.buildBar(); // (the events' names in the strip, the badge)
    this.buildSide();
    this.buildLeft();
    this.redrawMap();
    this.updateStatus();
    this.nameEditor.refresh();
  }

  show(): void {
    this.shownViews = null;
    this.check.reset(); // (edits made elsewhere are not said)
    this.pendingTile = -1;
    this.links.pending = null; // (left for another tab: ended)
    void this.views; // (asked for now: the links, sprites and events need them)
    this.event = loadEvent(this.app.romName);
    // (the map drawn last may be another ROM's: not shown while this one's load is emulated)
    this.last = null;
    if (!this.load()) {
      this.layerPx = null;
      putImage(this.l1Canvas, new Uint32Array(512 * 512), 512, 0);
      putImage(this.l2Canvas, new Uint32Array(512 * 512));
      this.composeMap();
    }
    this.sync();
    this.layout();
  }
}

// the mark of a path tile of kind k (isPathKind) on the 16x16 tile at (px, py), as the map's path marks
// draws it: walk green, climb green with rungs, swim blue, exit red, stop a cross; its ways (owpathshape.ts mapWays or
// usualWays, none while the shapes are learned) as white lines through the tile (lw: the width of a pixel)
// (each kind's colour, r,g,b: the mark's fill with its alpha, the sheet's border opaque; a level tile has no mark)
const KIND_RGB: Partial<Record<PathKind, [string, number]>> = { walk: ['90,230,100', 0.7], climb: ['90,230,100', 0.7], swim: ['60,140,255', 0.75], exit: ['235,60,60', 0.8], stop: ['255,255,255', 1], level: ['255,210,60', 1] };
const PATH_FILL = Object.fromEntries(Object.entries(KIND_RGB).map(([k, [c, a]]) => [k, `rgba(${c},${a})`])) as Partial<Record<PathKind, string>>;
export function drawPathMark(ctx: CanvasRenderingContext2D, k: PathKind, px: number, py: number, lw: number, ways: readonly PathWay[]): void {
  if (k === 'stop') {
    for (const [c, w] of [['rgba(0,0,0,0.8)', 4], ['#fff', 2]] as [string, number][]) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w * lw;
      ctx.beginPath();
      ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + 12, py + 12); ctx.moveTo(px + 12, py + 4); ctx.lineTo(px + 4, py + 12);
      ctx.stroke();
    }
    return;
  }
  ctx.fillStyle = PATH_FILL[k]!;
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
  // (a way and the way back are one line: each drawn twice, the same; cut at the tile's edge – its round ends and
  // outline would reach into the tiles next to it – so the lines of tiles side by side still meet)
  if (!ways.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, 16, 16);
  ctx.clip();
  for (const [c, w] of [['rgba(0,0,0,0.85)', 5], ['#fff', 3]] as [string, number][]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w * lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const { from, to } of ways) { ctx.moveTo(px + from[0], py + from[1]); ctx.lineTo(px + to[0], py + to[1]); }
    ctx.stroke();
  }
  ctx.restore();
}
// the colour of the border a visible tile of kind k gets in the paint sheet (the map's path marks'; a level tile yellow)
const KIND_BORDER = Object.fromEntries(Object.entries(KIND_RGB).map(([k, [c]]) => [k, `rgb(${c})`])) as Partial<Record<PathKind, string>>;
// the background of transparent pixels in the paint sheet: a checkerboard of 4x4 pixel squares (layer 2 shows there)
const checker = (x: number, y: number): number => (((x >> 2) ^ (y >> 2)) & 1 ? 0xff2a2a2a : 0xff1c1c1c);
const L2_SHEET_BACK = 0xff181818; // the background of the layer 2 sheets where no entry is
// a sheet's picture (one pixel per pixel) of layer 1 tiles (16x16) or layer 2 entries (8x8) at cells (pickeranim.ts
// animateTiles: x, y and the tile or entry, one after the other); marks: drawn over it at the size shown; back/backAt:
// the pixels where a tile draws none
interface SheetPicture { c: HTMLCanvasElement; cells: number[]; layer: 1 | 2; back?: number; backAt?: (x: number, y: number) => number; marks?: (ctx: CanvasRenderingContext2D) => void }
// the cells of `list` drawn w a row, each size×size (those `drawn` holds for)
function listCells(list: readonly number[], w: number, size: number, drawn: (v: number) => boolean): number[] {
  return list.flatMap((v, i) => (drawn(v) ? [(i % w) * size, Math.floor(i / w) * size, v] : []));
}
// piece k's cell in the "Pieces on this map" sheet
const pieceBox = (k: number) => ({ x: k % PIECE_COLS, y: Math.floor(k / PIECE_COLS), w: 1, h: 1 });
// a sheet's brush or pick (cells of `cell` pixels) as a running outline on its overlay (ants.ts), in sheet pixels
function cellMark(r: { x: number; y: number; w: number; h: number }, cell: number, color = '#4cc2ff'): AntsMark {
  return { x: r.x * cell, y: r.y * cell, w: r.w * cell, h: r.h * cell, color };
}
const REPLACED_PIECE = '#ffb000'; // the piece "Replace piece…" replaces, in the pieces sheet

// the event chosen in the strip kept per ROM (by its name) in the browser, -1: before events (a new key: the event progress
// kept before was a view only, the map painted before events)
const eventAfter = prefFamily('ow-map-after:', (name) => numberPref(name, -1));
function loadEvent(rom: string): number {
  const v = eventAfter.at(rom).get();
  return v < 0 ? -1 : stepEvent(v, 0);
}
function storeEvent(rom: string, e: number): void {
  if (e >= 0) eventAfter.at(rom).set(e); else eventAfter.at(rom).reset();
}

// View → Layers' switches kept in the browser (on unless switched off)
const dimL2Pref = boolPref('ow-dim-l2', true), l1InL2Pref = boolPref('ow-l1-in-l2', true);

// the map from its layers: black, layer 2, layer 1 over it, each at its strength (0: left out)
function composeLayers(out: HTMLCanvasElement, l1c: HTMLCanvasElement, l2c: HTMLCanvasElement, s: { l1: number; l2: number }): void {
  out.width = 512; out.height = 512;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 512, 512);
  for (const [c, a] of [[l2c, s.l2], [l1c, s.l1]] as const) {
    if (!a || !c.width) continue;
    ctx.globalAlpha = a;
    ctx.drawImage(c, 0, 0);
  }
  ctx.globalAlpha = 1;
}

// a map region's layers drawn apart: layer 1 transparent where it has no pixel, layer 2 black there (the back area)
function putMapLayers(l1c: HTMLCanvasElement, l2c: HTMLCanvasElement, rom: Rom, r: OwRender, region: number, l1: Uint16Array, l2: Uint16Array): void {
  const tcs = owTileCaches(r);
  putImage(l1c, drawOwMap(rom, r, region, l1, undefined, tcs), 512, 0);
  putImage(l2c, drawOwMap(rom, r, region, undefined, l2, tcs));
}
