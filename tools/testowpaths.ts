// Path tiles (owpaths.ts): the kind of every layer 1 tile – walk, climb, swim, exit, stop, warp, level or none –
// learned by moving Mario onto it in the emulator. Checked against the clean game's own tables (read here
// as the test's independent knowledge, the editor reads none of them): its path tiles 01–51 by the pose
// each gives Mario ($049FEB: bit 3 swimming, bit 4 climbing; 52–55 read past it) and its list of exit tiles ($049426); a
// patched game's tile shows what it does there; editing the overworld's data keeps the result.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomReads, ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { JobRunner } from '../src/core/jobrunner.ts';
import { pathKindsJob, levelTileTest, PATH_KINDS, type PathKind, OVERWORLD_DATA } from '../src/core/owpaths.ts';
import {
  readL1, writeL1, readL2, writeL2, readTranslevels, writeTranslevels, placeTile, setInitialFlags, setExitDirection, FLAG, MAX_TRANSLEVEL,
} from '../src/core/overworld.ts';
import { setLevelNameTiles, encodeName } from '../src/core/levelnames.ts';
import { writeTeleport } from '../src/core/owteleport.ts';
import { loadAsar } from '../src/core/asar.ts';
import { editorImage, cleanImage, applyHardPathsPatch } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

// the job run to its end as the result learner runs it, with what it read
function learn(rom: Rom): { kinds: PathKind[]; reads: RomReads } {
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) });
  const run = runner.run({ key: 'owpk', keep: false, shows: 'behaviour', leavesOut: OVERWORLD_DATA, start: pathKindsJob });
  for (;;) { const r = runner.step('owpk', run); if (r) return { kinds: r.result, reads: run.reads }; }
}

const image = await editorImage();
const rom = new Rom(image.slice());
const t0 = performance.now();
const { kinds, reads } = learn(rom);
console.log(`learned in ${Math.round(performance.now() - t0)} ms`);
check(kinds.length === 0x200, '512 tiles (pages 0 and 1)');

// ---- the clean game's path tiles ----
{
  const clean = new Rom(cleanImage());
  const r8 = (a: number) => clean.data[snesToPc(a)];
  const exits = new Set(Array.from({ length: 10 }, (_, i) => r8(0x049426 + i)));
  const expected = (t: number): PathKind => {
    if (exits.has(t)) return 'exit';
    const pose = r8(0x049feb + t - 1);
    return pose & 0x10 ? 'climb' : pose & 0x08 ? 'swim' : 'walk';
  };
  const used = [...new Set(readL1(clean))].filter((t) => t > 0 && t < 0x52).sort((a, b) => a - b);
  const wrong = used.filter((t) => kinds[t] !== expected(t));
  check(!wrong.length, `the ${used.length} path tiles on the clean game's map: ${wrong.length ? wrong.map((t) => `${hx(t)} ${kinds[t]} (${expected(t)})`).join(', ') : 'as its tables'}`);
  const all = Array.from({ length: 0x51 }, (_, k) => k + 1).filter((t) => kinds[t] !== expected(t));
  check(!all.length, `every path tile 01–51 as the game's tables (${all.map(hx).join(' ')})`);
  const count = (k: PathKind) => kinds.filter((v) => v === k).length;
  console.log(`     ${PATH_KINDS.map((k) => `${k} ${count(k)}`).join(', ')}`);
  check(kinds[0x05] === 'walk' && kinds[0x28] === 'swim' && kinds[0x3f] === 'climb' && kinds[0x44] === 'exit', 'walk 05, swim 28, climb 3F, exit 44');
  // 55: the look-ahead onto the tile after it comes in the same frame as the one onto it – its kind by the pose the
  // look-ahead gave on 55 (0F, read past the game's pose table: bit 3, swimming), not by the next tile's
  check(kinds[0x55] === 'swim' && kinds[0x155] === 'swim', `swim 55, 155: the pose the look-ahead gave on it (${kinds[0x55]}, ${kinds[0x155]})`);
  check(kinds[0] === 'none' && Array.from({ length: 0x100 - 0x87 }, (_, k) => kinds[k + 0x87]).every((k) => k === 'none'), 'tile 00 and 87–FF: no path');
  check(kinds[0x56] === 'level' && kinds[0x80] === 'level', 'level tiles 56, 80: enter a level');
  check([0x81, 0x86].every((t) => kinds[t] === 'stop'), 'tiles 81, 86: Mario stops, enters no level, A does nothing');
  // (A on 5F, 82 or 5B looks Mario's place up in the star/pipe table, $04915E, $04917D: a warp where it has an entry)
  check([0x5b, 0x5f, 0x82].every((t) => kinds[t] === 'warp'), `tiles 5B, 5F, 82: A warps (${[0x5b, 0x5f, 0x82].map((t) => kinds[t]).join(', ')})`);
  const warps = kinds.flatMap((k, t) => (k === 'warp' ? [t] : []));
  check(warps.join() === [0x5b, 0x5f, 0x82, 0x15b, 0x15f, 0x182].join(), `the warp tiles: 5B, 5F, 82 on both pages (${warps.map(hx).join(' ')})`);
  const level = levelTileTest(kinds), levels = Array.from({ length: 0x100 }, (_, t) => t).filter(level);
  // (the game's scan gives 56–80 a translevel, $04D838; A on 5F or 5B looks Mario's place up in the star and pipe
  // places, $049161, $049184, and enters no level)
  const want = Array.from({ length: 0x2b }, (_, k) => k + 0x56).filter((t) => t !== 0x5b && t !== 0x5f);
  check(levels.join() === want.join(), `the level tiles: 56–80 without 5B and 5F (${levels.length})`);
}

// ---- kept while the overworld is edited ----
{
  const r = new Rom(rom.data.slice());
  const before = r.data.slice();
  const l1 = readL1(r), l2 = readL2(r), tls = readTranslevels(r);
  l1.fill(0x04, 0, 0x40); l2.fill(0x0123, 0, 0x100); tls[0x10] = 0x30;
  writeL1(r, l1); writeL2(r, l2); writeTranslevels(r, tls);
  setInitialFlags(r, 0x29, 0x8f); setExitDirection(r, 0x29, 0, 3); setLevelNameTiles(r, 0x29, encodeName('A NAME').tiles);
  writeTeleport(r, 0x40, { from: { submap: 1, x: 3, y: 4 }, to: { submap: 2, x: 5, y: 6 } });
  check(!reads.differ(before, r.data), 'layer 1, layer 2, translevels, initial flags, exit directions, a name, a star/pipe link changed: the kinds hold');
}

// ---- the probe's own translevel isn't taken from the map ----
{
  const r = new Rom(rom.data.slice());
  for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) setInitialFlags(r, tl, FLAG.passed | FLAG.noEntry);
  const k = learn(r).kinds;
  check(k.every((v, t) => v === kinds[t]), 'every level passed with "no entry" from the start: the same kinds');
}

// ---- a patched game ----
{
  const r = new Rom(rom.data.slice());
  r.w8(0x049feb + 0x05 - 1, 0x0c); // tile 05 swims
  check(reads.differ(rom.data, r.data), 'the game\'s code changed: the kinds are learned again');
  const k = learn(r).kinds;
  check(k[0x05] === 'swim' && k[0x04] === 'walk', `tile 05 made a swimming tile: ${k[0x05]} (04: ${k[0x04]})`);
}
{
  // where A is pressed on a tile, the editor's patch ends as the game: CMP #$81 (tiles from 81 on enter nothing);
  // made CMP #$82, tile 81 enters a level – a level tile, so painting it gives it a translevel
  const r = new Rom(rom.data.slice());
  const at = Array.from({ length: 0x96 }, (_, k) => 0x03ba50 + k).find((a) => r.r8(a) === 0xc9 && r.r8(a + 1) === 0x81 && r.r8(a + 2) === 0x6b)!;
  r.w8(at + 1, 0x82);
  const k = learn(r).kinds, level = levelTileTest(k), before = levelTileTest(kinds);
  check(k[0x81] === 'level' && k[0x82] === 'warp' && level(0x81) && !before(0x81), `the game entering a level from tile 81 (CMP #$82 at ${at.toString(16)}): tile 81 ${k[0x81]}, a level tile (82 ${k[0x82]})`);
  const l1 = readL1(r), t = readTranslevels(r), i = l1.findIndex((v, j) => !t[j] && !level(v));
  placeTile(l1, t, i, 0x81, level);
  const l1b = readL1(rom), tb = readTranslevels(rom);
  placeTile(l1b, tb, i, 0x81, before);
  check(t[i] > 0 && tb[i] === 0, `tile 81 painted: a translevel there (${hx(t[i])}), none in the unpatched game`);
}

{
  // a patch changing where Mario stands once he stopped (Kevin's "Custom Overworld Hardcoded Paths": his tile from his
  // pixel position, $04952D) – after the swimming tiles 29 and 37, whose vectors leave him short of the tile after,
  // that is the probed tile's cell – while the tiles do as before: the kinds as the clean game's, a tile's kind told
  // by what the look-ahead onto it does, not by where Mario stands in the end
  await loadAsar();
  const k = learn(applyHardPathsPatch(new Rom(rom.data.slice()))).kinds;
  const differ = k.flatMap((v, t) => (v !== kinds[t] ? [`${hx(t)} ${v} (${kinds[t]})`] : []));
  check(!differ.length, `Kevin's hardcoded paths patch: the kinds as the clean game's${differ.length ? ` – ${differ.join(', ')}` : ''}`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('path tiles ok');
