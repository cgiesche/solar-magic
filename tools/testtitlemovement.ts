// Title screen movement (titlemovement.ts): the game's table found by what the title screen reads (the clean game's
// address, here only to check), its pairs decoded and encoded again, the run as the game plays it; a recording from
// scripted joypad input written in place and played by the game as recorded; a recording that doesn't fit; what death
// on the title screen does; a game that plays no table; the sync check – the title screen level changed after
// recording, the frame where the runs part; a recording of more pairs than the table holds written with the editor's
// patch (the table in free space), No Title Screen Movement's edit over it, what plays a title screen without a table.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator, titleScreenLevel } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { PAD, RAM, GM } from '../src/core/ram.ts';
import { learnMovement, runMovement, runState, titleMovement, TitleSession, writeMovement, moveFrames, movePairs, fitPairs, tableBytes, moveOfPad, MOVE,
  movementDrift, recordedTrace, compareRuns, movementFit, movementPatch, removeMovementPatch, PATCH_PAIRS } from '../src/core/titlemovement.ts';
import { loadAsar } from '../src/core/asar.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number) => n.toString(16);
const TABLE = snesToPc(0x009c1f);
const listPatchesOf = (rom: Rom) => listPatches(rom).filter((p) => p.kind === 'titlemove').length;

// scripted joypad input: the clean game's own movement as buttons held (Y's presses then come at Y's edges)
const padOf = (b: number) => ((b & ~(MOVE.yPress | MOVE.start)) << 8);

{
  const rom = fresh(), emu = new LevelEmulator(rom);
  const t0 = Date.now(), mv = learnMovement(emu)!, ms = Date.now() - t0;
  check(!!mv && mv.at === TABLE && mv.pairs.length === 34 && mv.capacity === 34 && mv.frames === 1426, `the table found at $009C1F: 34 pairs, 1426 frames (${ms} ms; at ${mv ? hex(mv.at) : '-'}, ${mv?.pairs.length} pairs, ${mv?.frames} frames)`);
  check(same(mv.pairs[0], [0x41, 0x0f]) && same(mv.pairs[33], [0x00, 0x30]), 'its first and last pair');
  check(same(mv.reads.map((a) => a & 0x7fffff).sort(), [0x009c77, 0x009c82, 0x009c93]), `read by the game's three instructions (${mv.reads.map(hex).join(', ')})`);
  check(same(tableBytes(movePairs(moveFrames(mv.pairs))), rom.data.subarray(TABLE, TABLE + 69)), 'decoded to frames and encoded again: the table\'s 69 bytes');
  check(fitPairs([[1, 10], [2, 1]], 4).length === 4 && same(moveFrames(fitPairs([[1, 10], [2, 1]], 4)), moveFrames([[1, 10], [2, 1]])) && same(fitPairs([[1, 1]], 3).flat(), [1, 1, 0, 1, 0, 1]),
    'pairs split to a table\'s length play the same frames; too few frames are filled with no button');
  check(moveOfPad(PAD.y | PAD.right) === (MOVE.y | MOVE.yPress | MOVE.right) && moveOfPad(PAD.y, PAD.y) === MOVE.y && moveOfPad(PAD.x | PAD.b | PAD.a | PAD.start, PAD.x) === (MOVE.y | MOVE.b), 'the joypad as a button byte: Y\'s press at its edge, X as Y, no A or Start');

  const t1 = Date.now(), run = runMovement(emu, mv), ms1 = Date.now() - t1;
  check(run.frames === 1426 && run.end === 'table' && run.x[1425] === 1787 && run.y[1425] === 336, `the run: 1426 frames to the table's end, Mario at 1787, 336 (${ms1} ms; ${run.frames}, ${run.end}, ${run.x[run.frames - 1]}, ${run.y[run.frames - 1]})`);
  const st = runState(emu, run, 700), w = st.wram as Uint8Array;
  check((w[RAM.marioX] | (w[RAM.marioX + 1] << 8)) === run.x[699] && w[RAM.gameMode] === GM.title, 'the machine before a frame of the run: Mario where the run has him');
  check(emu.snes.hook === null && !emu.snes.taintOn && same(rom.data, base), 'the emulator left without a hook or source tracking, the ROM as it was');
  const k = titleMovement(emu);
  check(titleMovement(emu) === k && k.run?.frames === 1426, 'kept: asked again, the same');

  // played on a machine of its own: the same way, also from a frame of the run on
  const play = new TitleSession(emu, mv, false);
  while (play.frame());
  check(play.end === 'table' && play.frames === 1426 && same(play.x, run.x), 'played frame by frame: the run');
  const part = new TitleSession(emu, mv, false, { frame: 700, state: st });
  while (part.frame());
  check(part.end === 'table' && part.frames === 1426 && same(part.x, run.x.subarray(700)), 'played from frame 700 on: the rest of the run');

  // recorded from the joypad: the clean game's own movement held as buttons for 600 frames, then right and jumps
  const script = Array.from(moveFrames(mv.pairs).subarray(0, 600), padOf);
  const rec = new TitleSession(emu, mv, true);
  for (const p of script) rec.frame(p);
  const recRun = rec.run();
  check(rec.end === null && rec.frames === 600 && rec.buttons.length === 600 && same(rom.data, base), `recorded: 600 frames, ${rec.pairs.length} pairs, the ROM untouched`);
  writeMovement(rom, mv, rec.buttons, recRun);
  const after = titleMovement(emu), mv2 = after.movement!, run2 = after.run!;
  check(mv2.at === TABLE && mv2.pairs.length === 34 && mv2.frames === 600 && same(moveFrames(mv2.pairs), rec.buttons) && rom.data[TABLE + 68] === 0xff, 'written in place: the table\'s 34 pairs, the recording\'s frames');
  check(run2.end === 'table' && run2.frames === 600 && same(run2.x, recRun.x) && same(run2.y, recRun.y), `the game plays it as recorded: Mario's way frame by frame (ends at ${run2.x[run2.frames - 1]}, ${run2.y[run2.frames - 1]})`);

  // the sync check: the run as recorded is in the ROM; the title screen level's sprites removed, the runs part
  const tr = recordedTrace(rom);
  check(!!tr && same(tr.x, recRun.x) && same(tr.y, recRun.y) && tr.end === 'table' && movementDrift(emu) === null, 'the run as recorded is written with it: in sync');
  {
    const saved = rom.data.slice(), n = titleScreenLevel(rom)!, lv = loadLevel(rom, n), had = lv.sprites.length;
    lv.sprites = [];
    saveLevel(rom, lv);
    const t2 = Date.now(), d = movementDrift(emu), ms2 = Date.now() - t2;
    check(had > 0 && !!d && d.since === 'recorded' && d.frame > 0 && d.frame < 600 && !!d.was && d.was.x === recRun.x[d.frame] && (!d.now || d.now.x !== d.was.x || d.now.y !== d.was.y),
      `level ${hex(n)} without its ${had} sprites: out of sync, the runs part at frame ${d?.frame} (${ms2} ms; Mario at ${d?.now?.x}, ${d?.now?.y}, was at ${d?.was?.x}, ${d?.was?.y}; ends ${d?.endNow})`);
    rom.writeAt(0, saved);
    check(movementDrift(emu) === null, 'the change taken back: in sync again');
  }

  // a recording of more pairs than the table holds
  const busy = Array.from({ length: 80 }, (_, f) => (f & 1 ? MOVE.right : MOVE.left));
  const fit = movementFit(rom, mv2, busy);
  check(fit.how === 'patch', `a recording of 80 pairs needs the table in free space (${fit.how})`);
}

// more pairs than the game's table holds: the editor's patch, the table in free space
await loadAsar();
{
  const rom = fresh(), emu = new LevelEmulator(rom), mv = learnMovement(emu)!;
  check(!mv.patched && movementFit(rom, mv, moveFrames(mv.pairs)).how === 'place', 'the clean game\'s table: a recording of its pairs is written in place');
  // the clean game's movement for 500 frames, Up held every other 8 frames besides: many pairs
  const script = Array.from(moveFrames(mv.pairs).subarray(0, 500), (b, f) => padOf(b) | (f & 8 ? PAD.up : 0));
  const rec = new TitleSession(emu, mv, true);
  for (const p of script) rec.frame(p);
  const n = rec.pairs.length, recRun = rec.run(), frames = rec.buttons.slice();
  check(rec.end === null && n > 34 && n <= PATCH_PAIRS && movementFit(rom, mv, frames).how === 'patch', `recorded: 500 frames, ${n} pairs – more than the table's 34 (end ${rec.end}, ${rec.frames} frames)`);
  const how = writeMovement(rom, mv, frames, recRun), k = titleMovement(emu), mv2 = k.movement!, run2 = k.run!;
  check(how === 'patch' && !!movementPatch(rom) && mv2.patched && mv2.capacity === PATCH_PAIRS && mv2.at >= 0x80000 && mv2.pairs.length === n && same(moveFrames(mv2.pairs), frames),
    `written with the patch: the table in free space (pc ${hex(mv2.at)}), its ${n} pairs, room for ${mv2.capacity}`);
  check(run2.end === 'table' && run2.frames === 500 && same(run2.x, recRun.x) && same(run2.y, recRun.y) && movementDrift(emu) === null, `the game plays it as recorded: Mario's way frame by frame, in sync (${run2.end}, ${run2.frames} frames)`);
  // the game goes on to load the title screen again after the table's end
  const s = emu.snes;
  s.loadState(emu.bootState());
  let back = -1;
  for (let f = 0; f < 1200 && back < 0; f++) { s.runFrame(); if (f > 520 && s.wram[RAM.gameMode] === GM.title) back = f; }
  check(back > 500, `after its end the game loads the title screen again (in its mode again at frame ${back})`);

  // recorded again with the patch installed: a recording on the patched game, applied anew – also a short one
  const rec2 = new TitleSession(emu, mv2, true);
  for (const p of script.slice(0, 300)) rec2.frame(p);
  check(same(rec2.x, recRun.x.subarray(0, 300)), 'recording on the patched game: the buttons fed through the table in free space');
  writeMovement(rom, mv2, rec2.buttons, rec2.run());
  const k3 = titleMovement(emu);
  check(k3.movement!.patched && k3.run!.frames === 300 && same(k3.run!.x, recRun.x.subarray(0, 300)) && listPatchesOf(rom) === 1, 'written again: the patch applied anew with the new table, once in the registry');
  let no = '';
  try { writeMovement(rom, k3.movement!, Array.from({ length: 600 }, (_, f) => (f & 1 ? MOVE.right : MOVE.left))); } catch (e) { no = String(e); }
  check(/600 pairs/.test(no) && /254/.test(no), `a recording of 600 pairs is not written (${no})`);

  // No Title Screen Movement's edit over the patch: no buttons, as over the game's own code
  const withPatch = rom.data.slice();
  rom.writeAt(snesToPc(0x009c82), Uint8Array.from([0xea, 0xa9, 0x00]));
  const k4 = titleMovement(emu);
  s.loadState(emu.bootState());
  let held = 0;
  for (let f = 0; f < 200; f++) { s.runFrame(); held |= s.wram[RAM.padHeld]; }
  check(k4.movement === null && k4.plays === 'none' && held === 0 && s.wram[RAM.gameMode] === GM.title, `No Title Screen Movement's edit over the patch: no button held, the title screen goes on (${k4.plays})`);
  rom.writeAt(0, withPatch);

  // the patch removed: the game's own code and table again
  // a patch of the place beside it: refused by the registry
  const ntsm = applyPatch(rom, { name: 'No buttons', main: 'a.asm', files: new Map([['a.asm', 'lorom\norg $009C82\n  NOP : LDA #$00\n']]) });
  check(!ntsm.ok && ntsm.errors.some((e) => /Title screen movement table/.test(e)), `a patch that changes the hooks is refused while the patch is installed (${ntsm.errors.join(' ')})`);
  removeMovementPatch(rom);
  const k5 = titleMovement(emu);
  check(!movementPatch(rom) && recordedTrace(rom) === null && k5.movement!.at === TABLE && !k5.movement!.patched && k5.movement!.frames === 1426 && k5.run!.end === 'table' && movementDrift(emu) === null,
    'the patch removed: the game\'s table in place again, in sync as seen now');
}

// what plays the title screen where it is no table
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  check(titleMovement(emu).plays === 'table', 'the clean game: its table');
  rom.writeAt(snesToPc(0x009c6c), Uint8Array.from([0x4c, 0x9c, 0x9c])); // JMP to the level's frame: the joypad as read
  const k = titleMovement(emu);
  check(k.movement === null && k.plays === 'player', `the joypad passed on to the level: played by the player (${k.plays})`);
}
// the table read by other code than the game's own: the editor's patch does not fit
{
  const rom = fresh();
  rom.writeAt(snesToPc(0x009c98), Uint8Array.from([0x29, 0xbf])); // AND #$BF instead of #$9F
  const emu = new LevelEmulator(rom), mv = learnMovement(emu)!, fit = movementFit(rom, mv, Array.from({ length: 80 }, (_, f) => f & 1));
  check(!!mv && fit.how === 'none' && /other code/.test(fit.why), `the code around the reads changed: a longer recording is refused (${fit.how === 'none' ? fit.why : fit.how})`);
}

// the sync check of a movement without a recorded run (the clean game's): against its run as first seen
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  check(recordedTrace(rom) === null && movementDrift(emu) === null, 'the clean game\'s movement: no recorded run, in sync as first seen');
  const first = titleMovement(emu).run!, n = titleScreenLevel(rom)!, lv = loadLevel(rom, n);
  lv.sprites = [];
  saveLevel(rom, lv);
  const d = movementDrift(emu);
  check(!!d && d.since === 'opened' && d.frame > 0 && d.frame < first.frames, `its level without sprites: out of sync since the ROM was opened, the runs part at frame ${d?.frame} (ends ${d?.endNow} after ${d?.framesNow} frames, ended ${d?.endWas} after ${d?.framesWas})`);
  const t = { x: Int16Array.of(1, 2, 3), y: Int16Array.of(0, 0, 0), end: 'table' as const };
  const c1 = compareRuns(t, { ...t, x: Int16Array.of(1, 2), y: Int16Array.of(0, 0), end: 'died' }), c2 = compareRuns(t, { ...t, end: 'left' });
  check(compareRuns(t, t) === null && c1?.frame === 2 && c1.now === null && c1.was?.x === 3 && c1.endNow === 'died' && c2?.frame === 3 && c2.endNow === 'left', 'runs compared: the same; one ends sooner; one ends another way');
}

// death on the title screen: holding right, Mario dies within a few seconds – the recording ends there; in the game it is
// a game over, after which the title screen level loads as a level to play
{
  const rom = fresh(), emu = new LevelEmulator(rom), mv = learnMovement(emu)!;
  const rec = new TitleSession(emu, mv, true);
  while (rec.frame(PAD.right) && rec.frames < 600);
  check(rec.end === 'died' && rec.frames < 200 && !rec.frame(PAD.right), `Mario dies: the recording ends (frame ${rec.frames})`);
  rom.writeAt(mv.at, tableBytes([[MOVE.right, 255], [MOVE.right, 255]]));
  const s = emu.snes, w = s.wram, modes: number[] = [];
  const run = runMovement(emu, learnMovement(emu)!);
  check(run.end === 'died' && run.frames === rec.frames, 'the same table played: the run ends with his death at that frame');
  s.loadState(emu.bootState());
  for (let f = 0; f < 800; f++) { s.runFrame(); if (modes[modes.length - 1] !== w[RAM.gameMode]) modes.push(w[RAM.gameMode]); }
  check(w[RAM.lives] === 0xff && modes.includes(0x16) && w[RAM.gameMode] === GM.level && w[RAM.introLevel] !== 0, `in the game: a game over, then the title screen level as a level (modes ${modes.map(hex).join(' ')})`);
}

// a game that reads no buttons from a table (No Title Screen Movement's edit: $009C82 = NOP : LDA #$00)
{
  const rom = fresh();
  rom.writeAt(snesToPc(0x009c82), Uint8Array.from([0xea, 0xa9, 0x00]));
  const emu = new LevelEmulator(rom), k = titleMovement(emu);
  check(k.movement === null && k.run === null, 'a game that plays no table: no movement');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
