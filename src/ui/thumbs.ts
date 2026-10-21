// Object preview thumbnails, rendered by emulating a test level that contains the objects.

import type { App } from './app.ts';
import type { Rom } from '../core/rom.ts';
import { OV_L1, type LevelEmulator } from '../core/levelemu.ts';
import { encodePrimaryHeader, serializeObjects, type Level, type LevelObject, newUid, L2_PTRS } from '../core/level.ts';
import { renderLevel, layerGeom } from '../core/render.ts';
import { MAP_BASE, map16Tile } from '../core/ram.ts';
import { objectVariant, type ObjKind } from '../core/objkinds.ts';

export interface ObjSpec { num: number; ext: number; size: number }

// sub-objects (see objectVariants) get a key per type
export function objKey(s: { num: number; ext: number; size: number }, kind: ObjKind | null): string {
  if (s.num === 0) return `e${s.ext}`;
  const v = objectVariant(kind, s.size);
  return v < 0 ? `s${s.num}` : `s${s.num}.${v}`;
}

// a rendered object: its pixels and the distinct Map16 tiles it produced
export interface ObjThumb { key: string; w: number; h: number; px: Uint32Array; m16: number[] }

// the thumbnails from the result cache (see romdeps.ts) or rendered; keyed by the level header
// settings they depend on and the objects
export function objectThumbs(app: App, specs: ObjSpec[]): ObjThumb[] {
  const h = app.level.header;
  // (o2: since batches whose load failed are no longer kept)
  const key = `o2${h.tileset}-${h.fgPalette}-${h.bgPalette}:${hashStr(specs.map((s) => `${s.num}.${s.ext}.${s.size}`).join())}`;
  const stored = app.results.get<ObjThumb[]>(key);
  if (stored) return stored;
  const r = app.emu.tracked(() => renderObjectThumbs(app.rom, app.emu, app.level, specs, (s) => objKey(s, app.objectKind(s.num))));
  app.results.set(key, r.result, app.results.fp.deps(r.reads));
  return r.result;
}

export function thumbCanvas(t: ObjThumb): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = t.w; c.height = t.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(t.w, t.h);
  new Uint32Array(id.data.buffer).set(t.px);
  ctx.putImageData(id, 0, 0);
  return c;
}

function hashStr(s: string): string {
  let a = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
  return (a >>> 0).toString(36);
}

// in batches of 32 test levels; a batch whose load fails (some objects together break the game, like two of
// tileset 7's object 33) is rendered in halves, an object that fails alone gets no thumbnail
export function renderObjectThumbs(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): ObjThumb[] {
  const out: ObjThumb[] = [];
  const PER = 32;
  const render = (batch: ObjSpec[]): void => {
    const objs: LevelObject[] = batch.map((s, i) => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 16 + 3, y: 12 }));
    const hdr = { ...level.header, screens: 32, mode: 0 };
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects(objs, [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader(hdr));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = emu.load(level.number, {
      layer1: l1,
      layer2Pointer: level.layer2Objects ? rom.r24(L2_PTRS + 0x105 * 3) : level.layer2Pointer,
      sprites: new Uint8Array([0, 0xff]),
      byteOwner,
    });
    if (!r.ok) {
      if (batch.length > 1) { render(batch.slice(0, batch.length >> 1)); render(batch.slice(batch.length >> 1)); }
      return;
    }
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
      const px = new Uint32Array(w * hh);
      for (const t of tiles) {
        const tx = t & 0xffff, ty = t >> 16;
        for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) {
          const v = im.layer1[(ty * 16 + yy) * im.width + tx * 16 + xx];
          px[((ty - y0) * 16 + yy) * w + (tx - x0) * 16 + xx] = v;
        }
      }
      const m16 = new Set<number>();
      for (const off of set!) m16.add(map16Tile(r.wram, MAP_BASE + off));
      out.push({ key: keyOf(s), w, h: hh, px, m16: [...m16].sort((a, b) => a - b) });
    });
  };
  for (let b = 0; b < specs.length; b += PER) render(specs.slice(b, b + PER));
  return out;
}
