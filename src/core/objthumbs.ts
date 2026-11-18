// Object preview thumbnails, rendered by emulating a test level that contains the objects (learned in the
// background by App.objectThumbs, in the probe worker); and the placement preview (App.objectsPreview), which follows
// the same graphics files and animations.

import type { Rom } from './rom.ts';
import { readOffset, type LevelEmulator, type LevelRender, type LevelOverride } from './levelemu.ts';
import { type Level, type LevelObject, newUid, levelRows } from './level.ts';
import { TileCache, map16Source, drawMap16, layerGeom, renderLayerTiles, tileByOffset } from './render.ts';
import { objectKey } from './objboxes.ts';
import { MAP_BASE, map16Tile } from './ram.ts';
import { objectVariant, sizedByte, type ObjKind } from './objkinds.ts';
import { levelSlots, layerSlots } from './gfxslots.ts';
import { gfxFilesHash } from './gfxpages.ts';
import { levelAnimHash } from './exanim.ts';
import { inputHash, type EditState } from './inputs.ts';
import { levelOverride } from './levelusage.ts';
import { runJob } from './jobrunner.ts';
import { effectLoad, ramEffect } from './objeffects.ts';
import { snesToPc } from './rom.ts';
import { EXT_OBJ_TABLE } from './prefabs.ts';

// extension: object 2D's bytes after its 3 where the ROM reads them (obj2d.ts), its custom number first
export interface ObjSpec { num: number; ext: number; size: number; extension?: number[] }

// sub-objects (see objectVariants) get a key per type, object 2D with an extension one per custom number (and type;
// kind: the custom number's)
export function objKey(s: { num: number; ext: number; size: number; extension?: number[] }, kind: ObjKind | null): string {
  if (s.num === 0) return `e${s.ext}`;
  const v = objectVariant(kind, sizedByte(kind, s)), at = s.extension ? `c${s.extension[0]}` : `s${s.num}`;
  return v < 0 ? at : `${at}.${v}`;
}

// a rendered object: its pixels, the distinct Map16 tiles it produced and where (cells: x, y of a tile's top left
// pixel and its number, one after the other – for the animation, pickeranim.ts); effect: of an extended object or one
// of object 2D's custom numbers that draws no tile, what its load changes in RAM (objeffects.ts ramEffect),
// without pixels (w = h = 0); unhandled: a custom extended object without a handler of its own (it runs one of
// the game's own extended objects' routines), without pixels as well, shown as its object box (see objectThumbsJob)
export interface ObjThumb { key: string; w: number; h: number; px: Uint32Array; m16: number[]; cells: number[]; effect?: string; unhandled?: true }

// the first of the custom extended objects (98–FF): ObjecTool's and Lunar Magic's, the numbers after the game's own.
// A bound of the numbering both use, not a property of a ROM: emulation can't tell where the game's own numbers end
// (its entries past 97 lead to 47/48's routine, #110)
export const CUSTOM_EXT = 0x98;
const isCustomExt = (s: ObjSpec): boolean => s.num === 0 && s.ext >= CUSTOM_EXT;

// their result cache key: the tileset and palettes (kept side by side) and the objects
export function thumbsKey(level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): string {
  const h = level.header;
  // (o4: effects as what they change, extended objects' too; o5: with cells; o6: custom extended objects without a handler)
  return `o6${h.tileset}-${h.fgPalette}-${h.bgPalette}:${inputHash(specs.map((s) => `${s.num}.${s.ext}.${s.size}=${keyOf(s)}`))}`;
}

// what they depend on outside the ROM bytes they read: the level they are drawn in as edited (its number
// decides its graphics slots), the content of the graphics files they draw from and what the level's animations
// copy at its load (graphics and ExAnimation data aren't among the bytes read, see App.gfxSkipMask). Not its BG:
// they show layer 1; nor its size and mode: the test level has its own.
export function thumbsInput(rom: Rom, level: Level): unknown {
  return { level: level.number, header: { ...level.header, screens: 0, mode: 0 }, gfx: layerFilesHash(rom, level), anim: animHash(rom, level.number) };
}
// what the placement preview (App.objectsPreview) depends on outside the ROM bytes it read: the level as edited
// (state) with the objects placed on layer 2 or 1 (their uids don't count) and, as for thumbnails, the content of the
// graphics files its layers draw from and what its animations copy
export function previewInput(rom: Rom, state: EditState, layer2: boolean, objects: LevelObject[]): unknown {
  const level = state.level;
  return { state: state.id, layer2, objects: objects.map((o) => ({ ...o, uid: 0 })), gfx: layerFilesHash(rom, level), anim: animHash(rom, level.number) };
}
// The level as edited (state) with objects placed on layer 2 or 1 (after the layer's own), as its load is given it: the
// objects serialized anew with their owners, the rest of the load as the state's (a BG tilemap only while layer 2
// holds no objects); placed: the placed objects' indices on their layer
export function withPlaced(rom: Rom, state: EditState, layer2: boolean, objects: LevelObject[]): { level: Level; ov: LevelOverride; placed: number[] } {
  const lv = state.level, base = (layer2 ? lv.layer2Objects : lv.objects) ?? [];
  const level = layer2 ? { ...lv, layer2Objects: [...base, ...objects] } : { ...lv, objects: [...base, ...objects] };
  const own = levelOverride(rom, level);
  return { level, ov: { ...state.ov, ...own, bgData: own.layer2 ? undefined : state.ov.bgData }, placed: objects.map((_, i) => base.length + i) };
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
// (objeffects.ts). A custom extended object (CUSTOM_EXT on) whose load reads its entry of the game's own pointer
// table, and the entry leads to the routine of one of the game's own numbers, has no handler of its own (ObjecTool's
// goes around the table, a hook at $0DA106; a patch that repoints the entry gives it a routine of its own): on the
// clean game these entries all lead to the routine of 47/48, which draws door parts from past the end of its table
// (#110). It is shown as its object box instead, as Lunar Magic shows a placeholder for unused extended objects;
// never left out of the list. (Told apart from 47/48 by "reads its data from code" doesn't work: C2–D7 read another
// routine's table, tools/extcodeprobe.ts)
export function* objectThumbsJob(rom: Rom, emu: LevelEmulator, level: Level, specs: ObjSpec[], keyOf: (s: ObjSpec) => string): Generator<void, ObjThumb[]> {
  const out: ObjThumb[] = [];
  const PER = 32;
  const objOf = (s: ObjSpec, i: number): LevelObject => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 16 + 3, y: 12, ...(s.extension ? { extension: s.extension } : {}) });
  // the routines of the game's own extended numbers, by its pointer table (read once needed), as ROM offsets (FastROM
  // moves some of the pointers to the fast banks)
  let own: Set<number> | null = null;
  const routine = (n: number): number => snesToPc(rom.r24(EXT_OBJ_TABLE + n * 3));
  const ownRoutine = (n: number): boolean => (own ??= new Set(Array.from({ length: CUSTOM_EXT }, (_, k) => routine(k)))).has(routine(n));
  // the thumbnails of a load's objects that wrote tiles
  const collect = (r: LevelRender, batch: ObjSpec[]): void => {
    const unhandled = (s: ObjSpec, i: number): boolean => {
      if (!isCustomExt(s) || !r.trace) return false;
      const entry = snesToPc(EXT_OBJ_TABLE + s.ext * 3);
      for (const v of r.trace.reads.get(i) ?? []) if (readOffset(v) === entry) return ownRoutine(s.ext);
      return false;
    };
    // (only the tiles the objects wrote are drawn, as renderLevel draws layer 1: not the whole test level and its BG)
    const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0b] & 0x0f) << 13), src = map16Source(rom, r);
    const g = layerGeom(rom, 0, 0, 32);
    const tileAt = tileByOffset(g);
    batch.forEach((s, i) => {
      if (unhandled(s, i)) { out.push({ key: keyOf(s), w: 0, h: 0, px: new Uint32Array(0), m16: [], cells: [], unhandled: true }); return; }
      const set = r.touched.get(i);
      const tiles: number[] = [];
      if (set) for (const off of set) { const t = tileAt[off]; if (t >= 0) tiles.push(t); }
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
        const m = map16Tile(r.wram, g.addr(tx, ty));
        cells.push((tx - x0) * 16, (ty - y0) * 16, m);
        drawMap16(px, w, hh, tc, src.fg(m), (tx - x0) * 16, (ty - y0) * 16);
      }
      const m16 = new Set<number>();
      for (const off of set!) m16.add(map16Tile(r.wram, MAP_BASE + off));
      out.push({ key: keyOf(s), w, h: hh, px, m16: [...m16].sort((a, b) => a - b), cells });
    });
  };
  const render = (batch: ObjSpec[]): void => {
    // (traced where a custom extended object is among them: whether it has a handler)
    const r = effectLoad(emu, level, batch.map(objOf), true, batch.some(isCustomExt));
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
    const r = effectLoad(emu, level, [objOf(s, 0)], true, isCustomExt(s));
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
  const tileAt = tileByOffset(g), tiles = new Set<number>();
  for (const i of placed) for (const off of r.touched.get(objectKey(layer2, i)) ?? []) { const t = tileAt[off]; if (t >= 0) tiles.add(t); }
  return renderLayerTiles(rom, r, g, layer2, [...tiles]);
}
export type PlacementPreview = NonNullable<ReturnType<typeof renderLayerTiles>>;
