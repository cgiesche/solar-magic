// The midway entrance (Lunar Magic 3.00's, levelheight.ts), checked by emulation: entering a level from the
// overworld with its midway point touched puts Mario where the editor shows the midway marker – the main
// entrance's position on the midway screen as in the game, or with its own settings at its tile, with its own
// action, camera start and options; levels that never set it load as in the clean game. Test play from it
// starts as entering it does; a standard screen exit set to it leads there. The bytes come back as they were.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  type SecondaryHeader, readSecondaryHeader, encodeSecondaryHeader, decodeSecondaryHeader, entrancePos, midwaySpot, midwayStart, nearestMidway, placeMidway,
  setCameraRows, startHeader, mainTranslevel, loadLevel, cloneLevel, LEVEL_HEIGHTS, EXIT_MIDWAY,
} from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { GM, RAM, marioX, marioY, cameraY, setMarioPos } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16);

const rom = new Rom(await editorImage());
const N = 0x105;
const sec0 = readSecondaryHeader(rom, N);
const SLANTED = 6; // the entrance action "shoot from slanted pipe"

// the bytes: every value of the midway entrance's four comes back as it was; the fields are their own bits
{
  const wrong: string[] = [];
  for (let v = 0; v < 256; v++) {
    const b = [v, v ^ 0x5a, v, v ^ 0xa5, v, v ^ 0x3c, v, v ^ 0xc3, v, v, v ^ 0x5a, v ^ 0xa5, v ^ 0x3c];
    if (encodeSecondaryHeader(decodeSecondaryHeader(b)).join() !== b.join()) wrong.push(hx(v));
  }
  // own, screen bit 4, X bit 4, action 5 / Y 6, X 9 / camera relative, face left, offset bits 3-0 $A / offset bit 4, Y bits 9-4 $21
  const s = decodeSecondaryHeader([0, 0, 0x30, 0, 0, 0, 0, 0, 0, 0x3d, 0x69, 0xca, 0x61]);
  check(!wrong.length && s.midwayOwn === 1 && s.midwayScreen === 0x13 && s.midwayX === 0x19 && s.midwayY === 0x216 && s.midwayAction === 5
    && s.midwayCameraRelative === 1 && s.midwayFaceLeft === 1 && s.midwayCamera === 0x1a && s.midwayWater === 0 && s.midwaySlippery === 0 && s.lmMidwayFlags === 0
    && decodeSecondaryHeader([0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0]).midwaySlippery === 1 && decodeSecondaryHeader([0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0]).lmMidwayFlags === 0,
  `midway entrance bytes: kept as they were, the fields their own bits${wrong.length ? ` – not ${wrong.slice(0, 5).join(', ')}` : ''}`);
}

// entering level n from the overworld at its midway point (the secondary header as override): where Mario
// and the camera start, then a second into the level his direction, the water level, how far he moved
function enter(r: Rom, n: number, sec?: SecondaryHeader) {
  const emu = new LevelEmulator(r);
  emu.load(n, { midway: true, ...(sec ? { secondaryHeader: encodeSecondaryHeader(sec) } : {}) });
  const s = emu.snes, w = s.wram;
  const at = { x: marioX(w), y: marioY(w), cam: cameraY(w), midway: w[RAM.midwayUsed] !== 0, screen: w[RAM.midwayScreen] };
  for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
  const x0 = marioX(w);
  s.joy1 = 0;
  for (let f = 0; f < 60; f++) s.runFrame();
  return { ...at, left: w[RAM.marioDir] === 0, water: w[RAM.waterLevel] !== 0, slippery: w[RAM.slippery] !== 0, dx: ((marioX(w) - x0) << 16) >> 16 };
}
type Entered = ReturnType<typeof enter>;
const show = (r: Entered) => `${hx(r.x)},${hx(r.y)} camera ${hx(r.cam)}${r.left ? ', left' : ''}${r.water ? ', water' : ''}${r.slippery ? ', slippery' : ''}${r.dx ? `, moved ${r.dx}` : ''}`;
const marker = (sec: SecondaryHeader) => entrancePos(rom, midwaySpot(sec), (sec.verticalPositioning & 1) !== 0);
// (the marker is Mario before the entrance action: a water level's moves him a few pixels)
const atMarker = (r: Entered, sec: SecondaryHeader) => { const p = marker(sec); return r.midway && Math.abs(r.x - p.x) < 16 && Math.abs(r.y - p.y) < 16; };

// levels that never set it: as in the clean game, Mario where the marker is (the main entrance's position on
// the midway screen)
{
  const clean = new Rom(cleanImage());
  const wrong: string[] = [];
  let n = 0;
  for (let l = 0; l < 0x200; l++) {
    const tl = mainTranslevel(l);
    if (!tl || tl === 0x24 || l === 0 || l === 0x100) continue;
    const sec = readSecondaryHeader(rom, l);
    if (sec.verticalPositioning & 1) continue; // (the game puts a vertical level's midway screen on X)
    const a = enter(rom, l), b = enter(clean, l);
    n++;
    if (a.x !== b.x || a.y !== b.y || a.cam !== b.cam || !atMarker(a, sec)) wrong.push(`${hx(l)}: ${show(a)}, the game's ${show(b)}, marker ${hx(marker(sec).x)},${hx(marker(sec).y)}`);
  }
  check(n > 50 && !wrong.length, `${n} levels at their midway point: as in the clean game, at the marker${wrong.length ? ` – not ${wrong.slice(0, 4).join('; ')}` : ''}`);
}

// with its own settings: Mario at its tile on its screen (also screens 10-1F), its own options and action,
// the main entrance's ignored
{
  const own: SecondaryHeader = {
    ...sec0, faceLeft: 1, water: 0, entranceAction: 0,
    midwayOwn: 1, midwayScreen: 1, midwayX: 8, midwayY: 0x10, midwayAction: 0, midwayFaceLeft: 0, midwayWater: 0, midwayCameraRelative: 0, midwayCamera: 0,
  };
  const r = enter(rom, N, own);
  check(atMarker(r, own) && r.x === 1 * 256 + 8 * 16 && r.y === 0x10 * 16 && !r.left, `own position: Mario at tile 8, 10 of screen 1, facing right (${show(r)})`);
  const hi = { ...own, midwayScreen: 0x12 }, rh = enter(rom, N, hi);
  check(atMarker(rh, hi) && rh.x >> 8 === 0x12 && rh.screen === 0x12, `own position on screen 12 (Lunar Magic's bit 4), the tape's screen ${hx(rh.screen)}: ${show(rh)}`);
  const shared = { ...sec0, midwayScreen: 0x10 }, rs = enter(rom, N, shared);
  check(atMarker(rs, shared) && rs.x >> 8 === 0x10 && rs.screen === 0x10, `shared position on screen 10, the tape's screen ${hx(rs.screen)} (0: no checkpoint): ${show(rs)}`);
  const xhi = { ...own, midwayX: 0x15 }, rx = enter(rom, N, xhi);
  check(rx.x === 0x150, `a horizontal level's X bit 4 left out as by Lunar Magic: ${show(rx)}`);
  const vl = Array.from({ length: 0x200 }, (_, l) => l).find((l) => mainTranslevel(l) && l !== 0x100 && (readSecondaryHeader(rom, l).verticalPositioning & 1))!;
  const vert = { ...readSecondaryHeader(rom, vl), midwayOwn: 1, midwayScreen: 2, midwayX: 0x14, midwayY: 5 }, rv = enter(rom, vl, vert);
  check(atMarker(rv, vert) && rv.x === 0x140 && rv.y === 0x250, `own position in vertical level ${hx(vl)}: tile 14, 5 of screen 2 (${show(rv)})`);
  const ignored = enter(rom, N, { ...sec0, midwayX: 9, midwayY: 3, midwayWater: 1, midwayAction: SLANTED, midwayCameraRelative: 1 });
  const plain = enter(rom, N);
  check(ignored.x === plain.x && ignored.y === plain.y && ignored.cam === plain.cam && ignored.water === plain.water,
    `bytes without "own settings": the main entrance's (${show(ignored)}, without them ${show(plain)})`);
  const left = enter(rom, N, { ...own, faceLeft: 0, midwayFaceLeft: 1 }), water = enter(rom, N, { ...own, water: 0, midwayWater: 1 });
  check(left.left && !left.water && water.water, `own options: face left (${show(left)}), water level (${show(water)})`);
  const slip = enter(rom, N, { ...own, slippery: 0, midwaySlippery: 1 }), mainSlip = enter(rom, N, { ...own, slippery: 1 }), shareSlip = enter(rom, N, { ...sec0, slippery: 1 });
  check(slip.slippery && !mainSlip.slippery && shareSlip.slippery, `own slippery (${show(slip)}), the main entrance's ignored (${show(mainSlip)}), without own settings the main entrance's (${show(shareSlip)})`);
  const pipe = enter(rom, N, { ...own, midwayAction: SLANTED });
  check(pipe.dx > 64, `own action: shot from a slanted pipe (${show(pipe)})`);

  // camera: the game's FG start Y, or rows above Mario
  const rel: SecondaryHeader = { ...own, midwayY: 0x14 };
  const m = { cameraRelative: 0, cameraOffsetHi: 0, fgInitY: 0, bgInitY: 0 };
  setCameraRows(m, 10);
  rel.midwayCameraRelative = 1; rel.midwayCamera = (m.cameraOffsetHi << 4) | (m.fgInitY << 2) | m.bgInitY;
  const rr = enter(rom, N, rel);
  check(rr.cam === 0x14 * 16 - 10 * 16, `own camera start: 10 rows above Mario (${show(rr)})`);
  const fg = [0, 1, 2, 3].map((v) => enter(rom, N, { ...own, midwayCamera: v << 2 }).cam);
  const game = [0, 1, 2, 3].map((v) => enter(rom, N, { ...sec0, midwayScreen: 3, fgInitY: v }).cam);
  check(fg.join() === game.join() && new Set(fg).size > 1, `own FG start Y 0-3: as the main entrance's (${fg.map(hx).join(', ')})`);

  // test play from it (as testplay.ts: the level from the nearest main entrance setting, Mario then moved to
  // the marker): as entering it
  for (const [name, sec] of [['own', own], ['own, face left', { ...own, midwayFaceLeft: 1 }], ['own, water', { ...own, midwayWater: 1 }], ['own, slippery', { ...own, midwaySlippery: 1 }], ['shared', { ...sec0, midwayScreen: 3 }], ['shared, slippery', { ...sec0, midwayScreen: 3, slippery: 1 }]] as [string, SecondaryHeader][]) {
    const p = marker(sec), g = enter(rom, N, sec);
    const emu = new LevelEmulator(rom);
    emu.load(N, { secondaryHeader: encodeSecondaryHeader(startHeader(rom, sec, p.x, p.y, 9, 0, midwayStart(sec))) });
    const s = emu.snes, w = s.wram;
    for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
    setMarioPos(w, p.x, p.y);
    for (let f = 0; f < 60; f++) s.runFrame();
    const left = w[RAM.marioDir] === 0, water = w[RAM.waterLevel] !== 0, slippery = w[RAM.slippery] !== 0;
    check(left === g.left && water === g.water && slippery === g.slippery,
      `test play from the midway entrance (${name}): ${left ? 'left' : 'right'}${water ? ', water' : ''}${slippery ? ', slippery' : ''}, entered ${show(g)}`);
  }
}

// a standard screen exit with w (Lunar Magic's "go to midway entrance", 0000wush without s): entering level 105
// through its exit pipe on screen 7, which leads back to 105, puts Mario at its midway entrance when it has its
// own settings (Lunar Magic's: else the main entrance's); the game's midway flag ($13CF) stays clear
// (or into level `to` with secondary header `toSec`)
function exitTo(sec: SecondaryHeader, flags: number, to = N, toSec?: SecondaryHeader) {
  const r = new Rom(rom.data.slice());
  if (toSec) { const t = cloneLevel(loadLevel(r, to)); t.secondary = toSec; saveLevel(r, t); }
  const lv = cloneLevel(loadLevel(r, N));
  lv.exits = lv.exits.map((x) => ({ ...x, dest: to, secondary: false, flags }));
  // Mario starts on the pipe (tile 8, 20 of screen 7)
  lv.secondary = { ...sec, entranceScreen: 7, entranceTile: 1, entranceX: 0, entranceXHi: 1, entranceY: 0x14 & 15, entranceYHi: 0x14 >> 4 };
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
  const entered = left && w[RAM.gameMode] === GM.level;
  const at = { x: marioX(w), y: marioY(w), cam: cameraY(w), midway: w[RAM.midwayUsed] !== 0 };
  const x0 = marioX(w);
  s.joy1 = 0;
  for (let f = 0; f < 60; f++) s.runFrame();
  return { entered, ...at, screen: w[RAM.midwayScreen], left: w[RAM.marioDir] === 0, water: w[RAM.waterLevel] !== 0, slippery: w[RAM.slippery] !== 0, dx: ((marioX(w) - x0) << 16) >> 16 };
}
{
  const own: SecondaryHeader = {
    ...sec0, faceLeft: 0, water: 0, entranceAction: 0,
    midwayOwn: 1, midwayScreen: 1, midwayX: 8, midwayY: 0x10, midwayAction: 0, midwayFaceLeft: 1, midwayWater: 1, midwayCameraRelative: 0, midwayCamera: 0,
  };
  const main = { x: 7 * 256 + 0x80, y: 0x14 * 16 };
  const near = (r: { x: number; y: number }, p: { x: number; y: number }) => Math.abs(r.x - p.x) < 16 && Math.abs(r.y - p.y) < 16;
  const to = exitTo(own, EXIT_MIDWAY);
  check(to.entered && near(to, marker(own)) && !to.midway && to.left && to.water,
    `standard exit "go to midway entrance": Mario at the target's midway entrance with its options, the game's midway flag clear (${show(to)})`);
  const pipe = exitTo({ ...own, midwayAction: SLANTED, midwayFaceLeft: 0 }, EXIT_MIDWAY);
  check(pipe.entered && pipe.dx > 64, `… with its action: shot from a slanted pipe (${show(pipe)})`);
  const slip = exitTo({ ...own, midwaySlippery: 1 }, EXIT_MIDWAY);
  check(slip.entered && slip.slippery && !to.slippery, `… slippery: the level is slippery (${show(slip)})`);
  const shared = exitTo({ ...own, midwayOwn: 0 }, EXIT_MIDWAY);
  check(shared.entered && near(shared, main) && !shared.left && !shared.water, `… a target without its own midway settings: its main entrance, as in Lunar Magic (${show(shared)})`);
  // into another level, a vertical one: its midway entrance's tile on its screen
  const vl = Array.from({ length: 0x100 }, (_, l) => 0x100 | l).find((l) => l !== N && mainTranslevel(l) && (readSecondaryHeader(rom, l).verticalPositioning & 1))!;
  const vert = { ...readSecondaryHeader(rom, vl), midwayOwn: 1, midwayScreen: 2, midwayX: 0x14, midwayY: 5, midwayAction: 0, midwayFaceLeft: 0, midwayWater: 0 };
  const rv = exitTo(sec0, EXIT_MIDWAY, vl, vert);
  check(rv.entered && rv.x === 0x140 && rv.y === 0x250, `… into vertical level ${hx(vl)}: tile 14, 5 of screen 2 (${show(rv)})`);
  const plain = exitTo(own, 0);
  check(plain.entered && near(plain, main) && !plain.left && !plain.water, `standard exit without it: the main entrance (${show(plain)})`);
}

// placing it: the tile nearest to the pixel, a horizontal level's X within its screen; the main entrance's
// settings first
{
  const sec = { ...sec0, faceLeft: 1, water: 1, slippery: 1, entranceAction: 3 };
  placeMidway(sec, nearestMidway(rom, sec, 0x2f8, 0x100, 9));
  check(sec.midwayOwn === 1 && sec.midwayScreen === 3 && sec.midwayX === 0 && sec.midwayY === 0x10 && sec.midwayFaceLeft === 1 && sec.midwayWater === 1 && sec.midwaySlippery === 1 && sec.midwayAction === 3,
    `placed at pixel 2F8, 100: screen ${hx(sec.midwayScreen)}, tile ${sec.midwayX}, ${hx(sec.midwayY)}, the main entrance's options and action`);
  placeMidway(sec, nearestMidway(rom, sec, 0x9f8, 0x40, 9));
  check(sec.midwayScreen === 9 && sec.midwayX === 15, `at the last screen's right edge: screen ${sec.midwayScreen}, tile ${sec.midwayX}`);
  const tall = { ...sec0, levelSize: 0x10, cameraRelative: 0 };
  placeMidway(tall, nearestMidway(rom, tall, 0x100, LEVEL_HEIGHTS[0x10] - 0x20, 9));
  check(tall.midwayY === (LEVEL_HEIGHTS[0x10] >> 4) - 2 && tall.midwayCameraRelative === 1, `in a level with a size: tile row ${hx(tall.midwayY)}, the camera relative to Mario`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
