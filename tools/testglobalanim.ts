// Global animation slots as a graphics part (globalanim.ts, pkgplan.ts, levelgfx.ts placeGlobalSlots): the
// Romhack Races baserom's export/global/exanimation.bps, Callisto's export of Lunar Magic's global
// ExAnimation – a BPS from the clean game to a whole Lunar Magic ROM. Its list is read from the patch's
// target (Lunar Magic's layout, the one the editor's engine follows); the bytes it takes from the clean game
// come from the editor's ROM where the clean game's fingerprint (cleangame.ts) says it still has them. The
// 7 slots are the ones of the baserom's docs/baserom_readme/ExAnimation.html, all with frames from its
// ExGFX61.bin (Anim graphic B there). Installed they go into free slots of the global list, their frames
// into its Anim graphic, and animate in the editor and in test play; removed, the ROM is as before.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { levelTranslevel, loadLevel } from '../src/core/level.ts';
import { cleanGameBytes } from '../src/core/cleangame.ts';
import { isGlobalAnimBps, globalAnimList } from '../src/core/globalanim.ts';
import { readGlobalList, writeGlobalList, readAltFile, writeAltFile, emptyList, exanimTiles, altFileName } from '../src/core/exanim.ts';
import { inspectUpload, installPackage, removePackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages, packageRemoval, packageSummary } from '../src/core/pkgreg.ts';
import { setExtTileWords } from '../src/core/map16ext.ts';
import { cleanImage, editorImage, romDiff, recordShape } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const ZIP = new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'));
const zip = unzipSync(ZIP);
const BPS = 'export/global/exanimation.bps', ALT = 'workspace/ExGraphics/ExGFX61.bin';
const bps = zip[BPS], alt = zip[ALT];
const tileBytes = (v: Uint8Array, t: number, n = 1) => v.subarray(t * 32, (t + n) * 32);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  return { rom, opt: { level: 0x105, blank, tileWords: () => blank, setup: false } };
}

// ---------- the patch ----------

// the docs' table: slot → type, trigger, frames less one, first tile (VRAM word / 16), from the alternative file
const DOCS: [number, number, number, number, number][] = [
  [0, 0x0a, 0x03, 0, 0x2f0], [1, 0x04, 0x00, 1, 0x2dc], [3, 0x04, 0x00, 3, 0x2e4], [4, 0x04, 0x00, 3, 0x2e0], [5, 0x04, 0x00, 4, 0x2d8], [6, 0x08, 0x00, 7, 0x2e8],
];
{
  const list = globalAnimList(bps, cleanGameBytes(new Rom(cleanImage())));
  check(!!list && list !== 'not known' && list.altFile === 1 && list.slots.size === 7, `read against the clean game: 7 slots, Anim graphic B (${list === 'not known' ? list : list?.slots.size})`);
  if (list && list !== 'not known') {
    const tiles = DOCS.every(([k, type, trigger, less1, tile]) => {
      const e = list.slots.get(k);
      return !!e && e.type === type && e.trigger === trigger && e.framesLess1 === less1 && (e.dest & 0x8000) !== 0 && (e.dest & 0x7fff) >> 4 === tile;
    });
    check(tiles, 'the tile slots as in the docs (ON/OFF blocks, swooper block, bounce block, spikes, one-ways, coins)');
    const c = list.slots.get(2)!;
    check(c.type === 0x14 && c.dest === 0x8178 && c.frames.join() === '0,4,8,12,8,4', 'slot 02: colors 78–79 from the alternative file, 6 frames');
    check(list.slots.get(0)!.frames.join() === [0xc00, 0xe00].join(), 'slot 00: the ON and OFF frame');
  }
  const ed = new Rom(await editorImage());
  const onEd = globalAnimList(bps, cleanGameBytes(ed));
  check(!!onEd && onEd !== 'not known' && onEd.slots.size === 7, 'read against the editor\'s ROM: the same list (the bytes it takes from the clean game are still there)');
  check(globalAnimList(bps, null) === 'not known', 'without the clean game: not known (some list bytes come from it)');
}
{
  const found = Object.keys(zip).filter((f) => f.endsWith('.bps') && isGlobalAnimBps(zip[f]));
  check(found.join() === BPS, `of the baserom's BPS only it is global animation (${found.join(', ')})`);
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', ZIP));
  const part = p.parts.find((x) => x.file === BPS);
  check(part?.kind === 'graphics' && part.type === 'globalanim', `the baserom brings it as its global animation (${part?.kind ?? 'not a part'})`);
}

// ---------- installed ----------

const upload = () => ready(inspectUpload('baserom-anim.zip', zipSync({ [BPS]: bps, [ALT]: alt, 'export/all_map16.map16': zip['export/all_map16.map16'] })));
{
  const { rom, opt } = await target();
  // a slot of the global list there before: it stays, the package's take the free ones
  const own = emptyList();
  own.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 0, dest: 0x8000 | 0x0700, frames: [0] });
  writeAltFile(rom, 0, new Uint8Array(0x20).fill(0x5a));
  writeGlobalList(rom, own);
  // pages 02 and 03 taken: the package's Map16 pages there move
  setExtTileWords(rom, 0x200, [1, 2, 3, 4]); setExtTileWords(rom, 0x300, [1, 2, 3, 4]);
  const before = rom.data.slice();
  const p = upload();
  const plan = planUpload(rom, p, opt.blank);
  check(plan.globalAnim?.slots.length === 7 && !!plan.globalAnim.frames.alt, `planned: 7 slots, frames from ${ALT}`);
  check(!plan.gfx.some((g) => g.file === ALT), 'ExGFX61.bin is their frames, not an ExGFX file');
  const r = await installPackage(rom, p, opt);
  check(r.ok, `installed ${r.errors.join(' ')} ${r.warnings.join(' ')}`);
  const g = readGlobalList(rom)!;
  check(g.slots.size === 8 && g.slots.get(0)!.dest === (0x8000 | 0x0700) && [1, 2, 3, 4, 5, 6, 7].every((k) => g.slots.has(k)), `the global list: its own slot 00, the package's in 01–07 (${[...g.slots.keys()].map(hx).join(' ')})`);
  const anim = readAltFile(rom, g.altFile)!;
  const on = g.slots.get(1)!;
  check(same(anim.subarray(on.frames[0], on.frames[0] + 0x200), alt.subarray(0xc00, 0xe00)) && same(anim.subarray(on.frames[1], on.frames[1] + 0x200), alt.subarray(0xe00, 0x1000)),
    `the ON/OFF frames copied into ${altFileName(g.altFile)}`);
  check(same(anim.subarray(0, 0x20), new Uint8Array(0x20).fill(0x5a)), `${altFileName(g.altFile)}'s own frames stay`);
  const pkg = listPackages(rom)[0];
  check(packageSummary(pkg).includes('Global animation') && packageRemoval(pkg).some((s) => s.includes('global animation slot(s) 01, 02, 03, 04, 05, 06, 07')), `the package names them: ${packageRemoval(pkg).join('; ')}`);

  // the tiles they animate: the 8x8 tiles of the baserom's Map16 tiles, which keep them wherever they landed
  // – the ON/OFF block's tiles draw tiles 2F0–2FF
  const anims = exanimTiles(rom, 0x105, 0);
  const fg = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg;
  const drawn = (plan.romMap16 ? [...plan.romMap16.fg.values()] : []).filter((t) => fg(t).some((x) => (x & 0x3ff) >= 0x2f0 && (x & 0x3ff) < 0x300));
  const moved = [...plan.romMap16?.fg ?? []].filter(([f]) => (f >> 8) === 2 || (f >> 8) === 3).every(([f, t]) => t !== f);
  check(moved && drawn.length > 0 && anims.get(0x2f0)?.[0].global === true, `the package's Map16 tiles drawing 2F0–2FF (${drawn.length}, pages 02–03 moved) show the global slot`);

  // in the editor: the ON/OFF blocks' tiles show the ON or the OFF frame, colors 78–79 cycle
  const emu = new LevelEmulator(rom);
  emu.load(0x105, { onOffSwitch: false });
  const fOn = emu.animationFrames(4, 8).at(-1)!;
  emu.load(0x105, { onOffSwitch: true });
  const fOff = emu.animationFrames(4, 8).at(-1)!;
  check(same(tileBytes(fOn.vram, 0x2f0, 16), alt.subarray(0xc00, 0xe00)) && same(tileBytes(fOff.vram, 0x2f0, 16), alt.subarray(0xe00, 0x1000)), 'in the editor: tiles 2F0–2FF show the ON and the OFF frame');
  emu.load(0x105);
  const colors = new Set(emu.animationFrames(16, 8).map((f) => f.cgram[0x78 * 2] | (f.cgram[0x78 * 2 + 1] << 8)));
  const want = new Set([0, 4, 8, 12].map((o) => alt[o] | (alt[o + 1] << 8)));
  check(colors.size > 1 && [...colors].every((c) => want.has(c)), `in the editor: color 78 cycles through the file's colors (${[...colors].map((c) => c.toString(16)).join(' ')})`);

  // in test play: entered from the overworld
  const tl = levelTranslevel(rom, 0x105);
  emu.startGame(tl);
  emu.loadInGame(0x105, tl, { onOffSwitch: true });
  const play = emu.animationFrames(4, 8).at(-1)!;
  check(same(tileBytes(play.vram, 0x2f0, 16), alt.subarray(0xe00, 0x1000)), 'in test play: the OFF frame');

  // removed: the global list and its Anim graphic as before
  const warnings = await removePackage(rom, pkg.id, opt.blank);
  const after = readGlobalList(rom);
  check(after?.slots.size === 1 && after.slots.get(0)!.dest === (0x8000 | 0x0700), `removed: the global list as before (${[...after?.slots.keys() ?? []].map(hx).join(' ')}) ${warnings.join(' ')}`);
  check(readAltFile(rom, 0)?.length === 0x20, `removed: ${altFileName(0)} its size before (${readAltFile(rom, 0)?.length})`);
  check(!listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the ROM as before (${romDiff(before, rom.data)} bytes differ)`);
}

// ---------- the level setup and the sample level: not the package's ----------

// On-Off Blocks (its sample level with an ExAnimation, frames from its AN2) with the global animation: the
// level setup and the sample level copy frames into level 105's Anim graphic A, the global slots theirs into
// the global list's Anim graphic B. Those level edits are not the package's: its record is the one of an
// install without them (the global animation's frames in B, B's size before).
{
  const onoff = unzipSync(new Uint8Array(readFileSync('test/fixtures/On-Off Block.zip')));
  const record = async (setup: boolean) => {
    const { rom, opt } = await target();
    const own = emptyList();
    own.altFile = 1;
    own.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 0, dest: 0x8000 | 0x0700, frames: [0] });
    writeAltFile(rom, 1, new Uint8Array(0x20).fill(0x5a));
    writeGlobalList(rom, own);
    const l = new LevelEmulator(rom).load(0x105);
    const o: InstallOptions = setup ? { ...opt, setup: true, cgram: l.cgram, wram: l.wram, sample: loadLevel(rom, 0x105) } : opt;
    const r = await installPackage(rom, ready(inspectUpload('anim.zip', zipSync({ ...onoff, [BPS]: bps, [ALT]: alt }))), o);
    const all = listPackages(rom);
    return { ok: r.ok && all.length === 1, a: readAltFile(rom, 0)?.length ?? 0, sample: !!r.sample, pkg: all[0], rec: recordShape(all[0]), errors: r.errors };
  };
  const plain = await record(false), full = await record(true);
  check(plain.ok && full.ok && full.sample && plain.a === 0 && full.a > 0, `installed with and without the level setup and the sample level, which copy frames into ${altFileName(0)} (${full.a}) ${full.errors.join(' ')}`);
  check(plain.pkg?.globalAnim?.graphic?.join() === [1, 0x20].join(), `the global animation's frames: in ${altFileName(1)}, its size before 20 (${plain.pkg?.globalAnim?.graphic?.join()})`);
  check(full.rec === plain.rec, `the record with the level setup and the sample level: the one without them (graphic ${full.pkg?.globalAnim?.graphic?.join()})`);
}

// ---------- the clean game's bytes no longer in the ROM ----------

{
  const { rom, opt } = await target();
  // the bytes of the clean game the list takes, found by asking for them
  const asked = new Set<number>();
  const clean = cleanGameBytes(rom)!;
  globalAnimList(bps, (o) => { asked.add(o); return clean(o); });
  const o = [...asked][0];
  rom.data[o] ^= 0xff;
  const plan = planUpload(rom, upload(), opt.blank);
  check(plan.globalAnim === null && plan.notes.some((n) => /clean game/.test(n)), `a byte it takes from the clean game changed in the ROM: not taken over (${plan.notes.find((n) => /clean game/.test(n))})`);
}

// ---------- no free slot ----------

{
  const { rom, opt } = await target();
  const full = emptyList();
  for (let k = 0; k < 0x1e; k++) full.slots.set(k, { type: 0x16, trigger: 0, framesLess1: 0, dest: 0, frames: [0] });
  writeGlobalList(rom, full);
  const r = await installPackage(rom, upload(), opt);
  const g = readGlobalList(rom)!;
  check(r.ok && g.slots.size === 0x20 && r.warnings.some((w) => /no free slot/i.test(w) && w.includes('5 slot(s)')), `2 free slots: 2 of them in, 5 left out with a note (${r.warnings.join(' ')})`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
