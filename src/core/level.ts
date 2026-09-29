// Super Mario World level data: parsing and serialization.

import { Rom } from './rom.ts';
import { spriteBankOf, DM16_EXT } from './patches.ts';

export const L1_PTRS = 0x05e000;
export const L2_PTRS = 0x05e600;
export const SPR_PTRS = 0x05ec00;
export const SEC_HDR = [0x05f000, 0x05f200, 0x05f400, 0x05f600];
export const SEC_ENT = [0x05f800, 0x05fa00, 0x05fc00, 0x05fe00];

export interface LevelObject {
  uid: number;
  num: number; // standard object number 1..0x3F, 0 = extended
  ext: number; // extended object number (num === 0)
  x: number; // absolute tile position
  y: number;
  size: number; // settings byte for standard objects (and Direct Map16)
  tile?: number; // Direct Map16 tile number (extended object $02, editor patch)
}

export interface ScreenExit {
  uid: number;
  screen: number;
  dest: number; // destination level (or secondary entrance) number, 9 bit
  secondary: boolean;
  flags: number; // raw low nibble of byte 1 (bit0 = hi bit, bit1 = secondary, others kept)
}

export interface LevelSprite {
  uid: number;
  num: number;
  x: number;
  y: number;
  extra: number; // 2 extra bits
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
  layer2Scroll: number; // F000 bits 7-4
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

export function decodeSecondaryHeader([a, b, c, d]: Iterable<number> & ArrayLike<number>): SecondaryHeader {
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
  };
}
export function encodeSecondaryHeader(s: SecondaryHeader): number[] {
  return [
    (s.layer2Scroll << 4) | (s.entranceY & 0x0f),
    (s.layer3 << 6) | ((s.entranceAction & 7) << 3) | (s.entranceX & 7),
    (s.midwayScreen << 4) | ((s.fgInitY & 3) << 2) | (s.bgInitY & 3),
    (s.noYoshiIntro << 7) | ((s.verticalPositioning & 3) << 5) | (s.entranceScreen & 0x1f),
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

export function parseObjects(data: Uint8Array, start: number, vertical: boolean): ParsedObjects {
  const objects: LevelObject[] = [];
  const exits: ScreenExit[] = [];
  let p = start;
  let screen = 0;
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
      y = f5;
    }
    if (dm16) {
      objects.push({ uid: newUid(), num, ext: b2, x, y, size: data[p + 5], tile: data[p + 3] | (data[p + 4] << 8) });
      p += 6;
      continue;
    }
    objects.push({ uid: newUid(), num, ext: num === 0 ? b2 : 0, x, y, size: num === 0 ? 0 : b2 });
    p += 3;
  }
  return { objects, exits, size: p - start + 1 };
}

// owners (optional): receives, per output byte, the index of the object it belongs to (or -1)
export function serializeObjects(objects: LevelObject[], exits: ScreenExit[], vertical: boolean, owners?: number[]): Uint8Array {
  const out: number[] = [];
  const own = (n: number, v: number) => { if (owners) for (let i = 0; i < n; i++) owners.push(v); };
  for (const e of exits) {
    const flags = (e.flags & 0x0c) | (e.secondary ? 2 : 0) | ((e.dest >> 8) & 1);
    out.push(e.screen & 0x1f, flags, 0x00, e.dest & 0xff);
    own(4, -1);
  }
  let screen = 0;
  for (const o of objects) {
    const s = vertical ? o.y >> 4 : o.x >> 4;
    let nflag = 0;
    if (s === screen + 1) {
      nflag = 0x80;
      screen = s;
    } else if (s !== screen) {
      out.push(s & 0x1f, 0x00, 0x01);
      own(3, -1);
      screen = s;
    }
    const f5 = vertical ? o.x & 0x1f : o.y & 0x1f;
    const f4 = vertical ? o.y & 0x0f : o.x & 0x0f;
    out.push(nflag | ((o.num & 0x30) << 1) | f5, ((o.num & 0x0f) << 4) | f4, o.num === 0 ? o.ext : o.size);
    if (o.num === 0 && o.ext === DM16_EXT) {
      const t = o.tile ?? 0;
      out.push(t & 0xff, (t >> 8) & 0xff, o.size & 0xff);
      own(6, objects.indexOf(o));
    } else own(3, objects.indexOf(o));
  }
  out.push(0xff);
  own(1, -1);
  return new Uint8Array(out);
}

// ----- sprites -----
export function parseSprites(data: Uint8Array, start: number, vertical: boolean): { sprites: LevelSprite[]; header: number; size: number } {
  const header = data[start];
  const sprites: LevelSprite[] = [];
  let p = start + 1;
  while (p < data.length && data[p] !== 0xff) {
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
      y = hi * 16 + lo;
    }
    sprites.push({ uid: newUid(), num: b2, x, y, extra: (b0 >> 2) & 3 });
    p += 3;
  }
  return { sprites, header, size: p - start + 1 };
}

export function serializeSprites(sprites: LevelSprite[], header: number, vertical: boolean): Uint8Array {
  const sorted = [...sprites].sort((a, b) => (vertical ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y));
  const out: number[] = [header];
  for (const s of sorted) {
    let screen: number, lo: number, hi: number, col: number;
    if (vertical) {
      screen = s.y >> 4; lo = s.y & 15; hi = (s.x >> 4) & 1; col = s.x & 15;
    } else {
      screen = s.x >> 4; col = s.x & 15; hi = (s.y >> 4) & 1; lo = s.y & 15;
    }
    out.push((lo << 4) | ((s.extra & 3) << 2) | ((screen & 0x10) >> 3) | hi, (col << 4) | (screen & 0x0f), s.num);
  }
  out.push(0xff);
  return new Uint8Array(out);
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
export function parseLevelData(rom: Rom, n: number, l1: Uint8Array, l2: Uint8Array | null, l2Pointer: number, spr: Uint8Array, secondary: SecondaryHeader): Level {
  const header = parsePrimaryHeader(l1.subarray(0, 5));
  const vert1 = isL1Vertical(rom, header.mode);
  const p1 = hasObjects(header.mode) ? parseObjects(l1, 5, vert1) : { objects: [], exits: [], size: 1 };
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
  const ps = parseSprites(spr, 0, vert1);
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
    ? serializeObjects(lv.objects, lv.exits, isL1Vertical(rom, lv.header.mode), owners)
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
  raw3: number; // FE00 remaining bits
}
export function readSecondaryEntrance(rom: Rom, i: number): SecondaryEntrance {
  const [a, b, c, d] = SEC_ENT.map((t) => rom.r8(t + i));
  return {
    destLevel: a,
    entranceY: b & 0x0f,
    fgInitY: (b >> 4) & 3,
    bgInitY: b >> 6,
    entranceX: c >> 5,
    screen: c & 0x1f,
    action: d & 7,
    raw3: d & 0xf8,
  };
}
export function writeSecondaryEntrance(rom: Rom, i: number, e: SecondaryEntrance): void {
  rom.w8(SEC_ENT[0] + i, e.destLevel & 0xff);
  rom.w8(SEC_ENT[1] + i, (e.bgInitY << 6) | ((e.fgInitY & 3) << 4) | (e.entranceY & 0x0f));
  rom.w8(SEC_ENT[2] + i, (e.entranceX << 5) | (e.screen & 0x1f));
  rom.w8(SEC_ENT[3] + i, (e.raw3 & 0xf8) | (e.action & 7));
}

// ---- entrance positions (tables at $05D730/$05D740: Y, $05D750/$05D758: X; see $05D951) ----
// The screen number replaces the high byte of the scroll axis: X in horizontal, Y in vertical levels.
// Result is Mario's pixel position before the entrance action (pipe/water offsets) is applied.
export function entrancePos(rom: Rom, screen: number, ex: number, ey: number, vertical: boolean): { x: number; y: number } {
  const xt = rom.r8(0x05d750 + (ex & 7)) | (rom.r8(0x05d758 + (ex & 7)) << 8);
  const yt = rom.r8(0x05d730 + (ey & 15)) | (rom.r8(0x05d740 + (ey & 15)) << 8);
  return vertical ? { x: xt, y: ((screen & 0x1f) << 8) | (yt & 0xff) } : { x: ((screen & 0x1f) << 8) | (xt & 0xff), y: yt };
}

// entrance settings whose position is closest to pixel (px, py)
export function nearestEntrance(rom: Rom, px: number, py: number, vertical: boolean, maxScreen: number): { screen: number; ex: number; ey: number } {
  const screen = Math.max(0, Math.min(maxScreen, Math.floor((vertical ? py : px) / 256)));
  let best = { screen, ex: 0, ey: 0 }, bestD = Infinity;
  for (let ex = 0; ex < 8; ex++) for (let ey = 0; ey < 16; ey++) {
    const p = entrancePos(rom, screen, ex, ey, vertical);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) { bestD = d; best = { screen, ex, ey }; }
  }
  return best;
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
  if (lv.header.screens >= 32) throw new Error('Das Level hat bereits 32 Screens.');
  shiftScreens(rom, lv, s, 1);
  lv.header.screens++;
}

export function deleteScreen(rom: Rom, lv: Level, s: number): void {
  if (lv.header.screens <= 1) throw new Error('Das Level braucht mindestens einen Screen.');
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
