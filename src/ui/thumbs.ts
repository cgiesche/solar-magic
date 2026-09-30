// Object preview thumbnails, rendered by emulating a test level that contains the objects.

import type { App } from './app.ts';
import { OV_L1 } from '../core/levelemu.ts';
import { encodePrimaryHeader, serializeObjects, type LevelObject, newUid, L2_PTRS } from '../core/level.ts';
import { renderLevel, layerGeom } from '../core/render.ts';
import { MAP_BASE } from '../core/levelemu.ts';
import { objectVariant } from '../core/names.ts';

export interface ObjSpec { num: number; ext: number; size: number }

// sub-objects (see objectVariants) get a key per type
export function objKey(s: { num: number; ext: number; size: number }): string {
  if (s.num === 0) return `e${s.ext}`;
  const v = objectVariant(s.num, s.size);
  return v < 0 ? `s${s.num}` : `s${s.num}.${v}`;
}

// tilesOut receives the distinct Map16 tiles each object produced
export function renderObjectThumbs(app: App, specs: ObjSpec[], tilesOut?: Map<string, number[]>): Map<string, HTMLCanvasElement> {
  const out = new Map<string, HTMLCanvasElement>();
  const PER = 32;
  const rom = app.rom;
  for (let b = 0; b < specs.length; b += PER) {
    const batch = specs.slice(b, b + PER);
    const objs: LevelObject[] = batch.map((s, i) => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 16 + 3, y: 12 }));
    const hdr = { ...app.level.header, screens: 32, mode: 0 };
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects(objs, [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader(hdr));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = app.emu.load(app.level.number, {
      layer1: l1,
      layer2Pointer: app.level.layer2Objects ? rom.r24(L2_PTRS + 0x105 * 3) : app.level.layer2Pointer,
      sprites: new Uint8Array([0, 0xff]),
      byteOwner,
    });
    const im = renderLevel(rom, r, 0, 32);
    const g = layerGeom(rom, 0, 0, 32);
    const inv = new Map<number, number>();
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) inv.set(g.addr(x, y) - MAP_BASE, (y << 16) | x);
    batch.forEach((s, i) => {
      const set = r.touched.get(i);
      const tiles: number[] = [];
      if (set) for (const off of set) { const t = inv.get(off); if (t !== undefined) tiles.push(t); }
      if (!tiles.length) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (const t of tiles) {
        const x = t & 0xffff, y = t >> 16;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      const w = (x1 - x0 + 1) * 16, hh = (y1 - y0 + 1) * 16;
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(w, hh);
      const px = new Uint32Array(id.data.buffer);
      for (const t of tiles) {
        const tx = t & 0xffff, ty = t >> 16;
        for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) {
          const v = im.layer1[(ty * 16 + yy) * im.width + tx * 16 + xx];
          px[((ty - y0) * 16 + yy) * w + (tx - x0) * 16 + xx] = v;
        }
      }
      ctx.putImageData(id, 0, 0);
      c.dataset.tiles = String(tiles.length);
      out.set(objKey(s), c);
      if (tilesOut) {
        const m16 = new Set<number>();
        for (const off of set!) m16.add(r.wram[MAP_BASE + off] | (r.wram[0x10000 + MAP_BASE + off] << 8));
        tilesOut.set(objKey(s), [...m16].sort((a, b) => a - b));
      }
    });
  }
  return out;
}
