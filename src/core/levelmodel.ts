// The level editing model: the open level's edit mode, selection, picked item and clipboard, and the edits on its
// objects and sprites – placing, copying and pasting, deleting, moving, resizing and reordering them – with their
// rules (the mode's layer, the level's bounds). DOM-free: the open level, its undoable edits, the level's geometry and
// a mode change are the host's (App: EditSession, the render, the views); views map pixels to tiles.

import type { Rom } from './rom.ts';
import { type Level, type LevelObject, type LevelSprite, newUid, spriteBytes, spriteSizes } from './level.ts';
import { objectLength2D, fitExtension } from './obj2d.ts';
import { keyResize, type Box } from './objresize.ts';

export type EditMode = 'l1' | 'l2' | 'spr' | 'exit' | 'bg' | 'l3';
// the modes painted with a brush of tiles picked from the level or the picker: BG tiles, layer 3's 8x8 tiles
export const isBrushMode = (m: EditMode) => m === 'bg' || m === 'l3';
export type PickedItem =
  // block: a rectangle of Map16 tiles from the picker sheet (tile + row * 16 + col), one Direct-Map16 object each
  // prefab: prefab number (extended object $04, see prefabs.ts)
  // extension: object 2D's bytes after its 3 when the ROM reads them (obj2d.ts)
  | { kind: 'obj'; num: number; ext: number; size: number; tile?: number; block?: { w: number; h: number }; prefab?: number; extension?: number[] }
  | { kind: 'spr'; num: number; extra: number };
// what a right click in the level adds (LevelModel.placement)
export interface Placement { objects: LevelObject[]; sprites: LevelSprite[] }
export interface Clipboard { objects?: LevelObject[]; sprites?: LevelSprite[] }

// the level's size in tiles as its load lays it out: layer 1, layer 2 when it has its own (null: as layer 1), and
// whether layer 1 is vertical (its objects' origins are on rows 0 to $1FF at most)
export interface LevelGeometry {
  l1: { width: number; height: number };
  l2: { width: number; height: number } | null;
  vertical: boolean;
}

export interface LevelModelHost {
  rom(): Rom;
  // the open level
  level(): Level;
  // one undoable level edit at once: f changes the open level, returns false when it changed nothing
  edit(f: (lv: Level) => boolean | void): boolean;
  geometry(): LevelGeometry;
  // the mode changes to m (an item of another mode placed): the host's mode change, which sets mode
  switchMode(m: EditMode): void;
}

export class LevelModel {
  private host: LevelModelHost;
  // the edit mode (App.setMode checks it and shows it)
  mode: EditMode = 'l1';
  selection = new Set<number>();
  // what a right click in the level places: the picked item, or – picked in the level after it – a copy of the selection
  private picked: PickedItem | null = null;
  get pickedItem(): PickedItem | null { return this.picked; }
  set pickedItem(p: PickedItem | null) { this.picked = p; this.stampSelection = false; }
  stampSelection = false;
  clipboard: Clipboard = {};

  constructor(host: LevelModelHost) {
    this.host = host;
  }

  get level(): Level { return this.host.level(); }

  // the mode's objects (layer 1 but in mode layer 2)
  currentObjects(): LevelObject[] {
    if (this.mode === 'l2') return this.level.layer2Objects ?? [];
    return this.level.objects;
  }
  selectedObjects(): LevelObject[] {
    return this.currentObjects().filter((o) => this.selection.has(o.uid));
  }
  selectedSprites(): LevelSprite[] {
    return this.level.sprites.filter((s) => this.selection.has(s.uid));
  }
  // the mode's selected items: sprites in mode sprites, else objects
  selectedItems(): (LevelObject | LevelSprite)[] {
    return this.mode === 'spr' ? this.selectedSprites() : this.selectedObjects();
  }

  // the tiles an object's origin can be on in the mode's layer: 0 to w - 1, 0 to h - 1
  objectLimits(): { w: number; h: number } {
    const g = this.host.geometry(), lg = this.mode === 'l2' && g.l2 ? g.l2 : g.l1;
    return { w: lg.width, h: g.vertical ? Math.min(lg.height, 0x1ff) : lg.height };
  }
  clampObject(o: { x: number; y: number }): void {
    const { w, h } = this.objectLimits();
    o.x = Math.max(0, Math.min(w - 1, o.x));
    o.y = Math.max(0, Math.min(h - 1, o.y));
  }

  // picked item p at tile (tx, ty): objects in layer 1/2, a sprite in any mode; null when it can't go into the
  // current mode (an object while editing sprites)
  newItems(p: PickedItem, tx: number, ty: number): Placement | null {
    const rom = this.host.rom();
    if (p.kind === 'spr') {
      const s: LevelSprite = { uid: newUid(), num: p.num, x: tx, y: ty, extra: p.extra };
      if (s.extra >= 2) { const b = spriteBytes(spriteSizes(rom), s); if (b.length) s.bytes = b; }
      return { objects: [], sprites: [s] };
    }
    if (this.mode !== 'l1' && this.mode !== 'l2') return null;
    const cells = p.block ? Array.from({ length: p.block.w * p.block.h }, (_, i) => ({ dx: i % p.block!.w, dy: Math.floor(i / p.block!.w) })) : [{ dx: 0, dy: 0 }];
    const objects = cells.map(({ dx, dy }) => {
      const o: LevelObject = { uid: newUid(), num: p.num, ext: p.ext, x: tx + dx, y: ty + dy, size: p.size };
      if (p.tile !== undefined) o.tile = p.tile + dy * 16 + dx;
      if (p.prefab !== undefined) o.prefab = p.prefab;
      if (p.extension) o.extension = [...p.extension];
      fitExtension(o, objectLength2D(rom));
      this.clampObject(o);
      return o;
    });
    return { objects, sprites: [] };
  }
  // copies of the current mode's items with their upper left at tile (tx, ty)
  copiesAt(items: (LevelObject | LevelSprite)[], tx: number, ty: number): Placement {
    const minX = Math.min(...items.map((o) => o.x)), minY = Math.min(...items.map((o) => o.y));
    const copies = items.map((it) => {
      const c = { ...structuredClone(it), uid: newUid(), x: it.x - minX + tx, y: it.y - minY + ty };
      this.clampObject(c);
      return c;
    });
    return this.mode === 'spr' ? { objects: [], sprites: copies as LevelSprite[] } : { objects: copies as LevelObject[], sprites: [] };
  }
  // puts the placement into the level, selected (sprites in mode sprites); inside a level edit
  private add(pl: Placement): void {
    if (pl.sprites.length && this.mode !== 'spr') this.host.switchMode('spr');
    this.level.sprites.push(...pl.sprites);
    this.currentObjects().push(...pl.objects);
    this.selection = new Set([...pl.objects, ...pl.sprites].map((o) => o.uid));
  }

  // places picked item p at tile (tx, ty), selected; false when it can't go into the mode
  insertAt(tx: number, ty: number, p: PickedItem): boolean {
    const done = this.host.edit(() => {
      const pl = this.newItems(p, tx, ty);
      if (!pl) return false;
      this.add(pl);
    });
    // the placed item is selected: changed (resized, …), the next right click copies it as it is now
    this.stampSelection = true;
    return done;
  }
  // copies of the items with their upper left at tile (tx, ty), selected; false when there are none
  placeCopy(items: (LevelObject | LevelSprite)[], tx: number, ty: number): boolean {
    if (!items.length) return false;
    return this.host.edit(() => this.add(this.copiesAt(items, tx, ty)));
  }
  // a right click places a copy of the selection: it was picked after the picked item
  copiesSelection(): boolean {
    return this.stampSelection && this.selection.size > 0;
  }
  // what a right click at tile (tx, ty) places; null: nothing (only layer 1/2 and sprites place)
  placement(tx: number, ty: number): Placement | null {
    if (this.mode !== 'l1' && this.mode !== 'l2' && this.mode !== 'spr') return null;
    if (this.copiesSelection()) { const items = this.selectedItems(); return items.length ? this.copiesAt(items, tx, ty) : null; }
    return this.pickedItem ? this.newItems(this.pickedItem, tx, ty) : null;
  }

  // the selection goes to the clipboard (the mode's items)
  copy(): void {
    if (this.mode === 'spr') this.clipboard = { sprites: structuredClone(this.selectedSprites()) };
    else this.clipboard = { objects: structuredClone(this.selectedObjects()) };
  }
  // the clipboard's items of the mode
  clipboardItems(): (LevelObject | LevelSprite)[] {
    return (this.mode === 'spr' ? this.clipboard.sprites : this.clipboard.objects) ?? [];
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    this.host.edit((lv) => {
      if (this.mode === 'spr') lv.sprites = lv.sprites.filter((s) => !this.selection.has(s.uid));
      else if (this.mode === 'l2' && lv.layer2Objects) lv.layer2Objects = lv.layer2Objects.filter((o) => !this.selection.has(o.uid));
      else if (this.mode === 'l1') lv.objects = lv.objects.filter((o) => !this.selection.has(o.uid));
      this.selection.clear();
    });
  }

  // by (dx, dy) tiles, inside the level
  moveSelection(dx: number, dy: number): void {
    if (!this.selection.size) return;
    this.host.edit(() => {
      for (const o of this.selectedItems()) { o.x += dx; o.y += dy; this.clampObject(o); }
    });
  }

  // objs get the settings bytes sized (one each): the left and top edges stay where they are, with far the right and
  // bottom ones, by the objects' boxes at each size (an object at the level's edge that would have to leave it stays)
  resizeObjects(objs: LevelObject[], sized: number[], boxes: (o: LevelObject) => (size: number) => Box | null | undefined, far: boolean): void {
    const { w, h } = this.objectLimits();
    this.host.edit(() => objs.forEach((o, i) => {
      const r = keyResize(o, sized[i], boxes(o), far, w, h);
      if (r) { o.x = r.x; o.y = r.y; o.size = r.size; }
    }));
  }

  // the selected objects drawn last (front) or first (back), in their order
  reorderSelection(dir: 'front' | 'back'): void {
    if (this.mode === 'spr' || !this.selection.size) return;
    this.host.edit((lv) => {
      const objs = this.currentObjects();
      const sel = objs.filter((o) => this.selection.has(o.uid));
      const rest = objs.filter((o) => !this.selection.has(o.uid));
      const res = dir === 'front' ? [...rest, ...sel] : [...sel, ...rest];
      if (this.mode === 'l2') lv.layer2Objects = res; else lv.objects = res;
    });
  }
}
