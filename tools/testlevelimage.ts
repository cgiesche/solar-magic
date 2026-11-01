// Levels as image files (core/levelimage.ts): the levels chosen by number, the file names, a level's layers
// drawn by its emulated load, and the screens it uses (to crop the image to) – layer 1's tiles and the sprites.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, cloneLevel, serializeLevelSprites, newUid, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { renderLevelImages, usedScreens, screensSize, levelImageName, parseLevelList, SCREEN_PX } from '../src/core/levelimage.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// the levels chosen
{
  const r = parseLevelList('105, 106-108 1a 105');
  check('levels' in r && r.levels.join(',') === '26,261,262,263,264', `list and ranges, each once, ascending: ${JSON.stringify(r)}`);
  check('error' in parseLevelList(''), 'nothing given: an error');
  check('error' in parseLevelList('200'), 'above 1FF: an error');
  check('error' in parseLevelList('10A-105'), 'a range backwards: an error');
  check('error' in parseLevelList('yoshi'), 'not a number: an error');
}

// file names
check(levelImageName(0x105, 'Yoshi\'s Island 1') === '105 Yoshi\'s Island 1.png', 'number and name');
check(levelImageName(0x1a, '') === '01A.png', 'a level without a name: its number');
check(levelImageName(0x13, 'A/B: C?  ') === '013 A_B_ C_.png', `characters file systems refuse: ${levelImageName(0x13, 'A/B: C?  ')}`);

// a level drawn, and the screens it uses
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const ov = (lv: Level) => ({ ...levelOverride(rom, lv), sprites: serializeLevelSprites(rom, lv) });
const draw = (lv: Level) => {
  const r = renderLevelImages(rom, emu, lv, ov(lv));
  if ('error' in r) throw new Error(r.error);
  return r.images;
};
{
  const lv = loadLevel(rom, 0x105), im = draw(lv);
  check(im.width === lv.header.screens * SCREEN_PX && !im.geom1.vertical, `level 105: ${lv.header.screens} screens wide (${im.width} pixels)`);
  const used = usedScreens(im, lv);
  check(used === lv.header.screens, `level 105 uses all its ${lv.header.screens} screens: ${used}`);

  // more screens than it uses: cropped back to its own
  const wide = cloneLevel(lv);
  wide.header = { ...wide.header, screens: lv.header.screens + 4 };
  const imw = draw(wide), usedw = usedScreens(imw, wide);
  check(imw.width === wide.header.screens * SCREEN_PX && usedw === used, `with 4 empty screens more: still ${usedw} used`);
  const size = screensSize(imw, usedw);
  check(size.width === used * SCREEN_PX && size.height === imw.height, `cropped to ${size.width}x${size.height}`);

  // a sprite on the last empty screen uses it
  const spr = cloneLevel(wide);
  spr.sprites = [...spr.sprites, { uid: newUid(), num: 0x0d, x: (wide.header.screens - 1) * 16 + 4, y: 0x10, extra: 0 }];
  const ims = draw(spr);
  check(usedScreens(ims, spr) === spr.header.screens, `a sprite on the last screen: all ${spr.header.screens} used`);
}
{
  // a vertical level: screens are rows of the image
  const lv = loadLevel(rom, 0x109), im = draw(lv);
  if (!im.geom1.vertical) check(false, 'level 109 is vertical');
  else {
    const used = usedScreens(im, lv), size = screensSize(im, used);
    check(used >= 1 && used <= lv.header.screens && size.width === im.width && size.height === used * SCREEN_PX, `vertical level 109: ${used} of ${lv.header.screens} screens, ${size.width}x${size.height}`);
  }
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
