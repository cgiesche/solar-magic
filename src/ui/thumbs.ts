// Object preview thumbnails, rendered by emulating a test level that contains the objects (learned in the
// background by App.objectThumbs).

import type { Rom } from '../core/rom.ts';
import { OV_L1, type LevelEmulator } from '../core/levelemu.ts';
import { encodePrimaryHeader, serializeObjects, type Level, type LevelObject, newUid, L2_PTRS } from '../core/level.ts';
import { renderLevel, layerGeom } from '../core/render.ts';
import { MAP_BASE, map16Tile } from '../core/ram.ts';
import { objectVariant, type ObjKind } from '../core/objkinds.ts';
import { levelSlots, layerSlots } from '../core/gfxslots.ts';
import { gfxFilesHash } from '../core/gfxpages.ts';
import { inputHash } from '../core/inputs.ts';
import { objectEffectsJob } from '../core/objeffects.ts';

// extension: object 2D's bytes after its 3 where the ROM reads them (obj2d.ts), its custom number first
export interface ObjSpec { num: number; ext: number; size: number; extension?: number[] }

// sub-objects (see objectVariants) get a key per type, object 2D with an extension one per custom number
export function objKey(s: { num: number; ext: number; size: number; extension?: number[] }, kind: ObjKind | null): string {
  if (s.num === 0) return `e${s.ext}`;
  if (s.extension) return `c${s.extension[0]}`;
  const v = objectVariant(kind, s.size);
  return v < 0 ? `s${s.num}` : `s${s.num}.${v}`;
}

// a rendered object: its pixels and the distinct Map16 tiles it produced; effect: one of object 2D's custom
// numbers that draws no tile but changes RAM when the level loads (objeffects.ts), without pixels (w = h = 0)
export interface ObjThumb { key: string; w: number; h: number; px: Uint32Array; m16: number[]; effect?: boolean }

// their result cache key: the tileset and palettes (kept side by side) and the objects
export function thumbsKey(level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): string {
  const h = level.header;
  // (o3: with the level they are drawn in as their input)
  return `o3${h.tileset}-${h.fgPalette}-${h.bgPalette}:${inputHash(specs.map((s) => `${s.num}.${s.ext}.${s.size}=${keyOf(s)}`))}`;
}

// what they depend on outside the ROM bytes they read: the level they are drawn in as edited (its number
// decides its graphics slots) and the content of the graphics files they draw from (graphics data isn't among
// the bytes read, see App.gfxSkipMask). Not its BG: they show layer 1; nor its size and mode: the test level
// has its own.
export function thumbsInput(rom: Rom, level: Level): unknown {
  const files = layerSlots(levelSlots(rom, level.number, level.header)).map((s) => s.file);
  return { level: level.number, header: { ...level.header, screens: 0, mode: 0 }, gfx: filesHash(rom, files) };
}
// (once per ROM state and files)
const filesMemo = { rom: null as Rom | null, gen: -1, files: '', hash: 0 };
function filesHash(rom: Rom, files: number[]): number {
  const m = filesMemo;
  if (m.rom !== rom || m.gen !== rom.gen || m.files !== files.join()) Object.assign(m, { rom, gen: rom.gen, files: files.join(), hash: gfxFilesHash(rom, files) });
  return m.hash;
}

export function thumbCanvas(t: Pick<ObjThumb, 'w' | 'h' | 'px'>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = t.w; c.height = t.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(t.w, t.h);
  new Uint32Array(id.data.buffer).set(t.px);
  ctx.putImageData(id, 0, 0);
  return c;
}

// all at once (see objectThumbsJob)
export function renderObjectThumbs(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): ObjThumb[] {
  const job = objectThumbsJob(rom, emu, level, specs, keyOf);
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// in batches of 32 test levels, a step each; a batch whose load fails (some objects together break the game,
// like two of tileset 7's object 33) is rendered in halves, an object that fails alone gets no thumbnail. Object
// 2D's custom numbers that draw nothing are probed for an effect then (#104's rule: listed are the objects that
// draw tiles or do something)
export function* objectThumbsJob(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): Generator<void, ObjThumb[]> {
  const out: ObjThumb[] = [];
  const PER = 32;
  const render = (batch: ObjSpec[]): void => {
    const objs: LevelObject[] = batch.map((s, i) => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 16 + 3, y: 12, ...(s.extension ? { extension: s.extension } : {}) }));
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
  for (let b = 0; b < specs.length; b += PER) { render(specs.slice(b, b + PER)); yield; }
  const drawn = new Set(out.map((t) => t.key));
  const quiet = specs.filter((s) => s.extension && !drawn.has(keyOf(s)));
  const fx = !quiet.length ? [] : yield* objectEffectsJob(emu, level, quiet.map((s) => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: 0, y: 0, extension: s.extension })));
  quiet.forEach((s, i) => { if (fx[i]) out.push({ key: keyOf(s), w: 0, h: 0, px: new Uint32Array(0), m16: [], effect: true }); });
  return out;
}
