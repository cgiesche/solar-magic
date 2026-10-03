// Test play within a game in progress: dying costs a life and returns to the level's overworld tile,
// entering it again loads the same level (not translevel 0, the bonus game, from a title screen state).
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelTranslevel } from '../src/core/level.ts';

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const emu = new LevelEmulator(rom);
emu.boot();
let bad = 0;
// level → its submap ($1F11)
for (const [level, sub] of [[0x105, 1], [0x001, 0], [0x10f, 4], [0x11a, 2]]) {
  const tl = levelTranslevel(rom, level);
  emu.startGame(tl);
  const r = emu.load(level, { translevel: tl, continueState: true });
  const s = emu.snes, w = s.wram;
  for (let f = 0; f < 60; f++) s.runFrame();
  const lives = w[0xdbe];
  w[0x71] = 9; // death animation
  let ow = false, f = 0;
  for (; f < 1500 && !(ow && w[0x100] === 0x14); f++) {
    if (w[0x100] === 0x0e) ow = true;
    s.joy1 = w[0x100] === 0x0e && f % 20 < 3 ? 0x8000 : 0; // B: enter the level
    s.runFrame();
  }
  s.joy1 = 0;
  const ok = r.ok && ow && w[0x100] === 0x14 && w[0x13bf] === tl && w[0x1f11] === sub && w[0xdbe] === lives - 1;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} level ${level.toString(16)}: died, re-entered translevel ${w[0x13bf].toString(16)} (want ${tl.toString(16)}), submap ${w[0x1f11]} (want ${sub}), lives ${lives} → ${w[0xdbe]}`);
}
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
