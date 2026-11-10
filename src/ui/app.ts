// Application state and editing actions.

import { makeProjectId } from '../core/projectid.ts';
import { Scheduler } from '../core/scheduler.ts';
import { ViewSettings } from '../core/viewsettings.ts';
import { Rom } from '../core/rom.ts';
import { OBJ_2D } from '../core/obj2d.ts';
import { LevelEmulator, type LevelRender, type LevelOverride, type Animated } from '../core/levelemu.ts';
import { LevelAnimSteps } from '../core/levelanimsteps.ts';
import {
  type Level, type LevelObject, type LevelSprite, type ScreenExit, loadLevel, spriteLoadOrder, serializeSprites, serializeLevelSprites, spriteId,
  isL1Vertical, hasLayer2Objects, hasObjects, SEC_HDR,
  nearestEntrance, encodeSecondaryHeader, mainSpot, sameSpot, placeMain, midwaySpot, nearestMidway, placeMidway, exitLandsAtMidway, isSized, SPRITE_MEMORY, levelRows, TIME_TABLE,
} from '../core/level.ts';
import { levelBgPointer } from '../core/levelheader.ts';
import { hex, hex2, spriteName } from '../core/names.ts';
import { objectTableKey, objectName, objectNameKey, setObjectName, namedPerTable, numberName } from '../core/objectnames.ts';
import { layerBoxes, boxAt } from '../core/objboxes.ts';
import { objectUserNames } from '../core/usernames.ts';
import { loadPixiProject, customSpriteList, type CustomSprite } from '../core/pixi.ts';
import { renderLevel, type LevelImages, composite, composeCells, patchLevel, patchFrame, animatedPixels, type PixelChanges, TileAnimation, ANIM_STEPS_PER_SECOND, MAX_ANIM_STEPS, type AnimStep } from '../core/render.ts';
import type { SpriteImage } from '../core/spritegfx.ts';
import { usedSpriteMemory, spriteMemSpec, lostSprites, missingSprites, type SpriteMemResult } from '../core/spritemem.ts';
import { DM16_EXT, levelGfx, levelExtGfx, customPalette, levelMusic } from '../core/patches.ts';
import { gfxSkipMask, gfxFilesHash } from '../core/gfxpages.ts';
import { flagBytes, usedFlags, isDm16, dm16Tiles } from '../core/cdm16.ts';
import { RenderQuery, type TileCut } from '../core/renderquery.ts';
import { PREFAB_EXT, listPrefabs, type Prefab } from '../core/prefabs.ts';
import { breakUpParts, replaced } from '../core/prefabsources.ts';
import { PasteCounter, findPasted, type PasteHint } from '../core/pastehint.ts';
import { SuggestRuns, suggestInput, type PrefabSuggestion, type SuggestRun } from '../core/prefabsuggest.ts';
import { SessionSuggestions } from '../core/suggestsession.ts';
import { deletePrefab, storePrefab, prefabObjectCount, replaceWithPrefab, type LevelPlaces, type LevelGroups, type PrefabGroup } from '../core/prefabplaces.ts';
import type { Package } from '../core/pkgreg.ts';
import { kvEntries, kvKeys, kvWrite, saveRom } from './storage.ts';
import { ResultCache, RomFingerprint, oldStoreKeys, type CacheEntry } from '../core/romdeps.ts';
import { bgFromWram, bgIndex, encodeBg } from '../core/bg.ts';
import { lt3Override, lt3Target, lt3Covers, layer3Map, layer3Word, layer3Index, blankLayer3Tile } from '../core/layer3map.ts';
import { layer3Geometry, type Layer3Geometry } from '../core/render.ts';
import { toast, log as logMsg, modalsOpen, onModalsChange } from './dom.ts';
import { musicPlayer } from './musicplayer.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { SecondaryEntrances, NO_FREE_ENTRANCE, entranceTables, entranceMarkers, type Marker } from '../core/entrances.ts';
import type { EditOptions } from '../core/romedit.ts';
import { type EditSession, type LevelEdit, type StepResult } from '../core/editsession.ts';
import { LevelModel, isBrushMode, type EditMode, type PickedItem, type Placement } from '../core/levelmodel.ts';
import { resizeObjectSize, sizedByte, withSizedByte, UNSIZED, type ObjKind, type ObjKinds, type KindLevel } from '../core/objkinds.ts';
import { sizeKey, sizeParts, partSizes, namedDrivers, ObjectBoxes, StepQueue, type Box, type Drivers, type SizeSpec } from '../core/objresize.ts';
import { type JumpArc } from '../core/jumparcs.ts';
import { scanKey, type ScanLevel, type ScanResult } from '../core/levelscan.ts';
import { cameraAtKey, type CameraReach, type CameraAt } from '../core/camerareach.ts';
import { MARIO_W, MARIO_H, type CameraBands } from '../core/camerabands.ts';
import { tideLines, type TideLines, type Layer3Kind } from '../core/layer3.ts';
import { type Layer2Motions } from '../core/l2scroll.ts';
import { variantOf, blockKey, collisionKey, type BlockProbe, type CollisionProbe, type RunStates, type SwitchState, SWITCH_STATES, SWITCH_TRIGGER } from '../core/blockprobe.ts';
import { SAVE_LANES, OW_LEFT_LANES, type ProbeReply, type ProbeBusyKey, type LearnLane, type SaveAsker } from '../core/probeprotocol.ts';
import { spriteJobs, spriteInput, layer3Spec, levelObjects, type SpriteInput } from '../core/learnspecs.ts';
import { ProbeClient, FAILED } from '../core/probeclient.ts';
import { messageRoutineInput, UNKNOWN_ROUTINE, type MessageRoutine } from '../core/messagedraw.ts';
import { ResultLearner } from '../core/learner.ts';
import { holds, perRomState, type Recorded } from '../core/romdeps.ts';
import { RomWatch, type Watch } from '../core/romwatch.ts';
import { thumbCanvas } from './thumbs.ts';
import { thumbsKey, thumbsInput, previewInput, objKey, type ObjSpec, type ObjThumb, type PlacementPreview } from '../core/objthumbs.ts';
import { levelInput, inputHash, editState } from '../core/inputs.ts';
import { map16Tile, bgTile } from '../core/ram.ts';
import { exanimTiles, exanimColors, exanimPeriod, readLevelList, readGlobalList } from '../core/exanim.ts';
import { usedTriggers, initTriggers, type TriggerView, type SlotRef } from '../core/extrigger.ts';
import { LevelUses, OpenLevelTiles, levelOverride, usedLevels, spriteUsage, isTilesetTile, type LevelTiles, type OpenTilesState, type OpenTilesAs, type SpriteUser } from '../core/levelusage.ts';
import { TILESETS, sharingTilesets } from '../core/tilesets.ts';
import { slipperyKey } from '../core/slippery.ts';
import { gameBgKey } from '../core/tilemove.ts';
import { type PathKind, type PathShapes, type LevelTileTest, levelTileTest } from '../core/owpaths.ts';
import type { RevealWalkSkips } from '../core/revealwalk.ts';
import { OW_EVENTS, type OwRender } from '../core/overworld.ts';
import type { OwTriggerSwitches } from '../core/owanimview.ts';
import { animationPref } from './motion.ts';
import type { Rect } from '../core/owevents.ts';
import type { OwSpriteView } from '../core/owsprites.ts';
import type { ProgressSave } from '../core/owprogress.ts';
import { canonicalProgress, type EventProgress } from '../core/eventset.ts';
import type { ExitEdge } from '../core/owexitedges.ts';
import type { WorldCheckLearned } from '../core/worldcheck.ts';
import type { Map16Target } from './gfx/target.ts';
import type { WsTarget } from './gfxworkspace.ts';

export { isBrushMode, type EditMode, type PickedItem, type Placement };
export interface Brush { w: number; h: number; tiles: number[] }
// a part of the placement preview (which is a picture, CONTEXT.md) in level pixels; img null: a sprite without an image (drawn as its tile)
export interface PreviewPart { x: number; y: number; img: HTMLCanvasElement | null }

type Listener = () => void;

// what the busy indicator shows: the probes, their tasks and learn lanes, the animations, the wait for the jump arcs
export type BusyKey = ProbeBusyKey | 'anim' | 'arcs-wait';

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
  | 'probe-progress' // one of the asked or prefetched probes is done (more may follow)
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
  | 'animation' // View → "Animation" was switched (setAnimation)
  | 'prefabs' // the prefab table changed
  | 'object-names' // the user's object names changed (a rename, its undo or redo), or an object table became known
  | 'slippery' // the entrance actions that make a level slippery are known (App.slipperyActions)
  | 'paste-hint' // App.pasteHint changed
  | 'prefab-suggestions' // App.prefabSuggestions changed
  | 'bgtile' // the BG or layer 3 brush changed (picked from the level)
  | 'reveal' // the level view scrolls to App.reveal
  | 'zoom' // the level view's zoom changed
  | 'busy' // background work (setBusy), a modal or the music player changed
  | 'open-gfx' // the graphics workspace opens on App.wsGfx
  | 'open-map16' // the graphics workspace opens on the Map16 tab
  | 'import-gfx' // the graphics workspace imports App.gfxImport
  | 'messages' // the message panel opens on App.messages (null: it closes)
  | 'message-routine'; // whether the game draws the editor's messages is known (App.messageRoutine)

// the hint to save a paste as prefab (pastehint.ts): the paste's objects as placed in level, layer
export type PasteHintAt = PasteHint & { level: number; layer: 'l1' | 'l2'; objects: LevelObject[] };

// IndexedDB keys of the result cache: its name and version (bump when result formats change or old results may be
// wrong: 4 keeps several inputs per key)
const CACHE_NAME = 'rc', CACHE_VERSION = 4, CACHE_PREFIX = `${CACHE_NAME}${CACHE_VERSION}:`;
// stored results whose keys are no longer used (s2.: sprite probes per tileset, now once for all, blockprobe.ts spriteKey)
const retiredKey = (stored: string) => stored.startsWith(`${CACHE_PREFIX}s2.`);
const SWEEP_SLICE = 64; // stored results checked against the ROM per background slice (ResultCache.sweep)


// result of the sprite memory check (see App.checkSpriteMem); gen: the edit session's levelGen when it started
export interface SpriteMemState { key: string; level: number; mem: number; gen: number; conflicts: Set<number>; missing: Set<number>; suggestion: number | null }

export type { Marker };

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
  render!: LevelRender;
  // what the render answers about its tiles (renderquery.ts): built with it
  query!: RenderQuery;
  images!: LevelImages;
  compositeImg!: Uint32Array;
  // the level editing model (levelmodel.ts): the edit mode (changed through setMode, which checks and shows it),
  // selection, picked item, clipboard and the object/sprite edits
  readonly model: LevelModel = new LevelModel({
    rom: () => this.rom,
    level: () => this.level,
    edit: (f, rerender) => this.editLevel(f, rerender),
    beginEdit: () => this.beginLevelEdit(),
    selectionChanged: () => this.emit('change'),
    geometry: () => ({ l1: this.images.geom1, l2: this.images.geom2 ?? null, vertical: this.vertical }),
    switchMode: (m) => this.setMode(m),
  });
  // BG mode brush: a w×h block of BG Map16 tiles (row-major), picked from the picker sheet or the level
  bgBrush: Brush = { w: 1, h: 1, tiles: [0] };
  l3Brush: Brush = { w: 1, h: 1, tiles: [0] }; // layer 3 tilemap words
  // zoom, what is shown, the game view frame and the view-only game state (viewsettings.ts)
  readonly view = new ViewSettings();
  wsTile = 0; // Map16 tile for 'open-map16' (opens the graphics workspace there)
  wsTarget: Map16Target = 'fg'; // what wsTile is a tile of
  wsAt: WsTarget | undefined = undefined; // for an overworld tile: the submap and event progress to draw it as on
  gfxImport: { file: File; into: Package | null } | null = null; // for 'import-gfx'
  wsGfx: number | null = null; // GFX file for 'open-gfx'
  private romTimer = 0;
  // the views' watches of the ROM bytes they read (romwatch.ts): told on a ROM change that changed one of them; while
  // one is held (a stroke being drawn) the debounced re-emulation waits (it would stall the stroke)
  private readonly romWatch: RomWatch;
  private quietUntil = 0; // and after a stroke until then (the next one often follows quickly)
  private persistTimer = 0;
  // the arrangements of Direct Map16 objects pasted in the session (pastehint.ts); the hint to save the last
  // paste (its objects as placed in level/layer) as prefab, until it is dismissed or another level is opened
  private pastes = new PasteCounter();
  pasteHint: PasteHintAt | null = null;
  // repeated arrangements of Direct Map16 objects across the levels (prefabsuggest.ts), found in the background
  // a while after the last change; null while not known yet
  // the list shown and whether it is current, wired to the edit session (suggestsession.ts)
  private suggestions: SessionSuggestions;
  get prefabSuggestions(): PrefabSuggestion[] | null { return this.suggestions.list.list; }
  // they are of the levels and the ROM as they are now (their places can be taken)
  get suggestionsCurrent(): boolean { return this.suggestions.list.current; }
  private suggestTimer = 0;
  private suggestRun = 0;
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
  // the emulated results needed at once, on the main thread: the tilesets' pointers only (tilesetPointerTable says
  // why). The others, level loads too, are learned in the probe worker (probeclient.ts), without one by its host on
  // the main thread.
  private learner: ResultLearner;
  private cacheTimer = 0;
  private closed = false; // project closed: nothing is written to the browser any more
  reveal = { x: 0, y: 0 }; // pixel the level view scrolls to on 'reveal'
  // tile/palette animation: frames stored as pixel diffs against the static composite (base), one per step
  // steps: the steps of the render (null: no animation), emulated in the background, carried over to a new render
  // while what they read is unchanged (levelanimsteps.ts); phase: the step shown (-1 none yet), kept while the steps
  // are; ready: the frames are those of the composite shown
  // paused: the next slice of building the frames, held while a level edit is open (dragging, #452: each drag step
  // would emulate steps that don't carry over to the next one); it goes on once the edit ended
  anim = { gen: 0, steps: null as LevelAnimSteps | null, base: null as Uint32Array | null,
    frames: [] as PixelChanges[], phase: -1, timer: 0, ready: false, paused: null as (() => void) | null };

  constructor(rom: Rom, name: string) {
    this.rom = rom;
    this.romName = name;
    this.romWatch = new RomWatch(rom);
    // made now, outside any ROM edit (undo never takes it away), and stored with the ROM soon
    if (makeProjectId(rom)) this.persistTimer = window.setTimeout(() => { this.persistTimer = 0; this.persist(); }, 1000);
    this.view.show.anim = animationPref.get();
    this.emu = new LevelEmulator(rom);
    this.emu.skipMask = this.gfxSkipMask;
    // the level is loaded anew for every edit and drag step: frames that read the same are taken over (#448)
    this.emu.reuseLoads = true;
    this.emu.boot();
    onModalsChange(() => { this.scheduler.resume(); this.emit('busy'); });
    // sprite images: learned again when what they depend on changed (the learner decides)
    this.on('render', () => this.ensureSpriteImages());
    this.on('rom-change', () => this.ensureSpriteImages());
    this.on('level', () => (this.objectNamesSeen = JSON.stringify(objectUserNames(this.rom)))); // (another ROM, too)
    this.on('rom-change', () => {
      const names = JSON.stringify(objectUserNames(this.rom));
      if (names !== this.objectNamesSeen) { this.objectNamesSeen = names; this.emit('object-names'); }
    });
    musicPlayer.onChange(() => { this.scheduler.resume(); this.emit('busy'); });
    this.results = new ResultCache(new RomFingerprint(rom));
    // level edits and ROM edits (romEdit: one undo step, all or nothing, the follow-ups below), with the prefab
    // suggestions checked on their changes; the levels' arrangements and places of earlier runs kept (only changed
    // levels are taken apart again)
    this.suggestions = new SessionSuggestions(rom, new SuggestRuns(this.results.fp), {
      changed: (rerender) => this.levelChanged(rerender),
      saved: (log, silent) => this.levelSaved(log, silent),
      saveFailed: (e) => toast(`Save failed: ${e}`, 'error'),
      written: () => this.romChanged(),
      editEnded: () => this.resumeAnimation(),
      // (each told when the edit changed a ROM byte its read read)
      followUps: [
        // the open level as stored (a patch rewrote its sprite data, a package its sample …): loaded again (not when it
        // reads the same: loading it again clears its undo history)
        { read: (r) => (this.level ? storedLevel(r, this.level.number) : null), same: (a, b) => sameLevel(a, b), changed: () => this.reloadLevel() },
        // its graphics slots, own palette or music: shown at once
        { read: (r) => { if (this.level) readLevelHeader(r, this.level.number); }, changed: () => { this.flushRomChange(); this.emit('level-header'); } },
        { read: (r) => attempt(() => listPrefabs(r)), changed: () => { this.flushRomChange(); this.emit('prefabs'); this.emit('change'); } },
        // the secondary entrances (markers, the exit panel): shown at once, also after undo/redo
        { read: (r) => entranceTables(r), changed: () => this.emit('change') },
      ],
    }, {
      start: () => this.startSuggestRun(),
      stop: () => this.stopSuggestRun(),
      changed: () => this.emit('prefab-suggestions'),
    });
    this.edits = this.suggestions.edits;
    this.entrances = new SecondaryEntrances(this.edits);
    this.cacheReady = kvEntries<CacheEntry | string[]>(CACHE_PREFIX)
      .then((e) => this.results.load(e.filter(([k]) => !retiredKey(k)).map(([k, v]) => [k.slice(CACHE_PREFIX.length), v])))
      .catch((e) => console.error(e));
    // the rows of earlier versions of the result cache and the retired keys go; the loaded results are checked in the background
    kvKeys(CACHE_NAME).then((k) => kvWrite([], [...oldStoreKeys(k, CACHE_NAME, CACHE_VERSION), ...k.filter(retiredKey)])).catch((e) => console.error(e));
    void this.cacheReady.then(() => this.sweepResults());
    this.learner = new ResultLearner({ rom, results: this.results, main: this.emu });
    this.probes = new ProbeClient({
      results: this.results,
      cacheReady: this.cacheReady,
      rom: () => this.rom,
      tileset: () => this.level.header.tileset,
      kindLevel: () => {
        const lv = this.level, first = levelObjects(lv);
        return { level: { number: lv.number, header: lv.header }, layer2Pointer: levelBgPointer(this.rom, lv), first };
      },
      level: () => this.level.number,
      connect: (reply, failed) => {
        const w = new Worker(new URL('./probeworker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ProbeReply>) => reply(e.data);
        w.onerror = (e) => { console.error(e); w.terminate(); failed(); };
        return (m) => w.postMessage(m, m.type === 'rom' ? [m.data.buffer] : m.type === 'edit' ? m.edits.map(([, b]) => b.buffer) : []);
      },
      later: (key, step) => this.scheduler.later(key, step),
      soon: (step) => setTimeout(step, 0),
      setBusy: (key, label) => this.setBusy(key, label),
      ready: () => this.emit('probes'),
      progress: () => this.emit('probe-progress'),
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
    const step = () => { if (this.results.sweep(SWEEP_SLICE)) this.scheduler.later('result-sweep', step); };
    this.scheduler.later('result-sweep', step);
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
  busy = new Map<BusyKey, string>();
  setBusy(key: BusyKey, label: string | null): void {
    if (label === null ? !this.busy.delete(key) : this.busy.get(key) === label) return;
    if (label !== null) this.busy.set(key, label);
    this.emit('busy');
  }

  // background work (scheduler.ts): held while a dialog is open or music plays
  readonly scheduler = new Scheduler(() => modalsOpen() > 0 || musicPlayer.holdsBackground);

  // ------------- level loading / rendering -------------
  // opens level n (the open one saved first, or its unsaved changes dropped with discard)
  openLevel(n: number, discard = false): void {
    // (the prefab suggestions checked then: the open level as edited is part of them)
    this.suggestions.open(n, discard, () => {
      this.model.selection.clear();
      this.exitScreen = 0;
      this.exitMarker = null;
      if (this.layerGone()) this.model.mode = 'l1';
      this.spriteMem = this.spriteMemBase = null;
      this.refresh();
      this.emit('level');
      logMsg(`Level ${hex(n, 3)} opened`);
      this.scheduleSpriteMem();
      this.probes.refreshPrefetch(); // (what the panels shown want, in the level's tileset; none shown: nothing)
    });
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
      switchPalaces: this.view.switches.palaces,
      onOffSwitch: this.view.switches.onOff,
      cdm16Flags: flagBytes(this.view.cdm16),
      // sub-level loads keep the old timer: the level's header time, as entered from the overworld
      timer: this.rom.r8(TIME_TABLE + lv.header.time),
      exTriggers: this.view.exTriggers,
      secondaryHeader: encodeSecondaryHeader(lv.secondary),
    };
  }

  // What every result learned from the level as edited depends on outside the ROM (inputs.ts): its data and the
  // view settings, as a load is given them (ov); the learner's input for such results
  levelInput(ov = this.buildOverrides()): ReturnType<typeof levelInput> {
    return levelInput(this.level.number, ov);
  }

  // what the render was made from: its inputs, the ROM generation and the ROM bytes it read
  private rendered: (Recorded<void> & { key: string }) | null = null;
  // what the level image was drawn for: the level's layout and the ROM generation (an edit's load of the same is drawn
  // only where it looks different: patchLevel)
  private drawnFor: { level: number; mode: number; screens: number; rows: number; gen: number } | null = null;
  private composedLook = ''; // the layers shown and the ghosting the composite was made with (compose: it follows the edit mode)

  // the level emulated and drawn anew – unless its inputs and the ROM bytes the last render read are unchanged
  // (a ROM edit elsewhere: the overworld, another level's data). The edit mode is no input: only the composite's
  // ghosting depends on it (compose), made anew when that changed. An edit's load (the same level's layout, the same
  // ROM) is drawn only in the cells that look different from the last one (#445: found by comparing the two loads), the
  // composite and the animation's frames there too
  refresh(): void {
    const lv = this.level, ov = this.buildOverrides();
    const key = inputHash({ level: lv.number, ov, header: lv.header, secondary: lv.secondary, show: this.view.show });
    const was = this.rendered;
    if (was?.key === key && holds(this.rom, was)) {
      if (this.composedLook !== this.look()) this.recomposite();
      this.scheduleScan();
      this.updateGameViewCamera(ov);
      return;
    }
    const prev = this.drawnFor, prevRender = this.render, prevImages = this.images;
    const drawn = { level: lv.number, mode: lv.header.mode, screens: lv.header.screens, rows: levelRows(lv.secondary), gen: this.rom.gen };
    let cells: Uint8Array | null = null, carried = false;
    this.rendered = { key, ...this.emu.recordAll(() => {
      const r = this.emu.load(lv.number, ov);
      this.renderError = r.ok ? null : r.error ?? 'Error';
      // as many steps as the level's own animations take to repeat (the game's repeat after 8), emulated in
      // the background (startAnimation) – or the last render's, carried over while nothing they read changed (an
      // object moved: no emulation, the phase kept)
      const count = this.view.show.anim && r.ok ? exanimPeriod([readLevelList(this.rom, lv.number), readGlobalList(this.rom)], MAX_ANIM_STEPS, 8) : 0;
      const kept = count ? this.anim.steps?.carry(this.emu, count) ?? null : null;
      if (!kept) this.anim.phase = -1;
      carried = !!kept;
      this.anim.steps = count ? kept ?? new LevelAnimSteps(this.emu, count) : null;
      const same = !!prev && !!prevRender?.ok && r.ok && prev.level === drawn.level && prev.mode === drawn.mode
        && prev.screens === drawn.screens && prev.rows === drawn.rows && prev.gen === drawn.gen;
      const p = same ? patchLevel(this.rom, prevRender, prevImages, r) : null;
      this.render = r;
      cells = p?.cells ?? null;
      this.images = p?.images ?? renderLevel(this.rom, r, lv.header.mode, lv.header.screens, drawn.rows);
      this.drawnFor = drawn;
    }) };
    if (this.anim.steps) this.rendered.reads.add(this.anim.steps.reads); // (the steps carried over)
    // picker thumbnails are transparent: shown on the level's backdrop as in the game
    const c = this.images.backdrop;
    document.documentElement.style.setProperty('--level-backdrop', `rgb(${c & 0xff},${(c >> 8) & 0xff},${(c >> 16) & 0xff})`);
    // (the composite without the animation patched in place where the level image was)
    const base = this.anim.base, look = this.look(), patched = !!cells && !!base && this.composedLook === look;
    if (patched) this.composeInto(base!, cells!);
    this.compositeImg = patched ? base! : this.compose();
    this.composedLook = look;
    this.query = new RenderQuery(this.render, this.images.geom1, this.images.geom2);
    this.startAnimation(patched && carried ? cells : null);
    this.emit('render');
    this.scheduleScan();
    this.updateGameViewCamera(ov);
  }

  recomposite(): void {
    this.compositeImg = this.compose();
    this.composedLook = this.look();
    this.startAnimation();
    this.emit('render');
  }

  // the object layer not being edited is ghosted (only in levels with two object layers), editing layer 3 both
  compose(images = this.images): Uint32Array {
    return composite(images, this.view.show.layer1, this.view.show.layer2, this.ghost(), this.view.show.layer3);
  }
  // a composite of the level image composed anew in its cells marked (patchLevel's)
  private composeInto(out: Uint32Array, cells: Uint8Array): void {
    composeCells(this.images, out, cells, this.view.show.layer1, this.view.show.layer2, this.ghost(), this.view.show.layer3);
  }
  private look(): string {
    const s = this.view.show;
    return `${s.layer1} ${s.layer2} ${s.layer3} ${this.ghost()}`;
  }
  private ghost(): number {
    const m = this.model.mode;
    return !this.view.show.ghost ? 0 : m === 'l3' ? 3 : m === 'bg' ? 1 : this.level.layer2Objects ? (m === 'l1' ? 2 : m === 'l2' ? 1 : 0) : 0;
  }

  // the animation's frames for the composite shown, built in the background from its steps (those not yet emulated
  // emulated then: "Animations i/n"), then cycled (8 game frames each) – on from the step shown when the steps are
  // the same as before (a recomposite, an edit the steps carry over): its frame built first and shown at once, the
  // level as the pickers (animStep) while the others are built. cells: the composite was composed anew there (an edit's
  // load, the steps carried over): the frames built before are patched there (those built)
  startAnimation(cells: Uint8Array | null = null): void {
    const a = this.anim, steps = a.steps;
    const gen = ++a.gen;
    const before = cells ? a.frames : [];
    a.paused = null;
    a.frames = [];
    a.ready = false;
    a.base = this.compositeImg;
    if (!steps?.count) { a.phase = -1; this.stopAnimation(); this.setBusy('anim', null); return; }
    const base = a.base, lv = this.level, made = steps.steps;
    const busy = () => this.setBusy('anim', steps.done ? null : `Animations ${made.length + 1}/${steps.count}`);
    // (a step is shown only once all are made: phase >= 0 means all are)
    const first = a.phase >= 0 && made.length ? a.phase % made.length : 0;
    if (a.phase >= 0) a.phase = made.length ? first : -1;
    let i = 0;
    const step = () => {
      if (gen !== a.gen) return;
      if (i === made.length && !steps.done) {
        // (not while dragging: the steps wait for the edit's end)
        if (this.edits.editing) { a.paused = step; this.setBusy('anim', null); return; }
        // the next step emulated, what it reads counting for the render (refresh)
        steps.next();
        this.rendered?.reads.add(steps.reads);
      }
      if (i < made.length) {
        const n = (first + i) % made.length, s = made[n];
        // only the cells the step changes drawn anew; all of them when it changes every cell. After an edit only those
        // in the cells composed anew
        const look = (cell: LevelImages) => this.compose(cell), old = before[n];
        const inside = old && cells ? animatedPixels(this.rom, this.render, this.images, base, s.vram, s.cgram, look, cells) : null;
        let f = inside ? patchFrame(old, inside, cells!, this.images.width) : animatedPixels(this.rom, this.render, this.images, base, s.vram, s.cgram, look);
        if (!f) {
          const li = renderLevel(this.rom, { ...this.render, vram: s.vram, cgram: s.cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
          const img = this.compose(li);
          const idx: number[] = [];
          for (let k = 0; k < img.length; k++) if (img[k] !== base[k]) idx.push(k);
          const ix = Uint32Array.from(idx);
          f = { idx: ix, val: ix.map((k) => img[k]) };
        }
        a.frames[n] = f;
        if (n === a.phase) {
          const img = base.slice();
          for (let j = 0; j < f.idx.length; j++) img[f.idx[j]] = f.val[j];
          this.compositeImg = img;
          this.emit('anim-frame');
        }
        i++;
      }
      busy();
      if (i < made.length || !steps.done) { this.scheduler.later('anim', step); return; }
      a.ready = true;
      if (!a.frames.length) { a.phase = -1; this.stopAnimation(); return; }
      if (!a.timer) a.timer = window.setInterval(() => this.animTick(), 1000 / ANIM_STEPS_PER_SECOND);
    };
    busy();
    this.scheduler.later('anim', step);
  }

  // the animation's steps emulated on after a level edit ended (dragging: paused in startAnimation)
  private resumeAnimation(): void {
    const a = this.anim, step = a.paused;
    a.paused = null;
    if (step) this.scheduler.later('anim', step);
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
    return this.view.show.anim && a.timer && a.phase >= 0 ? a.steps?.steps[a.phase] ?? null : null;
  }

  // the animation's steps on canvases of the level's Map16 tiles (the pickers'), for the render shown
  private tileAnim: { r: LevelRender; anim: TileAnimation } | null = null;
  tileAnimation(): TileAnimation {
    if (this.tileAnim?.r !== this.render) this.tileAnim = { r: this.render, anim: new TileAnimation(this.rom, this.render) };
    return this.tileAnim.anim;
  }

  animTick(): void {
    const a = this.anim;
    if (!a.ready || !a.frames.length || !a.base) return;
    if (!this.view.show.anim) { this.stopAnimation(); return; }
    if (this.scheduler.held()) return;
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
  // (of the open level; of another one for its image, levelimages.ts)
  markers(lv: Level = this.level): Marker[] {
    return entranceMarkers(this.rom, lv, this.entrances.inLevel(lv.number));
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
    if (m) this.model.selection.clear();
    this.emit('change');
  }

  // mode 'exit': chooses a screen (and its exit)
  selectScreen(scr: number): void {
    const ex = this.level.exits.find((x) => x.screen === scr);
    this.model.selection = new Set(ex ? [ex.uid] : []);
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
    this.model.mode = 'exit';
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
    this.model.mode = 'exit';
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
  // learnspecs.ts spriteJobs, with the ids the picker lists
  spriteJobs(lv: Level = this.level): ReturnType<typeof spriteJobs> {
    const nums = [...Array.from({ length: 0xe7 }, (_, i) => i), ...this.customSprites().map((c) => c.id)]; // as listed in the picker
    return spriteJobs(lv, nums, this.spriteInput(lv));
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

  // What sprite images depend on besides the ROM bytes they read (learnspecs.ts spriteInput; the files' hash kept)
  private spriteInput(lv: Level): SpriteInput {
    const m = this.spriteFiles;
    return spriteInput(this.rom, lv, this.customSprites().map((c) => c.id), (files) => {
      if (m.gen !== this.rom.gen || m.files !== files.join()) { m.gen = this.rom.gen; m.files = files.join(); m.hash = gfxFilesHash(this.rom, files); }
      return m.hash;
    });
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
  private gfxMask = perRomState(gfxSkipMask);
  readonly gfxSkipMask = (): Uint8Array | null => this.gfxMask(this.rom);

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

  spriteCanvas(img: SpriteImage): HTMLCanvasElement {
    let c = this.canvases.get(img);
    if (!c) this.canvases.set(img, (c = spriteCanvas(img)));
    return c;
  }

  // ------------- sprite memory (see spritemem.ts) -------------
  // sprites drawn incompletely because their OAM range is too small, sprites left out because no slot is free for
  // them when they load, and a sprite memory value that shows all; checked in the probe worker after every change
  // (only the groups of sprites it changed: the others' results are kept there)
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
    const lv = this.level, gen = this.edits.levelGen;
    const { key, input, checked, level } = this.spriteMemCheck(lv), mem = level.mem;
    if (this.spriteMem?.key === checked) return;
    const run = ++this.spriteMemRun;
    const done = (r: SpriteMemResult) => {
      if (run !== this.spriteMemRun || this.level !== lv) return;
      const cur = { key: checked, level: lv.number, mem, gen, conflicts: new Set(lostSprites(level, r)), missing: new Set(missingSprites(level, r)), suggestion: r.suggestion };
      this.spriteMem = cur;
      this.emit('sprite-mem');
      if (gen !== this.edits.levelGen) return; // edited meanwhile: checked again
      const base = this.spriteMemBase;
      this.spriteMemBase = cur;
      if (base) this.autoSpriteMem(base, cur);
    };
    const stored = this.probes.learn<SpriteMemResult>(key, { kind: 'spriteMem', level }, { input, lane: 'spritemem', replace: true, label: 'Checking sprite memory', done });
    if (stored) done(stored);
  }

  // the sprite memory check of a level as edited (spritemem.ts spriteMemSpec), with the values the ROM uses
  spriteMemCheck(lv: Level): ReturnType<typeof spriteMemSpec> {
    if (this.usedMem.gen !== this.rom.gen) this.usedMem = { gen: this.rom.gen, list: usedSpriteMemory(this.rom) };
    return spriteMemSpec(lv, this.usedMem.list);
  }

  // An edit (committed since the previous check, same sprite memory) that makes further sprites
  // incomplete or missing sets the suggested value, as part of that edit's undo step. A value chosen by hand
  // stays as long as edits add no new incomplete or missing sprites.
  private autoSpriteMem(prev: SpriteMemState, cur: SpriteMemState): void {
    if (prev.level !== cur.level || prev.mem !== cur.mem || prev.gen === cur.gen || cur.suggestion === null) return;
    const added = (now: Set<number>, before: Set<number>) => [...now].some((u) => !before.has(u));
    if (!added(cur.conflicts, prev.conflicts) && !added(cur.missing, prev.missing)) return;
    if (this.edits.lastStep !== 'level') return;
    this.level.spriteHeader = (this.level.spriteHeader & 0xc0) | cur.suggestion;
    this.changed();
    toast(`Sprite memory set to ${hex(cur.suggestion, 2)} so all sprites appear and are shown completely (Ctrl+Z undoes it).`);
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
  // grab area = every tile the object wrote (same as its outline), topmost first
  objectAt(tx: number, ty: number, l2 = this.model.mode === 'l2'): LevelObject | null {
    const g = l2 ? this.images.geom2 : this.images.geom1;
    const objs = l2 ? this.level.layer2Objects : this.level.objects;
    if (!g || !objs) return null;
    // the boxes of objects that draw nothing lie on top
    const box = boxAt(this.boxedObjects(l2), tx, ty);
    if (box) return box;
    if (g.addr(tx, ty) >= 0) {
      const k = this.query.ownerAt(tx, ty, l2);
      if (k >= 0 && ((k & 0x8000) !== 0) === l2) {
        const o = objs[k & 0x7fff];
        if (o) return o;
      }
      // tiles later overwritten by another object still belong to this one
      for (let i = objs.length - 1; i >= 0; i--) if (this.query.wrote(l2, i, tx, ty)) return objs[i];
    }
    // a hidden conditional Direct Map16 object's tiles
    const at = (ty << 16) | tx;
    for (let i = objs.length - 1; i >= 0; i--) if (isDm16(objs[i]) && objs[i].cond && dm16Tiles(objs[i]).includes(at)) return objs[i];
    return null;
  }

  // tiles covered by an object: array of packed (y<<16|x)
  objectTiles(o: LevelObject): number[] {
    const objs = this.model.currentObjects();
    return this.query.objectTiles(this.model.mode === 'l2', o, objs.indexOf(o));
  }

  // the objects of the mode's layer with a tile (objectTiles) in the tile rectangle x0..x1, y0..y1
  objectsInBox(x0: number, y0: number, x1: number, y1: number): LevelObject[] {
    return this.query.objectsInBox(this.model.mode === 'l2', this.model.currentObjects(), x0, y0, x1, y1);
  }

  // whether the object wrote a tile in the level's load
  objectDrawn(o: LevelObject): boolean {
    return this.query.drawn(this.model.mode === 'l2', this.model.currentObjects().indexOf(o));
  }

  // the objects of layer 1 (or 2) that wrote no tile in the level's load: shown as boxes (objboxes.ts)
  boxedObjects(l2 = this.model.mode === 'l2'): LevelObject[] {
    return layerBoxes(this.level, this.render.touched, l2);
  }

  // what a box's object is called, null when it has no name but its number (object 2D's custom numbers have none)
  boxName(o: LevelObject): string | null {
    if (o.extension) return null;
    const n = this.objectName(o.num, o.ext);
    return n === numberName(o.num, o.ext) ? null : n;
  }

  // Map16 tile numbers an object left in the level (tiles overwritten by later objects excluded)
  objectMap16(o: LevelObject): number[] {
    return this.query.objectMap16(this.model.mode === 'l2', this.model.currentObjects().indexOf(o));
  }

  // finished probes only (nothing is queued)
  cachedBlock(tile: number): BlockProbe | undefined {
    return this.results.get(blockKey(this.level.header.tileset, tile));
  }
  // the switch states the view sets (the probes' order: blue P-switch, silver P-switch, OFF)
  viewSwitches(): SwitchState[] {
    return SWITCH_STATES.filter((sw) => (sw === 'off' ? this.view.switches.onOff : this.view.exTriggers.game.has(SWITCH_TRIGGER[sw])));
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
    if (this.romWatch.held) { this.scheduleScan(); return; }
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
    this.probes.requestScan(run, key, this.scanLevel(lv, ov, this.images), (r) => { if (r) done(r); });
  }

  // a level as edited (ov: its load's overrides, images: its load's) to be played in the probe worker
  scanLevel(lv: Level, ov: LevelOverride, images: Pick<LevelImages, 'width' | 'height'>): ScanLevel {
    return { number: lv.number, ov, vertical: isL1Vertical(this.rom, lv.header.mode), width: images.width, height: images.height };
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
    this.view.gameViewMario = { x, y, key: null }; // (not asked for yet)
    this.updateGameViewCamera();
  }

  // the camera at Mario's place (kept inside the level) in the level as edited (ov), from the result cache or
  // played in the probe worker; asked again when the cache dropped it (the ROM bytes it read changed)
  updateGameViewCamera(ov?: LevelOverride): void {
    const m = this.view.gameViewMario, im = this.images;
    if (!m || !im || !this.view.show.gameView) return;
    m.x = Math.max(0, Math.min(im.width - MARIO_W, m.x)); m.y = Math.max(0, Math.min(im.height - MARIO_H, m.y));
    ov ??= this.buildOverrides();
    const key = cameraAtKey(this.level.number, ov, m.x, m.y);
    if (m.key === key && (m.camera === undefined || m.camera === null || this.results.get(key) !== undefined)) return;
    m.key = key;
    m.camera = this.results.get<CameraAt>(key);
    if (m.camera === undefined) this.probes.requestCamera(++this.cameraRun, key, this.scanLevel(this.level, ov, this.images), m.x, m.y, (r) => {
      if (this.view.gameViewMario !== m || m.key !== key) return;
      m.camera = r;
      this.emit('game-view');
    });
    this.emit('game-view');
  }

  // What the four layer 3 settings do in a tileset (see layer3.ts): the level as edited is loaded
  // with each of them in the probe worker; kept per tileset while the level as edited and the ROM it read
  // are unchanged. null while that runs, then `done` is called (the latest tileset asked for only).
  layer3Kinds(tileset: number, done: () => void): Layer3Kind[] | null {
    const j = layer3Spec(this.rom, this.level, this.buildOverrides(), tileset);
    return this.probes.learn<Layer3Kind[]>(j.key, j.job, { input: j.input, lane: 'layer3', replace: true, label: 'Layer 3 settings', done }) ?? null;
  }

  // Water line of a layer 3 tide in level pixels (layer3.ts tideLines), its range once the level scan measured it
  tide(): TideLines | null {
    const im = this.images, range = this.levelScan?.level === this.level.number ? this.levelScan.result.tide ?? null : null;
    if (this.tideCache?.images === im && this.tideCache.range === range) return this.tideCache.value;
    const value = tideLines(this.render, im.layer3, im.width, range);
    this.tideCache = { images: im, range, value };
    return value;
  }
  private tideCache: { images: LevelImages; range: unknown; value: TideLines | null } | null = null;

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
  // previous ones of this ROM state count as missing while its tiles as edited are learned, and its tiles as saved
  // while they are learned in place of those that could not be); open: whether the open level's are known, learned,
  // or could not be learned; as: which tiles stand for them – as edited, the last known, as saved, none (OpenLevelTiles)
  levelTiles(): { levels: LevelTiles[]; pending: number; open: OpenTilesState; as: OpenTilesAs } {
    const idx = this.usesIndex ??= new LevelUses(this.rom, this.results);
    // the open level's (kept in memory with the level as edited as their input); a level with conditional
    // Direct Map16 objects in both of their states, whatever the view's flags
    const lv = this.level, edited = editState(lv, this.buildOverrides());
    const here = this.probes.learnOrFailed<LevelTiles>(`lt:${lv.number}`, { kind: 'levelTiles', state: edited },
      { input: edited.id, lane: 'lt', replace: true, label: 'Uses in this level', done: this.usesLearned, failed: this.usesLearned });
    const failed = here === FAILED;
    const { tiles, state, as } = this.openTiles.shown(lv.number, this.rom.gen, failed ? undefined : here, failed, () => idx.tiles(lv.number));
    const levels = tiles ? [tiles] : [], missing: number[] = [];
    // (failed, and the level as saved not known yet: learned with the others)
    if (failed && state === 'pending') missing.push(lv.number);
    for (const n of usedLevels(this.rom)) {
      if (n === lv.number) continue;
      const t = idx.tiles(n);
      if (t) levels.push(t); else missing.push(n);
    }
    if (missing.length) this.learnLevelTiles(missing);
    return { levels, pending: missing.length + (state === 'pending' && !failed ? 1 : 0), open: state, as };
  }
  private openTiles = new OpenLevelTiles(); // the open level's tiles, the last known while they are learned
  // A level's BG tilemap from its load (the open one as shown), where it is the game's own (tilemove.ts): another
  // level's learned in the probe worker and kept in the result cache, undefined while that runs (then done is called;
  // null: the load failed or was dropped). Urgent: the remap dialog waits for it.
  loadedBg(n: number, done: (bg: Uint16Array | null) => void): Uint16Array | null | undefined {
    if (n === this.level.number) return bgFromWram(this.render.wram);
    const r = this.probes.learnOrFailed<Uint16Array>(gameBgKey(n), { kind: 'gameBg', level: n },
      { lane: 'gamebg', urgent: true, label: (k) => `Game BGs (${k})`, done, failed: () => done(null), dropped: () => done(null) });
    return r === FAILED ? null : r;
  }
  // the game BG loads asked for are not wanted any more (the dialog closed)
  dropLoadedBgs(): void {
    this.probes.unlearn('gamebg');
  }
  // the tilesets in which FG Map16 tile t is the open level's tile (all for the standard tiles): the
  // pointers each tileset loads (tilesets.ts), learned once and kept in the result cache
  tilesetsOf(t: number): number[] {
    if (!isTilesetTile(t)) return Array.from({ length: TILESETS }, (_, i) => i);
    return sharingTilesets(this.tilesetPointerTable(), this.level.header.tileset, t);
  }
  // Per tileset the pointers of FG Map16 tiles 000-1FF (tilesets.ts), learned once and kept in the result cache. Learned
  // on the main thread when not stored: they are needed at once (what a tileset tile applies to, a package's tiles) and
  // so is what they are part of on both threads (the display data's skip mask, jobrunner.ts); the probe worker learns
  // them for its own first jobs and hands them back, so here they are mostly stored already.
  tilesetPointerTable(): number[][] {
    return this.learner.tilesetPointers();
  }
  // the entrance actions that make a level slippery (slippery.ts), learned in the probe worker once and kept in the
  // result cache: undefined while that runs ('slippery' when known; none when it failed)
  slipperyActions(): number[] | undefined {
    const r = this.probes.learnOrFailed<number[]>(slipperyKey, { kind: 'slippery' }, { lane: 'slippery', urgent: true, label: 'Slippery entrances', done: this.slipperyLearned, failed: this.slipperyLearned });
    return r === FAILED ? [] : r;
  }
  private slipperyLearned = () => this.emit('slippery');
  // what Mario does on each overworld layer 1 tile 00–FF (owpaths.ts): learned in the probe worker once and kept in
  // the result cache while the game's code is unchanged; null while that runs, then `done` is called
  pathKinds(done: () => void): PathKind[] | null {
    return this.probes.learn<PathKind[]>('owpk1', { kind: 'pathKinds' }, { lane: 'owpk1', label: 'Path tiles', done }) ?? null;
  }
  // the exits whose first pass skips the reveal walk, per translevel and with the base event "No event" (revealwalk.ts):
  // learned in the probe worker once and kept in the result cache while the game's code is unchanged; null while that
  // runs, then `done` is called
  revealWalkSkips(done: () => void): RevealWalkSkips | null {
    return this.probes.learn<RevealWalkSkips>('owrw2', { kind: 'revealWalks' }, { lane: 'owrw', label: 'Reveal walks', done }) ?? null;
  }
  // how path tiles move Mario on the overworld (owpaths.ts path shapes, for path validation): learned in the probe
  // worker once and kept in the result cache while the game's code is unchanged; null while that runs, then `done` is
  // called
  pathShapes(done: () => void): PathShapes | null {
    return this.probes.learn<PathShapes>('owsh2', { kind: 'pathShapes' }, { lane: 'owsh', label: 'Path shapes', done }) ?? null;
  }
  // the overworld with every event passed (path validation, owreach.ts: what Mario can ever reach), learned in the probe
  // worker in a lane of its own (the map shown keeps its) and kept in memory while the ROM bytes it read are unchanged:
  // undefined while it is emulated, then `done` is called
  overworldAllEvents(done: () => void): OwRender | undefined {
    return this.probes.learn<OwRender>('owma1', { kind: 'owMap', map: 0, progress: OW_EVENTS }, { lane: 'owreach', label: 'Overworld', done });
  }
  // the World check's part the same at every event progress shown (worldcheck.ts worldCheckJob: the problems with
  // every event passed, the budgets, those found at every event progress), from the path kinds and shapes and the open
  // level's exits as edited, learned in the probe worker and kept in memory while the ROM bytes it read are unchanged
  // (seconds: the saves at every progress first)
  overworldWorldCheck(kinds: PathKind[], shapes: PathShapes, done: () => void): WorldCheckLearned | undefined {
    const open = { number: this.level.number, exits: this.level.exits };
    return this.probes.learn<WorldCheckLearned>('owwc1', { kind: 'owWorldCheck', kinds, shapes, open }, { lane: 'owwc', label: 'World check', input: [kinds, shapes, open], done });
  }
  // the exits' edges with the events still passable without each exit's event (owexitedges.ts passableEdgesJob, the
  // layer 1 mode's exit arrows), from the path kinds and shapes, learned in the probe worker and kept in memory while the ROM
  // bytes they read are unchanged (seconds: the saves at every progress first); dropped: the request was dropped (the
  // overworld left, overworldLeft)
  overworldExitEdges(kinds: PathKind[], shapes: PathShapes, done: () => void, dropped?: () => void): ExitEdge[] | undefined {
    return this.probes.learn<ExitEdge[]>('owxe1', { kind: 'owExitEdges', kinds, shapes }, { lane: 'owxe', label: 'Exit arrows', input: [kinds, shapes], done, dropped });
  }
  // The overworld workspace was left: the overworld view's jobs of seconds (the save at the progress shown and with
  // every event passed, the World check, the exits' arrows) are not wanted any more, so that the level editor's jobs
  // don't wait behind them (#388, OW_LEFT_LANES). Asked for again when the view shows; the saves' steps learned so far
  // are kept in the worker (OverworldLoads.deriveSteps). A test play's save goes on.
  overworldLeft(): void {
    for (const lane of OW_LEFT_LANES) this.probes.unlearn(lane);
  }
  // which overworld tiles are level tiles (owpaths.ts levelTileTest), from the path tiles: null while they are learned
  levelTileTest(done: () => void): LevelTileTest | null {
    const kinds = this.pathKinds(done);
    return kinds && levelTileTest(kinds);
  }
  // The overworld as emulated, learned in the probe worker and kept in memory while the ROM bytes it read are unchanged
  // (the latest event progresses of each map): undefined while it runs, then `done` is called. Map `map` at event
  // progress `progress` (a new request drops the one still waiting: the slider), the submaps' views, the sprites' images
  // at a map and progress (a new request drops the one still waiting). The maps' requests replace those of their
  // lane only: a dialog's (the exit dialog's map picker) asks in its own, urgent (runs while it is open), told when
  // the load failed. special: the map after the special world (its colors then, kept apart from the map before it)
  overworldMap(map: number, at: EventProgress, done: (r: OwRender) => void, dialog?: { lane: LearnLane; failed: () => void }, special = false): OwRender | undefined {
    const progress = canonicalProgress(at);
    return this.probes.learn<OwRender>(`owm1:${map}${special ? ':special' : ''}`, { kind: 'owMap', map, progress, ...(special ? { special } : {}) },
      { lane: dialog?.lane ?? 'ow', urgent: !!dialog, failed: dialog?.failed, input: { progress }, replace: true, label: 'Overworld', done });
  }
  // Map `map` at the event progress an edited event is stored against (`progress`: the events up to it passed, none
  // after – CONTEXT.md "Event list"), while another progress is shown: what painting into the event starts from. Kept
  // and asked as overworldMap, in a lane of its own (a new request drops the one still waiting)
  overworldEventBase(map: number, progress: number, done: (r: OwRender) => void): OwRender | undefined {
    return this.probes.learn<OwRender>(`owmb1:${map}`, { kind: 'owMap', map, progress }, { lane: 'owmb', input: { progress }, replace: true, label: 'Overworld', done });
  }
  // Map `map` at event progress `progress` (special: after the special world) with the event triggers 01–08 of its
  // animations switched for the graphics workspace's preview (owanimview.ts owTriggerRender), learned in the probe
  // worker and kept in memory while the ROM bytes it read are unchanged: undefined while it runs (a new request drops
  // the one still waiting), then `done` is called
  overworldTriggers(map: number, at: EventProgress, special: boolean, switches: OwTriggerSwitches, done: (r: OwRender) => void): OwRender | undefined {
    const progress = canonicalProgress(at);
    return this.probes.learn<OwRender>(`owt1:${map}${special ? ':special' : ''}`, { kind: 'owTriggers', map, progress, special, switches },
      { lane: 'owt', input: { progress, switches }, replace: true, label: 'Overworld animations', done });
  }
  // the screen behind map `map`'s border (owlayer3.ts owScreen; special: after the special world), learned and kept as
  // overworldTriggers
  overworldScreen(map: number, special: boolean, done: (f: Uint32Array) => void): Uint32Array | undefined {
    return this.probes.learn<Uint32Array>(`owbs1:${map}${special ? ':special' : ''}`, { kind: 'owScreen', map, special },
      { lane: 'owbs', replace: true, label: 'Overworld screen', done });
  }
  // the colors the game keeps setting on map `map` at event progress `progress` (owanimview.ts owGameColors), learned
  // and kept as overworldTriggers
  overworldGameColors(map: number, at: EventProgress, special: boolean, done: (c: number[]) => void): number[] | undefined {
    const progress = canonicalProgress(at);
    return this.probes.learn<number[]>(`owgc1:${map}${special ? ':special' : ''}`, { kind: 'owGameColors', map, progress, special },
      { lane: 'owgc', input: { progress }, replace: true, label: 'Overworld colors', done });
  }
  // layer 1 as after event e without its layer 1 changes (owevents.ts layer1Without: what a layer 1 stroke painted on
  // the event is compared with), learned in the probe worker and kept in memory while the ROM bytes it read are
  // unchanged: undefined while it runs (a new request drops the one still waiting), then `done` is called; null when
  // it could not be emulated (not asked again until the ROM changes)
  layer1Without(e: number, done: (l1: Uint16Array | null) => void): Uint16Array | null | undefined {
    const r = this.probes.learnOrFailed<Uint16Array>(`owlw1:${e}`, { kind: 'owL1Without', event: e },
      { lane: 'owlw', replace: true, label: 'Overworld event', done, failed: () => done(null) });
    return r === FAILED ? null : r;
  }
  // Whether the game draws the editor's messages (messagedraw.ts messageRoutine), learned in the probe worker and
  // stored while the ROM bytes it read and the registered patches and packages are unchanged: undefined while it is
  // checked (then 'message-routine' is emitted and the promises of messageRoutineKnown resolve). While a ROM edit
  // that left the patches and packages as they were is checked again, the result for them is still given; a check
  // that failed is unknown (game null).
  messageRoutine(): MessageRoutine | undefined {
    const rom = this.rom;
    if (this.msgRoutine?.gen !== rom.gen || this.msgRoutine.rom !== rom) {
      const input = messageRoutineInput(rom), last = this.msgRoutine?.rom === rom && this.msgRoutine.input === input ? this.msgRoutine.known : undefined;
      this.msgRoutine = { rom, gen: rom.gen, input, known: last, learned: undefined };
    }
    const cur = this.msgRoutine, input = cur.input;
    const learned = (r: MessageRoutine) => {
      if (this.msgRoutine?.rom !== rom || this.msgRoutine.input !== input) return;
      this.msgRoutine.known = this.msgRoutine.learned = r;
      const waiting = this.msgRoutineWaiting.splice(0);
      for (const w of waiting) w(r);
      this.emit('message-routine');
    };
    if (!cur.learned) {
      const r = this.probes.learnOrFailed<MessageRoutine>('msgr1', { kind: 'msgRoutine' }, {
        lane: 'msgr', input: { patches: input }, replace: true, label: 'Checking the message routine',
        done: learned, failed: () => learned(UNKNOWN_ROUTINE),
      });
      if (r !== undefined) cur.known = cur.learned = r === FAILED ? UNKNOWN_ROUTINE : r;
    }
    return cur.learned ?? cur.known;
  }
  // messageRoutine once it is known for the ROM as it is now
  messageRoutineKnown(): Promise<MessageRoutine> {
    const now = this.messageRoutine();
    if (now && this.msgRoutine?.learned) return Promise.resolve(now);
    return new Promise((resolve) => this.msgRoutineWaiting.push(resolve));
  }
  private msgRoutine: { rom: Rom; gen: number; input: string; known: MessageRoutine | undefined; learned: MessageRoutine | undefined } | null = null;
  private msgRoutineWaiting: ((r: MessageRoutine) => void)[] = [];

  // the save at an event progress (owprogress.ts progressSaves: the level flags, switch palaces and events triggered
  // the game has then), learned in the probe worker and kept in memory while the ROM bytes it read are unchanged:
  // known, else what gives it once learned (undefined: it could not be; null: the request was dropped). Any set of
  // events (eventset.ts): one emulation learns every prefix, another set is learned on its own (owprogress.ts
  // setSavesJob: its events' levels left in number order) and kept per set here (the probe client's memory); shared by
  // the lanes (OverworldLoads.deriveSteps), each asker in its own (SAVE_LANES: a test play waits for its own, the
  // progress shown replaces the one asked before it, #388). The overworld left, the shown progress's are dropped
  // (overworldLeft)
  progressSave(at: EventProgress, asker: SaveAsker = 'test'): ProgressSave | Promise<ProgressSave | null | undefined> {
    const progress = canonicalProgress(at);
    let learned!: (v: ProgressSave | null | undefined) => void;
    const later = new Promise<ProgressSave | null | undefined>((ok) => { learned = ok; });
    return this.probes.learn<ProgressSave>('owps1', { kind: 'owSave', progress }, {
      ...SAVE_LANES[asker], input: { progress }, label: 'Overworld progress', done: learned, failed: () => learned(undefined), dropped: () => learned(null),
    }) ?? later;
  }
  // the 8x8 tiles (layer 1 tile numbers) and colors the game keeps rewriting on submap `map` at event progress
  // `progress` (owanimated.ts), learned in the probe worker and kept in memory while the ROM bytes it read are
  // unchanged: null until known ('animated' when done), the submap's previous ones meanwhile
  owAnimated(map: number, at: EventProgress): Animated | null {
    const progress = canonicalProgress(at);
    const res = this.probes.learn<Animated>(`owan1:${map}`, { kind: 'owAnimated', map, progress },
      { lane: 'owan', input: { progress }, replace: true, label: 'Overworld animations', done: this.animatedLearned });
    if (res) this.owAnimatedShown = { map, res };
    return res ?? (this.owAnimatedShown?.map === map ? this.owAnimatedShown.res : null);
  }
  // the last submap's tiles and colors learned, shown while the submap's are learned again
  private owAnimatedShown: { map: number; res: Animated } | null = null;
  // the steps of the animation on submap `map` at event progress `progress` (owanimsteps.ts), learned in the probe
  // worker and kept in memory while the ROM bytes they read are unchanged (painting the tilemaps keeps them): undefined
  // while they are emulated (a new request drops the one still waiting; the job's progress in the busy indicator),
  // then `done` is called
  owAnimSteps(map: number, at: EventProgress, done: (s: AnimStep[]) => void): AnimStep[] | undefined {
    const progress = canonicalProgress(at);
    return this.probes.learn<AnimStep[]>(`owas1:${map}`, { kind: 'owAnimSteps', map, progress },
      { lane: 'owas', input: { progress }, replace: true, label: 'Overworld animations', done });
  }
  submapViews(done: (v: Rect[]) => void): Rect[] | undefined {
    return this.probes.learn<Rect[]>('owv1', { kind: 'owViews' }, { lane: 'owv', label: 'Submap views', done });
  }
  overworldSprites(map: number, at: EventProgress, done: (v: OwSpriteView[]) => void): OwSpriteView[] | undefined {
    const progress = canonicalProgress(at);
    return this.probes.learn<OwSpriteView[]>(`ows1:${map}`, { kind: 'owSprites', map, progress }, { lane: 'ows', input: { progress }, replace: true, label: 'Overworld sprites', done });
  }
  // the custom overworld sprites' images at a map and progress (BOWSIE's, owsprites.ts customSpriteImages), and how the
  // installed ones look (the palette)
  overworldCustomSprites(map: number, at: EventProgress, done: (v: OwSpriteView[]) => void): OwSpriteView[] | undefined {
    const progress = canonicalProgress(at);
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
    return this.probes.learn<JumpArc[]>(`arcs:${tx},${ty}`, { kind: 'arcs', level, load: { level: lv.number, ov, spriteHeader: lv.spriteHeader, height }, tx, ty, runs },
      { input: { level, runs }, lane: 'arcs', replace: true, label: 'Jump arcs', done: this.arcsLearned });
  }
  private arcsLearned = () => this.emit('arcs');

  // The object picker's thumbnails of specs in the level as edited (objthumbs.ts): undefined while they are
  // learned in the probe worker ('thumbs' when done)
  objectThumbs(specs: ObjSpec[]): ObjThumb[] | undefined {
    const rom = this.rom, lv = this.level, keys = new Map(specs.map((s) => [s, objKey(s, this.kindOf(s))]));
    const keyOf = (s: ObjSpec) => keys.get(s)!, level = { ...lv, header: { ...lv.header } };
    return this.probes.learn<ObjThumb[]>(thumbsKey(lv, specs, keyOf), { kind: 'thumbs', level, specs, keys: specs.map(keyOf) },
      { input: thumbsInput(rom, lv), lane: 'thumbs', replace: true, label: 'Object thumbnails', done: this.thumbsLearned });
  }
  private thumbsLearned = () => this.emit('thumbs');

  private objectNamesSeen = ''; // the user's object names as last told ('object-names')
  // the object table of a tileset's standard objects (objectnames.ts), learned in the probe worker once and kept in the
  // result cache: null while that runs (names as without a table, 'object-names' when known) and when there is none
  objectTable(ts = this.level.header.tileset): number | null {
    const r = this.probes.learnOrFailed<number | null>(objectTableKey(ts), { kind: 'objectTable', tileset: ts }, { lane: 'otab', label: 'Object tables', done: this.objectTableLearned, failed: this.objectTableLearned });
    return r === FAILED || r === undefined ? null : r;
  }
  private objectTableLearned = () => this.emit('object-names');
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

  // kind of a standard object in the current tileset; null while unknown (then treated as plain): the open level's
  // objects' kinds come before the tileset's others (ProbeClient.kindsSoFar)
  objectKind(num: number): ObjKind | null {
    if (num === 0) return null;
    const k = this.tilesetKinds();
    return (k ? k.kinds.get(num) : this.probes.kindsSoFar()?.get(num)) ?? null;
  }
  // kind of an object (or spec) in the current tileset: a custom number's of object 2D with an extension (UNSIZED for
  // one that draws nothing), else objectKind; null while unknown
  kindOf(o: { num: number; extension?: number[] }): ObjKind | null {
    if (o.num !== OBJ_2D || !o.extension) return this.objectKind(o.num);
    const k = this.tilesetKinds();
    return k && (k.custom.get(o.extension[0]) ?? UNSIZED);
  }
  // the byte of the object its kind names (the 3rd, or a custom number's 5th)
  sizedByte(o: LevelObject): number {
    return sizedByte(this.kindOf(o), o);
  }

  // (empty while unknown or when they could not be found: objects are treated as plain then)
  tilesetKinds(ts = this.level.header.tileset): ObjKinds | null {
    const k = this.probes.kinds(ts);
    return k === undefined ? null : k ?? { kinds: new Map(), custom: new Map(), drawsWith: new Map() };
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
    const s = this.view.show.sprites ? this.spriteAt(px, py) : null;
    if (s) out.push({ mode: 'spr', item: s });
    const o1 = this.view.show.layer1 ? this.objectAt(tx, ty, false) : null;
    if (o1) out.push({ mode: 'l1', item: o1 });
    const o2 = this.view.show.layer2 && this.level.layer2Objects ? this.objectAt(tx, ty, true) : null;
    if (o2) out.push({ mode: 'l2', item: o2 });
    return out;
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
    this.model.selection.clear();
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
    return (this.model.mode === 'l2' && !this.level.layer2Objects) || (this.model.mode === 'bg' && !this.canEditBg());
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
    const ghosts = this.level.layer2Objects || isBrushMode(m) || isBrushMode(this.model.mode);
    const recompose = m !== this.model.mode && ((ghosts && this.view.show.ghost) || (m === 'l3' && !this.view.show.layer3));
    if (m === 'l3') this.view.show.layer3 = true;
    this.model.mode = m;
    this.model.selection = new Set(selection);
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

  insertAt(tx: number, ty: number, p: PickedItem | null = this.model.pickedItem): void {
    if (!p) { toast('Choose an object/sprite in the picker first.'); return; }
    this.model.insertAt(tx, ty, p);
  }

  // ------------- conditional Direct Map16 (cdm16.ts) -------------
  // the flags the level's objects use, with the number of objects each
  levelFlags(): Map<number, number> {
    return this.level ? usedFlags(this.rom, this.level) : new Map();
  }
  // the view's flags (and test play's): `flags` on or off, then the level loads anew with them
  setFlags(flags: Iterable<number>, on: boolean): void {
    for (const f of flags) if (on) this.view.cdm16.add(f); else this.view.cdm16.delete(f);
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
  // View → "Animation" switched (motion.ts animationPref: kept in the browser): the level loads anew, its animation
  // shown or not; the overworld follows ('animation')
  setAnimation(on: boolean): void {
    animationPref.set(on);
    this.view.show.anim = on;
    this.refresh();
    this.emit('animation');
  }

  // changes the view's triggers (and test play's); the level loads anew with them, its animation shown (View →
  // "Animation" switched on, the overworld's too)
  setTriggers(fn: (v: TriggerView) => void): void {
    fn(this.view.exTriggers);
    if (!this.view.show.anim) { this.setAnimation(true); return; }
    this.refresh();
  }

  // ------------- prefabs (prefabs.ts) -------------
  prefabs(): Map<number, Prefab> {
    return listPrefabs(this.rom);
  }

  // what the selected objects left in the level as a block of tiles (RenderQuery.tileCut)
  prefabFromSelection(): TileCut | string {
    if (!this.model.selectedObjects().length || (this.model.mode !== 'l1' && this.model.mode !== 'l2')) return 'Select objects in the level first (layer 1 or 2).';
    return this.query.tileCut(this.model.mode === 'l2', this.model.currentObjects(), (o) => this.model.selection.has(o.uid));
  }

  // Where the arrangement of prefab s already is as Direct Map16 objects (prefabplaces.ts): the open level as edited
  // (not its selected objects, unless all) and all other levels as saved. Learned in the probe worker (a level's load
  // where objects lie between those of a place), done called with them; a later request replaces it. Urgent: the
  // dialog asking waits for it.
  prefabPlaces(s: Prefab, all: boolean, done: (places: LevelPlaces[]) => void): void {
    const lv = this.level, levels = usedLevels(this.rom), layer: 1 | 2 = this.model.mode === 'l2' ? 2 : 1;
    const skip = { level: lv.number, layer, objects: all ? [] : this.selectedIndices() };
    const r = this.probes.learnOrFailed<LevelPlaces[]>('places', { kind: 'prefabPlaces', prefab: s, levels, open: lv, skip },
      { lane: 'prefab-places', input: { s, levels, open: lv, skip }, replace: true, urgent: true, label: 'Looking for the arrangement', done, failed: () => done([]) });
    if (r !== undefined) done(r === FAILED ? [] : r);
  }
  // the places asked for are not wanted any more (the dialog closed)
  dropPrefabPlaces(): void {
    this.probes.unlearn('prefab-places');
  }
  private selectedIndices(): number[] {
    return this.model.currentObjects().flatMap((o, i) => (this.model.selection.has(o.uid) ? [i] : []));
  }

  // stores the selection as prefab n; replace: the selected objects become one prefab object (at the place of
  // the last of them in the object list, so objects in between still cover it); places (prefabPlaces): replaced
  // too, with the prefab and the selection in one ROM edit (else the selection is a level edit after it)
  saveSelectionAsPrefab(n: number, name: string, replace: boolean, places: LevelPlaces[] = []): boolean {
    const r = this.prefabFromSelection();
    if (typeof r === 'string') { toast(r, 'error'); return false; }
    const open = this.level.number, layer = this.model.mode === 'l2' ? 2 : 1;
    const selection: PrefabGroup = { layer, x: r.x, y: r.y, objects: this.selectedIndices() };
    const sources = { objects: this.model.currentObjects().filter((o) => this.model.selection.has(o.uid)), x: r.x, y: r.y };
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
      const o = this.model.currentObjects()[at];
      if (o) { this.model.selection = new Set([o.uid]); this.emit('change'); }
    } else if (replace) {
      this.editLevel((lv) => { this.model.selection = new Set(replaceWithPrefab(lv, n, [selection]).map((o) => o.uid)); });
    }
    this.model.pickedItem = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n };
    return true;
  }

  // stores arrangement s (a suggestion's) as prefab n, its places (prefabPlaces) replaced in the same ROM edit
  saveArrangementAsPrefab(n: number, s: Prefab, places: LevelPlaces[]): boolean {
    // (its places replaced: no longer suggested)
    try { this.suggestions.saveArrangement(n, s, places); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    this.model.pickedItem = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n };
    return true;
  }

  // prefab n as s and plan's objects replaced by it, one ROM edit labelled with the places found elsewhere;
  // sources: the objects it is made from, its top left at x, y (prefabsources.ts)
  private storePrefab(n: number, s: Prefab, plan: LevelGroups[], places: LevelPlaces[], sources?: { objects: LevelObject[]; x: number; y: number }): boolean {
    try {
      storePrefab(this.edits, n, s, plan, places, sources);
      return true;
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
  }

  // the suggestion runs: the suggestions anew a while after the last change, in the probe worker; the levels that didn't change keep their
  // results there (prefabsuggest.ts KeptSuggestions). A change they don't depend on keeps them current at once; one
  // back to the latest run's state (an undo) makes them current at once with that run's whole list (a suggestion
  // saved and undone is back with its places, a list it was dropped from is never current). During a ROM edit the
  // edit session's settled checks once it is done (suggestsession.ts).
  private stopSuggestRun(): void {
    clearTimeout(this.suggestTimer);
    this.suggestRun++; // (a run started meanwhile stops)
    this.probes.unlearn('prefab-suggest');
  }
  private startSuggestRun(): void {
    const run = this.suggestRun;
    this.suggestTimer = window.setTimeout(() => {
      if (run !== this.suggestRun || this.closed) return;
      const src = this.suggestions.source(), { levels, open } = src;
      // (a run on other levels or contents replaces the one running)
      this.probes.learn<SuggestRun>('suggest', { kind: 'suggest', levels, open }, { lane: 'prefab-suggest', input: suggestInput(this.rom, src), replace: true, done: (r) => {
        if (run === this.suggestRun) this.suggestions.list.done(r);
      } });
    }, 1500);
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

  // A prefab object becomes the objects it was made from where they draw the level as it does, else Direct Map16
  // objects (rectangles of one tile), at its place in the object list (prefabsources.ts). Whether they draw it the same
  // is learned in the probe worker (two loads of the level as edited); the level edited meanwhile, nothing is broken up.
  explodePrefab(o: LevelObject): void {
    const p = breakUpParts(this.rom, o, this.vertical);
    if (!p) { toast('The prefab does not exist (anymore).', 'error'); return; }
    const lv = this.level, gen = this.edits.levelGen, src = p.sources;
    const apply = (parts: LevelObject[], differs: boolean) => {
      if (this.level !== lv || this.edits.levelGen !== gen) { toast('The level changed meanwhile: break up the prefab again.', 'error'); return; }
      this.editLevel((l) => {
        const { objects, layer2Objects } = replaced(l, o, parts);
        l.objects = objects;
        if (layer2Objects) l.layer2Objects = layer2Objects;
        this.model.selection = new Set(parts.map((q) => q.uid));
      });
      if (differs) toast('Its objects would look different here: broken up into single tiles.', 'info');
    };
    if (!src) { apply(p.tiles, false); return; }
    let a: LevelOverride, b: LevelOverride;
    try { a = this.buildOverrides(lv); b = this.buildOverrides(replaced(lv, o, src)); } catch { apply(p.tiles, true); return; } // (not serializable there)
    const alike = (same: boolean) => (same ? apply(src, false) : apply(p.tiles, true));
    const r = this.probes.learnOrFailed<boolean>('same', { kind: 'sameTiles', level: lv.number, a, b },
      { lane: 'breakup', input: [levelInput(lv.number, a), levelInput(lv.number, b)], replace: true, label: 'Breaking up the prefab', done: alike, failed: () => alike(false) });
    if (r !== undefined) alike(r === true);
  }

  // resize: width/height nibbles of settings byte by one step each; the left and top edges stay where they
  // are, with far the right and bottom ones (an object at the level's edge that would have to leave it stays).
  // The boxes are asked for first: resized when they come, presses meanwhile after it in order
  resizeSelection(dw: number, dh: number, far = false): void {
    this.keyResizes.add((retry) => this.resizeStep(dw, dh, far, retry));
  }
  private keyResizes = new StepQueue();
  private resizeStep(dw: number, dh: number, far: boolean, retry: () => void): boolean {
    const objs = this.model.selectedObjects().filter((o) => this.resizable(o));
    if (!objs.length) return true;
    const sized = objs.map((o) => resizeObjectSize(this.kindOf(o), sizedByte(this.kindOf(o), o), dw, dh));
    if (!this.askSizes(objs.flatMap((o, i) => [this.sizeSpec(o), this.sizeSpec(o, sized[i])]), retry)) return false;
    this.model.resizeObjects(objs, sized, (o) => this.sizeBoxes(o), far, (o) => this.kindOf(o));
    return true;
  }

  // whether the settings byte sizes the object: standard objects and Direct Map16
  resizable(o: LevelObject): boolean {
    return o.num !== 0 || o.ext === DM16_EXT;
  }

  // the tiles objects cover at each size, emulated alone (objresize.ts) in the probe worker, for the level's tileset as
  // the ROM is now: those known (sizeLevel's key: of the level and ROM state they hold for)
  private sized = new ObjectBoxes((key, specs, done, failed) => {
    const { level, layer2Pointer } = this.sizeLevel();
    this.probes.learn<(Box | null)[]>('sizes', { kind: 'sizes', level, layer2Pointer, specs }, { lane: 'sizes', input: { key, specs: specs.map(sizeKey) },
      done: (got) => { done(got); this.emit('sizes'); }, failed: () => { failed(); this.emit('sizes'); } });
  });
  private sizeLevel(): { key: string; level: KindLevel; layer2Pointer: number } {
    const lv = this.level, l2 = levelBgPointer(this.rom, lv);
    return { key: `${this.rom.gen}:${lv.number}:${inputHash(lv.header)}:${l2}`, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 };
  }
  // the boxes known for the level as it is now
  private objectBoxes(): ObjectBoxes {
    return this.sized.at(this.sizeLevel().key);
  }
  // asks the probe worker for the boxes of specs not known ('sizes' when they come, then done); whether all are known
  private askSizes(specs: SizeSpec[], done?: () => void): boolean {
    return this.objectBoxes().ask(specs, done);
  }
  // the object as probed, the byte its kind names (sizedByte) set to size (as it is: unchanged)
  private sizeSpec(o: LevelObject, size?: number): SizeSpec {
    const s: SizeSpec = { num: o.num, ext: o.ext, size: o.size, tile: o.tile, extension: o.extension };
    return size === undefined ? s : withSizedByte(this.kindOf(o), s, size);
  }
  // the object's box at a size (of the byte its kind names; relative to its origin), undefined while not probed
  sizeBoxes(o: LevelObject): (size: number) => Box | null | undefined {
    const boxes = this.objectBoxes();
    return (size) => boxes.box(this.sizeSpec(o, size));
  }
  // every size the parts of the object's settings byte can take
  private allSizes(o: LevelObject): SizeSpec[] {
    const kind = this.kindOf(o);
    return sizeParts(kind).flatMap((p) => partSizes(sizedByte(kind, o), p).map((s) => this.sizeSpec(o, s)));
  }
  // asks for all sizes of the objects now (a drag starts; 'sizes' when they come)
  probeSizes(objs: LevelObject[]): void {
    this.askSizes(objs.flatMap((o) => this.allSizes(o)));
  }
  // which part of the settings byte sizes which axis of the object: as emulated once its sizes are known,
  // before (and when their job failed) as its kind says (they are probed in the background then, 'sizes' when known)
  resizeDrivers(o: LevelObject): Drivers {
    const kind = this.kindOf(o), d = this.objectBoxes().drivers(kind, this.sizeSpec(o));
    if (d) return d;
    this.prefetchSizes();
    return namedDrivers(kind);
  }
  private sizesAsked: string | null = null; // the sizes' key (sizeLevel) and the selection whose sizes are asked for
  private prefetchSizes(): void {
    const objs = this.model.mode === 'l1' || this.model.mode === 'l2' ? this.model.selectedObjects().filter((o) => this.resizable(o)).slice(0, 32) : [];
    if (!objs.length) return;
    const key = `${this.sizeLevel().key}/${objs.map((o) => `${o.uid}.${o.size}.${o.extension?.join(',') ?? ''}`).join()}`;
    if (this.sizesAsked === key) return;
    this.sizesAsked = key;
    if (this.askSizes(objs.flatMap((o) => this.allSizes(o)), () => (this.sizesAsked = null))) this.sizesAsked = null;
  }

  // copies the selection and pastes it one tile down-right (Ctrl+D)
  duplicateSelection(): void {
    this.model.copy();
    const s = this.model.selectedItems();
    if (s[0]) this.paste(s[0].x + 1, s[0].y + 1);
  }

  paste(tx: number, ty: number): void {
    this.placeCopy(this.model.clipboardItems(), tx, ty);
  }
  // a right click in the level: a copy of the selection when it was picked after the picked item, else the picked item
  placeAt(tx: number, ty: number): void {
    if (this.model.copiesSelection()) this.placeCopy(this.model.selectedItems(), tx, ty);
    else this.insertAt(tx, ty);
  }
  // The placement preview at tile (tx, ty): the placement as the level shows it once placed – objects drawn by
  // the level's load with them added (learned in the background: undefined until known), sprites with their images
  placementPreview(tx: number, ty: number): PreviewPart[] | undefined {
    const pl = this.model.placement(tx, ty);
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
    const sig = JSON.stringify([this.model.mode, objects.map((o) => ({ ...o, uid: 0 }))]), m = this.previewMemo;
    if (m.render === this.render && m.sig === sig) return m.part;
    const l2 = this.model.mode === 'l2', g = l2 ? this.images.geom2 : this.images.geom1;
    if (!g) return null;
    // (learned in the probe worker on the level as edited, sent there once: the objects placed in it)
    const state = editState(this.level, this.buildOverrides());
    const pic = this.probes.learn<PlacementPreview | null>(`pp1:${state.level.number}:${l2 ? 2 : 1}`, { kind: 'preview', state, layer2: l2, objects },
      { input: inputHash(previewInput(this.rom, state, l2, objects)), lane: 'placement', replace: true, done: this.previewLearned });
    const part = pic && { x: pic.x0 * 16, y: pic.y0 * 16, img: thumbCanvas(pic) };
    this.previewMemo = { render: this.render, sig, part };
    return part;
  }
  private previewLearned = () => { this.previewMemo.render = null; this.emit('placement-preview'); };

  // the picked item chosen in the picker: the level's selection cleared (it would be copied by a right click)
  choosePickedItem(p: PickedItem): void {
    this.model.pickedItem = p;
    this.model.clearSelection();
    this.emit('picked-item');
  }
  // no picked item any more
  clearPickedItem(): void {
    if (!this.model.pickedItem) return;
    this.model.pickedItem = null;
    this.emit('picked-item');
  }

  // copies of the items with their upper left at tile (tx, ty), selected
  private placeCopy(items: (LevelObject | LevelSprite)[], tx: number, ty: number): void {
    if (!this.model.placeCopy(items, tx, ty)) return;
    if (this.model.mode !== 'l1' && this.model.mode !== 'l2') return;
    const pasted = this.model.selectedObjects();
    const hint = this.pastes.paste(pasted);
    if (hint) this.setPasteHint({ ...hint, level: this.level.number, layer: this.model.mode, objects: structuredClone(pasted) });
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
    if (this.model.mode !== p.layer) this.setMode(p.layer, uids);
    else { this.model.selection = new Set(uids); this.emit('change'); }
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
      const wait = this.romWatch.held ? 150 : this.quietUntil - performance.now();
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
    this.romWatch.notify();
    this.emit('rom-change');
  }

  // the open level again from the ROM, after a ROM edit changed its stored data (unsaved changes are
  // gone: an edit saves them first, an undo may take back what they were saved over)
  private reloadLevel(): void {
    clearTimeout(this.romTimer); // (openLevel draws it)
    this.romTimer = 0;
    this.openLevel(this.level.number, true);
  }

  // a view watching the ROM bytes it draws from (romwatch.ts): changed when a ROM change changed one of them (the view
  // draws through the watch's run)
  watchRom(changed: () => void): Watch {
    return this.romWatch.watch(changed);
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

  // the Map16 tab on a tile of a target; an overworld tile drawn as on the submap of `at` at its event progress
  editTile(tile: number, target: Map16Target = 'fg', at?: WsTarget): void {
    this.wsTile = tile;
    this.wsTarget = target;
    this.wsAt = at;
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

// what the follow-ups of a ROM edit read (see the edit session in the constructor): a read that throws (a level the
// editor can't read) counts what it read up to there
function attempt(f: () => unknown): void {
  try { f(); } catch { /* (read up to the error) */ }
}
// the level as stored (the error when the editor can't read it); two are the same without the objects' and sprites'
// ids (compared only when a byte it read changed)
function storedLevel(rom: Rom, n: number): Level | string {
  try { return loadLevel(rom, n); } catch (e) { return String(e); }
}
const levelText = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'uid' ? undefined : x));
const sameLevel = (a: unknown, b: unknown) => levelText(a) === levelText(b);
// the level's graphics slots, own palette and music
function readLevelHeader(rom: Rom, n: number): void {
  levelGfx(rom, n); levelExtGfx(rom, n); customPalette(rom, n); levelMusic(rom, n);
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
