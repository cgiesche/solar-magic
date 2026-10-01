// Background packages (Lunar Magic .mwl + .map16 + ExGFX + .pal/.palmask, as on SMWCentral): only the
// background goes into a level; the game then draws the package's BG tiles with its graphics and colors.
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { packageFiles } from '../src/core/patchpkg.ts';
import { parseMwl, isBgPackage, planBgPack, applyBgPack, levelColors } from '../src/core/bgpack.ts';
import { bgTileWords, bgExtTileWords } from '../src/core/bgmap16.ts';
import { parseMap16File } from '../src/core/map16file.ts';
import { bgFromWram } from '../src/core/bg.ts';
import { loadLevel, hasLayer2Objects } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { levelGfx, levelExtGfx, GFX_SLOT_NAMES, gfxEntry, customPalette } from '../src/core/patches.ts';
import { renderLevel } from '../src/core/render.ts';
import { installVramPatch } from '../src/core/vrampatch.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const file = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
const LV = 0x105;

// words of BG tile (x, y) in the layer 2 tilemap (VRAM, 64x64 cells without the VRAM patch): TL, BL, TR, BR
const vramBg = (r: { vram: Uint8Array; ppuRegs: Uint8Array }, x: number, y: number) => {
  const base = (r.ppuRegs[0x08] & 0xfc) << 8;
  const cell = (cx: number, cy: number) => {
    const wa = base + (cx >= 32 ? 0x400 : 0) + (cy >= 32 ? 0x800 : 0) + (cy & 31) * 32 + (cx & 31);
    return r.vram[wa * 2] | (r.vram[wa * 2 + 1] << 8);
  };
  return [cell(2 * x, 2 * y), cell(2 * x, 2 * y + 1), cell(2 * x + 1, 2 * y), cell(2 * x + 1, 2 * y + 1)];
};
const bgAt = (bg: Uint16Array, x: number, y: number) => bg[(x >> 4) * 0x1b0 + y * 16 + (x & 15)];
const color = (cg: Uint8Array, i: number) => cg[i * 2] | (cg[i * 2 + 1] << 8);

// ---- the real package ----
const files = packageFiles('ghostbusters.zip', new Uint8Array(readFileSync('resources_local/ghostbustersghosttrapjavamanhattanBG.zip')));
check(isBgPackage(files), 'detected as background package');
const mwl = parseMwl(files.get('ghostbustersghosttrapjavamanhattanBG.mwl')!);
check(mwl.gfx.get('BG1') === 0x8a1 && mwl.gfx.get('BG2') === 0x8a2 && mwl.gfx.get('BG3') === 0x8a3 && mwl.gfx.get('FG1') === 0x14, '.mwl: ExGFX list (BG1-3 = 8A1-8A3)');
const usedTiles = [...new Set(mwl.bg)].filter((t) => t >= 0x200);
check(Math.min(...usedTiles) === 0x200 && Math.max(...usedTiles) === 0x257 && mwl.bg[0] === 0 && bgAt(mwl.bg, 0, 16) === 0x200 && bgAt(mwl.bg, 17, 16) === 0x201, '.mwl: BG tilemap uses 200-257, bottom 11 rows');
const map16 = parseMap16File(files.get('ghostbustersghosttrapjavamanhattanBG.map16')!);

{
  // without the VRAM patch: BG1 and the tiles, BG2/BG3 noted as not available
  const rom = new Rom(file.slice());
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const before = emu0.load(LV);
  const plan = planBgPack(rom, 'ghostbusters', files);
  check(plan.at === 0x200 && plan.gfx.length === 3 && plan.gfx.every((g) => g.num >= 0x80 && g.num < 0xff) && plan.colors?.join() === Array.from({ length: 14 }, (_, i) => 0x31 + i).join() && plan.back, 'plan: tiles at 200, ExGFX 8A1-8A3 renumbered, colors 31-3E + back area color');
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, files, plan, { cgram: levelColors(before) });
  check(r.ok && !!r.bg, 'applied: ' + [...r.errors, ...r.notes].join(' | '));
  check(r.notes.some((n) => n.includes('BG2-Slot nicht verfügbar')), 'BG2/BG3 need the VRAM patch (noted)');
  check(map16.tiles.every((ws, i) => same(bgExtTileWords(rom, 0x200 + i)!, ws)), 'BG Map16 tiles 200-25F from the .map16');
  const bg1 = plan.gfx.find((g) => g.slot === 'BG1')!;
  check(levelGfx(rom, LV)[GFX_SLOT_NAMES.indexOf('BG1')] === bg1.num && !!gfxEntry(rom, bg1.num)?.raw, 'BG1 slot = the stored 4bpp ExGFX');
  lv.bg = r.bg; saveLevel(rom, lv);
  const emu = new LevelEmulator(rom); emu.boot();
  const after = emu.load(LV);
  check(after.ok && same(bgFromWram(after.wram), r.bg!), 'saved level loads the package BG');
  let wrong = 0;
  for (let y = 0; y < 27; y++) for (let x = 0; x < 32; x++) if (!same(vramBg(after, x, y), bgTileWords(rom, bgAt(r.bg!, x, y)))) wrong++;
  check(!wrong, `game draws the package's BG tiles (${wrong} wrong)`);
  // the package's colors, the rest as before
  const pal = files.get('ghostbustersghosttrapjavamanhattanBG.pal')!;
  const exp = (i: number) => (pal[i * 3] >> 3) | ((pal[i * 3 + 1] >> 3) << 5) | ((pal[i * 3 + 2] >> 3) << 10);
  check(!!customPalette(rom, LV) && plan.colors!.every((i) => color(after.cgram, i) === exp(i)), 'masked colors from the .pal');
  check((after.wram[0x701] | (after.wram[0x702] << 8)) === mwl.back, 'back area color ($0701) from the .mwl');
  const changed = Array.from({ length: 256 }, (_, i) => i).filter((i) => i && !plan.colors!.includes(i) && color(after.cgram, i) !== color(before.cgram, i));
  check(!changed.length, `other colors unchanged (${changed.map((i) => i.toString(16)).join(' ')})`);
  const l2a = renderLevel(rom, before, lv.header.mode, lv.header.screens).layer2, l2b = renderLevel(rom, after, lv.header.mode, lv.header.screens).layer2;
  check(!same(l2a, l2b), 'editor preview shows a different background');
}

{
  // with the VRAM patch: BG2/BG3 slots get the files, the game uploads them to VRAM $2000/$2800
  const rom = new Rom(file.slice());
  const v = installVramPatch(rom);
  check(v.ok, 'VRAM patch installed ' + v.errors.join(' '));
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const plan = planBgPack(rom, 'ghostbusters', files);
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, files, plan, { cgram: levelColors(emu0.load(LV)) });
  check(r.ok, 'applied with VRAM patch: ' + [...r.errors, ...r.notes].join(' | '));
  const nums = ['BG2', 'BG3'].map((s) => plan.gfx.find((g) => g.slot === s)!.num);
  check(same(levelExtGfx(rom, LV), nums), 'BG2/BG3 slots set');
  lv.bg = r.bg; saveLevel(rom, lv);
  const emu = new LevelEmulator(rom); emu.boot();
  const after = emu.load(LV);
  const g2 = files.get('ExGFX8A2.bin')!, g3 = files.get('ExGFX8A3.bin')!;
  check(after.ok && same(after.vram.subarray(0x4000, 0x5000), g2) && same(after.vram.subarray(0x5000, 0x6000), g3), 'game loads ExGFX 8A2/8A3 into VRAM $2000/$2800');
  // applying again: the tiles at 200 are taken now, the plan moves to the next free block
  const again = planBgPack(rom, 'ghostbusters', files);
  check(again.at === 0x260, `second import goes to the next free tiles (${again.at.toString(16)})`);
}

// ---- synthetic package: other start tile, level with layer 2 objects ----
{
  const mwlData = new Uint8Array(0x900);
  mwlData.set([0x4c, 0x4d]);
  const w32 = (o: number, v: number) => { mwlData[o] = v & 0xff; mwlData[o + 1] = (v >> 8) & 0xff; mwlData[o + 2] = (v >> 16) & 0xff; mwlData[o + 3] = v >>> 24; };
  w32(0x40 + 2 * 8, 0x80); w32(0x44 + 2 * 8, 0x808);
  for (let i = 0; i < 0x400; i++) { const t = i % 3 ? 0x300 + (i % 2) : 0x025; mwlData[0x88 + i * 2] = t & 0xff; mwlData[0x89 + i * 2] = t >> 8; }
  const lm = new Uint8Array(0xb0 + 32 * 10);
  lm.set(new TextEncoder().encode('LM16'));
  const l32 = (o: number, v: number) => { lm[o] = v & 0xff; lm[o + 1] = (v >> 8) & 0xff; lm[o + 2] = (v >> 16) & 0xff; lm[o + 3] = v >>> 24; };
  l32(0x10, 0x70); l32(0x18, 16); l32(0x1c, 2); l32(0x70, 0xb0); l32(0x74, 32 * 8);
  for (let i = 0; i < 32 * 4; i++) { lm[0xb0 + i * 2] = (i + 1) & 0xff; lm[0xb1 + i * 2] = 0x05; }
  const syn = packageFiles('syn.zip', zipSync({ 'Syn/syn.mwl': mwlData, 'Syn/syn.map16': lm }));
  const rom = new Rom(file.slice());
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const plan = planBgPack(rom, 'syn', syn);
  check(plan.map16?.from === 0x300 && plan.at === 0x300 && !plan.colors, 'synthetic: tiles 300-31F, no palette');
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, syn, plan, { cgram: levelColors(emu0.load(LV)), at: 0x480 });
  const src = parseMwl(mwlData).bg;
  check(r.ok && r.bg!.every((t, i) => t === (src[i] >= 0x300 ? src[i] - 0x300 + 0x480 : src[i])) && bgExtTileWords(rom, 0x491)?.[0] === 0x0545, 'other start tile moves the tilemap along');
  check(!customPalette(rom, LV), 'without .palmask the palette stays');
  const l2 = [...Array(0x200).keys()].find((n) => hasLayer2Objects(loadLevel(rom, n).header.mode))!;
  const lv2 = loadLevel(rom, l2);
  const r2 = applyBgPack(rom, lv2, syn, plan, { cgram: levelColors(emu0.load(LV)) });
  check(!r2.ok && /Layer-2-Objekte/.test(r2.errors[0]), 'level with layer 2 objects is refused');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exitCode = 1;
