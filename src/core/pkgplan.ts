// Uploads detected per file and linked (ADR 0002): each file of an upload belongs to one part, decided
// from the file alone (folder, then content, then extension), never by which other files are in the
// upload. This module has the parts that are not a tool project of their own – blocks (named in a GPS
// list.txt or found by their content) and graphics parts (Map16 tiles, ExGFX, palettes, shared palettes,
// global animation slots) – and the links between parts:
// - detectBlocks / detectGraphics: what an upload holds, without a ROM;
// - planPackage: where it goes in a ROM – Map16 tiles and ExGFX keep the author's position or number
//   when free, else the next free ones; which tiles show which block; which slot each ExGFX file is for;
// - applyBlocks / applyGraphics / applyLevelSetup: the ROM side.
// Graphics go where the level graphics placement (levelgfx.ts) says, as in a level import. The defines
// naming a sprite of the package are linked by pixipkg.ts.

import type { ToolFolder } from './callisto.ts';
import type { Rom } from './rom.ts';
import type { Upload } from './patchpkg.ts';
import type { ApplyResult } from './patchapply.ts';
import { rewriteDefines } from './patchpkg.ts';
import { parseBlockList, loadBlockProject, saveBlockProject, assignBlock, type BlockProject } from './blocks.ts';
import { parseMap16File, parseRomMap16, romActsLike, map16Targets, exgfxName, type Map16File, type RomMap16 } from './map16file.ts';
import { EXT_FIRST, EXT_TILES, setExtTileWords } from './map16ext.ts';
import { slotTiles, type ExList, type ExSlot } from './exanim.ts';
import { parseMwl, type MwlLevel } from './bgpack.ts';
import {
  slotOfWord, gfxNumber, usedFgTiles, freeRun, fgOrigin, packPalettes, frameSources, putFgTiles, putRomMap16, placeRomMap16, storeGfx, placeInLevel, placeGlobalSlots,
  type PackPalette, type FrameSources, type LevelState, type Placed,
} from './levelgfx.ts';
import { GFX_SLOTS } from './gfxslots.ts';
import { withIncludes } from './pkgmap.ts';
import { isUberList } from './uberproject.ts';
import { mwlExAnim } from './mwl.ts';
import { gfxDataSize } from './patches.ts';
import { isSharedPalettes, changedColors, setSharedColor, sharedColorNames } from './sharedpal.ts';
import { isGlobalAnimBps, globalAnimList } from './globalanim.ts';
import { cleanGameBytes } from './cleangame.ts';
import { listPackages } from './pkgreg.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

// ---------- detection (no ROM) ----------

// a GPS block: its first real statement is db $42 / db $37
export function isBlockText(text: string): boolean {
  const first = text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim())
    .find((l) => l && !/^(print|!|incsrc|incbin|if|endif|else|macro|endmacro|%)/i.test(l) && !/^[A-Za-z_.][A-Za-z0-9_.]*:$/.test(l));
  return !!first && /^db\s+\$(42|37)\b/i.test(first);
}

// "act like 130" / "Acts like: $025" in a block's comments
export function actsComment(text: string): number | undefined {
  const m = /act(?:s)?\s*like[:\s]*\$?([0-9a-f]{1,3})\b/i.exec(text);
  return m ? parseInt(m[1], 16) : undefined;
}

const GPS_LINE = /^[0-9a-f]{3,4}(-[0-9a-f]{3,4})?(:[0-9a-f]{3,4})?\s+\S+\.asm/im;
// (not an UberASM Tool list, whose level lines look alike)
export const isGpsListText = (text: string) => GPS_LINE.test(text) && !isUberList(text);
export const isGpsList = (path: string, text: string) => /(^|\/)list\.txt$/i.test(path) && isGpsListText(text);

// a block of the upload; tile (and acts) when a GPS list.txt names it
export interface DetectedBlock { file: string; tile?: number; acts?: number }

// the blocks of an upload: those a GPS list.txt names, then every other file that is a block by its
// content; gps: the GPS folder and its list when the upload says where they are (a Callisto project)
export function detectBlocks(files: Map<string, Uint8Array>, gps?: ToolFolder | null): { blocks: DetectedBlock[]; list: string | null; missing: string[] } {
  const blocks: DetectedBlock[] = [];
  const missing: string[] = [];
  const list = gps ? gps.list : [...files.keys()].find((p) => isGpsList(p, dec.decode(files.get(p)!))) ?? null;
  if (list) {
    const dir = gps?.folder ?? dirOf(list);
    const find = (name: string) => {
      const n = name.replace(/\\/g, '/');
      for (const c of [dir + n, dir + 'blocks/' + n]) if (files.has(c)) return c;
      return [...files.keys()].find((f) => f.toLowerCase().endsWith('/' + n.toLowerCase()) || f.toLowerCase() === n.toLowerCase()) ?? null;
    };
    for (const b of parseBlockList(dec.decode(files.get(list)!))) {
      const name = b.file.replace(/^blocks\//, '');
      const f = find(name);
      if (f && !blocks.some((x) => x.file === f && x.tile === b.tile)) blocks.push({ file: f, tile: b.tile, acts: b.acts ?? actsComment(dec.decode(files.get(f)!)) });
      else if (!f) missing.push(name);
    }
  }
  if (gps?.list) return { blocks, list, missing }; // (a project's list names all its blocks)
  for (const [f, c] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.asm$/i.test(f) || blocks.some((b) => b.file === f) || /(^|\/)routines\//i.test(f)) continue;
    const text = dec.decode(c);
    if (isBlockText(text)) blocks.push({ file: f, acts: actsComment(text) });
  }
  return { blocks, list, missing };
}

// the graphics parts of an upload, and its Lunar Magic level file (a sample level when the upload has
// code, else a level import)
// (sharedpal: Lunar Magic's shared palettes, sharedpal.ts; globalanim: its global ExAnimation as a BPS,
// globalanim.ts)
export interface DetectedGraphics { map16: string[]; exgfx: string[]; pal: string[]; palmask: string[]; sharedpal: string[]; globalanim: string[]; mwl: string | null }

// `included`: files some .asm file includes (incbin data is code's, not graphics)
export function detectGraphics(files: Map<string, Uint8Array>, included: Set<string>): DetectedGraphics {
  const keys = [...files.keys()].sort();
  const isGfx = (f: string) => {
    if (!/\.bin$/i.test(f) || included.has(f)) return false;
    const n = files.get(f)!.length;
    return /gfx/i.test(base(f)) || n === 0x1000 || n === 0xc00;
  };
  return {
    map16: keys.filter((f) => /\.map16$/i.test(f)),
    exgfx: keys.filter(isGfx),
    pal: keys.filter((f) => /\.pal$/i.test(f) && !isSharedPalettes(files.get(f)!)),
    palmask: keys.filter((f) => /\.palmask$/i.test(f)),
    sharedpal: keys.filter((f) => /\.pal$/i.test(f) && isSharedPalettes(files.get(f)!)),
    globalanim: keys.filter((f) => /\.bps$/i.test(f) && isGlobalAnimBps(files.get(f)!)),
    mwl: keys.find((f) => /\.mwl$/i.test(f)) ?? null,
  };
}

export const graphicsFiles = (g: DetectedGraphics) => [...g.map16, ...g.exgfx, ...g.pal, ...g.palmask, ...g.sharedpal, ...g.globalanim];

// files the .asm files of an upload include (incsrc/incbin)
export function includedFiles(files: Map<string, Uint8Array>): Set<string> {
  const out = new Set<string>();
  for (const [p, c] of files) {
    if (!/\.(asm|asar)$/i.test(p)) continue;
    for (const f of withIncludes(files, new Map([[p, c]])).keys()) if (f !== p) out.add(f);
  }
  return out;
}

// ---------- planning (where everything goes in a ROM) ----------

export interface PlannedBlock { file: string; tiles: number[]; acts: number }
// the package's FG .map16: from = the tile its top left was exported from (as far as known), at = where it goes
export interface PlannedMap16 { file: string; data: Map16File; from: number; at: number }
// the package's whole-ROM .map16 (an export of all Map16): its tiles that differ from the clean game,
// file tile → tile here (FG and BG; levelgfx.ts placeRomMap16)
export interface PlannedRomMap16 { file: string; data: RomMap16; fg: Map<number, number>; bg: Map<number, number> }
// an ExGFX file: lmNum = its number in the package (file name), num = the number it is stored as,
// slot = the graphics slot it is for (null: none known – stored only)
// size: the file's size unpacked (gfxDataSize)
export interface PlannedGfx { file: string; lmNum: number | null; num: number; slot: string | null; size: number }

// the package's shared palettes: the colors differing from the clean game's (index in the block → color)
export interface PlannedSharedPal { file: string; colors: Map<number, number> }
// the package's global animation slots and where they take their frames from (frameFile: its ExGFX 60-63
// file of their list's Anim graphic); they go into free slots of the global list (levelgfx.ts placeGlobalSlots)
export interface PlannedGlobalAnim { file: string; slots: ExSlot[]; frames: FrameSources; frameFile: string | null }
export interface PackagePlan {
  blocks: PlannedBlock[];
  map16: PlannedMap16 | null;
  romMap16: PlannedRomMap16 | null; // instead of map16
  gfx: PlannedGfx[];
  palettes: PackPalette[];
  sharedPal: PlannedSharedPal | null;
  globalAnim: PlannedGlobalAnim | null;
  sample: MwlLevel | null; // the sample level, parsed
  exanim: ExSlot[]; // the sample level's ExAnimation slots that write tiles the package's Map16 tiles draw from
  // where its slots take their frames from: Lunar Magic's AN2 file, its alternative file (ExGFX 60-63);
  // the level setup copies them into the level's Anim graphic (exanim.ts localizeFrames)
  frames: FrameSources;
  notes: string[];
}

// tilesets: this ROM's words of FG tiles 000-1FF per tileset (tilesets.ts tilesetWords), when known: a
// whole-ROM .map16's tileset pages differing from them are reported
export interface PlanInput { files: Map<string, Uint8Array>; blocks: DetectedBlock[]; graphics: DetectedGraphics; tilesets?: number[][][] }

export function planPackage(rom: Rom, input: PlanInput, blank: number[]): PackagePlan {
  const { files, graphics } = input;
  const notes: string[] = [];
  let sample: MwlLevel | null = null;
  if (graphics.mwl) {
    try { sample = parseMwl(files.get(graphics.mwl)!); } catch (e) { notes.push(`${base(graphics.mwl)}: ${e instanceof Error ? e.message : e}`); }
  }
  // an export of all Map16 has all of the package's; else the FG .map16 (a BG one is for a sample level's
  // background)
  const whole = graphics.map16.map((file) => ({ file, data: parseRomMap16(files.get(file)!) })).find((m) => m.data) ?? null;
  for (const f of whole ? graphics.map16.filter((f) => f !== whole.file) : []) notes.push(`${base(f)}: not used – ${base(whole!.file)} has all of the package's Map16`);
  const maps = whole ? [] : graphics.map16.flatMap((file) => {
    try { return [{ file, data: parseMap16File(files.get(file)!) }]; } catch (e) { notes.push(`${base(file)}: ${e instanceof Error ? e.message : e}`); return []; }
  });
  const fgMap = maps.find((m) => !m.data.origin?.bg) ?? null;
  for (const m of maps) if (m !== fgMap && !m.data.origin?.bg) notes.push(`${base(m.file)}: only one FG .map16 per package – not used`);
  const used = usedFgTiles(rom, blank);
  const taken = new Set<number>();
  const isUsed = (t: number) => used(t) || taken.has(t);

  let listed = input.blocks.filter((b) => b.tile !== undefined);
  // the whole-ROM .map16 page by page, the list.txt blocks on its pages moving with them
  let romMap16: PlannedRomMap16 | null = null;
  let pageShift = new Map<number, number>();
  if (whole) {
    const p = placeRomMap16(rom, whole.data!, blank, isUsed, listed.map((b) => b.tile!), input.tilesets, notes);
    romMap16 = { file: whole.file, data: whole.data!, fg: p.fg, bg: p.bg };
    for (const t of p.fg.values()) taken.add(t);
    pageShift = p.shift;
  }
  const onPage = input.blocks.filter((b) => b.tile !== undefined && pageShift.has(b.tile >> 8));
  listed = listed.filter((b) => !onPage.includes(b));
  // Map16 tiles: the author's position when free, else the next free one. With a list.txt, its tiles
  // decide and the .map16 is placed to fit them (top left = the lowest block tile)
  let map16: PlannedMap16 | null = null;
  let shift = 0; // list.txt tiles moved by this much (taken here)
  if (fgMap) {
    const from = fgOrigin(rom, fgMap.data, graphics.mwl ? files.get(graphics.mwl)! : null) ?? (listed.length ? Math.min(...listed.map((b) => b.tile!)) : EXT_FIRST);
    const want = listed.length ? Math.min(...listed.map((b) => b.tile!)) : Math.max(from, EXT_FIRST);
    const offsets = [...new Set([...map16Targets(fgMap.data, 0), ...listed.map((b) => b.tile! - want)])];
    const at = freeRun(want, offsets, isUsed, Math.min(16, fgMap.data.width));
    if (at < 0) throw new Error(`No room for the ${fgMap.data.tiles.length} Map16 tiles of ${base(fgMap.file)}`);
    if (at !== want) notes.push(`Map16 tiles from ${hx(at, 3)} (${hx(want, 3)} is taken)`);
    shift = listed.length ? at - want : 0;
    map16 = { file: fgMap.file, data: fgMap.data, from, at };
    for (const t of map16Targets(fgMap.data, at)) taken.add(t);
  } else if (listed.length) {
    const want = Math.min(...listed.map((b) => b.tile!));
    const offsets = listed.map((b) => b.tile! - want);
    const at = freeRun(want, offsets, isUsed, Math.max(...offsets.map((o) => (o & 15) + 1)));
    if (at < 0) throw new Error('No room for the blocks of list.txt');
    if (at !== want) notes.push(`Blocks from ${hx(at, 3)} (${hx(want, 3)} is taken)`);
    shift = at - want;
  }
  for (const b of listed) taken.add(b.tile! + shift);
  const tileOf = (b: DetectedBlock) => b.tile! + (pageShift.get(b.tile! >> 8) ?? shift);
  for (const b of onPage) taken.add(tileOf(b));

  // blocks: list.txt tiles; else linked to the .map16 tiles (one block: all of them; as many blocks as
  // tiles: in order); else the next free tile
  const mapTiles = map16 ? map16Targets(map16.data, map16.at) : [];
  const unlisted = input.blocks.filter((b) => b.tile === undefined);
  const blocks: PlannedBlock[] = [];
  const fromTile = new Map([...(romMap16?.fg ?? [])].map(([f, t]) => [t, f]));
  const actsAt = (t: number) => {
    const f = fromTile.get(t);
    if (f !== undefined) return romActsLike(romMap16!.data, f) ?? undefined;
    const i = mapTiles.indexOf(t);
    return i >= 0 ? map16!.data.acts?.[i] : undefined;
  };
  for (const b of [...onPage, ...listed]) {
    const t = tileOf(b);
    const have = blocks.find((x) => x.file === b.file);
    if (have) { have.tiles.push(t); continue; }
    blocks.push({ file: b.file, tiles: [t], acts: b.acts ?? actsAt(t) ?? 0x130 });
  }
  // a tile of the whole-ROM .map16 acting like a block's tile shows that block (Lunar Magic runs the
  // block's code for it): the block goes on it too
  if (romMap16) {
    const blockAt = new Map(onPage.map((b) => [b.tile!, blocks.find((x) => x.file === b.file)!]));
    const on = new Set(blocks.flatMap((b) => b.tiles));
    for (const [f, t] of romMap16.fg) {
      const a = romActsLike(romMap16.data, f, (x) => blockAt.has(x));
      const b = a !== null ? blockAt.get(a) : undefined;
      if (b && !on.has(t)) { b.tiles.push(t); on.add(t); }
    }
  }
  if (!listed.length && mapTiles.length && unlisted.length) {
    if (unlisted.length === 1) blocks.push({ file: unlisted[0].file, tiles: [...mapTiles], acts: unlisted[0].acts ?? actsAt(mapTiles[0]) ?? 0x130 });
    else unlisted.slice(0, mapTiles.length).forEach((b, i) => blocks.push({ file: b.file, tiles: [mapTiles[i]], acts: b.acts ?? actsAt(mapTiles[i]) ?? 0x130 }));
  }
  for (const b of unlisted) {
    if (blocks.some((x) => x.file === b.file)) continue;
    let t = EXT_FIRST;
    while (t < EXT_TILES && isUsed(t)) t++;
    if (t >= EXT_TILES) throw new Error('No free Map16 tile left for the blocks');
    taken.add(t);
    blocks.push({ file: b.file, tiles: [t], acts: b.acts ?? 0x130 });
  }

  // ExGFX: the slot from the file name or the sample level's slots
  const named = graphics.exgfx.map((file) => {
    const n = exgfxName(base(file));
    const slot = n.slot ?? (sample && n.num !== null ? [...sample.gfx].find(([, v]) => v === n.num)?.[0] ?? null : null);
    return { file, lmNum: n.num, slot };
  });

  // ExAnimation: the sample level's slots writing tiles the .map16 tiles draw from; the files they take
  // frames from (AN2, the list's alternative file ExGFX 60-63) are frame sources, not ExGFX
  const exanim: ExSlot[] = [];
  let list: ExList | null = null;
  if (graphics.mwl) try { list = mwlExAnim(files.get(graphics.mwl)!); } catch { /* not a list */ }
  if (list && map16) {
    const drawn = new Set(map16.data.tiles.flat().map((w) => w & 0x3ff));
    for (const e of list.slots.values()) if (slotTiles(e).some((t) => drawn.has(t))) exanim.push(e);
  }
  const isAltOf = (l: ExList | null) => (g: { lmNum: number | null; slot: string | null }) => !!l && g.lmNum === 0x60 + l.altFile && !g.slot;
  const isAlt = isAltOf(list);
  const frames = frameSources(files, list, named.find((g) => g.slot === 'AN2')?.file, named.find(isAlt)?.file, notes);
  // the global animation slots: their ExGFX 60-63 file is a frame source too
  const globalAnim = planGlobalAnim(rom, files, graphics.globalanim, (l) => named.find(isAltOf(l))?.file ?? null, notes);
  const kept = named.filter((g) => g.slot !== 'AN2' && !isAlt(g) && g.file !== globalAnim?.frameFile);

  // one file without a slot and one slot the tiles draw from that no other file is for: that one
  const mapSlots = new Set((map16?.data.tiles ?? []).flat().map(slotOfWord).filter((s): s is string => !!s));
  const open = kept.filter((g) => !g.slot);
  const openSlots = [...mapSlots].filter((s) => GFX_SLOTS.includes(s) && !kept.some((g) => g.slot === s));
  if (open.length === 1 && openSlots.length === 1) open[0].slot = openSlots[0];
  for (const g of kept) if (g.slot && !GFX_SLOTS.includes(g.slot)) notes.push(`${base(g.file)} is for Lunar Magic's ${g.slot} slot – not supported, stored only`);
  // the number: the author's when it fits and is free, else the next free one of the file's range
  const nums = new Set<number>();
  const gfx: PlannedGfx[] = kept.map((g) => {
    const size = gfxDataSize(files.get(g.file)!);
    return { ...g, size, num: gfxNumber(rom, g.lmNum, nums, { slot: g.slot, size }) };
  });

  const palettes = packPalettes(files, graphics.pal, graphics.palmask, notes);
  return { blocks, map16, romMap16, gfx, palettes, sharedPal: planSharedPal(rom, files, graphics.sharedpal, notes), globalAnim, sample, exanim, frames, notes };
}

// the FG Map16 tiles a plan's .map16 (or whole-ROM .map16) draws
export const plannedFgTiles = (plan: Pick<PackagePlan, 'map16' | 'romMap16'>): number[] =>
  [...(plan.map16 ? map16Targets(plan.map16.data, plan.map16.at) : []), ...(plan.romMap16?.fg.values() ?? [])];

// the shared palettes (the first file; more are not used): only the colors differing from the clean
// game's are the package's
function planSharedPal(rom: Rom, files: Map<string, Uint8Array>, found: string[], notes: string[]): PlannedSharedPal | null {
  if (!found.length) return null;
  const file = found[0];
  for (const f of found.slice(1)) notes.push(`${base(f)}: not used – ${base(file)} has the package's shared palettes`);
  const colors = changedColors(rom, files.get(file)!);
  if (!colors) { notes.push(`${base(file)}: the clean game's shared palettes are not known in this ROM – not taken over`); return null; }
  if (!colors.size) { notes.push(`${base(file)}: the clean game's shared palettes – nothing to take over`); return null; }
  return { file, colors };
}

// the global animation list (the first file; more are not used), read where its bytes are known (some
// come from the clean game, cleangame.ts); frameFile: the package's ExGFX 60-63 file of a list's Anim graphic
function planGlobalAnim(rom: Rom, files: Map<string, Uint8Array>, found: string[], frameFile: (l: ExList) => string | null, notes: string[]): PlannedGlobalAnim | null {
  if (!found.length) return null;
  const file = found[0];
  for (const f of found.slice(1)) notes.push(`${base(f)}: not used – ${base(file)} has the package's global animation`);
  const list = globalAnimList(files.get(file)!, cleanGameBytes(rom));
  if (list === 'not known') { notes.push(`${base(file)}: needs bytes of the clean game this ROM no longer has – the global animation is not taken over`); return null; }
  if (!list?.slots.size) { notes.push(`${base(file)}: no global animation slots`); return null; }
  if (list.manual.size || list.customSet || list.customKeep !== 0xffff) notes.push(`${base(file)}: the global list's Trigger Init is not taken over`);
  const from = frameFile(list);
  return { file, slots: [...list.slots.values()], frames: frameSources(files, list, undefined, from ?? undefined, notes), frameFile: from };
}

// links changed in the preview: where the .map16 tiles go, which block each of them shows (null: none),
// the tiles of blocks that are on none of them, the ExGFX numbers and slots
export interface PlanEdits {
  map16At?: number;
  tileBlocks?: (string | null)[]; // per .map16 tile (in file order)
  blockTiles?: Map<string, number[]>; // blocks off the .map16
  gfx?: { num: number; slot: string | null }[]; // per plan.gfx
}

// the block on each .map16 tile of a plan (null: none)
export function tileBlocks(plan: PackagePlan): (string | null)[] {
  if (!plan.map16) return [];
  return map16Targets(plan.map16.data, plan.map16.at).map((t) => plan.blocks.find((b) => b.tiles.includes(t))?.file ?? null);
}

// the plan with the edits; throws when two blocks end up on one tile or a tile is outside 200–FFF
export function editPlan(plan: PackagePlan, e: PlanEdits): PackagePlan {
  const old = plan.map16 ? map16Targets(plan.map16.data, plan.map16.at) : [];
  const map16 = plan.map16 ? { ...plan.map16, at: e.map16At ?? plan.map16.at } : null;
  const targets = map16 ? map16Targets(map16.data, map16.at) : [];
  const links = e.tileBlocks ?? tileBlocks(plan);
  // (a whole-ROM .map16's tiles keep their blocks)
  const whole = new Set(plan.romMap16?.fg.values() ?? []);
  const blocks = plan.blocks.map((b) => ({
    ...b,
    tiles: [...targets.filter((_, i) => links[i] === b.file), ...b.tiles.filter((t) => whole.has(t)),
      ...(e.blockTiles?.get(b.file) ?? b.tiles.filter((t) => !old.includes(t) && !whole.has(t)))],
  }));
  const seen = new Set<number>();
  for (const b of blocks) for (const t of b.tiles) {
    if (t < EXT_FIRST || t >= EXT_TILES) throw new Error(`Tile ${hx(t, 3)} of ${base(b.file)} is outside 200–FFF`);
    if (seen.has(t)) throw new Error(`Two blocks on tile ${hx(t, 3)}`);
    seen.add(t);
  }
  if (map16 && ((map16.at & 15) + Math.min(16, map16.data.width) > 16 || map16.at < EXT_FIRST || targets[targets.length - 1] >= EXT_TILES)) throw new Error(`The .map16 tiles do not fit from ${hx(map16.at, 3)} on`);
  const gfx = plan.gfx.map((g, i) => ({ ...g, ...(e.gfx?.[i] ?? {}) }));
  if (new Set(gfx.map((g) => g.num)).size < gfx.length) throw new Error('Two ExGFX files under one number');
  return { ...plan, map16, blocks: blocks.filter((b) => b.tiles.length), gfx };
}

// ---------- the ROM side ----------

// the files of a block for the block project: its own file and what it includes (paths relative to its
// folder), routines wherever they are in the upload
function blockFiles(upload: Upload, file: string, text: (f: string) => Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dir = dirOf(file);
  for (const f of withIncludes(upload.files, new Map([[file, upload.files.get(file)!]])).keys()) {
    if (!/\.(asm|bin)$/i.test(f) || !upload.files.has(f)) continue;
    out.set('blocks/' + (f.startsWith(dir) ? f.slice(dir.length) : base(f)), text(f));
  }
  return out;
}

// routines (GPS/PIXI routines/ folders) a set of files calls as %name()
export function routinesCalled(upload: Upload, routines: string[], callers: string[]): string[] {
  const texts = callers.map((f) => dec.decode(upload.files.get(f)!));
  return routines.filter((r) => { const n = base(r).replace(/\.asm$/i, ''); return texts.some((t) => new RegExp(`%${n}\\s*\\(`, 'i').test(t)); });
}

// adds the blocks to the GPS project, each on its tiles; defines: per block file, defines to set (a
// sprite's number); tileWords: graphics of a block's tile when the package has none for it (from its
// acts like); extra: further files for the project (a Callisto project's header and shared code). Map16 graphics of the package come with applyGraphics.
export function applyBlocks(rom: Rom, upload: Upload, blocks: PlannedBlock[], defines: Map<string, Record<string, string>>, routines: string[],
  blank: number[], tileWords: (acts: number) => number[], drawn: Set<number>, claim: (file: string) => void, extra?: Map<string, Uint8Array>): ApplyResult {
  const proj: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
  for (const [f, c] of extra ?? []) { proj.files.set(f, c); claim(f); }
  const content = (f: string) => {
    const d = defines.get(f);
    return d ? enc.encode(rewriteDefines(dec.decode(upload.files.get(f)!), d).text) : upload.files.get(f)!;
  };
  for (const b of blocks) {
    for (const [f, c] of blockFiles(upload, b.file, content)) { proj.files.set(f, c); claim(f); }
    for (const t of b.tiles) assignBlock(proj, { tile: t, file: 'blocks/' + base(b.file), acts: b.acts });
  }
  for (const r of routines) { const f = r.slice(r.search(/routines\//i)); proj.files.set(f, upload.files.get(r)!); claim(f); }
  const r = saveBlockProject(rom, proj);
  if (!r.ok) return { ...r, errors: r.errors.map((e) => 'Custom blocks: ' + e) };
  for (const b of blocks) for (const t of b.tiles) if (!drawn.has(t)) setExtTileWords(rom, t, tileWords(b.acts));
  return { ...r, prints: [...r.prints, `${blocks.length} block(s): ${blocks.map((b) => `${base(b.file)} on ${b.tiles.map((t) => hx(t, 3)).join(', ')}`).join('; ')}`] };
}

// the shared palettes' colors, the Map16 tiles (with their acts like where no block on them gives one), the
// ExGFX files and the global animation slots
export function applyGraphics(rom: Rom, files: Map<string, Uint8Array>, plan: PackagePlan, blank: number[]): ApplyResult {
  const prints: string[] = [], warnings: string[] = [];
  if (plan.sharedPal) {
    const { file, colors } = plan.sharedPal;
    // a color another package changed is a conflict
    const errors = listPackages(rom).flatMap((p) => {
      const both = (p.sharedPal ?? []).map(([i]) => i).filter((i) => colors.has(i));
      return both.length ? [`Conflict with package “${p.name}”: both change the shared palettes' ${sharedColorNames(both).join('; ')}.`] : [];
    });
    if (errors.length) return { ok: false, errors, warnings: [], prints };
    for (const [i, c] of colors) setSharedColor(rom, i, c);
    prints.push(`${colors.size} shared palette color(s) from ${base(file)}: ${sharedColorNames([...colors.keys()]).join('; ')}`);
  }
  if (plan.map16) {
    const m = plan.map16;
    const targets = putFgTiles(rom, m.data, m.from, m.at, new Set(plan.blocks.flatMap((b) => b.tiles)));
    prints.push(`${targets.length} Map16 tile(s) from ${hx(m.at, 3)}`);
  }
  if (plan.romMap16) {
    const m = plan.romMap16;
    putRomMap16(rom, m.data, m, new Set(plan.blocks.flatMap((b) => b.tiles)));
    // its pages, those moved with the tile they start at
    const pages = (to: Map<number, number>, bg: number) => [...new Map([...to].map(([f, t]) => [f >> 8, t - f]))]
      .map(([p, d]) => `${hx(p + bg, 2)}${d ? ` at ${hx((p << 8) + d, 3)}` : ''}`).join(', ');
    prints.push(`${m.fg.size} FG Map16 tile(s) (pages ${pages(m.fg, 0)}) and ${m.bg.size} BG tile(s) (pages ${pages(m.bg, 0x80)}) from ${base(m.file)}`);
  }
  prints.push(...storeGfx(rom, files, plan.gfx));
  if (plan.globalAnim) {
    const g = placeGlobalSlots(rom, plan.globalAnim.slots, plan.globalAnim.frames);
    warnings.push(...g.warnings.map((w) => `${base(plan.globalAnim!.file)}: ${w}`));
    prints.push(...g.prints.map((p) => `${p} from ${base(plan.globalAnim!.file)}`));
  }
  return { ok: true, errors: [], warnings, prints };
}

// the level setup (see CONTEXT.md): the package's ExGFX in the level's slots, its ExAnimation slots in
// the level's list (their frames copied into its Anim graphic), the masked colors in its palette
export function applyLevelSetup(rom: Rom, level: number, plan: PackagePlan, state: LevelState): Placed {
  return placeInLevel(rom, level, {
    slots: plan.gfx, palettes: plan.palettes.filter((p) => !p.layer3), back: plan.sample?.back ?? null, exanim: plan.exanim, frames: plan.frames,
  }, state);
}
