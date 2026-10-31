// Object preview thumbnails, rendered by emulating a test level that contains the objects (learned in the
// background by App.objectThumbs, in the probe worker); and the placement preview (App.objectsPreview), which follows
// the same graphics files and animations.

import type { Rom } from './rom.ts';
import type { LevelEmulator, LevelRender, LevelOverride } from './levelemu.ts';
import { type Level, type LevelObject, newUid, levelRows } from './level.ts';
import { renderLevel, layerGeom, renderLayerTiles } from './render.ts';
import { MAP_BASE, map16Tile } from './ram.ts';
import { objectVariant, type ObjKind } from './objkinds.ts';
import { levelSlots, layerSlots } from './gfxslots.ts';
import { gfxFilesHash } from './gfxpages.ts';
import { levelAnimHash } from './exanim.ts';
import { inputHash, levelInput } from './inputs.ts';
import { runJob } from './jobrunner.ts';
import { effectLoad, ramEffect } from './objeffects.ts';

// extension: object 2D's bytes after its 3 where the ROM reads them (obj2d.ts), its custom number first
export interface ObjSpec { num: number; ext: number; size: number; extension?: number[] }

// sub-objects (see objectVariants) get a key per type, object 2D with an extension one per custom number
export function objKey(s: { num: number; ext: number; size: number; extension?: number[] }, kind: ObjKind | null): string {
  if (s.num === 0) return `e${s.ext}`;
  if (s.extension) return `c${s.extension[0]}`;
  const v = objectVariant(kind, s.size);
  return v < 0 ? `s${s.num}` : `s${s.num}.${v}`;
}

// a rendered object: its pixels, the distinct Map16 tiles it produced and where (cells: x, y of a tile's top left
// pixel and its number, one after the other – for the animation, pickeranim.ts); effect: of an extended object or one
// of object 2D's custom numbers that draws no tile, what its load changes in RAM (objeffects.ts ramEffect),
// without pixels (w = h = 0)
export interface ObjThumb { key: string; w: number; h: number; px: Uint32Array; m16: number[]; cells: number[]; effect?: string }

// their result cache key: the tileset and palettes (kept side by side) and the objects
export function thumbsKey(level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): string {
  const h = level.header;
  // (o4: effects as what they change, extended objects' too; o5: with cells)
  return `o5${h.tileset}-${h.fgPalette}-${h.bgPalette}:${inputHash(specs.map((s) => `${s.num}.${s.ext}.${s.size}=${keyOf(s)}`))}`;
}

// what they depend on outside the ROM bytes they read: the level they are drawn in as edited (its number
// decides its graphics slots), the content of the graphics files they draw from and what the level's animations
// copy at its load (graphics and ExAnimation data aren't among the bytes read, see App.gfxSkipMask). Not its BG:
// they show layer 1; nor its size and mode: the test level has its own.
export function thumbsInput(rom: Rom, level: Level): unknown {
  return { level: level.number, header: { ...level.header, screens: 0, mode: 0 }, gfx: layerFilesHash(rom, level), anim: animHash(rom, level.number) };
}
// what the placement preview (App.objectsPreview) depends on outside the ROM bytes it read: the level as edited
// with the placed objects (ov: its load's overrides) and, as for thumbnails, the content of the graphics files its
// layers draw from and what its animations copy
export function previewInput(rom: Rom, level: Level, ov: LevelOverride): unknown {
  return { level: levelInput(level.number, ov), gfx: layerFilesHash(rom, level), anim: animHash(rom, level.number) };
}
// the content hash of the graphics files level's Map16 tiles draw from (its layer slots)
function layerFilesHash(rom: Rom, level: Level): number {
  return filesHash(rom, layerSlots(levelSlots(rom, level.number, level.header)).map((s) => s.file));
}
// (once per ROM state and files)
const filesMemo = { rom: null as Rom | null, gen: -1, files: '', hash: 0 };
function filesHash(rom: Rom, files: number[]): number {
  const m = filesMemo;
  if (m.rom !== rom || m.gen !== rom.gen || m.files !== files.join()) Object.assign(m, { rom, gen: rom.gen, files: files.join(), hash: gfxFilesHash(rom, files) });
  return m.hash;
}
// what level's animations copy at its load (levelAnimHash; once per ROM state and level)
const animMemo = { rom: null as Rom | null, gen: -1, level: -1, hash: 0 };
function animHash(rom: Rom, level: number): number {
  const m = animMemo;
  if (m.rom !== rom || m.gen !== rom.gen || m.level !== level) Object.assign(m, { rom, gen: rom.gen, level, hash: levelAnimHash(rom, level) });
  return m.hash;
}

// all at once (see objectThumbsJob)
export function renderObjectThumbs(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): ObjThumb[] {
  return runJob(objectThumbsJob(rom, emu, level, specs, keyOf));
}

// in batches of 32 test levels, a step each; a batch whose load fails (some objects together break the game,
// like two of tileset 7's object 33) is rendered in halves, an object that fails alone gets no thumbnail. An
// extended object or one of object 2D's custom numbers that drew nothing in its batch is loaded again alone
// (#104's rule: listed are the objects that draw tiles or do something): it may draw alone what it didn't among
// the others (Retry's midway bars: only so many per level), else it is listed for what its load changes in RAM
// (objeffects.ts)
export function* objectThumbsJob(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): Generator<void, ObjThumb[]> {
  const out: ObjThumb[] = [];
  const PER = 32;
  const objOf = (s: ObjSpec, i: number): LevelObject => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 16 + 3, y: 12, ...(s.extension ? { extension: s.extension } : {}) });
  // the thumbnails of a load's objects that wrote tiles
  const collect = (r: LevelRender, batch: ObjSpec[]): void => {
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
      const px = new Uint32Array(w * hh), cells: number[] = [];
      for (const t of tiles) {
        const tx = t & 0xffff, ty = t >> 16;
        cells.push((tx - x0) * 16, (ty - y0) * 16, map16Tile(r.wram, g.addr(tx, ty)));
        for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 16; xx++) {
          const v = im.layer1[(ty * 16 + yy) * im.width + tx * 16 + xx];
          px[((ty - y0) * 16 + yy) * w + (tx - x0) * 16 + xx] = v;
        }
      }
      const m16 = new Set<number>();
      for (const off of set!) m16.add(map16Tile(r.wram, MAP_BASE + off));
      out.push({ key: keyOf(s), w, h: hh, px, m16: [...m16].sort((a, b) => a - b), cells });
    });
  };
  const render = (batch: ObjSpec[]): void => {
    const r = effectLoad(emu, level, batch.map(objOf), true);
    if (!r.ok) {
      if (batch.length > 1) { render(batch.slice(0, batch.length >> 1)); render(batch.slice(batch.length >> 1)); }
      return;
    }
    collect(r, batch);
  };
  for (let b = 0; b < specs.length; b += PER) { render(specs.slice(b, b + PER)); yield; }
  const drawn = new Set(out.map((t) => t.key));
  const quiet = specs.filter((s) => (s.num === 0 || s.extension) && !drawn.has(keyOf(s)));
  if (!quiet.length) return out;
  const base = effectLoad(emu, level, []);
  yield;
  if (!base.ok) return out;
  for (const s of quiet) {
    const r = effectLoad(emu, level, [objOf(s, 0)], true);
    const had = out.length;
    if (r.ok) collect(r, [s]);
    const effect = r.ok && out.length === had ? ramEffect(base.wram, r.wram) : null;
    if (effect) out.push({ key: keyOf(s), w: 0, h: 0, px: new Uint32Array(0), m16: [], cells: [], effect });
    yield;
  }
  return out;
}

// The placement preview (App.objectsPreview) as a job (a picture, a single step): the level as edited with the placed
// objects (ov: its load's overrides; the objects of layer2 or layer 1 at the indices of `placed`) loaded, the tiles
// they wrote drawn together, cut to their bounds (render.ts renderLayerTiles); null when the load fails or they wrote
// none
export function* placementPreviewJob(rom: Rom, emu: LevelEmulator, level: Level, ov: LevelOverride, layer2: boolean, placed: number[]): Generator<void, PlacementPreview | null> {
  const r = emu.load(level.number, ov);
  if (!r.ok) return null;
  const h = level.header, g = layer2 ? layerGeom(rom, 1, h.mode, h.screens) : layerGeom(rom, 0, h.mode, h.screens, levelRows(level.secondary));
  const tileAt = new Map<number, number>(); // by the offset in the tilemap
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) tileAt.set(g.addr(x, y) - MAP_BASE, (y << 16) | x);
  const tiles = new Set<number>();
  // (the objects' keys in the load's trace: those of layer 2 objects with bit 15 set, as App.objectKey)
  for (const i of placed) for (const off of r.touched.get(layer2 ? 0x8000 | i : i) ?? []) { const t = tileAt.get(off); if (t !== undefined) tiles.add(t); }
  return renderLayerTiles(rom, r, g, layer2, [...tiles]);
}
export type PlacementPreview = NonNullable<ReturnType<typeof renderLayerTiles>>;
