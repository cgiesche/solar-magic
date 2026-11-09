// Renders level layers from an emulated level load (WRAM/VRAM/CGRAM snapshot).

import { Rom } from './rom.ts';
import { decodeTile, cgramToRGBA, snesColorToRGBA } from './gfx.ts';
import { isL1Vertical, isL2Vertical, hasLayer2Objects } from './level.ts';
import { MAP_BASE, MAP_SIZE, type LevelRender } from './levelemu.ts';
import { EXT_FIRST, DEFAULT_ACTS, extTileAddr, extTileWords, setExtTileWords, actsLike, blockOf } from './map16ext.ts';
import { bgTileWords } from './bgmap16.ts';
import { RAM, get16, map16Tile, bgTile, map16Pointer, cameraX, cameraY } from './ram.ts';

export interface LayerGeom {
  vertical: boolean;
  width: number; // tiles
  height: number; // tiles
  addr(x: number, y: number): number; // WRAM low byte address, -1 outside
}

export function screenBase(rom: Rom, layer: number, mode: number, s: number): number {
  const modeTable = rom.r16(0x00bea8 + layer * 2);
  const screenTable = rom.r16(modeTable + mode * 2);
  return rom.r16(screenTable + s * 3);
}

// Screen s's rectangle in the drawn level (pixels): a horizontal level's screens lie side by side, the
// level's height each; a vertical level's are stacked, the level's width (two 16-tile halves) each.
export function screenRect(g: LayerGeom, s: number): { x: number; y: number; w: number; h: number } {
  return g.vertical ? { x: 0, y: s * 256, w: g.width * 16, h: 256 } : { x: s * 256, y: 0, w: 256, h: g.height * 16 };
}

// rows: the height of a horizontal level (levelRows). A horizontal layer's screens lie one after the other,
// rows * 16 bytes each, layer 2's from the 16th screen on (the game's tables for them are built in RAM
// with the level, levelheight.ts); a vertical layer's come from the game's tables.
export function layerGeom(rom: Rom, layer: number, mode: number, screens: number, rows = 27): LayerGeom {
  const vertical = layer === 0 ? isL1Vertical(rom, mode) : isL2Vertical(rom, mode);
  if (!vertical) {
    const w = screens * 16, base = MAP_BASE + layer * 16 * rows * 16;
    return {
      vertical, width: w, height: rows,
      addr(x, y) {
        if (x < 0 || y < 0 || x >= w || y >= rows) return -1;
        return base + (x >> 4) * rows * 16 + y * 16 + (x & 15);
      },
    };
  }
  const bases: number[] = [];
  const maxScreens = 32;
  for (let s = 0; s < maxScreens; s++) bases.push(screenBase(rom, layer, mode, s));
  const h = screens * 16;
  return {
    vertical, width: 32, height: h,
    addr(x, y) {
      if (x < 0 || y < 0 || x >= 32 || y >= h) return -1;
      return bases[y >> 4] + ((x >> 4) << 8) + ((y & 15) << 4) + (x & 15);
    },
  };
}

// the tile of a layer at each offset of the level's tilemap (in a load's touched sets and owner map: an address less
// MAP_BASE), packed (y<<16|x); -1 where the layer has none (or no layer, g null)
export function tileByOffset(g: LayerGeom | null): Int32Array {
  const m = new Int32Array(MAP_SIZE).fill(-1);
  if (g) for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const a = g.addr(x, y) - MAP_BASE;
    if (a >= 0 && a < MAP_SIZE) m[a] = (y << 16) | x;
  }
  return m;
}
// the tile (x, y) at an offset of such a map, undefined where the layer has none
export const tilePos = (m: Int32Array) => (off: number): [number, number] | undefined => {
  const t = m[off];
  return t >= 0 ? [t & 0xffff, t >> 16] : undefined;
};

// tiles 8x8 cache: key = palette-bank-specific tile word
export class TileCache {
  vram: Uint8Array;
  pal: Uint32Array;
  cache = new Map<number, Uint32Array>();
  charBase: number;
  constructor(vram: Uint8Array, cgram: Uint8Array, charBase = 0) {
    this.vram = vram;
    this.pal = cgramToRGBA(cgram);
    this.charBase = charBase;
  }
  // returns 64 RGBA pixels, 0 = transparent
  get(word: number, bpp = 4, palBase = 0): Uint32Array {
    const key = (word & 0xffff) | (bpp << 16) | (palBase << 20);
    let t = this.cache.get(key);
    if (t) return t;
    const idx = new Uint8Array(64);
    const num = word & 0x3ff;
    decodeTile(this.vram, (this.charBase + num * bpp * 8) & 0xffff, bpp, idx);
    const p = (word >> 10) & 7;
    const xf = word & 0x4000, yf = word & 0x8000;
    t = new Uint32Array(64);
    const colors = bpp === 2 ? 4 : 16;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const c = idx[(yf ? 7 - y : y) * 8 + (xf ? 7 - x : x)];
      t[y * 8 + x] = c ? this.pal[palBase + p * colors + c] : 0;
    }
    this.cache.set(key, t);
    return t;
  }
}

export function blit8(img: Uint32Array, iw: number, ih: number, t: Uint32Array, px: number, py: number): void {
  for (let y = 0; y < 8; y++) {
    const yy = py + y;
    if (yy < 0 || yy >= ih) continue;
    const row = yy * iw;
    for (let x = 0; x < 8; x++) {
      const c = t[y * 8 + x];
      if (c) {
        const xx = px + x;
        if (xx >= 0 && xx < iw) img[row + xx] = c;
      }
    }
  }
}

export interface Map16Source {
  // returns 4 tile words (TL, BL, TR, BR) for a FG map16 tile number
  fg(tile: number): number[];
  bg(tile: number): number[];
}

export function map16Source(rom: Rom, r: LevelRender): Map16Source {
  const w = r.wram;
  return {
    fg(t: number) {
      if (t >= EXT_FIRST) return extTileWords(rom, t) ?? this.fg(BLANK_TILE);
      const base = fgTileAddr(rom, r, t);
      return [rom.r16(base), rom.r16(base + 2), rom.r16(base + 4), rom.r16(base + 6)];
    },
    bg(t: number) {
      return bgTileWords(rom, t);
    },
  };
}

// an empty FG Map16 tile (air) of every tileset
export const BLANK_TILE = 0x025;
// its 4 tile words in the level's tileset: what new Map16 tiles start with and emptied ones get back
export function blankTile(rom: Rom, r: LevelRender): number[] {
  return map16Source(rom, r).fg(BLANK_TILE);
}

// where FG Map16 tile t's 4 words are: the level's tileset's (its Map16 pointers in the level's WRAM),
// an extended tile's in the extended Map16
export function fgTileAddr(rom: Rom, r: LevelRender, t: number): number {
  return t >= EXT_FIRST ? extTileAddr(rom, t) : 0x0d0000 | map16Pointer(r.wram, t);
}
// writes FG Map16 tile t's 4 words where map16Source reads them
export function setFgWords(rom: Rom, r: LevelRender, t: number, words: number[]): void {
  if (t >= EXT_FIRST) { setExtTileWords(rom, t, words); return; }
  const base = fgTileAddr(rom, r, t);
  words.forEach((v, q) => rom.w16(base + q * 2, v));
}

export function drawMap16(img: Uint32Array, iw: number, ih: number, tc: TileCache, words: number[], px: number, py: number): void {
  blit8(img, iw, ih, tc.get(words[0]), px, py);
  blit8(img, iw, ih, tc.get(words[1]), px, py + 8);
  blit8(img, iw, ih, tc.get(words[2]), px + 8, py);
  blit8(img, iw, ih, tc.get(words[3]), px + 8, py + 8);
}

export interface LevelImages {
  width: number; // pixels
  height: number;
  backdrop: number; // RGBA
  layer1: Uint32Array;
  layer2: Uint32Array; // BG or layer 2 level
  // BG3 (tides, layer 3 images): low priority tiles behind everything, high priority ones in front
  // (BG mode 1 with BG3 priority), translucent when color math is enabled for BG3
  layer3: { back: Uint32Array; front: Uint32Array; blend: boolean } | null;
  geom1: LayerGeom;
  geom2: LayerGeom | null;
  tiles1: Uint16Array; // map16 numbers per tile (layer 1)
  tiles2: Uint16Array | null;
  bgTiles: Uint16Array | null; // BG Map16 numbers of the BG tilemap (32 x 27, repeating), without layer 2 objects
}

export function backdropColor(r: LevelRender): number {
  const c = get16(r.wram, RAM.backdrop);
  return snesColorToRGBA(c);
}

export function renderLevel(rom: Rom, r: LevelRender, mode: number, screens: number, rows = 27): LevelImages {
  const w = r.wram;
  const geom1 = layerGeom(rom, 0, mode, screens, rows);
  const width = geom1.width * 16, height = geom1.height * 16;
  const tc = new TileCache(r.vram, r.cgram, ((r.ppuRegs[0x0b] & 0x0f) << 13));
  const src = map16Source(rom, r);
  const layer1 = new Uint32Array(width * height);
  const tiles1 = new Uint16Array(geom1.width * geom1.height);
  for (let y = 0; y < geom1.height; y++) for (let x = 0; x < geom1.width; x++) {
    const a = geom1.addr(x, y);
    const t = map16Tile(w, a);
    tiles1[y * geom1.width + x] = t;
    drawMap16(layer1, width, height, tc, src.fg(t), x * 16, y * 16);
  }
  const layer2 = new Uint32Array(width * height);
  let geom2: LayerGeom | null = null;
  let tiles2: Uint16Array | null = null, bgTiles: Uint16Array | null = null;
  const tc2 = new TileCache(r.vram, r.cgram, ((r.ppuRegs[0x0b] >> 4) << 13));
  if (hasLayer2Objects(mode)) {
    geom2 = layerGeom(rom, 1, mode, screens);
    tiles2 = new Uint16Array(geom2.width * geom2.height);
    for (let y = 0; y < geom2.height; y++) for (let x = 0; x < geom2.width; x++) {
      const a = geom2.addr(x, y);
      const t = map16Tile(w, a);
      tiles2[y * geom2.width + x] = t;
      if (x * 16 < width && y * 16 < height) drawMap16(layer2, width, height, tc2, src.fg(t), x * 16, y * 16);
    }
  } else {
    // BG tilemap: 32 x 27 tiles, repeating horizontally ($7EB900 / $7EBD00)
    const bgw = 32, bgh = 27;
    const bgRows: number[][] = [];
    for (let y = 0; y < bgh; y++) {
      const row: number[] = [];
      for (let x = 0; x < bgw; x++) {
        const o = (x >> 4) * 0x1b0 + y * 16 + (x & 15);
        row.push(bgTile(w, o));
      }
      bgRows.push(row);
    }
    bgTiles = Uint16Array.from(bgRows.flat());
    const rows = Math.ceil(height / 16), cols = Math.ceil(width / 16);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const t = bgRows[y % bgh][x % bgw];
      drawMap16(layer2, width, height, tc2, src.bg(t), x * 16, y * 16);
    }
  }
  const layer3 = renderLayer3(r, width, height);
  return { width, height, backdrop: backdropColor(r), layer1, layer2, layer3, geom1, geom2, tiles1, tiles2, bgTiles };
}

// tiles of an object layer (packed y<<16|x, laid out by g) drawn together, cut to their bounds, 0 = transparent;
// null without tiles
export function renderLayerTiles(rom: Rom, r: LevelRender, g: LayerGeom, layer2: boolean, tiles: number[]): { x0: number; y0: number; w: number; h: number; px: Uint32Array } | null {
  if (!tiles.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const t of tiles) {
    const x = t & 0xffff, y = t >> 16;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = (x1 - x0 + 1) * 16, h = (y1 - y0 + 1) * 16, px = new Uint32Array(w * h);
  const tc = new TileCache(r.vram, r.cgram, layer2 ? (r.ppuRegs[0x0b] >> 4) << 13 : (r.ppuRegs[0x0b] & 0x0f) << 13);
  const src = map16Source(rom, r);
  for (const t of tiles) {
    const x = t & 0xffff, y = t >> 16;
    drawMap16(px, w, h, tc, src.fg(map16Tile(r.wram, g.addr(x, y))), (x - x0) * 16, (y - y0) * 16);
  }
  return { x0, y0, w, h, px };
}

// Tiles of an object layer (1 or layer 2 objects) that are there but cannot be seen: drawn without a single pixel,
// yet acting unlike air or running a custom block (invisible blocks, P-switch coins and doors, 1-Up points …);
// by the tile at (x, y), each tile number judged once
export function invisibleTiles(rom: Rom, li: LevelImages, layer2: boolean): (x: number, y: number) => boolean {
  const g = layer2 ? li.geom2 : li.geom1, tiles = layer2 ? li.tiles2 : li.tiles1, img = layer2 ? li.layer2 : li.layer1;
  const known = new Map<number, boolean>();
  return (x, y) => {
    if (!g || !tiles || x < 0 || y < 0 || x >= g.width || y >= g.height || (x + 1) * 16 > li.width || (y + 1) * 16 > li.height) return false;
    const t = tiles[y * g.width + x];
    let v = known.get(t);
    if (v === undefined) {
      v = actsLike(rom, t) !== DEFAULT_ACTS || blockOf(rom, t) !== null;
      for (let py = 0; py < 16 && v; py++) for (let px = 0; px < 16 && v; px++) if (img[(y * 16 + py) * li.width + x * 16 + px]) v = false;
      known.set(t, v);
    }
    return v;
  };
}

// whether a Map16 tile's quarters (4bpp 8x8 tiles from charBase, palette rows 0-7) draw a pixel in one of
// `colors` (CGRAM indices)
function drawsColors(words: number[], vram: Uint8Array, charBase: number, colors: Set<number>, idx: Uint8Array): boolean {
  for (const w of words) {
    const row = ((w >> 10) & 7) * 16;
    let any = false;
    for (let v = 1; v < 16 && !any; v++) any = colors.has(row + v);
    if (!any) continue;
    decodeTile(vram, (charBase + (w & 0x3ff) * 32) & 0xffff, 4, idx);
    for (const v of idx) if (v && colors.has(row + v)) return true;
  }
  return false;
}

// the level's Map16 tiles that draw one of `colors` (CGRAM indices): FG tiles of layer 1 and of layer 2
// objects, BG tiles of the BG tilemap; sprite palettes (rows 8-F) are no layer's
export function levelColorUsers(rom: Rom, r: LevelRender, im: LevelImages, colors: Set<number>): { layer1: number[]; layer2: number[]; bg: number[] } {
  const src = map16Source(rom, r), idx = new Uint8Array(64);
  const base1 = (r.ppuRegs[0x0b] & 0x0f) << 13, base2 = (r.ppuRegs[0x0b] >> 4) << 13;
  const find = (tiles: Uint16Array | null, words: (t: number) => number[], base: number) =>
    [...new Set(tiles ?? [])].filter((t) => drawsColors(words(t), r.vram, base, colors, idx));
  const sorted = (a: number[]) => a.sort((x, y) => x - y);
  return { layer1: sorted(find(im.tiles1, (t) => src.fg(t), base1)), layer2: sorted(find(im.tiles2, (t) => src.fg(t), base2)), bg: sorted(find(im.bgTiles, (t) => src.bg(t), base2)) };
}

// where the BG3 tilemap is on the level image at the end of the load: its VRAM byte address, size in pixels
// (mw x mh, one, two or four tilemap quadrants of 32x32 tiles), scroll against the camera; tile (tx, ty) is
// drawn at level pixel (tx * 8 - dx, ty * 8 - dy), repeated every mw pixels horizontally
export interface Layer3Geometry { base: number; wide: number; mw: number; mh: number; dx: number; dy: number }
export const LAYER3_STATUS_ROWS = 5; // the status bar's tile rows (not drawn)
export function layer3Geometry(r: Pick<LevelRender, 'wram' | 'ppuRegs'>): Layer3Geometry {
  const w = r.wram, sc = r.ppuRegs[0x09], wide = sc & 1, tall = (sc >> 1) & 1;
  return { base: (sc & 0xfc) << 9, wide, mw: 256 << wide, mh: 256 << tall, dx: get16(w, RAM.layer3X) - cameraX(w), dy: get16(w, RAM.layer3Y) - cameraY(w) };
}
// VRAM byte address of tile (tx, ty)'s word: in its tilemap quadrant (32x32 tiles), those left to right, then down
const TILEMAP_QUADRANT = 0x800; // bytes
export const layer3TileAddr = (g: Layer3Geometry, tx: number, ty: number): number =>
  (g.base + ((tx >> 5) + (ty >> 5) * (g.wide ? 2 : 1)) * TILEMAP_QUADRANT + ((ty & 31) * 32 + (tx & 31)) * 2) & 0xffff;

// BG3 tilemap (2bpp) placed like on screen at the end of the level load: layer 3 scroll ($22/$24)
// relative to the camera ($1A/$1C), repeated horizontally. Approximation: layer 3 is assumed to
// scroll along with the camera. The top 5 tile rows hold the status bar (incl. item box) and are skipped.
export function renderLayer3(r: LevelRender, width: number, height: number): LevelImages['layer3'] {
  const p = r.ppuRegs;
  if (!(p[0x2c] & 0x04) && !(p[0x2d] & 0x04)) return null;
  const g = layer3Geometry(r), { mw, mh, dx, dy } = g;
  const tc = new TileCache(r.vram, r.cgram, (p[0x0c] & 0x0f) << 13);
  const back = new Uint32Array(width * height), front = new Uint32Array(width * height);
  const prioFront = (p[0x05] & 0x0f) === 0x09;
  let any = false;
  for (let ty = LAYER3_STATUS_ROWS; ty < mh / 8; ty++) {
    const py = ty * 8 - dy;
    if (py + 8 <= 0 || py >= height) continue;
    for (let tx = 0; tx < mw / 8; tx++) {
      const a = layer3TileAddr(g, tx, ty);
      const word = r.vram[a] | (r.vram[a + 1] << 8);
      const t = tc.get(word, 2);
      if (!t.some((c) => c)) continue;
      any = true;
      const out = prioFront && word & 0x2000 ? front : back;
      for (let px = ((((tx * 8 - dx) % mw) + mw) % mw) - mw; px < width; px += mw) if (px + 8 > 0) blit8(out, width, height, t, px, py);
    }
  }
  return any ? { back, front, blend: (p[0x31] & 0x04) !== 0 } : null;
}

// ghost: 1 or 2 draws that layer at 35 % opacity, 3 both; layer 3 in front is drawn half transparent
export function composite(li: LevelImages, show1 = true, show2 = true, ghost = 0, show3 = true): Uint32Array {
  const out = new Uint32Array(li.width * li.height).fill(li.backdrop);
  const put = (src: Uint32Array, faint: boolean) => {
    for (let i = 0; i < out.length; i++) {
      const c = src[i];
      if (c) out[i] = faint ? blend(c, out[i], 0.35) : c;
    }
  };
  const l3 = show3 ? li.layer3 : null;
  if (l3) put(l3.back, false);
  if (show2) put(li.layer2, (ghost & 2) !== 0);
  if (show1) put(li.layer1, (ghost & 1) !== 0);
  if (l3) {
    const f = l3.front;
    for (let i = 0; i < out.length; i++) if (f[i]) out[i] = l3.blend ? blend(f[i], out[i], 0.5) : f[i];
  }
  return out;
}

// What an animation step (other VRAM and CGRAM than the render r) changes: whether an 8x8 tile looks different –
// its graphics (bpp * 8 bytes from charBase) or a color of its palette; null when the step changes nothing
export function stepChanges(r: Pick<LevelRender, 'vram' | 'cgram'>, vram: Uint8Array, cgram: Uint8Array): ((word: number, charBase: number, bpp: number) => boolean) | null {
  // which 16-byte rows of VRAM and which colors differ
  const rowDiff = new Uint8Array(0x1000), colorDiff = new Uint8Array(256);
  let any = false;
  for (let i = 0; i < 0x10000; i += 16) {
    for (let k = 0; k < 16; k++) if (vram[i + k] !== r.vram[i + k]) { rowDiff[i >> 4] = 1; any = true; break; }
  }
  for (let c = 0; c < 256; c++) if (cgram[c * 2] !== r.cgram[c * 2] || cgram[c * 2 + 1] !== r.cgram[c * 2 + 1]) { colorDiff[c] = 1; any = true; }
  if (!any) return null;
  return (word, charBase, bpp) => {
    const at = (charBase + (word & 0x3ff) * bpp * 8) & 0xffff;
    for (let a = at; a < at + bpp * 8; a += 16) if (rowDiff[(a & 0xffff) >> 4]) return true;
    const colors = bpp === 2 ? 4 : 16, row = ((word >> 10) & 7) * colors;
    for (let v = 1; v < colors; v++) if (colorDiff[row + v]) return true;
    return false;
  };
}

// where the 8x8 tiles of FG (layer 1) or BG (layer 2) Map16 tiles are in VRAM (BG12NBA, $210B; a level's or a submap's
// load)
export function charBase(r: Pick<LevelRender, 'ppuRegs'>, bg: boolean): number {
  const p = r.ppuRegs[0x0b];
  return (bg ? p >> 4 : p & 0x0f) << 13;
}

// the cells (see TilePixels) of a sheet of `count` Map16 tiles from `first`, 16 a row
export function sheetCells(first: number, count: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < count; t++) out.push((t & 15) * 16, (t >> 4) * 16, first + t);
  return out;
}

// An image of the animation: the level's VRAM and CGRAM at one of its steps
export interface AnimStep { vram: Uint8Array; cgram: Uint8Array }

// Pixels showing the level's Map16 tiles (a picker's page, an object's thumbnail): the pixels (w wide), where each
// tile is and which (cells: x, y of its top left pixel and its number, one after the other), FG or BG tiles,
// and the pixel where a tile draws none (backAt: the pixel at x, y where it varies, a checkerboard)
export interface TilePixels { px: Uint32Array; w: number; h: number; cells: number[]; bg: boolean; back: number; backAt?: (x: number, y: number) => number }

// the pixels' size×size cell at (x0, y0) cleared to where a tile draws none
export function clearCell(p: TilePixels, x0: number, y0: number, size: number): void {
  for (let y = y0; y < y0 + size && y < p.h; y++) {
    const row = y * p.w;
    if (!p.backAt) { p.px.fill(p.back, row + x0, row + Math.min(p.w, x0 + size)); continue; }
    for (let x = x0; x < x0 + size && x < p.w; x++) p.px[row + x] = p.backAt(x, y);
  }
}

// what draws an animation's steps on pixels of tiles (TileAnimation: the level's; owanimsteps.ts OwTileAnimation: the
// overworld's): the pixels, drawn as step `from` showed them (null: as the render shows them), redrawn as step `to`
// shows them (all: all of them, for pixels drawn with another render); whether a tile was drawn anew
export interface PictureAnimation { redraw(pixels: TilePixels, from: AnimStep | null, to: AnimStep | null, all?: boolean): boolean }

// The level's animation on pixels of its Map16 tiles: between two steps, only the tiles that look different
// in one of them are drawn anew; what a step changes is found once per step and tile
export class TileAnimation implements PictureAnimation {
  private rom: Rom;
  private r: LevelRender;
  private src: Map16Source;
  private known = new WeakMap<AnimStep, { differs: ReturnType<typeof stepChanges>; fg: Map<number, boolean>; bg: Map<number, boolean> }>();
  private caches = new WeakMap<AnimStep, { fg: TileCache; bg: TileCache }>();
  private base: { fg: TileCache; bg: TileCache };

  constructor(rom: Rom, r: LevelRender) {
    this.rom = rom;
    this.r = r;
    this.src = map16Source(rom, r);
    this.base = this.tileCaches(r);
  }

  private tileCaches(s: AnimStep): { fg: TileCache; bg: TileCache } {
    return { fg: new TileCache(s.vram, s.cgram, charBase(this.r, false)), bg: new TileCache(s.vram, s.cgram, charBase(this.r, true)) };
  }

  private words(t: number, bg: boolean): number[] {
    return bg ? this.src.bg(t) : this.src.fg(t);
  }

  // whether Map16 tile t looks different at step s than the render shows it
  changes(s: AnimStep, t: number, bg: boolean): boolean {
    let k = this.known.get(s);
    if (!k) this.known.set(s, k = { differs: stepChanges(this.r, s.vram, s.cgram), fg: new Map(), bg: new Map() });
    if (!k.differs) return false;
    const m = bg ? k.bg : k.fg;
    let v = m.get(t);
    if (v === undefined) {
      const base = charBase(this.r, bg), differs = k.differs;
      m.set(t, v = this.words(t, bg).some((w) => differs(w, base, 4)));
    }
    return v;
  }

  // the pixels, drawn as step `from` showed them (null: as the render shows them), redrawn as step `to` shows them
  // (all: all of them, for pixels drawn with another render); whether a tile was drawn anew
  redraw(pixels: TilePixels, from: AnimStep | null, to: AnimStep | null, all = false): boolean {
    let tc: TileCache | null = null, any = false;
    const c = pixels.cells;
    if (all) clearCell(pixels, 0, 0, Math.max(pixels.w, pixels.h));
    for (let i = 0; i < c.length; i += 3) {
      const t = c[i + 2];
      if (!all && !(from && this.changes(from, t, pixels.bg)) && !(to && this.changes(to, t, pixels.bg))) continue;
      if (!tc) {
        let set = to ? this.caches.get(to) : this.base;
        if (!set) this.caches.set(to!, set = this.tileCaches(to!));
        tc = pixels.bg ? set.bg : set.fg;
      }
      const x0 = c[i], y0 = c[i + 1];
      clearCell(pixels, x0, y0, 16);
      drawMap16(pixels.px, pixels.w, pixels.h, tc, this.words(t, pixels.bg), x0, y0);
      any = true;
    }
    return any;
  }
}

// An animation step (other VRAM and CGRAM than the render r) as the pixels of the composed level image `base`
// that change: only the 16x16 cells drawing an 8x8 tile whose graphics or colors differ are drawn anew, each
// composed by look as the whole image was. null when the step changes what every cell shows (the backdrop
// color) or a layer 3 the render drew nothing of: then it is drawn whole.
export function animatedPixels(rom: Rom, r: LevelRender, li: LevelImages, base: Uint32Array, vram: Uint8Array, cgram: Uint8Array, look: (cell: LevelImages) => Uint32Array): { idx: Uint32Array; val: Uint32Array } | null {
  if (cgram[0] !== r.cgram[0] || cgram[1] !== r.cgram[1]) return null;
  const tileDiffers = stepChanges(r, vram, cgram);
  if (!tileDiffers) return { idx: new Uint32Array(0), val: new Uint32Array(0) };
  const p = r.ppuRegs, base1 = (p[0x0b] & 0x0f) << 13, base2 = (p[0x0b] >> 4) << 13;
  const src = map16Source(rom, r);
  const map16Differs = (charBase: number, words: (t: number) => number[]) => {
    const known = new Map<number, boolean>();
    return (t: number) => {
      let v = known.get(t);
      if (v === undefined) known.set(t, v = words(t).some((w) => tileDiffers(w, charBase, 4)));
      return v;
    };
  };
  const cols = li.width >> 4, rows = li.height >> 4;
  const dirty = new Uint8Array(cols * rows);
  const fg1 = map16Differs(base1, (t) => src.fg(t));
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (fg1(li.tiles1[y * li.geom1.width + x])) dirty[y * cols + x] = 1;
  const g2 = li.geom2, tiles2 = li.tiles2, bgTiles = li.bgTiles;
  const layer2At = (x: number, y: number): number[] | null =>
    g2 && tiles2 ? (x < g2.width && y < g2.height ? src.fg(tiles2[y * g2.width + x]) : null) : bgTiles ? src.bg(bgTiles[(y % 27) * 32 + (x % 32)]) : null;
  if (g2 && tiles2) {
    const fg2 = map16Differs(base2, (t) => src.fg(t));
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (x < g2.width && y < g2.height && fg2(tiles2[y * g2.width + x])) dirty[y * cols + x] = 1;
  } else if (bgTiles) {
    const bg = map16Differs(base2, (t) => src.bg(t));
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (bg(bgTiles[(y % 27) * 32 + (x % 32)])) dirty[y * cols + x] = 1;
  }
  // layer 3: a tile whose word or look differs marks the cells it covers (placed as renderLayer3 does)
  const l3on = (p[0x2c] & 0x04) !== 0 || (p[0x2d] & 0x04) !== 0;
  const g3 = l3on ? layer3Geometry(r) : null, base3 = (p[0x0c] & 0x0f) << 13;
  if (g3) {
    const { mw, mh, dx, dy } = g3;
    for (let ty = LAYER3_STATUS_ROWS; ty < mh / 8; ty++) {
      const py = ty * 8 - dy;
      if (py + 8 <= 0 || py >= li.height) continue;
      for (let tx = 0; tx < mw / 8; tx++) {
        const a = layer3TileAddr(g3, tx, ty);
        const was = r.vram[a] | (r.vram[a + 1] << 8), now = vram[a] | (vram[a + 1] << 8);
        if (was === now && !tileDiffers(now, base3, 2)) continue;
        if (!li.layer3) return null;
        for (let px = ((((tx * 8 - dx) % mw) + mw) % mw) - mw; px < li.width; px += mw) {
          if (px + 8 <= 0) continue;
          for (let cy = Math.max(0, py >> 4); cy <= Math.min(rows - 1, (py + 7) >> 4); cy++)
            for (let cx = Math.max(0, px >> 4); cx <= Math.min(cols - 1, (px + 7) >> 4); cx++) dirty[cy * cols + cx] = 1;
        }
      }
    }
  }
  // the dirty cells drawn anew, one at a time, as 16x16 level images
  const tc1 = new TileCache(vram, cgram, base1), tc2 = new TileCache(vram, cgram, base2), tc3 = new TileCache(vram, cgram, base3);
  const prioFront = (p[0x05] & 0x0f) === 0x09;
  const cell: LevelImages = { ...li, width: 16, height: 16, layer1: new Uint32Array(256), layer2: new Uint32Array(256), layer3: li.layer3 && { back: new Uint32Array(256), front: new Uint32Array(256), blend: li.layer3.blend } };
  const idx: number[] = [], val: number[] = [];
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (!dirty[cy * cols + cx]) continue;
    cell.layer1.fill(0);
    drawMap16(cell.layer1, 16, 16, tc1, src.fg(li.tiles1[cy * li.geom1.width + cx]), 0, 0);
    cell.layer2.fill(0);
    const w2 = layer2At(cx, cy);
    if (w2) drawMap16(cell.layer2, 16, 16, tc2, w2, 0, 0);
    if (cell.layer3 && g3) {
      cell.layer3.back.fill(0); cell.layer3.front.fill(0);
      const { mw, mh, dx, dy } = g3;
      // the layer 3 tiles covering the cell: tile rows by level y, tile columns by level x (repeating every mw)
      for (let ys = cy * 16 + dy - ((cy * 16 + dy) & 7); ys < cy * 16 + 16 + dy; ys += 8) {
        const ty = ys >> 3;
        if (ty < LAYER3_STATUS_ROWS || ty >= mh / 8) continue;
        for (let x = cx * 16; x < cx * 16 + 16;) {
          const m = (((x + dx) % mw) + mw) % mw, px = x - (m & 7);
          const a = layer3TileAddr(g3, m >> 3, ty), word = vram[a] | (vram[a + 1] << 8);
          blit8((prioFront && word & 0x2000) ? cell.layer3.front : cell.layer3.back, 16, 16, tc3.get(word, 2), px - cx * 16, ys - dy - cy * 16);
          x = px + 8;
        }
      }
    }
    const img = look(cell);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const k = (cy * 16 + y) * li.width + cx * 16 + x;
      if (img[y * 16 + x] !== base[k]) { idx.push(k); val.push(img[y * 16 + x]); }
    }
  }
  // in pixel order, as a scan of the whole image finds them
  const order = idx.map((_, j) => j).sort((a, b) => idx[a] - idx[b]);
  return { idx: Uint32Array.from(order, (j) => idx[j]), val: Uint32Array.from(order, (j) => val[j]) };
}

function blend(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * t + ((b >> s) & 0xff) * (1 - t));
  return (0xff000000 | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

export { MAP_BASE };
