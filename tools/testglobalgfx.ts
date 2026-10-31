// Global GFX files as a graphics part (globalgfx.ts, pkgplan.ts): the Romhack Races baserom's
// workspace/Graphics/GFX00–33.bin, Lunar Magic's export (3bpp files as 4bpp). Only the files differing
// from the clean game's are the package's – a file whose only difference is the 4th bitplane as the game's
// upload sets it (GFX17: tiles in colors 8–F) is the clean game's. A file using colors 8–F of its own
// (Lunar Magic's 4bpp GFX: GFX01's donut lift, GFX08) is kept 4bpp: the game uploads it as it is, its
// other code reading the file gets it as 3bpp, GFX31 still replaces half of GFX01 after the special world. They replace the game's file (GFX33, the animated
// tiles, by the game's loader at $00:B888, which shares its bank with GFX32); removed, the game's files
// are as before. resources/original_graphics/ (the baserom's backup copy) is not part of the package, and
// no GFX##.bin becomes an ExGFX file. A second package changing one of them is a conflict; a file changed
// since the package was installed is reported and left as it is when the package is removed.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { Snes } from '../src/core/snes.ts';
import { GFX_BUFFER } from '../src/core/ram.ts';
import { gfxEntry } from '../src/core/patches.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { convertBpp } from '../src/core/gfxbin.ts';
import { decodeTile } from '../src/core/gfx.ts';
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
// the game's routine at `at` (bank 0; ret: its return, RTS or RTL) called with Y = `y`, after `setup`
function call(rom: Rom, at: number, ret: 'rts' | 'rtl', y: number, setup = (_s: Snes) => {}): Snes {
  const s = new Snes(rom.data), cpu = s.cpu, w = s.wram, end = 0x1f00;
  if (ret === 'rtl') w.set([(end - 1) & 0xff, (end - 1) >> 8, 0], 0x1fd); else w.set([(end - 1) & 0xff, (end - 1) >> 8], 0x1fe);
  s.write(0x2115, 0x80); s.write(0x2116, 0); s.write(0x2117, 0);
  setup(s);
  cpu.e = false; cpu.p = 0x34; cpu.s = ret === 'rtl' ? 0x1fc : 0x1fd; cpu.d = 0; cpu.dbr = 0; cpu.pbr = 0; cpu.pc = at; cpu.y = y;
  for (let n = 0; n < 2_000_000 && !(cpu.pbr === 0 && cpu.pc === end); n++) cpu.step();
  if (cpu.pc !== end) throw new Error(`$${at.toString(16)} did not return`);
  return s;
}
// the file as the game's code reading it gets it ($00BA28: 3bpp in its buffer)
const read3bpp = (rom: Rom, n: number) => call(rom, 0x00ba28, 'rtl', n).wram.slice(GFX_BUFFER, GFX_BUFFER + 0xc00);
// the file as the game uploads it to VRAM ($00AA6B; sw: the special world passed, $1EEB bit 7)
const uploaded = (rom: Rom, n: number, sw = false) => call(rom, 0x00aa6b, 'rts', n, (s) => { s.wram[0x1eeb] = sw ? 0x80 : 0; }).vram.slice(0, 0x1000);
const fourBpp = [0x01, 0x08]; // the baserom's files using colors 8–F of their own

// ---------- the files and the clean game's ----------

{
  const { rom } = await target();
  check(Array.from({ length: GLOBAL_GFX }, (_, n) => n).every((n) => same(cleanGlobalGfx(rom, n), globalGfxData(rom, n))), 'the clean game\'s GFX00–33 known in the editor\'s ROM (its own files still the same)');
  check(cleanGlobalGfx(new Rom(cleanImage()), 0x14)?.length === 0xc00, 'and in the clean game itself');
  check(cleanGlobalGfx(rom, GFX33)?.length === 0x2400 && cleanGlobalGfx(rom, GFX32)?.length === 0x5d00, 'GFX32 and GFX33 known (Mario 4bpp, the animated tiles 3bpp)');
  const files = Array.from({ length: GLOBAL_GFX }, (_, n) => fromBin(rom, n, cleanGlobalGfx(rom, n)!, bin(n)));
  const differ = files.flatMap((f, n) => (same(f, cleanGlobalGfx(rom, n)) ? [] : [n]));
  check(differ.join() === EDITED.join(), `the baserom's .bin files differing from the clean game: ${differ.map(hx).join(', ')}`);
  const wide = files.flatMap((f, n) => (f!.length * 3 === cleanGlobalGfx(rom, n)!.length * 4 ? [n] : []));
  check(wide.join() === fourBpp.join(), `kept 4bpp, using colors 8–F of their own: ${wide.map(hx).join(', ')}`);
  check(same(files[0x01], bin(0x01)) && same(files[0x08], bin(0x08)), '… as the .bin has them');
  check(same(files[0x17], cleanGlobalGfx(rom, 0x17)) && files[0x1e]!.length === 0xc00, 'GFX17 and GFX1E: their 4th bitplane is the game\'s (3bpp)');
  check(same(files[0x31], convertBpp(bin(0x31), 4, 3)) && files[GFX33]!.length === 0x2400, 'GFX31 and GFX33 (fewer than 128 tiles) stay 3bpp');
  check(same(fromBin(rom, 0x27, cleanGlobalGfx(rom, 0x27)!, bin(0x27)), cleanGlobalGfx(rom, 0x27)), 'GFX27, exported as 3bpp, read as it is');
  check(globalGfxNum('workspace/Graphics/GFX33.bin') === 0x33 && globalGfxNum('ExGraphics/ExGFX33.bin') === null && globalGfxNum('GFX80.bin') === null, 'GFX00–33 by their names');
}

// ---------- setting a file and setting it back ----------

{
  const { rom } = await target();
  const before = rom.data.slice(), ram = animRam(rom);
  const g01 = fromBin(rom, 1, cleanGlobalGfx(rom, 1)!, bin(1))!;
  setGlobalGfx(rom, 1, g01);
  check(same(globalGfxData(rom, 1), g01) && gfxEntry(rom, 1)!.raw, 'GFX01 replaced, stored raw 4bpp');
  const g33 = fromBin(rom, GFX33, cleanGlobalGfx(rom, GFX33)!, bin(GFX33))!;
  setGlobalGfx(rom, GFX33, g33);
  check(same(globalGfxData(rom, GFX33), g33) && same(globalGfxData(rom, GFX32), cleanGlobalGfx(rom, GFX32)), 'GFX33 replaced, GFX32 still the clean game\'s');
  const ram2 = animRam(rom);
  check(!same(ram, ram2) && same(ram2, convertBpp(g33, 3, 4)), 'the game puts the new GFX33 into RAM');
  setGlobalGfx(rom, 1, cleanGlobalGfx(rom, 1)!);
  setGlobalGfx(rom, GFX33, cleanGlobalGfx(rom, GFX33)!);
  check(romDiff(before, rom.data) === 0, `set back: the ROM as before (${romDiff(before, rom.data)} bytes differ)`);
}

// ---------- a file using colors 8–F in the game ----------

// the colors of a 4bpp tile (not 0, transparent)
const colors = (d: Uint8Array, t: number) => { const pix = new Uint8Array(64); decodeTile(d, t * 32, 4, pix); return [...new Set(pix)].filter((c) => c).sort((a, b) => a - b); };
{
  const { rom } = await target();
  const clean = new Rom(await editorImage());
  check(colors(uploaded(clean, 1), 0).some((c) => c >= 8), 'the clean game puts some of GFX01\'s tiles in colors 8–F itself');
  setGlobalGfx(rom, 1, bin(1));
  const up = uploaded(rom, 1);
  check(same(up, bin(1)), 'the game uploads the 4bpp GFX01 as it is');
  // the donut lift (PIXI donut_sprite, tile $C2 = GFX01's tile 42): red-orange in Lunar Magic, palette 9
  check(colors(up, 0x42).join() === '1,10,13,14,15', `its donut lift in colors ${colors(up, 0x42).join(' ')}`);
  check(same(read3bpp(rom, 1), convertBpp(bin(1), 4, 3)), 'the game\'s code reading the file ($00BA28) gets it as 3bpp');
  check(same(read3bpp(rom, 2), cleanGlobalGfx(rom, 2)), '… an LZ2 file as before');
  const sw = uploaded(rom, 1, true), swClean = uploaded(clean, 1, true);
  check(same(sw.subarray(0, 0x800), swClean.subarray(0, 0x800)) && !same(swClean.subarray(0, 0x800), uploaded(clean, 1).subarray(0, 0x800)), 'after the special world GFX31 replaces its first half, as in the clean game');
  check(same(sw.subarray(0x800), convertBpp(convertBpp(bin(1), 4, 3), 3, 4).subarray(0x800)), '… the rest GFX01\'s tiles (3bpp, as the game converts it)');
  setGlobalGfx(rom, 8, bin(8));
  check(same(uploaded(rom, 8), bin(8)), 'GFX08 uploaded as it is too');
}

// ---------- the package ----------

const GFX = (n: number) => `GFX${hx(n)}`;
{
  // the whole baserom (a Callisto project): the files of workspace/Graphics/ (next to its output ROM)
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', ZIP));
  const global = p.parts.filter((x) => x.kind === 'graphics' && x.type === 'globalgfx').map((x) => x.file);
  check(global.length === GLOBAL_GFX && global.every((f) => f.startsWith('workspace/Graphics/')), `the baserom brings workspace/Graphics/GFX00–33 (${global.length} files)`);
  check(!p.parts.some((x) => x.kind === 'graphics' && /(^|\/)GFX[0-9A-F]{2}\.bin$/i.test(x.file) && x.type !== 'globalgfx'), 'no GFX##.bin becomes an ExGFX file');
  check(!p.parts.some((x) => x.file.startsWith('resources/original_graphics/')), 'resources/original_graphics/ is not part of the package');
  const { rom, opt } = await target();
  const plan = planUpload(rom, p, opt.blank);
  check(plan.globalGfx.map((g) => g.num).join() === EDITED.join(), `planned: the files differing from the clean game (${plan.globalGfx.map((g) => hx(g.num)).join(', ')})`);
  check(plan.notes.some((n) => n.includes('GFX17') && n.includes('GFX32') && /clean game's/.test(n)), 'the others noted as the clean game\'s');
}

// the baserom's Graphics folder as a package of its own
const graphicsUpload = (name: string) => upload(name, Object.fromEntries(Array.from({ length: GLOBAL_GFX }, (_, n) => [`Graphics/${GFX(n)}.bin`, bin(n)])));
// SP2 (GFX01) in VRAM
const tiles01 = (rom: Rom) => new LevelEmulator(rom).load(0x105).vram.slice(0xd000, 0xe000);
{
  const p = graphicsUpload('baserom-graphics');
  const { rom, opt } = await target();
  const before = rom.data.slice(), vram = tiles01(rom);
  const r = await installPackage(rom, p, opt);
  check(r.ok, `installed ${r.errors.join(' ')}`);
  const plan = planUpload(new Rom(await editorImage()), p, opt.blank);
  check(plan.globalGfx.every((g) => same(globalGfxData(rom, g.num), g.data)), 'its files are in the ROM');
  check(Array.from({ length: GLOBAL_GFX }, (_, n) => n).filter((n) => !EDITED.includes(n)).every((n) => same(globalGfxData(rom, n), cleanGlobalGfx(rom, n))), 'the others are the clean game\'s');
  // the poison mushroom: in GFX01 (SP2), loaded by every level
  const g01 = plan.globalGfx.find((g) => g.num === 1)!.data, vram2 = tiles01(rom);
  check(!same(vram, vram2) && same(vram2, g01), 'the game loads the baserom\'s GFX01 (the poison mushroom, the donut lift in colors 8–F) into VRAM');
  const pkg = listPackages(rom)[0];
  check(packageSummary(pkg).some((s) => s.startsWith('Global GFX (GFX00, GFX01')), `the package names them: ${packageSummary(pkg).join(', ')}`);
  check(packageRemoval(pkg).some((s) => s.includes('GFX33') && /clean game's/.test(s)), `removal says so: ${packageRemoval(pkg).join('; ')}`);

  // a second package changing one of them
  const other = cleanGlobalGfx(rom, 0x14)!.slice(); other[0] ^= 0xff;
  const r2 = await installPackage(rom, upload('other-gfx', { 'GFX14.bin': convertBpp(other, 3, 4), 'GFX15.bin': bin(0x15) }), opt);
  check(!r2.ok && r2.errors.some((e) => /conflict/i.test(e) && e.includes('baserom-graphics') && e.includes('GFX14')), `a second package changing one: conflict (${r2.errors.join(' ')})`);
  check(listPackages(rom).length === 1, 'not installed');

  const warnings = await removePackage(rom, pkg.id, opt.blank);
  check(!warnings.length && !listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the ROM as before (${romDiff(before, rom.data)} bytes differ) ${warnings.join(' ')}`);
  check(same(tiles01(rom), vram), 'the game loads the clean GFX01 again');
}

// ---------- changed before and since ----------

{
  const p = graphicsUpload('baserom-graphics');
  const { rom, opt } = await target();
  // GFX03 edited in this ROM before
  const mine = cleanGlobalGfx(rom, 3)!.map((v) => v ^ 0x0f);
  setGlobalGfx(rom, 3, mine);
  const r = await installPackage(rom, p, opt);
  check(r.ok && r.warnings.some((w) => w.includes('GFX03') && /own changes/.test(w)), `a file this ROM changed before: replaced, said so (${r.warnings.join(' ')})`);
  // GFX01 edited after
  const after = globalGfxData(rom, 1)!.map((v) => v ^ 0xf0);
  setGlobalGfx(rom, 1, after);
  const warnings = await removePackage(rom, listPackages(rom)[0].id, opt.blank);
  check(warnings.some((w) => w.includes('GFX01') && /changed since/.test(w)), `changed since: reported (${warnings.join(' ')})`);
  check(same(globalGfxData(rom, 1), after), '… and left as it is');
  check([0, 2, 3, GFX33].every((n) => same(globalGfxData(rom, n), cleanGlobalGfx(rom, n))), 'the others set back to the clean game\'s');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
