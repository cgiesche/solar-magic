// Entrance and screen exit options (Lunar Magic 3.00's, levelheight.ts), checked by emulation: Mario faces
// left, a water level, a slippery level, set for the main entrance ($05DE00 bits 6 and 7, $06FE00 bit 6), a
// secondary entrance (its RLW----- byte, I of IPXXDAAA) and a secondary screen exit (0000wush: w), each as
// Mario enters the level that way and as test play starts it, and the slanted pipe entrance shooting Mario out
// the way he faces; which entrances arrive slippery (also by the game's entrance action); the bytes the
// options don't own stay as they were.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  type SecondaryEntrance, type SecondaryHeader, readSecondaryHeader, encodeSecondaryHeader, decodeSecondaryHeader, readSecondaryEntrance,
  writeSecondaryEntrance, decodeSecondaryEntrance, entrancePos, secondarySpot, startHeader, loadLevel, cloneLevel, parseObjects, serializeObjects,
  SEC_ENT, EXIT_WATER,
} from '../src/core/level.ts';
import { slipperyActions, arrivesSlippery } from '../src/core/slippery.ts';
import { saveLevel } from '../src/core/save.ts';
import { GM, RAM, marioX } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());
const N = 0x105, IDX = 0x1f0;
const sec0 = readSecondaryHeader(rom, N);

// the bytes: every value of the main entrance's and a secondary entrance's bytes comes back as it was; the
// options are their own bits
{
  const wrong: string[] = [];
  for (let v = 0; v < 256; v++) {
    const b = [v, v ^ 0x5a, v, v ^ 0xa5, v, v ^ 0x3c, v, v ^ 0xc3, v];
    const s = decodeSecondaryHeader(b);
    if (encodeSecondaryHeader(s).slice(0, b.length).join() !== b.join()) wrong.push(`header ${v.toString(16)}`);
    const r = new Rom(rom.data.slice());
    const e = [v, v ^ 0x5a, v ^ 0xa5, v, v ^ 0x3c, v ^ 0xc3];
    SEC_ENT.forEach((t, i) => r.w8(t + IDX, e[i]));
    writeSecondaryEntrance(r, IDX, readSecondaryEntrance(r, IDX));
    if (SEC_ENT.some((t, i) => r.r8(t + IDX) !== e[i])) wrong.push(`entrance ${v.toString(16)}`);
  }
  const s = decodeSecondaryHeader([0, 0, 0, 0, 0, 0, 0x40, 0, 0x40]);
  const e = decodeSecondaryEntrance([0, 0, 0, 0, 0, 0x60]);
  const si = decodeSecondaryHeader([0, 0, 0, 0, 0, 0, 0x80, 0, 0]), ei = decodeSecondaryEntrance([0, 0, 0, 0x80, 0, 0]);
  check(!wrong.length && s.water === 1 && s.faceLeft === 1 && s.slippery === 0 && s.lmEntranceFlags === 0 && e.water === 1 && e.faceLeft === 1 && e.slippery === 0 && e.lmRaw === 0
    && si.slippery === 1 && si.water === 0 && si.lmEntranceFlags === 0 && ei.slippery === 1 && ei.action === 0 && ei.entranceTile === 0,
    `main and secondary entrance bytes: kept as they were, water, face left and slippery their own bits${wrong.length ? ` – not ${wrong.slice(0, 5).join(', ')}` : ''}`);
  const exits = [{ uid: 1, screen: 3, dest: 0x1f0, secondary: true, flags: 0x0f }, { uid: 2, screen: 4, dest: 0x105, secondary: false, flags: 0x05 }];
  const back = parseObjects(serializeObjects([], exits, false), 0, false).exits;
  check(back.map((x) => x.flags).join() === '15,5', `screen exit flags kept (w, u): ${back.map((x) => x.flags.toString(16)).join(', ')}`);
}

// Mario's direction ($76: 0 left), the water level ($85), whether he swims ($75) and the slippery level ($86), a
// second into the level; dx: how far he moved meanwhile (a slanted pipe shoots him out)
function after(s: LevelEmulator['snes']) {
  const w = s.wram, x0 = marioX(w);
  s.joy1 = 0;
  for (let f = 0; f < 60; f++) s.runFrame();
  return { left: w[RAM.marioDir] === 0, water: w[RAM.waterLevel] !== 0, swims: w[RAM.marioInWater] !== 0, slippery: w[RAM.slippery] !== 0, dx: (((marioX(w) - x0) << 16) >> 16) };
}
const show = (r: ReturnType<typeof after>) => `${r.left ? 'left' : 'right'}${r.water ? ', water' : ''}${r.swims ? ', swimming' : ''}${r.slippery ? ', slippery' : ''}${r.dx ? `, moved ${r.dx}` : ''}`;
const SLANTED = 6; // the entrance action "shoot from slanted pipe" ($192A)
// the level from its main entrance with this secondary header (as test play loads it)
function start(sec: SecondaryHeader) {
  const emu = new LevelEmulator(rom);
  emu.load(N, { secondaryHeader: encodeSecondaryHeader(sec) });
  const s = emu.snes;
  for (let f = 0; f < 300 && s.wram[RAM.gameMode] !== GM.level; f++) s.runFrame();
  return after(s);
}
{
  const game = start(sec0), left = start({ ...sec0, faceLeft: 1 }), water = start({ ...sec0, water: 1 });
  check(!game.left && !game.water && !game.swims, `main entrance: Mario faces right, no water (${show(game)})`);
  check(left.left && !left.water, `main entrance, face left: Mario faces left (${show(left)})`);
  check(water.water && water.swims && !water.left, `main entrance, water level: Mario swims (${show(water)})`);
  const slip = start({ ...sec0, slippery: 1 });
  check(!game.slippery && slip.slippery && !slip.water && !slip.left, `main entrance, slippery: the level is slippery (${show(slip)}; without: ${show(game)})`);
  // the slanted pipe shoots him out the way he faces (Lunar Magic's), else to the right as in the game
  const pipe = start({ ...sec0, entranceAction: SLANTED }), pipeLeft = start({ ...sec0, entranceAction: SLANTED, faceLeft: 1 });
  check(!pipe.left && pipe.dx > 64, `main entrance, slanted pipe: Mario shoots right (${show(pipe)})`);
  check(pipeLeft.left && pipeLeft.dx < -64, `main entrance, slanted pipe, face left: Mario shoots left (${show(pipeLeft)})`);
}

// entering level 105 through its exit pipe on screen 7, which leads to secondary entrance IDX (exit flags)
function enter(e: SecondaryEntrance, flags = 2) {
  const r = new Rom(rom.data.slice());
  writeSecondaryEntrance(r, IDX, e);
  const lv = cloneLevel(loadLevel(r, N));
  lv.exits = lv.exits.map((x) => ({ ...x, dest: IDX, secondary: true, flags }));
  // Mario starts on the pipe (tile 8, 20 of screen 7)
  lv.secondary = { ...lv.secondary, entranceScreen: 7, entranceTile: 1, entranceX: 0, entranceXHi: 1, entranceY: 0x14 & 15, entranceYHi: 0x14 >> 4 };
  saveLevel(r, lv);
  const em = new LevelEmulator(r);
  em.load(N);
  const s = em.snes, w = s.wram;
  for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
  w[RAM.marioX] = 0x88; // on the pipe's middle
  let left = false;
  for (let f = 0; f < 2000; f++) {
    s.joy1 = 0x0400; s.runFrame();
    if (w[RAM.gameMode] !== GM.level) left = true;
    if (left && w[RAM.gameMode] === GM.level) break;
  }
  return { entered: left && w[RAM.gameMode] === GM.level, ...after(s) };
}
{
  const base: SecondaryEntrance = { ...readSecondaryEntrance(rom, IDX), destLevel: N, screen: 2, entranceX: 3, entranceY: 6, entranceTile: 0, action: 0, slippery: 0, faceLeft: 0, water: 0 };
  const plain = enter(base), left = enter({ ...base, faceLeft: 1 }), water = enter({ ...base, water: 1 }), exitWater = enter(base, 2 | EXIT_WATER);
  const slip = enter({ ...base, slippery: 1 });
  check(plain.entered && !plain.slippery && slip.entered && slip.slippery && !slip.water, `secondary entrance, slippery: the level is slippery (${show(slip)}; without: ${show(plain)})`);
  check(plain.entered && !plain.left && !plain.water && !plain.swims, `secondary entrance: Mario faces right, no water (${show(plain)})`);
  check(left.entered && left.left && !left.water, `secondary entrance, face left: Mario faces left (${show(left)})`);
  check(water.entered && water.water && water.swims, `secondary entrance, water level: Mario swims (${show(water)})`);
  check(exitWater.entered && exitWater.water && exitWater.swims, `secondary exit with "water level": Mario swims (${show(exitWater)})`);
  const pipe = enter({ ...base, action: SLANTED }), pipeLeft = enter({ ...base, action: SLANTED, faceLeft: 1 });
  check(pipe.entered && !pipe.left && pipe.dx > 64, `secondary entrance, slanted pipe: Mario shoots right (${show(pipe)})`);
  check(pipeLeft.entered && pipeLeft.left && pipeLeft.dx < -64, `secondary entrance, slanted pipe, face left: Mario shoots left (${show(pipeLeft)})`);

  // test play from the secondary entrance: as entering through it
  const p = entrancePos(rom, secondarySpot(base), false);
  for (const [name, e] of [['face left', { ...base, faceLeft: 1 }], ['water level', { ...base, water: 1 }], ['slippery', { ...base, slippery: 1 }], ['neither', base],
    ['slanted pipe', { ...base, action: SLANTED }], ['slanted pipe, face left', { ...base, action: SLANTED, faceLeft: 1 }]] as [string, SecondaryEntrance][]) {
    const t = start(startHeader(rom, sec0, p.x, p.y, 9, 0, e)), g = enter(e);
    check(t.left === g.left && t.water === g.water && t.swims === g.swims && t.slippery === g.slippery && Math.sign(t.dx) === Math.sign(g.dx) && Math.abs(t.dx - g.dx) < 16,
      `test play from a secondary entrance (${name}): ${show(t)}, entered ${show(g)}`);
  }
}

// which entrance actions make the level slippery, learned by loading a level with each (the clean game: 5,
// sliding in); an entrance arrives slippery by its own bit or its action, as entering it shows
{
  const emu = new LevelEmulator(rom);
  const acts = slipperyActions(emu).result;
  check(acts.join() === '5', `entrance actions making the level slippery: ${acts.join(', ')}`);
  const wrong: string[] = [];
  for (let a = 0; a < 8; a++) for (const slippery of [0, 1]) {
    const r = start({ ...sec0, entranceAction: a, slippery });
    if (r.slippery !== arrivesSlippery({ action: a, slippery }, acts)) wrong.push(`${a}${slippery ? ' slippery' : ''}: ${show(r)}`);
  }
  check(!wrong.length, `arrives slippery: as entering the level shows, by bit and action${wrong.length ? ` – not ${wrong.join('; ')}` : ''}`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
