// Several sample levels at their own level numbers (pkgsamples.ts, packages.ts): the Romhack Races baserom's
// export/levels/*.mwl. 105 (the info level: Direct Map16 text on Map16 pages 40–41) and 13B (the demo level:
// ObjecTool's custom extended objects 98–FF) are offered at their numbers; 0C7 is the title screen's level
// (the level the game loads for its title screen, found by booting it) and 112 is Yoshi's Island 1 moved
// there by the package's overworld (its BPS has the level tile entering 105 here enter 112) – both left out
// with a note. Accepted, they are written at their numbers with the Map16 tiles and ExGFX numbers where the
// package's parts landed, their graphics slots, colors and screen exits their own; 13B's ObjecTool objects
// draw (emulated, ObjecTool installed with the package). Removing the package keeps them (a sample level is
// not part of it). One .mwl alone stays the sample level replacing the current level.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator, titleScreenLevel } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch, customPalette } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { loadLevel, type Level } from '../src/core/level.ts';
import { levelSlots } from '../src/core/gfxslots.ts';
import { mwlSections, parseLmObjects } from '../src/core/mwl.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { inspectUpload, installPackage, removePackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(3, '0');

const files = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const L = (n: string) => `export/levels/level ${n}.mwl`;
// the baserom without the global GFX files it edits (#107)
const keep: Record<string, Uint8Array> = {};
for (const [k, v] of Object.entries(files)) if (!/^(resources\/original_graphics\/|workspace\/Graphics\/)/.test(k)) keep[k] = v;
const baserom = ready(inspectUpload('baserom.zip', zipSync(keep)));

// an opened ROM with the Map16 extension and custom blocks, and the options to install with level 106 open
async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const emu = new LevelEmulator(rom); emu.boot();
  const src = map16Source(rom, emu.load(0x106));
  const blank = src.fg(0x025);
  installEditorPatch(rom);
  enableBlocks(rom, blank);
  return { rom, opt: { level: 0x106, blank, tileWords: (t) => src.fg(t), setup: false } };
}

// ---------- which are offered ----------

{
  const rom = new Rom(await editorImage());
  check(titleScreenLevel(rom) === 0xc7, `the title screen's level, found by booting the game: 0C7 (${titleScreenLevel(rom)?.toString(16)})`);
}
{
  check(baserom.samples.join() === ['0C7', '105', '112', '13B'].map(L).join(), `the baserom's sample levels: its four level files (${baserom.samples.join(', ')})`);
  const { rom, opt } = await target();
  const plan = planUpload(rom, baserom, opt.blank);
  const s = (n: string) => plan.samples.find((x) => x.file === L(n));
  check(s('105')?.level === 0x105 && s('105')?.left === null && s('13B')?.level === 0x13b && s('13B')?.left === null, '105 and 13B offered at their own numbers');
  check(!!s('0C7')?.left?.includes('title screen'), `0C7 left out: ${s('0C7')?.left}`);
  check(!!s('112')?.left?.includes('overworld') && !!s('112')?.left?.includes('105'), `112 left out: ${s('112')?.left}`);
  // the ExGFX slots from the level files (the first, 0C7, has none)
  const slot = (f: string) => plan.gfx.find((g) => g.file === `workspace/ExGraphics/ExGFX${f}.bin`)?.slot;
  check(slot('B54') === 'BG2' && slot('E17') === 'FG2' && slot('FF') === 'BG3', `ExGFX B54, E17, FF for the slots the sample levels have them in (${slot('B54')}, ${slot('E17')}, ${slot('FF')})`);
}
{
  // without the overworld's BPS, 112 is offered too; one level file alone replaces the current level
  const { rom, opt } = await target();
  const two = { ...keep };
  delete two['export/global/overworld.bps'];
  const p = ready(inspectUpload('two.zip', zipSync(two)));
  const plan = planUpload(rom, p, opt.blank);
  check(plan.samples.filter((x) => !x.left).map((x) => hx(x.level!)).join() === '105,112,13B', `without the overworld's BPS: 105, 112 and 13B offered (${plan.samples.filter((x) => !x.left).map((x) => hx(x.level!)).join()})`);
  const one = { 'blk.asm': new TextEncoder().encode('db $42\nJML Return\nJML Return\nJML Return\nJML Return\nJML Return\nJML Return\nJML Return\nReturn:\nRTL\n'), 'sample.mwl': files[L('13B')] };
  const p1 = ready(inspectUpload('one.zip', zipSync(one)));
  const plan1 = planUpload(rom, p1, opt.blank);
  check(plan1.samples.length === 1 && plan1.samples[0].level === null && plan1.samples[0].left === null, 'one level file: the sample level for the current level');
}

// ---------- installed ----------

{
  const { rom, opt } = await target();
  const plan = planUpload(rom, baserom, opt.blank);
  const before = { c7: loadLevel(rom, 0xc7), l112: loadLevel(rom, 0x112), l106: loadLevel(rom, 0x106) };
  const r = await installPackage(rom, baserom, { ...opt, plan, samples: [L('105'), L('13B')] });
  if (!r.ok) console.log(r.errors.slice(0, 5).join('\n'));
  check(r.ok && r.samples?.join() === [0x105, 0x13b].join() && !r.sample, `installed with 105 and 13B at their numbers (${r.samples?.map(hx).join()})`);
  const same = (a: Level, b: Level) => JSON.stringify(a.objects.map(({ uid: _, ...o }) => o)) === JSON.stringify(b.objects.map(({ uid: _, ...o }) => o)) && a.sprites.length === b.sprites.length;
  check(same(loadLevel(rom, 0xc7), before.c7) && same(loadLevel(rom, 0x112), before.l112) && same(loadLevel(rom, 0x106), before.l106), 'levels 0C7, 112 and the open level 106 unchanged');

  // 105: its 272 text objects on the tiles where the package's Map16 pages 40–41 went
  const l105 = loadLevel(rom, 0x105);
  const sec = mwlSections(files[L('105')]);
  // (the author's tiles, each Direct Map16 tile kept)
  const raw: number[] = [];
  parseLmObjects(sec.layer1, 5, false, [], false, (t) => { raw.push(t); return 0; });
  const dm16 = l105.objects.filter((o) => o.ext === DM16_EXT);
  const fg = new Map(plan.romMap16!.fg);
  check(raw.length === dm16.length && dm16.every((o, i) => o.tile === (fg.get(raw[i]) ?? raw[i])),
    `105: its ${dm16.length} Direct Map16 tiles, where the package's went (${raw.filter((t) => t >= 0x1000).length} from pages 40–41)`);
  check(dm16.every((o) => o.tile! < 0x1000) && dm16.some((o) => o.tile! >= 0x400 && o.tile! < 0x600), '105: the text from tiles 400–5FF (pages 40–41 moved there)');
  const slots = levelSlots(rom, 0x105, l105.header);
  const num = (f: string) => plan.gfx.find((g) => g.file === `workspace/ExGraphics/ExGFX${f}.bin`)!.num;
  const at = (n: string) => slots.find((s) => s.name === n)!;
  check(at('FG2').file === num('E17') && at('BG2').file === num('B54') && at('BG3').file === num('FF') && at('SP4').file === 0x02,
    `105: its graphics slots, the package's ExGFX by the numbers they got (FG2 ${hx(at('FG2').file)}, BG2 ${hx(at('BG2').file)}, BG3 ${hx(at('BG3').file)}, SP4 ${hx(at('SP4').file)})`);
  check(customPalette(rom, 0x105) !== 0 && customPalette(rom, 0x13b) !== 0, '105 and 13B: their own colors');

  // 13B: nothing left out, its own screen exits, ObjecTool's objects drawn
  const l13b = loadLevel(rom, 0x13b);
  const sec13 = mwlSections(files[L('13B')]);
  const own = parseLmObjects(sec13.layer1, 5, false, [], false, () => 0);
  check(!r.warnings.some((w) => /13B.*left out/.test(w)) && l13b.objects.length === own.objects.length, `13B: all ${own.objects.length} objects (${l13b.objects.length})`);
  check(JSON.stringify(l13b.exits.map((x) => [x.screen, x.dest])) === JSON.stringify(own.exits.map((x) => [x.screen, x.dest])), `13B: its own screen exits (${l13b.exits.length})`);
  // ObjecTool's objects 98–DF of the baserom set a flag each for its UberASM code ($7FA400, freeram.asm)
  const tool = l13b.objects.filter((o) => o.num === 0 && o.ext >= 0x98 && o.ext < 0xe0);
  const emu = new LevelEmulator(rom); emu.boot();
  const lr = emu.load(0x13b);
  const ran = tool.filter((o) => lr.wram[0x1a400 + ((o.ext - 0x98) >> 3)] & (1 << ((o.ext - 0x98) & 7)));
  check(lr.ok && tool.length > 0 && ran.length === tool.length, `13B: its ${tool.length} ObjecTool objects (${tool.map((o) => o.ext.toString(16).toUpperCase()).join(', ')}) run ObjecTool's code, emulated (${ran.length})`);

  // removed: the sample levels stay
  await removePackage(rom, listPackages(rom)[0].id, opt.blank);
  check(!listPackages(rom).length && same(loadLevel(rom, 0x105), l105) && same(loadLevel(rom, 0x13b), l13b), 'package removed: 105 and 13B stay (not part of it)');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
