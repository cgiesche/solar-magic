// Super Mario World level data: parsing and serialization.

import { Rom } from './rom.ts';
import { spriteBankOf, DM16_EXT } from './patches.ts';
import { STRUCT_EXT } from './structs.ts';
import { MAP_SIZE } from './ram.ts';

export const L1_PTRS = 0x05e000;
export const L2_PTRS = 0x05e600;
export const SPR_PTRS = 0x05ec00;
// the secondary header: the game's four tables, Lunar Magic's layer 2 scroll byte ($06FA00, l2scroll.ts),
// the level size byte (LEVEL_SIZE_TABLE) and Lunar Magic 3.00's three entrance bytes ($05DE00, $06FC00,
// $06FE00: the entrance at a tile, the camera relative to Mario, the BG's height; levelheight.ts)
export const SEC_HDR = [0x05f000, 0x05f200, 0x05f400, 0x05f600, 0x06fa00, 0x06ca00, 0x05de00, 0x06fc00, 0x06fe00];

// ----- level size (Lunar Magic 3.00's horizontal level heights, levelheight.ts) -----
// A byte per level in Lunar Magic's format TB0MMMMM: M the size, T (layer 2 or 3) and B (show the bottom
// row) Lunar Magic's own, kept. Lunar Magic keeps the table where its code is; the editor's is here.
export const LEVEL_SIZE_TABLE = SEC_HDR[5];
// the height in pixels per size (the 0x3800 bytes of level data shared by the screens); also a screen's
// bytes in the level data. Measured: what Lunar Magic's code sets as the level's height ($13D7) per size.
export const LEVEL_HEIGHTS = [
  0x1b0, 0x1c0, 0x1d0, 0x200, 0x220, 0x250, 0x260, 0x280, 0x2a0, 0x2c0, 0x2f0, 0x310, 0x340, 0x380, 0x3b0, 0x400,
  0x440, 0x4a0, 0x510, 0x590, 0x630, 0x700, 0x800, 0x950, 0xb30, 0xe00, 0x12a0, 0x1c00, 0x3800, 0x100, 0xf0, 0xe0,
];
// sizes the editor offers: 1C (one screen, 0x3800 pixels) needs Lunar Magic's swapped screen jump, extended
// object $03, which is the editor's structure; 1D-1F have more than 32 screens
export const MAX_LEVEL_SIZE = 0x1b;
export const SUBSCREEN_ROWS = 32; // a taller level's object and sprite positions count in subscreens of 32 rows
export const levelRows = (s: { levelSize: number }): number => LEVEL_HEIGHTS[s.levelSize & 0x1f] >> 4;
// a level with subscreens: objects and sprites below row 31 (screen jumps with a subscreen, sprite data
// in Lunar Magic's new format)
export const isTall = (s: { levelSize: number }): boolean => levelRows(s) > SUBSCREEN_ROWS;
// a level with a size: its screen jumps have a subscreen (as the patch reads them)
export const isSized = (s: { levelSize: number }): boolean => (s.levelSize & 0x1f) !== 0;
export const maxScreens = (s: { levelSize: number }): number => Math.min(32, Math.floor(MAP_SIZE / LEVEL_HEIGHTS[s.levelSize & 0x1f]));
// secondary entrances: the game's four tables, then Lunar Magic 3.00's two (EFYYYYYY, RLW-----; Lunar
// Magic keeps them where its code is, the editor here)
export const SEC_ENT = [0x05f800, 0x05fa00, 0x05fc00, 0x05fe00, 0x06cc00, 0x06ce00];

export interface LevelObject {
  uid: number;
  num: number; // standard object number 1..0x3F, 0 = extended
  ext: number; // extended object number (num === 0)
  x: number; // absolute tile position
  y: number;
  size: number; // settings byte for standard objects (and Direct Map16)
  tile?: number; // Direct Map16 tile number (extended object $02, editor patch)
  struct?: number; // structure number (extended object $03 with the structure patch, see structs.ts)
}

export interface ScreenExit {
  uid: number;
  screen: number;
  dest: number; // destination level (or secondary entrance) number, 9 bit
  secondary: boolean;
  flags: number; // the low nibble of byte 1, Lunar Magic's 0000wush (h: dest's high bit, s: secondary, u, w kept)
}
// a screen exit's w (Lunar Magic's): a secondary exit makes the level it leads to a water level (a standard
// exit would lead to the midway entrance with separate settings, which the editor doesn't have)
export const EXIT_WATER = 0x08;
// makes a screen exit secondary or standard; w means something else for the other kind, so a change drops it
export function setExitSecondary(e: ScreenExit, secondary: boolean): void {
  if (e.secondary !== secondary) e.flags &= ~EXIT_WATER;
  e.secondary = secondary;
}

export interface LevelSprite {
  uid: number;
  num: number;
  x: number;
  y: number;
  extra: number; // 2 extra bits (bit 1 = custom sprite, bit 0 = extra bit with PIXI)
  bytes?: number[]; // extra bytes of a custom sprite (PIXI), as many as the size table says
}

export interface PrimaryHeader {
  bgPalette: number; // 3
  screens: number; // 1..32
  backAreaColor: number; // 3
  mode: number; // 5
  layer3Priority: number; // 1
  music: number; // 3
  spriteGfx: number; // 4
  time: number; // 2
  spritePalette: number; // 3
  fgPalette: number; // 3
  itemMemory: number; // 2
  verticalScroll: number; // 2
  tileset: number; // 4
}

export interface SecondaryHeader {
  layer2Scroll: number; // F000 bits 7-4: the paired setting, or with layer2Separate the horizontal rate
  entranceY: number; // F000 bits 3-0
  layer3: number; // F200 bits 7-6
  entranceAction: number; // F200 bits 5-3
  entranceX: number; // F200 bits 2-0
  midwayScreen: number; // F400 bits 7-4
  fgInitY: number; // F400 bits 3-2
  bgInitY: number; // F400 bits 1-0
  noYoshiIntro: number; // F600 bit 7
  verticalPositioning: number; // F600 bits 6-5
  entranceScreen: number; // F600 bits 4-0
  layer2Separate: number; // FA00 bit 7: separate horizontal and vertical layer 2 rates
  layer2HAuto: number; // FA00 bit 6: the horizontal rate (layer2Scroll) is an auto-scroll
  layer2V: number; // FA00 bits 4-0: the vertical rate
  lmAutoScreens: number; // FA00 bit 5: Lunar Magic's "auto-set number of screens" (kept, not used)
  levelSize: number; // CA00 bits 4-0: the height of a horizontal level (LEVEL_HEIGHTS), 0 = the game's
  levelSizeFlags: number; // CA00 bits 7-5: Lunar Magic's T and B (kept, not used)
  // Lunar Magic 3.00's entrance (levelheight.ts)
  entranceTile: number; // DE00 bit 5: Mario at tile X/Y of the entrance screen (entranceX/Y their low bits)
  entranceXHi: number; // DE00 bits 4-3: X bits 4-3
  entranceYHi: number; // FC00 bits 5-0: Y bits 9-4
  water: number; // DE00 bit 6: a water level (Mario swims)
  lmEntranceFlags: number; // DE00 bits 7, 2-0: slippery, the sprites' spawn range (kept, not used)
  cameraRelative: number; // FE00 bit 7: the camera starts relative to Mario (cameraOffset), the BG to match
  cameraOffsetHi: number; // FC00 bit 6: bit 4 of the offset (bits 3-0: fgInitY, bgInitY)
  bgRelative: number; // FC00 bit 7: with cameraRelative the BG starts at the FG + 16 * bgHeight (signed)
  bgHeight: number; // FE00 bits 4-0: the BG's height in rows - 1 (or with bgRelative its offset)
  faceLeft: number; // FE00 bit 6: Mario faces left
  lmSpareBit: number; // FE00 bit 5 (unused in Lunar Magic's layout, kept)
}

export interface Level {
  number: number;
  header: PrimaryHeader;
  secondary: SecondaryHeader;
  objects: LevelObject[];
  exits: ScreenExit[];
  // layer 2: either object data (L2 levels) or a BG tilemap pointer
  layer2Objects: LevelObject[] | null;
  layer2Header: Uint8Array | null; // 5 raw header bytes of L2 object data
  layer2Pointer: number; // original 24-bit pointer
  bg?: Uint16Array | null; // edited BG tilemap (bg.ts layout), saved on the next save
  layer3?: Uint16Array | null; // edited layer 3 tilemap (layer3map.ts, VRAM $5000-$5FFF), saved into its LT3 file on the next save
  sprites: LevelSprite[];
  spriteHeader: number;
  // original locations (for in-place saving)
  l1Addr: number;
  l1Size: number;
  l2Size: number;
  sprAddr: number;
  sprSize: number;
}

let uidCounter = 1;
export function newUid(): number {
  return uidCounter++;
}

// ----- mode info (from ROM table $058417) -----
export function modeFlags(rom: Rom, mode: number): number {
  return rom.r8(0x058417 + (mode & 0x1f));
}
export function isL1Vertical(rom: Rom, mode: number): boolean {
  return (modeFlags(rom, mode) & 1) !== 0;
}
export function isL2Vertical(rom: Rom, mode: number): boolean {
  return (modeFlags(rom, mode) & 2) !== 0;
}
// Modes in which layer 2 holds level objects (see $0583D4)
export function hasLayer2Objects(mode: number): boolean {
  return ![0x00, 0x0a, 0x0c, 0x0d, 0x0e, 0x11, 0x1e, 0x09, 0x0b, 0x10].includes(mode);
}
export function hasObjects(mode: number): boolean {
  return ![0x09, 0x0b, 0x10].includes(mode);
}
// modes a level can have a size (a height) in: horizontal, with objects, layer 2 not of objects
export function hasLevelSize(rom: Rom, mode: number): boolean {
  return hasObjects(mode) && !hasLayer2Objects(mode) && !isL1Vertical(rom, mode);
}

// ----- header -----
export function parsePrimaryHeader(b: Uint8Array): PrimaryHeader {
  return {
    bgPalette: b[0] >> 5,
    screens: (b[0] & 0x1f) + 1,
    backAreaColor: b[1] >> 5,
    mode: b[1] & 0x1f,
    layer3Priority: b[2] >> 7,
    music: (b[2] >> 4) & 7,
    spriteGfx: b[2] & 0x0f,
    time: b[3] >> 6,
    spritePalette: (b[3] >> 3) & 7,
    fgPalette: b[3] & 7,
    itemMemory: b[4] >> 6,
    verticalScroll: (b[4] >> 4) & 3,
    tileset: b[4] & 0x0f,
  };
}
export function encodePrimaryHeader(h: PrimaryHeader): Uint8Array {
  return new Uint8Array([
    (h.bgPalette << 5) | ((h.screens - 1) & 0x1f),
    (h.backAreaColor << 5) | (h.mode & 0x1f),
    (h.layer3Priority << 7) | ((h.music & 7) << 4) | (h.spriteGfx & 0x0f),
    (h.time << 6) | ((h.spritePalette & 7) << 3) | (h.fgPalette & 7),
    (h.itemMemory << 6) | ((h.verticalScroll & 3) << 4) | (h.tileset & 0x0f),
  ]);
}

export function decodeSecondaryHeader([a, b, c, d, e = 0, f = 0, g = 0, h = 0, i = 0]: Iterable<number> & ArrayLike<number>): SecondaryHeader {
  return {
    layer2Scroll: a >> 4,
    entranceY: a & 0x0f,
    layer3: b >> 6,
    entranceAction: (b >> 3) & 7,
    entranceX: b & 7,
    midwayScreen: c >> 4,
    fgInitY: (c >> 2) & 3,
    bgInitY: c & 3,
    noYoshiIntro: d >> 7,
    verticalPositioning: (d >> 5) & 3,
    entranceScreen: d & 0x1f,
    layer2Separate: e >> 7,
    layer2HAuto: (e >> 6) & 1,
    layer2V: e & 0x1f,
    lmAutoScreens: (e >> 5) & 1,
    levelSize: f & 0x1f,
    levelSizeFlags: f & 0xe0,
    entranceTile: (g >> 5) & 1,
    entranceXHi: (g >> 3) & 3,
    entranceYHi: h & 0x3f,
    water: (g >> 6) & 1,
    lmEntranceFlags: g & 0x87,
    cameraRelative: i >> 7,
    cameraOffsetHi: (h >> 6) & 1,
    bgRelative: h >> 7,
    bgHeight: i & 0x1f,
    faceLeft: (i >> 6) & 1,
    lmSpareBit: i & 0x20,
  };
}
export function encodeSecondaryHeader(s: SecondaryHeader): number[] {
  return [
    (s.layer2Scroll << 4) | (s.entranceY & 0x0f),
    (s.layer3 << 6) | ((s.entranceAction & 7) << 3) | (s.entranceX & 7),
    (s.midwayScreen << 4) | ((s.fgInitY & 3) << 2) | (s.bgInitY & 3),
    (s.noYoshiIntro << 7) | ((s.verticalPositioning & 3) << 5) | (s.entranceScreen & 0x1f),
    (s.layer2Separate << 7) | ((s.layer2HAuto & 1) << 6) | ((s.lmAutoScreens & 1) << 5) | (s.layer2V & 0x1f),
    (s.levelSizeFlags & 0xe0) | (s.levelSize & 0x1f),
    (s.lmEntranceFlags & 0x87) | ((s.water & 1) << 6) | ((s.entranceTile & 1) << 5) | ((s.entranceXHi & 3) << 3),
    (s.bgRelative << 7) | ((s.cameraOffsetHi & 1) << 6) | (s.entranceYHi & 0x3f),
    (s.cameraRelative << 7) | ((s.faceLeft & 1) << 6) | (s.lmSpareBit & 0x20) | (s.bgHeight & 0x1f),
  ];
}
export function readSecondaryHeader(rom: Rom, n: number): SecondaryHeader {
  return decodeSecondaryHeader(SEC_HDR.map((t) => rom.r8(t + n)));
}
export function writeSecondaryHeader(rom: Rom, n: number, s: SecondaryHeader): void {
  encodeSecondaryHeader(s).forEach((v, i) => rom.w8(SEC_HDR[i] + n, v));
}

// ----- objects -----
export interface ParsedObjects {
  objects: LevelObject[];
  exits: ScreenExit[];
  size: number; // bytes consumed including terminating $FF
}

// extended object $03 is a structure (4 bytes, structure patch). In a level with a size (`sized`) the
// screen jump's low nibble of the second byte is the subscreen (000HHHHH 0000VVVV 00000001): rows
// V * 32 on; the new screen flag keeps it (observed: where the game puts objects in a Lunar Magic-saved ROM)
export function parseObjects(data: Uint8Array, start: number, vertical: boolean, sized = false): ParsedObjects {
  const objects: LevelObject[] = [];
  const exits: ScreenExit[] = [];
  let p = start;
  let screen = 0, sub = 0;
  while (p < data.length && data[p] !== 0xff) {
    const b0 = data[p], b1 = data[p + 1], b2 = data[p + 2];
    const num = ((b0 >> 1) & 0x30) | (b1 >> 4);
    if (b0 & 0x80) screen++;
    if (num === 0 && b2 === 0) {
      exits.push({
        uid: newUid(),
        screen: b0 & 0x1f,
        dest: data[p + 3] | ((b1 & 1) << 8),
        secondary: (b1 & 2) !== 0,
        flags: b1 & 0x0f,
      });
      p += 4;
      continue;
    }
    if (num === 0 && b2 === 1) {
      screen = b0 & 0x1f;
      if (sized && !vertical) sub = b1 & 0x0f;
      p += 3;
      continue;
    }
    const f5 = b0 & 0x1f, f4 = b1 & 0x0f;
    const dm16 = num === 0 && b2 === DM16_EXT;
    let x: number, y: number;
    if (vertical) {
      x = f5;
      y = screen * 16 + f4;
    } else {
      x = screen * 16 + f4;
      y = sub * SUBSCREEN_ROWS + f5;
    }
    if (dm16) {
      objects.push({ uid: newUid(), num, ext: b2, x, y, size: data[p + 5], tile: data[p + 3] | (data[p + 4] << 8) });
      p += 6;
      continue;
    }
    if (num === 0 && b2 === STRUCT_EXT) {
      objects.push({ uid: newUid(), num, ext: b2, x, y, size: 0, struct: data[p + 3] });
      p += 4;
      continue;
    }
    objects.push({ uid: newUid(), num, ext: num === 0 ? b2 : 0, x, y, size: num === 0 ? 0 : b2 });
    p += 3;
  }
  return { objects, exits, size: p - start + 1 };
}

// owners (optional): receives, per output byte, the index of the object it belongs to (or -1);
// sized: a level with a size (subscreens, see parseObjects)
export function serializeObjects(objects: LevelObject[], exits: ScreenExit[], vertical: boolean, owners?: number[], sized = false): Uint8Array {
  const out: number[] = [];
  const own = (n: number, v: number) => { if (owners) for (let i = 0; i < n; i++) owners.push(v); };
  for (const e of exits) {
    const flags = (e.flags & 0x0c) | (e.secondary ? 2 : 0) | ((e.dest >> 8) & 1);
    out.push(e.screen & 0x1f, flags, 0x00, e.dest & 0xff);
    own(4, -1);
  }
  let screen = 0, sub = 0;
  for (const o of objects) {
    const s = vertical ? o.y >> 4 : o.x >> 4;
    const v = sized && !vertical ? Math.floor(o.y / SUBSCREEN_ROWS) : 0;
    let nflag = 0;
    if (s === screen + 1 && v === sub) {
      nflag = 0x80;
      screen = s;
    } else if (s !== screen || v !== sub) {
      out.push(s & 0x1f, v & 0x0f, 0x01);
      own(3, -1);
      screen = s;
      sub = v;
    }
    const f5 = vertical ? o.x & 0x1f : o.y & 0x1f;
    const f4 = vertical ? o.y & 0x0f : o.x & 0x0f;
    out.push(nflag | ((o.num & 0x30) << 1) | f5, ((o.num & 0x0f) << 4) | f4, o.num === 0 ? o.ext : o.size);
    if (o.num === 0 && o.ext === DM16_EXT) {
      const t = o.tile ?? 0;
      out.push(t & 0xff, (t >> 8) & 0xff, o.size & 0xff);
      own(6, objects.indexOf(o));
    } else if (o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined) {
      out.push(o.struct & 0xff);
      own(4, objects.indexOf(o));
    } else own(3, objects.indexOf(o));
  }
  out.push(0xff);
  own(1, -1);
  return new Uint8Array(out);
}

// ----- sprites -----
// Sprite entries are 3 bytes plus extra bytes. The number of bytes per entry comes from a $400 byte size
// table (index = extra bits * $100 + sprite number, value = 3 + extra bytes) whose address Lunar Magic and
// PIXI keep at $0EF30C, enabled by $42 at $0EF30F. Without it every entry is 3 bytes.
export const SPR_SIZE_PTR = 0x0ef30c;
export type SpriteSizes = Uint8Array | null;

export function spriteSizes(rom: Rom): SpriteSizes {
  if (rom.r8(SPR_SIZE_PTR + 3) !== 0x42) return null;
  return rom.bytes(rom.r24(SPR_SIZE_PTR), 0x400);
}
export function spriteEntrySize(sizes: SpriteSizes, extra: number, num: number): number {
  const n = sizes ? sizes[((extra & 3) << 8) | (num & 0xff)] : 3;
  return n >= 3 ? n : 3;
}
// the extra bytes of a sprite, resized to what its entry holds
export function spriteBytes(sizes: SpriteSizes, s: { extra: number; num: number; bytes?: number[] }): number[] {
  const n = spriteEntrySize(sizes, s.extra, s.num) - 3;
  return Array.from({ length: n }, (_, i) => (s.bytes?.[i] ?? 0) & 0xff);
}

// Sprite id for images, names and the palette: original sprites by number (their extra bits 0/1 don't
// change what they are), custom sprites as extra bits << 8 | number ($2xx, with the extra bit $3xx)
export function spriteId(s: { num: number; extra: number }): number {
  return s.extra >= 2 ? ((s.extra & 3) << 8) | (s.num & 0xff) : s.num & 0xff;
}
export const isCustomId = (id: number) => id >= 0x200;

// Lunar Magic's new sprite format (header bit 5, NEW_SPRITE_FORMAT): $FF starts a command, $FF $00-$7F
// sets the subscreen of the sprites that follow (rows V * 32 on), $FF $FE ends the data, $FF $FF is a
// sprite whose first byte is $FF (smwspeedruns' "Level Data Format"; seen in a Lunar Magic-saved ROM)
export const NEW_SPRITE_FORMAT = 0x20;
export const SPRITE_MEMORY = 0x1f; // the header's sprite memory (bits 4-0; bit 5 is the format)

export function parseSprites(data: Uint8Array, start: number, vertical: boolean, sizes: SpriteSizes = null): { sprites: LevelSprite[]; header: number; size: number } {
  const header = data[start];
  const newFormat = (header & NEW_SPRITE_FORMAT) !== 0;
  const sprites: LevelSprite[] = [];
  let p = start + 1, sub = 0;
  while (p < data.length) {
    if (data[p] === 0xff) {
      if (!newFormat) break;
      const c = data[p + 1];
      if (c === 0xfe || c === undefined) { p++; break; }
      if (c < 0x80) { sub = c; p += 2; continue; }
      p++;
      if (c !== 0xff) { p++; continue; } // reserved commands: skipped
    }
    const b0 = data[p], b1 = data[p + 1], b2 = data[p + 2];
    const screen = (b1 & 0x0f) | ((b0 & 2) << 3);
    const lo = b0 >> 4; // y within screen (or tile row)
    const hi = b0 & 1;
    const col = b1 >> 4;
    let x: number, y: number;
    if (vertical) {
      y = screen * 16 + lo;
      x = hi * 16 + col;
    } else {
      x = screen * 16 + col;
      y = sub * SUBSCREEN_ROWS + hi * 16 + lo;
    }
    const extra = (b0 >> 2) & 3;
    const len = spriteEntrySize(sizes, extra, b2);
    const s: LevelSprite = { uid: newUid(), num: b2, x, y, extra };
    if (len > 3) s.bytes = [...data.subarray(p + 3, p + len)];
    sprites.push(s);
    p += len;
  }
  return { sprites, header, size: p - start + 1 };
}

// the order sprites are stored in (the game's sprite load index, $161A, counts in it)
export function spriteLoadOrder(sprites: LevelSprite[], vertical: boolean): LevelSprite[] {
  return [...sprites].sort((a, b) => (vertical ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
}

// tall: a level with subscreens (isTall), written in Lunar Magic's new format; others in the game's
export function serializeSprites(sprites: LevelSprite[], header: number, vertical: boolean, sizes: SpriteSizes = null, tall = false): Uint8Array {
  const sorted = spriteLoadOrder(sprites, vertical);
  const out: number[] = [tall ? header | NEW_SPRITE_FORMAT : header & ~NEW_SPRITE_FORMAT];
  let sub = 0;
  for (const s of sorted) {
    if (tall) {
      const v = Math.floor(s.y / SUBSCREEN_ROWS);
      if (v !== sub) { out.push(0xff, v & 0x7f); sub = v; }
    }
    let screen: number, lo: number, hi: number, col: number;
    if (vertical) {
      screen = s.y >> 4; lo = s.y & 15; hi = (s.x >> 4) & 1; col = s.x & 15;
    } else {
      screen = s.x >> 4; col = s.x & 15; hi = (s.y >> 4) & 1; lo = s.y & 15;
    }
    const b0 = (lo << 4) | ((s.extra & 3) << 2) | ((screen & 0x10) >> 3) | hi;
    if (tall && b0 === 0xff) out.push(0xff);
    out.push(b0, (col << 4) | (screen & 0x0f), s.num, ...spriteBytes(sizes, s));
  }
  out.push(...(tall ? [0xff, 0xfe] : [0xff]));
  return new Uint8Array(out);
}

// the level's sprite data as the ROM keeps it
export function serializeLevelSprites(rom: Rom, lv: Level): Uint8Array {
  return serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode), spriteSizes(rom), isTall(lv.secondary));
}

export function spriteBank(rom: Rom, n: number): number {
  return spriteBankOf(rom, n);
}

export function loadLevel(rom: Rom, n: number): Level {
  const l1 = rom.r24(L1_PTRS + n * 3);
  const l2 = rom.r24(L2_PTRS + n * 3);
  const spr = (spriteBank(rom, n) << 16) | rom.r16(SPR_PTRS + n * 2);
  // read generous windows of data (up to the end of the bank)
  const win = (a: number) => rom.bytes(a, 0x8000 - (a & 0x7fff));
  const lv = parseLevelData(rom, n, win(l1), (l2 >> 16) !== 0xff ? win(l2) : null, l2, win(spr), readSecondaryHeader(rom, n));
  lv.l1Addr = l1;
  lv.sprAddr = spr;
  return lv;
}

// builds a level from raw data: layer 1 (with 5 byte header), layer 2 object data (with header) or null,
// the layer 2 pointer (BG tilemap when l2 is null) and sprite data (with header byte)
export function parseLevelData(rom: Rom, n: number, l1: Uint8Array, l2: Uint8Array | null, l2Pointer: number, spr: Uint8Array, secondary: SecondaryHeader, sizes: SpriteSizes = spriteSizes(rom)): Level {
  const header = parsePrimaryHeader(l1.subarray(0, 5));
  const vert1 = isL1Vertical(rom, header.mode);
  const p1 = hasObjects(header.mode) ? parseObjects(l1, 5, vert1, isSized(secondary)) : { objects: [], exits: [], size: 1 };
  let layer2Objects: LevelObject[] | null = null;
  let layer2Header: Uint8Array | null = null;
  let l2Size = 0;
  if (l2 && hasLayer2Objects(header.mode)) {
    layer2Header = l2.slice(0, 5);
    const p2 = parseObjects(l2, 5, isL2Vertical(rom, header.mode));
    layer2Objects = p2.objects;
    l2Size = 5 + p2.size;
    // exits in layer 2 data are unusual; keep them with layer 1
    p1.exits.push(...p2.exits);
  }
  const ps = parseSprites(spr, 0, vert1, sizes);
  return {
    number: n,
    header,
    secondary,
    objects: p1.objects,
    exits: p1.exits,
    layer2Objects,
    layer2Header,
    layer2Pointer: l2Pointer,
    sprites: ps.sprites,
    spriteHeader: ps.header,
    l1Addr: 0,
    l1Size: 5 + p1.size,
    l2Size,
    sprAddr: 0,
    sprSize: ps.size,
  };
}

export function serializeLayer1(rom: Rom, lv: Level, owners?: number[]): Uint8Array {
  const hdr = encodePrimaryHeader(lv.header);
  if (owners) for (let i = 0; i < 5; i++) owners.push(-1);
  const body = hasObjects(lv.header.mode)
    ? serializeObjects(lv.objects, lv.exits, isL1Vertical(rom, lv.header.mode), owners, isSized(lv.secondary))
    : new Uint8Array([0xff]);
  const out = new Uint8Array(hdr.length + body.length);
  out.set(hdr);
  out.set(body, 5);
  return out;
}

export function serializeLayer2(rom: Rom, lv: Level, owners?: number[]): Uint8Array | null {
  if (!lv.layer2Objects) return null;
  const hdr = lv.layer2Header ?? new Uint8Array(5);
  if (owners) for (let i = 0; i < 5; i++) owners.push(-1);
  const body = serializeObjects(lv.layer2Objects, [], isL2Vertical(rom, lv.header.mode), owners);
  const out = new Uint8Array(5 + body.length);
  out.set(hdr);
  out.set(body, 5);
  return out;
}

export function cloneLevel(lv: Level): Level {
  return structuredClone(lv);
}

// ---- secondary entrances ----
export interface SecondaryEntrance {
  destLevel: number; // low 8 bits (vanilla); high bit from bit 3 of FE00 when patched
  entranceY: number; // FA00 bits 3-0
  fgInitY: number; // FA00 bits 5-4
  bgInitY: number; // FA00 bits 7-6
  entranceX: number; // FC00 bits 7-5
  screen: number; // FC00 bits 4-0
  action: number; // FE00 bits 2-0
  raw3: number; // FE00 bits 7 and 3 (Lunar Magic's, kept)
  // Lunar Magic 3.00's (levelheight.ts), as in the main entrance (SecondaryHeader)
  entranceTile: number; // FE00 bit 6
  entranceXHi: number; // FE00 bits 5-4
  entranceYHi: number; // CC00 bits 5-0
  cameraOffsetHi: number; // CC00 bit 6
  cameraRelative: number; // CE00 bit 7
  faceLeft: number; // CE00 bit 6: Mario faces left
  water: number; // CE00 bit 5: a water level (Mario swims)
  lmRaw: number; // CC00 bit 7 (exit to the overworld), CE00 bits 4-0 – kept, not used
}
export function readSecondaryEntrance(rom: Rom, i: number): SecondaryEntrance {
  return decodeSecondaryEntrance(SEC_ENT.map((t) => rom.r8(t + i)));
}
export function decodeSecondaryEntrance([a, b, c, d, e, f]: number[]): SecondaryEntrance {
  return {
    destLevel: a,
    entranceY: b & 0x0f,
    fgInitY: (b >> 4) & 3,
    bgInitY: b >> 6,
    entranceX: c >> 5,
    screen: c & 0x1f,
    action: d & 7,
    raw3: d & 0x88,
    entranceTile: (d >> 6) & 1,
    entranceXHi: (d >> 4) & 3,
    entranceYHi: e & 0x3f,
    cameraOffsetHi: (e >> 6) & 1,
    cameraRelative: f >> 7,
    faceLeft: (f >> 6) & 1,
    water: (f >> 5) & 1,
    lmRaw: ((e & 0x80) << 1) | (f & 0x1f),
  };
}
export function writeSecondaryEntrance(rom: Rom, i: number, e: SecondaryEntrance): void {
  rom.w8(SEC_ENT[0] + i, e.destLevel & 0xff);
  rom.w8(SEC_ENT[1] + i, (e.bgInitY << 6) | ((e.fgInitY & 3) << 4) | (e.entranceY & 0x0f));
  rom.w8(SEC_ENT[2] + i, (e.entranceX << 5) | (e.screen & 0x1f));
  rom.w8(SEC_ENT[3] + i, (e.raw3 & 0x88) | ((e.entranceTile & 1) << 6) | ((e.entranceXHi & 3) << 4) | (e.action & 7));
  rom.w8(SEC_ENT[4] + i, ((e.lmRaw >> 1) & 0x80) | ((e.cameraOffsetHi & 1) << 6) | (e.entranceYHi & 0x3f));
  rom.w8(SEC_ENT[5] + i, (e.cameraRelative << 7) | ((e.faceLeft & 1) << 6) | ((e.water & 1) << 5) | (e.lmRaw & 0x1f));
}

// ---- entrance positions ----
// The game's: tables at $05D730/$05D740 (Y), $05D750/$05D758 (X), see $05D951; the screen number replaces
// the high byte of the scroll axis. Lunar Magic 3.00's (tile, levelheight.ts): tile X (0-31) and Y (0-1023)
// of the screen, X/Y swapped in vertical levels. Either is Mario's pixel position before the entrance action
// (pipe/water offsets) is applied.
export interface EntranceSpot { screen: number; ex: number; ey: number; tile: number; exHi: number; eyHi: number }
export const mainSpot = (s: SecondaryHeader, screen = s.entranceScreen): EntranceSpot =>
  ({ screen, ex: s.entranceX, ey: s.entranceY, tile: s.entranceTile, exHi: s.entranceXHi, eyHi: s.entranceYHi });
export const secondarySpot = (e: SecondaryEntrance): EntranceSpot =>
  ({ screen: e.screen, ex: e.entranceX, ey: e.entranceY, tile: e.entranceTile, exHi: e.entranceXHi, eyHi: e.entranceYHi });
export const sameSpot = (a: EntranceSpot, b: EntranceSpot) => a.screen === b.screen && a.ex === b.ex && a.ey === b.ey && a.tile === b.tile && a.exHi === b.exHi && a.eyHi === b.eyHi;
export function setMainSpot(s: SecondaryHeader, p: EntranceSpot): void {
  s.entranceScreen = p.screen; s.entranceX = p.ex; s.entranceY = p.ey; s.entranceTile = p.tile; s.entranceXHi = p.exHi; s.entranceYHi = p.eyHi;
}
export function setSecondarySpot(e: SecondaryEntrance, p: EntranceSpot): void {
  e.screen = p.screen; e.entranceX = p.ex; e.entranceY = p.ey; e.entranceTile = p.tile; e.entranceXHi = p.exHi; e.entranceYHi = p.eyHi;
}
// a tile entrance's tile X/Y in the game's X/Y and their high bits (fields of the main and the secondary entrances)
export interface EntranceTileFields { entranceX: number; entranceY: number; entranceXHi: number; entranceYHi: number }
export function setEntranceTile(c: EntranceTileFields, t: { x?: number; y?: number }): void {
  if (t.x !== undefined) { c.entranceX = t.x & 7; c.entranceXHi = t.x >> 3; }
  if (t.y !== undefined) { c.entranceY = t.y & 15; c.entranceYHi = t.y >> 4; }
}
// the tile of a tile entrance (screen-relative along the scroll axis)
export const spotTile = (p: EntranceSpot) => ({ x: (p.exHi << 3) | p.ex, y: (p.eyHi << 4) | p.ey });
export function entrancePos(rom: Rom, p: EntranceSpot, vertical: boolean): { x: number; y: number } {
  const s = (p.screen & 0x1f) << 8;
  if (p.tile) {
    const t = spotTile(p);
    return vertical ? { x: t.x * 16, y: s + t.y * 16 } : { x: s + t.x * 16, y: t.y * 16 };
  }
  const xt = rom.r8(0x05d750 + (p.ex & 7)) | (rom.r8(0x05d758 + (p.ex & 7)) << 8);
  const yt = rom.r8(0x05d730 + (p.ey & 15)) | (rom.r8(0x05d740 + (p.ey & 15)) << 8);
  return vertical ? { x: xt, y: s | (yt & 0xff) } : { x: s | (xt & 0xff), y: yt };
}

// the entrance closest to pixel (px, py): the game's table positions, or with `rows` (a level with a size,
// where the tables don't reach) the tile there
export function nearestEntrance(rom: Rom, px: number, py: number, vertical: boolean, maxScreen: number, rows = 0): EntranceSpot {
  const screen = Math.max(0, Math.min(maxScreen, Math.floor((vertical ? py : px) / 256)));
  if (rows) {
    const x = Math.max(0, Math.min(31, Math.round((px - (vertical ? 0 : screen * 256)) / 16)));
    const y = Math.max(0, Math.min(vertical ? 15 : rows - 1, Math.round((py - (vertical ? screen * 256 : 0)) / 16)));
    return { screen, ex: x & 7, ey: y & 15, tile: 1, exHi: x >> 3, eyHi: y >> 4 };
  }
  let best: EntranceSpot = { screen, ex: 0, ey: 0, tile: 0, exHi: 0, eyHi: 0 }, bestD = Infinity;
  for (let ex = 0; ex < 8; ex++) for (let ey = 0; ey < 16; ey++) {
    const spot = { screen, ex, ey, tile: 0, exHi: 0, eyHi: 0 };
    const p = entrancePos(rom, spot, vertical);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) { bestD = d; best = spot; }
  }
  return best;
}

// Lunar Magic's camera relative to Mario: it starts `rows` above him (the 5-bit offset is fgInitY, bgInitY and
// bit 4; levelheight.ts); the main entrance's BG then shows its bottom at the level's (a BG of 27 rows)
export interface CameraStart { cameraRelative: number; cameraOffsetHi: number; fgInitY: number; bgInitY: number }
const signed5 = (v: number) => ((v & 0x1f) << 27) >> 27;
export const cameraRows = (c: CameraStart) => -signed5((c.cameraOffsetHi << 4) | (c.fgInitY << 2) | c.bgInitY);
export function setCameraRows(c: CameraStart, rows: number): void {
  const v = -rows & 31;
  c.cameraRelative = 1; c.cameraOffsetHi = v >> 4; c.fgInitY = (v >> 2) & 3; c.bgInitY = v & 3;
}
export function copyCameraStart(to: CameraStart, from: CameraStart): void {
  to.cameraRelative = from.cameraRelative; to.cameraOffsetHi = from.cameraOffsetHi; to.fgInitY = from.fgInitY; to.bgInitY = from.bgInitY;
}
// what an entrance sets besides where Mario and the camera start (Lunar Magic's, main and secondary entrances)
export type EntranceOptions = Pick<SecondaryEntrance, 'faceLeft' | 'water'>;
export function copyEntranceOptions(to: EntranceOptions, from: EntranceOptions): void {
  to.faceLeft = from.faceLeft; to.water = from.water;
}
export const GAME_BG_ROWS = 27; // the game's BGs
export const CAMERA_ROWS = 10; // the game's camera at the bottom has Mario standing on the ground 10 rows below its top
// the camera relative to Mario (CAMERA_ROWS above him) unless it already is, as a tile entrance in a level
// with a size needs; a main entrance's BG then 27 rows high unless it has a height
export function cameraAtMario(c: CameraStart & { bgHeight?: number; bgRelative?: number }): void {
  if (c.cameraRelative) return;
  setCameraRows(c, CAMERA_ROWS);
  if (c.bgHeight === 0 && !c.bgRelative) c.bgHeight = GAME_BG_ROWS - 1;
}
// the camera starts relative to Mario in horizontal levels only (layer 2 not vertical either: levelheight.ts);
// in others the entrance's bits are the game's FG/BG start Y
export const hasRelativeCamera = (rom: Rom, mode: number): boolean => !isL1Vertical(rom, mode) && !isL2Vertical(rom, mode);
export const levelMode = (rom: Rom, n: number): number => parsePrimaryHeader(rom.bytes(rom.r24(L1_PTRS + n * 3), 5)).mode;

// where the BG starts for an entrance whose camera starts relative to Mario (the level's setting, Lunar
// Magic's "Change Layer 1/2 Settings"): its bottom shown when the camera is at the level's bottom (a BG of
// `rows` rows), `rows` rows below the FG (negative: above), or at 0 (layer 2 scroll sprites that want it)
export type BgStart = { kind: 'bottom'; rows: number } | { kind: 'fg'; rows: number } | { kind: 'zero' };
const BG_ZERO = 0x10; // with bgRelative: absolute 0 instead of an offset
export function bgStart(s: Pick<SecondaryHeader, 'bgRelative' | 'bgHeight'>): BgStart {
  const v = s.bgHeight & 0x1f;
  if (!s.bgRelative) return { kind: 'bottom', rows: v + 1 };
  return v === BG_ZERO ? { kind: 'zero' } : { kind: 'fg', rows: signed5(v) };
}
export function setBgStart(s: Pick<SecondaryHeader, 'bgRelative' | 'bgHeight'>, b: BgStart): void {
  s.bgRelative = b.kind === 'bottom' ? 0 : 1;
  s.bgHeight = b.kind === 'zero' ? BG_ZERO : b.kind === 'bottom' ? Math.max(1, Math.min(32, b.rows)) - 1 : Math.max(-15, Math.min(15, b.rows)) & 0x1f;
}

// puts an entrance at a spot (dragged, created, test play from here); its camera start – the FG/BG start Y,
// or the rows above Mario – stays as set (as Lunar Magic 3.50 can drag them). Only a tile entrance whose
// camera is the game's gets the relative one: the game's start positions don't reach a taller level's rows.
export function placeMain(s: SecondaryHeader, p: EntranceSpot): void {
  setMainSpot(s, p);
  if (p.tile) cameraAtMario(s);
}
export function placeSecondary(e: SecondaryEntrance, p: EntranceSpot): void {
  setSecondarySpot(e, p);
  if (p.tile) cameraAtMario(e);
}
// the secondary header test play starts with from Mario's top-left pixel (px, py): the main entrance at the
// entrance setting nearest to it (rows: as nearestEntrance); `entrance`: the camera start, options and action
// of the entrance played from (a secondary entrance's own), else the main entrance's without an action
export type StartEntrance = CameraStart & EntranceOptions & Pick<SecondaryEntrance, 'action'>;
export function startHeader(rom: Rom, s: SecondaryHeader, px: number, py: number, maxScreen: number, rows = 0, entrance?: StartEntrance): SecondaryHeader {
  const sec = { ...s };
  if (entrance) { copyCameraStart(sec, entrance); copyEntranceOptions(sec, entrance); }
  placeMain(sec, nearestEntrance(rom, px, py, (sec.verticalPositioning & 1) !== 0, maxScreen, rows));
  sec.entranceAction = entrance?.action ?? 0;
  return sec;
}

// ---- screen operations ----
// Everything whose origin lies on screen >= s moves by one screen (items keep their position
// within the screen). Objects that start on an earlier screen and reach into s are not cut.
function shiftScreens(rom: Rom, lv: Level, from: number, delta: number): void {
  const v1 = isL1Vertical(rom, lv.header.mode), v2 = isL2Vertical(rom, lv.header.mode);
  const move = (o: { x: number; y: number }, vertical: boolean) => {
    if (vertical) { if (o.y >> 4 >= from) o.y += delta * 16; } else if (o.x >> 4 >= from) o.x += delta * 16;
  };
  for (const o of lv.objects) move(o, v1);
  for (const o of lv.layer2Objects ?? []) move(o, v2);
  for (const sp of lv.sprites) move(sp, v1);
  for (const e of lv.exits) if (e.screen >= from) e.screen += delta;
  const sec = lv.secondary;
  if (sec.entranceScreen >= from) sec.entranceScreen = Math.max(0, sec.entranceScreen + delta);
  if (sec.midwayScreen >= from) sec.midwayScreen = Math.max(0, Math.min(15, sec.midwayScreen + delta));
}

export function insertScreen(rom: Rom, lv: Level, s: number): void {
  const max = maxScreens(lv.secondary);
  if (lv.header.screens >= max) throw new Error(`The level already has ${max} screens${max < 32 ? ', as many as its height allows' : ''}.`);
  shiftScreens(rom, lv, s, 1);
  lv.header.screens++;
}

export function deleteScreen(rom: Rom, lv: Level, s: number): void {
  if (lv.header.screens <= 1) throw new Error('The level needs at least one screen.');
  const v1 = isL1Vertical(rom, lv.header.mode), v2 = isL2Vertical(rom, lv.header.mode);
  const on = (o: { x: number; y: number }, vertical: boolean) => (vertical ? o.y : o.x) >> 4 === s;
  lv.objects = lv.objects.filter((o) => !on(o, v1));
  if (lv.layer2Objects) lv.layer2Objects = lv.layer2Objects.filter((o) => !on(o, v2));
  lv.sprites = lv.sprites.filter((sp) => !on(sp, v1));
  lv.exits = lv.exits.filter((e) => e.screen !== s);
  shiftScreens(rom, lv, s + 1, -1);
  lv.header.screens--;
}

export function clearLevel(lv: Level): void {
  lv.objects = [];
  if (lv.layer2Objects) lv.layer2Objects = [];
  lv.sprites = [];
  lv.exits = [];
}

// ---- translevel ($13BF): overworld level number the game uses for messages, Yoshi coins, moons ----
// levels $000-$024 are translevels $00-$24, $101-$13B are $25-$5F; everything else is a sub-level
export function mainTranslevel(n: number): number | null {
  if (n < 0x25) return n;
  if (n >= 0x101 && n < 0x13c) return n - 0xdc;
  return null;
}

// sub-levels inherit the translevel of the main level whose exits lead to them (breadth first)
export function levelTranslevel(rom: Rom, n: number): number {
  const direct = mainTranslevel(n);
  if (direct !== null) return direct;
  const seen = new Map<number, number>();
  const queue: number[] = [];
  for (let m = 1; m < 0x13c; m++) {
    const t = mainTranslevel(m);
    if (t) { seen.set(m, t); queue.push(m); }
  }
  while (queue.length) {
    const m = queue.shift()!;
    let exits: ScreenExit[];
    try { exits = loadLevel(rom, m).exits; } catch { continue; }
    for (const e of exits) {
      // the high bit of the destination (and of the secondary entrance number) comes from the level side
      const idx = e.dest | (m & 0x100);
      const d = e.secondary ? readSecondaryEntrance(rom, idx).destLevel | (m & 0x100) : idx;
      if (seen.has(d)) continue;
      seen.set(d, seen.get(m)!);
      if (d === n) return seen.get(m)!;
      queue.push(d);
    }
  }
  return 0;
}
