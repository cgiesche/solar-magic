// The game view frame's scroll bands (BlockProber.cameraBands): where Mario is on the screen while the camera
// scrolls in each direction and after L/R, learned by moving him in a probe level with the open level's mode and
// vertical scroll setting; and placing the frame (gameViewAt), kept where the game lets the camera go.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { loadLevel, serializeLayer1, serializeSprites, isL1Vertical } from '../src/core/level.ts';
import { GAME_VIEW_W, GAME_VIEW_H, type Band, type CameraBands } from '../src/core/camerabands.ts';
import { gameViewAt, cameraRange, cameraReachJob, type CameraReach } from '../src/core/camerareach.ts';
import { runJob } from '../src/core/runjob.ts';
import { VERTICAL_SCROLL } from '../src/core/names.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fmt = (b: Band | null) => (b ? `${b.from}-${b.to}` : 'none');
const all = (b: CameraBands) => `right ${fmt(b.right)}, left ${fmt(b.left)}, up ${fmt(b.up)}, down ${fmt(b.down)}, R ${fmt(b.lookRight)}, L ${fmt(b.lookLeft)}`;
const inside = (x: Band | null, size: number) => !!x && x.from >= 0 && x.to <= size && x.to - x.from >= 16;
const HORIZONTAL = ['right', 'left', 'lookRight', 'lookLeft'] as const;

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const prober = new BlockProber(rom);
const lv105 = loadLevel(rom, 0x105), lv134 = loadLevel(rom, 0x134);
const mode = lv105.header.mode;

// a horizontal level under each vertical scroll setting of the header
const bySetting = [0, 1, 2, 3].map((v) => prober.cameraBands(mode, v));
bySetting.forEach((b, v) => console.log(`     ${VERTICAL_SCROLL[v]}: ${all(b)}`));
const b = bySetting[1];
check(HORIZONTAL.every((k) => inside(b[k], GAME_VIEW_W)), 'horizontal bands lie on the screen');
check(inside(b.up, GAME_VIEW_H) && inside(b.down, GAME_VIEW_H), 'vertical bands lie on the screen');
// the camera catches up with Mario: walking right he is held left of where he is held walking left
check(b.right!.from < b.left!.to - 16 && b.left!.from < b.right!.from, 'scrolling right holds Mario further left than scrolling left, turning around he is held further on');
// L/R look ahead: the camera holds him near the other edge
check(b.lookRight!.to <= b.right!.from, 'after R Mario is held left of the right band');
check(b.lookLeft!.from >= b.left!.to, 'after L Mario is held right of the left band');
check(b.up!.from < b.down!.from, 'scrolling up Mario is higher on the screen than scrolling down');
check(prober.cameraBands(mode, 1) === b, 'kept in the result cache');
// the settings: no vertical scroll keeps the horizontal bands only, no scroll at all none
check(bySetting[0].up === null && bySetting[0].down === null && HORIZONTAL.every((k) => JSON.stringify(bySetting[0][k]) === JSON.stringify(b[k])), 'no vertical scroll: no up or down band, the horizontal ones the same');
check(Object.values(bySetting[3]).every((x) => x === null), 'no scroll at all: no band');
// rising as in the game: climbing scrolls up under "always" and "while flying, climbing …", a jump up a ledge
// only under "always" (the camera follows Mario on the ground); the band is not one of a forced speed
check(!!bySetting[2].up && !!b.up && b.up.from <= bySetting[2].up.from && b.up.to >= bySetting[2].up.to, `while climbing …: the up band from climbing alone, inside the one under always (${fmt(bySetting[2].up)} in ${fmt(b.up)})`);
check(!!bySetting[2].down, 'while climbing …: the camera follows Mario down again after he climbed');

// a vertical level: its own bands, sideways inside its two screens' width
const v = prober.cameraBands(lv134.header.mode, lv134.header.verticalScroll);
console.log(`     134 (vertical): ${all(v)}`);
check(isL1Vertical(rom, lv134.header.mode) && HORIZONTAL.every((k) => inside(v[k], GAME_VIEW_W)), '134 (vertical): horizontal bands on the screen');
check(v.lookRight!.to <= v.right!.from && v.lookLeft!.from >= v.left!.to, '134 (vertical): L/R look ahead there too');
check(inside(v.up, GAME_VIEW_H) && inside(v.down, GAME_VIEW_H), '134 (vertical): vertical bands on the screen');

// placing the frame: snapped to 8x8, inside the level
check(JSON.stringify(gameViewAt(13, 19, 4096, 432)) === '{"x":16,"y":16}', 'snaps to 8x8');
check(JSON.stringify(gameViewAt(5000, 400, 4096, 432)) === `{"x":${4096 - 256},"y":${432 - 224}}`, 'stays inside the level');
check(JSON.stringify(gameViewAt(-30, -9, 4096, 432)) === '{"x":0,"y":0}', 'not before the level start');
check(JSON.stringify(gameViewAt(40, 40, 200, 200)) === '{"x":0,"y":0}', 'a level smaller than the screen: at its start');

// and where the game lets the camera go: within its place along the level, across it where it went there
{
  const r: CameraReach = { vertical: false, spans: [], camera: { along: [8, 500], across: [[0, 100], null, [40, 192]] } };
  check(JSON.stringify(cameraRange(r, 0, 300)) === '{"x":8,"y":100}', 'camera range: from its first place, across where it went there');
  check(JSON.stringify(cameraRange(r, 600, 0)) === '{"x":500,"y":40}', 'camera range: up to its last place');
  check(JSON.stringify(cameraRange(r, 20, 150)) === '{"x":20,"y":100}', 'camera range: where it was not read, the nearest place it was');
  const rv: CameraReach = { vertical: true, spans: [], camera: { along: [0, 300], across: [[0, 256]] } };
  check(JSON.stringify(cameraRange(rv, 400, 999)) === '{"x":256,"y":300}', 'camera range in a vertical level: across is X');
  check(JSON.stringify(cameraRange({ vertical: false, spans: [], camera: null }, 7, 9)) === '{"x":7,"y":9}', 'camera range unknown: as put');
}
// level 105: the game stops the camera at Y $C0, before the level's bottom (432 - 224 = 208)
{
  const emu = new LevelEmulator(rom); emu.boot();
  const ov = { layer1: serializeLayer1(rom, lv105), sprites: serializeSprites(lv105.sprites, lv105.spriteHeader, false) };
  const w = lv105.header.screens * 256, h = 432;
  const reach = runJob(cameraReachJob(emu, { number: 0x105, vertical: false, ov, width: w, height: h }));
  check(!!reach?.camera && reach.camera.along[0] === 0 && reach.camera.along[1] === w - GAME_VIEW_W, `105: the camera goes from the level's start to its end (${JSON.stringify(reach?.camera?.along)})`);
  check(JSON.stringify(gameViewAt(0x800, 400, w, h, reach)) === '{"x":2048,"y":192}', `105: the frame dragged to the bottom stops where the camera does (${JSON.stringify(gameViewAt(0x800, 400, w, h, reach))})`);
  check(JSON.stringify(gameViewAt(0x800, -50, w, h, reach)) === '{"x":2048,"y":0}', '105: and at the top');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
