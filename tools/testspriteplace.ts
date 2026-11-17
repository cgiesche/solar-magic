// Where a sprite's image is placed (spritegfx.ts SpriteImage ox/oy): where the game draws the sprite, seen from the
// tile it was placed at, without the way it went by its speed since. The game's own: a Koopa stays on its tile
// though it walked, a Piranha Plant stands between two tiles (its INIT moves it 8 pixels), the brown chained platform
// (its code writes the platform's place into the sprite's position each frame) and a Ball 'n' Chain hang at the tile
// they turn around. A sprite of a load with a tile below the screen is captured again alone (the ball's lower half).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { captureSprites, captureSpriteAt, type SpriteImage } from '../src/core/spritegfx.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const lv = loadLevel(rom, 0x007);
const L = { number: lv.number, header: lv.header, spriteHeader: lv.spriteHeader, bgPointer: 0xffd900 };
const box = (s: SpriteImage | null | undefined) => (s ? `${s.w}x${s.h} at ${s.ox},${s.oy}` : 'none');

const m = captureSprites(emu, L, [0x04, 0x1a, 0x5f, 0x9e]);
const koopa = m.get(0x04), plant = m.get(0x1a), plat = m.get(0x5f), ball = m.get(0x9e);
check(!!koopa && koopa.ox === 0 && koopa.oy === -16, `a Koopa on its tile, a tile taller (${box(koopa)})`);
check(!!plant && plant.ox === 8, `a Piranha Plant between two tiles (${box(plant)})`);
// (the platform turns around a place right below the tile, its chain's length away: at -112,-96 it was drawn by
// the sprite's position, which is the platform's)
check(!!plat && plat.ox >= 0 && plat.ox < 32 && plat.oy >= 0 && plat.oy < 32, `the brown chained platform by the tile (${box(plat)})`);
check(!!ball && ball.w === 32 && ball.h === 64 && ball.ox === -4 && ball.oy === 16, `a Ball 'n' Chain: the chain from the tile down, the ball at its end (${box(ball)})`);
// placed alone at a tile (the images of sprites that start by where they are)
for (const x of [0, 1]) {
  const at = captureSpriteAt(emu, L, 0x9e, x, 2);
  check(!!at && at.oy === 16 && Math.abs(at.ox + 8) <= 1, `a Ball 'n' Chain at tile X ${x}: turning ${x ? 'right' : 'left'} from below its tile (${box(at)})`);
}
const at = captureSpriteAt(emu, L, 0x1a, 0, 2);
check(!!at && at.ox === 8, `a Piranha Plant placed alone between two tiles (${box(at)})`);

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
