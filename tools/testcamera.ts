// The game view frame's scroll bands (BlockProber.cameraBands): where Mario is on the screen while the camera
// scrolls in each direction and after L/R, learned by moving him in the probe level; and placing the frame
// (gameViewAt).
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { gameViewAt, GAME_VIEW_W, GAME_VIEW_H, type Band } from '../src/core/camerabands.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fmt = (b: Band | null) => (b ? `${b.from}-${b.to}` : 'none');

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const prober = new BlockProber(rom);
const b = prober.cameraBands();
console.log(`     right ${fmt(b.right)}, left ${fmt(b.left)}, up ${fmt(b.up)}, down ${fmt(b.down)}, R ${fmt(b.lookRight)}, L ${fmt(b.lookLeft)}`);
const inside = (x: Band | null, size: number) => !!x && x.from >= 0 && x.to <= size && x.to - x.from >= 16;
check(['right', 'left', 'lookRight', 'lookLeft'].every((k) => inside(b[k as keyof typeof b], GAME_VIEW_W)), 'horizontal bands lie on the screen');
check(inside(b.up, GAME_VIEW_H) && inside(b.down, GAME_VIEW_H), 'vertical bands lie on the screen');
// the camera catches up with Mario: walking right he is held left of where he is held walking left
check(b.right!.from < b.left!.to - 16 && b.left!.from < b.right!.from, 'scrolling right holds Mario further left than scrolling left, turning around he is held further on');
// L/R look ahead: the camera holds him near the other edge
check(b.lookRight!.to <= b.right!.from, 'after R Mario is held left of the right band');
check(b.lookLeft!.from >= b.left!.to, 'after L Mario is held right of the left band');
check(b.up!.from < b.down!.from, 'scrolling up Mario is higher on the screen than scrolling down');
check(prober.cameraBands() === b, 'kept in the result cache');

// placing the frame: snapped to 8x8, inside the level
check(JSON.stringify(gameViewAt(13, 19, 4096, 432)) === '{"x":16,"y":16}', 'snaps to 8x8');
check(JSON.stringify(gameViewAt(5000, 400, 4096, 432)) === `{"x":${4096 - 256},"y":${432 - 224}}`, 'stays inside the level');
check(JSON.stringify(gameViewAt(-30, -9, 4096, 432)) === '{"x":0,"y":0}', 'not before the level start');
check(JSON.stringify(gameViewAt(40, 40, 200, 200)) === '{"x":0,"y":0}', 'a level smaller than the screen: at its start');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
