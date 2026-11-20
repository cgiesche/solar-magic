// Jump arcs (jumparcs.ts): emulated jumps from a tile of a level go further with more speed and
// are stopped by walls. Learned as the editor does (jumpArcsJob on a job runner's lane, as the probe worker's), a second request in the same
// level state doesn't load the level again, an edit of a byte the load read does.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { JumpArcs, ARC_SPEEDS, jumpArcsJob, type JumpArc, type ArcLoad } from '../src/core/jumparcs.ts';
import { JobRunner } from '../src/core/jobrunner.ts';
import { learnAtOnce } from './runnercheck.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, serializeLayer1, newUid } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const prober = new BlockProber(rom);
const runs = prober.runStates();
check(runs.walk.vx > 0 && runs.run.vx > runs.walk.vx && runs.p.vx > runs.run.vx && runs.p.pmeter > runs.run.pmeter,
  `running states: walk ${runs.walk.vx}, run ${runs.run.vx}, P-speed ${runs.p.vx} (P-meter ${runs.p.pmeter})`);

// level 105 with only a flat floor of cement blocks (row 24); Mario stands in row 23
const lv = loadLevel(rom, 0x105);
lv.objects = Array.from({ length: 8 }, (_, k) => ({ uid: newUid(), num: 0, ext: DM16_EXT, x: k * 16, y: 24, size: 0x0f, tile: 0x130 }));
const arcEmu = new LevelEmulator(rom);
if (prober.emu.snapshot) arcEmu.adoptBoot(prober.emu.snapshot);
const arcs = new JumpArcs(arcEmu);
const prepare = () => arcs.prepare({ level: lv.number, ov: { layer1: serializeLayer1(rom, lv) }, spriteHeader: lv.spriteHeader, height: 27 * 16 });
check(prepare(), 'level 105 runs to gameplay');
const TX = 0x40, TY = 23;
const dist = (a: JumpArc) => Math.abs(a.pts[a.pts.length - 2] - a.pts[0]);
const right = ARC_SPEEDS.map((sp) => arcs.arc(TX, TY, sp, 1, runs));
console.log('     distances (px): ' + right.map((a) => `${a.speed} ${dist(a)} (${a.end}, ${a.pts.length / 2} frames)`).join(', '));
check(right.every((a) => a.end === 'land'), 'all jumps land');
check(right.every((a, i) => i === 0 || dist(a) > dist(right[i - 1])), 'faster runs jump further');
const top = Math.min(...right[0].pts.filter((_, i) => i & 1));
check(right[0].pts[1] - top > 48, `a full jump rises more than 3 tiles (${right[0].pts[1] - top} px)`);
const left = arcs.arc(TX, TY, 'p', -1, runs);
check(left.end === 'land' && Math.abs(dist(left) - dist(right[3])) <= 16, `to the left as far as to the right (${dist(left)})`);

// a wall 3 tiles to the right, 10 high: the P-speed jump ends next to it
lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: TX + 3, y: 14, size: 0x90, tile: 0x130 });
check(prepare(), 'level with a wall runs to gameplay');
const walled = arcs.arc(TX, TY, 'p', 1, runs);
const maxX = Math.max(...walled.pts.filter((_, i) => !(i & 1)));
check(maxX <= (TX + 3) * 16, `the wall stops the jump (Mario's middle at most at ${maxX}, wall at ${(TX + 3) * 16})`);

// the 45° slope (tile 1AA, up to the right) in the original level 105 at tile (11, 20): Mario
// starts on its surface and jumps full height in both directions, also running downhill
const orig = loadLevel(rom, 0x105);
check(arcs.prepare({ level: orig.number, ov: { layer1: serializeLayer1(rom, orig) }, spriteHeader: orig.spriteHeader, height: 27 * 16 }), 'original level 105 runs to gameplay');
for (const dir of [-1, 1] as const) {
  const sl = ARC_SPEEDS.map((sp) => arcs.arc(11, 20, sp, dir, runs));
  const rise = sl.map((a) => a.pts[1] - Math.min(...a.pts.filter((_, i) => i & 1)));
  check(sl.every((a) => a.end === 'land' && a.pts[1] > 20 * 16 && a.pts[1] < 21 * 16) && rise.every((r) => r > 48),
    `jumps ${dir < 0 ? 'down' : 'up'} the slope from its surface (${sl[0].pts[1]}) rise ${rise.join(', ')} px`);
}

// learned as the editor does: the level loaded once per level state on the runner's 'arcs' lane, again after an edit
// of a byte the load read
{
  let loads = 0;
  const prepare = JumpArcs.prototype.prepare;
  JumpArcs.prototype.prepare = function (...a) { loads++; return prepare.apply(this, a); };
  const main = new LevelEmulator(rom);
  main.boot();
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)), main });
  const load: ArcLoad = { level: orig.number, ov: { layer1: serializeLayer1(rom, orig) }, spriteHeader: orig.spriteHeader, height: 27 * 16 };
  const ask = (tx: number): JumpArc[] =>
    learnAtOnce(runner, { key: `arcs:${tx},20`, keep: false, shows: 'behaviour', start: (emu, prep) => jumpArcsJob(emu, prep, 'lv105', load, tx, 20, runs) }, 'arcs');
  const a = ask(11), b = ask(12);
  check(a.length === 8 && b.length === 8 && loads === 1, `a second request in the same level state: the level not loaded again (${loads} loads)`);
  const o = runner.emu('arcs').bootReads('behaviour')!.pages.indexOf(1) << 8;
  rom.writeAt(o, Uint8Array.of(rom.data[o] ^ 1));
  rom.writeAt(o, Uint8Array.of(rom.data[o] ^ 1)); // (changed back: the level still loads)
  const c = ask(13);
  check(c.length === 8 && loads === 2, `an edit of a byte the load read: loaded again (${loads} loads)`);
  JumpArcs.prototype.prepare = prepare;
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
