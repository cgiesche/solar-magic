// Application state and editing actions.

import { Rom, snesToPc } from '../core/rom.ts';
import { LevelEmulator, OV_L1, OV_L2, type LevelRender, type LevelOverride, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, type ScreenExit, type SecondaryEntrance, loadLevel, spriteLoadOrder, serializeLayer1, serializeLayer2, serializeSprites, spriteSizes, spriteId, spriteBytes,
  isL1Vertical, cloneLevel, newUid, hasLayer2Objects, hasObjects, L1_PTRS, L2_PTRS, SEC_HDR,
  readSecondaryEntrance, writeSecondaryEntrance, entrancePos, nearestEntrance, encodeSecondaryHeader,
} from '../core/level.ts';
import { hex, spriteName } from '../core/names.ts';
import { loadPixiProject, customSpriteList, type CustomSprite } from '../core/pixi.ts';
import { renderLevel, type LevelImages, composite } from '../core/render.ts';
import { saveLevel } from '../core/save.ts';
import { captureSprites, captureSpriteAt, type SpriteImage } from '../core/spritegfx.ts';
import { spriteMemJob, usedSpriteMemory } from '../core/spritemem.ts';
import { DM16_EXT, levelGfx, defaultGfx } from '../core/patches.ts';
import { gfxSkipMask, gfxFilesHash } from '../core/gfxpages.ts';
import { STRUCT_EXT, STRUCT_MAX, TRANSPARENT, listStructures, readStructure, writeStructure, type Structure } from '../core/structs.ts';
import type { Package } from '../core/pkgreg.ts';
import { kvEntries, kvWrite, saveRom } from './storage.ts';
import { ResultCache, RomFingerprint, RomReads, type CacheEntry } from '../core/romdeps.ts';
import { bgFromWram, bgIndex, encodeBg } from '../core/bg.ts';
import { toast, log as logMsg, modalsOpen, onModalsChange } from './dom.ts';
import { musicPlayer } from './musicplayer.ts';
import { ExitGraph, exitTarget } from '../core/exitgraph.ts';
import { RomHistory, type RomEdit } from '../core/romhistory.ts';
import { LevelHistory } from '../core/levelhistory.ts';
import { resizeObjectSize, type ObjKind, type ObjKinds } from '../core/objkinds.ts';
import { JumpArcs, ARC_SPEEDS, type JumpArc } from '../core/jumparcs.ts';
import { scanKey, type ScanResult } from '../core/levelscan.ts';
import { layer3Kinds, tideKind, layer3Top, type Layer3Kind } from '../core/layer3.ts';
import { variantOf, blockKey, spriteKey, type BlockProbe, type SpriteProbe } from '../core/blockprobe.ts';
import type { ProbeReply } from '../core/probehost.ts';
import { ProbeClient } from '../core/probeclient.ts';
import { map16Tile, bgTile } from '../core/ram.ts';
import { exanimTiles, exanimColors } from '../core/exanim.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg';
export type PaletteItem =
  // block: a rectangle of Map16 tiles from the palette sheet (tile + row * 16 + col), one Direct-Map16 object each
  // struct: structure number (extended object $03, see structs.ts)
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number; block?: { w: number; h: number }; struct?: number }
  | { kind: 'spr'; num: number; extra: number };

type Listener = () => void;

// an undoable level edit begun with App.beginLevelEdit
export interface LevelEdit {
  commit(rerender?: boolean): void;
  cancel(restore?: boolean): void;
}

// What App tells its views (on/once/emit). None carries data: listeners read what they need from App.
export type AppEvent =
  | 'change' // the level (or the selection, the mode's objects) was edited
  | 'level' // another level was opened (also after "Save as")
  | 'level-header' // the level's header, GFX slots or palette changed
  | 'mode' // the edit mode (layer 1/2, sprites, BG, exits …) changed
  | 'render' // the level was emulated and drawn again
  | 'rom-change' // the ROM was written (romWritten, romChanged)
  | 'probes' // the asked or the prefetched probes are done (block, collision, sprite, run speeds)
  | 'objkinds' // object kinds asked for are known (or failed)
  | 'level-scan' // the level scan of the level as edited is known
  | 'arcs' // jump arcs asked for are known
  | 'sprites' // sprite images were captured
  | 'sprite-mem' // the sprite memory check of the level is known
  | 'animated' // which tiles and colors of the level animate is known
  | 'anim-frame' // the next frame of the level animation is shown
  | 'palettes' // the palettes changed (sprite images are captured again)
  | 'structs' // the structure table changed
  | 'bgtile' // the BG brush changed (picked from the level)
  | 'reveal' // the level view scrolls to App.reveal
  | 'zoom' // the level view's zoom changed
  | 'busy' // background work (setBusy), a modal or the music player changed
  | 'open-gfx' // the graphics workspace opens on App.wsGfx
  | 'open-map16' // the graphics workspace opens on the Map16 tab
  | 'import-gfx'; // the graphics workspace imports App.gfxImport

const CACHE_PREFIX = 'rc3:'; // IndexedDB keys of the result cache (bump when result formats change or old results may be wrong: rc3 after the stale boot snapshot fix)
const BG_SLICE = 12; // ms a slice of background work runs before input and drawing get through

// result of the sprite memory check (see App.checkSpriteMem); gen: App.editGen when it started
export interface SpriteMemState { key: string; level: number; mem: number; gen: number; conflicts: Set<number>; suggestion: number | null }

// entrance markers: main entrance, midway point, secondary entrances leading into this level
export interface Marker { kind: 'main' | 'midway' | 'sec'; index: number; x: number; y: number }

export class App {
  rom: Rom;
  romName: string;
  emu: LevelEmulator;
  level!: Level;
  render!: LevelRender;
  images!: LevelImages;
  compositeImg!: Uint32Array;
  mode: EditMode = 'l1';
  selection = new Set<number>();
  paletteItem: PaletteItem | null = null;
  // BG mode brush: a w×h block of BG Map16 tiles (row-major), picked from the palette sheet or the level
  bgBrush: { w: number; h: number; tiles: number[] } = { w: 1, h: 1, tiles: [0] };
  zoom = 2;
  show = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: false, items: true, collision: false, arcs: false };
  // view-only game state applied before the emulated level load
  switches = { palaces: false, onOff: false };
  dirty = false;
  private levelHistory = new LevelHistory<Level>(cloneLevel);
  private editToken = 0; // the latest begun level edit (older handles do nothing)
  // undo for ROM edits of the graphics workspace (palettes, Map16, GFX, slot assignments)
  romHistory: RomHistory;
  wsTile = 0; // Map16 tile for 'open-map16' (opens the graphics workspace there)
  wsTileBg = false; // wsTile is a BG tile
  gfxImport: { file: File; into: Package | null } | null = null; // for 'import-gfx'
  wsGfx: number | null = null; // GFX file for 'open-gfx'
  // order of level and ROM edits, so one undo/redo serves both (n: stack length after the push)
  undoOrder: { kind: 'level' | 'rom'; n: number }[] = [];
  redoOrder: ('level' | 'rom')[] = [];
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
  private graph: ExitGraph | null = null;
  spriteThumbs: Map<number, HTMLCanvasElement> | null = null;
  variantQueue: number[] = []; // sprites whose variant images are captured next
  private canvases = new WeakMap<SpriteImage, HTMLCanvasElement>();
  // results found out by emulation, valid while the ROM they read is unchanged (see romdeps.ts);
  // stored in IndexedDB, loaded once at start (cacheReady)
  results: ResultCache;
  cacheReady: Promise<void>;
  private cacheTimer = 0;
  private closed = false; // project closed: nothing is written to the browser any more
  reveal = { x: 0, y: 0 }; // pixel the level view scrolls to on 'reveal'
  secEntrances: number[] = []; // secondary entrance indices leading into the current level
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
    musicPlayer.onChange(() => { this.resumeBackground(); this.emit('busy'); });
    this.romHistory = new RomHistory(rom);
    this.results = new ResultCache(new RomFingerprint(rom));
    this.cacheReady = kvEntries<CacheEntry>(CACHE_PREFIX)
      .then((e) => this.results.load(e.map(([k, v]) => [k.slice(CACHE_PREFIX.length), v])))
      .catch((e) => console.error(e));
    this.probes = new ProbeClient({
      results: this.results,
      cacheReady: this.cacheReady,
      rom: () => ({ gen: this.rom.gen, data: this.rom.data }),
      tileset: () => this.level.header.tileset,
      kindLevel: () => {
        const lv = this.level;
        return { level: { number: lv.number, header: lv.header }, layer2Pointer: lv.layer2Objects ? this.rom.r24(L2_PTRS + 0x105 * 3) : lv.layer2Pointer };
      },
      connect: (reply, failed) => {
        const w = new Worker(new URL('./probeworker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ProbeReply>) => reply(e.data);
        w.onerror = (e) => { console.error(e); w.terminate(); failed(); };
        return (m) => w.postMessage(m, m.type === 'rom' ? [m.data.buffer] : []);
      },
      later: (key, step) => this.later(key, step),
      setBusy: (key, label) => this.setBusy(key, label),
      ready: () => this.emit('probes'),
      kindsReady: () => this.emit('objkinds'),
    });
    this.results.onChange = () => {
      if (!this.cacheTimer && !this.closed) this.cacheTimer = window.setTimeout(() => this.storeResults(), 3000);
    };
    window.addEventListener('pagehide', () => { if (this.cacheTimer && !this.closed) { clearTimeout(this.cacheTimer); this.storeResults(); } });
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
  backgroundHeld(): boolean { return modalsOpen() > 0 || musicPlayer.playing; }
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
  openLevel(n: number): void {
    if (this.level && this.dirty) this.saveLevel(true);
    this.level = loadLevel(this.rom, n);
    this.selection.clear();
    this.exitScreen = 0;
    this.exitMarker = null;
    if ((this.mode === 'l2' && !this.level.layer2Objects) || (this.mode === 'bg' && !this.canEditBg())) this.mode = 'l1';
    this.levelHistory.clear();
    this.dirty = false;
    this.spriteMem = this.spriteMemBase = null;
    this.refresh();
    this.emit('level');
    logMsg(`Level ${hex(n, 3)} opened`);
    this.ensureSpriteImages();
    this.scheduleSpriteMem();
    this.probes.prefetch();
  }

  get vertical(): boolean {
    return isL1Vertical(this.rom, this.level.header.mode);
  }

  buildOverrides(): LevelOverride {
    const lv = this.level;
    const owners1: number[] = [];
    const l1 = serializeLayer1(this.rom, lv, owners1);
    const owners2: number[] = [];
    const l2 = serializeLayer2(this.rom, lv, owners2);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners1.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    owners2.forEach((o, i) => (byteOwner[OV_L2 + i] = o < 0 ? -1 : 0x8000 | o));
    return {
      layer1: l1,
      layer2: l2 ?? undefined,
      layer2Pointer: l2 ? undefined : lv.layer2Pointer,
      bgData: !l2 && lv.bg ? encodeBg(lv.bg) : undefined,
      sprites: serializeSprites(lv.sprites, lv.spriteHeader, this.vertical, spriteSizes(this.rom)),
      byteOwner,
      switchPalaces: this.switches.palaces,
      onOffSwitch: this.switches.onOff,
      secondaryHeader: encodeSecondaryHeader(lv.secondary),
    };
  }

  refresh(): void {
    this.graph = null;
    this.arcCache.clear();
    this.arcLevel = null;
    const lv = this.level;
    const r = this.emu.load(lv.number, this.buildOverrides());
    this.renderError = r.ok ? null : r.error ?? 'Error';
    this.anim.snaps = this.show.anim && r.ok ? this.emu.animationFrames() : [];
    this.render = r;
    this.images = renderLevel(this.rom, r, lv.header.mode, lv.header.screens);
    this.compositeImg = this.compose();
    this.buildOffsetMaps();
    this.findSecondaryEntrances();
    this.startAnimation();
    this.emit('render');
    this.scheduleScan();
  }

  recomposite(): void {
    this.compositeImg = this.compose();
    this.startAnimation();
    this.emit('render');
  }

  // the object layer not being edited is ghosted (only in levels with two object layers)
  compose(images = this.images): Uint32Array {
    const ghost = !this.show.ghost ? 0 : this.mode === 'bg' ? 1 : this.level.layer2Objects ? (this.mode === 'l1' ? 2 : this.mode === 'l2' ? 1 : 0) : 0;
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
      const li = renderLevel(this.rom, { ...this.render, vram: snaps[i].vram, cgram: snaps[i].cgram }, lv.header.mode, lv.header.screens);
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
  // vanilla: entrance i leads to level F800[i] | (i & $100) (the high bit comes from the map, like the exit's)
  findSecondaryEntrances(): void {
    const n = this.level.number;
    this.secEntrances = [];
    for (let i = n & 0x100; i < (n & 0x100) + 0x100; i++) if (readSecondaryEntrance(this.rom, i).destLevel === (n & 0xff)) this.secEntrances.push(i);
  }

  markers(): Marker[] {
    const s = this.level.secondary;
    const vert = (s.verticalPositioning & 1) !== 0;
    const main = entrancePos(this.rom, s.entranceScreen, s.entranceX, s.entranceY, vert);
    const mid = entrancePos(this.rom, s.midwayScreen, s.entranceX, s.entranceY, vert);
    const out: Marker[] = [{ kind: 'midway', index: 0, ...mid }, { kind: 'main', index: 0, ...main }];
    for (const i of this.secEntrances) {
      const e = readSecondaryEntrance(this.rom, i);
      out.push({ kind: 'sec', index: i, ...entrancePos(this.rom, e.screen, e.entranceX, e.entranceY, vert) });
    }
    return out;
  }

  // snaps a marker to the entrance setting nearest to Mario's top-left pixel (px, py);
  // main/midway change the level (undoable), secondary entrances are written to the ROM directly.
  // The midway point shares X/Y with the main entrance, only its screen can change.
  moveMarker(m: Marker, px: number, py: number): boolean {
    const s = this.level.secondary;
    const vert = (s.verticalPositioning & 1) !== 0;
    const maxScreen = this.level.header.screens - 1;
    const p = nearestEntrance(this.rom, px, py, vert, m.kind === 'midway' ? Math.min(15, maxScreen) : maxScreen);
    if (m.kind === 'main') {
      if (s.entranceScreen === p.screen && s.entranceX === p.ex && s.entranceY === p.ey) return false;
      s.entranceScreen = p.screen; s.entranceX = p.ex; s.entranceY = p.ey;
    } else if (m.kind === 'midway') {
      if (s.midwayScreen === p.screen) return false;
      s.midwayScreen = p.screen;
    } else {
      const e = readSecondaryEntrance(this.rom, m.index);
      if (e.screen === p.screen && e.entranceX === p.ex && e.entranceY === p.ey) return false;
      e.screen = p.screen; e.entranceX = p.ex; e.entranceY = p.ey;
      // ROM data: one undo step per marker (successive moves merge)
      this.romEdit(`Secondary entrance ${hex(m.index, 3)} moved`, () => writeSecondaryEntrance(this.rom, m.index, e), `sec-entrance:${m.index}`);
    }
    return true;
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

  // all exits of the ROM, the current level as edited
  exitGraph(): ExitGraph {
    return (this.graph ??= new ExitGraph(this.rom, this.level));
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

  // changes a secondary entrance (undoable ROM edit; edits with the same key merge)
  editSecondaryEntrance(idx: number, label: string, f: (e: SecondaryEntrance) => void, key: string | null = null): void {
    const e = readSecondaryEntrance(this.rom, idx);
    f(e);
    this.romEdit(label, () => writeSecondaryEntrance(this.rom, idx, e), key);
    this.findSecondaryEntrances();
    this.emit('change');
  }

  // a new secondary entrance into the current level at the entrance setting nearest to (px, py)
  newSecondaryEntrance(px: number, py: number): number | null {
    const n = this.level.number;
    const idx = this.exitGraph().freeEntrance(n);
    if (idx === null) { toast(`No free secondary entrance left in ${n & 0x100 ? '100–1FF' : '000–0FF'}.`, 'error'); return null; }
    const p = nearestEntrance(this.rom, px, py, (this.level.secondary.verticalPositioning & 1) !== 0, this.level.header.screens - 1);
    this.editSecondaryEntrance(idx, `Secondary entrance ${hex(idx, 3)} created`, (e) => {
      e.destLevel = n & 0xff; e.screen = p.screen; e.entranceX = p.ex; e.entranceY = p.ey;
    });
    this.selectEntrance({ kind: 'sec', index: idx });
    return idx;
  }

  // clears a secondary entrance (all bytes 0: free again)
  removeSecondaryEntrance(idx: number): void {
    this.romEdit(`Secondary entrance ${hex(idx, 3)} removed`, () => {
      writeSecondaryEntrance(this.rom, idx, { destLevel: 0, entranceY: 0, fgInitY: 0, bgInitY: 0, entranceX: 0, screen: 0, action: 0, raw3: 0 });
    });
    this.findSecondaryEntrances();
    if (this.exitMarker?.kind === 'sec' && this.exitMarker.index === idx) this.exitMarker = null;
    this.emit('change');
  }

  // moves the main entrance or the midway point to the setting nearest to (px, py), undoable
  placeEntrance(kind: 'main' | 'midway', px: number, py: number): void {
    if (!this.editLevel(() => this.moveMarker({ kind, index: 0, x: 0, y: 0 }, px, py))) return;
    this.selectEntrance({ kind, index: 0 });
  }

  // opens the level an exit leads to and chooses the entrance it arrives at
  gotoExitTarget(e: ScreenExit): void {
    const t = exitTarget(this.rom, this.level.number, e);
    this.openLevel(t.to);
    this.mode = 'exit';
    this.exitMarker = t.entrance >= 0 ? { kind: 'sec', index: t.entrance } : { kind: 'main', index: 0 };
    this.emit('mode');
    this.revealMarker();
  }

  // opens a level and chooses the screen of one of its exits
  gotoExit(level: number, screen: number): void {
    if (level !== this.level.number) this.openLevel(level);
    this.mode = 'exit';
    this.emit('mode');
    this.selectScreen(screen);
    this.reveal = this.vertical ? { x: 128, y: screen * 256 + 128 } : { x: screen * 256 + 128, y: 200 };
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
  // variant images by sprite and position
  spriteKey = '';
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

  ensureSpriteImages(): void {
    const hd = this.level.header;
    // sprite memory: a sprite whose OAM range is too small is captured as the game shows it
    const custom = this.customSprites().map((c) => c.id);
    const key = `${hd.spriteGfx}-${hd.spritePalette}-${this.level.spriteHeader & 0x3f}-${gfxFilesHash(this.rom, this.spriteGfxFiles()).toString(36)}${custom.length ? '-' + custom.map((c) => c.toString(16)).join('.') : ''}`;
    if (key === this.spriteKey) return;
    this.spriteKey = key;
    this.variantQueue = [];
    const map = new Map<number, HTMLCanvasElement>();
    this.spriteThumbs = map;
    const all = [...Array.from({ length: 0xe7 }, (_, i) => i), ...custom]; // as listed in the palette
    const lvNum = this.level.number;
    const bg = this.level.layer2Pointer >> 16 === 0xff ? this.level.layer2Pointer : 0xffd900;
    const header = { ...hd };
    const sh = this.level.spriteHeader;
    const images: [number, SpriteImage][] = [];
    const reads = new RomReads(this.rom.data.length);
    let i = 0;
    const step = () => {
      if (this.spriteKey !== key) return;
      if (i === 0) {
        // i4: with the sprites from $C9 on (shells, groups), failed batches retried one by one; sprites
        // that draw nothing shown by what they spawn
        const stored = this.results.get<[number, SpriteImage][]>(`i4${key}`);
        if (stored) {
          for (const [n, img] of stored) map.set(n, this.spriteCanvas(img));
          this.setBusy('sprites', null);
          this.emit('sprites');
          return;
        }
      }
      this.setBusy('sprites', `Sprite graphics ${Math.min(100, Math.round(i / all.length * 100))} %`);
      const chunk = all.slice(i, i + 6); // one test level load (six sprite slots) per slice
      i += 6;
      const r = this.emu.tracked(() => captureSprites(this.emu, lvNum, header, sh, bg, chunk));
      reads.add(r.reads);
      for (const [n, img] of r.result) { map.set(n, this.spriteCanvas(img)); images.push([n, img]); }
      this.emit('sprites');
      if (i < all.length) this.later('sprites', step);
      else {
        this.results.set(`i4${key}`, images, this.results.fp.deps(reads));
        this.setBusy('sprites', null);
      }
    };
    this.setBusy('sprites', 'Sprite graphics');
    this.cacheReady.then(() => this.later('sprites', step));
  }

  // image of sprite id (see spriteId) at tile (x, y): sprites that start differently depending on their
  // position (see SpriteVariants) get an own image per variant, captured in the background once known;
  // custom sprites with extra bytes other than 0 one per bytes
  spriteImage(id: number, x: number, y: number, bytes?: number[]): HTMLCanvasElement | undefined {
    const base = this.spriteThumbs?.get(id);
    if (bytes?.some((b) => b)) {
      const img = this.results.get<SpriteImage | null>(this.bytesKey(id, bytes));
      if (img === undefined) this.queueBytesImage(id, bytes);
      return img ? this.spriteCanvas(img) : base;
    }
    const p = this.probes.sprite(id);
    if (!p || p.variants.reps.length < 2) return base;
    const img = this.results.get<SpriteImage | null>(this.variantKey(id, p.variants.reps[variantOf(p.variants, x, y)]));
    if (img === undefined) this.queueVariantImages(id);
    return img ? this.spriteCanvas(img) : base;
  }
  // image of a placed sprite
  spriteImageOf(s: LevelSprite): HTMLCanvasElement | undefined {
    return this.spriteImage(spriteId(s), s.x, s.y, s.extra >= 2 ? s.bytes : undefined);
  }

  private bytesKey(id: number, bytes: number[]): string {
    return `b2${this.spriteKey}:${id}:${bytes.join(',')}`;
  }
  private bytesQueue: { id: number; bytes: number[] }[] = [];
  private queueBytesImage(id: number, bytes: number[]): void {
    const k = this.bytesKey(id, bytes);
    if (this.bytesQueue.some((q) => this.bytesKey(q.id, q.bytes) === k)) return;
    this.bytesQueue.push({ id, bytes: [...bytes] });
    if (this.bytesQueue.length > 1) return;
    const queue = this.bytesQueue, key = this.spriteKey;
    const step = () => {
      if (queue !== this.bytesQueue || key !== this.spriteKey) return;
      const q = queue[0];
      const lv = this.level, bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
      try {
        const r = this.emu.tracked(() => captureSprites(this.emu, lv.number, lv.header, lv.spriteHeader, bg, [q.id], undefined, q.bytes));
        this.results.set(this.bytesKey(q.id, q.bytes), r.result.get(q.id) ?? null, this.results.fp.deps(r.reads));
      } catch (e) { console.error(e); }
      queue.shift();
      this.emit('sprites');
      if (queue.length) this.later('bytes', step);
    };
    this.later('bytes', step);
  }

  private variantKey(num: number, at: { x: number; y: number }): string {
    return `v${this.spriteKey}:${num}:${at.x}:${at.y}`;
  }

  // ROM bytes of GFX file data: emulated results don't depend on them (graphics only reach VRAM);
  // sprite images name the sprite files' content in their key instead
  private gfxMaskMemo: { gen: number; mask: Uint8Array | null } = { gen: -1, mask: null };
  gfxSkipMask(): Uint8Array | null {
    const m = this.gfxMaskMemo;
    if (m.gen !== this.rom.gen) { m.gen = this.rom.gen; m.mask = gfxSkipMask(this.rom); }
    return m.mask;
  }

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

  private queueVariantImages(num: number): void {
    if (this.variantQueue.includes(num)) return;
    this.variantQueue.push(num);
    if (this.variantQueue.length > 1) return;
    const queue = this.variantQueue, key = this.spriteKey;
    const step = () => {
      if (queue !== this.variantQueue || key !== this.spriteKey) return;
      const n = queue[0];
      this.setBusy('variants', `Sprite variants (${queue.length})`);
      const p = this.cachedSprite(n);
      const lv = this.level, bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
      for (const at of p?.variants.reps ?? []) {
        const k = this.variantKey(n, at);
        if (this.results.get(k) !== undefined) continue;
        try {
          const r = this.emu.tracked(() => captureSpriteAt(this.emu, lv.number, lv.header, lv.spriteHeader, bg, n, at.x, at.y));
          this.results.set(k, r.result, this.results.fp.deps(r.reads));
        } catch (e) { console.error(e); }
      }
      queue.shift();
      this.emit('sprites');
      if (queue.length) this.later('variants', step);
      else this.setBusy('variants', null);
    };
    this.later('variants', step);
  }

  // ------------- sprite memory (see spritemem.ts) -------------
  // sprites drawn incompletely because their OAM range is too small, and a sprite memory value
  // that shows all; checked in the background after every change
  spriteMem: SpriteMemState | null = null;
  private spriteMemBase: SpriteMemState | null = null; // the latest check no edit came after (autocorrection compares with it)
  private spriteMemTimer = 0;
  private spriteMemRun = 0;
  private editGen = 0; // counts committed level edits (not undo/redo/loading)
  private usedMem: { gen: number; list: number[] } = { gen: -1, list: [] };

  private scheduleSpriteMem(): void {
    clearTimeout(this.spriteMemTimer);
    this.spriteMemTimer = window.setTimeout(() => this.cacheReady.then(() => this.checkSpriteMem()), 300);
  }

  private checkSpriteMem(): void {
    const lv = this.level, mem = lv.spriteHeader & 0x3f, gen = this.editGen;
    // canonical order: results are stored by index, uids differ between sessions
    const sprites = [...lv.sprites].sort((a, b) => a.x - b.x || a.y - b.y || a.num - b.num || a.extra - b.extra);
    if (this.usedMem.gen !== this.rom.gen) this.usedMem = { gen: this.rom.gen, list: usedSpriteMemory(this.rom) };
    const candidates = this.usedMem.list;
    const key = `sm2${lv.number}:${mem}:${JSON.stringify(lv.header)}:${candidates.join(',')}:${sprites.map((q) => `${q.num}.${q.x}.${q.y}.${q.extra}${q.bytes?.length ? '.' + q.bytes.join('-') : ''}`).join(' ')}`;
    if (this.spriteMem?.key === key) return;
    const run = ++this.spriteMemRun;
    const done = (r: { lost: number[]; suggestion: number | null }) => {
      if (run !== this.spriteMemRun || this.level !== lv) return;
      this.setBusy('spritemem', null);
      const cur = { key, level: lv.number, mem, gen, conflicts: new Set(r.lost.map((i) => sprites[i].uid)), suggestion: r.suggestion };
      this.spriteMem = cur;
      this.emit('sprite-mem');
      if (gen !== this.editGen) return; // edited meanwhile: checked again
      const base = this.spriteMemBase;
      this.spriteMemBase = cur;
      if (base) this.autoSpriteMem(base, cur);
    };
    const stored = this.results.get<{ lost: number[]; suggestion: number | null }>(key);
    if (stored) { done(stored); return; }
    const bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
    const job = spriteMemJob({ emu: this.emu, level: lv.number, header: { ...lv.header }, bgPointer: bg }, mem, candidates, sprites);
    const reads = new RomReads(this.rom.data.length);
    const step = () => {
      if (run !== this.spriteMemRun || this.level !== lv) return;
      const t0 = performance.now();
      try {
        for (;;) {
          const r = this.emu.tracked(() => job.next());
          reads.add(r.reads);
          if (r.result.done) {
            const res = { lost: [...r.result.value.check.conflicts].map((u) => sprites.findIndex((q) => q.uid === u)), suggestion: r.result.value.suggestion };
            this.results.set(key, res, this.results.fp.deps(reads));
            done(res);
            return;
          }
          if (performance.now() - t0 > BG_SLICE) break;
        }
      } catch (e) { console.error(e); this.setBusy('spritemem', null); return; }
      this.later('spritemem', step);
    };
    this.setBusy('spritemem', 'Checking sprite memory');
    this.later('spritemem', step);
  }

  // An edit (committed since the previous check, same sprite memory) that makes further sprites
  // incomplete sets the suggested value, as part of that edit's undo step. A value chosen by hand
  // stays as long as edits add no new conflicts.
  private autoSpriteMem(prev: SpriteMemState, cur: SpriteMemState): void {
    if (prev.level !== cur.level || prev.mem !== cur.mem || prev.gen === cur.gen || cur.suggestion === null) return;
    if (![...cur.conflicts].some((u) => !prev.conflicts.has(u))) return;
    if (this.undoOrder[this.undoOrder.length - 1]?.kind !== 'level') return;
    this.level.spriteHeader = (this.level.spriteHeader & 0xc0) | cur.suggestion;
    this.changed();
    toast(`Sprite memory set to ${hex(cur.suggestion, 2)} so all sprites are shown completely (Ctrl+Z undoes it).`);
    this.emit('level-header');
  }

  // sets the sprite memory value as an own undo step
  setSpriteMemory(m: number): void {
    this.editLevel(() => { this.level.spriteHeader = (this.level.spriteHeader & 0xc0) | (m & 0x3f); });
    this.emit('level-header');
    logMsg(`Sprite memory set to ${hex(m, 2)}`);
  }

  // 8x8 tiles (layer 1 tile numbers) and colors the game keeps rewriting in this level (tile and
  // palette animation), found by emulating some frames; null until known ('animated' when done)
  private animInfo: { render: LevelRender | null; level: number; res: { tiles: Set<number>; colors: Set<number> } | null; timer: number } = { render: null, level: -1, res: null, timer: 0 };
  animated(): { tiles: Set<number>; colors: Set<number> } | null {
    const a = this.animInfo;
    if (a.render === this.render) return this.withOwnAnims(a.res);
    if (!a.timer) a.timer = window.setTimeout(() => {
      a.timer = 0;
      const render = this.render;
      try {
        const r = this.emu.load(this.level.number, this.buildOverrides());
        const frames = this.emu.animationFrames(16, 4);
        const base = (r.ppuRegs[0x0b] & 0x0f) << 13;
        const tiles = new Set<number>(), colors = new Set<number>();
        for (const f of frames) {
          for (let t = 0; t < 0x400; t++) {
            const o = (base + t * 32) & 0xffff;
            for (let b = 0; b < 32; b++) if (f.vram[o + b] !== r.vram[o + b]) { tiles.add(t); break; }
          }
          for (let c = 0; c < 256; c++) if (f.cgram[c * 2] !== r.cgram[c * 2] || f.cgram[c * 2 + 1] !== r.cgram[c * 2 + 1]) colors.add(c);
        }
        a.res = { tiles, colors };
      } catch (e) { console.error(e); a.res = { tiles: new Set(), colors: new Set() }; }
      a.render = render;
      a.level = this.level.number;
      this.emit('animated');
    }, 50);
    return a.level === this.level.number ? this.withOwnAnims(a.res) : null; // same level: the previous result until known
  }
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

  palettesChanged(): void {
    this.spriteKey = '';
    this.ensureSpriteImages();
    this.emit('palettes');
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
    // fall back to object origins (objects that produce no visible tiles)
    for (let i = objs.length - 1; i >= 0; i--) if (objs[i].x === tx && objs[i].y === ty) return objs[i];
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
    if (!out.length) out.push((o.y << 16) | o.x);
    return out;
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
  cachedSprite(num: number): SpriteProbe | undefined {
    return this.results.get(spriteKey(this.level.header.tileset, num));
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
    if (this.levelScan?.key === key) { done(this.levelScan.result); return; }
    const stored = this.results.get<ScanResult>(key);
    if (stored) { done(stored); return; }
    // played in the probe worker
    this.probes.requestScan(run, key, { number: lv.number, ov, vertical, width: this.images.width, height: this.images.height }, (r) => { if (r) done(r); });
  }

  // What the four layer 3 settings do in a tileset (see layer3.ts): the level as edited is loaded
  // with each of them on an own emulator; kept per tileset while the ROM it read is unchanged
  layer3Kinds(tileset: number): Layer3Kind[] {
    const key = `l3k1:${tileset}`;
    const stored = this.results.get<Layer3Kind[]>(key);
    if (stored) return stored;
    const lv = this.level, ov = this.buildOverrides();
    if (tileset !== lv.header.tileset) ov.layer1 = serializeLayer1(this.rom, { ...lv, header: { ...lv.header, tileset } });
    const emu = this.layer3Emu = this.auxEmu(this.layer3Emu);
    const { result, reads } = emu.tracked(() => layer3Kinds(emu, lv.number, ov));
    this.results.set(key, result, this.results.fp.deps(reads));
    return result;
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

  private layer3Emu: LevelEmulator | null = null;

  // a background emulator (new for another ROM) set up from the main one's boot state
  private auxEmu(emu: LevelEmulator | null): LevelEmulator {
    if (!emu || emu.rom !== this.rom) {
      emu = new LevelEmulator(this.rom);
      emu.skipMask = () => this.gfxSkipMask();
    }
    emu.adoptBoot(this.emu);
    return emu;
  }

  // ------------- jump arcs (see jumparcs.ts) -------------
  // arcs from a tile of the current level as edited, by tile (ty << 16 | tx); emulated in the
  // background on an own emulator, the latest request first; 'arcs' when some are ready
  arcCache = new Map<number, JumpArc[]>();
  private arcs: JumpArcs | null = null;
  private arcLevel: Level | null = null; // the level state the arc emulator is prepared for
  private arcWant: { tx: number; ty: number; done: JumpArc[] } | null = null;
  private arcsWaiting = false; // for the run speeds probe

  jumpArcs(tx: number, ty: number): JumpArc[] | undefined {
    const k = (ty << 16) | tx, c = this.arcCache.get(k);
    if (c) return c;
    if (this.arcWant?.tx !== tx || this.arcWant.ty !== ty) this.arcWant = { tx, ty, done: [] };
    this.later('arcs', () => this.runArcs());
    return undefined;
  }

  private runArcs(): void {
    const want = this.arcWant;
    if (!want) return;
    const t0 = performance.now();
    try {
      if (!this.arcs || this.arcs.emu.rom !== this.rom) {
        this.arcs = new JumpArcs(this.rom, this.emu);
        this.arcs.emu.skipMask = () => this.gfxSkipMask();
      }
      if (this.arcLevel !== this.level) {
        this.setBusy('arcs', 'Jump arcs');
        const lv = this.level;
        this.arcLevel = this.arcs.prepare(lv.number, this.buildOverrides(), lv.spriteHeader, this.images.height) ? lv : null;
        if (!this.arcLevel) throw new Error('level did not reach gameplay');
      }
      // Mario's run speeds in this tileset: probed first, the arcs continue on 'probes'
      const runs = this.probes.runSpeeds();
      if (runs === null) throw new Error('run speeds not found');
      if (!runs) {
        this.setBusy('arcs', 'Jump arcs');
        if (!this.arcsWaiting) {
          this.arcsWaiting = true;
          this.once('probes', () => { this.arcsWaiting = false; this.later('arcs', () => this.runArcs()); });
        }
        return;
      }
      const all = ARC_SPEEDS.flatMap((sp) => [{ sp, dir: 1 as const }, { sp, dir: -1 as const }]);
      while (want.done.length < all.length && performance.now() - t0 < BG_SLICE) {
        const { sp, dir } = all[want.done.length];
        want.done.push(this.arcs.arc(want.tx, want.ty, sp, dir, runs));
      }
      if (want.done.length < all.length) { this.setBusy('arcs', 'Jump arcs'); this.later('arcs', () => this.runArcs()); return; }
      this.arcCache.set((want.ty << 16) | want.tx, want.done);
    } catch (e) {
      console.error(e);
      this.arcCache.set((want.ty << 16) | want.tx, []);
    }
    if (this.arcWant === want) this.arcWant = null;
    this.setBusy('arcs', null);
    this.emit('arcs');
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
  // An undoable level edit: begun before the level changes, then committed (an undo step; the level is
  // drawn again unless rerender is false) or cancelled (nothing recorded, redo stays; restore: the
  // level as before, after a failed change). For edits spanning several events (dragging).
  beginLevelEdit(): LevelEdit {
    if (this.levelHistory.begin(this.level)) this.levelEditDone();
    const token = ++this.editToken;
    const live = () => token === this.editToken && this.levelHistory.editing;
    return {
      commit: (rerender = true) => {
        if (!live()) return;
        this.commitLevelEdit();
        this.changed(rerender);
      },
      cancel: (restore = false) => {
        if (!live()) return;
        const was = this.levelHistory.cancel();
        if (restore && was) { this.level = was; this.changed(); }
      },
    };
  }
  // A level edit at once: f changes the level, returns false when it changed nothing (cancelled);
  // when it throws, the level is as before and the error passed on. True when committed.
  editLevel(f: () => boolean | void, rerender = true): boolean {
    const e = this.beginLevelEdit();
    let ok: boolean;
    try { ok = f() !== false; } catch (err) { e.cancel(true); throw err; }
    if (ok) e.commit(rerender); else e.cancel();
    return ok;
  }
  private commitLevelEdit(): void {
    if (this.levelHistory.commit()) this.levelEditDone();
  }
  private levelEditDone(): void {
    this.editGen++;
    this.pushOrder('level', this.levelHistory.undoSize);
  }
  private pushOrder(kind: 'level' | 'rom', n: number): void {
    this.undoOrder.push({ kind, n });
    if (this.undoOrder.length > 400) this.undoOrder.shift();
    this.redoOrder = [];
  }
  changed(rerender = true): void {
    this.dirty = true;
    this.graph = null;
    if (rerender) this.refresh();
    this.emit('change');
    this.ensureSpriteImages(); // sprite memory may have changed
    this.scheduleSpriteMem();
  }
  // undoes the latest level or ROM edit
  undo(): void {
    this.commitLevelEdit(); // (an edit still open, e.g. while dragging)
    while (this.undoOrder.length) {
      const o = this.undoOrder.pop()!;
      const len = o.kind === 'level' ? this.levelHistory.undoSize : this.romHistory.undoStack.length;
      if (o.n > len || len === 0) continue; // dropped history (beyond the limit)
      if (o.kind === 'rom') { if (this.romStep(true)) this.redoOrder.push('rom'); return; }
      this.levelUndo();
      this.redoOrder.push('level');
      return;
    }
    if (this.levelHistory.undoSize) this.levelUndo();
    else toast('Nothing to undo');
  }
  redo(): void {
    this.commitLevelEdit();
    while (this.redoOrder.length) {
      const k = this.redoOrder.pop()!;
      if (k === 'rom') {
        if (!this.romHistory.redoStack.length) continue;
        if (this.romStep(false)) this.undoOrder.push({ kind: 'rom', n: this.romHistory.undoStack.length });
        return;
      }
      if (!this.levelHistory.redoSize) continue;
      this.levelRedo();
      this.undoOrder.push({ kind: 'level', n: this.levelHistory.undoSize });
      return;
    }
    if (this.levelHistory.redoSize) this.levelRedo();
  }
  private levelUndo(): void {
    const prev = this.levelHistory.undo(this.level);
    if (!prev) return;
    this.level = prev;
    this.changed();
  }
  private levelRedo(): void {
    const next = this.levelHistory.redo(this.level);
    if (!next) return;
    this.level = next;
    this.changed();
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
    const recompose = (this.level.layer2Objects || m === 'bg' || this.mode === 'bg') && this.show.ghost && m !== this.mode;
    this.mode = m;
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

  clampObject(o: { x: number; y: number }): void {
    const w = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.width : this.levelWidthTiles();
    const hgt = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.height : this.levelHeightTiles();
    o.x = Math.max(0, Math.min(w - 1, o.x));
    o.y = Math.max(0, Math.min(Math.min(hgt, this.vertical ? 0x1ff : 0x1f + 1) - 1, o.y));
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
        if (p.struct !== undefined) o.struct = p.struct;
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

  // ------------- structures (structs.ts) -------------
  structures(): Map<number, Structure> {
    return listStructures(this.rom);
  }

  // what the selected objects left in the level as a block of tiles; cells of other objects are
  // transparent, empty rows and columns at the border are cut off
  structureFromSelection(): { x: number; y: number; w: number; h: number; tiles: number[] } | string {
    const objs = this.selectedObjects();
    if (!objs.length || (this.mode !== 'l1' && this.mode !== 'l2')) return 'Select objects in the level first (layer 1 or 2).';
    const l2 = this.mode === 'l2';
    const g = l2 ? this.images.geom2 : this.images.geom1;
    if (!g) return 'Layer without objects';
    const all = this.currentObjects();
    const keys = new Set(objs.map((o) => this.objectKey(l2, all.indexOf(o))));
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const cells = new Map<number, number>();
    for (const o of objs) for (const t of this.objectTiles(o)) {
      const x = t & 0xffff, y = t >> 16;
      const a = g.addr(x, y);
      if (a < 0 || !keys.has(this.render.owner[a - MAP_BASE])) continue;
      cells.set(t, map16Tile(this.render.wram, a));
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (x1 < 0) return 'The selected objects have no visible tiles.';
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w > STRUCT_MAX || h > STRUCT_MAX) return `Selection is ${w}×${h} tiles, a structure can be at most ${STRUCT_MAX}×${STRUCT_MAX}.`;
    const tiles = Array.from({ length: w * h }, (_, i) => cells.get(((y0 + Math.floor(i / w)) << 16) | (x0 + (i % w))) ?? TRANSPARENT);
    return { x: x0, y: y0, w, h, tiles };
  }

  // after the structure table changed: the emulator sees the new ROM, the level is drawn again
  structuresChanged(): void {
    this.romWritten();
    this.refresh();
    this.emit('structs');
    this.emit('change');
  }

  // stores the selection as structure n; replace: the selected objects become one structure object
  // (at the place of the last of them in the object list, so objects in between still cover it)
  saveSelectionAsStructure(n: number, name: string, replace: boolean): boolean {
    const r = this.structureFromSelection();
    if (typeof r === 'string') { toast(r, 'error'); return false; }
    try {
      writeStructure(this.rom, n, { w: r.w, h: r.h, tiles: r.tiles, name });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    if (replace) {
      this.editLevel(() => {
        const all = this.currentObjects();
        const at = Math.max(...this.selectedObjects().map((o) => all.indexOf(o)));
        const o: LevelObject = { uid: newUid(), num: 0, ext: STRUCT_EXT, x: r.x, y: r.y, size: 0, struct: n };
        const res = [...all.slice(0, at + 1).filter((x) => !this.selection.has(x.uid)), o, ...all.slice(at + 1)];
        if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
        this.selection = new Set([o.uid]);
      }, false); // (drawn by structuresChanged)
    }
    this.paletteItem = { kind: 'obj', num: 0, ext: STRUCT_EXT, size: 0, struct: n };
    this.structuresChanged();
    return true;
  }

  // levels whose saved data uses structure n (plus the open level with its unsaved changes)
  structureUsers(n: number): number[] {
    const out: number[] = [];
    const uses = (lv: { objects: LevelObject[]; layer2Objects: LevelObject[] | null }) =>
      [...lv.objects, ...(lv.layer2Objects ?? [])].some((o) => o.num === 0 && o.ext === STRUCT_EXT && o.struct === n);
    for (const i of this.usedLevels()) {
      try { if (uses(i === this.level.number ? this.level : loadLevel(this.rom, i))) out.push(i); } catch { /* unreadable level */ }
    }
    return out;
  }

  // a structure object becomes one Direct-Map16 object per tile, at its place in the object list
  explodeStructure(o: LevelObject): void {
    const s = o.struct !== undefined ? readStructure(this.rom, o.struct) : null;
    if (!s) { toast('The structure does not exist (anymore).', 'error'); return; }
    this.editLevel(() => {
      const parts: LevelObject[] = [];
      s.tiles.forEach((t, i) => { if (t !== TRANSPARENT) parts.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: o.x + (i % s.w), y: o.y + Math.floor(i / s.w), size: 0, tile: t }); });
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
    try {
      const log = saveLevel(this.rom, this.level);
      this.dirty = false;
      const n = this.level.number;
      // re-read to refresh addresses/sizes, keep selection by position
      const sel = this.selection;
      const mode = this.mode;
      this.level = loadLevel(this.rom, n);
      this.mode = mode;
      this.selection = sel;
      this.romWritten();
      if (!silent) toast(`Level ${hex(n, 3)} saved. ${log.join(' · ')}`);
      else logMsg(`Level ${hex(n, 3)} saved automatically. ${log.join(' · ')}`);
      this.refresh();
      this.emit('change');
    } catch (e) {
      toast(`Save failed: ${e}`, 'error');
    }
  }

  // ------------- ROM edits (graphics workspace) -------------
  // runs an undoable ROM edit; the level is re-emulated shortly after the last one of a series
  romEdit<T>(label: string, fn: () => T, key: string | null = null): T {
    const h = this.romHistory, pushes = h.pushes;
    try {
      return h.edit(label, fn, key);
    } finally {
      if (!h.open) {
        if (h.pushes !== pushes) this.pushOrder('rom', h.undoStack.length);
        this.romChanged();
      }
    }
  }

  // romEdit for a change that awaits (AddmusicK inserting songs): one undo step for all of it
  async romEditAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const h = this.romHistory, pushes = h.pushes;
    h.begin(label);
    try {
      return await fn();
    } finally {
      h.commit();
      if (!h.open) {
        if (h.pushes !== pushes) this.pushOrder('rom', h.undoStack.length);
        this.romChanged();
      }
    }
  }

  // Whoever writes the ROM tells it with one of these two (emulators and caches follow rom.gen by
  // themselves; this is for the editor's views and the copy in the browser):
  // romWritten – written outside the ROM history (saving a level, the overworld, messages …): editors
  // show it ('rom-change'), the copy in the browser is stored at once;
  romWritten(): void {
    this.romNotice();
    clearTimeout(this.persistTimer);
    this.persistTimer = 0;
    this.persist();
  }
  // romChanged – an undoable ROM edit (romEdit, undo/redo): editors show it at once, the level render and
  // storing follow debounced (edits come in quick succession, e.g. graphics strokes)
  romChanged(): void {
    this.romNotice();
    clearTimeout(this.romTimer);
    const run = () => {
      const wait = this.holdRender ? 150 : this.quietUntil - performance.now();
      if (wait > 0) { this.romTimer = window.setTimeout(run, wait); return; }
      this.romTimer = 0;
      this.refresh();
      setTimeout(() => this.palettesChanged(), 0); // separate task: input gets through in between
    };
    this.romTimer = window.setTimeout(run, 150);
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => { this.persistTimer = 0; this.persist(); }, 1000);
  }
  private romNotice(): void {
    this.graph = null;
    this.emit('rom-change');
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
    this.palettesChanged();
  }

  private romStep(undo: boolean): boolean {
    let e: RomEdit | null;
    try {
      e = undo ? this.romHistory.undo() : this.romHistory.redo();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err), 'error');
      return false;
    }
    if (!e) return false;
    this.romChanged();
    toast(`${undo ? 'Undone' : 'Redone'}: ${e.label}`);
    return true;
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
    const used = new Set<number>();
    for (let i = 0; i <= 0x24; i++) used.add(i);
    for (let i = 0x101; i <= 0x13b; i++) used.add(i);
    for (let i = 0; i < 512; i++) if (snesToPc(this.rom.r24(L1_PTRS + i * 3)) >= 0x80000) used.add(i);
    return used;
  }
}

export { hasLayer2Objects, SEC_HDR };

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
