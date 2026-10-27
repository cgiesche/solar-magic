// Test play's deaths (src/core/deaths.ts): where Mario died – the frame the game sets him dying – and what
// killed him, learned by emulation: a sprite he walked into, a block he stood on, a pit he fell into, the timer.
// node tools/testdeaths.ts
import { Rom } from '../src/core/rom.ts';
import { editorImage } from './fixture.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelTranslevel } from '../src/core/level.ts';
import { layerGeom } from '../src/core/render.ts';
import { GM, RAM, MAP_HI, marioX, marioY, cameraY, setMarioPos } from '../src/core/ram.ts';
import { DeathWatch, blockTile, type Death } from '../src/core/deaths.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// as the editor opens it: the level heights patch keeps the level being played
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
emu.boot();
const s = emu.snes;

// level lv in a game in progress (small Mario), sprites: the level's own unless given; until gameplay
function enter(lv: number, sprites?: number[]): void {
  const tl = levelTranslevel(rom, lv);
  emu.startGame(tl);
  emu.loadInGame(lv, tl, sprites ? { sprites: new Uint8Array([0, ...sprites, 0xff]) } : {});
  for (let i = 0; i < 80 && s.wram[RAM.gameMode] !== GM.level; i++) s.runFrame();
  s.wram[RAM.powerup] = 0;
}
// k frames with buttons held (each: before a frame), watched; the deaths
function play(k: number, buttons: number, each?: (f: number) => void): Death[] {
  const watch = new DeathWatch(s), deaths: Death[] = [];
  s.hook = watch.hook;
  for (let f = 0; f < k; f++) {
    s.joy1 = buttons;
    each?.(f);
    s.runFrame();
    deaths.push(...watch.take());
  }
  s.hook = null;
  return deaths;
}
// a sprite entry at tile col/row (yyyy--sY, xxxxssss, number)
const sprite = (col: number, row: number, num: number) => [((row & 15) << 4) | ((row >> 4) & 1), ((col & 15) << 4) | (col >> 4), num];
const RIGHT = 0x0100;

{
  enter(0x105, []);
  const d = play(200, 0);
  check(d.length === 0, `standing in the level: no death (${d.length})`);
}
{
  // a Goomba ahead, small Mario walks into it
  enter(0x105, sprite(0x0a, 0x16, 0x0f));
  const d = play(300, RIGHT);
  const k = d[0]?.killer;
  check(d.length === 1, `walked into a Goomba: one death (${d.length})`);
  check(k?.kind === 'sprite' && k.slots === 'sprite' && k.id === 0x0f, `killed by the Goomba (${JSON.stringify(k)})`);
  check(k?.kind === 'sprite' && Math.abs((k.x >> 4) - d[0].tx) <= 2, 'the Goomba was where Mario died');
  check(d[0]?.level === 0x105, `in level 105 (${d[0]?.level.toString(16)})`);
}
{
  // a muncher (Map16 12F) in the floor where Mario stands
  enter(0x105, []);
  const w = s.wram, tx = (marioX(w) + 8) >> 4, ty = ((marioY(w) + 16) >> 4) + 1;
  const a = layerGeom(rom, 0, 0, 0x20, 27).addr(tx, ty);
  w[a] = 0x2f; w[a + MAP_HI] = 0x01;
  const d = play(120, 0);
  const k = d[0]?.killer;
  check(d.length === 1, `standing on a muncher: one death (${d.length})`);
  check(k?.kind === 'block' && k.tx === tx && k.ty === ty && k.tile === 0x12f, `killed by the muncher's tile (${JSON.stringify(k)}, ${tx}/${ty})`);
}
{
  // fallen below the screen
  enter(0x105, []);
  const d = play(120, 0, (f) => { if (f === 10) { const w = s.wram; setMarioPos(w, marioX(w), cameraY(w) + 0xd8); } });
  check(d.length === 1 && d[0].killer.kind === 'pit', `fallen below the screen: killed by the pit (${JSON.stringify(d[0]?.killer)})`);
}
{
  // the timer runs out
  enter(0x105, []);
  const d = play(120, 0, (f) => { if (f === 10) s.wram.set([0, 0, 1], RAM.timer); });
  check(d.length === 1 && d[0].killer.kind === 'time', `time up: killed by the timer (${JSON.stringify(d[0]?.killer)})`);
}
{
  // a level without a time limit keeps its timer at 000: a muncher's death is no time-up
  enter(0x105, []);
  const w = s.wram, tx = (marioX(w) + 8) >> 4, ty = ((marioY(w) + 16) >> 4) + 1;
  const a = layerGeom(rom, 0, 0, 0x20, 27).addr(tx, ty);
  w[a] = 0x2f; w[a + MAP_HI] = 0x01;
  w.set([0, 0, 0], RAM.timer);
  const d = play(120, 0);
  check(d[0]?.killer.kind === 'block', `timer at 000 without counting: not the timer (${JSON.stringify(d[0]?.killer)})`);
}
{
  // the level data's tiles: a horizontal level's screens of its height, a vertical level's of two halves
  const w = new Uint8Array(0x20000);
  const h = layerGeom(rom, 0, 0, 0x20, 27), v = layerGeom(rom, 0, 0x0a, 0x10);
  const at = (x: number, y: number) => JSON.stringify(blockTile(w, h.addr(x, y))) === JSON.stringify({ tx: x, ty: y });
  check(at(0, 0) && at(0x35, 0x19) && at(0x1ff, 0x1a), 'horizontal level: the tile of an address');
  w[RAM.screenMode] = 1;
  const atV = (x: number, y: number) => JSON.stringify(blockTile(w, v.addr(x, y))) === JSON.stringify({ tx: x, ty: y });
  check(atV(0, 0) && atV(0x13, 0x25) && atV(0x1f, 0xff), 'vertical level: the tile of an address');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
