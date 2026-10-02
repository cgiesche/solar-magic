// Application state and editing actions.

import { Rom, snesToPc } from '../core/rom.ts';
import { LevelEmulator, OV_L1, OV_L2, type LevelRender, type LevelOverride, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, loadLevel, serializeLayer1, serializeLayer2, serializeSprites,
  isL1Vertical, cloneLevel, newUid, hasLayer2Objects, hasObjects, L1_PTRS, L2_PTRS, SEC_HDR,
  readSecondaryEntrance, writeSecondaryEntrance, entrancePos, nearestEntrance, encodeSecondaryHeader,
} from '../core/level.ts';
import { hex } from '../core/names.ts';
import { renderLevel, type LevelImages, composite, map16Source } from '../core/render.ts';
import { EXT_FIRST, map16Ext, installMap16Ext } from '../core/map16ext.ts';
import { saveLevel } from '../core/save.ts';
import { captureSprites, captureSpriteAt, type SpriteImage } from '../core/spritegfx.ts';
import { DM16_EXT, hasEditorPatch, installEditorPatch, levelGfx, defaultGfx } from '../core/patches.ts';
import { gfxSkipMask, gfxFilesHash } from '../core/gfxpages.ts';
import { STRUCT_EXT, STRUCT_MAX, TRANSPARENT, listStructures, readStructure, writeStructure, type Structure } from '../core/structs.ts';
import { kvSet, kvGet, kvEntries, kvKeys, kvWrite } from './storage.ts';
import { ResultCache, RomFingerprint, RomReads, type CacheEntry } from '../core/romdeps.ts';
import { bgFromWram, bgIndex, encodeBg } from '../core/bg.ts';
import { toast } from './dom.ts';
import { RomHistory, type RomEdit } from '../core/romhistory.ts';
import { ObjKindProbe, kindsStillValid, storeKinds, loadKinds, resizeObjectSize, type ObjKind, type ObjKinds, type StoredObjKinds } from '../core/objkinds.ts';
import { BlockProber, variantOf, type BlockProbe, type SpriteProbe } from '../core/blockprobe.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg';
export type PaletteItem =
  // block: a rectangle of Map16 tiles from the palette sheet (tile + row * 16 + col), one Direct-Map16 object each
  // struct: structure number (extended object $03, see structs.ts)
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number; block?: { w: number; h: number }; struct?: number }
  | { kind: 'spr'; num: number; extra: number };

type Listener = () => void;

const CACHE_PREFIX = 'rc2:'; // IndexedDB keys of the result cache (bump when result formats change)
const PROBE_SPRITE = 0x10000; // probe queue key flag: sprite number instead of Map16 tile
const SPRITE_PROBE_END = 0xc9; // sprites from $C9 on are shooters, generators and run-once sprites

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
  show = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: false, items: true };
  // view-only game state applied before the emulated level load
  switches = { palaces: false, onOff: false };
  dirty = false;
  undoStack: Level[] = [];
  redoStack: Level[] = [];
  // undo for ROM edits of the graphics workspace (palettes, Map16, GFX, slot assignments)
  romHistory: RomHistory;
  wsTile = 0; // Map16 tile for 'open-map16' (opens the graphics workspace there)
  wsTileBg = false; // wsTile is a BG tile
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
  listeners = new Map<string, Set<Listener>>();
  renderError: string | null = null;
  // block behaviour probes (emulated hits), run in the background
  prober: BlockProber | null = null;
  proberGen = -1;
  probeQueue: number[] = []; // Map16 tiles; sprites as PROBE_SPRITE | num
  prefetchQueue = new Set<number>(); // the same, probed when probeQueue is empty
  probeFailed = new Set<number>();
  probeScheduled = false;
  probeChannel: MessageChannel | null = null; // yields between probe slices (setTimeout is throttled in hidden tabs)
  exitScreen = 0;
  spriteThumbs: Map<number, HTMLCanvasElement> | null = null;
  variantQueue: number[] = []; // sprites whose variant images are captured next
  private canvases = new WeakMap<SpriteImage, HTMLCanvasElement>();
  // results found out by emulation, valid while the ROM they read is unchanged (see romdeps.ts);
  // stored in IndexedDB, loaded once at start (cacheReady)
  results: ResultCache;
  cacheReady: Promise<void>;
  private cacheTimer = 0;
  // what the settings byte nibbles of standard objects mean, per tileset (emulated, see objkinds.ts)
  kinds = new Map<number, { k: ObjKinds; gen: number }>();
  kindJob: { ts: number; probe: ObjKindProbe | null } | null = null;
  kindChannel: MessageChannel | null = null;
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
    this.romHistory = new RomHistory(rom);
    this.results = new ResultCache(new RomFingerprint(this.emu));
    this.cacheReady = kvEntries<CacheEntry>(CACHE_PREFIX)
      .then((e) => this.results.load(e.map(([k, v]) => [k.slice(CACHE_PREFIX.length), v])))
      .catch((e) => console.error(e));
    // results of older formats
    kvKeys('rc').then((k) => kvWrite([], k.filter((x) => !x.startsWith(CACHE_PREFIX)))).catch(() => {});
    this.results.onChange = () => {
      if (!this.cacheTimer) this.cacheTimer = window.setTimeout(() => this.storeResults(), 3000);
    };
    window.addEventListener('pagehide', () => { if (this.cacheTimer) { clearTimeout(this.cacheTimer); this.storeResults(); } });
  }

  private storeResults(): void {
    this.cacheTimer = 0;
    const { put, del } = this.results.flush();
    kvWrite(put.map(([k, v]) => [CACHE_PREFIX + k, v]), del.map((k) => CACHE_PREFIX + k)).catch((e) => console.error(e));
  }

  on(ev: string, fn: Listener): void {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
  }
  emit(ev: string): void {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  // background jobs currently running (key -> label), shown by the busy indicator
  busy = new Map<string, string>();
  setBusy(key: string, label: string | null): void {
    if (label === null ? !this.busy.delete(key) : this.busy.get(key) === label) return;
    if (label !== null) this.busy.set(key, label);
    this.emit('busy');
  }

  // ------------- level loading / rendering -------------
  openLevel(n: number): void {
    if (this.level && this.dirty) this.saveLevel(true);
    this.level = loadLevel(this.rom, n);
    this.prober?.use(this.level.header.tileset);
    this.selection.clear();
    if ((this.mode === 'l2' && !this.level.layer2Objects) || (this.mode === 'bg' && !this.canEditBg())) this.mode = 'l1';
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.refresh();
    this.emit('level');
    this.ensureSpriteImages();
    this.prefetchProbes();
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
      sprites: serializeSprites(lv.sprites, lv.spriteHeader, this.vertical),
      byteOwner,
      switchPalaces: this.switches.palaces,
      onOffSwitch: this.switches.onOff,
      secondaryHeader: encodeSecondaryHeader(lv.secondary),
    };
  }

  refresh(): void {
    const lv = this.level;
    const r = this.emu.load(lv.number, this.buildOverrides());
    this.renderError = r.ok ? null : r.error ?? 'Fehler';
    this.anim.snaps = this.show.anim && r.ok ? this.emu.animationFrames() : [];
    this.render = r;
    this.images = renderLevel(this.rom, r, lv.header.mode, lv.header.screens);
    this.compositeImg = this.compose();
    this.buildOffsetMaps();
    this.findSecondaryEntrances();
    this.startAnimation();
    this.emit('render');
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
      this.setBusy('anim', `Animationen ${i + 1}/${snaps.length}`);
      const li = renderLevel(this.rom, { ...this.render, vram: snaps[i].vram, cgram: snaps[i].cgram }, lv.header.mode, lv.header.screens);
      const img = this.compose(li);
      const idx: number[] = [];
      for (let k = 0; k < img.length; k++) if (img[k] !== base[k]) idx.push(k);
      const ix = Uint32Array.from(idx);
      a.frames.push({ idx: ix, val: ix.map((k) => img[k]) });
      if (++i < snaps.length) setTimeout(step, 0);
      else this.setBusy('anim', null);
      if (i === snaps.length && !a.timer) a.timer = window.setInterval(() => this.animTick(), 1000 / 7.5);
    };
    setTimeout(step, 0);
  }

  animTick(): void {
    const a = this.anim;
    if (!a.frames.length || !a.base) return;
    if (!this.show.anim) { clearInterval(a.timer); a.timer = 0; return; }
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
      this.romEdit(`Sekundärer Eingang ${hex(m.index, 3)} verschoben`, () => writeSecondaryEntrance(this.rom, m.index, e), `sec-entrance:${m.index}`);
    }
    return true;
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
  ensureSpriteImages(): void {
    const hd = this.level.header;
    const key = `${hd.spriteGfx}-${hd.spritePalette}-${gfxFilesHash(this.rom, this.spriteGfxFiles()).toString(36)}`;
    if (key === this.spriteKey) return;
    this.spriteKey = key;
    this.variantQueue = [];
    const map = new Map<number, HTMLCanvasElement>();
    this.spriteThumbs = map;
    const all = Array.from({ length: 0xc9 }, (_, i) => i);
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
        const stored = this.results.get<[number, SpriteImage][]>(`i${key}`);
        if (stored) {
          for (const [n, img] of stored) map.set(n, this.spriteCanvas(img));
          this.setBusy('sprites', null);
          this.emit('sprites');
          return;
        }
      }
      this.setBusy('sprites', `Sprite-Grafiken ${Math.min(100, Math.round(i / all.length * 100))} %`);
      const chunk = all.slice(i, i + 12);
      i += 12;
      const r = this.emu.tracked(() => captureSprites(this.emu, lvNum, header, sh, bg, chunk));
      reads.add(r.reads);
      for (const [n, img] of r.result) { map.set(n, this.spriteCanvas(img)); images.push([n, img]); }
      this.emit('sprites');
      if (i < all.length) setTimeout(step, 0);
      else {
        this.results.set(`i${key}`, images, this.results.fp.deps(reads));
        this.setBusy('sprites', null);
      }
    };
    this.setBusy('sprites', 'Sprite-Grafiken');
    this.cacheReady.then(() => setTimeout(step, 0));
  }

  // image of sprite num at tile (x, y): sprites that start differently depending on their position
  // (see SpriteVariants) get an own image per variant, captured in the background once known
  spriteImage(num: number, x: number, y: number): HTMLCanvasElement | undefined {
    const base = this.spriteThumbs?.get(num);
    const p = this.spriteInfo(num);
    if (!p || p.variants.reps.length < 2) return base;
    const img = this.results.get<SpriteImage | null>(this.variantKey(num, p.variants.reps[variantOf(p.variants, x, y)]));
    if (img === undefined) this.queueVariantImages(num);
    return img ? this.spriteCanvas(img) : base;
  }

  private variantKey(num: number, at: { x: number; y: number }): string {
    return `v${this.spriteKey}:${num}:${at.x}:${at.y}`;
  }

  // ROM bytes of GFX file data: emulated results don't depend on them (graphics only reach VRAM);
  // sprite images name the sprite files' content in their key instead
  private gfxMaskMemo: { gen: number; data: Uint8Array | null; mask: Uint8Array | null } = { gen: -1, data: null, mask: null };
  gfxSkipMask(): Uint8Array | null {
    const m = this.gfxMaskMemo;
    if (m.gen !== this.emu.romGen || m.data !== this.rom.data) { m.gen = this.emu.romGen; m.data = this.rom.data; m.mask = gfxSkipMask(this.rom); }
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
      this.setBusy('variants', `Sprite-Varianten (${queue.length})`);
      const p = this.prober?.cachedSprite(n);
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
      if (queue.length) setTimeout(step, 0);
      else this.setBusy('variants', null);
    };
    setTimeout(step, 0);
  }

  // 8x8 tiles (layer 1 tile numbers) and colors the game keeps rewriting in this level (tile and
  // palette animation), found by emulating some frames; null until known ('animated' when done)
  private animInfo: { render: LevelRender | null; level: number; res: { tiles: Set<number>; colors: Set<number> } | null; timer: number } = { render: null, level: -1, res: null, timer: 0 };
  animated(): { tiles: Set<number>; colors: Set<number> } | null {
    const a = this.animInfo;
    if (a.render === this.render) return a.res;
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
    return a.level === this.level.number ? a.res : null; // same level: the previous result until known
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
      out.add(this.render.wram[a] | (this.render.wram[a + 0x10000] << 8));
    }
    return [...out].sort((a, b) => a - b);
  }

  // What a Map16 tile does when hit from below. Unknown tiles are probed in the background;
  // 'blockinfo' is emitted once queued probes are done.
  blockInfo(tile: number): BlockProbe | undefined {
    const pr = this.blockProber();
    const p = pr.cached(tile);
    if (!p) this.queueProbe(tile);
    return p;
  }

  // the same for a sprite hit from below (normal sprites only, not shooters/generators)
  spriteInfo(num: number): SpriteProbe | undefined {
    if (num >= SPRITE_PROBE_END) return undefined;
    const pr = this.blockProber();
    const p = pr.cachedSprite(num);
    if (!p) this.queueProbe(PROBE_SPRITE | num);
    return p;
  }

  // kind of a standard object in the current tileset; null while unknown (then treated as plain)
  objectKind(num: number): ObjKind | null {
    if (num === 0) return null;
    return this.tilesetKinds()?.kinds.get(num) ?? null;
  }

  tilesetKinds(ts = this.level.header.tileset): ObjKinds | null {
    const c = this.kinds.get(ts);
    if (c && c.gen !== this.emu.romGen) {
      if (kindsStillValid(c.k, this.rom.data)) c.gen = this.emu.romGen;
      else this.kinds.delete(ts);
    }
    if (this.kinds.has(ts)) return c!.k;
    this.startKindJob(ts);
    return null;
  }

  // stored result first (valid while the ROM bytes it depends on are unchanged), otherwise emulate
  // in slices between UI work, on an own emulator (the main one keeps the animation state)
  private startKindJob(ts: number): void {
    if (this.kindJob) return;
    const job: { ts: number; probe: ObjKindProbe | null } = { ts, probe: null };
    this.kindJob = job;
    kvGet<StoredObjKinds>(`objkinds-${ts}`).catch(() => undefined).then((st) => {
      const k = st && loadKinds(st);
      if (k && kindsStillValid(k, this.rom.data)) { this.setKinds(ts, k); return; }
      this.setBusy('kinds', 'Objektarten');
      const emu = new LevelEmulator(this.rom);
      emu.baseState = this.emu.baseState;
      emu.skipMask = () => this.gfxSkipMask();
      const lv = { ...this.level, header: { ...this.level.header, tileset: ts } };
      job.probe = new ObjKindProbe(emu, lv, this.level.layer2Objects ? this.rom.r24(L2_PTRS + 0x105 * 3) : this.level.layer2Pointer);
      if (!this.kindChannel) {
        this.kindChannel = new MessageChannel();
        this.kindChannel.port1.onmessage = () => this.runKindJob();
      }
      this.kindChannel.port2.postMessage(0);
    });
  }

  private runKindJob(): void {
    const j = this.kindJob;
    if (!j?.probe) return;
    const t0 = performance.now();
    try {
      while (!j.probe.done && performance.now() - t0 < 30) j.probe.step();
      if (!j.probe.done) { this.kindChannel!.port2.postMessage(0); return; }
      const k = j.probe.result();
      kvSet(`objkinds-${j.ts}`, storeKinds(k)).catch(() => {});
      this.setKinds(j.ts, k);
    } catch (e) {
      console.error(e);
      this.setKinds(j.ts, { kinds: new Map(), deps: new Map() });
    }
  }

  private setKinds(ts: number, k: ObjKinds): void {
    this.kinds.set(ts, { k, gen: this.emu.romGen });
    this.kindJob = null;
    this.setBusy('kinds', null);
    this.emit('objkinds');
  }

  private blockProber(): BlockProber {
    if (!this.prober || this.prober.rom !== this.rom) {
      this.prober = new BlockProber(this.rom, { state: this.emu.baseState, reads: this.emu.bootReads }, this.results);
      this.prober.emu.skipMask = () => this.gfxSkipMask();
      this.proberGen = this.emu.romGen;
    }
    if (this.proberGen !== this.emu.romGen) {
      this.prober.reset();
      this.probeFailed.clear();
      this.proberGen = this.emu.romGen;
      setTimeout(() => this.prefetchProbes(), 0); // results that read changed ROM data are redone
    }
    this.prober.use(this.level.header.tileset);
    return this.prober;
  }

  private queueProbe(k: number): void {
    if (this.probeFailed.has(k)) return;
    if (!this.probeQueue.includes(k)) this.probeQueue.push(k);
    this.prefetchQueue.delete(k);
    this.probeBusy();
    this.scheduleProbes();
  }

  // Probes everything the palette tabs can show (Map16 tiles 000-1FF, the objects' tiles, all
  // sprites) in the background, after what is asked for directly; results go to the cache, so
  // this runs once per tileset and ROM state.
  prefetchProbes(tiles: Iterable<number> = []): void {
    this.cacheReady.then(() => {
      const pr = this.blockProber();
      const add = (k: number, known: unknown) => { if (!known && !this.probeFailed.has(k) && !this.probeQueue.includes(k)) this.prefetchQueue.add(k); };
      for (const t of tiles) add(t, pr.cached(t));
      for (let t = 0; t < 0x200; t++) add(t, pr.cached(t));
      for (let n = 0; n < SPRITE_PROBE_END; n++) add(PROBE_SPRITE | n, pr.cachedSprite(n));
      if (!this.prefetchQueue.size) return;
      this.probeBusy();
      this.scheduleProbes();
    });
  }

  private probeBusy(): void {
    const n = this.probeQueue.length + this.prefetchQueue.size;
    this.setBusy('probe', n ? `Blockverhalten (${n})` : null);
  }

  private scheduleProbes(): void {
    if (this.probeScheduled) return;
    this.probeScheduled = true;
    if (!this.probeChannel) {
      this.probeChannel = new MessageChannel();
      this.probeChannel.port1.onmessage = () => this.runProbes();
    }
    this.cacheReady.then(() => this.probeChannel!.port2.postMessage(0));
  }

  // requested probes first, then prefetched ones; 'blockinfo' when either queue runs empty
  private runProbes(): void {
    this.probeScheduled = false;
    const t0 = performance.now();
    const hadAsked = this.probeQueue.length > 0, hadPrefetch = this.prefetchQueue.size > 0;
    while ((this.probeQueue.length || this.prefetchQueue.size) && performance.now() - t0 < 30) {
      let t: number;
      if (this.probeQueue.length) t = this.probeQueue.shift()!;
      else { t = this.prefetchQueue.values().next().value!; this.prefetchQueue.delete(t); }
      try {
        if (t & PROBE_SPRITE) this.prober?.probeSprite(t & 0xff); else this.prober?.probe(t);
      } catch (e) { console.error(e); this.probeFailed.add(t); }
    }
    this.probeBusy();
    if (this.probeQueue.length || this.prefetchQueue.size) this.scheduleProbes();
    if ((hadAsked && !this.probeQueue.length) || (hadPrefetch && !this.prefetchQueue.size)) this.emit('blockinfo');
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
    const img = this.spriteImage(s.num, s.x, s.y);
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
  checkpoint(): void {
    this.undoStack.push(cloneLevel(this.level));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.pushOrder('level', this.undoStack.length);
  }
  private pushOrder(kind: 'level' | 'rom', n: number): void {
    this.undoOrder.push({ kind, n });
    if (this.undoOrder.length > 400) this.undoOrder.shift();
    this.redoOrder = [];
  }
  changed(rerender = true): void {
    this.dirty = true;
    if (rerender) this.refresh();
    this.emit('change');
  }
  // undoes the latest level or ROM edit
  undo(): void {
    while (this.undoOrder.length) {
      const o = this.undoOrder.pop()!;
      const len = o.kind === 'level' ? this.undoStack.length : this.romHistory.undoStack.length;
      if (o.n > len || len === 0) continue; // cancelled checkpoint or dropped history
      if (o.kind === 'rom') { if (this.romStep(true)) this.redoOrder.push('rom'); return; }
      this.levelUndo();
      this.redoOrder.push('level');
      return;
    }
    if (this.undoStack.length) this.levelUndo();
    else toast('Nichts rückgängig zu machen');
  }
  redo(): void {
    while (this.redoOrder.length) {
      const k = this.redoOrder.pop()!;
      if (k === 'rom') {
        if (!this.romHistory.redoStack.length) continue;
        if (this.romStep(false)) this.undoOrder.push({ kind: 'rom', n: this.romHistory.undoStack.length });
        return;
      }
      if (!this.redoStack.length) continue;
      this.levelRedo();
      this.undoOrder.push({ kind: 'level', n: this.undoStack.length });
      return;
    }
    if (this.redoStack.length) this.levelRedo();
  }
  private levelUndo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneLevel(this.level));
    this.level = prev;
    this.changed();
  }
  private levelRedo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneLevel(this.level));
    this.level = next;
    this.changed();
  }

  setMode(m: EditMode, selection: Iterable<number> = []): void {
    if (m === 'l2' && !this.level.layer2Objects) {
      toast('Dieses Level hat keine Layer-2-Objekte (Layer 2 ist Hintergrund, Modus BG).');
      return;
    }
    if (m === 'bg' && !this.canEditBg()) {
      toast('Dieses Level hat Layer-2-Objekte statt einer BG-Tilemap.');
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
    return this.level.bg ? this.level.bg[o] : this.render.wram[0xb900 + o] | (this.render.wram[0xbd00 + o] << 8);
  }
  // sets one BG tile (the map repeats, so all copies change); caller handles checkpoint/refresh
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
    if (!p) { toast('Zuerst ein Objekt/Sprite in der Palette wählen.'); return; }
    this.checkpoint();
    if (p.kind === 'obj' && (this.mode === 'l1' || this.mode === 'l2')) {
      if (p.num === 0 && p.ext === DM16_EXT && !this.ensureEditorPatch()) { this.undoStack.pop(); return; }
      const cells = p.block ? Array.from({ length: p.block.w * p.block.h }, (_, i) => ({ dx: i % p.block!.w, dy: Math.floor(i / p.block!.w) })) : [{ dx: 0, dy: 0 }];
      const lastTile = (p.tile ?? 0) + (p.block ? (p.block.h - 1) * 16 + p.block.w - 1 : 0);
      if (p.num === 0 && p.ext === DM16_EXT && lastTile >= EXT_FIRST && !map16Ext(this.rom)) {
        installMap16Ext(this.rom, map16Source(this.rom, this.render).fg(0x025));
        this.emu.syncRom();
        this.persist();
        toast('Map16-Erweiterung installiert (Tiles 200–FFF).');
      }
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
      this.level.sprites.push(s);
      this.selection = new Set([s.uid]);
    } else {
      this.undoStack.pop();
      return;
    }
    this.changed();
  }

  // Direct-Map16 objects need the editor patch; installs it, false if that is not possible
  ensureEditorPatch(): boolean {
    if (hasEditorPatch(this.rom)) return true;
    try {
      installEditorPatch(this.rom);
      this.emu.syncRom();
      this.persist();
      toast('Editor-Patch installiert (für Direct-Map16-Objekte).');
      return true;
    } catch (e) { toast(String(e), 'error'); return false; }
  }

  // ------------- structures (structs.ts) -------------
  structures(): Map<number, Structure> {
    return listStructures(this.rom);
  }

  // what the selected objects left in the level as a block of tiles; cells of other objects are
  // transparent, empty rows and columns at the border are cut off
  structureFromSelection(): { x: number; y: number; w: number; h: number; tiles: number[] } | string {
    const objs = this.selectedObjects();
    if (!objs.length || (this.mode !== 'l1' && this.mode !== 'l2')) return 'Zuerst Objekte im Level auswählen (Layer 1 oder 2).';
    const l2 = this.mode === 'l2';
    const g = l2 ? this.images.geom2 : this.images.geom1;
    if (!g) return 'Layer ohne Objekte';
    const all = this.currentObjects();
    const keys = new Set(objs.map((o) => this.objectKey(l2, all.indexOf(o))));
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const cells = new Map<number, number>();
    for (const o of objs) for (const t of this.objectTiles(o)) {
      const x = t & 0xffff, y = t >> 16;
      const a = g.addr(x, y);
      if (a < 0 || !keys.has(this.render.owner[a - MAP_BASE])) continue;
      cells.set(t, this.render.wram[a] | (this.render.wram[a + 0x10000] << 8));
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (x1 < 0) return 'Die ausgewählten Objekte haben keine sichtbaren Tiles.';
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w > STRUCT_MAX || h > STRUCT_MAX) return `Auswahl ist ${w}×${h} Tiles groß, eine Struktur höchstens ${STRUCT_MAX}×${STRUCT_MAX}.`;
    const tiles = Array.from({ length: w * h }, (_, i) => cells.get(((y0 + Math.floor(i / w)) << 16) | (x0 + (i % w))) ?? TRANSPARENT);
    return { x: x0, y: y0, w, h, tiles };
  }

  // after the structure table changed: the emulator sees the new ROM, the level is drawn again
  structuresChanged(): void {
    this.emu.syncRom();
    this.persist();
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
      this.checkpoint();
      const all = this.currentObjects();
      const at = Math.max(...this.selectedObjects().map((o) => all.indexOf(o)));
      const o: LevelObject = { uid: newUid(), num: 0, ext: STRUCT_EXT, x: r.x, y: r.y, size: 0, struct: n };
      const res = [...all.slice(0, at + 1).filter((x) => !this.selection.has(x.uid)), o, ...all.slice(at + 1)];
      if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
      this.selection = new Set([o.uid]);
      this.dirty = true;
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
    if (!s) { toast('Die Struktur gibt es nicht (mehr).', 'error'); return; }
    if (!this.ensureEditorPatch()) return;
    if (s.tiles.some((t) => t >= EXT_FIRST) && !map16Ext(this.rom)) { toast('Die Struktur nutzt Tiles ab 200, die Map16-Erweiterung fehlt.', 'error'); return; }
    this.checkpoint();
    const parts: LevelObject[] = [];
    s.tiles.forEach((t, i) => { if (t !== TRANSPARENT) parts.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: o.x + (i % s.w), y: o.y + Math.floor(i / s.w), size: 0, tile: t }); });
    const all = this.currentObjects();
    const at = all.indexOf(o);
    const res = [...all.slice(0, at), ...parts, ...all.slice(at + 1)];
    if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
    this.selection = new Set(parts.map((p) => p.uid));
    this.changed();
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    this.checkpoint();
    if (this.mode === 'spr') this.level.sprites = this.level.sprites.filter((s) => !this.selection.has(s.uid));
    else if (this.mode === 'l2' && this.level.layer2Objects) this.level.layer2Objects = this.level.layer2Objects.filter((o) => !this.selection.has(o.uid));
    else if (this.mode === 'l1') this.level.objects = this.level.objects.filter((o) => !this.selection.has(o.uid));
    this.selection.clear();
    this.changed();
  }

  moveSelection(dx: number, dy: number, withCheckpoint = true): void {
    if (!this.selection.size) return;
    if (withCheckpoint) this.checkpoint();
    const items = this.mode === 'spr' ? this.selectedSprites() : this.selectedObjects();
    for (const o of items) { o.x += dx; o.y += dy; this.clampObject(o); }
    this.changed();
  }

  // resize: width/height nibbles of settings byte
  resizeSelection(dw: number, dh: number): void {
    const objs = this.selectedObjects().filter((o) => o.num !== 0 || o.ext === DM16_EXT);
    if (!objs.length) return;
    this.checkpoint();
    for (const o of objs) o.size = resizeObjectSize(this.objectKind(o.num), o.size, dw, dh);
    this.changed();
  }

  reorderSelection(dir: 'front' | 'back'): void {
    if (this.mode === 'spr' || !this.selection.size) return;
    this.checkpoint();
    const objs = this.currentObjects();
    const sel = objs.filter((o) => this.selection.has(o.uid));
    const rest = objs.filter((o) => !this.selection.has(o.uid));
    const res = dir === 'front' ? [...rest, ...sel] : [...sel, ...rest];
    if (this.mode === 'l2') this.level.layer2Objects = res; else this.level.objects = res;
    this.changed();
  }

  copy(): void {
    if (this.mode === 'spr') this.clipboard = { sprites: structuredClone(this.selectedSprites()) };
    else this.clipboard = { objects: structuredClone(this.selectedObjects()) };
  }
  paste(tx: number, ty: number): void {
    const items = this.mode === 'spr' ? this.clipboard.sprites : this.clipboard.objects;
    if (!items?.length) return;
    this.checkpoint();
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
    this.changed();
  }

  // ------------- saving -------------
  saveLevel(silent = false): void {
    try {
      const log = saveLevel(this.rom, this.level);
      this.emu.syncRom();
      this.dirty = false;
      const n = this.level.number;
      // re-read to refresh addresses/sizes, keep selection by position
      const sel = this.selection;
      const mode = this.mode;
      this.level = loadLevel(this.rom, n);
      this.mode = mode;
      this.selection = sel;
      this.persist();
      if (!silent) toast(`Level ${hex(n, 3)} gespeichert. ${log.join(' · ')}`);
      this.refresh();
      this.emit('change');
    } catch (e) {
      toast(`Speichern fehlgeschlagen: ${e}`, 'error');
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

  // the ROM changed: editors redraw at once ('rom-change'), the level render follows debounced
  romChanged(): void {
    this.emu.syncRom();
    this.emit('rom-change');
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
    toast(`${undo ? 'Rückgängig' : 'Wiederholt'}: ${e.label}`);
    return true;
  }

  editMap16(tile: number, bg = false): void {
    this.wsTile = tile;
    this.wsTileBg = bg;
    this.emit('open-map16');
  }

  persist(): void {
    kvSet('rom', { name: this.romName, data: this.rom.output(false), header: this.rom.smcHeader }).catch(() => {});
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
