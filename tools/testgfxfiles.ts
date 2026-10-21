// Graphics files (gfxfiles.ts): read as pixels, written back in their format – an LZ2 file that no
// longer fits its place moves to free space and frees the old one, a raw file stays raw and in place –,
// created and imported; the Anim graphics A–D behind the same interface.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { gfxEntry } from '../src/core/patches.ts';
import { readAltFile } from '../src/core/exanim.ts';
import { readGfx, writeGfx, gfxBytes, hasGfx, createGfx, importGfxFile, removeGfx, isGfxData, ANIM_FILE } from '../src/core/gfxfiles.ts';
import { lz2Compress } from '../src/core/lz2.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const rats = (rom: Rom, addr: number) => rom.isRatsAt(snesToPc(addr) - 8);
const noise = (pix: Uint8Array, colors: number) => { let s = 12345; for (let i = 0; i < pix.length; i++) { s = (s * 1103515245 + 12345) >>> 0; pix[i] = (s >>> 16) % colors; } };

// an LZ2 file edited past its place: moved to free space, the old place freed
{
  const rom = fresh();
  importGfxFile(rom, 0x80, new Uint8Array(0xc00)); // 3bpp, all zero: packs small
  importGfxFile(rom, 0x90, new Uint8Array(0x1000)); // behind it: its place can't grow
  const before = gfxEntry(rom, 0x80)!, blocks = rom.scanRats().length;
  const f = readGfx(rom, 0x80);
  check(!f.raw && f.bpp === 3 && f.tiles === 128, 'an empty 3bpp file reads as 128 tiles of LZ2 3bpp');
  noise(f.pix, 8);
  writeGfx(rom, f);
  const after = gfxEntry(rom, 0x80)!;
  check(!after.raw && after.addr !== before.addr && f.addr === after.addr, 'the larger LZ2 data moved elsewhere (the file told where)');
  check(rats(rom, before.addr) < 0 && rom.scanRats().length === blocks, 'the old place is free');
  check(readGfx(rom, 0x80).pix.every((v, i) => v === f.pix[i]), 'the pixels read back');
  // a smaller edit stays in place
  f.pix.fill(0, 0, 64);
  writeGfx(rom, f);
  check(gfxEntry(rom, 0x80)!.addr === after.addr, 'an edit that fits stays in place');
}

// one of the game's files (LZ2, not in free space): moved by any edit, even one that would fit, the game's data kept
{
  const rom = fresh();
  const was = gfxEntry(rom, 0x14)!, old = rom.bytes(was.addr, 16).slice();
  const f = readGfx(rom, 0x14);
  f.pix[0] = 0;
  writeGfx(rom, f);
  const e = gfxEntry(rom, 0x14)!;
  check(!e.raw && e.addr !== was.addr && rats(rom, e.addr) > 0 && rom.bytes(was.addr, 16).every((v, i) => v === old[i]), 'GFX14: moved into free space, the original bytes untouched');
  writeGfx(rom, f);
  check(gfxEntry(rom, 0x14)!.addr === e.addr, 'then edited in its new place');
}

// a raw file stays raw, in place
{
  const rom = fresh();
  importGfxFile(rom, 0x81, new Uint8Array(0x1000));
  const was = gfxEntry(rom, 0x81)!;
  const f = readGfx(rom, 0x81);
  noise(f.pix, 16);
  writeGfx(rom, f);
  const e = gfxEntry(rom, 0x81)!;
  check(e.raw && e.size === 0x1000 && e.addr === was.addr, 'a 4bpp raw file stays raw, in place');
  check(readGfx(rom, 0x81).pix.every((v, i) => v === f.pix[i]), 'its pixels read back');
  importGfxFile(rom, 0xe00, new Uint8Array(0x800));
  const lg = readGfx(rom, 0xe00);
  check(lg.raw && lg.bpp === 2 && lg.tiles === 128, 'a 2bpp raw file reads as 2bpp');
  noise(lg.pix, 4);
  writeGfx(rom, lg);
  check(gfxEntry(rom, 0xe00)!.raw && gfxEntry(rom, 0xe00)!.size === 0x800, 'and stays 2bpp raw');
}

// a raw file written again in another format (an image imported as LZ2): replaced, the old place freed
{
  const rom = fresh();
  importGfxFile(rom, 0x82, new Uint8Array(0x1000));
  const blocks = rom.scanRats().length;
  const f = readGfx(rom, 0x82);
  writeGfx(rom, { ...f, raw: false, bpp: 3 });
  check(!gfxEntry(rom, 0x82)!.raw && rom.scanRats().length === blocks && gfxBytes(rom, 0x82)!.data.length === 0xc00, 'raw → LZ2 3bpp: stored anew, the old place freed');
}

// the Anim graphics: created, drawn, imported, read like any file
{
  const rom = fresh();
  const b = ANIM_FILE + 1;
  check(!hasGfx(rom, b) && readGfx(rom, b).empty, 'Anim graphic B: none yet');
  createGfx(rom, b);
  check(hasGfx(rom, b) && readAltFile(rom, 1)?.length === 0x1000, 'created: 128 empty 4bpp tiles');
  const f = readGfx(rom, b);
  check(f.raw && f.bpp === 4 && f.tiles === 128 && !f.empty, 'it reads as 4bpp');
  noise(f.pix, 16);
  writeGfx(rom, f);
  check(readGfx(rom, b).pix.every((v, i) => v === f.pix[i]) && gfxEntry(rom, 0x61) === null, 'drawn into it: read back, no ExGFX touched');
  const d = new Uint8Array(0x200).fill(7);
  importGfxFile(rom, b, d);
  check(gfxBytes(rom, b)!.data.length === 0x200 && readGfx(rom, b).tiles === 16, 'a .bin imported into it: 16 tiles');
  let refused = false;
  try { importGfxFile(rom, b, new Uint8Array(0x101)); } catch { refused = true; }
  check(refused && gfxBytes(rom, b)!.data.length === 0x200, 'not 4bpp tiles: refused, unchanged');
  removeGfx(rom, b);
  check(!hasGfx(rom, b), 'removed');
}

// created empty, removed, recognized
{
  const rom = fresh();
  createGfx(rom, 0xe01, 0x2000);
  check(gfxEntry(rom, 0xe01)?.raw === true && gfxEntry(rom, 0xe01)?.size === 0x2000, 'an empty layer 3 tilemap file created raw');
  const addr = gfxEntry(rom, 0xe01)!.addr;
  removeGfx(rom, 0xe01);
  check(!hasGfx(rom, 0xe01) && rats(rom, addr) < 0, 'removed, its place freed');
  check(isGfxData(new Uint8Array(0x1000)) && isGfxData(lz2Compress(new Uint8Array(0xc00))) && !isGfxData(new Uint8Array(0x123)), 'graphics data recognized (plain and LZ2)');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
