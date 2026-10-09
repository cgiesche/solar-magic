// Uploads detected per file and linked (ADR 0002): each file of an upload belongs to one part, decided
// from the file alone (folder, then content, then extension), never by which other files are in the
// upload. This module has the parts that are not a tool project of their own – blocks (named in a GPS
// list.txt or found by their content) and graphics parts (Map16 tiles, ExGFX, palettes) – and the
// links between parts:
// - detectBlocks / detectGraphics: what an upload holds, without a ROM;
// - planPackage: where it goes in a ROM – Map16 tiles and ExGFX keep the author's position or number
//   when free, else the next free ones; which tiles show which block; which slot each ExGFX file is for;
// - applyBlocks / applyGraphics / applyLevelSetup: the ROM side.
// The defines naming a sprite of the package are linked by pixipkg.ts.

import type { Rom } from './rom.ts';
import type { Upload } from './patchpkg.ts';
import type { ApplyResult } from './patchapply.ts';
import { rewriteDefines } from './patchpkg.ts';
import { parseBlockList, loadBlockProject, saveBlockProject, type BlockProject } from './blocks.ts';
import { parseMap16File, map16Targets, exgfxName, importGfxFile, type Map16File } from './map16file.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, map16Ext, extTileWords, actsLike, setExtTileWords, setActsLike } from './map16ext.ts';
import { gfxEntry, hasEditorPatch, VANILLA_GFX, levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES, EXT_GFX_SLOT_NAMES, extGfxAvailable, customPalette, setCustomPalette, setLevelAn2 } from './patches.ts';
import { slotTiles, usesAltFile, addLevelSlots, type ExList, type ExSlot } from './exanim.ts';
import { parseMwl, packPalettes, slotOfWord, type MwlLevel, type PackPalette } from './bgpack.ts';
import { withIncludes } from './pkgmap.ts';
import { sampleTiles, mwlSections } from './mwl.ts';

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

const GPS_LINE = /^[0-9a-f]{3,4}(:[0-9a-f]{3})?\s+\S+\.asm/im;
export const isGpsList = (path: string, text: string) => /(^|\/)list\.txt$/i.test(path) && GPS_LINE.test(text);

// a block of the upload; tile (and acts) when a GPS list.txt names it
export interface DetectedBlock { file: string; tile?: number; acts?: number }

// the blocks of an upload: those a GPS list.txt names, then every other file that is a block by its
// content; `skip`: files of other parts
export function detectBlocks(files: Map<string, Uint8Array>, skip: Set<string>): { blocks: DetectedBlock[]; list: string | null; missing: string[] } {
  const blocks: DetectedBlock[] = [];
  const missing: string[] = [];
  const list = [...files.keys()].find((p) => !skip.has(p) && isGpsList(p, dec.decode(files.get(p)!))) ?? null;
  if (list) {
    const dir = dirOf(list);
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
  for (const [f, c] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.asm$/i.test(f) || skip.has(f) || blocks.some((b) => b.file === f) || /(^|\/)routines\//i.test(f)) continue;
    const text = dec.decode(c);
    if (isBlockText(text)) blocks.push({ file: f, acts: actsComment(text) });
  }
  return { blocks, list, missing };
}

// the graphics parts of an upload, and its Lunar Magic level file (a sample level when the upload has
// code, else a level import)
export interface DetectedGraphics { map16: string[]; exgfx: string[]; pal: string[]; palmask: string[]; mwl: string | null }

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
    pal: keys.filter((f) => /\.pal$/i.test(f)),
    palmask: keys.filter((f) => /\.palmask$/i.test(f)),
    mwl: keys.find((f) => /\.mwl$/i.test(f)) ?? null,
  };
}

export const graphicsFiles = (g: DetectedGraphics) => [...g.map16, ...g.exgfx, ...g.pal, ...g.palmask];

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
// an ExGFX file: lmNum = its number in the package (file name), num = the number it is stored as,
// slot = the graphics slot it is for (null: none known – stored only)
export interface PlannedGfx { file: string; lmNum: number | null; num: number; slot: string | null }

export interface PackagePlan {
  blocks: PlannedBlock[];
  map16: PlannedMap16 | null;
  gfx: PlannedGfx[];
  palettes: PackPalette[];
  sample: MwlLevel | null; // the sample level, parsed
  exanim: ExSlot[]; // the sample level's ExAnimation slots that write tiles the package's Map16 tiles draw from
  notes: string[];
}

export interface PlanInput { files: Map<string, Uint8Array>; blocks: DetectedBlock[]; graphics: DetectedGraphics }

// the slots ExGFX can go in: the level's GFX bypass, the BG2/BG3 slots of the VRAM patch and AN2 (for
// ExAnimation, patches.ts)
export const GFX_SLOTS = [...GFX_SLOT_NAMES, ...EXT_GFX_SLOT_NAMES, 'AN2'];

// first ExGFX number that is free and not taken by `taken` (80-FE first, as Lunar Magic suggests)
function freeGfx(rom: Rom, taken: Set<number>): number {
  const free = (i: number) => !taken.has(i) && (!hasEditorPatch(rom) || !gfxEntry(rom, i));
  for (let i = 0x80; i < 0xff; i++) if (free(i)) return i;
  for (let i = VANILLA_GFX; i < 0x80; i++) if (free(i)) return i;
  return -1;
}

// tiles the ROM already uses: a block on them, or graphics / acts like other than an empty tile's
function usedTiles(rom: Rom, blank: number[]): (t: number) => boolean {
  const blocks = new Set((loadBlockProject(rom)?.list ?? []).map((b) => b.tile));
  const ext = !!map16Ext(rom);
  return (t) => {
    if (t < EXT_FIRST || t >= EXT_TILES) return true;
    if (blocks.has(t)) return true;
    if (!ext) return false;
    const w = extTileWords(rom, t);
    return !!w && (w.some((v, k) => v !== blank[k]) || actsLike(rom, t) !== DEFAULT_ACTS);
  };
}

// the first position from `want` on (then from 200) where all `offsets` (relative tiles) are free and
// stay in their rows; `want` itself when it fits
function freeRun(want: number, offsets: number[], used: (t: number) => boolean, width: number): number {
  const fits = (at: number) => (at & 15) + width <= 16 && offsets.every((o) => !used(at + o));
  if (fits(want)) return want;
  for (let at = EXT_FIRST; at < EXT_TILES; at++) if (fits(at)) return at;
  return -1;
}

export function planPackage(rom: Rom, input: PlanInput, blank: number[]): PackagePlan {
  const { files, graphics } = input;
  const notes: string[] = [];
  let sample: MwlLevel | null = null;
  if (graphics.mwl) {
    try { sample = parseMwl(files.get(graphics.mwl)!); } catch (e) { notes.push(`${base(graphics.mwl)}: ${e instanceof Error ? e.message : e}`); }
  }
  // the FG .map16 (a BG one is for a sample level's background)
  const maps = graphics.map16.flatMap((file) => {
    try { return [{ file, data: parseMap16File(files.get(file)!) }]; } catch (e) { notes.push(`${base(file)}: ${e instanceof Error ? e.message : e}`); return []; }
  });
  const fgMap = maps.find((m) => !m.data.origin?.bg) ?? null;
  for (const m of maps) if (m !== fgMap && !m.data.origin?.bg) notes.push(`${base(m.file)}: only one FG .map16 per package – not used`);
  const used = usedTiles(rom, blank);
  const taken = new Set<number>();
  const isUsed = (t: number) => used(t) || taken.has(t);

  // Map16 tiles: the author's position when free, else the next free one. With a list.txt, its tiles
  // decide and the .map16 is placed to fit them (top left = the lowest block tile)
  const listed = input.blocks.filter((b) => b.tile !== undefined);
  let map16: PlannedMap16 | null = null;
  let shift = 0; // list.txt tiles moved by this much (taken here)
  if (fgMap) {
    let from = fgMap.data.origin && !fgMap.data.origin.bg ? fgMap.data.origin.tile : listed.length ? Math.min(...listed.map((b) => b.tile!)) : EXT_FIRST;
    // the .map16 knows its row only: the column from the tiles the sample level places in those rows
    if (fgMap.data.origin && !fgMap.data.origin.bg && graphics.mwl && fgMap.data.width < 16) {
      let tiles: number[] = [];
      try { tiles = sampleTiles(rom, files.get(graphics.mwl)!).filter((t) => t >= from && t < from + fgMap.data.height * 16); } catch { /* no level data */ }
      const col = Math.min(...tiles.map((t) => t & 15));
      if (tiles.length && tiles.every((t) => (t & 15) - col < fgMap.data.width)) from += col;
    }
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

  // blocks: list.txt tiles; else linked to the .map16 tiles (one block: all of them; as many blocks as
  // tiles: in order); else the next free tile
  const mapTiles = map16 ? map16Targets(map16.data, map16.at) : [];
  const unlisted = input.blocks.filter((b) => b.tile === undefined);
  const blocks: PlannedBlock[] = [];
  const actsAt = (t: number) => { const i = mapTiles.indexOf(t); return i >= 0 ? map16!.data.acts?.[i] : undefined; };
  for (const b of listed) {
    const t = b.tile! + shift;
    const have = blocks.find((x) => x.file === b.file);
    if (have) { have.tiles.push(t); continue; }
    blocks.push({ file: b.file, tiles: [t], acts: b.acts ?? actsAt(t) ?? 0x130 });
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

  // ExGFX: the author's number when free (00-FE), else the next free one; the slot from the file name,
  // the sample level's slots or the slot the .map16 tiles draw from
  const gfx: PlannedGfx[] = [];
  const nums = new Set<number>();
  const mapSlots = new Set((map16?.data.tiles ?? []).flat().map(slotOfWord).filter((s): s is string => !!s));
  for (const file of graphics.exgfx) {
    const n = exgfxName(base(file));
    const free = n.num !== null && n.num >= VANILLA_GFX && n.num < 0xff && !nums.has(n.num) && (!hasEditorPatch(rom) || !gfxEntry(rom, n.num));
    const num = free ? n.num! : freeGfx(rom, nums);
    if (num < 0) throw new Error('No free ExGFX number left');
    nums.add(num);
    let slot = n.slot;
    if (!slot && sample && n.num !== null) slot = [...sample.gfx].find(([, v]) => v === n.num)?.[0] ?? null;
    gfx.push({ file, lmNum: n.num, num, slot });
  }
  // one file without a slot and one slot the tiles draw from that no other file is for: that one
  const open = gfx.filter((g) => !g.slot);
  const openSlots = [...mapSlots].filter((s) => GFX_SLOTS.includes(s) && !gfx.some((g) => g.slot === s));
  if (open.length === 1 && openSlots.length === 1) open[0].slot = openSlots[0];
  for (const g of gfx) if (g.slot && !GFX_SLOTS.includes(g.slot)) notes.push(`${base(g.file)} is for Lunar Magic's ${g.slot} slot – not supported, stored only`);
  for (const g of gfx) if (g.slot === 'AN2' && files.get(g.file)!.length !== 0x1000) notes.push(`${base(g.file)} cannot be AN2: only uncompressed 4bpp files (4 KB) can`);

  // ExAnimation: the sample level's slots writing tiles the .map16 tiles draw from
  const exanim: ExSlot[] = [];
  if (graphics.mwl && map16) {
    let list: ExList | null = null;
    try { list = mwlSections(files.get(graphics.mwl)!).exanim; } catch { /* no level data */ }
    const drawn = new Set(map16.data.tiles.flat().map((w) => w & 0x3ff));
    for (const e of list?.slots.values() ?? []) {
      if (!slotTiles(e).some((t) => drawn.has(t))) continue;
      if (usesAltFile(e)) { notes.push('An ExAnimation slot of the package takes its frames from an alternative file (ExGFX 60-63) – not taken over'); continue; }
      exanim.push(e);
    }
  }

  const palettes = packPalettes(files, graphics.pal, graphics.palmask, notes);
  return { blocks, map16, gfx, palettes, sample, exanim, notes };
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
  const blocks = plan.blocks.map((b) => ({
    ...b,
    tiles: [...targets.filter((_, i) => links[i] === b.file), ...(e.blockTiles?.get(b.file) ?? b.tiles.filter((t) => !old.includes(t)))],
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
// acts like). Map16 graphics of the package come with applyGraphics.
export function applyBlocks(rom: Rom, upload: Upload, blocks: PlannedBlock[], defines: Map<string, Record<string, string>>, routines: string[],
  blank: number[], tileWords: (acts: number) => number[], drawn: Set<number>, claim: (file: string) => void): ApplyResult {
  const proj: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
  const content = (f: string) => {
    const d = defines.get(f);
    return d ? enc.encode(rewriteDefines(dec.decode(upload.files.get(f)!), d).text) : upload.files.get(f)!;
  };
  const tiles = new Set(blocks.flatMap((b) => b.tiles));
  proj.list = proj.list.filter((b) => !tiles.has(b.tile));
  for (const b of blocks) {
    for (const [f, c] of blockFiles(upload, b.file, content)) { proj.files.set(f, c); claim(f); }
    for (const t of b.tiles) proj.list.push({ tile: t, file: 'blocks/' + base(b.file), acts: b.acts });
  }
  for (const r of routines) { const f = r.slice(r.search(/routines\//i)); proj.files.set(f, upload.files.get(r)!); claim(f); }
  const r = saveBlockProject(rom, proj, blank);
  if (!r.ok) return { ...r, errors: r.errors.map((e) => 'Custom blocks: ' + e) };
  for (const b of blocks) for (const t of b.tiles) if (!drawn.has(t)) setExtTileWords(rom, t, tileWords(b.acts), blank);
  return { ...r, prints: [...r.prints, `${blocks.length} block(s): ${blocks.map((b) => `${base(b.file)} on ${b.tiles.map((t) => hx(t, 3)).join(', ')}`).join('; ')}`] };
}

// the Map16 tiles (with their acts like where no block on them gives one) and the ExGFX files
export function applyGraphics(rom: Rom, files: Map<string, Uint8Array>, plan: PackagePlan, blank: number[]): ApplyResult {
  const prints: string[] = [];
  if (plan.map16) {
    const m = plan.map16;
    const targets = map16Targets(m.data, m.at), from = map16Targets(m.data, m.from);
    const onBlock = new Set(plan.blocks.flatMap((b) => b.tiles));
    targets.forEach((t, i) => {
      setExtTileWords(rom, t, m.data.tiles[i], blank);
      const a = m.data.acts?.[i];
      // acts like pointing into the .map16 itself moves along
      if (a !== undefined && !onBlock.has(t)) { const k = from.indexOf(a); setActsLike(rom, t, k >= 0 ? targets[k] : a, blank); }
    });
    prints.push(`${targets.length} Map16 tile(s) from ${hx(m.at, 3)}`);
  }
  for (const g of plan.gfx) prints.push(`${base(g.file)} as ExGFX ${hx(g.num, 2)} (${importGfxFile(rom, g.num, files.get(g.file)!)})`);
  return { ok: true, errors: [], warnings: [], prints };
}

export interface SetupResult { warnings: string[]; prints: string[] }

// the level setup (see CONTEXT.md): the package's ExGFX in the level's slots (AN2 too), its ExAnimation
// slots in the level's list, the masked colors in its palette. cgram: the level's colors now (base of a
// new own palette). The VRAM patch for BG2/BG3 is the caller's.
export function applyLevelSetup(rom: Rom, level: number, plan: PackagePlan, cgram: Uint8Array | null): SetupResult {
  const warnings: string[] = [], prints: string[] = [];
  const std = levelGfx(rom, level), ext = levelExtGfx(rom, level);
  let stdSet = false, extSet = false;
  const slots: string[] = [];
  for (const g of plan.gfx) {
    if (!g.slot) continue;
    const e = EXT_GFX_SLOT_NAMES.indexOf(g.slot), s = GFX_SLOT_NAMES.indexOf(g.slot);
    if (e >= 0) {
      if (!extGfxAvailable(rom)) { warnings.push(`${g.slot} slot not available (VRAM patch missing) – ExGFX ${hx(g.num, 2)} not loaded in level ${hx(level, 3)}`); continue; }
      ext[e] = g.num; extSet = true;
    } else if (s >= 0) { std[s] = g.num; stdSet = true; } else if (g.slot === 'AN2') {
      try { setLevelAn2(rom, level, g.num); } catch (err) { warnings.push(err instanceof Error ? err.message : String(err)); continue; }
    } else continue;
    slots.push(`${g.slot} = ${hx(g.num, 2)}`);
  }
  if (plan.exanim.length) {
    const used = addLevelSlots(rom, level, plan.exanim);
    prints.push(`Level ${hx(level, 3)}: ExAnimation slot(s) ${used.map((k) => hx(k, 2)).join(', ')}`);
  }
  if (stdSet) setLevelGfx(rom, level, std);
  if (extSet) setLevelExtGfx(rom, level, ext);
  if (slots.length) prints.push(`Level ${hx(level, 3)}: ${slots.join(', ')}`);
  const pals = plan.palettes.filter((p) => !p.layer3);
  if (pals.length) {
    const own = customPalette(rom, level);
    if (!own && !cgram) warnings.push(`Colors not set: the colors of level ${hx(level, 3)} are not known`);
    else {
      const pal = own ? rom.bytes(own, 512).slice() : cgram!.slice(0, 512);
      for (const p of pals) {
        for (const i of p.colors) { pal[i * 2] = p.pal[i] & 0xff; pal[i * 2 + 1] = p.pal[i] >> 8; }
        if (p.back && plan.sample) { pal[0] = plan.sample.back & 0xff; pal[1] = plan.sample.back >> 8; }
        prints.push(`Level ${hx(level, 3)}: ${p.colors.length} color(s) from ${base(p.file)}`);
      }
      setCustomPalette(rom, level, pal);
    }
  }
  return { warnings, prints };
}
