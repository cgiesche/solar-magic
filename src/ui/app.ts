// Application state and editing actions.

import { Rom, snesToPc } from '../core/rom.ts';
import { LevelEmulator, OV_L1, OV_L2, type LevelRender, type LevelOverride, MAP_BASE, MAP_SIZE } from '../core/levelemu.ts';
import {
  type Level, type LevelObject, type LevelSprite, loadLevel, serializeLayer1, serializeLayer2, serializeSprites,
  isL1Vertical, cloneLevel, newUid, hasLayer2Objects, L1_PTRS, SEC_HDR,
} from '../core/level.ts';
import { renderLevel, type LevelImages, composite } from '../core/render.ts';
import { saveLevel } from '../core/save.ts';
import { captureSprites } from '../core/spritegfx.ts';
import { kvSet } from './storage.ts';
import { toast } from './dom.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit';
export type PaletteItem =
  | { kind: 'obj'; num: number; ext: number; size: number }
  | { kind: 'spr'; num: number; extra: number };

type Listener = () => void;

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
  zoom = 2;
  show = { layer1: true, layer2: true, sprites: true, grid: false, screens: true, exits: true };
  dirty = false;
  undoStack: Level[] = [];
  redoStack: Level[] = [];
  clipboard: { objects?: LevelObject[]; sprites?: LevelSprite[] } = {};
  // tile (x,y) lookup from map offset
  offsetToTile1 = new Int32Array(MAP_SIZE);
  offsetToTile2 = new Int32Array(MAP_SIZE);
  listeners = new Map<string, Set<Listener>>();
  renderError: string | null = null;
  exitScreen = 0;
  spriteThumbs: Map<number, HTMLCanvasElement> | null = null;

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
    const s = lv.secondary;
    return {
      layer1: l1,
      layer2: l2 ?? undefined,
      layer2Pointer: l2 ? undefined : lv.layer2Pointer,
      sprites: serializeSprites(lv.sprites, lv.spriteHeader, this.vertical),
      byteOwner,
      secondaryHeader: [
        (s.layer2Scroll << 4) | s.entranceY, (s.layer3 << 6) | (s.entranceAction << 3) | s.entranceX,
        (s.midwayScreen << 4) | (s.fgInitY << 2) | s.bgInitY, (s.noYoshiIntro << 7) | (s.verticalPositioning << 5) | s.entranceScreen,
      ],
    };
  }

  refresh(): void {
    const lv = this.level;
    const r = this.emu.load(lv.number, this.buildOverrides());
    this.renderError = r.ok ? null : r.error ?? 'Fehler';
    this.render = r;
    this.images = renderLevel(this.rom, r, lv.header.mode, lv.header.screens);
    this.compositeImg = composite(this.images, this.show.layer1, this.show.layer2);
    this.buildOffsetMaps();
    this.emit('render');
  }

  recomposite(): void {
    this.compositeImg = composite(this.images, this.show.layer1, this.show.layer2);
    this.emit('render');
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

  objectAt(tx: number, ty: number): LevelObject | null {
    const l2 = this.mode === 'l2';
    const g = l2 ? this.images.geom2 : this.images.geom1;
    const objs = this.currentObjects();
    if (!g) return null;
    const a = g.addr(tx, ty);
    if (a >= 0) {
      const k = this.render.owner[a - MAP_BASE];
      if (k >= 0 && ((k & 0x8000) !== 0) === l2) {
        const o = objs[k & 0x7fff];
        if (o) return o;
      }
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

  objectBounds(o: LevelObject): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = o.x, y0 = o.y, x1 = o.x, y1 = o.y;
    for (const t of this.objectTiles(o)) {
      const x = t & 0xffff, y = t >> 16;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
  }

  spriteAt(tx: number, ty: number): LevelSprite | null {
    const sp = this.level.sprites;
    for (let i = sp.length - 1; i >= 0; i--) if (sp[i].x === tx && sp[i].y === ty) return sp[i];
    return null;
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

  setMode(m: EditMode): void {
    if (m === 'l2' && !this.level.layer2Objects) {
      toast('Dieses Level hat keine Layer-2-Objekte (Layer 2 ist Hintergrund).');
      return;
    }
    this.mode = m;
    this.selection.clear();
    this.emit('mode');
    this.emit('change');
  }

  clampObject(o: { x: number; y: number }): void {
    const w = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.width : this.levelWidthTiles();
    const hgt = this.mode === 'l2' && this.images.geom2 ? this.images.geom2.height : this.levelHeightTiles();
    o.x = Math.max(0, Math.min(w - 1, o.x));
    o.y = Math.max(0, Math.min(Math.min(hgt, this.vertical ? 0x1ff : 0x1f + 1) - 1, o.y));
  }

  insertAt(tx: number, ty: number): void {
    const p = this.paletteItem;
    if (!p) { toast('Zuerst ein Objekt/Sprite in der Palette wählen.'); return; }
    this.checkpoint();
    if (p.kind === 'obj' && (this.mode === 'l1' || this.mode === 'l2')) {
      const o: LevelObject = { uid: newUid(), num: p.num, ext: p.ext, x: tx, y: ty, size: p.size };
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
    const objs = this.selectedObjects().filter((o) => o.num !== 0);
    if (!objs.length) return;
    this.checkpoint();
    for (const o of objs) {
      const w = Math.max(0, Math.min(15, (o.size & 15) + dw));
      const hh = Math.max(0, Math.min(15, (o.size >> 4) + dh));
      o.size = (hh << 4) | w;
    }
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
