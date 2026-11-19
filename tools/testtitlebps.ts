// The title screen picture as a graphics part (titlebps.ts, pkgplan.ts, #548): the Romhack Races baserom's
// export/global/titlescreen.bps, a BPS from the clean game to a ROM Lunar Magic saved its title screen in. The
// baserom's layer 3 graphics have other pictures where the game's copyright line's letters were ("Ni89ndo"); its
// own picture doesn't draw them. Installed the game shows the file's picture; removed the ROM is as before, a
// picture the ROM had of its own back. A second package with a picture is a conflict; a picture edited after the
// install stays when the package is removed.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { applyBps, createBps } from '../src/core/bps.ts';
import { isTitleBps, titleMapOfBps } from '../src/core/titlebps.ts';
import { TITLE_COLS, TITLE_ROWS, GAME_TITLE_STRIPE, titleStripeAddr, titleTilemap, writeTitleScreen } from '../src/core/titlescreen.ts';
import { inspectUpload, installPackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages, packageRemoval, packageSummary, uninstallPackage } from '../src/core/pkgreg.ts';
import { cleanImage, editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

const FILE = 'export/global/titlescreen.bps';
const zip = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const file = zip[FILE];
const clean = new Rom(cleanImage());
const cleanData = (): Uint8Array => clean.data.slice();
const N = TITLE_COLS * TITLE_ROWS;
// the picture the game shows on the title screen
const shown = (rom: Rom) => { const e = new LevelEmulator(rom); e.boot(); return titleTilemap(e); };
// the ROM Lunar Magic saved, the patch applied to the clean game here: what its title screen shows
const lmMap = shown(new Rom(applyBps(cleanData(), file)));

async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  return { rom, opt: { level: 0x105, blank, tileWords: () => blank, setup: false } };
}
const upload = (name: string, files: Record<string, Uint8Array>) => ready(inspectUpload(`${name}.zip`, zipSync(files)));
// a patch as Lunar Magic's: the clean game with `map` as its title screen
const patchOf = (map: Uint16Array) => { const r = new Rom(cleanData()); writeTitleScreen(r, map); return createBps(cleanData(), r.data); };

// ---------- the file ----------

{
  check(isTitleBps(file), 'the baserom\'s titlescreen.bps is a title screen picture');
  check(['overworld', 'exanimation', 'credits'].every((n) => !isTitleBps(zip[`export/global/${n}.bps`])), 'its overworld, global animation and credits are none');
  check(!isTitleBps(createBps(cleanData(), cleanData())), 'a patch changing nothing is none');
  const map = titleMapOfBps(file, (o) => clean.data[o]);
  check(map instanceof Uint16Array && map.length === N && same(map, lmMap), `its 32 × 29 tiles are what Lunar Magic's ROM shows (${map instanceof Uint16Array ? map.filter((w, i) => w !== lmMap[i]).length : map} differ)`);
  check(titleMapOfBps(file, null) === 'not known' || titleMapOfBps(file, null) instanceof Uint16Array, 'without the clean game\'s bytes: read from the patch alone or not known');
  // the game's picture moved (its 17 stripes at another place): not Lunar Magic's layout
  const moved = new Rom(cleanData());
  const at = moved.allocWrite(moved.bytes(GAME_TITLE_STRIPE, 0x400));
  moved.writeBytes(0x0084d3, Uint8Array.from([at & 0xff, (at >> 8) & 0xff, at >> 16]));
  const other = createBps(cleanData(), moved.data);
  check(isTitleBps(other) && titleMapOfBps(other, (o) => clean.data[o]) === null, 'a stripe image not in Lunar Magic\'s layout: a title screen patch, its picture not read');
  const { rom, opt } = await target();
  const p = upload('moved', { 'titlescreen.bps': other });
  const plan = planUpload(rom, p, opt.blank);
  check(!plan.titlePicture && plan.notes.some((n) => /titlescreen\.bps/.test(n) && /not taken over/.test(n)), `planned: not taken over, with a note (${plan.notes.join(' ')})`);
}

// ---------- the package ----------

{
  // the whole baserom (a Callisto project): the file is its title screen picture
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'))));
  const part = p.parts.find((x) => x.file.endsWith(FILE));
  check(part?.kind === 'graphics' && part.type === 'titlepic', `the baserom brings it as its title screen picture (${part?.kind ?? 'not a part'})`);
  check(p.notes.some((n) => n.includes(FILE) && /only its picture/.test(n)), `the note on its title screen says what is taken: ${p.notes.find((n) => n.includes(FILE))}`);
}

{
  const p = upload('baserom-title', { [FILE]: file });
  const part = p.parts.find((x) => x.file.endsWith('titlescreen.bps'));
  check(part?.kind === 'graphics' && part.type === 'titlepic', `a graphics part of its own (${part?.kind} ${part?.kind === 'graphics' ? part.type : ''})`);
  const { rom, opt } = await target();
  const game = shown(rom);

  // into the clean game's title screen
  const before = rom.data.slice();
  const plan = planUpload(rom, p, opt.blank);
  check(!!plan.titlePicture && same(plan.titlePicture.map, lmMap) && !plan.conflicts.length, 'planned: the file\'s picture');
  const r = await installPackage(rom, p, opt);
  check(r.ok && !r.warnings.some((w) => /Title screen picture/.test(w)), `installed ${r.errors.join(' ')}`);
  check(same(shown(rom), lmMap), 'the game shows the file\'s picture on the title screen');
  const pkg = listPackages(rom)[0];
  check(packageSummary(pkg).some((s) => /Title screen picture/.test(s)), `the package names it: ${packageSummary(pkg).join(', ')}`);
  check(packageRemoval(pkg).some((s) => /title screen picture/.test(s)), `removal says so: ${packageRemoval(pkg).join('; ')}`);

  // a second package with a picture
  const mine = lmMap.map((w) => w ^ 0x4000);
  const p2 = upload('other-title', { 'titlescreen.bps': patchOf(mine) });
  const conflicts = planUpload(rom, p2, opt.blank).conflicts;
  check(conflicts.length === 1 && conflicts[0].includes('baserom-title') && /title screen picture/.test(conflicts[0]), `the preview's plan shows the conflict (${conflicts.join(' ')})`);
  const r2 = await installPackage(rom, p2, opt);
  check(!r2.ok && r2.errors.some((e) => /conflict/i.test(e)) && listPackages(rom).length === 1, `a second package with a picture: conflict, not installed (${r2.errors.join(' ')})`);

  const w = await uninstallPackage(rom, pkg.id, opt.blank);
  check(titleStripeAddr(rom) === GAME_TITLE_STRIPE && same(shown(rom), game), 'removed: the game\'s picture again');
  check(!listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the ROM as before (${romDiff(before, rom.data)} bytes differ) ${w.join(' ')}`);

  // over a picture the ROM has of its own: named, back when the package is removed
  writeTitleScreen(rom, mine);
  const own = rom.data.slice();
  const r3 = await installPackage(rom, p, opt);
  check(r3.ok && r3.warnings.some((x) => /Title screen picture/.test(x) && /own/.test(x)), `over the ROM's own picture: named (${r3.warnings.join(' ')})`);
  check(same(shown(rom), lmMap), 'the file\'s picture shown');
  await uninstallPackage(rom, r3.pkg!.id, opt.blank);
  check(romDiff(own, rom.data) === 0 && same(shown(rom), mine), `removed: the ROM's own picture back, the ROM as before (${romDiff(own, rom.data)} bytes differ)`);

  // the picture edited after the install: removing leaves it and says so; the picture kept for the removal is freed
  const blocks = rom.scanRats().length, ownAt = titleStripeAddr(rom);
  const r4 = await installPackage(rom, p, opt);
  check(r4.ok && titleStripeAddr(rom) !== ownAt && rom.isRatsAt(snesToPc(ownAt) - 8) > 0, 'installed again: the ROM\'s own picture kept beside the package\'s');
  const edited = lmMap.map((x) => x ^ 0x0400);
  writeTitleScreen(rom, edited);
  const w4 = await uninstallPackage(rom, r4.pkg!.id, opt.blank);
  check(same(shown(rom), edited) && w4.some((x) => /changed since/.test(x)), `a picture edited since stays when the package is removed: ${w4.join(' ')}`);
  check(rom.scanRats().length === blocks, `one picture left in the ROM (${rom.scanRats().length - blocks + 1})`);

  // the ROM's picture already the file's: nothing written, nothing recorded
  writeTitleScreen(rom, lmMap);
  const had = rom.scanRats().length, at = titleStripeAddr(rom);
  const r5 = await installPackage(rom, p, opt);
  check(titleStripeAddr(rom) === at && rom.scanRats().length === had && !(r5.pkg?.titlePicture?.length), `the ROM's picture already the file's: left where it is (${r5.ok ? 'installed' : r5.errors.join(' ')})`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
