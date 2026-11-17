// The overworld's layer 1 tiles as a graphics part (owtilebps.ts, pkgplan.ts, #509): the Romhack Races baserom's
// export/global/overworld.bps, a BPS from the clean game to a ROM Lunar Magic saved its overworld in. The baserom's
// GFX08 and GFX1E have other pictures where the game's path pieces were, and its overworld's layer 1 Map16 no longer
// draws them: 21 of the game's tiles 00–C0 differ from the clean game's. Only those are the package's. Installed
// they change exactly those – no path tile draws an 8x8 tile the baserom's graphics changed; removed they are as
// before. A second package changing one of them is a conflict.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { applyBps, createBps } from '../src/core/bps.ts';
import { OW_L1_TILES, GAME_OW_TILES, GAME_OW_MAP16, owTileWords, setOwTileWords } from '../src/core/overworld.ts';
import { isOwTileBps } from '../src/core/owtilebps.ts';
import { inspectUpload, installPackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages, packageRemoval, packageSummary, uninstallPackage } from '../src/core/pkgreg.ts';
import { cleanImage, editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const FILE = 'export/global/overworld.bps';
const zip = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const file = zip[FILE];
const clean = new Rom(cleanImage());
// (the clean game without its copier header, as the patches take it)
const cleanData = (): Uint8Array => clean.data.slice();
// the ROM Lunar Magic saved, the patch applied to the clean game here
const lm = new Rom(applyBps(cleanData(), file));
// the tiles the file changes, found here on its own
const CHANGED = [0x03, 0x05, 0x0b, 0x0d, 0x0e, 0x15, 0x16, 0x1b, 0x1c, 0x1d, 0x1e, 0x28, 0x29, 0x2b, 0x2c, 0x2f, 0x31, 0x32, 0x36, 0x3b, 0xbd];
const words = (rom: Rom, t: number) => owTileWords(rom, t).join();
const all = (rom: Rom) => Array.from({ length: OW_L1_TILES }, (_, t) => words(rom, t));

async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  return { rom, opt: { level: 0x105, blank, tileWords: () => blank, setup: false } };
}
const upload = (name: string, files: Record<string, Uint8Array>) => ready(inspectUpload(`${name}.zip`, zipSync(files)));

// ---------- the file ----------

{
  const differs = Array.from({ length: GAME_OW_TILES }, (_, t) => t).filter((t) => words(lm, t) !== words(clean, t));
  check(differs.join() === CHANGED.join(), `it differs from the clean game in tiles ${differs.map(hx).join(' ')}`);
  check(isOwTileBps(file), 'told from the patch alone');
  check(!isOwTileBps(zip['export/global/exanimation.bps']) && !isOwTileBps(zip['export/global/titlescreen.bps']) && !isOwTileBps(zip['export/global/credits.bps']),
    'the baserom\'s other Lunar Magic data are none');
}

// ---------- the package ----------

{
  // the whole baserom (a Callisto project): the file is its overworld tiles
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'))));
  const part = p.parts.find((x) => x.file.endsWith(FILE));
  check(part?.kind === 'graphics' && part.type === 'owtiles', `the baserom brings it as its overworld tiles (${part?.kind ?? 'not a part'})`);
  check(p.notes.some((n) => n.includes(FILE) && /layer 1 tiles/.test(n)), `the note on its overworld says what is taken: ${p.notes.find((n) => n.includes(FILE))}`);
}

{
  const p = upload('baserom-overworld', { [FILE]: file });
  const part = p.parts.find((x) => x.file.endsWith('overworld.bps'));
  check(part?.kind === 'graphics' && part.type === 'owtiles', `a graphics part of its own (${part?.kind} ${part?.kind === 'graphics' ? part.type : ''})`);
  const { rom, opt } = await target();
  // a tile edited by hand before, not one of the package's: the clean game decides, not the ROM
  setOwTileWords(rom, 0x40, [0x122, 0x122, 0x122, 0x122]);
  const plan = planUpload(rom, p, opt.blank);
  check([...plan.owTiles?.tiles.keys() ?? []].join() === CHANGED.join(), `planned: the 21 tiles differing from the clean game (${[...plan.owTiles?.tiles.keys() ?? []].map(hx).join(' ')})`);
  setOwTileWords(rom, CHANGED[0], [0x1d6, 0x1d6, 0x1d6, 0x1d6]); // one of them too
  const before = rom.data.slice(), was = all(rom);
  const r = await installPackage(rom, p, opt);
  check(r.ok, `installed ${r.errors.join(' ')}`);
  const now = all(rom);
  const differs = now.flatMap((w, t) => (w !== was[t] ? [t] : []));
  check(differs.join() === CHANGED.join() && CHANGED.every((t) => now[t] === words(lm, t)), `exactly its tiles changed, to the file's (${differs.map(hx).join(' ')})`);
  check(r.warnings.some((w) => w.includes(`tile ${hx(CHANGED[0])}`) && /own changes/.test(w)), `the hand-edited tile it replaces is named: ${r.warnings.join(' ')}`);
  check(now[0x40] === '290,290,290,290', 'the hand-edited tile not its own stays');
  // the 8x8 tiles the baserom's GFX08 and GFX1E changed: the path tiles draw none of them (BD does: its picture moved there)
  const GONE = new Set([0x16e, 0x16f, 0x17e, 0x17f, 0x1dc, 0x1dd, 0x1ec, 0x1ed]);
  const drawing = Array.from({ length: GAME_OW_TILES }, (_, t) => t).filter((t) => owTileWords(rom, t).some((w) => GONE.has(w & 0x3ff)));
  check(drawing.join() === String(0xbd), `no tile but BD draws an 8x8 tile the baserom's graphics changed (${drawing.map(hx).join(' ')})`);
  const pkg = listPackages(rom)[0];
  check(packageSummary(pkg).some((s) => /Overworld layer 1 tiles/.test(s)), `the package names them: ${packageSummary(pkg).join(', ')}`);
  check(packageRemoval(pkg).some((s) => /21 overworld layer 1 tile/.test(s)), `removal says so: ${packageRemoval(pkg).join('; ')}`);

  // a second package changing one of them (and one other)
  const o = new Rom(cleanData());
  o.w16(GAME_OW_MAP16 + CHANGED[1] * 8, 0x1d6);
  o.w16(GAME_OW_MAP16 + 0x50 * 8, 0x1d6);
  const p2 = upload('other-overworld', { 'overworld.bps': createBps(cleanData(), o.data) });
  const conflicts = planUpload(rom, p2, opt.blank).conflicts;
  check(conflicts.length === 1 && conflicts[0].includes('baserom-overworld') && conflicts[0].includes(`tile ${hx(CHANGED[1])}`) && !conflicts[0].includes('50'), `the preview's plan shows the conflict (${conflicts.join(' ')})`);
  const r2 = await installPackage(rom, p2, opt);
  check(!r2.ok && r2.errors.some((e) => /conflict/i.test(e) && e.includes('baserom-overworld')), `a second package changing one: conflict (${r2.errors.join(' ')})`);
  check(listPackages(rom).length === 1, 'not installed');

  const warnings = await uninstallPackage(rom, pkg.id, opt.blank);
  check(words(rom, CHANGED[0]) === was[CHANGED[0]] && words(rom, CHANGED[1]) === words(clean, CHANGED[1]), 'removed: its tiles set back (the hand-edited one as it was)');
  check(!listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the ROM as before (${romDiff(before, rom.data)} bytes differ) ${warnings.join(' ')}`);

  // now the other one is free to go in
  const r3 = await installPackage(rom, upload('other-overworld', { 'overworld.bps': createBps(cleanData(), o.data) }), opt);
  check(r3.ok && owTileWords(rom, 0x50)[0] === 0x1d6, `the other package after it: installed ${r3.errors.join(' ')}`);

  // one of its tiles edited after the install: removing leaves that one and says so
  setOwTileWords(rom, 0x50, [0x1d7, 0x1d7, 0x1d7, 0x1d7]);
  const w3 = await uninstallPackage(rom, r3.pkg!.id, opt.blank);
  check(owTileWords(rom, 0x50)[0] === 0x1d7 && words(rom, CHANGED[1]) === words(clean, CHANGED[1]) && w3.some((w) => w.includes('tile 50') && /changed since/.test(w)),
    `a tile edited since stays when the package is removed, the other is set back: ${w3.join(' ')}`);
}

// ---------- the clean game's overworld: nothing to install ----------

{
  // (a patch bringing bytes of the tiles that are the clean game's)
  const a = new Rom(cleanData());
  a.w16(GAME_OW_MAP16 + 8, a.r16(GAME_OW_MAP16 + 8) ^ 1);
  const one = createBps(cleanData(), a.data);
  check(isOwTileBps(one), 'a patch changing one tile is one');
  check(!isOwTileBps(createBps(cleanData(), cleanData())), 'a patch changing nothing is none');
  // two tiles swapped: the patch brings no byte of its own (it copies the clean game's from the other tile)
  const s = new Rom(cleanData());
  const t3 = s.bytes(GAME_OW_MAP16 + 0x03 * 8, 8), t60 = s.bytes(GAME_OW_MAP16 + 0x60 * 8, 8);
  s.writeBytes(GAME_OW_MAP16 + 0x03 * 8, t60);
  s.writeBytes(GAME_OW_MAP16 + 0x60 * 8, t3);
  const swap = createBps(cleanData(), s.data);
  const { rom, opt } = await target();
  const plan = planUpload(rom, upload('swapped', { 'overworld.bps': swap }), opt.blank);
  check(isOwTileBps(swap) && [...plan.owTiles?.tiles.keys() ?? []].join() === '3,96', `a patch swapping two tiles is one: tiles ${[...plan.owTiles?.tiles.keys() ?? []].map(hx).join(' ')}`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
