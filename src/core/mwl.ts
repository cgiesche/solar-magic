// A package's sample level (see CONTEXT.md): its Lunar Magic level file (.mwl) as a level of this ROM,
// replacing the current one – or, when the package brings several, the level of its own number – with the
// Map16 tiles, ExGFX and custom sprites rewritten to where the package's parts landed. A level edit, not
// part of the package.
//
// .mwl (Ankouno's "MWL File Format", SMW-Data): at 0x40 (offset, size) pairs of the sections
//  - 0 level information: 2 bytes the level number, then the secondary header ($05F000, $05F200,
//    $05F400, $05F600, then at 6 Lunar Magic's $05DE00), at 14/15 Lunar Magic 3.00's entrance bytes ($06FC00,
//    $06FE00; levelheight.ts), at 16 the level size (Lunar Magic 3.00's TB0MMMMM, LEVEL_SIZE_TABLE; seen in
//    level files Lunar Magic 3.71 exported), at 17 the layer 2 scroll byte ($06FA00, l2scroll.ts); $FF in
//    Lunar Magic's bytes: a ROM without its tables, the game's setting;
//  - 1 layer 1, 2 layer 2, 3 sprites: 8 header bytes (layer 1: byte 0 bit 0 = custom palette), then the
//    data as in the ROM; a BG tilemap as layer 2 is 0x800 bytes (bgpack.ts);
//  - 4 palette: 8 header bytes, 256 colors and the back area color;
//  - 5 the secondary entrances into the level: 8 header bytes, then 8 bytes each – the entrance's number
//    (16 bit), its bytes of $05FA00, $05FC00, $05FE00 and of Lunar Magic's two further tables (SEC_ENT 4/5),
//    one unused byte; its level ($05F800, the high bit in $05FE00) is the level's own;
//  - 6 ExAnimation: 8 header bytes (byte 0: the settings byte, $03FE00), then the list (exanim.ts);
//  - 7 ExGFX numbers of the slots (bgpack.ts).
// Lunar Magic's Direct Map16 objects in layer 1/2 (smwspeedruns' "Level Data Format") become the
// editor's own (extended object $05, patches.ts):
//  - 22 / 23: N10YYYYY 0010XXXX / 0011XXXX HHHHWWWW bbbbbbbb – one tile of page 0 / 1;
//  - 27 (pages 00-3F) / 29 (40-7F): N10YYYYY 0111XXXX / 1001XXXX, then by the top bits of the 4th byte:
//    00 HHHHWWWW 00BBBBBB bbbbbbbb (one tile, a rectangle), 01 hhhhwwww 01BBBBBB bbbbbbbb (a block of
//    tiles from the base tile, unstretched), 10 HHHHWWWW 10BBBBBB bbbbbbbb hhhhwwww (the block repeated
//    over the rectangle), 11 0WWWWWWW 11BBBBBB bbbbbbbb hhhhwwww HHHHHHHH (the same over screens), 11
//    1WWWWWWW 11BBBBBB bbbbbbbb hhhhwwww HHHHHHHH ACCCCCCC (the same with a condition: Lunar Magic's
//    conditional Direct Map16, cdm16.ts).

import type { Rom } from './rom.ts';
import {
  type Level, type LevelObject, type ScreenExit, newUid, parsePrimaryHeader, decodeSecondaryHeader, isL1Vertical, isL2Vertical,
  hasLayer2Objects, hasObjects, parseSprites, spriteSizes, hasLevelSize, isSized, MAX_LEVEL_SIZE, SUBSCREEN_ROWS, SWAPPED_JUMP,
} from './level.ts';
import { DM16_EXT } from './patches.ts';
import { OBJ_2D, objectLength2D } from './obj2d.ts';
import { condOf, type Dm16Cond } from './cdm16.ts';
import { EXT_FIRST, EXT_TILES } from './map16ext.ts';
import { parseList, type ExList } from './exanim.ts';

const u32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

export interface MwlSections {
  number: number; // level it was exported from
  secondary: number[]; // the bytes of SEC_HDR
  layer1: Uint8Array; // with the 5-byte primary header
  customPalette: boolean;
  layer2: Uint8Array | null; // object data (with header) or a BG tilemap (0x800 bytes)
  sprites: Uint8Array; // with the header byte
  palette: Uint8Array | null; // 512 bytes (BGR555 words), color 0 = the back area color
  exanim: ExList | null; // its ExAnimation list
  exanimSettings: number; // its ExAnimation settings byte ($03FE00)
  entrances: { idx: number; bytes: number[] }[]; // its secondary entrances: number, the bytes of SEC_ENT 1-5
}

export function mwlSections(d: Uint8Array): MwlSections {
  if (d.length < 0x80 || d[0] !== 0x4c || d[1] !== 0x4d) throw new Error('Not a Lunar Magic level file (.mwl)');
  const sec = (i: number, header: number): Uint8Array | null => {
    const off = u32(d, 0x40 + i * 8), size = u32(d, 0x44 + i * 8);
    if (!off || size < header || off + size > d.length) return null;
    return d.subarray(off + header, off + size);
  };
  const info = sec(0, 0), l1 = sec(1, 8), l2 = sec(2, 8), spr = sec(3, 8), pal = sec(4, 8), ent = sec(5, 8), ex = sec(6, 8), exh = sec(6, 0);
  if (!info || info.length < 6 || !l1 || l1.length < 6 || !spr || !spr.length) throw new Error('Lunar Magic level file without level data');
  let palette: Uint8Array | null = null;
  if (pal && pal.length >= 514) {
    palette = pal.slice(0, 512);
    palette[0] = pal[512]; palette[1] = pal[513] & 0x7f; // the back area color, as a custom palette holds it
  }
  const l1h = d.subarray(u32(d, 0x40 + 8), u32(d, 0x40 + 8) + 1);
  // a byte of Lunar Magic's tables ($FF: a ROM without them, the game's setting)
  const lm = (i: number) => (info.length > i && info[i] !== 0xff ? info[i] : 0);
  return {
    number: info[0] | (info[1] << 8),
    secondary: [...info.subarray(2, 6), lm(17), info.length > 16 ? info[16] : 0, lm(6), lm(14), lm(15)],
    layer1: l1,
    customPalette: (l1h[0] & 1) !== 0,
    layer2: l2 && l2.length ? l2 : null,
    sprites: spr,
    palette,
    exanim: ex && ex.some((b) => b !== 0) ? parseList(ex).list : null,
    exanimSettings: exh && exh.length ? exh[0] & 0xf0 : 0,
    entrances: ent ? Array.from({ length: ent.length >> 3 }, (_, i) => ({ idx: (ent[i * 8] | (ent[i * 8 + 1] << 8)) & 0x1ff, bytes: [...ent.subarray(i * 8 + 2, i * 8 + 7)] })) : [],
  };
}

// the ExAnimation list of a level file alone (null: none)
export function mwlExAnim(d: Uint8Array): ExList | null {
  const off = u32(d, 0x40 + 6 * 8), size = u32(d, 0x44 + 6 * 8);
  if (d.length < 0x80 || !off || size <= 8 || off + size > d.length) return null;
  const ex = d.subarray(off + 8, off + size);
  return ex.some((b) => b !== 0) ? parseList(ex).list : null;
}

const LM_LEN_2D = 5; // object 2D in Lunar Magic's level files

// layer 1/2 objects with Lunar Magic's Direct Map16 objects as the editor's; `notes`: what is left out
// sized: a level with a size, whose screen jumps have a subscreen (parseObjects)
// tile: the Map16 tile a Direct Map16 tile of the file is here (default: the same); one from 1000 on is left out
// len2d: object 2D's length in the ROM (objectLength2D); the file's are 5 bytes, kept where the ROM reads them so
export function parseLmObjects(data: Uint8Array, start: number, vertical: boolean, notes: string[], sized = false, tile: (t: number) => number = (t) => t, len2d = 3): { objects: LevelObject[]; exits: ScreenExit[] } {
  const objects: LevelObject[] = [];
  const exits: ScreenExit[] = [];
  let p = start, screen = 0, sub = 0, custom = 0, high = 0, cut = false;
  const at = (b0: number, b1: number) => {
    const f5 = b0 & 0x1f, f4 = b1 & 0x0f;
    return vertical ? { x: f5, y: screen * 16 + f4 } : { x: screen * 16 + f4, y: sub * SUBSCREEN_ROWS + f5 };
  };
  const dm16 = (x: number, y: number, t: number, size: number, cond?: Dm16Cond) => {
    const here = tile(t);
    if (here >= EXT_TILES) { cut = true; return; }
    objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size, tile: here, ...(cond ? { cond } : {}) });
  };
  // a block of (ph+1)x(pw+1) tiles from `first` (Map16 rows of 16) over (h+1)x(w+1) tiles
  const pattern = (x: number, y: number, first: number, h: number, w: number, ph: number, pw: number, cond?: Dm16Cond) => {
    for (let r = 0; r <= h; r++) for (let c = 0; c <= w; c++) dm16(x + c, y + r, first + (r % (ph + 1)) * 16 + (c % (pw + 1)), 0, cond);
  };
  while (p < data.length && data[p] !== 0xff) {
    const b0 = data[p], b1 = data[p + 1], b2 = data[p + 2];
    const num = ((b0 >> 1) & 0x30) | (b1 >> 4);
    if (b0 & 0x80) screen++;
    if (num === 0 && b2 === 0) {
      exits.push({ uid: newUid(), screen: b0 & 0x1f, dest: data[p + 3] | ((b1 & 1) << 8), secondary: (b1 & 2) !== 0, flags: b1 & 0x0f });
      p += 4;
      continue;
    }
    if (num === 0 && b2 === 1) { screen = b0 & 0x1f; if (sized && !vertical) sub = b1 & 0x0f; p += 3; continue; }
    if (num === 0 && b2 === SWAPPED_JUMP) { screen = b1 & 0x1f; if (sized && !vertical) sub = b0 & 0x1f; p += 3; continue; }
    const { x, y } = at(b0, b1);
    cut = false;
    if (num === 0x22 || num === 0x23) { dm16(x, y, ((num - 0x22) << 8) | data[p + 3], b2); if (cut) high++; p += 4; continue; }
    if (num === 0x27 || num === 0x29) {
      const b3 = data[p + 3], fmt = b3 >> 6, t = ((b3 & 0x3f) << 8) | data[p + 4] | (num === 0x29 ? 0x4000 : 0);
      const cond = fmt === 3 && b2 & 0x80 ? condOf(data[p + 7]) : undefined;
      const len = cond ? 8 : [5, 5, 6, 7][fmt];
      if (fmt === 0) dm16(x, y, t, b2);
      else if (fmt === 1) pattern(x, y, t, b2 >> 4, b2 & 15, b2 >> 4, b2 & 15);
      else if (fmt === 2) pattern(x, y, t, b2 >> 4, b2 & 15, data[p + 5] >> 4, data[p + 5] & 15);
      else pattern(x, y, t, data[p + 6], b2 & 0x7f, data[p + 5] >> 4, data[p + 5] & 15, cond);
      if (cut) high++;
      p += len;
      continue;
    }
    if (num === OBJ_2D) { // Lunar Magic's custom objects
      if (len2d === LM_LEN_2D) objects.push({ uid: newUid(), num, ext: 0, x, y, size: b2, extension: [data[p + 3], data[p + 4]] });
      else custom++;
      p += LM_LEN_2D;
      continue;
    }
    objects.push({ uid: newUid(), num, ext: num === 0 ? b2 : 0, x, y, size: num === 0 ? 0 : b2 });
    p += 3;
  }
  if (custom) notes.push(`${custom} custom object(s) (Lunar Magic object 2D) left out: the ROM has no code that reads them as 5 bytes`);
  if (high) notes.push(`${high} Direct Map16 object(s) with tiles from 1000 on left out – the editor has tiles up to FFF`);
  return { objects, exits };
}

// the Map16 tiles (Direct Map16) a sample level places in layer 1
export function sampleTiles(rom: Rom, d: Uint8Array): number[] {
  const s = mwlSections(d);
  const header = parsePrimaryHeader(s.layer1.subarray(0, 5));
  if (!hasObjects(header.mode)) return [];
  const { objects } = parseLmObjects(s.layer1, 5, isL1Vertical(rom, header.mode), [], isSized(decodeSecondaryHeader(s.secondary)));
  return [...new Set(objects.filter((o) => o.tile !== undefined).map((o) => o.tile!))].sort((a, b) => a - b);
}

export interface SampleMapping {
  tile(t: number): number | null; // the author's Map16 tile → the tile it went to, null: not the package's
  sprite(num: number, extra: number): number | null; // a custom sprite's number → ours, null: not known
}

export interface SampleLevel { level: Level; palette: Uint8Array | null; exanim: ExList | null; exanimSettings: number; notes: string[] }

// the sample level as level `into.number` (ROM locations for saving in place from `into`); `own`: at its
// own level number, with its own screen exits – else the current level keeps its (those on screens the
// sample level has)
export function sampleLevel(rom: Rom, d: Uint8Array, into: Level, map: SampleMapping, own = false): SampleLevel {
  const s = mwlSections(d);
  const notes: string[] = [];
  const header = parsePrimaryHeader(s.layer1.subarray(0, 5));
  const secondary = decodeSecondaryHeader(s.secondary);
  if (secondary.levelSize > MAX_LEVEL_SIZE) throw new Error(`The level file's level size ${hx(secondary.levelSize, 2)} (Lunar Magic) is not supported – the editor has sizes up to ${hx(MAX_LEVEL_SIZE, 2)}`);
  if (secondary.levelSize && !hasLevelSize(rom, header.mode)) throw new Error(`The level file's level has a size (Lunar Magic) in a level mode (${hx(header.mode, 2)}) the editor has no sizes for`);
  const vert1 = isL1Vertical(rom, header.mode);
  // Direct Map16 tiles where the package's went (also those from 1000 on that went below it)
  const others = new Set<number>();
  const tile = (t: number) => {
    const here = map.tile(t);
    if (here !== null) return here;
    if (t >= EXT_FIRST) others.add(t);
    return t;
  };
  const len2d = objectLength2D(rom);
  const l1 = hasObjects(header.mode) ? parseLmObjects(s.layer1, 5, vert1, notes, isSized(secondary), tile, len2d) : { objects: [], exits: [] };
  let layer2Objects: LevelObject[] | null = null, layer2Header: Uint8Array | null = null;
  if (s.layer2 && hasLayer2Objects(header.mode) && s.layer2.length !== 0x800) {
    layer2Header = s.layer2.slice(0, 5);
    layer2Objects = parseLmObjects(s.layer2, 5, isL2Vertical(rom, header.mode), notes, false, tile, len2d).objects;
  }
  if (others.size) notes.push(`Uses Map16 tiles the package does not bring: ${[...others].map((t) => hx(t, 3)).join(', ')}`);
  const ps = parseSprites(s.sprites, 0, vert1, spriteSizes(rom));
  let dropped = 0;
  const sprites = ps.sprites.filter((q) => {
    if (!(q.extra & 2)) return true;
    const n = map.sprite(q.num, q.extra);
    if (n === null) { dropped++; return false; }
    q.num = n;
    return true;
  });
  if (dropped) notes.push(`${dropped} custom sprite(s) left out: which sprite of the package they are is not certain`);
  // the current level's screen exits, as far as the sample level has their screens
  const exits = own ? l1.exits : into.exits.filter((x) => x.screen < header.screens).map((x) => ({ ...x }));
  if (!own && exits.length < into.exits.length) notes.push(`${into.exits.length - exits.length} screen exit(s) of level ${hx(into.number, 3)} dropped: the sample level has ${header.screens} screen(s)`);
  const level: Level = {
    number: into.number,
    header,
    secondary,
    objects: l1.objects,
    exits,
    layer2Objects,
    layer2Header,
    layer2Pointer: into.layer2Pointer,
    sprites,
    spriteHeader: ps.header,
    l1Addr: into.l1Addr, l1Size: into.l1Size, l2Size: into.l2Size, sprAddr: into.sprAddr, sprSize: into.sprSize,
  };
  return { level, palette: s.customPalette ? s.palette : null, exanim: s.exanim, exanimSettings: s.exanimSettings, notes };
}
