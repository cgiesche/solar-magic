// Renders level layers from an emulated level load (WRAM/VRAM/CGRAM snapshot).

import { Rom } from './rom.ts';
import { decodeTile, cgramToRGBA, snesColorToRGBA } from './gfx.ts';
import { isL1Vertical, isL2Vertical, hasLayer2Objects } from './level.ts';
import { MAP_BASE, type LevelRender } from './levelemu.ts';
import { EXT_FIRST, extTileWords } from './map16ext.ts';
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
      if (t >= EXT_FIRST) return extTileWords(rom, t) ?? this.fg(0x025);
      const ptr = map16Pointer(w, t);
      const base = 0x0d0000 | ptr;
      return [rom.r16(base), rom.r16(base + 2), rom.r16(base + 4), rom.r16(base + 6)];
    },
    bg(t: number) {
      return bgTileWords(rom, t);
    },
  };
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
// (mw x mh, 32x32 tiles a screen), scroll against the camera; tile (tx, ty) is drawn at level pixel
// (tx * 8 - dx, ty * 8 - dy), repeated every mw pixels horizontally
export interface Layer3Geometry { base: number; wide: number; mw: number; mh: number; dx: number; dy: number }
export const LAYER3_STATUS_ROWS = 5; // the status bar's tile rows (not drawn)
export function layer3Geometry(r: LevelRender): Layer3Geometry {
  const w = r.wram, sc = r.ppuRegs[0x09], wide = sc & 1, tall = (sc >> 1) & 1;
  return { base: (sc & 0xfc) << 9, wide, mw: 256 << wide, mh: 256 << tall, dx: get16(w, RAM.layer3X) - cameraX(w), dy: get16(w, RAM.layer3Y) - cameraY(w) };
}
// VRAM byte address of tile (tx, ty)'s word
export const layer3TileAddr = (g: Layer3Geometry, tx: number, ty: number): number =>
  (g.base + ((tx >> 5) + (ty >> 5) * (g.wide ? 2 : 1)) * 0x800 + ((ty & 31) * 32 + (tx & 31)) * 2) & 0xffff;

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

function blend(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * t + ((b >> s) & 0xff) * (1 - t));
  return (0xff000000 | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

export { MAP_BASE };
