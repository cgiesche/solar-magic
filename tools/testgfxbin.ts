// GFX/ExGFX files as .bin (gfxbin.ts, gfxnames.ts): exported as Lunar Magic extracts them (unpacked,
// 3bpp as 4bpp), named GFX##.bin / ExGFX###_Name.bin, imported back byte-identical in the format the
// number had; several files or a .zip at once, planned (new, replaced, unchanged) and applied as one edit.
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { gfxEntry, VANILLA_GFX } from '../src/core/patches.ts';
import { importGfxFile } from '../src/core/map16file.ts';
import { lz2Compress } from '../src/core/lz2.ts';
import { savePackage, emptyParts } from '../src/core/pkgreg.ts';
import { gfxBinData, storeGfxBin, gfxBinName, parseGfxBinName, binFiles, planGfxBins, applyGfxBins, exportAllGfx } from '../src/core/gfxbin.ts';
import { gfxUserName as ownName, setGfxName, gfxLabel } from '../src/core/gfxnames.ts';
import { zipSync, unzipSync } from 'fflate';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const pattern = (n: number, seed: number) => { const d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = (i * seed + (i >> 5) + seed) & 0xff; return d; };

// the game's files: unpacked, 3bpp as 4bpp (Lunar Magic's Graphics folder), 2bpp as they are
{
  const rom = fresh();
  check(gfxBinData(rom, 0x00)?.length === 0x1000 && gfxBinData(rom, 0x30)?.length === 0x800, '3bpp files export as 4bpp (C00 → 1000, 600 → 800)');
  check(gfxBinData(rom, 0x28)?.length === 0x800 && gfxBinData(rom, 0x2f)?.length === 0x400, '2bpp files export as they are');
  check(gfxBinData(rom, 0x80) === null, 'an empty number exports nothing');
  const d = gfxBinData(rom, 0x14)!;
  check([...Array(0x80).keys()].every((t) => d.subarray(t * 32 + 16, t * 32 + 32).every((v, i) => i % 2 === 0 || v === 0)), 'the 4th bitplane of a converted 3bpp file is empty');
}

// every file re-imports byte-identical and keeps its format
{
  const rom = fresh();
  let ok = true, kept = true;
  for (let n = 0; n < VANILLA_GFX; n++) {
    const d = gfxBinData(rom, n)!, was = gfxEntry(rom, n)!;
    storeGfxBin(rom, n, d);
    ok &&= same(gfxBinData(rom, n), d);
    kept &&= gfxEntry(rom, n)!.raw === was.raw;
  }
  check(ok, 'GFX00–31: export → import → export is byte-identical');
  check(kept, 'GFX00–31 stay LZ2 (3bpp/2bpp) when the 4th bitplane stays empty');
  importGfxFile(rom, 0x80, pattern(0x1000, 3));
  importGfxFile(rom, 0xe00, pattern(0x800, 5));
  importGfxFile(rom, 0xe01, pattern(0x2000, 7));
  importGfxFile(rom, 0x81, pattern(0xc00, 9));
  importGfxFile(rom, 0x182, lz2Compress(pattern(0x1000, 11)));
  ok = true;
  for (const n of [0x80, 0xe00, 0xe01, 0x81, 0x182]) {
    const d = gfxBinData(rom, n)!;
    storeGfxBin(rom, n, d);
    ok &&= same(gfxBinData(rom, n), d);
  }
  check(ok, 'ExGFX (4bpp, 2bpp, tilemap, 3bpp, LZ2 4bpp) re-import byte-identical');
  check(!gfxEntry(rom, 0x81)!.raw && gfxEntry(rom, 0x80)!.raw, 'a 3bpp ExGFX stays 3bpp, a 4bpp one raw');
  // colors 8-15 drawn into a 3bpp file: kept (stored as 4bpp)
  const d = gfxBinData(rom, 0x14)!.slice();
  d[17] = 0xff;
  storeGfxBin(rom, 0x14, d);
  check(same(gfxBinData(rom, 0x14), d) && gfxEntry(rom, 0x14)!.raw, 'a 4bpp file with colors 8–15 into a 3bpp number: stored as 4bpp, nothing lost');
  // a 2F-sized file (400) into an empty number has no known format
  let refused = false;
  try { storeGfxBin(rom, 0x90, new Uint8Array(0x400)); } catch { refused = true; }
  check(refused && !gfxEntry(rom, 0x90), 'a file of unknown format into an empty number is refused');
}

// file names: GFX## / ExGFX# (no leading zero below 100), the name from the user, else the package
{
  const rom = fresh();
  importGfxFile(rom, 0x80, pattern(0x1000, 3));
  importGfxFile(rom, 0x123, pattern(0x1000, 4));
  check(gfxBinName(rom, 0x00) === 'GFX00.bin' && gfxBinName(rom, 0x2a) === 'GFX2A.bin', 'the game\'s files: GFX00.bin, GFX2A.bin');
  check(gfxBinName(rom, 0x80) === 'ExGFX80.bin' && gfxBinName(rom, 0x123) === 'ExGFX123.bin', 'ExGFX80.bin, ExGFX123.bin');
  savePackage(rom, { ...emptyParts(), gfx: [0x80], id: 'p1', name: 'Boo Ring', fileName: 'Boo Ring.zip', added: '2026-10-20' });
  check(gfxLabel(rom, 0x80) === 'Boo Ring' && gfxBinName(rom, 0x80) === 'ExGFX80_Boo Ring.bin', 'a package\'s file is named after the package');
  setGfxName(rom, 0x80, 'Ghost: house?');
  check(ownName(rom, 0x80) === 'Ghost: house?' && gfxBinName(rom, 0x80) === 'ExGFX80_Ghost house.bin', 'the user\'s name wins; characters a file name can\'t hold are left out');
  setGfxName(rom, 0x00, 'Ground');
  check(gfxBinName(rom, 0x00) === 'GFX00_Ground.bin', 'the game\'s files can be named too');
  setGfxName(rom, 0x80, '');
  check(ownName(rom, 0x80) === null && gfxBinName(rom, 0x80) === 'ExGFX80_Boo Ring.bin', 'an empty name removes it');
}

// names read back: plain and descriptive, in folders
{
  const p = (s: string) => JSON.stringify(parseGfxBinName(s));
  check(p('GFX00.bin') === JSON.stringify({ num: 0, game: true, name: '' }), 'GFX00.bin');
  check(p('Graphics/GFX1A.bin') === JSON.stringify({ num: 0x1a, game: true, name: '' }), 'Graphics/GFX1A.bin');
  check(p('ExGraphics/ExGFX100_Forest.bin') === JSON.stringify({ num: 0x100, game: false, name: 'Forest' }), 'ExGFX100_Forest.bin');
  check(p('exgfx80 Bush.BIN') === JSON.stringify({ num: 0x80, game: false, name: 'Bush' }), 'exgfx80 Bush.BIN (case, space)');
  check(parseGfxBinName('AllGFX.bin') === null && parseGfxBinName('ExGFX80.png') === null && parseGfxBinName('readme.txt') === null, 'no number, no .bin: not a GFX file');
}

// export all: Lunar Magic's folders; importing it back changes nothing
{
  const rom = fresh();
  importGfxFile(rom, 0x80, pattern(0x1000, 3));
  setGfxName(rom, 0x80, 'Bush');
  const zip = unzipSync(exportAllGfx(rom));
  const names = Object.keys(zip);
  check(names.filter((n) => n.startsWith('Graphics/')).length === VANILLA_GFX && names.includes('Graphics/GFX00.bin') && names.includes('Graphics/GFX31.bin'), 'Graphics/GFX00.bin … GFX31.bin');
  check(names.includes('ExGraphics/ExGFX80_Bush.bin') && names.length === VANILLA_GFX + 1, 'ExGraphics/ExGFX80_Bush.bin');
  const plan = planGfxBins(rom, binFiles('all.zip', exportAllGfx(rom)));
  check(plan.length === VANILLA_GFX + 1 && plan.every((x) => x.status === 'unchanged'), 'the whole .zip back: all unchanged');
}

// a bulk import: planned, then applied as one undo step
{
  const rom = fresh();
  importGfxFile(rom, 0x80, pattern(0x1000, 3));
  const s = new RomEditSession(rom);
  const changed = gfxBinData(rom, 0x80)!.slice(); changed[0] ^= 0xff;
  const zip = zipSync({ 'ExGraphics/ExGFX81_New.bin': pattern(0x1000, 5), 'ExGraphics/ExGFX80.bin': changed, 'Graphics/GFX00.bin': gfxBinData(rom, 0)!, 'readme.txt': new Uint8Array(3) });
  const files = [...binFiles('pack.zip', zip), { path: 'ExGFX81.bin', data: pattern(0x1000, 6) }, { path: 'ExGFX90.bin', data: new Uint8Array(7) }, { path: 'GFX32.bin', data: new Uint8Array(0x1000) }, { path: 'ExGFX12.bin', data: new Uint8Array(0x1000) }];
  check(files.length === 7, 'only the .bin files of a .zip are taken');
  const plan = planGfxBins(rom, files);
  const st = (path: string) => plan.find((x) => x.path === path)!;
  check(st('ExGraphics/ExGFX81_New.bin').status === 'new' && st('ExGraphics/ExGFX80.bin').status === 'replace' && st('Graphics/GFX00.bin').status === 'unchanged', 'new, replaced, unchanged');
  check(st('ExGFX81.bin').status === 'skip' && /ExGFX81_New/.test(st('ExGFX81.bin').why ?? ''), 'a second file for the same number is skipped');
  check(st('ExGFX90.bin').status === 'skip' && st('GFX32.bin').status === 'skip' && st('ExGFX12.bin').status === 'skip', 'unknown format, GFX32 (not one of the game\'s files here), ExGFX12 (a game file\'s number): skipped, with a reason');
  const before = rom.data.slice();
  const n = s.edit('Import graphics', () => applyGfxBins(rom, plan));
  check(n === 2 && same(gfxBinData(rom, 0x81), pattern(0x1000, 5)) && same(gfxBinData(rom, 0x80), changed) && ownName(rom, 0x81) === 'New', 'applied: the new and the replaced file, the name from the file name');
  check(s.history.undoStack.length === 1, 'one undo step');
  s.undo();
  check(same(rom.data, before), 'undo reverts all of it');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
