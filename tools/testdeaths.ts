// Test play's deaths (src/core/deaths.ts): where Mario died – the frame the game sets him dying – and what
// killed him, learned by emulation: a sprite he walked into, a block he stood on, a pit he fell into, the timer.
// node tools/testdeaths.ts
import { Rom, snesToPc } from '../src/core/rom.ts';
import { editorImage } from './fixture.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { levelTranslevel, L1_PTRS } from '../src/core/level.ts';
import { layerGeom } from '../src/core/render.ts';
import { RAM, PAD, MAP_HI, marioX, marioY } from '../src/core/ram.ts';
import { DeathWatch, blockTile, type Death } from '../src/core/deaths.ts';
import { levelVersion } from '../src/ui/deathmarks.ts';
import { projectId } from '../src/core/projectid.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// as the editor opens it: the level heights patch keeps the level being played
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
emu.boot();
const s = emu.snes;

// level lv in a game in progress (small Mario), sprites: the level's own unless given; until gameplay
function enter(lv: number, sprites?: number[]): PlaySession {
  const p = PlaySession.start(emu, lv, { ov: sprites ? { sprites: new Uint8Array([0, ...sprites, 0xff]) } : {}, game: {} });
  s.wram[RAM.powerup] = 0;
  return p;
}
// k frames with buttons held (each: before a frame), watched; the deaths
function play(p: PlaySession, k: number, buttons: number, each?: (f: number) => void): Death[] {
  const watch = p.watch((m) => new DeathWatch(m)), deaths: Death[] = [];
  for (let f = 0; f < k; f++) {
    each?.(f);
    p.frame(buttons);
    deaths.push(...watch.take());
  }
  p.close();
  return deaths;
}
// a sprite entry at tile col/row (yyyy--sY, xxxxssss, number)
const sprite = (col: number, row: number, num: number) => [((row & 15) << 4) | ((row >> 4) & 1), ((col & 15) << 4) | (col >> 4), num];

{
  const p = enter(0x105, []);
  const d = play(p, 200, 0);
  check(d.length === 0, `standing in the level: no death (${d.length})`);
}
{
  // a Goomba ahead, small Mario walks into it
  const p = enter(0x105, sprite(0x0a, 0x16, 0x0f));
  const d = play(p, 300, PAD.right);
  const k = d[0]?.killer;
  check(d.length === 1, `walked into a Goomba: one death (${d.length})`);
  check(k?.kind === 'sprite' && k.slots === 'sprite' && k.id === 0x0f, `killed by the Goomba (${JSON.stringify(k)})`);
  check(k?.kind === 'sprite' && Math.abs((k.x >> 4) - d[0].tx) <= 2, 'the Goomba was where Mario died');
  check(d[0]?.level === 0x105, `in level 105 (${d[0]?.level.toString(16)})`);
  check(s.wram[RAM.screens] === 0x14, `the level's screens in RAM (${s.wram[RAM.screens].toString(16)})`);
}
{
  // a Goomba among other Goombas and Koopas (sprite code reading other slots): still the Goomba that touched him
  const p = enter(0x105, [...sprite(0x0a, 0x16, 0x0f), ...sprite(0x0c, 0x16, 0x0f), ...sprite(0x0e, 0x16, 0x04), ...sprite(0x10, 0x16, 0x0f)]);
  const d = play(p, 300, PAD.right);
  const k = d[0]?.killer;
  check(d.length === 1 && k?.kind === 'sprite' && k.slots === 'sprite' && (k.id === 0x0f || k.id === 0x04) && Math.abs((k.x >> 4) - d[0].tx) <= 2,
    `among other sprites: killed by the one he touched (${JSON.stringify(k)}, Mario at ${d[0]?.tx})`);
}
{
  // the level's own sprites running: a muncher's death is still the block's
  const p = enter(0x105);
  const w = s.wram, tx = (marioX(w) + 8) >> 4, ty = ((marioY(w) + 16) >> 4) + 1;
  const a = layerGeom(rom, 0, 0, 0x20, 27).addr(tx, ty);
  w[a] = 0x2f; w[a + MAP_HI] = 0x01;
  const d = play(p, 120, 0);
  check(d[0]?.killer.kind === 'block', `with the level's sprites: a muncher still the killer (${JSON.stringify(d[0]?.killer)})`);
}
{
  // a muncher (Map16 12F) in the floor where Mario stands
  const p = enter(0x105, []);
  const w = s.wram, tx = (marioX(w) + 8) >> 4, ty = ((marioY(w) + 16) >> 4) + 1;
  const a = layerGeom(rom, 0, 0, 0x20, 27).addr(tx, ty);
  w[a] = 0x2f; w[a + MAP_HI] = 0x01;
  const d = play(p, 120, 0);
  const k = d[0]?.killer;
  check(d.length === 1, `standing on a muncher: one death (${d.length})`);
  check(k?.kind === 'block' && k.tx === tx && k.ty === ty && k.tile === 0x12f, `killed by the muncher's tile (${JSON.stringify(k)}, ${tx}/${ty})`);
}
{
  // fallen through the floor and out of view (where the game kills him: its own rule)
  const p = enter(0x105, []);
  const d = play(p, 200, 0, () => { s.wram[RAM.noLayer1Contact] = 0xff; });
  check(d.length === 1 && d[0].killer.kind === 'pit', `fallen out of view: killed by the pit (${JSON.stringify(d[0]?.killer)})`);
}
{
  // the timer runs out
  const p = enter(0x105, []);
  const d = play(p, 120, 0, (f) => { if (f === 10) s.wram.set([0, 0, 1], RAM.timer); });
  check(d.length === 1 && d[0].killer.kind === 'time', `time up: killed by the timer (${JSON.stringify(d[0]?.killer)})`);
}
{
  // a level without a time limit keeps its timer at 000: a muncher's death is no time-up
  const p = enter(0x105, []);
  const w = s.wram, tx = (marioX(w) + 8) >> 4, ty = ((marioY(w) + 16) >> 4) + 1;
  const a = layerGeom(rom, 0, 0, 0x20, 27).addr(tx, ty);
  w[a] = 0x2f; w[a + MAP_HI] = 0x01;
  w.set([0, 0, 0], RAM.timer);
  const d = play(p, 120, 0);
  check(d[0]?.killer.kind === 'block', `timer at 000 without counting: not the timer (${JSON.stringify(d[0]?.killer)})`);
}
{
  // the level data's tiles: a horizontal level's screens of its height, a vertical level's of two halves
  const w = new Uint8Array(0x20000);
  const h = layerGeom(rom, 0, 0, 0x20, 27), v = layerGeom(rom, 0, 0x0a, 0x10);
  const at = (x: number, y: number) => JSON.stringify(blockTile(w, h.addr(x, y))) === JSON.stringify({ tx: x, ty: y });
  check(at(0, 0) && at(0x35, 0x19) && at(0x1ff, 0x1a), 'horizontal level: the tile of an address');
  w[RAM.screens] = 0x10;
  check(blockTile(w, h.addr(0x100, 0)) === null && at(0xff, 0), 'behind the level\'s screens (layer 2\'s data): no layer 1 tile');
  w[RAM.screens] = 0;
  w[RAM.screenMode] = 1;
  const atV = (x: number, y: number) => JSON.stringify(blockTile(w, v.addr(x, y))) === JSON.stringify({ tx: x, ty: y });
  check(atV(0, 0) && atV(0x13, 0x25) && atV(0x1f, 0xff), 'vertical level: the tile of an address');
}

{
  // a death's level version: the level as saved, another after it was changed
  const v = levelVersion(rom, 0x105);
  check(v !== -1 && v === levelVersion(rom, 0x105) && v !== levelVersion(rom, 0x106), 'a level\'s version: the same until it changes, another level\'s differs');
  const d = rom.data.slice(), at = snesToPc(rom.r24(L1_PTRS + 0x105 * 3)) + 5; // a byte of its first object
  d[at] ^= 1;
  rom.data = d;
  check(levelVersion(rom, 0x105) !== v, 'the level changed: another version');
}

{
  // the project's id: made once, kept in the project file, none in an exported ROM
  const p = new Rom(await editorImage()), id = projectId(p);
  check(id.length === 24 && projectId(p) === id, `a project id, the same when asked again (${id})`);
  check(projectId(Rom.fromFile(p.outputProject(false))) === id, 'kept in the project file');
  check(projectId(new Rom(p.output(false))) !== id, 'an exported ROM opened: a new project');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
