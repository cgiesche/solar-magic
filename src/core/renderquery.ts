// What the open level's render answers about its tiles: the Map16 tile at a tile, the tiles an object covers (those
// it wrote in the level's load), and what the selected objects left in the level as a block of tiles (a prefab's).
// DOM-free: built from a level load (LevelRender) and its layers' geometry, so the editor's object queries (prefab
// from the selection, box selection by object tiles, the tile under the mouse) don't read the render's WRAM and
// owner map themselves.

import { MAP_BASE, type LevelRender } from './levelemu.ts';
import { tileByOffset, type LayerGeom } from './render.ts';
import type { LevelObject } from './level.ts';
import { objectKey } from './objboxes.ts';
import { isDm16, dm16Tiles, type Dm16Cond } from './cdm16.ts';
import { PREFAB_MAX, TRANSPARENT } from './prefabs.ts';
import { map16Tile } from './ram.ts';

// a block of tiles from the level: at (x, y), w×h, row by row (TRANSPARENT: no selected object's tile there);
// conds: a conditional Direct Map16 object's condition per cell when any
export interface TileCut { x: number; y: number; w: number; h: number; tiles: number[]; conds?: (Dm16Cond | null)[] }

const pack = (x: number, y: number) => (y << 16) | x;

export class RenderQuery {
  // map offset → packed tile (y<<16|x) of layer 1 and layer 2, -1 where the layer has none
  private offsetToTile: [Int32Array, Int32Array];
  private render: Pick<LevelRender, 'wram' | 'owner' | 'touched'>;
  private geom1: LayerGeom;
  private geom2: LayerGeom | null;

  constructor(render: Pick<LevelRender, 'wram' | 'owner' | 'touched'>, geom1: LayerGeom, geom2: LayerGeom | null) {
    this.render = render; this.geom1 = geom1; this.geom2 = geom2;
    this.offsetToTile = [tileByOffset(geom1), tileByOffset(geom2)];
  }

  private geom(l2: boolean): LayerGeom | null {
    return l2 ? this.geom2 : this.geom1;
  }

  // the Map16 tile at a tile of layer 1 (or 2), -1 outside the layer
  tileAt(tx: number, ty: number, l2 = false): number {
    const a = this.geom(l2)?.addr(tx, ty) ?? -1;
    return a < 0 ? -1 : map16Tile(this.render.wram, a);
  }

  // the key (objectKey) of the object whose tile is at a tile of layer 1 (or 2) – the last to write it –, -1 none
  ownerAt(tx: number, ty: number, l2 = false): number {
    const a = this.geom(l2)?.addr(tx, ty) ?? -1;
    return a < 0 ? -1 : this.render.owner[a - MAP_BASE];
  }

  // whether object i of layer 1 (or 2) wrote a tile at a tile, also one a later object overwrote
  wrote(l2: boolean, i: number, tx: number, ty: number): boolean {
    const a = this.geom(l2)?.addr(tx, ty) ?? -1;
    return a >= 0 && !!this.render.touched.get(objectKey(l2, i))?.has(a - MAP_BASE);
  }

  // whether object i of layer 1 (or 2) wrote any tile in the level's load
  drawn(l2: boolean, i: number): boolean {
    return !!this.render.touched.get(objectKey(l2, i))?.size;
  }

  // the tiles object i of layer 1 (or 2) wrote (its outline), packed (y<<16|x); empty when it wrote none
  written(l2: boolean, i: number): number[] {
    const set = this.render.touched.get(objectKey(l2, i)), map = this.offsetToTile[l2 ? 1 : 0];
    const out: number[] = [];
    if (set) for (const off of set) { const t = map[off]; if (t >= 0) out.push(t); }
    return out;
  }

  // the tiles object o, at index i of layer 1 (or 2) in the load (-1: not in it), covers, packed (y<<16|x): those it
  // wrote, else a hidden conditional Direct Map16 object's rectangle, else its own tile (a box, objboxes.ts)
  objectTiles(l2: boolean, o: LevelObject, i: number): number[] {
    const out = this.written(l2, i);
    if (!out.length) out.push(...(isDm16(o) && o.cond ? dm16Tiles(o) : [pack(o.x, o.y)]));
    return out;
  }

  // the Map16 tile numbers object i left in the level (tiles overwritten by later objects excluded), sorted
  objectMap16(l2: boolean, i: number): number[] {
    const key = objectKey(l2, i), set = this.render.touched.get(key);
    const out = new Set<number>();
    if (set) for (const off of set) if (this.render.owner[off] === key) out.add(map16Tile(this.render.wram, MAP_BASE + off));
    return [...out].sort((a, b) => a - b);
  }

  // the objects of layer 1 (or 2) with a tile (objectTiles) in the tile rectangle x0..x1, y0..y1 (inclusive):
  // an object is caught by its outline, not its bounding box (slopes reach far diagonally)
  objectsInBox(l2: boolean, objs: readonly LevelObject[], x0: number, y0: number, x1: number, y1: number): LevelObject[] {
    return objs.filter((o, i) => this.objectTiles(l2, o, i).some((t) => {
      const x = t & 0xffff, y = t >> 16;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    }));
  }

  // what the objects of layer 1 (or 2) for which selected holds left in the level as a block of tiles; cells of
  // other objects are transparent, empty rows and columns at the border are cut off. A conditional Direct Map16
  // object gives its tiles with its condition whatever the load's flags (cdm16.ts); a cell holds one tile, the
  // topmost. A string: why there is none
  tileCut(l2: boolean, objs: readonly LevelObject[], selected: (o: LevelObject) => boolean): TileCut | string {
    const g = this.geom(l2);
    if (!g) return 'Layer without objects';
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const cells = new Map<number, { tile: number; cond?: Dm16Cond }>();
    // in drawing order: each object's cells over those of the objects before it
    objs.forEach((o, i) => {
      if (!selected(o)) return;
      const cond = isDm16(o) ? o.cond : undefined, key = objectKey(l2, i);
      for (const t of cond ? dm16Tiles(o) : this.objectTiles(l2, o, i)) {
        const x = t & 0xffff, y = t >> 16;
        const a = g.addr(x, y);
        if (a < 0 || (!cond && this.render.owner[a - MAP_BASE] !== key)) continue;
        cells.set(t, cond ? { tile: o.tile ?? 0, cond: { ...cond } } : { tile: map16Tile(this.render.wram, a) });
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    });
    if (x1 < 0) return 'The selected objects have no visible tiles.';
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w > PREFAB_MAX || h > PREFAB_MAX) return `Selection is ${w}×${h} tiles, a prefab can be at most ${PREFAB_MAX}×${PREFAB_MAX}.`;
    const cell = (i: number) => cells.get(pack(x0 + (i % w), y0 + Math.floor(i / w)));
    const tiles = Array.from({ length: w * h }, (_, i) => cell(i)?.tile ?? TRANSPARENT);
    const conds = Array.from({ length: w * h }, (_, i) => cell(i)?.cond ?? null);
    return { x: x0, y: y0, w, h, tiles, ...(conds.some((c) => c) ? { conds } : {}) };
  }
}
