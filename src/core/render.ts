// Renders level layers from an emulated level load (WRAM/VRAM/CGRAM snapshot).

import { Rom } from './rom.ts';
import { decodeTile, cgramToRGBA, snesColorToRGBA } from './gfx.ts';
import { isL1Vertical, isL2Vertical, hasLayer2Objects } from './level.ts';
import { MAP_BASE, type LevelRender } from './levelemu.ts';

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

export function layerGeom(rom: Rom, layer: number, mode: number, screens: number): LayerGeom {
  const vertical = layer === 0 ? isL1Vertical(rom, mode) : isL2Vertical(rom, mode);
  const bases: number[] = [];
  const maxScreens = 32;
  for (let s = 0; s < maxScreens; s++) bases.push(screenBase(rom, layer, mode, s));
  if (vertical) {
    const h = screens * 16;
    return {
      vertical, width: 32, height: h,
      addr(x, y) {
        if (x < 0 || y < 0 || x >= 32 || y >= h) return -1;
        return bases[y >> 4] + ((x >> 4) << 8) + ((y & 15) << 4) + (x & 15);
      },
    };
  }
  const w = screens * 16;
  return {
    vertical, width: w, height: 27,
    addr(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= 27) return -1;
      return bases[x >> 4] + (y << 4) + (x & 15);
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
      const ptr = w[0x0fbe + (t & 0x1ff) * 2] | (w[0x0fbf + (t & 0x1ff) * 2] << 8);
      const base = 0x0d0000 | ptr;
      return [rom.r16(base), rom.r16(base + 2), rom.r16(base + 4), rom.r16(base + 6)];
    },
    bg(t: number) {
      const base = 0x0d9100 + (t & 0x1ff) * 8;
      return [rom.r16(base), rom.r16(base + 2), rom.r16(base + 4), rom.r16(base + 6)];
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
  geom1: LayerGeom;
  geom2: LayerGeom | null;
  tiles1: Uint16Array; // map16 numbers per tile (layer 1)
  tiles2: Uint16Array | null;
}

export function backdropColor(r: LevelRender): number {
  const c = r.wram[0x0701] | (r.wram[0x0702] << 8);
  return snesColorToRGBA(c);
}

export function renderLevel(rom: Rom, r: LevelRender, mode: number, screens: number): LevelImages {
  const w = r.wram;
  const geom1 = layerGeom(rom, 0, mode, screens);
  const width = geom1.width * 16, height = geom1.height * 16;
  const tc = new TileCache(r.vram, r.cgram, ((r.ppuRegs[0x0b] & 0x0f) << 13));
  const src = map16Source(rom, r);
  const layer1 = new Uint32Array(width * height);
  const tiles1 = new Uint16Array(geom1.width * geom1.height);
  for (let y = 0; y < geom1.height; y++) for (let x = 0; x < geom1.width; x++) {
    const a = geom1.addr(x, y);
    const t = w[a] | (w[a + 0x10000] << 8);
    tiles1[y * geom1.width + x] = t;
    drawMap16(layer1, width, height, tc, src.fg(t), x * 16, y * 16);
  }
  const layer2 = new Uint32Array(width * height);
  let geom2: LayerGeom | null = null;
  let tiles2: Uint16Array | null = null;
  const tc2 = new TileCache(r.vram, r.cgram, ((r.ppuRegs[0x0b] >> 4) << 13));
  if (hasLayer2Objects(mode)) {
    geom2 = layerGeom(rom, 1, mode, screens);
    tiles2 = new Uint16Array(geom2.width * geom2.height);
    for (let y = 0; y < geom2.height; y++) for (let x = 0; x < geom2.width; x++) {
      const a = geom2.addr(x, y);
      const t = w[a] | (w[a + 0x10000] << 8);
      tiles2[y * geom2.width + x] = t;
      if (x * 16 < width && y * 16 < height) drawMap16(layer2, width, height, tc2, src.fg(t), x * 16, y * 16);
    }
  } else {
    // BG tilemap: 32 x 27 tiles, repeating horizontally ($7EB900 / $7EBD00)
    const bgw = 32, bgh = 27;
    const bgTiles: number[][] = [];
    for (let y = 0; y < bgh; y++) {
      const row: number[] = [];
      for (let x = 0; x < bgw; x++) {
        const o = (x >> 4) * 0x1b0 + y * 16 + (x & 15);
        row.push(w[0xb900 + o] | (w[0xbd00 + o] << 8));
      }
      bgTiles.push(row);
    }
    const rows = Math.ceil(height / 16), cols = Math.ceil(width / 16);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const t = bgTiles[y % bgh][x % bgw];
      drawMap16(layer2, width, height, tc2, src.bg(t), x * 16, y * 16);
    }
  }
  return { width, height, backdrop: backdropColor(r), layer1, layer2, geom1, geom2, tiles1, tiles2 };
}

export function composite(li: LevelImages, show1 = true, show2 = true): Uint32Array {
  const out = new Uint32Array(li.width * li.height).fill(li.backdrop);
  if (show2) for (let i = 0; i < out.length; i++) if (li.layer2[i]) out[i] = li.layer2[i];
  if (show1) for (let i = 0; i < out.length; i++) if (li.layer1[i]) out[i] = li.layer1[i];
  return out;
}

export { MAP_BASE };
