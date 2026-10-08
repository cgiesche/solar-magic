// Background packages (Lunar Magic .mwl + .map16 + ExGFX + .pal/.palmask, as on SMWCentral): only the
// background goes into a level; the game then draws the package's BG tiles with its graphics and colors.
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { uploadFiles } from '../src/core/patchpkg.ts';
import { parseMwl, isLevelImport, planBgPack, applyBgPack, levelColors } from '../src/core/bgpack.ts';
import { bgTileWords, bgExtTileWords } from '../src/core/bgmap16.ts';
import { parseMap16File } from '../src/core/map16file.ts';
import { bgFromWram } from '../src/core/bg.ts';
import { loadLevel, hasLayer2Objects } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { levelGfx, levelExtGfx, GFX_SLOT_NAMES, gfxEntry, customPalette } from '../src/core/patches.ts';
import { renderLevel, map16Source } from '../src/core/render.ts';
import { extTileWords, actsLike } from '../src/core/map16ext.ts';
import { snapshot, partsBetween, savePackage, emptyParts, mergeParts, uninstallPackage } from '../src/core/pkgreg.ts';
import { installVramPatch } from '../src/core/vrampatch.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const LV = 0x105;
let BLANK: number[] = [];
{ const rom = new Rom(file.slice()); const e = new LevelEmulator(rom); e.boot(); BLANK = map16Source(rom, e.load(LV)).fg(0x025); }

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
const files = uploadFiles('ghostbusters.zip', new Uint8Array(readFileSync('test/fixtures/ghostbustersghosttrapjavamanhattanBG.zip')));
check(isLevelImport(files), 'detected as background package');
const mwl = parseMwl(files.get('ghostbustersghosttrapjavamanhattanBG.mwl')!);
check(mwl.gfx.get('BG1') === 0x8a1 && mwl.gfx.get('BG2') === 0x8a2 && mwl.gfx.get('BG3') === 0x8a3 && mwl.gfx.get('FG1') === 0x14, '.mwl: ExGFX list (BG1-3 = 8A1-8A3)');
const usedTiles = [...new Set(mwl.bg!)].filter((t) => t >= 0x200);
check(Math.min(...usedTiles) === 0x200 && Math.max(...usedTiles) === 0x257 && mwl.bg![0] === 0 && bgAt(mwl.bg!, 0, 16) === 0x200 && bgAt(mwl.bg!, 17, 16) === 0x201, '.mwl: BG tilemap uses 200-257, bottom 11 rows');
const map16 = parseMap16File(files.get('ghostbustersghosttrapjavamanhattanBG.map16')!);

{
  // without the VRAM patch: BG1 and the tiles, BG2/BG3 noted as not available
  const rom = new Rom(file.slice());
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const before = emu0.load(LV);
  const plan = planBgPack(rom, 'ghostbusters', files, BLANK);
  check(plan.at === 0x200 && plan.gfx.length === 3 && plan.gfx.every((g) => g.num >= 0x80 && g.num < 0xff) && plan.palettes.length === 1 && plan.palettes[0].colors.join() === Array.from({ length: 14 }, (_, i) => 0x31 + i).join() && plan.palettes[0].back && !plan.fg && plan.map16?.data.origin?.bg === true, 'plan: tiles at 200 (BG .map16 by its header), ExGFX 8A1-8A3 renumbered, colors 31-3E + back area color');
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, files, plan, { blank: BLANK, cgram: levelColors(before) });
  check(r.ok && !!r.bg, 'applied: ' + [...r.errors, ...r.notes].join(' | '));
  check(r.notes.some((n) => n.includes('BG2 slot not available')), 'BG2/BG3 need the VRAM patch (noted)');
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
  check(!!customPalette(rom, LV) && plan.palettes[0].colors.every((i) => color(after.cgram, i) === exp(i)), 'masked colors from the .pal');
  check((after.wram[0x701] | (after.wram[0x702] << 8)) === mwl.back, 'back area color ($0701) from the .mwl');
  const changed = Array.from({ length: 256 }, (_, i) => i).filter((i) => i && !plan.palettes[0].colors.includes(i) && color(after.cgram, i) !== color(before.cgram, i));
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
  const plan = planBgPack(rom, 'ghostbusters', files, BLANK);
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, files, plan, { blank: BLANK, cgram: levelColors(emu0.load(LV)) });
  check(r.ok, 'applied with VRAM patch: ' + [...r.errors, ...r.notes].join(' | '));
  const nums = ['BG2', 'BG3'].map((s) => plan.gfx.find((g) => g.slot === s)!.num);
  check(same(levelExtGfx(rom, LV), nums), 'BG2/BG3 slots set');
  lv.bg = r.bg; saveLevel(rom, lv);
  const emu = new LevelEmulator(rom); emu.boot();
  const after = emu.load(LV);
  const g2 = files.get('ExGFX8A2.bin')!, g3 = files.get('ExGFX8A3.bin')!;
  check(after.ok && same(after.vram.subarray(0x4000, 0x5000), g2) && same(after.vram.subarray(0x5000, 0x6000), g3), 'game loads ExGFX 8A2/8A3 into VRAM $2000/$2800');
  // applying again: the tiles at 200 are taken now, the plan moves to the next free block
  const again = planBgPack(rom, 'ghostbusters', files, BLANK);
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
  const syn = uploadFiles('syn.zip', zipSync({ 'Syn/syn.mwl': mwlData, 'Syn/syn.map16': lm }));
  const rom = new Rom(file.slice());
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const plan = planBgPack(rom, 'syn', syn, BLANK);
  check(plan.map16?.from === 0x300 && plan.at === 0x300 && !plan.palettes.length, 'synthetic: tiles 300-31F, no palette');
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, syn, plan, { blank: BLANK, cgram: levelColors(emu0.load(LV)), at: 0x480 });
  const src = parseMwl(mwlData).bg!;
  check(r.ok && r.bg!.every((t, i) => t === (src[i] >= 0x300 ? src[i] - 0x300 + 0x480 : src[i])) && bgExtTileWords(rom, 0x491)?.[0] === 0x0545, 'other start tile moves the tilemap along');
  check(!customPalette(rom, LV), 'without .palmask the palette stays');
  const l2 = [...Array(0x200).keys()].find((n) => hasLayer2Objects(loadLevel(rom, n).header.mode))!;
  const lv2 = loadLevel(rom, l2);
  const r2 = applyBgPack(rom, lv2, syn, plan, { blank: BLANK, cgram: levelColors(emu0.load(LV)) });
  check(!r2.ok && /layer 2 objects/.test(r2.errors[0]), 'level with layer 2 objects is refused');
}

// ---- FG + BG + layer 3 package (Sonic Mania Studiopolis Act 1): which .map16/.pal is which comes from
// the files, not their names ----
{
  const ssz = uploadFiles('ssz.zip', new Uint8Array(readFileSync('test/fixtures/sonicmaniasszact1.zip')));
  const fgFile = parseMap16File(ssz.get('sonicmaniasszact1FG.map16')!), bgFile = parseMap16File(ssz.get('sonicmaniasszact1BG-L2.map16')!);
  check(fgFile.origin?.bg === false && fgFile.origin.tile === 0x200 && bgFile.origin?.bg === true && bgFile.origin.tile === 0x200, '.map16 header: FG from 200, BG from BG tile 200');
  // renamed files: same result
  const renamed = new Map([...ssz].map(([f, d]) => [f.replace('FG.map16', 'a.map16').replace('BG-L2.map16', 'b.map16'), d]));
  const rom = new Rom(file.slice());
  check(installVramPatch(rom).ok, 'VRAM patch installed');
  const emu0 = new LevelEmulator(rom); emu0.boot();
  const before = emu0.load(LV);
  for (const [what, fs] of [['names', ssz], ['renamed', renamed]] as const) {
    const pl = planBgPack(rom, 'ssz', fs, BLANK);
    check(!!pl.fg && pl.fg.data.tiles.length === 256 && pl.map16?.data.tiles.length === 128 && pl.fg.from === 0x200, `${what}: FG .map16 (256 tiles) and BG .map16 (128 tiles) told apart`);
  }
  const plan = planBgPack(rom, 'ssz', ssz, BLANK);
  const slots = Object.fromEntries(plan.gfx.map((g) => [g.slot, g]));
  check(!!slots.FG3?.file?.endsWith('3A6.bin') && !!slots.BG3?.file?.endsWith('3A7.bin') && slots.FG3.parts.join() === 'fg' && slots.BG3.parts.join() === 'fg' && ['BG1', 'BG2'].every((s) => slots[s]?.file && slots[s].parts.join() === 'bg') && slots.FG1?.file === null && !slots.FG2, 'slots from the tiles that use them: FG tiles FG1 (ROM), FG3, BG3; background BG1, BG2');
  check(!plan.gfx.some((g) => g.slot.startsWith('FG') && g.parts.join() === 'bg'), 'the background does not change FG slots');
  const pFg = plan.palettes.find((p) => p.file.endsWith('FG.pal'))!, pL3 = plan.palettes.find((p) => p.file.endsWith('L3.pal'))!;
  check(plan.palettes.length === 2 && pFg.colors.join() === Array.from({ length: 15 }, (_, i) => 33 + i).join() && !pFg.layer3 && pL3.colors.join() === '1,2,3,5,6' && pL3.layer3, 'palettes: FG colors 21-2F, layer 3 colors 1-6 (each .pal with its .palmask)');
  check(plan.layer3.some((f) => f.endsWith('ExGFX3AB.bin')) && plan.layer3.some((f) => f.endsWith('ExGFX3AA.bin')), 'layer 3 files noted (LT3 tilemap 3AB, LG3 graphics 3AA)');
  const before2 = snapshot(rom);
  const lv = loadLevel(rom, LV);
  const r = applyBgPack(rom, lv, ssz, plan, { blank: BLANK, cgram: levelColors(before) });
  check(r.ok && !!r.bg, 'applied: ' + [...r.errors, ...r.notes].join(' | '));
  const at = plan.fgAt;
  check(plan.fg!.data.tiles.every((ws, i) => same(extTileWords(rom, at + i)!, ws)), `FG Map16 tiles from ${at.toString(16)}`);
  const acts = plan.fg!.data.acts!;
  check(acts.every((a, i) => actsLike(rom, at + i) === (a >= 0x200 && a < 0x300 ? a - 0x200 + at : a)), 'acts like taken over');
  check(levelGfx(rom, LV)[GFX_SLOT_NAMES.indexOf('FG3')] === slots.FG3.num, 'FG3 slot set');
  lv.bg = r.bg; saveLevel(rom, lv);
  const emu = new LevelEmulator(rom); emu.boot();
  const after = emu.load(LV);
  const pal = ssz.get('sonicmaniasszact1FG.pal')!;
  const exp = (i: number) => (pal[i * 3] >> 3) | ((pal[i * 3 + 1] >> 3) << 5) | ((pal[i * 3 + 2] >> 3) << 10);
  check(after.ok && pFg.colors.every((i) => color(after.cgram, i) === exp(i)), 'FG colors in the game');
  check([1, 2, 3, 5, 6].every((i) => color(after.cgram, i) === color(before.cgram, i)), 'layer 3 colors not taken over by default (layer 3 is not)');
  // as a package: its Map16 tiles are recorded and emptied again on removal
  const parts = partsBetween(before2, snapshot(rom));
  check(parts.map16?.length === 256 && parts.map16[0] === at && parts.bgMap16?.length === 128, `recorded: ${parts.map16?.length} FG, ${parts.bgMap16?.length} BG Map16 tiles, ExGFX ${parts.gfx.map((g) => g.toString(16)).join(' ')}`);
  const rec = savePackage(rom, mergeParts({ id: 'ssz', name: 'ssz', fileName: 'ssz.zip', added: '', ...emptyParts() }, parts, snapshot(rom)));
  uninstallPackage(rom, rec.id, BLANK);
  check(same(extTileWords(rom, at)!, BLANK) && actsLike(rom, at) === 0x25 && parts.gfx.every((g) => !gfxEntry(rom, g)), 'removed: FG tiles empty again, ExGFX gone');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exitCode = 1;
