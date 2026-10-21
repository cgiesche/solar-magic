// ExGFX numbers 100-FFF in the game (patches.ts, layer3gfx.ts): a file above FF loads from every slot
// that takes ExGFX – the level's graphics slots, BG2/BG3, LG1-LG4 and LT3 – exactly as the same file
// under a number up to FF; its low byte is not taken for one of the game's own files (1E: the game
// converts its file 1E differently in some tilesets), and a slot that changes between 0x180 and 0x080
// (same low byte) from one level to the next gets the new file.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { importGfxFile } from '../src/core/gfxfiles.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { levelLayer3, setLevelLayer3, type Layer3Gfx } from '../src/core/layer3gfx.ts';
import { gfxEntry, setGfxEntry, freeGfx, levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES, MAX_GFX, gfxRangeFor, gfxNumberProblem, gfxDataSize, installEditorPatch } from '../src/core/patches.ts';
import { gfxNumber } from '../src/core/levelgfx.ts';
import { lz2Compress } from '../src/core/lz2.ts';
import { loadAsar } from '../src/core/asar.ts';
import { inspectUpload, installPackage, planUpload } from '../src/core/packages.ts';
import { map16Source } from '../src/core/render.ts';
import { zipSync } from 'fflate';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const LV = 0x105;
const slot = (name: string) => GFX_SLOT_NAMES.indexOf(name);
// (the game animates tiles in the second half of FG1, so only the first is compared there)
const pattern = (n: number, seed: number) => { const d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = (i * seed + (i >> 5) + seed) & 0xff; return d; };
const withSlot = (rom: Rom, lv: number, name: string, num: number) => { const g = levelGfx(rom, lv); g[slot(name)] = num; setLevelGfx(rom, lv, g); };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

check(MAX_GFX === 0xfff, 'ExGFX numbers go up to FFF');

// the ranges: ExGFX from 80 (then 32-7F), files kept "as is" from E00; FF is no file's number; an LM
// number is kept when free, else the next free one in its range
{
  const rom = fresh();
  check(freeGfx(rom, new Set()) === 0x80 && freeGfx(rom, new Set(), 'asIs') === 0xe00, 'next free: 80, "as is" E00');
  const taken = new Set<number>();
  for (let i = 0x80; i < 0xff; i++) taken.add(i);
  check(freeGfx(rom, taken) === 0x100, 'after 80-FE: 100 (FF skipped)');
  check(gfxNumber(rom, 0x8a2, new Set(), { size: 0xc00 }) === 0x8a2 && gfxNumber(rom, 0xe05, new Set(), { size: 0x800 }) === 0xe05, 'LM numbers 8A2 and E05 kept when free');
  importGfxFile(rom, 0xe05, pattern(0x800, 3));
  check(gfxNumber(rom, 0xe05, new Set(), { size: 0x800 }) === 0xe00 && gfxNumber(rom, null, new Set(), { slot: 'LG1' }) === 0xe00, 'E05 taken: the next free "as is" number');
  check(gfxNumber(rom, 0xe20, new Set(), { size: 0xc00 }) === 0x80, 'a 3bpp file numbered E20: the next free ExGFX number (it can\'t be kept "as is")');
  check(gfxNumber(rom, 0xe21, new Set(), { size: 0x1000 }) === 0xe21, 'a 4bpp file numbered E21 stays there');
  let refused = '';
  try { importGfxFile(rom, 0xe10, pattern(0xc00, 3)); } catch (e) { refused = (e as Error).message; }
  check(refused.includes('E00') && !gfxEntry(rom, 0xe10), 'a 3bpp file is not stored in E00-FFF');
  refused = '';
  try { importGfxFile(rom, 0xff, pattern(0x1000, 3)); } catch (e) { refused = (e as Error).message; }
  check(!!refused && !gfxEntry(rom, 0xff), 'no file under FF (a slot\'s "none")');
}

// one rule for a file's range: by the slot it is for, else by its size unpacked; 3bpp graphics never "as is"
{
  check(gfxRangeFor({ slot: 'LG1' }) === 'asIs' && gfxRangeFor({ slot: 'LT3' }) === 'asIs' && gfxRangeFor({ slot: 'FG1' }) === 'exgfx' && gfxRangeFor({ slot: 'BG2' }) === 'exgfx', 'by slot: layer 3\'s "as is", the others ExGFX');
  check(gfxRangeFor({ size: 0x800 }) === 'asIs' && gfxRangeFor({ size: 0x2000 }) === 'asIs' && gfxRangeFor({ size: 0x1000 }) === 'exgfx' && gfxRangeFor({ size: 0xc00 }) === 'exgfx' && gfxRangeFor({}) === 'exgfx', 'by size: 2bpp and tilemaps "as is", 3bpp/4bpp ExGFX');
  check(gfxRangeFor({ slot: 'LG1', size: 0xc00 }) === 'exgfx', 'a 3bpp file is ExGFX whatever its slot');
  check(gfxDataSize(pattern(0xc00, 2)) === 0xc00 && gfxDataSize(lz2Compress(pattern(0x800, 2))) === 0x800 && gfxDataSize(new Uint8Array(5)) === 5, 'size unpacked: raw as is, LZ2 unpacked');
  check(gfxNumberProblem(0x80) === null && gfxNumberProblem(0x32) === null && gfxNumberProblem(0xfff) === null && gfxNumberProblem(0xe10, { size: 0x1000 }) === null, 'numbers 32-FFF may hold a file');
  check(!!gfxNumberProblem(0x10) && gfxNumberProblem(0x10, { game: true }) === null, 'the game\'s files: only when replacing them');
  check(!!gfxNumberProblem(0xff) && !!gfxNumberProblem(0x1000) && !!gfxNumberProblem(-1) && !!gfxNumberProblem(128.5), 'not FF, not above FFF');
  check(/80–DFF/.test(gfxNumberProblem(0xe10, { size: 0xc00 }) ?? ''), 'a 3bpp file not in E00-FFF, and why');
}

// a package's 3bpp file numbered E20 by its author: placed under the next free ExGFX number, installed
{
  await loadAsar();
  const b3 = pattern(0xc00, 5);
  const zip = zipSync({ 'Pack/ExGFXE20_FG3.bin': lz2Compress(b3) });
  const preview = inspectUpload('Pack.zip', zip);
  check(preview.status === 'ready', 'package with one ExGFX file: ready');
  if (preview.status === 'ready') {
    const rom = fresh(); installEditorPatch(rom);
    const emu = new LevelEmulator(rom); emu.boot();
    const blank = map16Source(rom, emu.load(LV)).fg(0x25);
    const plan = planUpload(rom, preview, blank);
    check(plan.gfx[0]?.num === 0x80 && plan.gfx[0]?.lmNum === 0xe20, `planned as ExGFX 80, not E20 (${plan.gfx[0]?.num.toString(16)})`);
    const r = await installPackage(rom, preview, { blank, tileWords: () => blank, level: LV, setup: false });
    check(r.ok && gfxEntry(rom, 0x80)?.raw === false && !gfxEntry(rom, 0xe20), 'installed: 3bpp under 80 ' + [...r.errors].join(' | '));
  }
}

// a raw 4bpp file at 180 in FG1, a compressed 3bpp file at 11E in FG2 (and the same file at 81)
{
  const rom = fresh();
  const raw = pattern(0x1000, 7), b3 = pattern(0xc00, 13);
  importGfxFile(rom, 0x180, raw);
  importGfxFile(rom, 0x11e, b3);
  importGfxFile(rom, 0x81, b3);
  check(!!gfxEntry(rom, 0x180)?.raw && gfxEntry(rom, 0x11e)?.raw === false, 'files stored under 180 and 11E');
  withSlot(rom, LV, 'FG1', 0x180);
  withSlot(rom, LV, 'FG2', 0x81);
  check(levelGfx(rom, LV)[slot('FG1')] === 0x180, 'FG1 of the level reads back as 180');
  const emu = new LevelEmulator(rom); emu.boot();
  const r81 = emu.load(LV);
  check(r81.ok && same(r81.vram.subarray(0, 0x800), raw.subarray(0, 0x800)), 'FG1: ExGFX 180 (raw) in VRAM $0000');
  withSlot(rom, LV, 'FG2', 0x11e);
  const emu2 = new LevelEmulator(rom); emu2.boot();
  const r11e = emu2.load(LV);
  check(r11e.ok && same(r11e.vram.subarray(0x1000, 0x2000), r81.vram.subarray(0x1000, 0x2000)), 'FG2: ExGFX 11E (compressed) as the same file under 81');

  // into a sublevel whose FG1 is 080 (same low byte as 180): the new file
  const other = pattern(0x1000, 3);
  importGfxFile(rom, 0x80, other);
  withSlot(rom, 0x106, 'FG1', 0x80);
  const emu3 = new LevelEmulator(rom); emu3.boot();
  emu3.load(LV);
  const s = emu3.snes, w = s.wram;
  w[RAM.sublevelCount] = 1; w[RAM.screenExitLo] = 0x06; w[RAM.useSecondaryExit] = 0; w[RAM.gameMode] = GM.levelLoad;
  for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
  check(w[RAM.gameMode] === GM.level && same(s.vram.subarray(0, 0x800), other.subarray(0, 0x800)), 'a sublevel with FG1 = 080 after FG1 = 180: ExGFX 080 in VRAM $0000');
}

// SP1 (the sprite slots' upload) from ExGFX 1C0: as the same file under 80
{
  const rom = fresh();
  importGfxFile(rom, 0x80, pattern(0x1000, 17));
  importGfxFile(rom, 0x1c0, pattern(0x1000, 17));
  const at = (num: number) => { withSlot(rom, LV, 'SP1', num); const emu = new LevelEmulator(rom); emu.boot(); return emu.load(LV); };
  const a = at(0x80), b = at(0x1c0), c = at(0xff);
  check(a.ok && b.ok && same(a.vram, b.vram) && !same(a.vram, c.vram), 'SP1: ExGFX 1C0 as the same file under 80');
}

// BG2 (VRAM $2000) from ExGFX 2A0
{
  const rom = fresh();
  const raw = pattern(0x1000, 5);
  importGfxFile(rom, 0x2a0, raw);
  setLevelExtGfx(rom, LV, [0x2a0, 0xff]);
  check(levelExtGfx(rom, LV)[0] === 0x2a0 && levelExtGfx(rom, LV)[1] === 0xff, 'BG2 slot reads back as 2A0');
  const emu = new LevelEmulator(rom); emu.boot();
  const r = emu.load(LV);
  check(r.ok && same(r.vram.subarray(0x4000, 0x5000), raw), 'BG2: ExGFX 2A0 in VRAM $2000');
}

// LG1 from E00 (raw 2bpp), LG2 from E01 (the game's compressed file 29), LT3 from FFE
{
  const rom = fresh();
  const lg = pattern(0x800, 11);
  importGfxFile(rom, 0xe00, lg);
  setGfxEntry(rom, 0xe01, gfxEntry(rom, 0x29)!.addr, false); // the game's compressed 2bpp file 29
  const map = pattern(0x2000, 9);
  importGfxFile(rom, 0xffe, map);
  const g: Layer3Gfx = { lt3: 0xffe, dest: 3, size: 0, lg: [0xe00, 0xe01, 0xff, 0xff] };
  setLevelLayer3(rom, LV, g);
  const back = levelLayer3(rom, LV);
  check(back.lt3 === 0xffe && back.lg[0] === 0xe00 && back.lg[1] === 0xe01 && back.lg[2] === 0xff, 'layer 3 slots read back as FFE, E00, E01');
  const emu = new LevelEmulator(rom); emu.boot();
  const r = emu.load(LV), plain = new LevelEmulator(fresh()); plain.boot();
  const p = plain.load(LV); // LG2 is the game's file 29 there too
  check(r.ok && same(r.vram.subarray(0x8000, 0x8800), lg), 'LG1: ExGFX E00 in VRAM $4000');
  check(same(r.vram.subarray(0x8800, 0x9000), p.vram.subarray(0x8800, 0x9000)), 'LG2: ExGFX E01 (compressed) in VRAM $4400');
  check(same(r.vram.subarray(0xb000, 0xc000), map.subarray(0, 0x1000)), 'LT3: ExGFX FFE in the bottom half of layer 3 ($5800)');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
