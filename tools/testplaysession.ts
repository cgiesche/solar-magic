// The play session (src/core/playsession.ts): a level loaded and played until ready (gameplay, or Mario settled),
// frames with buttons held until Mario dies or the level is left, within a game in progress back to the overworld
// and into the level again, the watchers on the machine's hook (none: no hook) and reset after a savestate.
// node tools/testplaysession.ts
import { Rom } from '../src/core/rom.ts';
import { editorImage } from './fixture.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { readTranslevels } from '../src/core/overworld.ts';
import { DeathWatch } from '../src/core/deaths.ts';
import { GM, RAM, PAD } from '../src/core/ram.ts';
import type { MemHook } from '../src/core/snes.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
emu.boot();
const s = emu.snes, w = s.wram;
// a sprite entry at tile col/row (yyyy--sY, xxxxssss, number)
const sprite = (col: number, row: number, num: number) => [((row & 15) << 4) | ((row >> 4) & 1), ((col & 15) << 4) | (col >> 4), num];
const goomba = { sprites: new Uint8Array([0, ...sprite(0x0a, 0x16, 0x0f), 0xff]) };

{
  const p = PlaySession.start(emu, 0x105);
  check(p.ready && p.render?.ok === true && p.mode === GM.level, `level 105 on its own: ready in gameplay (mode ${p.mode.toString(16)})`);
  check(s.hook === null, 'no watcher: no hook');
  const load = p.frame();
  check(load >= 0 && load <= 262, `a frame's CPU load in lines (${load})`);
  check(p.play(120) === null, 'standing still for 120 frames: played to the end');
  p.close();
}
{
  const p = PlaySession.start(emu, 0x105, { until: 'settled' });
  check(p.ready && p.mode === GM.level && w[RAM.marioAnim] === 0 && !w[RAM.spritesLocked], 'settled: Mario standing, the sprites running');
  p.close();
}
{
  // on its own, small Mario walking into a Goomba: he dies, then the level is left (no game to go back to)
  const p = PlaySession.start(emu, 0x105, { ov: goomba });
  w[RAM.powerup] = 0;
  let each = 0;
  const end = p.play(300, PAD.right, () => { each++; });
  check(end === 'died', `walked into a Goomba: died (${end})`);
  check(s.joy1 === 0 && each > 0, `the buttons released after the run (${each} frames)`);
  check(p.play(600) === 'left', 'dying: the level left');
  check(!p.until('gameplay', 30), 'not back in gameplay: false, no exception');
  p.close();
}
{
  // within a game in progress: dying returns to the overworld, entering the tile plays the level again
  const p = PlaySession.start(emu, 0x105, { ov: goomba, game: {} });
  check(p.ready && p.mode === GM.level, 'within a game: ready in gameplay');
  const lives = w[RAM.lives];
  check(p.play(300, PAD.right) === 'died', 'within a game: died');
  check(p.follow() === 'overworld', 'back on the overworld');
  check(w[RAM.lives] === ((lives - 1) & 0xff), `a life less (${lives} → ${w[RAM.lives]})`);
  check(p.enter() && p.mode === GM.level, 'the level entered again from the overworld');
  p.close();
}
{
  // from the overworld of a new game, Mario on level 105's tile
  const p = PlaySession.overworld(emu, readTranslevels(rom).indexOf(0x29));
  check(p.mode === GM.overworld && !p.ready, 'a new game on the overworld');
  check(p.enter('settled') && w[RAM.marioAnim] === 0, 'level 105 entered from its tile, Mario settled');
  p.close();
}
{
  // watchers: on the hook while the session runs, reset after a savestate is loaded
  const p = PlaySession.start(emu, 0x105);
  let resets = 0;
  const counted = p.watch(() => ({ hook: {} as MemHook, reset: () => { resets++; } }));
  check(s.hook === counted.hook, 'one watcher: its hook');
  const deaths = p.watch((m) => new DeathWatch(m));
  check(s.hook !== null && s.hook !== counted.hook, 'two watchers: both on the hook');
  const st = p.save();
  p.play(30, PAD.right);
  p.load(st);
  check(resets === 1, `a savestate loaded: the watchers reset (${resets})`);
  check(deaths.take().length === 0, 'no death watched');
  p.close();
  check(s.hook === null && s.joy1 === 0, 'closed: no hook, no buttons');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
