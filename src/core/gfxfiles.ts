// Graphics files: the GFX/ExGFX files 000–FFF and the Anim graphics A–D (ADR 0003), numbered past
// them, behind one interface – read as pixels or bytes, written back, created, imported, removed. It
// hides how they are stored: the editor's file table, LZ2 or raw, written in place when the new data
// fits the file's place, else moved to free space and the old place freed (the game's own files keep
// their original bytes, which are not in free space).

import { snesToPc, type Rom } from './rom.ts';
import { lz2Compress, lz2Decompress } from './lz2.ts';
import { decodeTile, encodeTile } from './gfx.ts';
import { gfxEntry, setGfxEntry, gfxNumberProblem, gfxDataSize, GFX_FILES, GFX_3BPP, RAW_GFX_SIZES, type GfxEntry } from './patches.ts';
import { readAltFile, writeAltFile, altFileAddr, ALT_FILE_MAX } from './exanim.ts';

// Anim graphic A; B–D follow
export const ANIM_FILE = GFX_FILES;
export const isAnimFile = (n: number) => n >= ANIM_FILE;
const ANIM_SIZE = 0x1000; // a new Anim graphic: 128 tiles 4bpp

// a file as pixels (64 per 8x8 tile); auto: the detected bpp, packed: its size as stored, empty: no file
export interface GfxFile { num: number; addr: number; raw: boolean; bpp: number; auto: number; packed: number; pix: Uint8Array; tiles: number; empty: boolean }

// how the game reads a file of `size` bytes unpacked under number i (2bpp: its layer 3 files)
export function defaultBpp(i: number, size: number): number {
  if ((i >= 0x28 && i <= 0x2b) || i === 0x2f) return 2;
  if (size % 24 === 0 && size % 32 !== 0) return 3;
  if (size === 0xc00 || size === 0x600) return 3;
  return 4;
}

// whether there is a file under `num`
export function hasGfx(rom: Rom, num: number): boolean {
  return isAnimFile(num) ? !!altFileAddr(rom, num - ANIM_FILE) : !!gfxEntry(rom, num);
}

// the file's bytes unpacked and whether it is stored raw (an Anim graphic is); null: no file
export function gfxBytes(rom: Rom, num: number): { raw: boolean; data: Uint8Array } | null {
  if (isAnimFile(num)) { const d = readAltFile(rom, num - ANIM_FILE); return d ? { raw: true, data: d.slice() } : null; }
  const e = gfxEntry(rom, num);
  if (!e) return null;
  if (e.raw) return { raw: true, data: rom.bytes(e.addr, e.size).slice() };
  const r = lz2Decompress(rom.data, snesToPc(e.addr));
  rom.noteRead(snesToPc(e.addr), r.size);
  return { raw: false, data: r.data };
}

// the file as pixels; bpp: read an LZ2 file as another format than the detected one
export function readGfx(rom: Rom, num: number, bpp: number | null = null): GfxFile {
  const none: GfxFile = { num, addr: 0, raw: true, bpp: 4, auto: 4, packed: 0, pix: new Uint8Array(128 * 64), tiles: 128, empty: true };
  if (isAnimFile(num)) {
    const d = readAltFile(rom, num - ANIM_FILE);
    return d ? pixels(num, altFileAddr(rom, num - ANIM_FILE), true, 4, 4, d.length, d) : none;
  }
  const e = gfxEntry(rom, num);
  if (!e) return none;
  let data: Uint8Array, packed: number;
  if (e.raw) { data = rom.bytes(e.addr, e.size); packed = e.size; }
  else { ({ data, size: packed } = lz2Decompress(rom.data, snesToPc(e.addr))); rom.noteRead(snesToPc(e.addr), packed); }
  const auto = e.raw ? (e.size === 0x800 ? 2 : 4) : defaultBpp(num, data.length);
  return pixels(num, e.addr, e.raw, e.raw ? auto : bpp ?? auto, auto, packed, data);
}

function pixels(num: number, addr: number, raw: boolean, bpp: number, auto: number, packed: number, data: Uint8Array): GfxFile {
  const tiles = Math.max(1, Math.floor(data.length / (bpp * 8)));
  const pix = new Uint8Array(tiles * 64);
  for (let t = 0; t < tiles; t++) decodeTile(data, t * bpp * 8, bpp, pix, t * 64);
  return { num, addr, raw, bpp, auto, packed, pix, tiles, empty: false };
}

// writes the pixels back as `f` says (raw or LZ2, its bpp and tiles); f's place and size as stored follow
export function writeGfx(rom: Rom, f: GfxFile): void {
  const data = new Uint8Array(f.tiles * f.bpp * 8);
  for (let t = 0; t < f.tiles; t++) encodeTile(f.pix, t * 64, f.bpp, data, t * f.bpp * 8);
  const stored = f.raw ? data : lz2Compress(data);
  put(rom, f.num, stored, f.raw);
  f.addr = isAnimFile(f.num) ? altFileAddr(rom, f.num - ANIM_FILE) : gfxEntry(rom, f.num)!.addr;
  f.packed = stored.length;
  f.empty = false;
}

// an empty file under `num`, replacing one there: `size` bytes raw (0x1000 4bpp, 0x800 2bpp, 0x2000 a
// layer 3 tilemap); an Anim graphic is 128 tiles 4bpp
export function createGfx(rom: Rom, num: number, size = 0x1000): void {
  if (isAnimFile(num)) { writeAltFile(rom, num - ANIM_FILE, new Uint8Array(ANIM_SIZE)); return; }
  storeGfxFile(rom, num, gfxStorage(new Uint8Array(size)));
}

// removes the file under `num`, its place freed
export function removeGfx(rom: Rom, num: number): void {
  if (isAnimFile(num)) { writeAltFile(rom, num - ANIM_FILE, null); return; }
  const e = gfxEntry(rom, num);
  if (!e) return;
  rom.freeAt(e.addr);
  setGfxEntry(rom, num, 0, false);
}

// how a file is stored: raw (uncompressed) or LZ2, the bytes, its size unpacked; what: as told to the user
export interface GfxStorage { raw: boolean; stored: Uint8Array; size: number; what: string }

// LZ2 storage of unpacked data
export const lz2Storage = (data: Uint8Array, what: string): GfxStorage => ({ raw: false, stored: lz2Compress(data), size: data.length, what });

// the storage of a file by its data alone: 4 KB = raw 4bpp (DMA'd directly), 3 KB = 3bpp (packed with
// LZ2), otherwise LZ2 data as it is (like Lunar Magic's compressed ExGFX); throws for an unknown format
export function gfxStorage(data: Uint8Array): GfxStorage {
  // uncompressed: 4bpp; 2bpp layer 3 graphics and layer 3 tilemaps (layer3gfx.ts) stay so too
  const plain: Record<number, string> = { 0x1000: '4bpp', 0x800: '2bpp (layer 3)', 0x2000: 'layer 3 tilemap' };
  if (plain[data.length]) return { raw: true, stored: data, size: data.length, what: `${plain[data.length]} uncompressed` };
  if (data.length === GFX_3BPP) return lz2Storage(data, '3bpp, LZ2-compressed');
  let un: Uint8Array;
  try { un = lz2Decompress(data, 0).data; } catch { throw new Error(`Unknown GFX format (${data.length} bytes)`); }
  if (plain[un.length]) return { raw: true, stored: un, size: un.length, what: `${plain[un.length]} (decompressed)` };
  if (un.length === GFX_3BPP) return { raw: false, stored: data, size: GFX_3BPP, what: '3bpp, LZ2' };
  throw new Error(`Unknown GFX format (${data.length} bytes, decompressed ${un.length})`);
}

// a graphics file's data (4bpp/3bpp/2bpp or a layer 3 tilemap, plain or LZ2)
export const isGfxData = (data: Uint8Array) => [...RAW_GFX_SIZES, GFX_3BPP].includes(gfxDataSize(data));

// throws when `num` can't hold the file (gfxNumberProblem; one of the game's files may be replaced)
export function checkGfxNumber(num: number, s: GfxStorage): void {
  const bad = gfxNumberProblem(num, { game: true, size: s.size });
  if (bad) throw new Error(bad);
}

// stores a file under `num` (one of the game's replaced); what was stored
export function storeGfxFile(rom: Rom, num: number, s: GfxStorage): string {
  checkGfxNumber(num, s);
  put(rom, num, s.stored, s.raw);
  return s.what;
}

// stores a file under `num` by its data (gfxStorage); an Anim graphic takes uncompressed 4bpp tiles
// (up to 1023). The number must fit the file (gfxNumberProblem: also one of the game's files).
export function importGfxFile(rom: Rom, num: number, data: Uint8Array): string {
  if (!isAnimFile(num)) return storeGfxFile(rom, num, gfxStorage(data));
  if (!data.length || data.length % 32 || data.length > ALT_FILE_MAX) throw new Error('Animation graphic: an uncompressed 4bpp file of up to 1023 tiles is expected');
  writeAltFile(rom, num - ANIM_FILE, data);
  return '4bpp uncompressed';
}

// puts the stored bytes under `num`: in place when the file has this format and they fit its place,
// else into free space, the old place freed
function put(rom: Rom, num: number, stored: Uint8Array, raw: boolean): void {
  if (isAnimFile(num)) { writeAltFile(rom, num - ANIM_FILE, stored); return; }
  const e = gfxEntry(rom, num);
  if (e && e.raw === raw && stored.length <= room(rom, e) && (!raw || stored.length === e.size)) { rom.writeBytes(e.addr, stored); return; }
  if (e) rom.freeAt(e.addr);
  setGfxEntry(rom, num, rom.allocWrite(stored), raw, stored.length);
}

// the bytes a file's place in free space holds; 0 for the game's original files, which are never overwritten
function room(rom: Rom, e: GfxEntry): number {
  const pc = snesToPc(e.addr);
  return pc - 8 >= 0x80000 ? Math.max(0, rom.isRatsAt(pc - 8)) : 0;
}
