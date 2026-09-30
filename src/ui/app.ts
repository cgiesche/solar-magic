// Application state and editing actions.

import { Rom, snesToPc } from '../core/rom.ts';
import { LevelEmulator, OV_L1, OV_L2, type LevelRender, type LevelOverride, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, loadLevel, serializeLayer1, serializeLayer2, serializeSprites,
  isL1Vertical, cloneLevel, newUid, hasLayer2Objects, hasObjects, L1_PTRS, L2_PTRS, SEC_HDR,
  readSecondaryEntrance, writeSecondaryEntrance, entrancePos, nearestEntrance, encodeSecondaryHeader,
} from '../core/level.ts';
import { renderLevel, type LevelImages, composite, map16Source } from '../core/render.ts';
import { EXT_FIRST, map16Ext, installMap16Ext } from '../core/map16ext.ts';
import { saveLevel } from '../core/save.ts';
import { captureSprites } from '../core/spritegfx.ts';
import { DM16_EXT, hasEditorPatch, installEditorPatch } from '../core/patches.ts';
import { kvSet, kvGet } from './storage.ts';
import { bgFromWram, bgIndex, encodeBg } from '../core/bg.ts';
import { toast } from './dom.ts';
import { ObjKindProbe, kindsStillValid, storeKinds, loadKinds, resizeObjectSize, type ObjKind, type ObjKinds, type StoredObjKinds } from '../core/objkinds.ts';
import { BlockProber, type BlockProbe, type SpriteProbe } from '../core/blockprobe.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg';
export type PaletteItem =
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number }
  | { kind: 'spr'; num: number; extra: number };

type Listener = () => void;

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
  bgTile = 0; // BG Map16 tile painted in BG mode
  zoom = 2;
  show = { layer1: true, layer2: true, layer3: true, sprites: true, grid: false, screens: true, exits: true, ghost: true, anim: false, items: true };
  // view-only game state applied before the emulated level load
  switches = { palaces: false, onOff: false };
  dirty = false;
  undoStack: Level[] = [];
  redoStack: Level[] = [];
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
  probeFailed = new Set<number>();
  probeScheduled = false;
  probeChannel: MessageChannel | null = null; // yields between probe slices (setTimeout is throttled in hidden tabs)
  exitScreen = 0;
  spriteThumbs: Map<number, HTMLCanvasElement> | null = null;
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
    this.emu.boot();
  }

  on(ev: string, fn: Listener): void {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
  }
  emit(ev: string): void {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  // ------------- level loading / rendering -------------
  openLevel(n: number): void {
    if (this.level && this.dirty) this.saveLevel(true);
    this.level = loadLevel(this.rom, n);
    this.selection.clear();
    if ((this.mode === 'l2' && !this.level.layer2Objects) || (this.mode === 'bg' && !this.canEditBg())) this.mode = 'l1';
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.refresh();
    this.emit('level');
    this.ensureSpriteImages();
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
    if (!a.snaps.length) { clearInterval(a.timer); a.timer = 0; return; }
    const base = a.base, snaps = a.snaps, lv = this.level;
    let i = 0;
    const step = () => {
      if (gen !== a.gen) return;
      const li = renderLevel(this.rom, { ...this.render, vram: snaps[i].vram, cgram: snaps[i].cgram }, lv.header.mode, lv.header.screens);
      const img = this.compose(li);
      const idx: number[] = [];
      for (let k = 0; k < img.length; k++) if (img[k] !== base[k]) idx.push(k);
      const ix = Uint32Array.from(idx);
      a.frames.push({ idx: ix, val: ix.map((k) => img[k]) });
      if (++i < snaps.length) setTimeout(step, 0);
      else if (!a.timer) a.timer = window.setInterval(() => this.animTick(), 1000 / 7.5);
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
      writeSecondaryEntrance(this.rom, m.index, e);
      this.emu.syncRom();
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
  spriteKey = '';
  ensureSpriteImages(): void {
    const hd = this.level.header;
    const key = `${hd.spriteGfx}-${hd.spritePalette}`;
    if (key === this.spriteKey) return;
    this.spriteKey = key;
    const map = new Map<number, HTMLCanvasElement>();
    this.spriteThumbs = map;
    const all = Array.from({ length: 0xc9 }, (_, i) => i);
    const lvNum = this.level.number;
    const bg = this.level.layer2Pointer >> 16 === 0xff ? this.level.layer2Pointer : 0xffd900;
    const header = { ...hd };
    const sh = this.level.spriteHeader;
    let i = 0;
    const step = () => {
      if (this.spriteKey !== key) return;
      const chunk = all.slice(i, i + 12);
      i += 12;
      const res = captureSprites(this.emu, lvNum, header, sh, bg, chunk);
      for (const [n, img] of res) {
        const c = document.createElement('canvas');
        c.width = img.w; c.height = img.h;
        const ctx = c.getContext('2d')!;
        const id = ctx.createImageData(img.w, img.h);
        new Uint32Array(id.data.buffer).set(img.rgba);
        ctx.putImageData(id, 0, 0);
        c.dataset.ox = String(img.ox);
        c.dataset.oy = String(img.oy);
        map.set(n, c);
      }
      this.emit('sprites');
      if (i < all.length) setTimeout(step, 0);
    };
    setTimeout(step, 50);
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
      const emu = new LevelEmulator(this.rom);
      emu.baseState = this.emu.baseState;
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
    this.emit('objkinds');
  }

  private blockProber(): BlockProber {
    if (!this.prober || this.prober.rom !== this.rom) {
      this.prober = new BlockProber(this.rom, this.emu.baseState);
      this.proberGen = this.emu.romGen;
    }
    if (this.proberGen !== this.emu.romGen) {
      this.prober.reset();
      this.probeFailed.clear();
      this.proberGen = this.emu.romGen;
    }
    return this.prober;
  }

  private queueProbe(k: number): void {
    if (this.probeFailed.has(k)) return;
    if (!this.probeQueue.includes(k)) this.probeQueue.push(k);
    this.scheduleProbes();
  }

  private scheduleProbes(): void {
    if (this.probeScheduled) return;
    this.probeScheduled = true;
    if (!this.probeChannel) {
      this.probeChannel = new MessageChannel();
      this.probeChannel.port1.onmessage = () => this.runProbes();
    }
    this.probeChannel.port2.postMessage(0);
  }

  private runProbes(): void {
    this.probeScheduled = false;
    const t0 = performance.now();
    while (this.probeQueue.length && performance.now() - t0 < 30) {
      const t = this.probeQueue.shift()!;
      try {
        if (t & PROBE_SPRITE) this.prober?.probeSprite(t & 0xff); else this.prober?.probe(t);
      } catch (e) { console.error(e); this.probeFailed.add(t); }
    }
    if (this.probeQueue.length) this.scheduleProbes();
    else this.emit('blockinfo');
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
    const img = this.spriteThumbs?.get(s.num);
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
  }
  changed(rerender = true): void {
    this.dirty = true;
    if (rerender) this.refresh();
    this.emit('change');
  }
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneLevel(this.level));
    this.level = prev;
    this.changed();
  }
  redo(): void {
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
      if (p.num === 0 && p.ext === DM16_EXT && !hasEditorPatch(this.rom)) {
        try {
          installEditorPatch(this.rom);
          this.emu.syncRom();
          this.persist();
          toast('Editor-Patch installiert (für Direct-Map16-Objekte).');
        } catch (e) { toast(String(e), 'error'); this.undoStack.pop(); return; }
      }
      if (p.num === 0 && p.ext === DM16_EXT && (p.tile ?? 0) >= EXT_FIRST && !map16Ext(this.rom)) {
        installMap16Ext(this.rom, map16Source(this.rom, this.render).fg(0x025));
        this.emu.syncRom();
        this.persist();
        toast('Map16-Erweiterung installiert (Tiles 200–FFF).');
      }
      const o: LevelObject = { uid: newUid(), num: p.num, ext: p.ext, x: tx, y: ty, size: p.size };
      if (p.tile !== undefined) o.tile = p.tile;
      this.clampObject(o);
      this.currentObjects().push(o);
      this.selection = new Set([o.uid]);
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
      if (!silent) toast(`Level ${n.toString(16).toUpperCase()} gespeichert. ${log.join(' · ')}`);
      this.refresh();
      this.emit('change');
    } catch (e) {
      toast(`Speichern fehlgeschlagen: ${e}`, 'error');
    }
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
