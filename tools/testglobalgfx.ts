// Global GFX files as a graphics part (globalgfx.ts, pkgplan.ts): the Romhack Races baserom's
// workspace/Graphics/GFX00–33.bin, Lunar Magic's export (3bpp files as 4bpp). Only the files differing
// from the clean game's are the package's – a file whose only difference is the 4th bitplane Lunar Magic
// leaves in a 3bpp file's .bin is the clean game's. They replace the game's file (GFX33, the animated
// tiles, by the game's loader at $00:B888, which shares its bank with GFX32); removed, the game's files
// are as before. resources/original_graphics/ (the baserom's backup copy) is not part of the package, and
// no GFX##.bin becomes an ExGFX file. A second package changing one of them is a conflict; a file changed
// since the package was installed is reported and left as it is when the package is removed.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { convertBpp } from '../src/core/gfxbin.ts';
import { GLOBAL_GFX, GFX32, GFX33, cleanGlobalGfx, globalGfxData, setGlobalGfx, fromBin, globalGfxNum } from '../src/core/globalgfx.ts';
import { inspectUpload, installPackage, removePackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages, packageRemoval, packageSummary } from '../src/core/pkgreg.ts';
import { cleanImage, editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

const ZIP = new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'));
const zip = unzipSync(ZIP);
const bin = (n: number, dir = 'workspace/Graphics') => zip[`${dir}/GFX${hx(n)}.bin`];
// the files the baserom changes: the readme's edited and remapped graphics and GFX33, and five more with a
// few tiles changed (02, 09, 28, 31) – GFX17 differs only in its .bin's 4th bitplane
const EDITED = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0d, 0x0e, 0x13, 0x14, 0x16, 0x1e, 0x28, 0x2a, 0x2b, 0x31, 0x33];

async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  return { rom, opt: { level: 0x105, blank, tileWords: () => blank, setup: false } };
}
const upload = (name: string, files: Record<string, Uint8Array>) => ready(inspectUpload(`${name}.zip`, zipSync(files)));
// the animated tiles as the game puts them into RAM ($7E7D00, GFX33 as 4bpp)
const animRam = (rom: Rom) => new LevelEmulator(rom).load(0x105).wram.slice(0x7d00, 0x7d00 + 0x3000);

// ---------- the files and the clean game's ----------

{
  const { rom } = await target();
  check(Array.from({ length: GLOBAL_GFX }, (_, n) => n).every((n) => same(cleanGlobalGfx(rom, n), globalGfxData(rom, n))), 'the clean game\'s GFX00–33 known in the editor\'s ROM (its own files still the same)');
  check(cleanGlobalGfx(new Rom(cleanImage()), 0x14)?.length === 0xc00, 'and in the clean game itself');
  check(cleanGlobalGfx(rom, GFX33)?.length === 0x2400 && cleanGlobalGfx(rom, GFX32)?.length === 0x5d00, 'GFX32 and GFX33 known (Mario 4bpp, the animated tiles 3bpp)');
  const differ = Array.from({ length: GLOBAL_GFX }, (_, n) => n).filter((n) => !same(fromBin(cleanGlobalGfx(rom, n)!, bin(n)), cleanGlobalGfx(rom, n)));
  check(differ.join() === EDITED.join(), `the baserom's .bin files differing from the clean game: ${differ.map(hx).join(', ')}`);
  check(same(fromBin(cleanGlobalGfx(rom, 0x27)!, bin(0x27)), cleanGlobalGfx(rom, 0x27)), 'GFX27, exported as 3bpp, read as it is');
  check(globalGfxNum('workspace/Graphics/GFX33.bin') === 0x33 && globalGfxNum('ExGraphics/ExGFX33.bin') === null && globalGfxNum('GFX80.bin') === null, 'GFX00–33 by their names');
}

// ---------- setting a file and setting it back ----------

{
  const { rom } = await target();
  const before = rom.data.slice(), ram = animRam(rom);
  const g01 = fromBin(cleanGlobalGfx(rom, 1)!, bin(1))!;
  setGlobalGfx(rom, 1, g01);
  check(same(globalGfxData(rom, 1), g01), 'GFX01 replaced');
  const g33 = fromBin(cleanGlobalGfx(rom, GFX33)!, bin(GFX33))!;
  setGlobalGfx(rom, GFX33, g33);
  check(same(globalGfxData(rom, GFX33), g33) && same(globalGfxData(rom, GFX32), cleanGlobalGfx(rom, GFX32)), 'GFX33 replaced, GFX32 still the clean game\'s');
  const ram2 = animRam(rom);
  check(!same(ram, ram2) && same(ram2, convertBpp(g33, 3, 4)), 'the game puts the new GFX33 into RAM');
  setGlobalGfx(rom, 1, cleanGlobalGfx(rom, 1)!);
  setGlobalGfx(rom, GFX33, cleanGlobalGfx(rom, GFX33)!);
  check(romDiff(before, rom.data) === 0, `set back: the ROM as before (${romDiff(before, rom.data)} bytes differ)`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
