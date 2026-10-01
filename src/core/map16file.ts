// Lunar Magic's Map16 export (.map16, "LM16") and ExGFX files (.bin).
//
// .map16 (as far as needed here): "LM16" magic, width/height in tiles at 0x18/0x1C, and at the offset
// stored at 0x10 a list of (offset, size) pairs: the tile data (8 bytes per tile: TL, BL, TR, BR tile
// words) and the acts-like values (2 bytes per tile). Tiles are row by row, 16 per Map16 row.

import { Rom } from './rom.ts';
import { lz2Decompress, lz2Compress } from './lz2.ts';
import { gfxEntry, setGfxEntry, VANILLA_GFX } from './patches.ts';

export interface Map16File { width: number; height: number; tiles: number[][]; acts: number[] | null }

export function parseMap16File(d: Uint8Array): Map16File {
  const u32 = (o: number) => (o + 4 <= d.length ? d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24) : -1);
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'LM16') throw new Error('Keine Lunar-Magic-Map16-Datei (LM16)');
  const table = u32(0x10);
  const section = (i: number): Uint8Array | null => {
    const off = u32(table + i * 8), size = u32(table + i * 8 + 4);
    if (off <= 0 || size <= 0 || off + size > d.length) return null;
    return d.subarray(off, off + size);
  };
  const td = section(0);
  if (!td || td.length % 8) throw new Error('Map16-Datei: keine Tile-Daten gefunden');
  const tiles: number[][] = [];
  for (let i = 0; i < td.length; i += 8) tiles.push([0, 2, 4, 6].map((k) => td[i + k] | (td[i + k + 1] << 8)));
  const ad = section(1);
  const acts = ad && ad.length >= tiles.length * 2 ? tiles.map((_, i) => ad[i * 2] | (ad[i * 2 + 1] << 8)) : null;
  let width = u32(0x18), height = u32(0x1c);
  if (width <= 0 || height <= 0 || width * height !== tiles.length) { width = Math.min(16, tiles.length); height = Math.ceil(tiles.length / width); }
  return { width, height, tiles, acts };
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

// stores a GFX/ExGFX file: 4 KB = raw 4bpp (DMA'd directly), 3 KB = 3bpp (packed with LZ2),
// otherwise LZ2 data as it is (like Lunar Magic's compressed ExGFX). Replaces a file in free space.
export function importGfxFile(rom: Rom, num: number, data: Uint8Array): string {
  if (num < 0 || num > 0xff) throw new Error('GFX-Nummer muss 00–FF sein');
  let raw: boolean, stored: Uint8Array, what: string;
  if (data.length === 0x1000) { raw = true; stored = data; what = '4bpp unkomprimiert'; }
  else if (data.length === 0xc00) { raw = false; stored = lz2Compress(data); what = '3bpp, LZ2-gepackt'; }
  else {
    let un: Uint8Array;
    try { un = lz2Decompress(data, 0).data; } catch { throw new Error(`Unbekanntes GFX-Format (${data.length} Bytes)`); }
    if (un.length === 0x1000) { raw = true; stored = un; what = '4bpp (entpackt)'; }
    else if (un.length === 0xc00) { raw = false; stored = data; what = '3bpp, LZ2'; }
    else throw new Error(`Unbekanntes GFX-Format (${data.length} Bytes, entpackt ${un.length})`);
  }
  const old = gfxEntry(rom, num);
  if (old && num >= VANILLA_GFX) rom.freeAt(old.addr);
  setGfxEntry(rom, num, rom.allocWrite(stored), raw);
  return what;
}
