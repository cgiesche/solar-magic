// Playing a taller horizontal level (levelheight.ts, vrampatch.ts), checked by emulation: a level of the game
// moved down into a taller level must play exactly like the game's – the same input gives Mario and every
// sprite the same positions (moved down), the visible layer 1 tiles are the same whenever the cameras are,
// a pipe in the moved part leads where the game's does, and an entrance in it puts Mario there.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import {
  type Level, loadLevel, cloneLevel, maxScreens, entrancePos, mainSpot, levelRows, readSecondaryEntrance, writeSecondaryEntrance,
} from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { GM, RAM, MARIO_DYING, PAD, SPR, SPRITE_SLOTS, get16, marioX, marioY, cameraX, cameraY, spriteX, spriteY } from '../src/core/ram.ts';
import { loadAsar } from '../src/core/asar.ts';
import { uploadFiles, uploadFromFiles } from '../src/core/patchpkg.ts';
import { planPixiUpload, applyPixiUpload } from '../src/core/pixipkg.ts';
import { savePixiProject, parsePixiList } from '../src/core/pixi.ts';
import { map16Tile, MAP_BASE } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
let base = new Rom(await editorImage());

// the level moved down by dy rows into a level of the given size; Mario starts at the game's entrance
// (moved down), the camera as far above him as in the game (Lunar Magic's tile entrance, relative camera)
function moved(game: Level, size: number, dy: number): Level {
  const lv = cloneLevel(game);
  lv.secondary = { ...lv.secondary, levelSize: size };
  lv.objects = lv.objects.map((o) => ({ ...o, y: o.y + dy }));
  lv.sprites = lv.sprites.map((o) => ({ ...o, y: o.y + dy }));
  const s = game.secondary, p = entrancePos(base, mainSpot(s), false);
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
  return PlaySession.start(new LevelEmulator(rom), lv.number).emu.snes;
}
type S = ReturnType<typeof play>;
// one game frame ($14 advances; a lag frame more or less doesn't count)
function step(s: S, joy: number): void {
  const f0 = s.wram[RAM.frameCounter];
  s.joy1 = joy;
  for (let n = 0; n < 10; n++) { s.runFrame(); if (s.wram[RAM.frameCounter] !== f0) break; }
}
const sprites = (w: Uint8Array, dy: number) => Array.from({ length: SPRITE_SLOTS }, (_, i) =>
  w[SPR.status + i] ? `${w[SPR.num + i]}:${spriteX(w, i)},${(spriteY(w, i) + dy) & 0xffff}` : '').join('|');
// the visible layer 1 tilemap (SMWV's 64x32 at $3000, rows modulo 32 in both); a 33rd column only while the
// camera's fine scroll shows part of it (else it can lie past the level's last screen)
function visible(s: S): number[] {
  const out: number[] = [], w = s.wram, x0 = cameraX(w) >> 3, y0 = cameraY(w) >> 3, cols = cameraX(w) & 7 ? 33 : 32;
  for (let r = 0; r < 28; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c, m = ((x & 32) ? 0x3400 : 0x3000) + ((y0 + r) & 31) * 32 + (x & 31);
    out.push(s.vram[m * 2] | (s.vram[m * 2 + 1] << 8));
  }
  return out;
}

// the same input to the game's level and the moved one
const input = (f: number) => PAD.right | (f % 70 < 30 ? PAD.b : 0) | (f % 200 > 150 ? PAD.y : 0);
function compare(n: number, size: number, dy: number, note = ''): void {
  const game = cut(n, size), tall = moved(game, size, dy);
  const rows = levelRows(tall.secondary);
  const a = play(game), b = play(tall), d = dy * 16;
  let frames = 0, state = -1, tiles = 0, tilesBad = -1, below = 0;
  let still = 0; // frames the cameras have been the same (the tilemap follows a frame later)
  for (let f = 0; f < 600 && a.wram[RAM.gameMode] === GM.level && a.wram[RAM.marioAnim] !== MARIO_DYING; f++) {
    step(a, input(f)); step(b, input(f)); frames++;
    const wa = a.wram, wb = b.wram;
    const same = marioX(wa) === marioX(wb) && marioY(wa) + d === marioY(wb) && sprites(wa, d) === sprites(wb, 0);
    if (!same && state < 0) state = f;
    for (let i = 0; i < SPRITE_SLOTS; i++) if (wb[SPR.status + i] && spriteY(wb, i) >= 0x200) below++;
    still = cameraX(wa) === cameraX(wb) && cameraY(wa) + d === cameraY(wb) ? still + 1 : 0;
    if (still >= 2) { tiles++; if (tilesBad < 0 && visible(a).join() !== visible(b).join()) tilesBad = f; }
  }
  const what = `level ${n.toString(16)} ${dy} rows lower (${rows} rows)${note}`;
  check(state < 0 && frames > 100, `${what}: Mario and the sprites as in the game's level for ${frames} frames${state < 0 ? '' : ` – not from frame ${state}`}`);
  check(below > 0 || dy < 32, `${what}: sprites below the game's 32 rows (${below} sprite frames)`);
  check(tilesBad < 0 && tiles > 0, `${what}: the visible layer 1 tiles as in the game's level (${tiles} frames with the same camera)${tilesBad < 0 ? '' : ` – not in frame ${tilesBad}`}`);
}
// also the sizes shorter than 32 rows (28, 29 and 32); a level moves by an even number of rows where its
// sprites look at their row: the bouncing Paratroopa jumps higher from an odd row ($01856C keeps Y bit 4)
for (const [n, size, dy] of [[0x105, 0x0e, 32], [0x106, 0x0e, 32], [0x001, 0x0e, 32], [0x002, 0x0e, 32], [0x10b, 0x0e, 32], [0x105, 0x13, 62], [0x106, 0x1a, 271], [0x105, 0x01, 1], [0x106, 0x02, 2], [0x001, 0x01, 0], [0x002, 0x02, 2], [0x105, 0x03, 5], [0x105, 0x1b, 421], [0x105, 0x1c, 869]]) compare(n, size, dy);

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
      if (secondary) writeSecondaryEntrance(rom, idx, { ...readSecondaryEntrance(rom, idx), destLevel: 0x105, screen: 2, entranceX: 5, entranceXHi: 0, entranceY: ey & 15, entranceYHi: ey >> 4, entranceTile: 1, action: 0, cameraRelative: 1, cameraOffsetHi: v >> 4, fgInitY: (v >> 2) & 3, bgInitY: v & 3, slippery: 0 });
    });
    const w = s.wram;
    w[RAM.marioX] = 0x88; // on the pipe's middle
    const start = marioY(w);
    let left = false, f = 0;
    for (; f < 400; f++) { step(s, PAD.down); if (w[RAM.gameMode] !== GM.level) left = true; if (left && w[RAM.gameMode] === GM.level) break; }
    return { start, left, x: marioX(w), y: marioY(w), cam: get16(w, RAM.layer1Y) };
  };
  const g = run(0, 0, false), t = run(32, 0x0e, false);
  check(t.start === g.start + 0x200 && g.left && t.left && t.x === g.x && t.y === g.y, `pipe 32 rows lower: leads where the game's does (Mario at ${t.x.toString(16)},${t.y.toString(16)}; the game's ${g.x.toString(16)},${g.y.toString(16)})`);
  const gs = run(0, 0, true), ts = run(32, 0x0e, true);
  check(gs.x === 0x250 && gs.y === 0x140 && ts.x === 0x250 && ts.y === 0x340, `secondary entrance at tile (5, 52) of screen 2: Mario at ${ts.x.toString(16)},${ts.y.toString(16)} (at row 20: ${gs.x.toString(16)},${gs.y.toString(16)})`);
  // the offset puts the camera 9 rows above him; it has moved a little by the time the level has faded in
  check(Math.abs(ts.y - ts.cam - 0x90) <= 0x10 && Math.abs(gs.y - gs.cam - 0x90) <= 0x10, `its camera about 9 rows above him: ${ts.cam.toString(16)} (at row 20: ${gs.cam.toString(16)})`);
}

// a secondary entrance numbered $100 and up, as the game has it: level 105's exit pipe to the game's $1CB (back
// into level 105 by the pipe cannon of screen 8) shoots Mario out over screen 8 inside the level, the camera
// at the game's lowest – the entrance code takes its tables' indexes with a 16-bit TAX, so a hook must leave
// A's high byte 0 (Mario's Y was $65D8)
{
  const lv = moved(cut(0x105, 0), 0, 0);
  lv.sprites = [];
  lv.secondary = { ...lv.secondary, entranceScreen: 7, entranceX: 0, entranceXHi: 1, entranceY: 0x14 & 15, entranceYHi: 0x14 >> 4 };
  lv.exits = lv.exits.map((x) => ({ ...x, dest: 0x1cb, secondary: true }));
  const s = play(lv), w = s.wram;
  w[RAM.marioX] = 0x88;
  let left = false, f = 0;
  for (; f < 400; f++) { step(s, PAD.down); if (w[RAM.gameMode] !== GM.level) left = true; if (left && w[RAM.gameMode] === GM.level) break; }
  for (let n = 0; n < 60; n++) step(s, 0);
  const x = marioX(w), y = marioY(w), at = `${x.toString(16)},${y.toString(16)} camera ${cameraX(w).toString(16)},${cameraY(w).toString(16)}`;
  check(left && x >> 8 >= 8 && x >> 8 <= 9 && y < 0x1b0 && cameraY(w) === 0xc0, `secondary entrance $1CB: Mario shot out of the pipe cannon at ${at}`);
}

// the camera over the whole height: Mario starts at row 2 of a level of 89 rows, above level 105 moved to its
// bottom, and falls onto its ground; the camera starts at the top, follows him down to the level's bottom
// (its height less a screen) and shows the ground there as the game's level does at its bottom
{
  const size = 0x13, dy = 62, game = cut(0x105, size), lv = moved(game, size, dy);
  lv.sprites = [];
  lv.secondary = { ...lv.secondary, entranceY: 2, entranceYHi: 0 };
  const a = play(game), b = play(lv), wa = a.wram, wb = b.wram;
  const top = cameraY(wb), bottom = (levelRows(lv.secondary) << 4) - 0xf0;
  let max = 0, f = 0, landed = -1;
  for (; f < 600 && landed < 0; f++) {
    step(b, 0); max = Math.max(max, cameraY(wb));
    if (wb[RAM.marioBlocked] & 4) landed = f;
  }
  for (let n = 0; n < 60; n++) { step(a, 0); step(b, 0); } // the cameras settle
  const yA = marioY(wa), yB = marioY(wb);
  check(top === 0, `taller level: the camera starts at the top with Mario at row 2 (${top.toString(16)})`);
  check(landed >= 0 && yB === yA + dy * 16, `taller level: Mario falls onto the ground at the bottom (Y ${yB.toString(16)}, the game's ${yA.toString(16)} + ${(dy * 16).toString(16)}${landed < 0 ? ', not landed' : ''})`);
  check(max === bottom && cameraY(wb) === cameraY(wa) + dy * 16, `taller level: the camera follows him to the bottom (${max.toString(16)} of ${bottom.toString(16)}; then ${cameraY(wb).toString(16)}, the game's ${cameraY(wa).toString(16)} + ${(dy * 16).toString(16)})`);
  check(visible(a).join() === visible(b).join(), 'taller level: the visible layer 1 tiles at the bottom as the game\'s');
}

// the BG with the camera relative to Mario: at the level's bottom it shows its own bottom (its height less a
// screen), whatever layer 2's vertical rate – the game's 16 paired settings and the separate rates 0-8
{
  const size = 0x13, dy = 62, bgRows = 27, bgBottom = (bgRows << 4) - 0xf0;
  const wrong: string[] = [];
  const settings = [...Array.from({ length: 16 }, (_, i) => ({ layer2Scroll: i, layer2Separate: 0, layer2V: 0 })),
    ...Array.from({ length: 9 }, (_, v) => ({ layer2Scroll: 1, layer2Separate: 1, layer2V: v }))];
  for (const l2 of settings) {
    const lv = moved(cut(0x105, size), size, dy);
    lv.sprites = [];
    lv.secondary = { ...lv.secondary, ...l2, layer2HAuto: 0, entranceY: 2, entranceYHi: 0, bgRelative: 0, bgHeight: bgRows - 1 };
    const s = play(lv), w = s.wram;
    for (let f = 0; f < 600 && !(w[RAM.marioBlocked] & 4); f++) step(s, 0);
    for (let n = 0; n < 60; n++) step(s, 0);
    const name = l2.layer2Separate ? `separate V ${l2.layer2V}` : `paired ${l2.layer2Scroll.toString(16)}`;
    if (cameraY(w) !== (levelRows(lv.secondary) << 4) - 0xf0 || get16(w, RAM.layer2Y) !== bgBottom) wrong.push(`${name}: ${get16(w, RAM.layer2Y).toString(16)}`);
  }
  check(!wrong.length, `taller level: at its bottom the BG shows its bottom (${bgBottom.toString(16)}) at every vertical rate${wrong.length ? ` – not ${wrong.join(', ')}` : ''}`);
}

// with custom sprites the editor's PIXI runtime loads the sprites (its own loop over the list): the same,
// and a custom sprite in the moved part spawns there
{
  await loadAsar();
  const rom = new Rom(base.data.slice());
  const upload = uploadFromFiles('BrutalBill.zip', uploadFiles('BrutalBill.zip', new Uint8Array(readFileSync('test/fixtures/BrutalBill.zip'))));
  const res = applyPixiUpload(rom, upload, planPixiUpload(rom, upload), new Set(), () => {});
  check(res.ok, 'PIXI runtime installed (BrutalBill)');
  base = rom;
  compare(0x105, 0x0e, 32, ', PIXI\'s loader');
  const lv = moved(cut(0x105, 0x0e), 0x0e, 32);
  lv.sprites = [{ ...lv.sprites[0], num: 0x00, extra: 2, x: 0x0c, y: 0x34 }]; // custom sprite 00, row 52
  const s = play(lv), w = s.wram;
  let x = -1, y = -1;
  for (let f = 0; f < 30 && x < 0; f++) { step(s, 0); for (let i = 0; i < SPRITE_SLOTS; i++) if (w[SPR.status + i]) { x = spriteX(w, i); y = spriteY(w, i); } }
  check(Math.abs(x - 0xc0) < 8 && Math.abs(y - 0x340) < 8, `custom sprite at row 52 spawned there (${x.toString(16)},${y.toString(16)} in its first frame)`);
}

// PIXI's GetMap16/ChangeMap16 (the editor's) below row 31: block (3, 57) of level 105 moved 32 rows down is
// the game's (3, 25); changed, it is in the level data at its place
{
  const code = `print "INIT ",pc
  RTL
print "MAIN ",pc
  LDA $7FB0FF : BEQ + : RTL
+ LDA #$01 : STA $7FB0FF
  STZ $1933
  REP #$20 : LDA #$0390 : STA $98 : LDA #$0030 : STA $9A
  %GetMap16() : STA $7FB020
  LDA #$0130 : %ChangeMap16()
  LDA #$0390 : STA $98 : LDA #$0030 : STA $9A
  %GetMap16() : STA $7FB022
  SEP #$20
  RTL
`;
  const rom = new Rom((await editorImage()).slice());
  const res = savePixiProject(rom, { files: new Map([
    ['sprites/m16.cfg', new TextEncoder().encode('01\n36\n00 00 3B 80 00 00\n00 00\nm16.asm\n00:00\n')],
    ['sprites/m16.asm', new TextEncoder().encode(code)],
  ]), list: parsePixiList('00 m16.cfg\n') });
  base = rom;
  const lv = moved(cut(0x105, 0x0e), 0x0e, 32);
  lv.sprites = [{ ...lv.sprites[0], num: 0x00, extra: 2, x: 6, y: 0x36 }];
  const s = play(lv), w = s.wram;
  for (let f = 0; f < 20; f++) step(s, 0);
  const at = (a: number) => w[a - 0x7e0000] | (w[a - 0x7e0000 + 1] << 8);
  const before = map16Tile(new LevelEmulator(new Rom((await editorImage()).slice())).load(0x105).wram, MAP_BASE + 3 + 25 * 16);
  const here = map16Tile(w, MAP_BASE + 3 + 57 * 16);
  check(res.ok && w[0x1b0ff] === 1 && at(0x7fb020) === before && at(0x7fb022) === 0x130 && here === 0x130,
    `GetMap16 below row 31: ${at(0x7fb020).toString(16)} (the game's ${before.toString(16)}); after ChangeMap16 ${at(0x7fb022).toString(16)}, level data ${here.toString(16)}`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
