// GFX/ExGFX files as .bin, as Lunar Magic extracts and inserts them (LM help: file_extract_gfx.htm,
// file_extract_exgfx.htm, file_insert_exgfx.htm): unpacked, 3bpp files as 4bpp (the 4th bitplane empty),
// named GFX##.bin / ExGFX#.bin (no leading zero below 100) with a descriptive name after it (LM changes,
// 3.70), in the folders Graphics/ and ExGraphics/. A file goes back in the format its number has, so
// export → import → export is byte-identical and the game's files stay 3bpp. Several files (or a .zip)
// are planned first – new, replaced, unchanged, skipped – then applied together.

import { unzipSync, zipSync } from 'fflate';
import { Rom } from './rom.ts';
import { decodeTile, encodeTile } from './gfx.ts';
import { gfxHex, gfxNumberProblem, VANILLA_GFX, GFX_FILES } from './patches.ts';
import { gfxBytes, gfxStorage, lz2Storage, storeGfxFile, checkGfxNumber, defaultBpp, type GfxStorage } from './gfxfiles.ts';
import { gfxLabels, setGfxNames } from './gfxnames.ts';

// the tiles of `data` from one bpp to another (to 3bpp: the 4th bitplane dropped)
export function convertBpp(data: Uint8Array, from: number, to: number): Uint8Array {
  const tiles = data.length / (from * 8), pix = new Uint8Array(64), out = new Uint8Array(tiles * to * 8);
  for (let t = 0; t < tiles; t++) { decodeTile(data, t * from * 8, from, pix); encodeTile(pix, 0, to, out, t * to * 8); }
  return out;
}

// 4bpp data that only uses colors 0-7
function only3bpp(d: Uint8Array): boolean {
  for (let i = 17; i < d.length; i += 32) for (let y = 0; y < 16; y += 2) if (d[i + y]) return false;
  return true;
}

// the file as .bin (null: no file under the number)
export function gfxBinData(rom: Rom, num: number): Uint8Array | null {
  const f = gfxBytes(rom, num);
  if (!f) return null;
  return !f.raw && defaultBpp(num, f.data.length) === 3 ? convertBpp(f.data, 3, 4) : f.data;
}

// how a .bin goes under `num`: in the format the number's file has (an LZ2 file of the same size; a 3bpp
// file's 4bpp form back to 3bpp when its 4th bitplane is empty), else by the data (gfxStorage)
function binStorage(rom: Rom, num: number, data: Uint8Array): GfxStorage {
  const f = gfxBytes(rom, num);
  if (f && !f.raw) {
    if (data.length === f.data.length) return lz2Storage(data, 'LZ2, as before');
    if (defaultBpp(num, f.data.length) === 3 && data.length === (f.data.length / 3) * 4 && only3bpp(data)) {
      return lz2Storage(convertBpp(data, 4, 3), '3bpp, as before');
    }
  }
  return gfxStorage(data);
}

// stores a .bin under `num`; what it was stored as. Throws for a format unknown there or a bad number.
export function storeGfxBin(rom: Rom, num: number, data: Uint8Array): string {
  return storeGfxFile(rom, num, binStorage(rom, num, data));
}

// a name as part of a file name: without characters file systems refuse
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');

// the file name: GFX## for the game's files, ExGFX# for the others, then _Name when one is known
// (Lunar Magic's descriptive names are the ExGFX's; label: gfxLabels, when naming many)
export function gfxBinName(rom: Rom, num: number, label = gfxLabels(rom)): string {
  if (num < VANILLA_GFX) return `GFX${gfxHex(num)}.bin`;
  const name = fileSafe(label(num) ?? '');
  return `ExGFX${gfxHex(num)}${name ? `_${name}` : ''}.bin`;
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

// number and descriptive name from a file name (also in a folder); game: GFX## (one of the game's
// files), else ExGFX; null: not a numbered .bin. A third hex digit followed by a lowercase letter starts
// the name (ExGFX80Forest: 80, "Forest"; ExGFX10ADesert: 10A); a slot suffix of a package's file (ExGFX80_BG2) is no name.
export function parseGfxBinName(path: string): { num: number; game: boolean; name: string } | null {
  const m = /^(ex)?gfx([0-9a-f]{1,3})(.*)\.bin$/i.exec(baseName(path));
  if (!m) return null;
  let [digits, rest] = [m[2], m[3]];
  if (digits.length === 3 && /^[a-f]/i.test(digits[2]) && /^[a-z]/.test(rest)) [digits, rest] = [digits.slice(0, 2), digits[2] + rest];
  const name = rest.replace(/^[\s_-]+/, '').trim();
  return { num: parseInt(digits, 16), game: !m[1], name: /^(BG[1-3]|FG[1-3]|SP[1-4])$/i.test(name) ? '' : name };
}

export interface BinFile { path: string; data: Uint8Array }

// the files of an upload: a .zip's .bin files (in any folder), else the file itself
export function binFiles(path: string, data: Uint8Array): BinFile[] {
  const zip = /\.zip$/i.test(path) || (data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4);
  if (!zip) return [{ path, data }];
  return Object.entries(unzipSync(data))
    .filter(([p]) => /\.bin$/i.test(p) && !p.startsWith('__MACOSX/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, d]) => ({ path: p, data: d }));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export type BinStatus = 'new' | 'replace' | 'unchanged' | 'skip';
export interface BinPlanItem extends BinFile { num: number | null; name: string; status: BinStatus; why?: string }

// what importing the files would do, each to the number in its name (the first file for a number wins)
export function planGfxBins(rom: Rom, files: BinFile[]): BinPlanItem[] {
  const seen = new Map<number, string>();
  return files.map((f) => {
    const p = parseGfxBinName(f.path);
    const skip = (why: string): BinPlanItem => ({ ...f, num: p?.num ?? null, name: p?.name ?? '', status: 'skip', why });
    if (!p) return skip('No GFX## or ExGFX### number in the file name');
    if (p.game && p.num >= VANILLA_GFX) return skip(`GFX${gfxHex(p.num)} is none of the game's files 00–${gfxHex(VANILLA_GFX - 1)}`);
    const bad = p.game ? null : gfxNumberProblem(p.num);
    if (bad) return skip(bad);
    if (seen.has(p.num)) return skip(`Same number as ${baseName(seen.get(p.num)!)}`);
    try { checkGfxNumber(p.num, binStorage(rom, p.num, f.data)); } catch (e) { return skip(e instanceof Error ? e.message : String(e)); }
    seen.set(p.num, f.path);
    const cur = gfxBinData(rom, p.num);
    const status: BinStatus = !cur ? 'new' : sameBytes(cur, f.data) ? 'unchanged' : 'replace';
    return { ...f, num: p.num, name: p.name, status };
  });
}

// writes the new and replaced files of a plan (and their descriptive names); how many
export function applyGfxBins(rom: Rom, plan: BinPlanItem[]): number {
  const names = new Map<number, string>();
  let n = 0;
  for (const x of plan) {
    if ((x.status !== 'new' && x.status !== 'replace') || x.num === null) continue;
    storeGfxBin(rom, x.num, x.data);
    if (x.name && x.num >= VANILLA_GFX) names.set(x.num, x.name);
    n++;
  }
  if (names.size) setGfxNames(rom, names);
  return n;
}

// all files as a .zip in Lunar Magic's folders: Graphics/GFX##.bin, ExGraphics/ExGFX#.bin
export function exportAllGfx(rom: Rom): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const label = gfxLabels(rom);
  for (let n = 0; n < GFX_FILES; n++) {
    const d = gfxBinData(rom, n);
    if (d) files[`${n < VANILLA_GFX ? 'Graphics' : 'ExGraphics'}/${gfxBinName(rom, n, label)}`] = d;
  }
  return zipSync(files);
}
