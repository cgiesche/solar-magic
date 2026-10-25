// Lunar Magic's Map16 export (.map16, "LM16") and ExGFX file names (the files themselves: gfxfiles.ts).
//
// .map16 (as far as needed here): "LM16" magic, width/height in tiles at 0x18/0x1C, and at the offset
// stored at 0x10 a list of (offset, size) pairs: the tile data (8 bytes per tile: TL, BL, TR, BR tile
// words) and the acts-like values (2 bytes per tile). Tiles are row by row, 16 per Map16 row.
// When the section table starts after it, 0x24 tells where the tiles were exported from: the first
// tile / 16, bit 0x400 set for BG Map16 (seen in Lunar Magic 3.31 exports: FG page 2 = 0x20, BG tile
// 200 = 0x420, blocks at 500 = 0x50).

export interface Map16File {
  width: number; height: number; tiles: number[][]; acts: number[] | null;
  origin?: { bg: boolean; tile: number } | null; // where the tiles were exported from, if the file says
}

export function parseMap16File(d: Uint8Array): Map16File {
  const u32 = (o: number) => (o + 4 <= d.length ? d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24) : -1);
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'LM16') throw new Error('Not a Lunar Magic Map16 file (LM16)');
  const table = u32(0x10);
  const section = (i: number): Uint8Array | null => {
    const off = u32(table + i * 8), size = u32(table + i * 8 + 4);
    if (off <= 0 || size <= 0 || off + size > d.length) return null;
    return d.subarray(off, off + size);
  };
  const td = section(0);
  if (!td || td.length % 8) throw new Error('Map16 file: no tile data found');
  const tiles: number[][] = [];
  for (let i = 0; i < td.length; i += 8) tiles.push([0, 2, 4, 6].map((k) => td[i + k] | (td[i + k + 1] << 8)));
  const ad = section(1);
  const acts = ad && ad.length >= tiles.length * 2 ? tiles.map((_, i) => ad[i * 2] | (ad[i * 2 + 1] << 8)) : null;
  let width = u32(0x18), height = u32(0x1c);
  if (width <= 0 || height <= 0 || width * height !== tiles.length) { width = Math.min(16, tiles.length); height = Math.ceil(tiles.length / width); }
  const o = table >= 0x28 ? u32(0x24) : -1;
  const origin = o > 0 ? { bg: (o & 0x400) !== 0, tile: (o & 0x3ff) << 4 } : null;
  return origin ? { width, height, tiles, acts, origin } : { width, height, tiles, acts };
}

// Lunar Magic's export of all Map16 (as Callisto keeps it, export/all_map16.map16; seen in Lunar Magic
// 3.63's): the same header, its section table (at 0x10, 8 entries) has
// 0: all tiles, FG then BG; 1: the FG tiles' acts like (2 bytes per tile); 2: FG tiles 0000–7FFF (pages
// 00–7F, 00–01 left empty: they are the tilesets'); 3: BG tiles 0000–7FFF (pages 80–FF); 5: pages 00–01
// of tilesets 0–E (0x200 tiles each); then two tables of page 00–01 tiles kept apart from the tilesets:
// 6 (0x100 bytes) the vertical pipe's end and body in palettes 3, 5, 6, 7, 7 (0x40 bytes) tiles
// 1C4–1C7 and 1EC–1EF (the clean game's at $0D:8A70). Neither is taken over: they are pages 00–01.
// Tile words 4 per tile (TL, BL, TR, BR) in fg, bg and each tileset.
export const ROM_MAP16_TILES = 0x8000;
export const ROM_MAP16_TILESET_TILES = 0x200;
export interface RomMap16 { fg: Uint16Array; acts: Uint16Array; bg: Uint16Array; tilesets: Uint16Array[] }

// the words of tile t of fg, bg or a tileset
export const romTileWords = (a: Uint16Array, t: number): number[] => Array.from(a.subarray(t * 4, t * 4 + 4));

// the tile FG tile t acts like, followed while that acts like another of 200 on (Lunar Magic's acts
// like may name any tile) – until `stop` says so, else to one of pages 00–01; null when it leads
// nowhere (a loop: more steps than any chain of distinct tiles needs in practice)
const ACTS_CHAIN_MAX = 64;
export function romActsLike(m: RomMap16, t: number, stop: (t: number) => boolean = () => false): number | null {
  let a = m.acts[t];
  for (let n = 0; a >= ROM_MAP16_TILESET_TILES && !stop(a); n++) {
    if (n >= ACTS_CHAIN_MAX || a >= ROM_MAP16_TILES) return null;
    a = m.acts[a];
  }
  return a;
}

// null when the file is no export of all Map16
export function parseRomMap16(d: Uint8Array): RomMap16 | null {
  if (d.length < 0x20 || String.fromCharCode(...d.subarray(0, 4)) !== 'LM16') return null;
  const u32 = (o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
  const table = u32(0x10);
  const section = (i: number, size: number): Uint16Array | null => {
    const off = u32(table + i * 8);
    if (u32(table + i * 8 + 4) !== size || !off || off + size > d.length) return null;
    const out = new Uint16Array(size / 2);
    for (let k = 0; k < out.length; k++) out[k] = d[off + k * 2] | (d[off + k * 2 + 1] << 8);
    return out;
  };
  if (u32(0x14) < 6 * 8) return null;
  const fg = section(2, ROM_MAP16_TILES * 8), bg = section(3, ROM_MAP16_TILES * 8), acts = section(1, ROM_MAP16_TILES * 2);
  if (!fg || !bg || !acts) return null;
  const size = u32(table + 5 * 8 + 4), per = ROM_MAP16_TILESET_TILES * 8;
  const all = size && !(size % per) ? section(5, size) : null;
  const tilesets = all ? Array.from({ length: size / per }, (_, i) => all.subarray(i * per / 2, (i + 1) * per / 2)) : [];
  return { fg, acts, bg, tilesets };
}

// writes the same layout: header (magic, section table offset at 0x10, width/height at 0x18/0x1C),
// section table (tiles, acts like), data
export function writeMap16File(f: Map16File): Uint8Array {
  const n = f.tiles.length;
  const table = 0x20, tiles = table + 16, acts = tiles + n * 8;
  const out = new Uint8Array(acts + (f.acts ? n * 2 : 0));
  const u32 = (o: number, v: number) => { out[o] = v & 255; out[o + 1] = (v >> 8) & 255; out[o + 2] = (v >> 16) & 255; out[o + 3] = (v >>> 24) & 255; };
  out.set([0x4c, 0x4d, 0x31, 0x36]); // "LM16"
  u32(0x10, table);
  u32(0x18, f.width);
  u32(0x1c, f.height);
  u32(table, tiles); u32(table + 4, n * 8);
  if (f.acts) { u32(table + 8, acts); u32(table + 12, n * 2); }
  f.tiles.forEach((ws, i) => ws.forEach((w, k) => { out[tiles + i * 8 + k * 2] = w & 255; out[tiles + i * 8 + k * 2 + 1] = w >> 8; }));
  f.acts?.forEach((a, i) => { out[acts + i * 2] = a & 255; out[acts + i * 2 + 1] = a >> 8; });
  return out;
}

// Map16 tile numbers of the file's tiles when its top-left tile goes to `at`
export function map16Targets(f: Map16File, at: number): number[] {
  return f.tiles.map((_, i) => at + Math.floor(i / f.width) * 16 + (i % f.width));
}

// ExGFX number and slot from a file name like "ExGFX80_BG2.bin"
export function exgfxName(name: string): { num: number | null; slot: string | null } {
  const m = /ExGFX([0-9a-f]{1,3})/i.exec(name);
  const s = /[_\-\s](BG[1-3]|FG[1-3]|SP[1-4])\b/i.exec(name);
  return { num: m ? parseInt(m[1], 16) : null, slot: s ? s[1].toUpperCase() : null };
}

