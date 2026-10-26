// Application state and editing actions.

import { Rom } from '../core/rom.ts';
import { LevelEmulator, type LevelRender, type LevelOverride, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, type ScreenExit, loadLevel, spriteLoadOrder, serializeLayer1, serializeSprites, serializeLevelSprites, spriteSizes, spriteId, spriteBytes,
  isL1Vertical, newUid, hasLayer2Objects, hasObjects, L2_PTRS, SEC_HDR,
  entrancePos, nearestEntrance, encodeSecondaryHeader, mainSpot, sameSpot, placeMain, midwaySpot, nearestMidway, placeMidway, exitLandsAtMidway, isSized, SPRITE_MEMORY, levelRows, TIME_TABLE,
} from '../core/level.ts';
import { hex, spriteName } from '../core/names.ts';
import { loadPixiProject, customSpriteList, type CustomSprite } from '../core/pixi.ts';
import { renderLevel, type LevelImages, composite } from '../core/render.ts';
import { captureSprites, captureSpriteAt, type SpriteImage } from '../core/spritegfx.ts';
import { spriteMemJob, usedSpriteMemory } from '../core/spritemem.ts';
import { DM16_EXT, levelGfx, levelExtGfx, customPalette, levelMusic, defaultGfx } from '../core/patches.ts';
import { gfxSkipMask, gfxFilesHash } from '../core/gfxpages.ts';
import { flagBytes, usedFlags, isDm16, dm16Tiles, type Dm16Cond } from '../core/cdm16.ts';
import { PREFAB_EXT, PREFAB_MAX, TRANSPARENT, listPrefabs, readPrefab, writePrefab, type Prefab } from '../core/prefabs.ts';
import type { Package } from '../core/pkgreg.ts';
import { kvEntries, kvWrite, saveRom } from './storage.ts';
import { ResultCache, RomFingerprint, type CacheEntry } from '../core/romdeps.ts';
import { bgFromWram, bgIndex, encodeBg } from '../core/bg.ts';
import { lt3Override, lt3Target, lt3Covers, layer3Map, layer3Word, layer3Index, blankLayer3Tile } from '../core/layer3map.ts';
import { layer3Geometry, type Layer3Geometry } from '../core/render.ts';
import { toast, log as logMsg, modalsOpen, onModalsChange } from './dom.ts';
import { musicPlayer } from './musicplayer.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { SecondaryEntrances, NO_FREE_ENTRANCE, entranceTables } from '../core/entrances.ts';
import type { RomHistory } from '../core/romhistory.ts';
import type { EditOptions } from '../core/romedit.ts';
import { EditSession, type LevelEdit, type StepResult } from '../core/editsession.ts';
import { resizeObjectSize, type ObjKind, type ObjKinds } from '../core/objkinds.ts';
import { JumpArcs, ARC_SPEEDS, type JumpArc } from '../core/jumparcs.ts';
import { scanKey, type ScanLevel, type ScanResult } from '../core/levelscan.ts';
import { cameraAtKey, type CameraReach, type CameraAt } from '../core/camerareach.ts';
import { MARIO_W, MARIO_H, type CameraBands } from '../core/camerabands.ts';
import { layer3Kinds, tideKind, layer3Top, type Layer3Kind } from '../core/layer3.ts';
import { layer2MotionsJob, type Layer2Motions } from '../core/l2scroll.ts';
import { variantOf, blockKey, type BlockProbe, type RunStates } from '../core/blockprobe.ts';
import type { ProbeReply } from '../core/probehost.ts';
import { ProbeClient } from '../core/probeclient.ts';
import { ResultLearner } from '../core/learner.ts';
import type { RomReads } from '../core/romdeps.ts';
import { objectThumbsJob, thumbsKey, thumbsInput, objKey, type ObjSpec, type ObjThumb } from './thumbs.ts';
import { levelInput, inputHash } from '../core/inputs.ts';
import { map16Tile, bgTile } from '../core/ram.ts';
import { exanimTiles, exanimColors, exanimPeriod, readLevelList, readGlobalList } from '../core/exanim.ts';
import { emptyTriggerView, usedTriggers, initTriggers, type TriggerView, type SlotRef } from '../core/extrigger.ts';
import { LevelUses, levelTilesAll, levelOverride, usedLevels, spriteUsage, isTilesetTile, type LevelTiles, type SpriteUser } from '../core/levelusage.ts';
import { TILESETS, tilesetPointers, sharingTilesets } from '../core/tilesets.ts';
import { slipperyActions } from '../core/slippery.ts';
import { pathKindsJob, type PathKind } from '../core/owpaths.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg' | 'l3';
// the modes painted with a brush of tiles picked from the level or the palette: BG tiles, layer 3's 8x8 tiles
export const isBrushMode = (m: EditMode) => m === 'bg' || m === 'l3';
export interface Brush { w: number; h: number; tiles: number[] }
export type PaletteItem =
  // block: a rectangle of Map16 tiles from the palette sheet (tile + row * 16 + col), one Direct-Map16 object each
  // prefab: prefab number (extended object $04, see prefabs.ts)
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number; block?: { w: number; h: number }; prefab?: number }
  | { kind: 'spr'; num: number; extra: number };

type Listener = () => void;

export type { LevelEdit };

// What App tells its views (on/once/emit). None carries data: listeners read what they need from App.
export type AppEvent =
  | 'change' // the level (or the selection, the mode's objects) was edited
  | 'level' // another level was opened (also after "Save as")
  | 'level-header' // the level's header, GFX slots or palette changed
  | 'mode' // the edit mode (layer 1/2, sprites, BG, exits …) changed
  | 'render' // the level was emulated and drawn again
  | 'rom-change' // the ROM was written (a ROM edit, undo/redo, a level save)
  | 'probes' // the asked or the prefetched probes are done (block, collision, sprite, run speeds)
  | 'objkinds' // object kinds asked for are known (or failed)
  | 'level-scan' // the level scan of the level as edited is known
  | 'game-view' // the camera at Mario's place for the game view frame is known (or asked for)
  | 'level-uses' // more levels' Map16 tiles are known (levelTiles)
  | 'palette-item' // a sprite was chosen in the palette
  | 'arcs' // jump arcs asked for are known
  | 'sprites' // sprite images were captured
  | 'thumbs' // object thumbnails asked for are known
  | 'sprite-mem' // the sprite memory check of the level is known
  | 'animated' // which tiles and colors of the level animate is known
  | 'anim-frame' // the next frame of the level animation is shown
  | 'prefabs' // the prefab table changed
  | 'bgtile' // the BG or layer 3 brush changed (picked from the level)
  | 'reveal' // the level view scrolls to App.reveal
  | 'zoom' // the level view's zoom changed
  | 'busy' // background work (setBusy), a modal or the music player changed
  | 'open-gfx' // the graphics workspace opens on App.wsGfx
  | 'open-map16' // the graphics workspace opens on the Map16 tab
  | 'import-gfx'; // the graphics workspace imports App.gfxImport

const CACHE_PREFIX = 'rc3:'; // IndexedDB keys of the result cache (bump when result formats change or old results may be wrong: rc3 after the stale boot snapshot fix)

// the 8x8 tiles (layer 1 tile numbers) and colors that change in level n (ov) over 16 times 4 frames (none
// when it fails)
function animatedIn(emu: LevelEmulator, n: number, ov: LevelOverride): { tiles: Set<number>; colors: Set<number> } {
  const tiles = new Set<number>(), colors = new Set<number>();
  try {
    const r = emu.load(n, ov);
    const frames = emu.animationFrames(16, 4);
    const base = (r.ppuRegs[0x0b] & 0x0f) << 13;
    for (const f of frames) {
      for (let t = 0; t < 0x400; t++) {
        const o = (base + t * 32) & 0xffff;
        for (let b = 0; b < 32; b++) if (f.vram[o + b] !== r.vram[o + b]) { tiles.add(t); break; }
      }
      for (let c = 0; c < 256; c++) if (f.cgram[c * 2] !== r.cgram[c * 2] || f.cgram[c * 2 + 1] !== r.cgram[c * 2 + 1]) colors.add(c);
    }
  } catch (e) { console.error(e); return { tiles: new Set(), colors: new Set() }; }
  return { tiles, colors };
}

// result of the sprite memory check (see App.checkSpriteMem); gen: the edit session's levelGen when it started
export interface SpriteMemState { key: string; level: number; mem: number; gen: number; conflicts: Set<number>; suggestion: number | null }

// entrance markers: main entrance, midway point, secondary entrances leading into this level
export interface Marker { kind: 'main' | 'midway' | 'sec'; index: number; x: number; y: number }

export class App {
  rom: Rom;
  romName: string;
  emu: LevelEmulator;
  // the open level, its dirty flag, level and ROM edits and their undo (editsession.ts)
  edits: EditSession;
  // secondary entrances over the ROM and the open level as edited (the entrances into it, the exit graph)
  readonly entrances: SecondaryEntrances;
  get level(): Level { return this.edits.level; }
  get dirty(): boolean { return this.edits.dirty; }
  get romHistory(): RomHistory { return this.edits.romHistory; }
  render!: LevelRender;
  images!: LevelImages;
  compositeImg!: Uint32Array;
  // the edit mode: changed through setMode (or App's own level opening and exit jumps)
  private editMode: EditMode = 'l1';
  get mode(): EditMode { return this.editMode; }
  selection = new Set<number>();
  paletteItem: PaletteItem | null = null;
  // BG mode brush: a w×h block of BG Map16 tiles (row-major), picked from the palette sheet or the level
  bgBrush: Brush = { w: 1, h: 1, tiles: [0] };
  l3Brush: Brush = { w: 1, h: 1, tiles: [0] }; // layer 3 tilemap words
  zoom = 2;
  show = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: false, items: true, collision: false, arcs: false, gameView: false, scrollBands: false };
  // the game view frame's top left corner in level pixels (levelview.ts), kept while editing and between levels
  gameView: { x: number; y: number } | null = null;
  // the frame placed by Mario (Shift+V): his place (inside the level) and the camera the game puts there in the
  // level as edited (key: its result cache key; camera undefined while it is played, null when it could not be);
  // kept while editing and between levels, until the frame is dragged; asked for only while the frame is shown
  gameViewMario: { x: number; y: number; key: string | null; camera?: CameraAt | null } | null = null;
  // view-only game state applied before the emulated level load
  switches = { palaces: false, onOff: false };
  // the conditional Direct Map16 flags on (cdm16.ts), in the view and in test play
  cdm16 = new Set<number>();
  // the ExAnimation triggers the view switches (extrigger.ts), set after the level's load; test play too
  exTriggers: TriggerView = emptyTriggerView();
  wsTile = 0; // Map16 tile for 'open-map16' (opens the graphics workspace there)
  wsTileBg = false; // wsTile is a BG tile
  gfxImport: { file: File; into: Package | null } | null = null; // for 'import-gfx'
  wsGfx: number | null = null; // GFX file for 'open-gfx'
  private romTimer = 0;
  holdRender = false; // while drawing: the debounced re-emulation waits (it would stall the stroke)
  private quietUntil = 0; // and after a stroke until then (the next one often follows quickly)
  private persistTimer = 0;
  clipboard: { objects?: LevelObject[]; sprites?: LevelSprite[] } = {};
  // tile (x,y) lookup from map offset
  offsetToTile1 = new Int32Array(MAP_SIZE);
  offsetToTile2 = new Int32Array(MAP_SIZE);
  private listeners = new Map<AppEvent, Set<Listener>>();
  renderError: string | null = null;
  // block behaviour probes (emulated hits), object kinds and level scan, run in a Web Worker;
  // 'probes' once the asked or the prefetched probes are done
  probes: ProbeClient;
  exitScreen = 0;
  // mode 'exit': the chosen entrance marker, else the screen exitScreen (and its exit)
  exitMarker: { kind: Marker['kind']; index: number } | null = null;
  spriteThumbs = new Map<number, HTMLCanvasElement>(); // sprite images by sprite id (ensureSpriteImages)
  private canvases = new WeakMap<SpriteImage, HTMLCanvasElement>();
  // results found out by emulation, valid while the ROM they read is unchanged (see romdeps.ts);
  // stored in IndexedDB, loaded once at start (cacheReady)
  results: ResultCache;
  cacheReady: Promise<void>;
  // learns the emulated results the probe worker doesn't, on the main thread (learner.ts)
  private learner: ResultLearner;
  private cacheTimer = 0;
  private closed = false; // project closed: nothing is written to the browser any more
  reveal = { x: 0, y: 0 }; // pixel the level view scrolls to on 'reveal'
  // tile/palette animation: frames stored as pixel diffs against the static composite
  anim = { gen: 0, snaps: [] as { vram: Uint8Array; cgram: Uint8Array }[], base: null as Uint32Array | null,
    frames: [] as { idx: Uint32Array; val: Uint32Array }[], phase: -1, timer: 0 };

  constructor(rom: Rom, name: string) {
    this.rom = rom;
    this.romName = name;
    this.emu = new LevelEmulator(rom);
    this.emu.skipMask = () => this.gfxSkipMask();
    this.emu.boot();
    onModalsChange(() => { this.resumeBackground(); this.emit('busy'); });
    // sprite images: learned again when what they depend on changed (the learner decides)
    this.on('render', () => this.ensureSpriteImages());
    this.on('rom-change', () => this.ensureSpriteImages());
    musicPlayer.onChange(() => { this.resumeBackground(); this.emit('busy'); });
    // level edits and ROM edits (romEdit: one undo step, all or nothing, the follow-ups below)
    this.edits = new EditSession(rom, {
      changed: (rerender) => this.levelChanged(rerender),
      saved: (log, silent) => this.levelSaved(log, silent),
      saveFailed: (e) => toast(`Save failed: ${e}`, 'error'),
      written: () => this.romChanged(),
      followUps: [
        // the open level as stored (a patch rewrote its sprite data, a package its sample …): loaded again
        { read: (r) => (this.level ? levelSignature(r, this.level.number) : ''), changed: () => this.reloadLevel() },
        // its graphics slots, own palette or music: shown at once
        { read: (r) => (this.level ? headerSignature(r, this.level.number) : ''), changed: () => { this.flushRomChange(); this.emit('level-header'); } },
        { read: (r) => prefabsSignature(r), changed: () => { this.flushRomChange(); this.emit('prefabs'); this.emit('change'); } },
        // the secondary entrances (markers, the exit panel): shown at once, also after undo/redo
        { read: (r) => entranceTables(r), changed: () => this.emit('change') },
      ],
    });
    this.entrances = new SecondaryEntrances(this.edits);
    this.results = new ResultCache(new RomFingerprint(rom));
    this.cacheReady = kvEntries<CacheEntry>(CACHE_PREFIX)
      .then((e) => this.results.load(e.map(([k, v]) => [k.slice(CACHE_PREFIX.length), v])))
      .catch((e) => console.error(e));
    this.learner = new ResultLearner({
      rom, results: this.results, cacheReady: this.cacheReady, main: this.emu,
      later: (key, step) => this.later(key, step),
      soon: (step) => setTimeout(step, 0),
      setBusy: (key, label) => this.setBusy(key, label),
    });
    this.probes = new ProbeClient({
      results: this.results,
      cacheReady: this.cacheReady,
      rom: () => this.rom,
      tileset: () => this.level.header.tileset,
      kindLevel: () => {
        const lv = this.level;
        return { level: { number: lv.number, header: lv.header }, layer2Pointer: lv.layer2Objects ? this.rom.r24(L2_PTRS + 0x105 * 3) : lv.layer2Pointer };
      },
      connect: (reply, failed) => {
        const w = new Worker(new URL('./probeworker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ProbeReply>) => reply(e.data);
        w.onerror = (e) => { console.error(e); w.terminate(); failed(); };
        return (m) => w.postMessage(m, m.type === 'rom' ? [m.data.buffer] : m.type === 'edit' ? m.edits.map(([, b]) => b.buffer) : []);
      },
      later: (key, step) => this.later(key, step),
      setBusy: (key, label) => this.setBusy(key, label),
      ready: () => this.emit('probes'),
      kindsReady: () => this.emit('objkinds'),
    });
    this.results.onChange = () => {
      if (!this.cacheTimer && !this.closed) this.cacheTimer = window.setTimeout(() => this.storeResults(), 3000);
    };
    window.addEventListener('pagehide', () => {
      if (this.cacheTimer && !this.closed) { clearTimeout(this.cacheTimer); this.storeResults(); }
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = 0; this.persist(); } // a ROM edit not stored yet
    });
  }

  private storeResults(): void {
    this.cacheTimer = 0;
    const { put, del } = this.results.flush();
    kvWrite(put.map(([k, v]) => [CACHE_PREFIX + k, v]), del.map((k) => CACHE_PREFIX + k)).catch((e) => console.error(e));
  }

  on(ev: AppEvent, fn: Listener): void {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
  }
  // fn the next time ev is emitted only
  once(ev: AppEvent, fn: Listener): void {
    const go = () => { this.listeners.get(ev)?.delete(go); fn(); };
    this.on(ev, go);
  }
  emit(ev: AppEvent): void {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  // background jobs currently running (key -> label), shown by the busy indicator
  busy = new Map<string, string>();
  setBusy(key: string, label: string | null): void {
    if (label === null ? !this.busy.delete(key) : this.busy.get(key) === label) return;
    if (label !== null) this.busy.set(key, label);
    this.emit('busy');
  }

  // ------------- background work -------------
  // Slices of background emulation (block behavior, sprite graphics, scans …) run as low-priority
  // tasks, so input, drawing and audio go first. While a dialog is open or music plays they wait:
  // they would stall the dialog and make the sound crackle. The next slice of each job is parked by
  // its key and continues once nothing holds it.
  private parked = new Map<string, () => void>();
  backgroundHeld(): boolean { return modalsOpen() > 0 || musicPlayer.holdsBackground; }
  later(key: string, step: () => void): void {
    if (this.backgroundHeld()) { this.parked.set(key, step); return; }
    const go = () => { if (this.backgroundHeld()) this.parked.set(key, step); else step(); };
    const sch = (globalThis as { scheduler?: { postTask?: (f: () => void, o: { priority: string }) => Promise<void> } }).scheduler;
    if (sch?.postTask) { sch.postTask(go, { priority: 'background' }).catch((e) => console.error(e)); return; }
    // otherwise a message (setTimeout is throttled in hidden tabs)
    if (!this.bgChannel) {
      const ch = this.bgChannel = new MessageChannel(), q = this.bgQueue;
      ch.port1.onmessage = () => q.shift()?.();
    }
    this.bgQueue.push(go);
    this.bgChannel.port2.postMessage(0);
  }
  private bgChannel: MessageChannel | null = null;
  private bgQueue: (() => void)[] = [];
  private resumeBackground(): void {
    if (this.backgroundHeld() || !this.parked.size) return;
    const p = [...this.parked];
    this.parked.clear();
    for (const [k, step] of p) this.later(k, step);
  }

  // ------------- level loading / rendering -------------
  // opens level n (the open one saved first, or its unsaved changes dropped with discard)
  openLevel(n: number, discard = false): void {
    this.edits.open(n, discard);
    this.selection.clear();
    this.exitScreen = 0;
    this.exitMarker = null;
    if (this.layerGone()) this.editMode = 'l1';
    this.spriteMem = this.spriteMemBase = null;
    this.refresh();
    this.emit('level');
    logMsg(`Level ${hex(n, 3)} opened`);
    this.scheduleSpriteMem();
    this.probes.prefetch();
  }

  get vertical(): boolean {
    return isL1Vertical(this.rom, this.level.header.mode);
  }

  buildOverrides(): LevelOverride {
    const lv = this.level, ov = levelOverride(this.rom, lv);
    return {
      ...ov,
      bgData: !ov.layer2 && lv.bg ? encodeBg(lv.bg) : undefined,
      layer3: lt3Override(this.rom, lv),
      sprites: serializeLevelSprites(this.rom, lv),
      switchPalaces: this.switches.palaces,
      onOffSwitch: this.switches.onOff,
      cdm16Flags: flagBytes(this.cdm16),
      // sub-level loads keep the old timer: the level's header time, as entered from the overworld
      timer: this.rom.r8(TIME_TABLE + lv.header.time),
      exTriggers: this.exTriggers,
      secondaryHeader: encodeSecondaryHeader(lv.secondary),
    };
  }

  // What every result learned from the level as edited depends on outside the ROM (inputs.ts): its data and the
  // view settings, as a load is given them (ov); the learner's input for such results
  levelInput(ov = this.buildOverrides()): ReturnType<typeof levelInput> {
    return levelInput(this.level.number, ov);
  }

  // what the render was made from: its inputs, the ROM generation and the ROM bytes it read
  private rendered: { key: string; gen: number; reads: RomReads } | null = null;

  // the level emulated and drawn anew – unless its inputs and the ROM bytes the last render read are unchanged
  // (a ROM edit elsewhere: the overworld, another level's data)
  refresh(): void {
    const lv = this.level, ov = this.buildOverrides();
    const key = inputHash({ level: lv.number, ov, header: lv.header, secondary: lv.secondary, show: this.show, mode: this.mode });
    const was = this.rendered, changes = was?.key === key ? this.rom.changesSince(was.gen) : null;
    if (was && changes && !was.reads.touches(changes)) {
      was.gen = this.rom.gen;
      this.scheduleScan();
      this.updateGameViewCamera(ov);
      return;
    }
    const gen = this.rom.gen;
    const { reads } = this.emu.recordAll(() => {
      const r = this.emu.load(lv.number, ov);
      this.renderError = r.ok ? null : r.error ?? 'Error';
      // as many steps as the level's own animations take to repeat (the game's repeat after 8)
      this.anim.snaps = this.show.anim && r.ok ? this.emu.animationFrames(exanimPeriod([readLevelList(this.rom, lv.number), readGlobalList(this.rom)], 64, 8)) : [];
      this.render = r;
      this.images = renderLevel(this.rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
    });
    this.rendered = { key, gen, reads };
    // palette thumbnails are transparent: shown on the level's backdrop as in the game
    const c = this.images.backdrop;
    document.documentElement.style.setProperty('--level-backdrop', `rgb(${c & 0xff},${(c >> 8) & 0xff},${(c >> 16) & 0xff})`);
    this.compositeImg = this.compose();
    this.buildOffsetMaps();
    this.startAnimation();
    this.emit('render');
    this.scheduleScan();
    this.updateGameViewCamera(ov);
  }

  recomposite(): void {
    this.compositeImg = this.compose();
    this.startAnimation();
    this.emit('render');
  }

  // the object layer not being edited is ghosted (only in levels with two object layers), editing layer 3 both
  compose(images = this.images): Uint32Array {
    const ghost = !this.show.ghost ? 0 : this.mode === 'l3' ? 3 : this.mode === 'bg' ? 1 : this.level.layer2Objects ? (this.mode === 'l1' ? 2 : this.mode === 'l2' ? 1 : 0) : 0;
    return composite(images, this.show.layer1, this.show.layer2, ghost, this.show.layer3);
  }

  // renders the animation snapshots in the background, then cycles them (8 game frames each)
  startAnimation(): void {
    const a = this.anim;
    const gen = ++a.gen;
    a.frames = [];
    a.phase = -1;
    a.base = this.compositeImg;
    if (!a.snaps.length) { clearInterval(a.timer); a.timer = 0; this.setBusy('anim', null); return; }
    const base = a.base, snaps = a.snaps, lv = this.level;
    let i = 0;
    const step = () => {
      if (gen !== a.gen) return;
      this.setBusy('anim', `Animations ${i + 1}/${snaps.length}`);
      const li = renderLevel(this.rom, { ...this.render, vram: snaps[i].vram, cgram: snaps[i].cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
      const img = this.compose(li);
      const idx: number[] = [];
      for (let k = 0; k < img.length; k++) if (img[k] !== base[k]) idx.push(k);
      const ix = Uint32Array.from(idx);
      a.frames.push({ idx: ix, val: ix.map((k) => img[k]) });
      if (++i < snaps.length) this.later('anim', step);
      else this.setBusy('anim', null);
      if (i === snaps.length && !a.timer) a.timer = window.setInterval(() => this.animTick(), 1000 / 7.5);
    };
    this.later('anim', step);
  }

  animTick(): void {
    const a = this.anim;
    if (!a.frames.length || !a.base) return;
    if (!this.show.anim) { clearInterval(a.timer); a.timer = 0; return; }
    if (this.backgroundHeld()) return;
    const img = this.compositeImg === a.base ? a.base.slice() : this.compositeImg;
    const prev = a.frames[a.phase];
    if (prev) for (const k of prev.idx) img[k] = a.base[k];
    a.phase = (a.phase + 1) % a.frames.length;
    const f = a.frames[a.phase];
    for (let j = 0; j < f.idx.length; j++) img[f.idx[j]] = f.val[j];
    this.compositeImg = img;
    this.emit('anim-frame');
  }

  // ------------- entrances -------------
  markers(): Marker[] {
    const s = this.level.secondary;
    const vert = (s.verticalPositioning & 1) !== 0;
    const main = entrancePos(this.rom, mainSpot(s), vert);
    const mid = entrancePos(this.rom, midwaySpot(s), vert);
    const out: Marker[] = [{ kind: 'midway', index: 0, ...mid }, { kind: 'main', index: 0, ...main }];
    for (const i of this.entrances.inOpenLevel()) out.push({ kind: 'sec', index: i, ...this.entrances.place(i) });
    return out;
  }

  // snaps a marker to the entrance setting nearest to Mario's top-left pixel (px, py) – in a level with a
  // size the tile there (Lunar Magic's, the camera then relative to Mario); main/midway change the level
  // (undoable), secondary entrances are ROM edits (core/entrances.ts). The midway point goes to the tile there
  // with its own settings (Lunar Magic's midway entrance; the main entrance's at first).
  moveMarker(m: Marker, px: number, py: number): boolean {
    const s = this.level.secondary;
    const vert = (s.verticalPositioning & 1) !== 0;
    const maxScreen = this.level.header.screens - 1;
    if (m.kind === 'midway') {
      const p = nearestMidway(this.rom, s, px, py, maxScreen);
      if (s.midwayOwn && sameSpot(midwaySpot(s), p)) return false;
      placeMidway(s, p);
      return true;
    }
    if (m.kind === 'sec') return this.entrances.move(m.index, px, py);
    const p = nearestEntrance(this.rom, px, py, vert, maxScreen, this.entranceRows());
    if (sameSpot(mainSpot(s), p)) return false;
    placeMain(s, p);
    return true;
  }

  // entrances are placed at tiles in a level with a size (the game's table positions don't reach its rows)
  entranceRows(): number {
    return isSized(this.level.secondary) ? levelRows(this.level.secondary) : 0;
  }

  // whether a screen has tiles that can be entered (pipes, doors); null while probes are pending
  enterableOn(screen: number): boolean | null {
    const g = this.images?.geom1, w = this.render?.wram;
    if (!g || !w) return null;
    const v = this.vertical;
    const x0 = v ? 0 : screen * 16, x1 = Math.min(g.width, v ? g.width : x0 + 16);
    const y0 = v ? screen * 16 : 0, y1 = Math.min(g.height, v ? y0 + 16 : g.height);
    let pending = false;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const a = g.addr(x, y);
      if (a < 0) continue;
      const p = this.probes.block(map16Tile(w, a));
      if (!p) pending = true;
      else if (p.enter) return true;
    }
    return pending ? null : false;
  }

  // mode 'exit': chooses an entrance marker (null: the screen exitScreen)
  selectEntrance(m: { kind: Marker['kind']; index: number } | null): void {
    this.exitMarker = m && { kind: m.kind, index: m.index };
    if (m) this.selection.clear();
    this.emit('change');
  }

  // mode 'exit': chooses a screen (and its exit)
  selectScreen(scr: number): void {
    const ex = this.level.exits.find((x) => x.screen === scr);
    this.selection = new Set(ex ? [ex.uid] : []);
    this.exitScreen = scr;
    this.exitMarker = null;
    this.emit('change');
  }

  // a new secondary entrance into the open level at the entrance setting nearest to (px, py), then chosen
  newSecondaryEntrance(px: number, py: number): number | null {
    const idx = this.entrances.createAt(px, py);
    if (idx === null) { toast(NO_FREE_ENTRANCE, 'error'); return null; }
    this.selectEntrance({ kind: 'sec', index: idx });
    return idx;
  }

  // clears a secondary entrance (free again), no longer chosen
  removeSecondaryEntrance(idx: number): void {
    if (this.exitMarker?.kind === 'sec' && this.exitMarker.index === idx) this.exitMarker = null;
    this.entrances.remove(idx);
  }

  // moves the main entrance or the midway point to the setting nearest to (px, py), undoable
  placeEntrance(kind: 'main' | 'midway', px: number, py: number): void {
    if (!this.editLevel(() => this.moveMarker({ kind, index: 0, x: 0, y: 0 }, px, py))) return;
    this.selectEntrance({ kind, index: 0 });
  }

  // opens the level an exit leads to and chooses the entrance it arrives at
  gotoExitTarget(e: ScreenExit): void {
    const t = exitTarget(this.rom, this.level.number, e);
    if (t.overworld) return;
    this.openLevel(t.to);
    this.editMode = 'exit';
    this.exitMarker = t.entrance >= 0 ? { kind: 'sec', index: t.entrance }
      : { kind: exitLandsAtMidway(e, this.level.secondary) ? 'midway' : 'main', index: 0 };
    this.emit('mode');
    this.revealMarker();
  }

  // set by the host: shows the overworld with layer 1 tile i (l1Index) selected
  gotoOverworldTile: (i: number) => void = () => {};

  // opens a level and chooses the screen of one of its exits
  gotoExit(level: number, screen: number): void {
    if (level !== this.level.number) this.openLevel(level);
    this.editMode = 'exit';
    this.emit('mode');
    this.selectScreen(screen);
    this.reveal = this.vertical ? { x: 128, y: screen * 256 + 128 } : { x: screen * 256 + 128, y: 200 };
    this.emit('reveal');
  }

  // opens level n (unless it is open) and scrolls to a tile of it
  showUse(n: number, at?: { x: number; y: number }): void {
    if (n !== this.level.number) this.openLevel(n);
    if (!at) return;
    this.reveal = { x: at.x * 16 + 8, y: at.y * 16 + 8 };
    this.emit('reveal');
  }

  // scrolls the level view to the chosen marker
  revealMarker(): void {
    const sel = this.exitMarker;
    const m = sel && this.markers().find((x) => x.kind === sel.kind && x.index === sel.index);
    this.emit('change');
    if (!m) return;
    this.reveal = { x: m.x + 8, y: m.y + 24 };
    this.emit('reveal');
  }

  buildOffsetMaps(): void {
    const g1 = this.images.geom1;
    this.offsetToTile1.fill(-1);
    for (let y = 0; y < g1.height; y++) for (let x = 0; x < g1.width; x++) {
      const a = g1.addr(x, y) - MAP_BASE;
      if (a >= 0 && a < MAP_SIZE) this.offsetToTile1[a] = (y << 16) | x;
    }
    this.offsetToTile2.fill(-1);
    const g2 = this.images.geom2;
    if (g2) for (let y = 0; y < g2.height; y++) for (let x = 0; x < g2.width; x++) {
      const a = g2.addr(x, y) - MAP_BASE;
      if (a >= 0 && a < MAP_SIZE) this.offsetToTile2[a] = (y << 16) | x;
    }
  }

  // ------------- sprite images (captured from the running game) -------------
  // kept in the result cache like the probes: all images of a sprite GFX/palette setting together,
  // variant images by sprite and position; their input (spriteInput) the rest of what they depend on
  // custom sprites of the ROM's PIXI project (see pixi.ts), by sprite id ($2xx / $3xx with the extra bit)
  private customMemo: { gen: number; list: CustomSprite[] } = { gen: -1, list: [] };
  customSprites(): CustomSprite[] {
    const m = this.customMemo;
    if (m.gen === this.rom.gen) return m.list;
    m.gen = this.rom.gen; m.list = [];
    try {
      const p = loadPixiProject(this.rom);
      if (p) m.list = customSpriteList(p);
    } catch (e) { console.error(e); }
    return m.list;
  }
  customSprite(id: number): CustomSprite | undefined {
    return id >= 0x200 ? this.customSprites().find((c) => c.id === id) : undefined;
  }
  // name of a sprite id
  spriteLabel(id: number): string {
    if (id < 0x200) return spriteName(id);
    return this.customSprite(id)?.name ?? `Custom Sprite ${hex(id & 0xff, 2)}${id & 0x100 ? ' (extra bit)' : ''} – not inserted`;
  }

  // the images of all sprites (spriteThumbs, 'sprites' as they come), learned unless known: asked for on every
  // render and ROM change
  ensureSpriteImages(): void {
    const lv = this.level, hd = lv.header, show = this.showSprites;
    const all = [...Array.from({ length: 0xe7 }, (_, i) => i), ...this.customSprites().map((c) => c.id)]; // as listed in the palette
    const lvNum = lv.number, bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
    const header = { ...hd }, sh = lv.spriteHeader;
    // i5: with the input; sprites from $C9 on (shells, groups), failed batches retried one by one, sprites
    // that draw nothing shown by what they spawn
    const stored = this.learner.learn(`i5${hd.spriteGfx}-${hd.spritePalette}`, function* (emu) {
      show(null);
      const images: [number, SpriteImage][] = [];
      for (let i = 0; i < all.length; i += 6) {
        // one test level load (six sprite slots) per step
        const r = captureSprites(emu, lvNum, header, sh, bg, all.slice(i, i + 6));
        show(r);
        images.push(...r);
        yield `Sprite graphics ${Math.min(100, Math.round((i + 6) / all.length * 100))} %`;
      }
      return images;
    }, { input: this.spriteInput(), lane: 'sprites', replace: true, label: 'Sprite graphics', progress: this.spritesShown, done: this.spritesLearned });
    if (stored && stored !== this.spritesFrom) this.spritesLearned(stored);
  }
  private spritesFrom: [number, SpriteImage][] | null = null; // the images spriteThumbs shows
  private spritesLearned = (images: [number, SpriteImage][]) => {
    this.showSprites(null);
    this.showSprites(images);
    this.spritesFrom = images;
    this.emit('sprites');
  };
  // adds images to spriteThumbs (null: clears it)
  private showSprites = (images: Iterable<[number, SpriteImage]> | null) => {
    if (!images) { this.spriteThumbs.clear(); this.spritesFrom = null; return; }
    for (const [n, img] of images) this.spriteThumbs.set(n, this.spriteCanvas(img));
  };

  // What sprite images depend on besides the ROM bytes they read: the level's sprite settings (sprite memory:
  // a sprite whose OAM range is too small is captured as the game shows it), the content of its sprite
  // graphics files (graphics data isn't among the bytes read, see gfxSkipMask) and the custom sprites
  private spriteInput(): unknown {
    const lv = this.level, hd = lv.header, files = this.spriteGfxFiles();
    const m = this.spriteFiles;
    if (m.gen !== this.rom.gen || m.files !== files.join()) { m.gen = this.rom.gen; m.files = files.join(); m.hash = gfxFilesHash(this.rom, files); }
    return { gfx: hd.spriteGfx, palette: hd.spritePalette, memory: lv.spriteHeader & SPRITE_MEMORY, files: m.hash, custom: this.customSprites().map((c) => c.id) };
  }
  private spriteFiles = { gen: -1, files: '', hash: 0 }; // the hash of the sprite graphics files

  // image of sprite id (see spriteId) at tile (x, y): sprites that start differently depending on their
  // position (see SpriteVariants) get an own image per variant, captured in the background once known;
  // custom sprites with extra bytes other than 0 one per bytes
  spriteImage(id: number, x: number, y: number, bytes?: number[]): HTMLCanvasElement | undefined {
    const base = this.spriteThumbs.get(id);
    const lv = this.level, bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
    const shown = this.spritesShown, set = `${lv.header.spriteGfx}-${lv.header.spritePalette}`;
    if (bytes?.some((b) => b)) {
      const b = [...bytes];
      const img = this.learner.learn(`b3${set}:${id}:${b.join(',')}`, function* (emu) {
        return captureSprites(emu, lv.number, lv.header, lv.spriteHeader, bg, [id], undefined, b).get(id) ?? null;
      }, { input: this.spriteInput(), lane: 'bytes', done: shown });
      return img ? this.spriteCanvas(img) : base;
    }
    const p = this.probes.sprite(id);
    if (!p || p.variants.reps.length < 2) return base;
    const at = p.variants.reps[variantOf(p.variants, x, y)];
    const img = this.learner.learn<SpriteImage | null>(`v5${set}:${id}:${at.x}:${at.y}`, function* (emu) {
      return captureSpriteAt(emu, lv.number, lv.header, lv.spriteHeader, bg, id, at.x, at.y);
    }, { input: this.spriteInput(), lane: 'variants', label: (n) => `Sprite variants (${n})`, done: shown });
    return img ? this.spriteCanvas(img) : base;
  }
  private spritesShown = () => this.emit('sprites');
  // image of a placed sprite
  spriteImageOf(s: LevelSprite): HTMLCanvasElement | undefined {
    return this.spriteImage(spriteId(s), s.x, s.y, s.extra >= 2 ? s.bytes : undefined);
  }

  // ROM bytes of GFX file data: emulated results don't depend on them (graphics only reach VRAM);
  // sprite images and object thumbnails have the files' content in their input instead
  private gfxMaskMemo: { gen: number; mask: Uint8Array | null } = { gen: -1, mask: null };
  gfxSkipMask(): Uint8Array | null {
    const m = this.gfxMaskMemo;
    if (m.gen !== this.rom.gen) { m.gen = this.rom.gen; m.mask = gfxSkipMask(this.rom); }
    return m.mask;
  }

  // the content of the bytes gfxSkipMask leaves out of the bytes read (graphics and ExAnimation data), for
  // results that depend on them; once per ROM state
  private maskedHash(): number {
    const m = this.maskedMemo;
    if (m.gen !== this.rom.gen) {
      const mask = this.gfxSkipMask(), d = this.rom.data;
      let h = 0x811c9dc5;
      if (mask) for (let i = 0; i < d.length; i++) if (mask[i]) h = Math.imul(h ^ d[i], 0x01000193);
      m.gen = this.rom.gen; m.hash = h >>> 0;
    }
    return m.hash;
  }
  private maskedMemo = { gen: -1, hash: 0 };

  // GFX files in the level's sprite slots (sprite images depend on these only)
  private spriteGfxFiles(): number[] {
    const hd = this.level.header;
    const set = levelGfx(this.rom, this.level.number), def = defaultGfx(this.rom, hd.tileset, hd.spriteGfx);
    return [0, 1, 2, 3].map((k) => (set[k] !== 0xff ? set[k] : def[k]));
  }

  private spriteCanvas(img: SpriteImage): HTMLCanvasElement {
    let c = this.canvases.get(img);
    if (!c) this.canvases.set(img, (c = spriteCanvas(img)));
    return c;
  }

  // ------------- sprite memory (see spritemem.ts) -------------
  // sprites drawn incompletely because their OAM range is too small, and a sprite memory value
  // that shows all; checked in the background after every change
  spriteMem: SpriteMemState | null = null;
  private spriteMemBase: SpriteMemState | null = null; // the latest check no edit came after (autocorrection compares with it)
  private spriteMemTimer = 0;
  private spriteMemRun = 0;
  private usedMem: { gen: number; list: number[] } = { gen: -1, list: [] };

  private scheduleSpriteMem(): void {
    clearTimeout(this.spriteMemTimer);
    this.spriteMemTimer = window.setTimeout(() => this.cacheReady.then(() => this.checkSpriteMem()), 300);
  }

  private checkSpriteMem(): void {
    const lv = this.level, mem = lv.spriteHeader & SPRITE_MEMORY, gen = this.edits.levelGen;
    // canonical order: results are stored by index, uids differ between sessions
    const sprites = [...lv.sprites].sort((a, b) => a.x - b.x || a.y - b.y || a.num - b.num || a.extra - b.extra);
    if (this.usedMem.gen !== this.rom.gen) this.usedMem = { gen: this.rom.gen, list: usedSpriteMemory(this.rom) };
    const candidates = this.usedMem.list;
    const bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900, header = { ...lv.header };
    // the test level it plays: the level's header and BG, its sprites
    const input = { mem, header, bg, candidates, sprites: sprites.map((q) => [q.num, q.x, q.y, q.extra, q.bytes ?? []]) };
    const key = `sm3:${lv.number}`, checked = `${key}#${inputHash(input)}`;
    if (this.spriteMem?.key === checked) return;
    const run = ++this.spriteMemRun;
    const done = (r: { lost: number[]; suggestion: number | null }) => {
      if (run !== this.spriteMemRun || this.level !== lv) return;
      const cur = { key: checked, level: lv.number, mem, gen, conflicts: new Set(r.lost.map((i) => sprites[i].uid)), suggestion: r.suggestion };
      this.spriteMem = cur;
      this.emit('sprite-mem');
      if (gen !== this.edits.levelGen) return; // edited meanwhile: checked again
      const base = this.spriteMemBase;
      this.spriteMemBase = cur;
      if (base) this.autoSpriteMem(base, cur);
    };
    const stored = this.learner.learn(key, function* (emu) {
      const r = yield* spriteMemJob({ emu, level: lv.number, header, bgPointer: bg }, mem, candidates, sprites);
      return { lost: [...r.check.conflicts].map((u) => sprites.findIndex((q) => q.uid === u)), suggestion: r.suggestion };
    }, { input, lane: 'spritemem', replace: true, label: 'Checking sprite memory', done });
    if (stored) done(stored);
  }

  // An edit (committed since the previous check, same sprite memory) that makes further sprites
  // incomplete sets the suggested value, as part of that edit's undo step. A value chosen by hand
  // stays as long as edits add no new conflicts.
  private autoSpriteMem(prev: SpriteMemState, cur: SpriteMemState): void {
    if (prev.level !== cur.level || prev.mem !== cur.mem || prev.gen === cur.gen || cur.suggestion === null) return;
    if (![...cur.conflicts].some((u) => !prev.conflicts.has(u))) return;
    if (this.edits.lastStep !== 'level') return;
    this.level.spriteHeader = (this.level.spriteHeader & 0xc0) | cur.suggestion;
    this.changed();
    toast(`Sprite memory set to ${hex(cur.suggestion, 2)} so all sprites are shown completely (Ctrl+Z undoes it).`);
    this.emit('level-header');
  }

  // sets the sprite memory value as an own undo step
  setSpriteMemory(m: number): void {
    this.editLevel(() => { this.level.spriteHeader = (this.level.spriteHeader & 0xc0) | (m & SPRITE_MEMORY); });
    this.emit('level-header');
    logMsg(`Sprite memory set to ${hex(m, 2)}`);
  }

  // CGRAM every 8 game frames of the level as it is now, emulated (count images, none when it fails)
  animationCgrams(count: number): Uint8Array[] {
    const r = this.emu.load(this.level.number, this.buildOverrides());
    return r.ok ? this.emu.animationFrames(count, 8).map((f) => f.cgram) : [];
  }

  // 8x8 tiles (layer 1 tile numbers) and colors the game keeps rewriting in this level (tile and
  // palette animation), found by emulating some frames in the background, kept in memory with the level as
  // edited as their input; null until known ('animated' when done), the level's previous ones meanwhile
  animated(): { tiles: Set<number>; colors: Set<number> } | null {
    const n = this.level.number, ov = this.buildOverrides();
    const res = this.learner.learn(`anim:${n}`, function* (emu) { return animatedIn(emu, n, ov); },
      { input: { level: this.levelInput(ov), masked: this.maskedHash() }, keep: 'memory', lane: 'animated', replace: true, done: this.animatedLearned });
    if (res) this.animatedShown = { level: n, res };
    return this.withOwnAnims(res ?? (this.animatedShown?.level === n ? this.animatedShown.res : null));
  }
  private animatedShown: { level: number; res: { tiles: Set<number>; colors: Set<number> } } | null = null;
  private animatedLearned = () => this.emit('animated');
  // plus the tiles and colors the ROM's own ExAnimation slots overwrite (their trigger may not fire in the
  // emulated frames, e.g. on/off or manual), read from the lists as they are now
  private ownAnim: { key: string; res: { tiles: Set<number>; colors: Set<number> } | null; out: { tiles: Set<number>; colors: Set<number> } | null } = { key: '', res: null, out: null };
  private withOwnAnims(res: { tiles: Set<number>; colors: Set<number> } | null): { tiles: Set<number>; colors: Set<number> } | null {
    if (!res) return null;
    const o = this.ownAnim, charWord = (this.render.ppuRegs[0x0b] & 0x0f) << 12;
    const key = `${this.rom.gen}:${this.level.number}:${charWord}`;
    if (o.key !== key || o.res !== res) {
      const tiles = exanimTiles(this.rom, this.level.number, charWord), colors = exanimColors(this.rom, this.level.number);
      o.key = key;
      o.res = res;
      o.out = tiles.size || colors.size ? { tiles: new Set([...res.tiles, ...tiles.keys()]), colors: new Set([...res.colors, ...colors.keys()]) } : res;
    }
    return o.out;
  }

  // ------------- queries -------------
  currentObjects(): LevelObject[] {
    if (this.mode === 'l2') return this.level.layer2Objects ?? [];
    return this.level.objects;
  }

  objectKey(layer2: boolean, idx: number): number {
    return layer2 ? 0x8000 | idx : idx;
  }

  // grab area = every tile the object wrote (same as its outline), topmost first
  objectAt(tx: number, ty: number, l2 = this.mode === 'l2'): LevelObject | null {
    const g = l2 ? this.images.geom2 : this.images.geom1;
    const objs = l2 ? this.level.layer2Objects : this.level.objects;
    if (!g || !objs) return null;
    const a = g.addr(tx, ty);
    if (a >= 0) {
      const off = a - MAP_BASE;
      const k = this.render.owner[off];
      if (k >= 0 && ((k & 0x8000) !== 0) === l2) {
        const o = objs[k & 0x7fff];
        if (o) return o;
      }
      // tiles later overwritten by another object still belong to this one
      for (let i = objs.length - 1; i >= 0; i--) if (this.render.touched.get(this.objectKey(l2, i))?.has(off)) return objs[i];
    }
    // fall back to object origins (objects that produce no visible tiles), a hidden conditional Direct Map16 object's tiles
    const at = (ty << 16) | tx;
    for (let i = objs.length - 1; i >= 0; i--) if ((objs[i].x === tx && objs[i].y === ty) || (isDm16(objs[i]) && objs[i].cond && dm16Tiles(objs[i]).includes(at))) return objs[i];
    return null;
  }

  // tiles covered by an object: array of packed (y<<16|x)
  objectTiles(o: LevelObject): number[] {
    const l2 = this.mode === 'l2';
    const objs = this.currentObjects();
    const idx = objs.indexOf(o);
    const set = this.render.touched.get(this.objectKey(l2, idx));
    const map = l2 ? this.offsetToTile2 : this.offsetToTile1;
    const out: number[] = [];
    if (set) for (const off of set) { const t = map[off]; if (t >= 0) out.push(t); }
    if (!out.length) out.push(...(isDm16(o) && o.cond ? dm16Tiles(o) : [(o.y << 16) | o.x]));
    return out;
  }

  // whether the object wrote a tile in the level's load
  objectDrawn(o: LevelObject): boolean {
    return !!this.render.touched.get(this.objectKey(this.mode === 'l2', this.currentObjects().indexOf(o)))?.size;
  }

  // Map16 tile numbers an object left in the level (tiles overwritten by later objects excluded)
  objectMap16(o: LevelObject): number[] {
    const l2 = this.mode === 'l2';
    const key = this.objectKey(l2, this.currentObjects().indexOf(o));
    const set = this.render.touched.get(key);
    const out = new Set<number>();
    if (set) for (const off of set) {
      if (this.render.owner[off] !== key) continue;
      const a = MAP_BASE + off;
      out.add(map16Tile(this.render.wram, a));
    }
    return [...out].sort((a, b) => a - b);
  }

  // finished probes only (nothing is queued)
  cachedBlock(tile: number): BlockProbe | undefined {
    return this.results.get(blockKey(this.level.header.tileset, tile));
  }

  // ------------- level scan (see levelscan.ts) -------------
  // slowdown and sprite problems found by playing the level through, in the background a while
  // after the last change; stored with a key of the level data it played
  levelScan: { key: string; level: number; result: ScanResult; uids: number[] } | null = null;
  private scanTimer = 0;
  private scanRun = 0;

  private scheduleScan(): void {
    clearTimeout(this.scanTimer);
    this.scanRun++;
    this.probes.cancelScan();
    this.scanTimer = window.setTimeout(() => this.cacheReady.then(() => this.runScan()), 1500);
  }

  private runScan(): void {
    if (this.holdRender) { this.scheduleScan(); return; }
    const lv = this.level, vertical = this.vertical, run = ++this.scanRun;
    const ov = this.buildOverrides();
    const key = scanKey(lv.number, ov);
    const uids = spriteLoadOrder(lv.sprites, vertical).map((q) => q.uid);
    const done = (result: ScanResult) => {
      if (run !== this.scanRun || this.level !== lv) return;
      this.levelScan = { key, level: lv.number, result, uids };
      this.emit('level-scan');
    };
    // (the scan of the level as it is: also the one shown while it holds for the ROM)
    const stored = this.results.get<ScanResult>(key);
    if (stored) { done(stored); return; }
    // played in the probe worker
    this.probes.requestScan(run, key, this.scanLevel(ov), (r) => { if (r) done(r); });
  }

  // the open level as edited (ov), to be played in the probe worker
  private scanLevel(ov: LevelOverride): ScanLevel {
    return { number: this.level.number, ov, vertical: this.vertical, width: this.images.width, height: this.images.height };
  }

  // What of the level the camera can show (camerareach.ts), from the level scan: undefined while the level has
  // none yet, null when it could not be found
  cameraReach(): CameraReach | null | undefined {
    return this.levelScan?.level === this.level.number ? this.levelScan.result.camera ?? null : undefined;
  }

  // The game view's scroll bands (camerabands.ts) under the open level's mode and vertical scroll setting:
  // undefined while emulating, null when they could not be found
  scrollBands(): CameraBands | null | undefined {
    const h = this.level.header;
    return this.probes.cameraBands(h.mode, h.verticalScroll);
  }

  // ------------- the game view frame placed by Mario (see camerareach.ts) -------------
  private cameraRun = 0;

  // Mario standing at level pixel (x, y): the frame shows the camera the game puts there
  placeGameViewByMario(x: number, y: number): void {
    this.gameViewMario = { x, y, key: null }; // (not asked for yet)
    this.updateGameViewCamera();
  }

  // the camera at Mario's place (kept inside the level) in the level as edited (ov), from the result cache or
  // played in the probe worker; asked again when the cache dropped it (the ROM bytes it read changed)
  updateGameViewCamera(ov?: LevelOverride): void {
    const m = this.gameViewMario, im = this.images;
    if (!m || !im || !this.show.gameView) return;
    m.x = Math.max(0, Math.min(im.width - MARIO_W, m.x)); m.y = Math.max(0, Math.min(im.height - MARIO_H, m.y));
    ov ??= this.buildOverrides();
    const key = cameraAtKey(this.level.number, ov, m.x, m.y);
    if (m.key === key && (m.camera === undefined || m.camera === null || this.results.get(key) !== undefined)) return;
    m.key = key;
    m.camera = this.results.get<CameraAt>(key);
    if (m.camera === undefined) this.probes.requestCamera(++this.cameraRun, key, this.scanLevel(ov), m.x, m.y, (r) => {
      if (this.gameViewMario !== m || m.key !== key) return;
      m.camera = r;
      this.emit('game-view');
    });
    this.emit('game-view');
  }

  // What the four layer 3 settings do in a tileset (see layer3.ts): the level as edited is loaded
  // with each of them on an own emulator; kept per tileset while the level as edited and the ROM it read
  // are unchanged
  layer3Kinds(tileset: number): Layer3Kind[] {
    const lv = this.level, ov = this.buildOverrides(), input = this.levelInput(ov);
    if (tileset !== lv.header.tileset) ov.layer1 = serializeLayer1(this.rom, { ...lv, header: { ...lv.header, tileset } });
    return this.learner.now(`l3k2:${tileset}`, (emu) => emu.tracked(() => layer3Kinds(emu, lv.number, ov)), { input });
  }

  // Water line of a layer 3 tide in level pixels: the surface where the level view draws layer 3
  // (as at the end of the level load), and for a tide that rises and falls its highest and lowest
  // line once the level scan has measured how far it moves (higher $24 - $1C: water higher up)
  tide(): { moving: boolean; surface: number; high: number; low: number } | null {
    const im = this.images, range = this.levelScan?.level === this.level.number ? this.levelScan.result.tide ?? null : null;
    if (this.tideCache?.images === im && this.tideCache.range === range) return this.tideCache.value;
    const kind = tideKind(this.render), surface = kind ? layer3Top(im.layer3, im.width) : -1;
    const value = surface < 0 ? null : {
      moving: kind === 'tide-moving', surface,
      high: range ? surface + range.load - range.max : surface, low: range ? surface + range.load - range.min : surface,
    };
    this.tideCache = { images: im, range, value };
    return value;
  }
  private tideCache: { images: LevelImages; range: unknown; value: ReturnType<App['tide']> } | null = null;

  // What every layer 2 scroll setting does (l2scroll.ts), measured with the level's code on an own
  // emulator a setting at a time; null while that runs, then `done` is called. Kept per level while
  // the level as edited and the ROM it read are unchanged.
  layer2Motions(done: () => void): Layer2Motions | null {
    const n = this.level.number, ov = this.buildOverrides();
    // (urgent: the header dialog shows them)
    return this.learner.learn(`l2m2:${n}`, function* (emu) { return (yield* layer2MotionsJob(emu, n, ov)).result; }, { input: this.levelInput(ov), lane: 'l2', replace: true, urgent: true, done }) ?? null;
  }

  // The Map16 tiles of every level (levelusage.ts), the open one as edited: those known now, the others are
  // learned in the background ('level-uses' as they come); pending: how many are still missing
  levelTiles(): { levels: LevelTiles[]; pending: number } {
    const idx = this.usesIndex ??= new LevelUses(this.rom, this.results);
    // the open level's (kept in memory with the level as edited as their input); a level with conditional
    // Direct Map16 objects in both of their states, whatever the view's flags
    const rom = this.rom, lv = this.level, ov = this.buildOverrides();
    const here = this.learner.now(`lt:${lv.number}`, (emu) => emu.tracked(() => levelTilesAll(rom, lv, (o) => emu.load(lv.number, o), ov)), { input: this.levelInput(ov), keep: 'memory' });
    const levels = [here];
    let pending = 0;
    for (const n of usedLevels(this.rom)) {
      if (n === this.level.number) continue;
      const t = idx.tiles(n);
      if (t) levels.push(t); else pending++;
    }
    if (pending) this.learnLevelTiles(idx);
    return { levels, pending };
  }
  // a level's BG tilemap from its load (the open one as shown), where it is the game's own (tilemove.ts)
  loadedBg(n: number): Uint16Array {
    return bgFromWram(n === this.level.number ? this.render.wram : this.learner.emu().load(n).wram);
  }
  // the tilesets in which FG Map16 tile t is the open level's tile (all for the standard tiles): the
  // pointers each tileset loads (tilesets.ts), learned once and kept in the result cache
  tilesetsOf(t: number): number[] {
    if (!isTilesetTile(t)) return Array.from({ length: TILESETS }, (_, i) => i);
    return sharingTilesets(this.tilesetPointerTable(), this.level.header.tileset, t);
  }
  // per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts), learned once and kept in the result cache
  tilesetPointerTable(): number[][] {
    return Array.from({ length: TILESETS }, (_, ts) => this.learner.now(`tsp1:${ts}`, (emu) => tilesetPointers(emu, ts)));
  }
  // the entrance actions that make a level slippery (slippery.ts), learned once and kept in the result cache
  slipperyActions(): number[] {
    return this.learner.now('slip1', slipperyActions);
  }
  // what Mario does on each overworld layer 1 tile 00–FF (owpaths.ts): learned in the background once and kept in
  // the result cache while the game's code is unchanged; null while that runs, then `done` is called
  pathKinds(done: () => void): PathKind[] | null {
    return this.learner.learn('owpk1', pathKindsJob, { label: 'Path tiles', done }) ?? null;
  }
  // the levels with sprite id (spriteId), the open level as edited
  spriteUsers(id: number): SpriteUser[] {
    const n = this.level.number;
    if (this.savedSprites?.level !== n) this.savedSprites = { level: n, uses: spriteUsage(this.rom, usedLevels(this.rom).filter((i) => i !== n)) };
    const here = spriteUsage(this.rom, [n], () => this.level).get(id) ?? [];
    return [...here, ...(this.savedSprites.uses.get(id) ?? [])].sort((a, b) => a.level - b.level);
  }
  private savedSprites: { level: number; uses: Map<number, SpriteUser[]> } | null = null;

  private usesIndex: LevelUses | null = null;

  // the other levels' tiles not known (each stored by LevelUses), 'level-uses' as they come
  private learnLevelTiles(idx: LevelUses): void {
    const missing = () => idx.missing(usedLevels(this.rom)).filter((n) => n !== this.level.number);
    this.learner.learn('uses', function* (emu) {
      for (let left = missing(); left.length; left = missing()) {
        while (left.length) { idx.scan(left.shift()!, emu); yield `Uses in levels (${left.length})`; }
      }
    }, { keep: false, label: 'Uses in levels', progress: this.usesLearned, done: this.usesLearned });
  }
  private usesLearned = () => this.emit('level-uses');

  // ------------- jump arcs (see jumparcs.ts) -------------
  // arcs from a tile of the level as edited: emulated in the background, the latest request only, kept in
  // memory with the level as edited as their input; 'arcs' when some are ready
  private arcs: JumpArcs | null = null;
  private arcsFor = ''; // the ROM and level state the arc emulator is prepared for
  private arcsLoad: RomReads | null = null; // what preparing it read
  private arcsWaiting = false; // for the run speeds probe

  jumpArcs(tx: number, ty: number): JumpArc[] | undefined {
    // Mario's run speeds in this tileset: probed first, the arcs are asked for again on 'probes'
    const runs = this.probes.runSpeeds();
    if (runs === null) { console.error('run speeds not found'); return []; }
    if (!runs) {
      if (!this.arcsWaiting) {
        this.arcsWaiting = true;
        this.setBusy('arcs-wait', 'Jump arcs');
        this.once('probes', () => { this.arcsWaiting = false; this.setBusy('arcs-wait', null); this.emit('arcs'); });
      }
      return undefined;
    }
    const lv = this.level, ov = this.buildOverrides(), height = this.images.height;
    const level = inputHash({ level: this.levelInput(ov), spriteHeader: lv.spriteHeader, height });
    // (asked for on every paint: joins the job while it is learned)
    return this.learner.learn(`arcs:${tx},${ty}`, (emu) => this.arcJob(emu, level, [lv.number, ov, lv.spriteHeader, height], tx, ty, runs),
      { input: { level, runs }, keep: 'memory', lane: 'arcs', replace: true, label: 'Jump arcs', done: this.arcsLearned });
  }
  private arcsLearned = () => this.emit('arcs');

  // (none when the level doesn't reach gameplay); levelHash: the hash of the level state prepared with
  private *arcJob(emu: LevelEmulator, levelHash: string, prepare: Parameters<JumpArcs['prepare']>, tx: number, ty: number, runs: RunStates): Generator<void, JumpArc[]> {
    if (this.arcs?.emu !== emu) { this.arcs = new JumpArcs(emu); this.arcsFor = ''; }
    const arcs = this.arcs, state = `${this.rom.gen}:${levelHash}`;
    if (this.arcsFor !== state) {
      const r = emu.tracked(() => arcs.prepare(...prepare));
      this.arcsFor = r.result ? state : '';
      this.arcsLoad = r.reads;
      if (!this.arcsFor) { console.error('jump arcs: the level did not reach gameplay'); return []; }
      yield;
    } else this.rom.reads?.add(this.arcsLoad!); // the arcs depend on the level's load they start from too

    const out: JumpArc[] = [];
    for (const sp of ARC_SPEEDS) for (const dir of [1, -1] as const) { out.push(arcs.arc(tx, ty, sp, dir, runs)); yield; }
    return out;
  }

  // The object palette's thumbnails of specs in the level as edited (thumbs.ts): undefined while they are
  // learned in the background ('thumbs' when done)
  objectThumbs(specs: ObjSpec[]): ObjThumb[] | undefined {
    const rom = this.rom, lv = this.level, keys = new Map(specs.map((s) => [s, objKey(s, this.objectKind(s.num))]));
    const keyOf = (s: ObjSpec) => keys.get(s)!, level = { ...lv, header: { ...lv.header } };
    return this.learner.learn(thumbsKey(lv, specs, keyOf), (emu) => objectThumbsJob(rom, emu, level, specs, keyOf),
      { input: thumbsInput(rom, lv), lane: 'thumbs', replace: true, label: 'Object thumbnails', done: this.thumbsLearned });
  }
  private thumbsLearned = () => this.emit('thumbs');

  // kind of a standard object in the current tileset; null while unknown (then treated as plain)
  objectKind(num: number): ObjKind | null {
    if (num === 0) return null;
    return this.tilesetKinds()?.kinds.get(num) ?? null;
  }

  // (empty while unknown or when they could not be found: objects are treated as plain then)
  tilesetKinds(ts = this.level.header.tileset): ObjKinds | null {
    const k = this.probes.kinds(ts);
    return k === undefined ? null : k ?? { kinds: new Map() };
  }

  objectBounds(o: LevelObject): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = o.x, y0 = o.y, x1 = o.x, y1 = o.y;
    for (const t of this.objectTiles(o)) {
      const x = t & 0xffff, y = t >> 16;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
  }

  // sprite pixel box: its 16x16 tile united with the bounds of its captured image
  spriteBox(s: LevelSprite): { x0: number; y0: number; x1: number; y1: number } {
    const x = s.x * 16, y = s.y * 16;
    const img = this.spriteImageOf(s);
    if (!img) return { x0: x, y0: y, x1: x + 16, y1: y + 16 };
    const ix = x + Number(img.dataset.ox), iy = y + Number(img.dataset.oy);
    return { x0: Math.min(x, ix), y0: Math.min(y, iy), x1: Math.max(x + 16, ix + img.width), y1: Math.max(y + 16, iy + img.height) };
  }

  spriteAt(px: number, py: number): LevelSprite | null {
    const sp = this.level.sprites;
    const tx = Math.floor(px / 16), ty = Math.floor(py / 16);
    for (let i = sp.length - 1; i >= 0; i--) if (sp[i].x === tx && sp[i].y === ty) return sp[i];
    for (let i = sp.length - 1; i >= 0; i--) {
      const b = this.spriteBox(sp[i]);
      if (px >= b.x0 && px < b.x1 && py >= b.y0 && py < b.y1) return sp[i];
    }
    return null;
  }

  // everything under a pixel across visible layers, top-down: sprites, L1, L2
  hitsAt(px: number, py: number): { mode: EditMode; item: LevelObject | LevelSprite }[] {
    const tx = Math.floor(px / 16), ty = Math.floor(py / 16);
    const out: { mode: EditMode; item: LevelObject | LevelSprite }[] = [];
    const s = this.show.sprites ? this.spriteAt(px, py) : null;
    if (s) out.push({ mode: 'spr', item: s });
    const o1 = this.show.layer1 ? this.objectAt(tx, ty, false) : null;
    if (o1) out.push({ mode: 'l1', item: o1 });
    const o2 = this.show.layer2 && this.level.layer2Objects ? this.objectAt(tx, ty, true) : null;
    if (o2) out.push({ mode: 'l2', item: o2 });
    return out;
  }

  selectedObjects(): LevelObject[] {
    return this.currentObjects().filter((o) => this.selection.has(o.uid));
  }
  selectedSprites(): LevelSprite[] {
    return this.level.sprites.filter((s) => this.selection.has(s.uid));
  }

  levelWidthTiles(): number {
    return this.images.geom1.width;
  }
  levelHeightTiles(): number {
    return this.images.geom1.height;
  }

  // ------------- edit plumbing -------------
  // An undoable level edit (see EditSession.beginLevelEdit). For edits spanning several events (dragging).
  beginLevelEdit(): LevelEdit {
    return this.edits.beginLevelEdit();
  }
  // A level edit at once: f changes the open level it is given (see EditSession.editLevel), returns false
  // when it changed nothing (cancelled); when it throws, the level is as before and the error passed on.
  editLevel(f: (lv: Level) => boolean | void, rerender = true): boolean {
    return this.edits.editLevel(f, rerender);
  }
  // A level edit putting lv in place of the open level (a level import, a package's sample level): one
  // undo step, the selection cleared
  replaceLevel(lv: Level): boolean {
    this.selection.clear();
    return this.edits.replaceLevel(lv);
  }
  // the level changed (outside a level edit too: as part of the latest step, or while dragging)
  changed(rerender = true): void {
    this.edits.changed(rerender);
  }
  private levelChanged(rerender: boolean): void {
    if (rerender) this.refresh();
    this.emit('change');
    this.scheduleSpriteMem();
    if (this.layerGone()) this.setMode('l1'); // (its header changed, an edit undone)
  }
  // the open level has no layer for the edit mode (layer 2 objects, BG tilemap)
  private layerGone(): boolean {
    return (this.mode === 'l2' && !this.level.layer2Objects) || (this.mode === 'bg' && !this.canEditBg());
  }
  // undoes the latest level or ROM edit
  undo(): void {
    const r = this.edits.undo();
    if (!r) toast('Nothing to undo');
    else this.stepDone(r, 'Undone');
  }
  redo(): void {
    const r = this.edits.redo();
    if (r) this.stepDone(r, 'Redone');
  }
  private stepDone(r: StepResult, what: string): void {
    if (r.kind === 'rom') toast(`${what}: ${r.edit.label}`);
    else if (r.kind === 'failed') toast(String(r.error instanceof Error ? r.error.message : r.error), 'error');
  }

  setMode(m: EditMode, selection: Iterable<number> = []): void {
    if (m === 'l2' && !this.level.layer2Objects) {
      toast('This level has no layer 2 objects (layer 2 is background, mode BG).');
      return;
    }
    if (m === 'bg' && !this.canEditBg()) {
      toast('This level has layer 2 objects instead of a BG tilemap.');
      return;
    }
    // editing layer 3 shows it
    const ghosts = this.level.layer2Objects || isBrushMode(m) || isBrushMode(this.mode);
    const recompose = m !== this.mode && ((ghosts && this.show.ghost) || (m === 'l3' && !this.show.layer3));
    if (m === 'l3') this.show.layer3 = true;
    this.editMode = m;
    this.selection = new Set(selection);
    if (recompose) this.recomposite();
    this.emit('mode');
    this.emit('change');
  }

  // ------------- BG tilemap -------------
  canEditBg(): boolean {
    return !this.level.layer2Objects && hasObjects(this.level.header.mode);
  }
  bgAt(tx: number, ty: number): number {
    const o = bgIndex(tx, ty);
    return this.level.bg ? this.level.bg[o] : bgTile(this.render.wram, o);
  }
  // sets one BG tile (the map repeats, so all copies change); caller handles the level edit and refresh
  paintBg(tx: number, ty: number, tile: number): boolean {
    if (this.bgAt(tx, ty) === tile) return false;
    this.level.bg ??= bgFromWram(this.render.wram);
    this.level.bg[bgIndex(tx, ty)] = tile;
    return true;
  }
  // stamps the brush with its top-left tile at (tx, ty)
  paintBrush(tx: number, ty: number): boolean {
    const b = this.bgBrush;
    let changed = false;
    for (let i = 0; i < b.tiles.length; i++) if (this.paintBg(tx + (i % b.w), ty + Math.floor(i / b.w), b.tiles[i])) changed = true;
    return changed;
  }
  // the level's BG tiles in a rectangle become the brush
  pickBg(x0: number, y0: number, x1: number, y1: number): void {
    const w = Math.min(Math.abs(x1 - x0) + 1, 32), h = Math.min(Math.abs(y1 - y0) + 1, 27);
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    this.bgBrush = { w, h, tiles: Array.from({ length: w * h }, (_, i) => this.bgAt(x + (i % w), y + Math.floor(i / w))) };
    this.emit('bgtile');
  }

  // ------------- layer 3 tilemap (layer3map.ts) -------------
  // cells (cx, cy) as layer 3 is drawn over the level
  l3Grid(): Layer3Geometry {
    return layer3Geometry(this.render);
  }
  // the tilemap word of a cell, -1: no entry there (the status bar's rows)
  l3At(cx: number, cy: number): number {
    const i = layer3Index(this.l3Grid(), cx, cy);
    if (i < 0) return -1;
    return this.level.layer3 ? this.level.layer3[i] : layer3Word(this.render.vram, i);
  }
  // a cell can be edited: its entry is in the part of the tilemap the level's LT3 file (or a new one) holds
  l3Editable(cx: number, cy: number): boolean {
    const i = layer3Index(this.l3Grid(), cx, cy);
    return i >= 0 && lt3Covers(lt3Target(this.rom, this.level.number).place, i);
  }
  // a layer 3 edit begins: the tilemap is held in the level first, so the undo step has it as it was (a level
  // without one reads it from the ROM, which after a save already holds the edit); cancelled, it lets go again
  beginLayer3Edit(): LevelEdit {
    const held = !!this.level.layer3;
    this.level.layer3 ??= layer3Map(this.render.vram);
    const e = this.beginLevelEdit();
    return { commit: e.commit, cancel: (restore) => { e.cancel(restore); if (!held) this.level.layer3 = null; } };
  }
  // stamps the brush with its top-left tile at cell (cx, cy); caller handles the level edit and refresh
  paintL3Brush(cx: number, cy: number): boolean {
    const b = this.l3Brush, g = this.l3Grid(), place = lt3Target(this.rom, this.level.number).place;
    let changed = false;
    for (let k = 0; k < b.tiles.length; k++) {
      const i = layer3Index(g, cx + (k % b.w), cy + Math.floor(k / b.w));
      if (i < 0 || !lt3Covers(place, i)) continue;
      const map = this.level.layer3 ??= layer3Map(this.render.vram);
      if (map[i] === b.tiles[k]) continue;
      map[i] = b.tiles[k];
      changed = true;
    }
    return changed;
  }
  // the level's layer 3 tiles in a rectangle of cells become the brush (blank where there is no entry)
  pickL3(x0: number, y0: number, x1: number, y1: number): void {
    const w = Math.min(Math.abs(x1 - x0) + 1, 32), h = Math.min(Math.abs(y1 - y0) + 1, 32);
    const x = Math.min(x0, x1), y = Math.min(y0, y1), blank = blankLayer3Tile(this.render);
    this.l3Brush = { w, h, tiles: Array.from({ length: w * h }, (_, i) => { const t = this.l3At(x + (i % w), y + Math.floor(i / w)); return t < 0 ? blank : t; }) };
    this.emit('bgtile');
  }

  clampObject(o: { x: number; y: number }): void {
    const w = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.width : this.levelWidthTiles();
    const hgt = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.height : this.levelHeightTiles();
    o.x = Math.max(0, Math.min(w - 1, o.x));
    o.y = Math.max(0, Math.min((this.vertical ? Math.min(hgt, 0x1ff) : hgt) - 1, o.y));
  }

  insertAt(tx: number, ty: number, p: PaletteItem | null = this.paletteItem): void {
    if (!p) { toast('Choose an object/sprite in the palette first.'); return; }
    this.editLevel(() => this.insert(tx, ty, p));
  }
  private insert(tx: number, ty: number, p: PaletteItem): boolean {
    if (p.kind === 'obj' && (this.mode === 'l1' || this.mode === 'l2')) {
      const cells = p.block ? Array.from({ length: p.block.w * p.block.h }, (_, i) => ({ dx: i % p.block!.w, dy: Math.floor(i / p.block!.w) })) : [{ dx: 0, dy: 0 }];
      this.selection = new Set();
      for (const { dx, dy } of cells) {
        const o: LevelObject = { uid: newUid(), num: p.num, ext: p.ext, x: tx + dx, y: ty + dy, size: p.size };
        if (p.tile !== undefined) o.tile = p.tile + dy * 16 + dx;
        if (p.prefab !== undefined) o.prefab = p.prefab;
        this.clampObject(o);
        this.currentObjects().push(o);
        this.selection.add(o.uid);
      }
    } else if (p.kind === 'spr') {
      if (this.mode !== 'spr') this.setMode('spr');
      const s: LevelSprite = { uid: newUid(), num: p.num, x: tx, y: ty, extra: p.extra };
      if (s.extra >= 2) { const b = spriteBytes(spriteSizes(this.rom), s); if (b.length) s.bytes = b; }
      this.level.sprites.push(s);
      this.selection = new Set([s.uid]);
    } else return false;
    return true;
  }

  // ------------- conditional Direct Map16 (cdm16.ts) -------------
  // the flags the level's objects use, with the number of objects each
  levelFlags(): Map<number, number> {
    return this.level ? usedFlags(this.rom, this.level) : new Map();
  }
  // the view's flags (and test play's): `flags` on or off, then the level loads anew with them
  setFlags(flags: Iterable<number>, on: boolean): void {
    for (const f of flags) if (on) this.cdm16.add(f); else this.cdm16.delete(f);
    this.refresh();
  }

  // ------------- ExAnimation triggers (extrigger.ts) -------------
  // the triggers the level's slots and the global ones use (and their Trigger Inits), with their slots
  levelTriggers(): Map<number, SlotRef[]> {
    return this.level ? usedTriggers(readLevelList(this.rom, this.level.number), readGlobalList(this.rom)) : new Map();
  }
  // the custom triggers and manual frames once the level has loaded (the global list's init, then the level's)
  triggerInit(): { custom: number; manual: Map<number, number> } {
    return initTriggers(readGlobalList(this.rom), this.level ? readLevelList(this.rom, this.level.number) : null);
  }
  // changes the view's triggers (and test play's); the level loads anew with them, its animation shown
  setTriggers(fn: (v: TriggerView) => void): void {
    fn(this.exTriggers);
    this.show.anim = true;
    this.refresh();
  }

  // ------------- prefabs (prefabs.ts) -------------
  prefabs(): Map<number, Prefab> {
    return listPrefabs(this.rom);
  }

  // what the selected objects left in the level as a block of tiles; cells of other objects are
  // transparent, empty rows and columns at the border are cut off. A conditional Direct Map16 object gives its
  // tiles with its condition whatever the view's flags (cdm16.ts); a cell holds one tile, the topmost
  prefabFromSelection(): { x: number; y: number; w: number; h: number; tiles: number[]; conds?: (Dm16Cond | null)[] } | string {
    const objs = this.selectedObjects();
    if (!objs.length || (this.mode !== 'l1' && this.mode !== 'l2')) return 'Select objects in the level first (layer 1 or 2).';
    const l2 = this.mode === 'l2';
    const g = l2 ? this.images.geom2 : this.images.geom1;
    if (!g) return 'Layer without objects';
    const all = this.currentObjects();
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const cells = new Map<number, { tile: number; cond?: Dm16Cond }>();
    // in drawing order: each object's cells over those of the objects before it
    for (const o of all) {
      if (!this.selection.has(o.uid)) continue;
      const cond = isDm16(o) ? o.cond : undefined, key = this.objectKey(l2, all.indexOf(o));
      for (const t of cond ? dm16Tiles(o) : this.objectTiles(o)) {
        const x = t & 0xffff, y = t >> 16;
        const a = g.addr(x, y);
        if (a < 0 || (!cond && this.render.owner[a - MAP_BASE] !== key)) continue;
        cells.set(t, cond ? { tile: o.tile ?? 0, cond: { ...cond } } : { tile: map16Tile(this.render.wram, a) });
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return 'The selected objects have no visible tiles.';
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w > PREFAB_MAX || h > PREFAB_MAX) return `Selection is ${w}×${h} tiles, a prefab can be at most ${PREFAB_MAX}×${PREFAB_MAX}.`;
    const cell = (i: number) => cells.get(((y0 + Math.floor(i / w)) << 16) | (x0 + (i % w)));
    const tiles = Array.from({ length: w * h }, (_, i) => cell(i)?.tile ?? TRANSPARENT);
    const conds = Array.from({ length: w * h }, (_, i) => cell(i)?.cond ?? null);
    return { x: x0, y: y0, w, h, tiles, ...(conds.some((c) => c) ? { conds } : {}) };
  }

  // stores the selection as prefab n; replace: the selected objects become one prefab object
  // (at the place of the last of them in the object list, so objects in between still cover it)
  saveSelectionAsPrefab(n: number, name: string, replace: boolean): boolean {
    const r = this.prefabFromSelection();
    if (typeof r === 'string') { toast(r, 'error'); return false; }
    try {
      this.romEdit(`Prefab ${hex(n, 2)} saved`, () => writePrefab(this.rom, n, { w: r.w, h: r.h, tiles: r.tiles, ...(r.conds ? { conds: r.conds } : {}), name }));
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    if (replace) {
      this.editLevel(() => {
        const all = this.currentObjects();
        const at = Math.max(...this.selectedObjects().map((o) => all.indexOf(o)));
        const o: LevelObject = { uid: newUid(), num: 0, ext: PREFAB_EXT, x: r.x, y: r.y, size: 0, prefab: n };
        const res = [...all.slice(0, at + 1).filter((x) => !this.selection.has(x.uid)), o, ...all.slice(at + 1)];
        if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
        this.selection = new Set([o.uid]);
      });
    }
    this.paletteItem = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n };
    return true;
  }

  // levels whose saved data uses prefab n (plus the open level with its unsaved changes)
  prefabUsers(n: number): number[] {
    const out: number[] = [];
    const uses = (lv: { objects: LevelObject[]; layer2Objects: LevelObject[] | null }) =>
      [...lv.objects, ...(lv.layer2Objects ?? [])].some((o) => o.num === 0 && o.ext === PREFAB_EXT && o.prefab === n);
    for (const i of this.usedLevels()) {
      try { if (uses(i === this.level.number ? this.level : loadLevel(this.rom, i))) out.push(i); } catch { /* unreadable level */ }
    }
    return out;
  }

  // a prefab object becomes one Direct-Map16 object per tile, at its place in the object list
  explodePrefab(o: LevelObject): void {
    const s = o.prefab !== undefined ? readPrefab(this.rom, o.prefab) : null;
    if (!s) { toast('The prefab does not exist (anymore).', 'error'); return; }
    this.editLevel(() => {
      const parts: LevelObject[] = [];
      s.tiles.forEach((t, i) => {
        const cond = s.conds?.[i];
        if (t !== TRANSPARENT) parts.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: o.x + (i % s.w), y: o.y + Math.floor(i / s.w), size: 0, tile: t, ...(cond ? { cond: { ...cond } } : {}) });
      });
      const all = this.currentObjects();
      const at = all.indexOf(o);
      const res = [...all.slice(0, at), ...parts, ...all.slice(at + 1)];
      if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
      this.selection = new Set(parts.map((p) => p.uid));
    });
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    this.editLevel(() => {
      if (this.mode === 'spr') this.level.sprites = this.level.sprites.filter((s) => !this.selection.has(s.uid));
      else if (this.mode === 'l2' && this.level.layer2Objects) this.level.layer2Objects = this.level.layer2Objects.filter((o) => !this.selection.has(o.uid));
      else if (this.mode === 'l1') this.level.objects = this.level.objects.filter((o) => !this.selection.has(o.uid));
      this.selection.clear();
    });
  }

  moveSelection(dx: number, dy: number): void {
    if (!this.selection.size) return;
    this.editLevel(() => {
      const items = this.mode === 'spr' ? this.selectedSprites() : this.selectedObjects();
      for (const o of items) { o.x += dx; o.y += dy; this.clampObject(o); }
    });
  }

  // resize: width/height nibbles of settings byte
  resizeSelection(dw: number, dh: number): void {
    const objs = this.selectedObjects().filter((o) => o.num !== 0 || o.ext === DM16_EXT);
    if (!objs.length) return;
    this.editLevel(() => { for (const o of objs) o.size = resizeObjectSize(this.objectKind(o.num), o.size, dw, dh); });
  }

  // copies the selection and pastes it one tile down-right (Ctrl+D)
  duplicateSelection(): void {
    this.copy();
    const s = this.mode === 'spr' ? this.selectedSprites() : this.selectedObjects();
    if (s[0]) this.paste(s[0].x + 1, s[0].y + 1);
  }

  reorderSelection(dir: 'front' | 'back'): void {
    if (this.mode === 'spr' || !this.selection.size) return;
    this.editLevel(() => {
      const objs = this.currentObjects();
      const sel = objs.filter((o) => this.selection.has(o.uid));
      const rest = objs.filter((o) => !this.selection.has(o.uid));
      const res = dir === 'front' ? [...rest, ...sel] : [...sel, ...rest];
      if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
    });
  }

  copy(): void {
    if (this.mode === 'spr') this.clipboard = { sprites: structuredClone(this.selectedSprites()) };
    else this.clipboard = { objects: structuredClone(this.selectedObjects()) };
  }
  paste(tx: number, ty: number): void {
    const items = this.mode === 'spr' ? this.clipboard.sprites : this.clipboard.objects;
    if (!items?.length) return;
    this.editLevel(() => {
      const minX = Math.min(...items.map((o) => o.x)), minY = Math.min(...items.map((o) => o.y));
      const sel = new Set<number>();
      for (const it of items) {
        const c = { ...structuredClone(it), uid: newUid(), x: it.x - minX + tx, y: it.y - minY + ty };
        this.clampObject(c);
        sel.add(c.uid);
        if (this.mode === 'spr') this.level.sprites.push(c as LevelSprite);
        else this.currentObjects().push(c as LevelObject);
      }
      this.selection = sel;
    });
  }

  // ------------- saving -------------
  saveLevel(silent = false): void {
    this.edits.save(silent);
  }
  // the level was saved and loaded again
  private levelSaved(log: string[], silent: boolean): void {
    const n = this.level.number;
    this.romWritten();
    if (!silent) toast(`Level ${hex(n, 3)} saved. ${log.join(' · ')}`);
    else logMsg(`Level ${hex(n, 3)} saved automatically. ${log.join(' · ')}`);
    this.refresh();
    this.emit('change');
  }

  // ------------- ROM edits -------------
  // One undoable ROM edit (see romedit.ts): a dirty level is saved before it; when fn throws or returns
  // { ok: false } nothing changes and nothing is recorded; views, the level and the render follow by
  // themselves. Edits with the same key in quick succession merge.
  romEdit<T>(label: string, fn: () => T, opt: EditOptions = {}): T {
    return this.edits.romEdit(label, fn, opt);
  }

  // romEdit for a change that awaits (AddmusicK inserting songs): one undo step for all of it
  romEditAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.edits.romEditAsync(label, fn);
  }

  // the level was saved (outside the ROM history): editors show it ('rom-change'), the copy in the
  // browser is stored at once
  private romWritten(): void {
    this.romNotice();
    clearTimeout(this.persistTimer);
    this.persistTimer = 0;
    this.persist();
  }
  // a ROM edit or undo/redo: editors show it at once, the level render and storing follow debounced
  // (edits come in quick succession, e.g. graphics strokes)
  private romChanged(): void {
    this.romNotice();
    clearTimeout(this.romTimer);
    const run = () => {
      const wait = this.holdRender ? 150 : this.quietUntil - performance.now();
      if (wait > 0) { this.romTimer = window.setTimeout(run, wait); return; }
      this.romTimer = 0;
      this.refresh();
    };
    this.romTimer = window.setTimeout(run, 150);
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => { this.persistTimer = 0; this.persist(); }, 1000);
  }
  private romNotice(): void {
    this.savedSprites = null;
    this.emit('rom-change');
  }

  // the open level again from the ROM, after a ROM edit changed its stored data (unsaved changes are
  // gone: an edit saves them first, an undo may take back what they were saved over)
  private reloadLevel(): void {
    clearTimeout(this.romTimer); // (openLevel draws it)
    this.romTimer = 0;
    this.openLevel(this.level.number, true);
  }

  // a stroke ended: the re-emulation waits for a pause in drawing
  renderPause(ms = 600): void {
    this.quietUntil = performance.now() + ms;
  }

  // re-emulates now if a ROM change is still pending (before reading the render)
  flushRomChange(): void {
    if (!this.romTimer) return;
    clearTimeout(this.romTimer);
    this.romTimer = 0;
    this.refresh();
  }

  // the graphics workspace on a GFX/ExGFX file
  showGfxFile(num: number): void {
    this.wsGfx = num;
    this.emit('open-gfx');
  }

  editMap16(tile: number, bg = false): void {
    this.wsTile = tile;
    this.wsTileBg = bg;
    this.emit('open-map16');
  }

  // stops all writes to the browser storage (before it is cleared)
  close(): void {
    this.closed = true;
    clearTimeout(this.cacheTimer);
    this.cacheTimer = 0;
  }

  persist(): void {
    if (this.closed) return;
    saveRom(this.romName, this.rom).catch(() => {});
  }

  // vanilla levels plus anything relocated into expanded ROM space
  usedLevels(): Set<number> {
    return new Set(usedLevels(this.rom));
  }
}

export { hasLayer2Objects, SEC_HDR };

// what the follow-ups of a ROM edit compare (see the edit session in the constructor)
const noUids = (k: string, v: unknown) => (k === 'uid' ? undefined : v);
function levelSignature(rom: Rom, n: number): string {
  try { return JSON.stringify(loadLevel(rom, n), noUids); } catch (e) { return String(e); }
}
function headerSignature(rom: Rom, n: number): string {
  return JSON.stringify([levelGfx(rom, n), levelExtGfx(rom, n), customPalette(rom, n), levelMusic(rom, n)]);
}
function prefabsSignature(rom: Rom): string {
  try { return JSON.stringify([...listPrefabs(rom)]); } catch (e) { return String(e); }
}

function spriteCanvas(img: SpriteImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.w; c.height = img.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(img.w, img.h);
  new Uint32Array(id.data.buffer).set(img.rgba);
  ctx.putImageData(id, 0, 0);
  c.dataset.ox = String(img.ox);
  c.dataset.oy = String(img.oy);
  return c;
}
