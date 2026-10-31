// Path tiles (owpaths.ts): the kind of every layer 1 tile – walk, climb, swim, exit, stop, level or none –
// learned by moving Mario onto it in the emulator. Checked against the clean game's own tables (read here
// as the test's independent knowledge, the editor reads none of them): its path tiles 01–51 by the pose
// each gives Mario ($049FEB: bit 3 swimming, bit 4 climbing; 52–55 read past it) and its list of exit tiles ($049426); a
// patched game's tile shows what it does there; editing the overworld's data keeps the result.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomReads, ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { JobRunner } from '../src/core/jobrunner.ts';
import { pathKindsJob, PATH_KINDS, type PathKind } from '../src/core/owpaths.ts';
import {
  readL1, writeL1, readL2, writeL2, readTranslevels, writeTranslevels, setInitialFlags, setExitDirection, setNameCode, FLAG, MAX_TRANSLEVEL,
} from '../src/core/overworld.ts';
import { editorImage, cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

// the job run to its end as the result learner runs it, with what it read
function learn(rom: Rom): { kinds: PathKind[]; reads: RomReads } {
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) });
  const run = runner.run({ key: 'owpk', keep: false, picture: false, start: pathKindsJob });
  for (;;) { const r = runner.step('owpk', run); if (r) return { kinds: r.result, reads: run.reads }; }
}

const image = await editorImage();
const rom = new Rom(image.slice());
const t0 = performance.now();
const { kinds, reads } = learn(rom);
console.log(`learned in ${Math.round(performance.now() - t0)} ms`);
check(kinds.length === 0x100, '256 tiles');

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
  check(kinds[0] === 'none' && Array.from({ length: 0x100 - 0x87 }, (_, k) => kinds[k + 0x87]).every((k) => k === 'none'), 'tile 00 and 87–FF: no path');
  check(kinds[0x56] === 'level' && kinds[0x80] === 'level', 'level tiles 56, 80: enter a level');
  check([0x81, 0x82, 0x86].every((t) => kinds[t] === 'stop'), 'tiles 81, 82, 86: Mario stops, enters no level');
}

// ---- kept while the overworld is edited ----
{
  const r = new Rom(rom.data.slice());
  const before = r.data.slice();
  const l1 = readL1(r), l2 = readL2(r), tls = readTranslevels(r);
  l1.fill(0x04, 0, 0x40); l2.fill(0x0123, 0, 0x100); tls[0x10] = 0x30;
  writeL1(r, l1); writeL2(r, l2); writeTranslevels(r, tls);
  setInitialFlags(r, 0x29, 0x8f); setExitDirection(r, 0x29, 0, 3); setNameCode(r, 0x29, 0x0123);
  check(!reads.differ(before, r.data), 'layer 1, layer 2, translevels, initial flags, exit directions, a name changed: the kinds hold');
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

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('path tiles ok');
