// Shared palettes as a graphics part (sharedpal.ts, pkgplan.ts): the Romhack Races baserom's
// export/shared_palettes.pal, a raw copy of the game's palette block $00:B0A0–$00:B881 (Lunar Magic's
// export). Only its colors differing from the clean game's are the package's – kept by the editor when it
// opens the clean game, as the ROM's own may have been edited since: 3 colors of BG palette 0 (14–16).
// Installed they change exactly those; removed they are as before (also when one was edited by hand
// before). A second package changing one of them is a conflict.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { SHARED_PALETTES, SHARED_PAL_SIZE, cleanSharedPalettes, sharedColorNames } from '../src/core/sharedpal.ts';
import { inspectUpload, installPackage, removePackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages, packageRemoval } from '../src/core/pkgreg.ts';
import { cleanImage, editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

const FILE = 'export/shared_palettes.pal';
const file = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')))[FILE];
const clean = new Rom(cleanImage());
const word = (d: Uint8Array, i: number) => d[i * 2] | (d[i * 2 + 1] << 8);
const color = (rom: Rom, i: number) => rom.r16(SHARED_PALETTES + i * 2);
// the colors the file changes, found here on its own: $B0C0, $B0C2, $B0C4
const CHANGED = [0x10, 0x11, 0x12];

async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  return { rom, opt: { level: 0x105, blank, tileWords: () => blank, setup: false } };
}
const upload = (name: string, files: Record<string, Uint8Array>) => ready(inspectUpload(`${name}.zip`, zipSync(files)));

// ---------- the file and the clean game's colors ----------

check(file.length === SHARED_PAL_SIZE, `the file is the palette block (${file.length} bytes)`);
{
  const changed = Array.from({ length: SHARED_PAL_SIZE / 2 }, (_, i) => i).filter((i) => word(file, i) !== color(clean, i));
  check(changed.join() === CHANGED.join(), `it differs from the clean game in colors ${changed.map((i) => hx(SHARED_PALETTES + i * 2)).join(', ')}`);
}
{
  const { rom } = await target();
  const kept = cleanSharedPalettes(rom);
  check(!!kept && kept.length === SHARED_PAL_SIZE / 2 && kept.every((c, i) => c === color(clean, i)), 'the editor keeps the clean game\'s colors when it opens it');
  check(cleanSharedPalettes(clean) === null, 'the clean game itself has no copy');
}
check(sharedColorNames(CHANGED).join('; ') === 'BG palette 0: colors 14–16', `named: ${sharedColorNames(CHANGED).join('; ')}`);
// $B0A0, $B0B0, $B190, $B318 and $B250
const OTHERS = [0, 0x08, 0x78, 0x13c, 0xd8];
check(sharedColorNames(OTHERS).join('; ') === 'Back area color 0; BG palette 0: color 02; FG palette 0: color 22; Global: $B250; Sprite palette 0: color E2',
  `other tables named: ${sharedColorNames(OTHERS).join('; ')}`);

// ---------- the package ----------

{
  const p = upload('baserom-palettes', { [FILE]: file });
  const part = p.parts.find((x) => x.file.endsWith('shared_palettes.pal'));
  check(part?.kind === 'graphics' && part.type === 'sharedpal', `a graphics part of its own (${part?.kind} ${part?.kind === 'graphics' ? part.type : ''})`);
  check(!p.notes.some((n) => /palmask/.test(n)), 'no .palmask needed');
  const { rom, opt } = await target();
  // a color of the block edited by hand before: the clean game decides, not the ROM
  rom.w16(SHARED_PALETTES + 0x20 * 2, 0x1234);
  const plan = planUpload(rom, p, opt.blank);
  check([...plan.sharedPal?.colors.keys() ?? []].join() === CHANGED.join(), `planned: the 3 colors differing from the clean game (${[...plan.sharedPal?.colors.keys() ?? []].join()})`);
  rom.w16(SHARED_PALETTES + CHANGED[0] * 2, 0x0421); // one of them too
  const before = rom.data.slice();
  const r = await installPackage(rom, p, opt);
  check(r.ok, `installed ${r.errors.join(' ')}`);
  const differs = Array.from({ length: SHARED_PAL_SIZE / 2 }, (_, i) => i).filter((i) => color(rom, i) !== word(before.subarray(snesToPc(SHARED_PALETTES)), i));
  check(differs.join() === CHANGED.join() && CHANGED.every((i) => color(rom, i) === word(file, i)), `exactly its colors changed (${differs.join()})`);
  check(color(rom, 0x20) === 0x1234, 'the hand-edited color not its own stays');
  const pkg = listPackages(rom)[0];
  check(packageRemoval(pkg).some((s) => s.includes('BG palette 0: colors 14–16')), `removal says so: ${packageRemoval(pkg).join('; ')}`);

  // a second package changing one of them (and one other)
  const other = clean.bytes(SHARED_PALETTES, SHARED_PAL_SIZE);
  other[CHANGED[1] * 2] ^= 0x1f;
  other[0x40 * 2] ^= 0x1f;
  const r2 = await installPackage(rom, upload('other-palettes', { 'shared_palettes.pal': other }), opt);
  check(!r2.ok && r2.errors.some((e) => /conflict/i.test(e) && e.includes('baserom-palettes') && e.includes('color 15') && !e.includes('14')), `a second package changing one: conflict (${r2.errors.join(' ')})`);
  check(listPackages(rom).length === 1, 'not installed');

  const warnings = await removePackage(rom, pkg.id, opt.blank);
  check(color(rom, CHANGED[0]) === 0x0421 && color(rom, CHANGED[1]) === color(clean, CHANGED[1]), 'removed: its colors set back (the hand-edited one as it was)');
  check(!listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the ROM as before (${romDiff(before, rom.data)} bytes differ) ${warnings.join(' ')}`);

  // now the other one is free to go in
  const r3 = await installPackage(rom, upload('other-palettes', { 'shared_palettes.pal': other }), opt);
  check(r3.ok && color(rom, 0x40) === word(other, 0x40), `the other package after it: installed ${r3.errors.join(' ')}`);
}

// ---------- the same colors as the clean game: nothing to install ----------

{
  const p = upload('clean-palettes', { 'shared_palettes.pal': clean.bytes(SHARED_PALETTES, SHARED_PAL_SIZE) });
  const { rom, opt } = await target();
  check(planUpload(rom, p, opt.blank).sharedPal === null, 'a copy of the clean game\'s block brings no colors');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
