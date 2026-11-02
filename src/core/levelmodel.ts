// The level editing model: the open level's edit mode, selection, picked item and clipboard, and the edits on its
// objects and sprites – placing, copying and pasting, deleting, moving, resizing and reordering them – with their
// rules (the mode's layer, the level's bounds). DOM-free: the open level, its undoable edits, the level's geometry and
// a mode change are the host's (App: EditSession, the render, the views); views map pixels to tiles.

import type { Rom } from './rom.ts';
import { type Level, type LevelObject, type LevelSprite, newUid, spriteBytes, spriteSizes } from './level.ts';
import { objectLength2D, fitExtension } from './obj2d.ts';
import { keyResize, aimResize, grabFor, type Box, type Drivers, type Grab } from './objresize.ts';
import { PREFAB_EXT } from './prefabs.ts';
import { isDm16 } from './cdm16.ts';
import type { LevelEdit } from './editsession.ts';

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
  // one undoable level edit at once: f changes the open level, returns false when it changed nothing (rerender
  // false: the level is drawn anew by its views, not emulated again)
  edit(f: (lv: Level) => boolean | void, rerender?: boolean): boolean;
  // an undoable level edit spanning several events (a drag), committed or cancelled at its end
  beginEdit(): LevelEdit;
  // the selection changed outside a level edit (the views show it)
  selectionChanged(): void;
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
  // the mode's items: sprites in mode sprites, else the mode's objects
  modeItems(): (LevelObject | LevelSprite)[] {
    return this.mode === 'spr' ? this.level.sprites : this.currentObjects();
  }
  // the mode's selected items
  selectedItems(): (LevelObject | LevelSprite)[] {
    return this.modeItems().filter((o) => this.selection.has(o.uid));
  }

  // ---- the selection, changed by the views (clicks, a selection box, keys) ----
  // an item of the mode clicked: selected (alone, unless it is already), and a right click copies the selection
  pick(uid: number): void {
    if (!this.selection.has(uid)) this.selection = new Set([uid]);
    this.stampSelection = true;
    this.host.selectionChanged();
  }
  // an item of the mode Ctrl+clicked: in the selection or out of it
  toggle(uid: number): void {
    if (this.selection.has(uid)) this.selection.delete(uid); else this.selection.add(uid);
    this.stampSelection = true;
    this.host.selectionChanged();
  }
  // a selection box begins (add: to the selection, else in place of it)
  beginBox(add: boolean): void {
    if (!add) this.selection.clear();
    this.stampSelection = true;
    this.host.selectionChanged();
  }
  // the items a selection box caught join the selection
  addToSelection(uids: Iterable<number>): void {
    for (const u of uids) this.selection.add(u);
    this.host.selectionChanged();
  }
  // all items of the mode
  selectAll(): void {
    this.selection = new Set(this.modeItems().map((o) => o.uid));
    this.host.selectionChanged();
  }
  // false when nothing was selected
  clearSelection(): boolean {
    if (!this.selection.size) return false;
    this.selection.clear();
    this.host.selectionChanged();
    return true;
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

  // a level edit remaking the level (screens inserted or deleted, the level cleared): f changes the open level, the
  // selection cleared with it; when f throws, the level and the selection are as before and the error passed on
  remake(f: (lv: Level) => void): boolean {
    return this.host.edit((lv) => { f(lv); this.selection.clear(); });
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

  // ---- property edits (the properties panel) ----
  // f changes the objects with the ids of uids in the mode's layer, one level edit; false when none is there any more
  updateObjects(uids: Iterable<number>, f: (o: LevelObject) => void): boolean {
    const ids = new Set(uids);
    return this.host.edit(() => {
      const objs = this.currentObjects().filter((o) => ids.has(o.uid));
      if (!objs.length) return false;
      objs.forEach(f);
    });
  }
  // f changes the object uid of the mode's layer (see updateObjects)
  updateObject(uid: number, f: (o: LevelObject) => void): boolean {
    return this.updateObjects([uid], f);
  }
  // another object number: a prefab number only for extended object $04, a flag check only for Direct Map16, the
  // extension as long as object 2D's code reads it
  setObjectNum(uid: number, num: number): boolean {
    return this.updateObject(uid, (o) => { o.num = num; fixPrefab(o); fitExtension(o, objectLength2D(this.host.rom())); });
  }
  // another extended object number (see setObjectNum)
  setObjectExt(uid: number, ext: number): boolean {
    return this.updateObject(uid, (o) => { o.ext = ext; fixPrefab(o); });
  }
  // f changes the open level's sprite uid, one level edit (drawn anew, not emulated again); false when it is gone
  updateSprite(uid: number, f: (s: LevelSprite) => void): boolean {
    return this.host.edit((lv) => {
      const s = lv.sprites.find((x) => x.uid === uid);
      if (!s) return false;
      f(s);
    }, false);
  }
  // the extra bytes of a custom sprite (as many as the size table says for its number and extra bits)
  spriteByteCount(s: LevelSprite): number {
    return s.extra >= 2 ? spriteBytes(spriteSizes(this.host.rom()), s).length : 0;
  }
  // the custom sprite's extra bytes as many as its number and extra bits take (kept as far as they go, else 0)
  private fitSpriteBytes(s: LevelSprite): void {
    const b = spriteBytes(spriteSizes(this.host.rom()), s);
    if (b.length) s.bytes = b; else delete s.bytes;
  }
  // another sprite number, extra bits or extra byte i: the extra bytes fitted to the number and extra bits
  setSpriteNum(uid: number, num: number): boolean {
    return this.updateSprite(uid, (s) => { s.num = num; this.fitSpriteBytes(s); });
  }
  setSpriteExtra(uid: number, extra: number): boolean {
    return this.updateSprite(uid, (s) => { s.extra = extra; this.fitSpriteBytes(s); });
  }
  setSpriteByte(uid: number, i: number, v: number): boolean {
    return this.updateSprite(uid, (s) => { this.fitSpriteBytes(s); if (s.bytes) s.bytes[i] = v; });
  }

  // ---- drags (the level view: it maps the mouse to tiles and draws) ----
  // moving the selection with the mouse: one level edit from here to its end; null when nothing is selected
  beginMove(): MoveDrag | null {
    const items = this.selectedItems();
    if (!items.length) return null;
    const orig = new Map(items.map((o) => [o.uid, { x: o.x, y: o.y }]));
    const edit = this.host.beginEdit();
    let lastDx = 0, lastDy = 0;
    return {
      to: (dx, dy) => {
        if (dx === lastDx && dy === lastDy) return false;
        lastDx = dx; lastDy = dy;
        for (const o of this.selectedItems()) {
          const or = orig.get(o.uid);
          if (!or) continue;
          o.x = or.x + dx; o.y = or.y + dy;
          this.clampObject(o);
        }
        return true;
      },
      end: () => { if (lastDx || lastDy) edit.commit(); else edit.cancel(); },
      cancel: () => edit.cancel(true),
    };
  }

  // resizing objs by the handle grabbed on object grabbed (handle: the edges at the mouse), the drivers and boxes of each
  // object's sizes given (emulated by the host): one level edit from here to its end; null when the grabbed
  // object's drivers move none of the handle's edges
  beginResize(objs: LevelObject[], grabbed: LevelObject, handle: Grab, drivers: (o: LevelObject) => Drivers,
    boxes: (o: LevelObject) => (size: number) => Box | null | undefined): ResizeDrag | null {
    const uid = grabbed.uid;
    let grab = grabFor(handle, drivers(grabbed));
    if (!grab.hx && !grab.hy) return null;
    const orig = new Map(objs.map((o) => [o.uid, { x: o.x, y: o.y, size: o.size, drivers: drivers(o) }]));
    const edit = this.host.beginEdit();
    let last = '', changed = false;
    return {
      uid,
      get grab() { return grab; },
      get changed() { return changed; },
      learned: () => {
        for (const o of this.selectedObjects()) { const or = orig.get(o.uid); if (or) or.drivers = drivers({ ...o, size: or.size }); }
        const g = orig.get(uid);
        if (g) grab = grabFor(handle, g.drivers);
      },
      // the grabbed object aims at the tile, the others move the same edges by as many tiles
      aim: (tx, ty) => {
        const { w, h } = this.objectLimits(), g = grab;
        const live = this.selectedObjects().filter((o) => orig.has(o.uid));
        const edges = (o: LevelObject) => {
          const or = orig.get(o.uid)!, b = boxes(o)(or.size);
          return b ? { x: or.x + (g.hx === 1 ? b.x1 : b.x0), y: or.y + (g.hy === 1 ? b.y1 : b.y0) } : null;
        };
        const aim = (o: LevelObject, ax: number, ay: number) => { const or = orig.get(o.uid)!; return aimResize(or, or.drivers, boxes(o), g, ax, ay, w, h); };
        const held = live.find((o) => o.uid === uid), ge = held && edges(held), gr = held && aim(held, tx, ty);
        if (!held || !ge || !gr) return false;
        const dx = (g.hx === 1 ? gr.box.x1 : gr.box.x0) - ge.x, dy = (g.hy === 1 ? gr.box.y1 : gr.box.y0) - ge.y;
        for (const o of live) {
          const e0 = o === held ? ge : edges(o), r = o === held ? gr : e0 && aim(o, e0.x + dx, e0.y + dy);
          if (r) { o.x = r.x; o.y = r.y; o.size = r.size; }
        }
        const key = live.map((o) => `${o.x},${o.y},${o.size}`).join(' ');
        if (key === last) return false;
        last = key;
        changed = live.some((o) => { const or = orig.get(o.uid)!; return o.x !== or.x || o.y !== or.y || o.size !== or.size; });
        return true;
      },
      end: () => { if (changed) edit.commit(); else edit.cancel(); },
      cancel: () => edit.cancel(true),
    };
  }
}

// a drag of the level model, one level edit: end commits it (cancelled when it changed nothing), cancel undoes it
export interface ModelDrag {
  end(): void;
  cancel(): void;
}
export interface MoveDrag extends ModelDrag {
  // the selection by (dx, dy) tiles from where it was, inside the level; false when it is there already
  to(dx: number, dy: number): boolean;
}
export interface ResizeDrag extends ModelDrag {
  readonly uid: number; // the grabbed object
  readonly grab: Grab; // the edges it moves
  readonly changed: boolean; // whether an object is not as it was
  // the grabbed edges aimed at tile (tx, ty); false when nothing changed since the last aim
  aim(tx: number, ty: number): boolean;
  // the drivers were learned (asked again: the edges grabbed those the grabbed object's drivers move)
  learned(): void;
}

// extended object $04 always carries a prefab number (its 4th byte), only Direct Map16 a flag check
function fixPrefab(o: LevelObject): void {
  if (o.num === 0 && o.ext === PREFAB_EXT) o.prefab ??= 0;
  else delete o.prefab;
  if (!isDm16(o)) delete o.cond;
}
