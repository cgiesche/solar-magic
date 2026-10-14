// Playing a taller horizontal level (levelheight.ts, vrampatch.ts), checked by emulation: a level of the game
// moved down into a taller level must play exactly like the game's – the same input gives Mario and every
// sprite the same positions (moved down), the visible layer 1 tiles are the same whenever the cameras are,
// a pipe in the moved part leads where the game's does, and an entrance in it puts Mario there.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  type Level, loadLevel, cloneLevel, maxScreens, entrancePos, levelRows, readSecondaryEntrance, writeSecondaryEntrance,
} from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { RAM, SPR, SPRITE_SLOTS, get16, marioX, marioY, cameraX, cameraY, spriteX, spriteY } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = new Rom(await editorImage());

// the level moved down by dy rows into a level of the given size; Mario starts at the game's entrance
// (moved down), the camera as far above him as in the game (Lunar Magic's tile entrance, relative camera)
function moved(game: Level, size: number, dy: number): Level {
  const lv = cloneLevel(game);
  lv.secondary = { ...lv.secondary, levelSize: size };
  lv.objects = lv.objects.map((o) => ({ ...o, y: o.y + dy }));
  lv.sprites = lv.sprites.map((o) => ({ ...o, y: o.y + dy }));
  const s = game.secondary, p = entrancePos(base, s.entranceScreen, s.entranceX, s.entranceY, false);
  const ty = (p.y >> 4) + dy, tx = (p.x & 0xff) >> 4, v = ((0xc0 - p.y) >> 4) & 31;
  lv.secondary = {
    ...lv.secondary, entranceTile: 1, entranceX: tx & 7, entranceXHi: tx >> 3, entranceY: ty & 15, entranceYHi: ty >> 4,
    cameraRelative: 1, cameraOffsetHi: v >> 4, fgInitY: (v >> 2) & 3, bgInitY: v & 3, bgHeight: 26,
  };
  return lv;
}
// the game's level, cut to the screens a level of the size has
function cut(n: number, size: number): Level {
  const lv = cloneLevel(loadLevel(base, n));
  const screens = Math.min(lv.header.screens, maxScreens({ levelSize: size }));
  lv.header = { ...lv.header, screens };
  lv.objects = lv.objects.filter((o) => o.x >> 4 < screens);
  lv.sprites = lv.sprites.filter((o) => o.x >> 4 < screens);
  return lv;
}
function play(lv: Level, prepare?: (rom: Rom) => void) {
  const rom = new Rom(base.data.slice());
  prepare?.(rom);
  saveLevel(rom, cloneLevel(lv));
  const emu = new LevelEmulator(rom);
  emu.load(lv.number);
  const s = emu.snes;
  for (let f = 0; f < 300 && s.wram[RAM.gameMode] !== 0x14; f++) s.runFrame();
  return s;
}
type S = ReturnType<typeof play>;
// one game frame ($14 advances; a lag frame more or less doesn't count)
function step(s: S, joy: number): void {
  const f0 = s.wram[0x14];
  s.joy1 = joy;
  for (let n = 0; n < 10; n++) { s.runFrame(); if (s.wram[0x14] !== f0) break; }
}
const sprites = (w: Uint8Array, dy: number) => Array.from({ length: SPRITE_SLOTS }, (_, i) =>
  w[SPR.status + i] ? `${w[SPR.num + i]}:${spriteX(w, i)},${(spriteY(w, i) + dy) & 0xffff}` : '').join('|');
// the visible layer 1 tilemap (SMWV's 64x32 at $3000, rows modulo 32 in both)
function visible(s: S): number[] {
  const out: number[] = [], w = s.wram, x0 = cameraX(w) >> 3, y0 = cameraY(w) >> 3;
  for (let r = 0; r < 28; r++) for (let c = 0; c < 33; c++) {
    const x = x0 + c, m = ((x & 32) ? 0x3400 : 0x3000) + ((y0 + r) & 31) * 32 + (x & 31);
    out.push(s.vram[m * 2] | (s.vram[m * 2 + 1] << 8));
  }
  return out;
}

// the same input to the game's level and the moved one
const input = (f: number) => 0x0100 | (f % 70 < 30 ? 0x8000 : 0) | (f % 200 > 150 ? 0x4000 : 0);
for (const [n, size, dy] of [[0x105, 0x0e, 32], [0x106, 0x0e, 32], [0x001, 0x0e, 32], [0x002, 0x0e, 32], [0x10b, 0x0e, 32], [0x105, 0x13, 62], [0x106, 0x1a, 271]]) {
  const game = cut(n, size), tall = moved(game, size, dy);
  const rows = levelRows(tall.secondary);
  const a = play(game), b = play(tall), d = dy * 16;
  let frames = 0, state = -1, tiles = 0, tilesBad = -1, below = 0;
  let still = 0; // frames the cameras have been the same (the tilemap follows a frame later)
  for (let f = 0; f < 600 && a.wram[RAM.gameMode] === 0x14 && a.wram[RAM.marioAnim] !== 9; f++) {
    step(a, input(f)); step(b, input(f)); frames++;
    const wa = a.wram, wb = b.wram;
    const same = marioX(wa) === marioX(wb) && marioY(wa) + d === marioY(wb) && sprites(wa, d) === sprites(wb, 0);
    if (!same && state < 0) state = f;
    for (let i = 0; i < SPRITE_SLOTS; i++) if (wb[SPR.status + i] && spriteY(wb, i) >= 0x200) below++;
    still = cameraX(wa) === cameraX(wb) && cameraY(wa) + d === cameraY(wb) ? still + 1 : 0;
    if (still >= 2) { tiles++; if (tilesBad < 0 && visible(a).join() !== visible(b).join()) tilesBad = f; }
  }
  const what = `level ${n.toString(16)} ${dy} rows lower (${rows} rows)`;
  check(state < 0 && frames > 100, `${what}: Mario and the sprites as in the game's level for ${frames} frames${state < 0 ? '' : ` – not from frame ${state}`}`);
  check(below > 0 || dy < 32, `${what}: sprites below the game's 32 rows (${below} sprite frames)`);
  check(tilesBad < 0 && tiles > 0, `${what}: the visible layer 1 tiles as in the game's level (${tiles} frames with the same camera)${tilesBad < 0 ? '' : ` – not in frame ${tilesBad}`}`);
}

// a pipe in the moved part: level 105's exit pipe (screen 7) leads where the game's does; the exit leads to
// a secondary entrance in the moved part of the level itself: Mario comes out at its tile, the camera above
// him by its offset
{
  const run = (dy: number, size: number, secondary: boolean) => {
    const lv = moved(cut(0x105, size), size, dy);
    const ty = 0x14 + dy;
    lv.sprites = [];
    lv.secondary = { ...lv.secondary, entranceScreen: 7, entranceX: 0, entranceXHi: 1, entranceY: ty & 15, entranceYHi: ty >> 4 };
    const idx = 0x1f0, ey = 20 + dy, v = -9 & 31;
    if (secondary) lv.exits = lv.exits.map((x) => ({ ...x, dest: idx, secondary: true }));
    const s = play(lv, (rom) => {
      if (secondary) writeSecondaryEntrance(rom, idx, { ...readSecondaryEntrance(rom, idx), destLevel: 0x05, screen: 2, entranceX: 5, entranceXHi: 0, entranceY: ey & 15, entranceYHi: ey >> 4, entranceTile: 1, action: 0, cameraRelative: 1, cameraOffsetHi: v >> 4, fgInitY: (v >> 2) & 3, bgInitY: v & 3, raw3: 8 });
    });
    const w = s.wram;
    w[RAM.marioX] = 0x88; // on the pipe's middle
    const start = marioY(w);
    let left = false, f = 0;
    for (; f < 400; f++) { step(s, 0x0400); if (w[RAM.gameMode] !== 0x14) left = true; if (left && w[RAM.gameMode] === 0x14) break; }
    return { start, left, x: marioX(w), y: marioY(w), cam: get16(w, RAM.layer1Y) };
  };
  const g = run(0, 0, false), t = run(32, 0x0e, false);
  check(t.start === g.start + 0x200 && g.left && t.left && t.x === g.x && t.y === g.y, `pipe 32 rows lower: leads where the game's does (Mario at ${t.x.toString(16)},${t.y.toString(16)}; the game's ${g.x.toString(16)},${g.y.toString(16)})`);
  const gs = run(0, 0, true), ts = run(32, 0x0e, true);
  check(gs.x === 0x250 && gs.y === 0x140 && ts.x === 0x250 && ts.y === 0x340, `secondary entrance at tile (5, 52) of screen 2: Mario at ${ts.x.toString(16)},${ts.y.toString(16)} (at row 20: ${gs.x.toString(16)},${gs.y.toString(16)})`);
  // the offset puts the camera 9 rows above him; it has moved a little by the time the level has faded in
  check(Math.abs(ts.y - ts.cam - 0x90) <= 0x10 && Math.abs(gs.y - gs.cam - 0x90) <= 0x10, `its camera about 9 rows above him: ${ts.cam.toString(16)} (at row 20: ${gs.cam.toString(16)})`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
