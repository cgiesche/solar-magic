// Sprite positions in vertical levels (parseSprites/serializeSprites), checked by emulation: a sprite spawns
// where the editor shows it – the game's loader takes tile X from byte 0's high nibble and tile Y from
// byte 1's, the other way round than in a horizontal level. Vanilla 12A and sprites placed there.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { type Level, loadLevel, cloneLevel, isL1Vertical } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { SPR, SPRITE_SLOTS, spriteX, spriteY } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const base = new Rom(await editorImage());

// the tile each sprite number spawns at in the first frames of playing the level
function spawned(lv: Level): Map<number, string> {
  const rom = new Rom(base.data.slice());
  saveLevel(rom, cloneLevel(lv));
  const s = PlaySession.start(new LevelEmulator(rom), lv.number).emu.snes;
  const at = new Map<number, string>();
  for (let f = 0; f < 60; f++) {
    s.runFrame();
    for (let i = 0; i < SPRITE_SLOTS; i++) {
      const num = s.wram[SPR.num + i];
      if (s.wram[SPR.status + i] && !at.has(num)) at.set(num, `${hx(spriteX(s.wram, i) >> 4)}/${hx(spriteY(s.wram, i) >> 4)}`);
    }
  }
  return at;
}
const shown = (lv: Level, num: number) => lv.sprites.filter((o) => o.num === num).map((o) => `${hx(o.x)}/${hx(o.y)}`);

const game = loadLevel(base, 0x12a);
check(isL1Vertical(base, game.header.mode), '12A is vertical');
{
  // stationary sprites near the entrance: the info box, the wall springboard (X and Y low nibbles differ)
  const at = spawned(game);
  for (const num of [0xb9, 0x6b]) check(shown(game, num).includes(at.get(num) ?? '-'), `12A: sprite ${hx(num)} shown at ${shown(game, num).join(', ')}, spawns at ${at.get(num)}`);
}
{
  // sprites the editor places (written by serializeSprites): they spawn there
  const lv = cloneLevel(game);
  const b9 = lv.sprites.find((o) => o.num === 0xb9)!;
  lv.sprites = [{ ...b9, x: 0x0c, y: 0x47 }, { ...b9, uid: b9.uid + 1, num: 0x6b, x: 0x0e, y: 0x45 }];
  const at = spawned(lv);
  check(at.get(0xb9) === '0C/47' && at.get(0x6b) === '0E/45', `placed at 0C/47 and 0E/45: spawned at ${at.get(0xb9)} and ${at.get(0x6b)}`);
}
process.exit(bad ? 1 : 0);
