// Test play within a game in progress: dying costs a life and returns to the level's overworld tile,
// entering it again loads the same level (not translevel 0, the bonus game, from a title screen state).
// The level is entered from its tile as in the game, so its midway tape counts: touched, Mario dies and
// comes back at the midway point – in the clean game and with the editor's patches; a sub-level is entered
// through its main level, which sets up the midway point the same way.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { levelTranslevel } from '../src/core/level.ts';
import { GM, RAM, MARIO_DYING, MAP_BASE, MAP_SIZE, MAP_HI, marioX, setMarioPos } from '../src/core/ram.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16);

// dies, waits for the overworld and enters the tile again; whether the level is played again
function dieAndReenter(p: PlaySession): boolean {
  p.wram[RAM.marioAnim] = MARIO_DYING;
  return p.follow() === 'overworld' && p.enter();
}

{
  const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  const emu = new LevelEmulator(rom);
  emu.boot();
  // level → its submap ($1F11)
  for (const [level, sub] of [[0x105, 1], [0x001, 0], [0x10f, 4], [0x11a, 2]]) {
    const tl = levelTranslevel(rom, level);
    const p = PlaySession.start(emu, level, { game: { translevel: tl } }), w = p.wram;
    const lives = w[RAM.lives];
    const again = dieAndReenter(p);
    check(p.ready && again && w[RAM.translevel] === tl && w[RAM.submap] === sub && w[RAM.lives] === lives - 1,
      `level ${hx(level)}: died, re-entered translevel ${hx(w[RAM.translevel])} (want ${hx(tl)}), submap ${w[RAM.submap]} (want ${sub}), lives ${lives} → ${w[RAM.lives]}`);
  }
}

// the midway tape: Mario touches it (Map16 tile 38 in the level), dies and comes back at the midway point
for (const [name, image] of [['clean game', new Uint8Array(readFileSync('test/fixtures/smw.smc'))], ['editor patches', await editorImage()]] as const) {
  const rom = new Rom(image);
  const emu = new LevelEmulator(rom);
  emu.boot();
  for (const level of [0x105, 0x001]) {
    const tl = levelTranslevel(rom, level);
    const p = PlaySession.start(emu, level, { game: { translevel: tl } }), w = p.wram;
    const x0 = marioX(w);
    let i = 0;
    while (i < MAP_SIZE && !(w[MAP_BASE + i] === 0x38 && w[MAP_BASE + MAP_HI + i] === 0)) i++;
    const tx = Math.floor(i / 0x1b0) * 16 + (i & 15), ty = (i % 0x1b0) >> 4;
    for (let f = 0; f < 10; f++) { setMarioPos(w, tx * 16, ty * 16 - 16); p.frame(); }
    const touched = w[RAM.midwayTouched] !== 0;
    const again = dieAndReenter(p);
    check(i < MAP_SIZE && touched && again && w[RAM.midwayUsed] !== 0 && marioX(w) > x0 + 0x100,
      `${name}, level ${hx(level)}: tape at ${hx(tx)}/${hx(ty)} touched (${touched}), died, re-entered at the midway point: ${w[RAM.midwayUsed] !== 0}, Mario at x ${hx(marioX(w))} (start ${hx(x0)})`);
  }
  // a sub-level: the midway point set up by its main level
  const [sub, main] = [0xc3, 0x006];
  const tl = main; // (the clean game's exits are old-style: levelTranslevel doesn't follow them)
  emu.startGame(tl);
  emu.loadInGame(main, tl);
  const want = emu.snes.wram[RAM.midwayScreen];
  emu.startGame(tl);
  const r = emu.loadInGame(sub, tl);
  const w = emu.snes.wram;
  check(r.ok && want !== 0 && w[RAM.midwayScreen] === want && w[RAM.translevel] === tl && w[RAM.sublevelCount] !== 0,
    `${name}, sub-level ${hx(sub)} of ${hx(main)}: midway screen ${hx(w[RAM.midwayScreen])} (want ${hx(want)}), translevel ${hx(w[RAM.translevel])}`);
}
// a level with the no-Yoshi intro, test played with the sound unit (its music call sees $141A 0): Mario walks
// into the castle or ghost house (animation $0A) and the level loads after it
{
  await loadApu();
  const rom = new Rom(await editorImage());
  const emu = new LevelEmulator(rom);
  emu.snes.apu = new Apu();
  emu.boot();
  for (const level of [0x101, 0x004]) {
    const tl = levelTranslevel(rom, level);
    emu.startGame(tl);
    const r = emu.loadInGame(level, tl);
    const s = emu.snes, w = s.wram;
    const walk = w[RAM.marioAnim];
    let f = 0;
    for (; f < 900 && !(w[RAM.introShown] && w[RAM.gameMode] === GM.level); f++) s.runFrame();
    check(r.ok && walk === 0x0a && w[RAM.introShown] === 1 && w[RAM.gameMode] === GM.level,
      `level ${hx(level)} with sound: intro walk (animation ${hx(walk)}), then the level (after ${f} frames, game mode ${hx(w[RAM.gameMode])})`);
  }
}
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
