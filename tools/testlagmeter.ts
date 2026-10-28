// Test play's lag meter (src/core/playlog.ts): the CPU's load in each frame (scanlines from the NMI until the
// game waits for the next one) and lag frames – the game's frame not done before the next NMI – as events with
// Mario's position. Vanilla levels played without lag, on the clean game and on the ROM as the editor opens it
// (its patches' hooks, e.g. the block interaction's, cost no lag frame; its code runs from FastROM, which the
// emulator times); eight Wigglers slow the game down where they are; the frames the game spends loading (after a
// death) are no lag of the level.
// node tools/testlagmeter.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelTranslevel } from '../src/core/level.ts';
import { LINES_PER_FRAME, type Snes } from '../src/core/snes.ts';
import { GM, RAM, marioX, marioY } from '../src/core/ram.ts';
import { PlayLog, cpuLoad, LAG } from '../src/core/playlog.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// ---------- the log: load per frame, lag frames as events with Mario's position ----------
{
  const log = new PlayLog(4);
  const used = { sprite: 0, extended: 0, cluster: 0 };
  log.frame(1, used, [], 120, 0x100, 0x150);
  log.frame(2, used, [], LAG, 0x120, 0x150);
  log.frame(3, used, [], 200, 0x124, 0x150);
  log.frame(4, used, [], LAG, 0x128, 0x150);
  log.frame(200, used, [], LAG, 0x400, 0x80);
  log.frame(201, used, [], 90, 0x400, 0x80);
  check(log.history[3].busy === 90 && log.history[2].busy === LAG, 'the history keeps each frame\'s load');
  check(log.lagFrames === 3, `lag frames counted (${log.lagFrames})`);
  check(log.lags.length === 2 && log.lags[0].frame === 2 && log.lags[0].count === 2 && log.lags[0].last === 4 && log.lags[0].tx === 0x12 && log.lags[0].ty === 0x16,
    'lag frames close together are one event (first frame, count, Mario\'s tile)');
  check(log.lags[1].frame === 200 && log.lags[1].count === 1 && log.lags[1].tx === 0x40, 'a later one is an event of its own');
  check(log.worstLag() === log.lags[0], 'the worst lag: the event with the most lag frames');
  log.cut();
  log.frame(202, used, [], LAG, 0x400, 0x80);
  check(log.lags.length === 3, 'after a savestate is loaded: a lag frame is an event of its own');
}

// ---------- what a frame's load is: the game mode on both sides of it ----------
{
  const at = (busy: number, mode: number) => ({ busyLines: busy, wram: Object.assign(new Uint8Array(0x20000), { [RAM.gameMode]: mode }) }) as unknown as Snes;
  check(cpuLoad(at(120, GM.level), GM.level) === 120, 'the game waited: its load in scanlines');
  check(cpuLoad(at(-1, GM.level), GM.level) === LAG, 'it never waited, in the level: a lag frame');
  check(cpuLoad(at(-1, GM.level), GM.level - 1) === LINES_PER_FRAME, 'the last loading frame, the level\'s mode set after the NMI: fully busy, no lag');
  check(cpuLoad(at(-1, GM.level + 1), GM.level) === LINES_PER_FRAME, 'the level left in it: fully busy, no lag');
}

// ---------- the game ----------
// the game played: the clean one, at the end the ROM as the editor opens it
let rom = new Rom(cleanImage()), emu = new LevelEmulator(rom);
const open = (image: Uint8Array) => { rom = new Rom(image); emu = new LevelEmulator(rom); emu.boot(); };
open(cleanImage());
// k frames walking right (running, jumping every 40 frames), until the level ends (stop); the log of them
function play(k: number, stop: boolean, each?: (f: number) => void): PlayLog {
  const s = emu.snes, log = new PlayLog(k);
  const used = { sprite: 0, extended: 0, cluster: 0 };
  for (let i = 0; i < 80 && s.wram[RAM.gameMode] !== GM.level; i++) s.runFrame(); // as test play starts
  for (let f = 0; f < k; f++) {
    s.joy1 = 0x0100 | 0x4000 | (f % 40 < 10 ? 0x8000 : 0);
    each?.(f);
    const mode = s.wram[RAM.gameMode];
    s.runFrame();
    if (stop && s.wram[RAM.gameMode] !== GM.level) break;
    log.frame(f, used, [], cpuLoad(s, mode), marioX(s.wram), marioY(s.wram));
  }
  return log;
}
const inGame = (lv: number) => {
  const tl = levelTranslevel(rom, lv);
  emu.startGame(tl);
  emu.loadInGame(lv, tl);
};
const vanillaLevels = (what: string) => {
  for (const lv of [0x105, 0x106, 0x10b, 0x1]) {
    inGame(lv);
    const log = play(900, true), busy = log.history.map((f) => f.busy).filter((b) => b !== LAG);
    check(log.lagFrames === 0 && log.history.length > 300, `${what}: level ${lv.toString(16)} played: no lag frame (${log.lagFrames} in ${log.history.length} frames)`);
    check(busy.every((b) => b > 0 && b < LINES_PER_FRAME) && Math.max(...busy) > Math.min(...busy),
      `${what}: level ${lv.toString(16)}: a load in every frame, it varies (${Math.min(...busy)}–${Math.max(...busy)} of ${LINES_PER_FRAME} lines)`);
  }
};
vanillaLevels('the clean game');
{
  // eight Wigglers (sprite 86) in a row ahead in level 105, at tile row 14 (level sprite data: header byte, then
  // per sprite yyyy--sY, xxxxssss, number)
  const col = 0x28, row = 0x14, sprites = [0x00];
  for (let i = 0; i < 8; i++) sprites.push(((row & 15) << 4) | ((row >> 4) & 1), (((col + i) & 15) << 4) | ((col + i) >> 4), 0x86);
  sprites.push(0xff);
  emu.load(0x105, { sprites: new Uint8Array(sprites) });
  const log = play(600, true);
  check(log.lagFrames >= 3 && log.lags.length > 0, `eight Wigglers: lag frames (${log.lagFrames} in ${log.lags.length} events)`);
  const worst = log.worstLag();
  check(!!worst && worst.tx > col - 20 && worst.tx < col + 12, `the worst lag where Mario came near them (tile ${worst?.tx.toString(16)})`);
}
{
  // Mario dies: the game fades out and loads the overworld, frames it spends busy but no lag of the level
  inGame(0x105);
  const log = play(400, false, (f) => { if (f === 60) emu.snes.wram[RAM.marioAnim] = 9; });
  check(log.lagFrames === 0, `a death and the overworld loaded after it: no lag frame (${log.lagFrames})`);
  check(log.history.some((f) => f.busy === LINES_PER_FRAME), 'loading frames are shown fully busy');
}

open(await editorImage());
vanillaLevels('the editor ROM');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
