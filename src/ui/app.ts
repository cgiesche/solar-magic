// Application state and editing actions.

import { makeProjectId } from '../core/projectid.ts';
import { Rom } from '../core/rom.ts';
import { LevelEmulator, type LevelRender, type LevelOverride, type Animated, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, type ScreenExit, loadLevel, spriteLoadOrder, serializeLayer1, serializeSprites, serializeLevelSprites, spriteSizes, spriteId, spriteBytes,
  isL1Vertical, newUid, hasLayer2Objects, hasObjects, SEC_HDR,
  entrancePos, nearestEntrance, encodeSecondaryHeader, mainSpot, sameSpot, placeMain, midwaySpot, nearestMidway, placeMidway, exitLandsAtMidway, isSized, SPRITE_MEMORY, levelRows, TIME_TABLE,
} from '../core/level.ts';
import { levelBgPointer } from '../core/levelheader.ts';
import { hex, hex2, spriteName } from '../core/names.ts';
import { objectTable, objectName, objectNameKey, setObjectName, namedPerTable, numberName } from '../core/objectnames.ts';
import { boxedObjects, boxAt } from '../core/objboxes.ts';
import { objectUserNames } from '../core/usernames.ts';
import { loadPixiProject, customSpriteList, type CustomSprite } from '../core/pixi.ts';
import { renderLevel, type LevelImages, composite, animatedPixels, TileAnimation, type AnimStep } from '../core/render.ts';
import type { SpriteImage, SpriteLevel } from '../core/spritegfx.ts';
import { usedSpriteMemory, type SpriteMemLevel, type SpriteMemResult } from '../core/spritemem.ts';
import { DM16_EXT, levelGfx, levelExtGfx, customPalette, levelMusic, defaultGfx } from '../core/patches.ts';
import { objectLength2D, fitExtension } from '../core/obj2d.ts';
import { gfxSkipMask, gfxFilesHash } from '../core/gfxpages.ts';
import { flagBytes, usedFlags, isDm16, dm16Tiles, type Dm16Cond } from '../core/cdm16.ts';
import { PREFAB_EXT, PREFAB_MAX, TRANSPARENT, listPrefabs, writePrefab, type Prefab } from '../core/prefabs.ts';
import { breakUpPrefab, replaced, setPrefabSources } from '../core/prefabsources.ts';
import { PasteCounter, findPasted, arrangementKey, type PasteHint } from '../core/pastehint.ts';
import { KeptSuggestions, type PrefabSuggestion, type SuggestLevels, type SuggestRun } from '../core/prefabsuggest.ts';
import { planPrefabPlaces, applyPrefabPlaces, deletePrefab, prefabObjectCount, replaceWithPrefab, type LevelPlaces, type LevelGroups, type PrefabGroup } from '../core/prefabplaces.ts';
import type { Package } from '../core/pkgreg.ts';
import { kvEntries, kvKeys, kvWrite, saveRom } from './storage.ts';
import { ResultCache, RomFingerprint, oldStoreKeys, type CacheEntry } from '../core/romdeps.ts';
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
import { resizeObjectSize, type ObjKind, type ObjKinds, type KindLevel } from '../core/objkinds.ts';
import { sizeKey, sizeParts, partSizes, drivers, namedDrivers, keepEdges, type Box, type Drivers, type SizeSpec } from '../core/objresize.ts';
import { type JumpArc } from '../core/jumparcs.ts';
import { scanKey, type ScanLevel, type ScanResult } from '../core/levelscan.ts';
import { cameraAtKey, type CameraReach, type CameraAt } from '../core/camerareach.ts';
import { MARIO_W, MARIO_H, type CameraBands } from '../core/camerabands.ts';
import { tideKind, layer3Top, type Layer3Kind } from '../core/layer3.ts';
import { type Layer2Motions } from '../core/l2scroll.ts';
import { variantOf, blockKey, collisionKey, type BlockProbe, type CollisionProbe, type RunStates, type SwitchState, SWITCH_STATES, SWITCH_TRIGGER } from '../core/blockprobe.ts';
import type { ProbeReply, LearnJob } from '../core/probeprotocol.ts';
import { ProbeClient } from '../core/probeclient.ts';
import { ResultLearner } from '../core/learner.ts';
import type { RomReads } from '../core/romdeps.ts';
import { thumbCanvas } from './thumbs.ts';
import { thumbsKey, thumbsInput, previewInput, objKey, type ObjSpec, type ObjThumb, type PlacementPreview } from '../core/objthumbs.ts';
import { levelInput, inputHash } from '../core/inputs.ts';
import { map16Tile, bgTile } from '../core/ram.ts';
import { exanimTiles, exanimColors, exanimPeriod, readLevelList, readGlobalList } from '../core/exanim.ts';
import { emptyTriggerView, usedTriggers, initTriggers, type TriggerView, type SlotRef } from '../core/extrigger.ts';
import { LevelUses, levelOverride, usedLevels, spriteUsage, isTilesetTile, type LevelTiles, type SpriteUser } from '../core/levelusage.ts';
import { TILESETS, sharingTilesets } from '../core/tilesets.ts';
import { slipperyActions } from '../core/slippery.ts';
import { type PathKind } from '../core/owpaths.ts';
import type { OwRender } from '../core/overworld.ts';
import type { Rect } from '../core/owevents.ts';
import type { OwSpriteView } from '../core/owsprites.ts';
import type { ProgressSave } from '../core/owprogress.ts';
import type { Map16Target } from './gfx/map16tab.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg' | 'l3';
// the modes painted with a brush of tiles picked from the level or the picker: BG tiles, layer 3's 8x8 tiles
export const isBrushMode = (m: EditMode) => m === 'bg' || m === 'l3';
export interface Brush { w: number; h: number; tiles: number[] }
export type PickedItem =
  // block: a rectangle of Map16 tiles from the picker sheet (tile + row * 16 + col), one Direct-Map16 object each
  // prefab: prefab number (extended object $04, see prefabs.ts)
  // extension: object 2D's bytes after its 3 when the ROM reads them (obj2d.ts)
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number; block?: { w: number; h: number }; prefab?: number; extension?: number[] }
  | { kind: 'spr'; num: number; extra: number };
// what a right click in the level adds (App.placement)
export interface Placement { objects: LevelObject[]; sprites: LevelSprite[] }
// a part of the placement preview (which is a picture, CONTEXT.md) in level pixels; img null: a sprite without an image (drawn as its tile)
export interface PreviewPart { x: number; y: number; img: HTMLCanvasElement | null }

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
  | 'picked-item' // a picked item was chosen in the picker, or the picked item cleared
  | 'placement-preview' // the placement preview asked for is known
  | 'properties' // the properties panel is wanted (the context menu)
  | 'arcs' // jump arcs asked for are known
  | 'sizes' // the sizes of objects asked for (resizing, objresize.ts) are known
  | 'sprites' // sprite images were captured
  | 'thumbs' // object thumbnails asked for are known
  | 'sprite-mem' // the sprite memory check of the level is known
  | 'animated' // which tiles and colors of the level animate is known
  | 'anim-frame' // the next frame of the level animation is shown, or the level as rendered again when it stops
  | 'prefabs' // the prefab table changed
  | 'object-names' // the user's object names changed (a rename, its undo or redo)
  | 'paste-hint' // App.pasteHint changed
  | 'prefab-suggestions' // App.prefabSuggestions changed
  | 'bgtile' // the BG or layer 3 brush changed (picked from the level)
  | 'reveal' // the level view scrolls to App.reveal
  | 'zoom' // the level view's zoom changed
  | 'busy' // background work (setBusy), a modal or the music player changed
  | 'open-gfx' // the graphics workspace opens on App.wsGfx
  | 'open-map16' // the graphics workspace opens on the Map16 tab
  | 'import-gfx' // the graphics workspace imports App.gfxImport
  | 'messages'; // the message panel opens on App.messages (null: it closes)

// the hint to save a paste as prefab (pastehint.ts): the paste's objects as placed in level, layer
export type PasteHintAt = PasteHint & { level: number; layer: 'l1' | 'l2'; objects: LevelObject[] };

// IndexedDB keys of the result cache: its name and version (bump when result formats change or old results may be
// wrong: 4 keeps several inputs per key)
const CACHE_NAME = 'rc', CACHE_VERSION = 4, CACHE_PREFIX = `${CACHE_NAME}${CACHE_VERSION}:`;
const SWEEP_SLICE = 64; // stored results checked against the ROM per background slice (ResultCache.sweep)

// a learn job for sprite images (App.spriteJobs)
export interface SpriteJob { key: string; job: LearnJob; input: unknown }

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
  // what a right click in the level places: the picked item, or – picked in the level after it – a copy of the selection
  private picked: PickedItem | null = null;
  get pickedItem(): PickedItem | null { return this.picked; }
  set pickedItem(p: PickedItem | null) { this.picked = p; this.stampSelection = false; }
  stampSelection = false;
  // BG mode brush: a w×h block of BG Map16 tiles (row-major), picked from the picker sheet or the level
  bgBrush: Brush = { w: 1, h: 1, tiles: [0] };
  l3Brush: Brush = { w: 1, h: 1, tiles: [0] }; // layer 3 tilemap words
  zoom = 2;
  show = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: true, items: true, invisible: true, deaths: true, collision: false, preview: false, arcs: false, gameView: false, scrollBands: false };
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
  wsTarget: Map16Target = 'fg'; // what wsTile is a tile of
  wsOw: { map: number; progress: number } | undefined = undefined; // for an overworld tile: the map and event progress to draw it as on
  gfxImport: { file: File; into: Package | null } | null = null; // for 'import-gfx'
  wsGfx: number | null = null; // GFX file for 'open-gfx'
  private romTimer = 0;
  holdRender = false; // while drawing: the debounced re-emulation waits (it would stall the stroke)
  private quietUntil = 0; // and after a stroke until then (the next one often follows quickly)
  private persistTimer = 0;
  clipboard: { objects?: LevelObject[]; sprites?: LevelSprite[] } = {};
  // the arrangements of Direct Map16 objects pasted in the session (pastehint.ts); the hint to save the last
  // paste (its objects as placed in level/layer) as prefab, until it is dismissed or another level is opened
  private pastes = new PasteCounter();
  pasteHint: PasteHintAt | null = null;
  // repeated arrangements of Direct Map16 objects across the levels (prefabsuggest.ts), found in the background
  // a while after the last change; null while not known yet
  prefabSuggestions: PrefabSuggestion[] | null = null;
  suggestionsCurrent = false; // they are of the levels and the ROM as they are now (their places can be taken)
  private keptSuggestions: KeptSuggestions; // the levels' arrangements and places of earlier runs (only changed levels are taken apart again)
  private suggestTimer = 0;
  private suggestRun = 0;
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
  // the emulated results needed at once, on the main thread (learner.ts now: the slippery entrance actions, the
  // object tables, the tilesets' pointers; its emulator for loads at once). The others are learned in the probe worker
  // (probeclient.ts), without one by its host on the main thread.
  private learner: ResultLearner;
  private cacheTimer = 0;
  private closed = false; // project closed: nothing is written to the browser any more
  reveal = { x: 0, y: 0 }; // pixel the level view scrolls to on 'reveal'
  // tile/palette animation: frames stored as pixel diffs against the static composite
  // snaps: the images emulated so far, of count; next emulates the next one (null when there are no more)
  anim = { gen: 0, snaps: [] as { vram: Uint8Array; cgram: Uint8Array }[], count: 0, next: null as (() => { vram: Uint8Array; cgram: Uint8Array } | null) | null, base: null as Uint32Array | null,
    frames: [] as { idx: Uint32Array; val: Uint32Array }[], phase: -1, timer: 0 };

  constructor(rom: Rom, name: string) {
    this.rom = rom;
    this.romName = name;
    // made now, outside any ROM edit (undo never takes it away), and stored with the ROM soon
    if (makeProjectId(rom)) this.persistTimer = window.setTimeout(() => { this.persistTimer = 0; this.persist(); }, 1000);
    this.emu = new LevelEmulator(rom);
    this.emu.skipMask = () => this.gfxSkipMask();
    this.emu.boot();
    onModalsChange(() => { this.resumeBackground(); this.emit('busy'); });
    // sprite images: learned again when what they depend on changed (the learner decides)
    this.on('render', () => this.ensureSpriteImages());
    this.on('rom-change', () => this.ensureSpriteImages());
    this.on('rom-change', () => this.scheduleSuggestions());
    this.on('level', () => (this.objectNamesSeen = JSON.stringify(objectUserNames(this.rom)))); // (another ROM, too)
    this.on('rom-change', () => {
      const names = JSON.stringify(objectUserNames(this.rom));
      if (names !== this.objectNamesSeen) { this.objectNamesSeen = names; this.emit('object-names'); }
    });
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
    this.cacheReady = kvEntries<CacheEntry | string[]>(CACHE_PREFIX)
      .then((e) => this.results.load(e.map(([k, v]) => [k.slice(CACHE_PREFIX.length), v])))
      .catch((e) => console.error(e));
    // the rows of earlier versions of the result cache go; the loaded results are checked in the background
    kvKeys(CACHE_NAME).then((k) => kvWrite([], oldStoreKeys(k, CACHE_NAME, CACHE_VERSION))).catch((e) => console.error(e));
    void this.cacheReady.then(() => this.sweepResults());
    this.learner = new ResultLearner({
      rom, results: this.results, cacheReady: this.cacheReady, main: this.emu,
      later: (key, step) => this.later(key, step),
      soon: (step) => setTimeout(step, 0),
      setBusy: (key, label) => this.setBusy(key, label),
    });
    this.keptSuggestions = new KeptSuggestions(this.results.fp);
    this.probes = new ProbeClient({
      results: this.results,
      cacheReady: this.cacheReady,
      rom: () => this.rom,
      tileset: () => this.level.header.tileset,
      kindLevel: () => {
        const lv = this.level;
        return { level: { number: lv.number, header: lv.header }, layer2Pointer: levelBgPointer(this.rom, lv) };
      },
      connect: (reply, failed) => {
        const w = new Worker(new URL('./probeworker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ProbeReply>) => reply(e.data);
        w.onerror = (e) => { console.error(e); w.terminate(); failed(); };
        return (m) => w.postMessage(m, m.type === 'rom' ? [m.data.buffer] : m.type === 'edit' ? m.edits.map(([, b]) => b.buffer) : []);
      },
      later: (key, step) => this.later(key, step),
      soon: (step) => setTimeout(step, 0),
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
    const { put, order, del } = this.results.flush();
    kvWrite([...put, ...order].map(([k, v]) => [CACHE_PREFIX + k, v]), del.map((k) => CACHE_PREFIX + k)).catch((e) => console.error(e));
  }

  // drops the loaded results that no longer hold for the ROM (also those of inputs not in use), a slice at a time
  // (once: a result whose bytes an edit changes, and an undo changes back, would be dropped for nothing)
  private sweepResults(): void {
    const step = () => { if (this.results.sweep(SWEEP_SLICE)) this.later('result-sweep', step); };
    this.later('result-sweep', step);
  }

  // (returns what takes fn off again)
  on(ev: AppEvent, fn: Listener): () => void {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
    return () => { this.listeners.get(ev)?.delete(fn); };
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
    this.scheduleSuggestions(); // (the open level as edited is part of them)
  }

  get vertical(): boolean {
    return isL1Vertical(this.rom, this.level.header.mode);
  }

  buildOverrides(lv = this.level): LevelOverride {
    const ov = levelOverride(this.rom, lv);
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
      // as many steps as the level's own animations take to repeat (the game's repeat after 8), emulated in
      // the background (startAnimation)
      const anim = this.show.anim && r.ok;
      this.anim.snaps = [];
      this.anim.count = anim ? exanimPeriod([readLevelList(this.rom, lv.number), readGlobalList(this.rom)], 64, 8) : 0;
      this.anim.next = anim ? this.emu.animationSteps() : null;
      this.render = r;
      this.images = renderLevel(this.rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
    });
    this.rendered = { key, gen, reads };
    // picker thumbnails are transparent: shown on the level's backdrop as in the game
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

  // emulates and renders the animation snapshots in the background, then cycles them (8 game frames each)
  startAnimation(): void {
    const a = this.anim;
    const gen = ++a.gen;
    a.frames = [];
    a.phase = -1;
    a.base = this.compositeImg;
    if (!a.count) { this.stopAnimation(); this.setBusy('anim', null); return; }
    const base = a.base, snaps = a.snaps, lv = this.level;
    let i = 0;
    const step = () => {
      if (gen !== a.gen) return;
      if (i === snaps.length) {
        // the next image emulated, what it reads counting for the render (refresh)
        const { result, reads } = this.emu.recordAll(() => a.next?.() ?? null);
        this.rendered?.reads.add(reads);
        if (result) snaps.push(result);
        else a.count = snaps.length;
      }
      if (i < a.count) {
        // only the cells the step changes drawn anew; all of them when it changes every cell
        const changed = animatedPixels(this.rom, this.render, this.images, base, snaps[i].vram, snaps[i].cgram, (cell) => this.compose(cell));
        if (changed) a.frames.push(changed);
        else {
          const li = renderLevel(this.rom, { ...this.render, vram: snaps[i].vram, cgram: snaps[i].cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
          const img = this.compose(li);
          const idx: number[] = [];
          for (let k = 0; k < img.length; k++) if (img[k] !== base[k]) idx.push(k);
          const ix = Uint32Array.from(idx);
          a.frames.push({ idx: ix, val: ix.map((k) => img[k]) });
        }
        i++;
      }
      if (i < a.count) { this.setBusy('anim', `Animations ${i + 1}/${a.count}`); this.later('anim', step); return; }
      this.setBusy('anim', null);
      if (a.frames.length && !a.timer) a.timer = window.setInterval(() => this.animTick(), 1000 / 7.5);
    };
    this.setBusy('anim', `Animations 1/${a.count}`);
    this.later('anim', step);
  }

  // the canvases following the animation (pickeranim.ts) go back to the level as rendered
  private stopAnimation(): void {
    const a = this.anim;
    if (!a.timer) return;
    clearInterval(a.timer);
    a.timer = 0;
    this.emit('anim-frame');
  }

  // the step of the animation shown now; null when none is (the level as rendered)
  animStep(): AnimStep | null {
    const a = this.anim;
    return this.show.anim && a.timer && a.phase >= 0 ? a.snaps[a.phase] ?? null : null;
  }

  // the animation's steps on canvases of the level's Map16 tiles (the pickers'), for the render shown
  private tileAnim: { r: LevelRender; anim: TileAnimation } | null = null;
  tileAnimation(): TileAnimation {
    if (this.tileAnim?.r !== this.render) this.tileAnim = { r: this.render, anim: new TileAnimation(this.rom, this.render) };
    return this.tileAnim.anim;
  }

  animTick(): void {
    const a = this.anim;
    if (!a.frames.length || !a.base) return;
    if (!this.show.anim) { this.stopAnimation(); return; }
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

  // the message the message panel shows (msg 1 or 2 of a translevel), null while it is closed
  messages: { translevel: number; msg: number } | null = null;
  openMessages(translevel: number, msg: number): void {
    this.messages = { translevel, msg };
    this.emit('messages');
  }
  closeMessages(): void {
    this.messages = null;
    this.emit('messages');
  }

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
  // variant images by sprite and position; their input (spriteInput) the rest of what they depend on. Captured in
  // the probe worker (probeclient.ts; without one on the main thread)
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
    const show = this.showSprites, { all } = this.spriteJobs();
    const stored = this.probes.learn(all.key, all.job, {
      input: all.input, lane: 'sprites', replace: true, label: 'Sprite graphics', done: this.spritesLearned,
      shown: (items) => { show(items as [number, SpriteImage][] | null); if (items) this.spritesShown(); },
    });
    if (stored && stored !== this.spritesFrom) this.spritesLearned(stored);
  }
  // What the images of level lv's sprites are learned with (the open level's; another level's for its image file):
  // all sprites (the ids the picker lists), a custom sprite with extra bytes, a sprite's variant at a place
  spriteJobs(lv: Level = this.level): { all: SpriteJob; bytes: (id: number, bytes: number[]) => SpriteJob; at: (id: number, x: number, y: number) => SpriteJob } {
    const hd = lv.header, set = `${hd.spriteGfx}-${hd.spritePalette}`;
    // (the level as sprite images are captured in it)
    const level: SpriteLevel = { number: lv.number, header: { ...hd }, spriteHeader: lv.spriteHeader, bgPointer: lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900 };
    const nums = [...Array.from({ length: 0xe7 }, (_, i) => i), ...this.customSprites().map((c) => c.id)]; // as listed in the picker
    // i6: with the input; sprites from $C9 on (shells, groups), failed batches retried one by one, sprites
    // that draw nothing shown by what they spawn, sprites erasing themselves at once by what they drew
    // (each test level load is kept on its own, with what spriteInput gives but the custom sprites: a custom sprite
    // added or changed captures only its load again)
    const input = this.spriteInput(lv), { custom: _, ...loadInput } = input;
    return {
      all: { key: `i6${set}`, job: { kind: 'sprites', level, nums, input: inputHash(loadInput) }, input },
      bytes: (id, b) => ({ key: `b3${set}:${id}:${b.join(',')}`, job: { kind: 'spriteBytes', level, id, bytes: b }, input }),
      at: (id, x, y) => ({ key: `v5${set}:${id}:${x}:${y}`, job: { kind: 'spriteAt', level, id, x, y }, input }),
    };
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
  private spriteInput(lv: Level): { custom: number[] } & Record<string, unknown> {
    const hd = lv.header, files = this.spriteGfxFiles(lv);
    const m = this.spriteFiles;
    if (m.gen !== this.rom.gen || m.files !== files.join()) { m.gen = this.rom.gen; m.files = files.join(); m.hash = gfxFilesHash(this.rom, files); }
    return { gfx: hd.spriteGfx, palette: hd.spritePalette, memory: lv.spriteHeader & SPRITE_MEMORY, files: m.hash, custom: this.customSprites().map((c) => c.id) };
  }
  private spriteFiles = { gen: -1, files: '', hash: 0 }; // the hash of the sprite graphics files

  // image of sprite id (see spriteId) at tile (x, y): sprites that start differently depending on their
  // position (see SpriteVariants) get an own image per variant, captured in the background once known;
  // custom sprites with extra bytes other than 0 one per bytes
  spriteImage(id: number, x: number, y: number, bytes?: number[]): HTMLCanvasElement | undefined {
    const base = this.spriteThumbs.get(id), shown = this.spritesShown, jobs = this.spriteJobs();
    if (bytes?.some((b) => b)) {
      const j = jobs.bytes(id, [...bytes]);
      const img = this.probes.learn<SpriteImage | null>(j.key, j.job, { input: j.input, lane: 'bytes', done: shown });
      return img ? this.spriteCanvas(img) : base;
    }
    const at = this.spriteVariant(id, x, y);
    if (!at) return base;
    const j = jobs.at(id, at.x, at.y);
    const img = this.probes.learn<SpriteImage | null>(j.key, j.job, { input: j.input, lane: 'variants', label: (n) => `Sprite variants (${n})`, done: shown });
    return img ? this.spriteCanvas(img) : base;
  }
  // the place whose image sprite id at tile (x, y) shows in tileset ts: null when it looks the same everywhere,
  // undefined while its probe isn't known (asked for then)
  spriteVariant(id: number, x: number, y: number, ts = this.level.header.tileset): { x: number; y: number } | null | undefined {
    const p = this.probes.spriteIn(id, ts);
    if (!p) return p;
    return p.variants.reps.length < 2 ? null : p.variants.reps[variantOf(p.variants, x, y)];
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
  private spriteGfxFiles(lv: Level): number[] {
    const hd = lv.header;
    const set = levelGfx(this.rom, lv.number), def = defaultGfx(this.rom, hd.tileset, hd.spriteGfx);
    return [0, 1, 2, 3].map((k) => (set[k] !== 0xff ? set[k] : def[k]));
  }

  spriteCanvas(img: SpriteImage): HTMLCanvasElement {
    let c = this.canvases.get(img);
    if (!c) this.canvases.set(img, (c = spriteCanvas(img)));
    return c;
  }

  // ------------- sprite memory (see spritemem.ts) -------------
  // sprites drawn incompletely because their OAM range is too small, and a sprite memory value
  // that shows all; checked in the probe worker after every change (only the groups of sprites it changed: the others'
  // results are kept there)
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
    const done = (r: SpriteMemResult) => {
      if (run !== this.spriteMemRun || this.level !== lv) return;
      const cur = { key: checked, level: lv.number, mem, gen, conflicts: new Set(r.lost.map((i) => sprites[i].uid)), suggestion: r.suggestion };
      this.spriteMem = cur;
      this.emit('sprite-mem');
      if (gen !== this.edits.levelGen) return; // edited meanwhile: checked again
      const base = this.spriteMemBase;
      this.spriteMemBase = cur;
      if (base) this.autoSpriteMem(base, cur);
    };
    const level: SpriteMemLevel = { number: lv.number, header, bgPointer: bg, mem, candidates, sprites };
    const stored = this.probes.learn<SpriteMemResult>(key, { kind: 'spriteMem', level }, { input, lane: 'spritemem', replace: true, label: 'Checking sprite memory', done });
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
  // palette animation), found by emulating some frames in the probe worker, kept in memory with the level as
  // edited as their input; null until known ('animated' when done), the level's previous ones meanwhile
  animated(): Animated | null {
    const n = this.level.number, ov = this.buildOverrides();
    // (the load's owners of level bytes aren't needed: not sent)
    const res = this.probes.learn<Animated>(`anim:${n}`, { kind: 'animated', level: n, ov: { ...ov, byteOwner: undefined } },
      { input: { level: this.levelInput(ov), masked: this.maskedHash() }, lane: 'animated', replace: true, done: this.animatedLearned });
    if (res) this.animatedShown = { level: n, res };
    return this.withOwnAnims(res ?? (this.animatedShown?.level === n ? this.animatedShown.res : null));
  }
  private animatedShown: { level: number; res: Animated } | null = null;
  private animatedLearned = () => this.emit('animated');
  // plus the tiles and colors the ROM's own ExAnimation slots overwrite (their trigger may not fire in the
  // emulated frames, e.g. on/off or manual), read from the lists as they are now
  private ownAnim: { key: string; res: Animated | null; out: Animated | null } = { key: '', res: null, out: null };
  private withOwnAnims(res: Animated | null): Animated | null {
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
    // the boxes of objects that draw nothing lie on top
    const box = boxAt(this.boxedObjects(l2), tx, ty);
    if (box) return box;
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
    // a hidden conditional Direct Map16 object's tiles
    const at = (ty << 16) | tx;
    for (let i = objs.length - 1; i >= 0; i--) if (isDm16(objs[i]) && objs[i].cond && dm16Tiles(objs[i]).includes(at)) return objs[i];
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

  // the objects of layer 1 (or 2) that wrote no tile in the level's load: shown as boxes (objboxes.ts)
  boxedObjects(l2 = this.mode === 'l2'): LevelObject[] {
    const objs = (l2 ? this.level.layer2Objects : this.level.objects) ?? [];
    return boxedObjects(objs, this.render.touched, (i) => this.objectKey(l2, i));
  }

  // what a box's object is called, null when it has no name but its number (object 2D's custom numbers have none)
  boxName(o: LevelObject): string | null {
    if (o.extension) return null;
    const n = this.objectName(o.num, o.ext);
    return n === numberName(o.num, o.ext) ? null : n;
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
  // the switch states the view sets (the probes' order: blue P-switch, silver P-switch, OFF)
  viewSwitches(): SwitchState[] {
    return SWITCH_STATES.filter((sw) => (sw === 'off' ? this.switches.onOff : this.exTriggers.game.has(SWITCH_TRIGGER[sw])));
  }

  cachedCollision(tile: number): CollisionProbe | undefined {
    return this.results.get(collisionKey(this.level.header.tileset, tile));
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
  // with each of them in the probe worker; kept per tileset while the level as edited and the ROM it read
  // are unchanged. null while that runs, then `done` is called (the latest tileset asked for only).
  layer3Kinds(tileset: number, done: () => void): Layer3Kind[] | null {
    const lv = this.level, ov = this.buildOverrides(), input = this.levelInput(ov);
    if (tileset !== lv.header.tileset) ov.layer1 = serializeLayer1(this.rom, { ...lv, header: { ...lv.header, tileset } });
    // (the load leaves out the sprites and the owners of level bytes: not sent)
    return this.probes.learn<Layer3Kind[]>(`l3k2:${tileset}`, { kind: 'layer3', level: lv.number, ov: { ...ov, sprites: undefined, byteOwner: undefined } },
      { input, lane: 'layer3', replace: true, label: 'Layer 3 settings', done }) ?? null;
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

  // What every layer 2 scroll setting does (l2scroll.ts), measured with the level's code in the probe worker a
  // setting at a time; null while that runs, then `done` is called. Kept per level while
  // the level as edited and the ROM it read are unchanged.
  layer2Motions(done: () => void): Layer2Motions | null {
    const n = this.level.number, ov = this.buildOverrides();
    // (urgent: the header dialog shows them)
    return this.probes.learn<Layer2Motions>(`l2m2:${n}`, { kind: 'layer2Motions', level: n, ov }, { input: this.levelInput(ov), lane: 'l2', replace: true, urgent: true, done }) ?? null;
  }

  // The Map16 tiles of every level (levelusage.ts), the open one as edited: those known now, the others are
  // learned in the probe worker ('level-uses' as they come); pending: how many are still missing (the open level's
  // previous ones count as missing while its tiles as edited are learned)
  levelTiles(): { levels: LevelTiles[]; pending: number } {
    const idx = this.usesIndex ??= new LevelUses(this.rom, this.results);
    // the open level's (kept in memory with the level as edited as their input); a level with conditional
    // Direct Map16 objects in both of their states, whatever the view's flags
    const lv = this.level, ov = this.buildOverrides();
    const here = this.probes.learn<LevelTiles>(`lt:${lv.number}`, { kind: 'levelTiles', level: lv, ov },
      { input: this.levelInput(ov), lane: 'lt', replace: true, label: 'Uses in this level', done: this.usesLearned });
    // (the last known ones meanwhile, of this level since it was opened: none after another level's)
    if (here || this.levelTilesShown?.level !== lv.number) this.levelTilesShown = here ?? null;
    const shown = here ?? this.levelTilesShown;
    const levels = shown ? [shown] : [], missing: number[] = [];
    for (const n of usedLevels(this.rom)) {
      if (n === this.level.number) continue;
      const t = idx.tiles(n);
      if (t) levels.push(t); else missing.push(n);
    }
    if (missing.length) this.learnLevelTiles(missing);
    return { levels, pending: missing.length + (here ? 0 : 1) };
  }
  private levelTilesShown: LevelTiles | null = null; // the open level's tiles last known
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
    return this.learner.tilesetPointers();
  }
  // the entrance actions that make a level slippery (slippery.ts), learned once and kept in the result cache
  slipperyActions(): number[] {
    return this.learner.now('slip1', slipperyActions, { picture: false });
  }
  // what Mario does on each overworld layer 1 tile 00–FF (owpaths.ts): learned in the probe worker once and kept in
  // the result cache while the game's code is unchanged; null while that runs, then `done` is called
  pathKinds(done: () => void): PathKind[] | null {
    return this.probes.learn<PathKind[]>('owpk1', { kind: 'pathKinds' }, { lane: 'owpk1', label: 'Path tiles', done }) ?? null;
  }
  // The overworld as emulated, learned in the probe worker and kept in memory while the ROM bytes it read are unchanged
  // (the latest event progresses of each map): undefined while it runs, then `done` is called. Map `map` at event
  // progress `progress` (a new request drops the one still waiting: the slider), the submaps' views, the sprites' images
  // at a map and progress (a new request drops the one still waiting).
  overworldMap(map: number, progress: number, done: (r: OwRender) => void): OwRender | undefined {
    return this.probes.learn<OwRender>(`owm1:${map}`, { kind: 'owMap', map, progress }, { lane: 'ow', input: { progress }, replace: true, label: 'Overworld', done });
  }
  // the save at an event progress (owprogress.ts progressSaves: the level flags, switch palaces and events triggered
  // the game has then), learned in the probe worker and kept in memory while the ROM bytes it read are unchanged:
  // undefined while it runs, then `done` is called (`failed`: it could not be learned)
  progressSave(progress: number, done: (v: ProgressSave) => void, failed?: () => void): ProgressSave | undefined {
    return this.probes.learn<ProgressSave>('owps1', { kind: 'owSave', progress }, { lane: 'owps', input: { progress }, replace: true, label: 'Overworld progress', done, failed });
  }
  submapViews(done: (v: Rect[]) => void): Rect[] | undefined {
    return this.probes.learn<Rect[]>('owv1', { kind: 'owViews' }, { lane: 'owv', label: 'Submap views', done });
  }
  overworldSprites(map: number, progress: number, done: (v: OwSpriteView[]) => void): OwSpriteView[] | undefined {
    return this.probes.learn<OwSpriteView[]>(`ows1:${map}`, { kind: 'owSprites', map, progress }, { lane: 'ows', input: { progress }, replace: true, label: 'Overworld sprites', done });
  }
  // the custom overworld sprites' images at a map and progress (BOWSIE's, owsprites.ts customSpriteImages), and how the
  // installed ones look (the palette)
  overworldCustomSprites(map: number, progress: number, done: (v: OwSpriteView[]) => void): OwSpriteView[] | undefined {
    return this.probes.learn<OwSpriteView[]>(`owc1:${map}`, { kind: 'owCustom', map, progress }, { lane: `owc${map}`, input: { progress }, replace: true, label: 'Overworld sprites', done });
  }
  overworldSpriteLooks(ids: number[], done: (v: (SpriteImage | null)[]) => void): (SpriteImage | null)[] | undefined {
    return this.probes.learn<(SpriteImage | null)[]>(`owl1:${ids.join(',')}`, { kind: 'owLooks', ids }, { lane: 'owl', replace: true, label: 'Overworld sprites', done });
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

  // the other levels' tiles not known (missing; each stored by LevelUses), learned in the probe worker, 'level-uses' as
  // they come
  private learnLevelTiles(missing: number[]): void {
    this.probes.learn('uses', { kind: 'uses', levels: missing }, { lane: 'uses', label: 'Uses in levels', shown: this.usesShown, done: this.usesLearned });
  }
  private usesShown = (levels: unknown[] | null) => { if (levels?.length) this.emit('level-uses'); };
  private usesLearned = () => this.emit('level-uses');

  // ------------- jump arcs (see jumparcs.ts) -------------
  // arcs from a tile of the level as edited: emulated in the probe worker, the latest request only, kept in
  // memory with the level as edited as their input; 'arcs' when some are ready
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
    return this.probes.learn<JumpArc[]>(`arcs:${tx},${ty}`, { kind: 'arcs', level, load: [lv.number, ov, lv.spriteHeader, height], tx, ty, runs },
      { input: { level, runs }, lane: 'arcs', replace: true, label: 'Jump arcs', done: this.arcsLearned });
  }
  private arcsLearned = () => this.emit('arcs');

  // The object picker's thumbnails of specs in the level as edited (objthumbs.ts): undefined while they are
  // learned in the probe worker ('thumbs' when done)
  objectThumbs(specs: ObjSpec[]): ObjThumb[] | undefined {
    const rom = this.rom, lv = this.level, keys = new Map(specs.map((s) => [s, objKey(s, this.objectKind(s.num))]));
    const keyOf = (s: ObjSpec) => keys.get(s)!, level = { ...lv, header: { ...lv.header } };
    return this.probes.learn<ObjThumb[]>(thumbsKey(lv, specs, keyOf), { kind: 'thumbs', level, specs, keys: specs.map(keyOf) },
      { input: thumbsInput(rom, lv), lane: 'thumbs', replace: true, label: 'Object thumbnails', done: this.thumbsLearned });
  }
  private thumbsLearned = () => this.emit('thumbs');

  private objectNamesSeen = ''; // the user's object names as last told ('object-names')
  // the object table of a tileset's standard objects (objectnames.ts), learned once and kept in the result cache
  objectTable(ts = this.level.header.tileset): number | null {
    return this.learner.now(`otab1:${ts}`, (emu) => objectTable(emu, ts), { picture: false });
  }
  // the name of an object in the open level's tileset: the user's, else the built-in one (objectnames.ts)
  objectName(num: number, ext: number): string {
    return objectName(this.rom, num, ext, this.objectTableOf(num));
  }
  // the object table an object's name depends on (null: none, or unknown)
  objectTableOf(num: number): number | null {
    return namedPerTable(num) ? this.objectTable() : null;
  }
  // names an object for the project, 2E-3F for the open level's object table; empty: back to the built-in name
  renameObject(num: number, ext: number, name: string): void {
    const what = num ? `Object ${hex2(num)}` : `Extended object ${hex2(ext)}`;
    const key = objectNameKey(num, ext, this.objectTableOf(num));
    if (key === null) { toast(`${what}: the object table of this tileset is unknown, so it cannot be named`, 'error'); return; }
    try { this.romEdit(name.trim() ? `${what} renamed` : `${what}: name reset`, () => setObjectName(this.rom, key, name)); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

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
    this.scheduleSuggestions();
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
    const { w, h } = this.objectLimits();
    o.x = Math.max(0, Math.min(w - 1, o.x));
    o.y = Math.max(0, Math.min(h - 1, o.y));
  }
  // the tiles an object's origin can be on in the mode's layer: 0 to w - 1, 0 to h - 1
  objectLimits(): { w: number; h: number } {
    const w = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.width : this.levelWidthTiles();
    const hgt = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.height : this.levelHeightTiles();
    return { w, h: this.vertical ? Math.min(hgt, 0x1ff) : hgt };
  }

  insertAt(tx: number, ty: number, p: PickedItem | null = this.pickedItem): void {
    if (!p) { toast('Choose an object/sprite in the picker first.'); return; }
    this.editLevel(() => {
      const pl = this.newItems(p, tx, ty);
      if (!pl) return false;
      this.add(pl);
    });
    // the placed item is selected: changed (resized, …), the next right click copies it as it is now
    this.stampSelection = true;
  }
  // picked item p at tile (tx, ty): objects in layer 1/2, a sprite in any mode; null when it can't go into the
  // current mode (an object while editing sprites)
  private newItems(p: PickedItem, tx: number, ty: number): Placement | null {
    if (p.kind === 'spr') {
      const s: LevelSprite = { uid: newUid(), num: p.num, x: tx, y: ty, extra: p.extra };
      if (s.extra >= 2) { const b = spriteBytes(spriteSizes(this.rom), s); if (b.length) s.bytes = b; }
      return { objects: [], sprites: [s] };
    }
    if (this.mode !== 'l1' && this.mode !== 'l2') return null;
    const cells = p.block ? Array.from({ length: p.block.w * p.block.h }, (_, i) => ({ dx: i % p.block!.w, dy: Math.floor(i / p.block!.w) })) : [{ dx: 0, dy: 0 }];
    const objects = cells.map(({ dx, dy }) => {
      const o: LevelObject = { uid: newUid(), num: p.num, ext: p.ext, x: tx + dx, y: ty + dy, size: p.size };
      if (p.tile !== undefined) o.tile = p.tile + dy * 16 + dx;
      if (p.prefab !== undefined) o.prefab = p.prefab;
      if (p.extension) o.extension = [...p.extension];
      fitExtension(o, objectLength2D(this.rom));
      this.clampObject(o);
      return o;
    });
    return { objects, sprites: [] };
  }
  // copies of the current mode's items with their upper left at tile (tx, ty)
  private copiesAt(items: (LevelObject | LevelSprite)[], tx: number, ty: number): Placement {
    const minX = Math.min(...items.map((o) => o.x)), minY = Math.min(...items.map((o) => o.y));
    const copies = items.map((it) => {
      const c = { ...structuredClone(it), uid: newUid(), x: it.x - minX + tx, y: it.y - minY + ty };
      this.clampObject(c);
      return c;
    });
    return this.mode === 'spr' ? { objects: [], sprites: copies as LevelSprite[] } : { objects: copies as LevelObject[], sprites: [] };
  }
  // puts the placement into the level, selected (sprites in mode sprites)
  private add(pl: Placement): void {
    if (pl.sprites.length && this.mode !== 'spr') this.setMode('spr');
    this.level.sprites.push(...pl.sprites);
    this.currentObjects().push(...pl.objects);
    this.selection = new Set([...pl.objects, ...pl.sprites].map((o) => o.uid));
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

  // where the arrangement of prefab s already is as Direct Map16 objects (prefabplaces.ts): the open level as
  // edited (not its selected objects, unless all) and all other levels as saved
  prefabPlaces(s: Prefab, all = false): LevelPlaces[] {
    const open = this.level.number, layer = this.mode === 'l2' ? 2 : 1, sel = new Set(all ? [] : this.selectedIndices());
    return planPrefabPlaces(this.rom, s, {
      levels: usedLevels(this.rom),
      level: (n) => (n === open ? this.level : loadLevel(this.rom, n)),
      load: (n, ov) => this.learner.emu().load(n, ov),
      skip: (n, l, i) => n === open && l === layer && sel.has(i),
    });
  }
  private selectedIndices(): number[] {
    return this.currentObjects().flatMap((o, i) => (this.selection.has(o.uid) ? [i] : []));
  }

  // stores the selection as prefab n; replace: the selected objects become one prefab object (at the place of
  // the last of them in the object list, so objects in between still cover it); places (prefabPlaces): replaced
  // too, with the prefab and the selection in one ROM edit (else the selection is a level edit after it)
  saveSelectionAsPrefab(n: number, name: string, replace: boolean, places: LevelPlaces[] = []): boolean {
    const r = this.prefabFromSelection();
    if (typeof r === 'string') { toast(r, 'error'); return false; }
    const open = this.level.number, layer = this.mode === 'l2' ? 2 : 1;
    const selection: PrefabGroup = { layer, x: r.x, y: r.y, objects: this.selectedIndices() };
    const sources = { objects: this.currentObjects().filter((o) => this.selection.has(o.uid)), x: r.x, y: r.y };
    const plan: LevelGroups[] = places.map((p) => ({ level: p.level, places: [...p.places] }));
    if (replace && plan.length) {
      let here = plan.find((p) => p.level === open);
      if (!here) plan.push(here = { level: open, places: [] });
      here.places.push(selection);
    }
    if (!this.storePrefab(n, { w: r.w, h: r.h, tiles: r.tiles, ...(r.conds ? { conds: r.conds } : {}), name }, plan, places, sources)) return false;
    if (replace && plan.length) {
      // the open level was loaded again: the prefab object where the selection's last object was, after the
      // objects replaced before it
      const last = Math.max(...selection.objects), gs = plan.find((p) => p.level === open)!.places.filter((g) => g.layer === layer);
      const at = last + 1 - gs.flatMap((g) => g.objects).filter((i) => i <= last).length + gs.filter((g) => Math.max(...g.objects) < last).length;
      const o = this.currentObjects()[at];
      if (o) { this.selection = new Set([o.uid]); this.emit('change'); }
    } else if (replace) {
      this.editLevel((lv) => { this.selection = new Set(replaceWithPrefab(lv, n, [selection]).map((o) => o.uid)); });
    }
    this.pickedItem = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n };
    return true;
  }

  // stores arrangement s (a suggestion's) as prefab n, its places (prefabPlaces) replaced in the same ROM edit
  saveArrangementAsPrefab(n: number, s: Prefab, places: LevelPlaces[]): boolean {
    if (!this.storePrefab(n, s, places, places)) return false;
    // its places replaced: not offered any more (the next background run doesn't find it either)
    const key = arrangementKey(s);
    if (places.length && this.prefabSuggestions?.some((q) => q.key === key)) {
      this.prefabSuggestions = this.prefabSuggestions.filter((q) => q.key !== key);
      this.emit('prefab-suggestions');
    }
    this.pickedItem = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n };
    return true;
  }

  // prefab n as s and plan's objects replaced by it, one ROM edit labelled with the places found elsewhere;
  // sources: the objects it is made from, its top left at x, y (prefabsources.ts)
  private storePrefab(n: number, s: Prefab, plan: LevelGroups[], places: LevelPlaces[], sources?: { objects: LevelObject[]; x: number; y: number }): boolean {
    const open = this.level.number, found = places.reduce((k, p) => k + p.places.length, 0);
    try {
      this.romEdit(`Prefab ${hex(n, 2)} saved${found ? `, ${found} place${found > 1 ? 's' : ''} replaced` : ''}`, () => {
        // (the plan's objects are the open level's as edited: saved before the ROM edit)
        if (plan.some((p) => p.level === open) && this.dirty) throw new Error(`Level ${hex(open, 3)} could not be saved`);
        writePrefab(this.rom, n, s);
        setPrefabSources(this.rom, n, s, sources?.objects ?? null, sources?.x, sources?.y);
        applyPrefabPlaces(this.rom, n, plan);
      });
      return true;
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
  }

  // the suggestions anew a while after the last change, in the probe worker; the levels that didn't change keep their
  // results there (prefabsuggest.ts KeptSuggestions; keptSuggestions: the latest run as it came). A change they don't depend on keeps them current at once;
  // one back to the latest run's state (an undo) makes them current at once with that run's whole list (a suggestion
  // saved and undone is back with its places, a list it was dropped from is never current).
  private scheduleSuggestions(): void {
    const held = this.keptSuggestions.held(this.rom, this.suggestSource());
    if (held) {
      if (this.suggestionsCurrent) return;
      clearTimeout(this.suggestTimer);
      this.suggestRun++; // (a run started meanwhile stops)
      this.probes.unlearn('prefab-suggest');
      this.prefabSuggestions = held;
      this.suggestionsCurrent = true;
      this.emit('prefab-suggestions');
      return;
    }
    clearTimeout(this.suggestTimer);
    this.suggestionsCurrent = false;
    this.probes.unlearn('prefab-suggest'); // (a run started before stops)
    const run = ++this.suggestRun;
    this.suggestTimer = window.setTimeout(() => {
      if (run !== this.suggestRun || this.closed) return;
      const { levels, open } = this.suggestSource();
      // (the run's number as its input: a new one replaces the one running)
      this.probes.learn<SuggestRun>('suggest', { kind: 'suggest', levels, open }, { lane: 'prefab-suggest', input: run, replace: true, done: (r) => {
        if (run !== this.suggestRun) return;
        this.keptSuggestions.adopt(r);
        this.prefabSuggestions = r.list;
        this.suggestionsCurrent = true;
        this.emit('prefab-suggestions');
      } });
    }, 1500);
  }
  private suggestSource(): SuggestLevels {
    return { levels: usedLevels(this.rom), open: this.level };
  }

  // levels whose saved data uses prefab n (plus the open level with its unsaved changes), with how many objects
  prefabUses(n: number): { level: number; count: number }[] {
    const out: { level: number; count: number }[] = [];
    for (const i of this.usedLevels()) {
      try {
        const count = prefabObjectCount(i === this.level.number ? this.level : loadLevel(this.rom, i), n);
        if (count) out.push({ level: i, count });
      } catch { /* unreadable level */ }
    }
    return out;
  }
  prefabUsers(n: number): number[] {
    return this.prefabUses(n).map((u) => u.level);
  }

  // deletes prefab n with its objects in all levels, one ROM edit
  deletePrefab(n: number): void {
    try { this.romEdit(`Prefab ${hex(n, 2)} deleted`, () => deletePrefab(this.rom, n, usedLevels(this.rom))); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  // a prefab object becomes the objects it was made from where they draw the level as it does, else Direct Map16
  // objects (rectangles of one tile), at its place in the object list (prefabsources.ts)
  explodePrefab(o: LevelObject): void {
    const r = breakUpPrefab(this.rom, this.level, o, this.vertical, (lv) => this.learner.emu().load(lv.number, this.buildOverrides(lv)));
    if (!r) { toast('The prefab does not exist (anymore).', 'error'); return; }
    this.editLevel((lv) => {
      const { objects, layer2Objects } = replaced(lv, o, r.parts);
      lv.objects = objects;
      if (layer2Objects) lv.layer2Objects = layer2Objects;
      this.selection = new Set(r.parts.map((p) => p.uid));
    });
    if (r.differs) toast('Its objects would look different here: broken up into single tiles.', 'info');
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

  // resize: width/height nibbles of settings byte by one step each; the left and top edges stay where they
  // are, with far the right and bottom ones (an object at the level's edge that would have to leave it stays)
  resizeSelection(dw: number, dh: number, far = false): void {
    const objs = this.selectedObjects().filter((o) => this.resizable(o));
    if (!objs.length) return;
    const sized = objs.map((o) => resizeObjectSize(this.objectKind(o.num), o.size, dw, dh));
    // (the boxes asked for first: resized when they come)
    if (!this.askSizes(objs.flatMap((o, i) => [this.sizeSpec(o, o.size), this.sizeSpec(o, sized[i])]), () => this.resizeSelection(dw, dh, far))) return;
    const { w, h } = this.objectLimits();
    this.editLevel(() => objs.forEach((o, i) => {
      const box = this.sizeBoxes(o);
      if (!box(o.size) || !box(sized[i])) { o.size = sized[i]; return; } // (draws nothing: the origin stays)
      const at = keepEdges(o, sized[i], box, far, w, h);
      if (at) { o.x = at.x; o.y = at.y; o.size = sized[i]; }
    }));
  }

  // whether the settings byte sizes the object: standard objects and Direct Map16
  resizable(o: LevelObject): boolean {
    return o.num !== 0 || o.ext === DM16_EXT;
  }

  // the tiles objects cover at each size, emulated alone (objresize.ts) in the probe worker, for the level's tileset as
  // the ROM is now: those known (key: of the level and ROM state they hold for)
  private sized = { key: '', boxes: new Map<string, Box | null>() };
  private sizeLevel(): { key: string; level: KindLevel; layer2Pointer: number } {
    const lv = this.level, l2 = levelBgPointer(this.rom, lv);
    return { key: `${this.rom.gen}:${lv.number}:${inputHash(lv.header)}:${l2}`, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 };
  }
  private sizeBoxMap(): Map<string, Box | null> {
    const { key } = this.sizeLevel();
    if (this.sized.key !== key) { this.sized = { key, boxes: new Map() }; this.driverMemo.clear(); }
    return this.sized.boxes;
  }
  // asks the probe worker for the boxes of specs not known ('sizes' when they come, then done); whether all are known
  private askSizes(specs: SizeSpec[], done?: () => void): boolean {
    const boxes = this.sizeBoxMap(), todo = [...new Map(specs.filter((s) => !boxes.has(sizeKey(s))).map((s) => [sizeKey(s), s])).values()];
    if (!todo.length) return true;
    const { key, level, layer2Pointer } = this.sizeLevel();
    this.probes.learn<(Box | null)[]>('sizes', { kind: 'sizes', level, layer2Pointer, specs: todo }, { lane: 'sizes', input: { key, specs: todo.map(sizeKey) }, done: (got) => {
      if (this.sized.key === key) got.forEach((b, i) => this.sized.boxes.set(sizeKey(todo[i]), b));
      this.emit('sizes');
      done?.();
    } });
    return false;
  }
  private sizeSpec(o: LevelObject, size: number): SizeSpec {
    return { num: o.num, ext: o.ext, size, tile: o.tile, extension: o.extension };
  }
  // the object's box at a size (relative to its origin), undefined while not probed
  sizeBoxes(o: LevelObject): (size: number) => Box | null | undefined {
    const boxes = this.sizeBoxMap();
    return (size) => boxes.get(sizeKey(this.sizeSpec(o, size)));
  }
  // every size the parts of the object's settings byte can take
  private allSizes(o: LevelObject): SizeSpec[] {
    return sizeParts(this.objectKind(o.num)).flatMap((p) => partSizes(o.size, p).map((s) => this.sizeSpec(o, s)));
  }
  // asks for all sizes of the objects now (a drag starts; 'sizes' when they come)
  probeSizes(objs: LevelObject[]): void {
    this.askSizes(objs.flatMap((o) => this.allSizes(o)));
  }
  // which part of the settings byte sizes which axis of the object: as emulated once its sizes are known,
  // before as its kind says (they are probed in the background then, 'sizes' when known)
  private driverMemo = new Map<string, Drivers>(); // (emulated ones, per object as resized and its kind)
  resizeDrivers(o: LevelObject): Drivers {
    const kind = this.objectKind(o.num), box = this.sizeBoxes(o);
    const key = `${o.num}:${o.ext}:${o.size}:${o.tile ?? ''}:${o.extension?.join(',') ?? ''}:${JSON.stringify(kind)}`;
    const had = this.driverMemo.get(key);
    if (had) return had;
    if (this.allSizes(o).every((s) => box(s.size) !== undefined)) {
      const d = drivers(kind, o.size, box);
      this.driverMemo.set(key, d);
      return d;
    }
    this.prefetchSizes();
    return namedDrivers(kind);
  }
  private sizesAsked: string | null = null; // the sizes' key (sizeLevel) and the selection whose sizes are asked for
  private prefetchSizes(): void {
    const objs = this.mode === 'l1' || this.mode === 'l2' ? this.selectedObjects().filter((o) => this.resizable(o)).slice(0, 32) : [];
    if (!objs.length) return;
    const key = `${this.sizeLevel().key}/${objs.map((o) => `${o.uid}.${o.size}`).join()}`;
    if (this.sizesAsked === key) return;
    this.sizesAsked = key;
    if (this.askSizes(objs.flatMap((o) => this.allSizes(o)), () => (this.sizesAsked = null))) this.sizesAsked = null;
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
    this.placeCopy((this.mode === 'spr' ? this.clipboard.sprites : this.clipboard.objects) ?? [], tx, ty);
  }
  // a right click in the level: a copy of the selection when it was picked after the picked item, else the picked item
  placeAt(tx: number, ty: number): void {
    if (this.copiesSelection()) this.placeCopy(this.selectedItems(), tx, ty);
    else this.insertAt(tx, ty);
  }
  private copiesSelection(): boolean {
    return this.stampSelection && this.selection.size > 0;
  }
  private selectedItems(): (LevelObject | LevelSprite)[] {
    return this.mode === 'spr' ? this.selectedSprites() : this.selectedObjects();
  }
  // what a right click at tile (tx, ty) places (placeAt); null: nothing (only layer 1/2 and sprites place)
  placement(tx: number, ty: number): Placement | null {
    if (this.mode !== 'l1' && this.mode !== 'l2' && this.mode !== 'spr') return null;
    if (this.copiesSelection()) { const items = this.selectedItems(); return items.length ? this.copiesAt(items, tx, ty) : null; }
    return this.pickedItem ? this.newItems(this.pickedItem, tx, ty) : null;
  }
  // The placement preview at tile (tx, ty): the placement as the level shows it once placed – objects drawn by
  // the level's load with them added (learned in the background: undefined until known), sprites with their images
  placementPreview(tx: number, ty: number): PreviewPart[] | undefined {
    const pl = this.placement(tx, ty);
    if (!pl) return [];
    const parts: PreviewPart[] = pl.sprites.map((s) => {
      const img = this.spriteImageOf(s) ?? null;
      return img ? { x: s.x * 16 + Number(img.dataset.ox), y: s.y * 16 + Number(img.dataset.oy), img } : { x: s.x * 16, y: s.y * 16, img };
    });
    if (!pl.objects.length) return parts;
    const objs = this.objectsPreview(pl.objects);
    return objs === undefined ? undefined : objs ? [...parts, objs] : parts;
  }
  // (the latest asked for, also while it is learned)
  private previewMemo: { render: LevelRender | null; sig: string; part: PreviewPart | null | undefined } = { render: null, sig: '', part: undefined };
  private objectsPreview(objects: LevelObject[]): PreviewPart | null | undefined {
    const sig = JSON.stringify([this.mode, objects.map((o) => ({ ...o, uid: 0 }))]), m = this.previewMemo;
    if (m.render === this.render && m.sig === sig) return m.part;
    const l2 = this.mode === 'l2', rom = this.rom, base = this.currentObjects();
    const lv: Level = l2 ? { ...this.level, layer2Objects: [...base, ...objects] } : { ...this.level, objects: [...base, ...objects] };
    const ov = this.buildOverrides(lv), g = l2 ? this.images.geom2 : this.images.geom1;
    if (!g) return null;
    // (learned in the probe worker: objectKey's keys of the placed objects)
    const pic = this.probes.learn<PlacementPreview | null>(`pp1:${lv.number}:${l2 ? 2 : 1}`, { kind: 'preview', level: lv, ov, layer2: l2, placed: objects.map((_, i) => base.length + i) },
      { input: inputHash(previewInput(rom, lv, ov)), lane: 'placement', replace: true, done: this.previewLearned });
    const part = pic && { x: pic.x0 * 16, y: pic.y0 * 16, img: thumbCanvas(pic) };
    this.previewMemo = { render: this.render, sig, part };
    return part;
  }
  private previewLearned = () => { this.previewMemo.render = null; this.emit('placement-preview'); };

  // the picked item chosen in the picker: the level's selection cleared (it would be copied by a right click)
  choosePickedItem(p: PickedItem): void {
    this.pickedItem = p;
    if (this.selection.size) { this.selection.clear(); this.emit('change'); }
    this.emit('picked-item');
  }
  // no picked item any more
  clearPickedItem(): void {
    if (!this.pickedItem) return;
    this.pickedItem = null;
    this.emit('picked-item');
  }

  // copies of the items with their upper left at tile (tx, ty), selected
  private placeCopy(items: (LevelObject | LevelSprite)[], tx: number, ty: number): void {
    if (!items.length) return;
    this.editLevel(() => this.add(this.copiesAt(items, tx, ty)));
    if (this.mode !== 'l1' && this.mode !== 'l2') return;
    const pasted = this.selectedObjects();
    const hint = this.pastes.paste(pasted);
    if (hint) this.setPasteHint({ ...hint, level: this.level.number, layer: this.mode, objects: structuredClone(pasted) });
  }
  setPasteHint(h: PasteHintAt | null): void {
    this.pasteHint = h;
    this.emit('paste-hint');
  }
  // no hint for the arrangement anymore
  dismissPasteHint(): void {
    if (this.pasteHint) this.pastes.dismiss(this.pasteHint.key);
    this.setPasteHint(null);
  }
  // the hint's pasted objects in the open level (uids), or null when they are no longer there (undone, removed)
  pasteHintObjects(): number[] | null {
    const p = this.pasteHint;
    if (!p || p.level !== this.level.number) return null;
    return findPasted((p.layer === 'l2' ? this.level.layer2Objects : this.level.objects) ?? [], p.objects);
  }
  // selects the hint's pasted objects; false when they are no longer in the open level
  selectPasteHint(): boolean {
    const p = this.pasteHint, uids = this.pasteHintObjects();
    if (!p || !uids) return false;
    if (this.mode !== p.layer) this.setMode(p.layer, uids);
    else { this.selection = new Set(uids); this.emit('change'); }
    return true;
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
    this.editTile(tile, bg ? 'bg' : 'fg');
  }
  // the Map16 tab on a tile of a target; an overworld tile drawn as on map `ow.map` at event progress `ow.progress`
  editTile(tile: number, target: Map16Target, ow?: { map: number; progress: number }): void {
    this.wsTile = tile;
    this.wsTarget = target;
    this.wsOw = ow;
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
