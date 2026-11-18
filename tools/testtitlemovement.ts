// Title screen movement (titlemovement.ts): the game's table found by what the title screen reads (the clean game's
// address, here only to check), its pairs decoded and encoded again, the run as the game plays it; a recording from
// scripted joypad input written in place and played by the game as recorded; a recording that doesn't fit; what death
// on the title screen does; a game that plays no table.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PAD, RAM, GM } from '../src/core/ram.ts';
import { learnMovement, runMovement, runState, titleMovement, TitleSession, writeMovement, moveFrames, movePairs, fitPairs, tableBytes, moveOfPad, MOVE } from '../src/core/titlemovement.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number) => n.toString(16);
const TABLE = snesToPc(0x009c1f);

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
  writeMovement(rom, mv, rec.buttons);
  const after = titleMovement(emu), mv2 = after.movement!, run2 = after.run!;
  check(mv2.at === TABLE && mv2.pairs.length === 34 && mv2.frames === 600 && same(moveFrames(mv2.pairs), rec.buttons) && rom.data[TABLE + 68] === 0xff, 'written in place: the table\'s 34 pairs, the recording\'s frames');
  check(run2.end === 'table' && run2.frames === 600 && same(run2.x, recRun.x) && same(run2.y, recRun.y), `the game plays it as recorded: Mario's way frame by frame (ends at ${run2.x[run2.frames - 1]}, ${run2.y[run2.frames - 1]})`);

  // a recording of more pairs than the table holds
  const busy = Array.from({ length: 80 }, (_, f) => (f & 1 ? MOVE.right : MOVE.left));
  const before = rom.data.slice();
  let no = '';
  try { writeMovement(rom, mv2, busy); } catch (e) { no = String(e); }
  check(/80 pairs/.test(no) && /46 more/.test(no) && same(rom.data, before), `a recording of 80 pairs is not written (${no})`);
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
