// Changing the level header (levelheader.ts): the level sizes possible with their reasons, and a header
// change applied by the level mode's rules or refused.
import { Rom } from '../src/core/rom.ts';
import { loadLevel, hasLayer2Objects, hasLevelSize, maxScreens, isL1Vertical, L2_PTRS, newUid, type Level } from '../src/core/level.ts';
import { levelSizeOptions, applyHeaderChange, headerRefusal, fallbackBgPointer, levelBgPointer, NO_HEIGHTS, type HeaderChange } from '../src/core/levelheader.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());
const levels = Array.from({ length: 0x200 }, (_, n) => n);
const plain = loadLevel(rom, 0x105);
check(hasLevelSize(rom, plain.header.mode), `level 105 (mode ${plain.header.mode}) has heights`);
const l2n = levels.find((n) => { const lv = loadLevel(rom, n); return !!lv.layer2Objects && !isL1Vertical(rom, lv.header.mode); })!;
const noHeightsMode = 0x01; // horizontal, layer 2 objects
check(!hasLevelSize(rom, noHeightsMode) && hasLayer2Objects(noHeightsMode), 'mode 01 has layer 2 objects and no heights');
const plainMode = plain.header.mode;

const fresh = (n: number): Level => loadLevel(rom, n);
const changeOf = (lv: Level, c: Partial<HeaderChange> = {}): HeaderChange =>
  ({ header: { ...lv.header }, secondary: { ...lv.secondary }, rates: null, spriteHeader: lv.spriteHeader, bgPointer: null, ...c });

// level 105's layer 2 pointer, and the BG a level of layer 2 objects shows
check(fallbackBgPointer(rom) === rom.r24(L2_PTRS + 0x105 * 3), 'the fallback BG is level 105\'s layer 2 pointer');
check(levelBgPointer(rom, fresh(l2n)) === fallbackBgPointer(rom), `level ${l2n.toString(16)} (layer 2 objects) shows level 105's BG`);
check(levelBgPointer(rom, plain) === plain.layer2Pointer, 'level 105 shows its own BG');

// size options: all possible in an empty-ish level; a mode without heights only the game's
{
  const opts = levelSizeOptions(rom, { objects: [], sprites: [] }, plainMode, 1);
  check(opts.length === 0x1d && opts.every((o) => !o.reason), 'level sizes 00-1C, all possible for one screen without objects');
  check(opts.every((o) => o.screens === maxScreens({ levelSize: o.size })), 'each with the screens it leaves room for');
  const none = levelSizeOptions(rom, { objects: [], sprites: [] }, noHeightsMode, 1);
  check(!none[0].reason && none.slice(1).every((o) => o.reason === NO_HEIGHTS), 'a mode without heights: only the game\'s');
  const many = levelSizeOptions(rom, { objects: [], sprites: [] }, plainMode, 32);
  check(many.every((o) => !o.reason === (o.screens >= 32)), 'sizes leaving room for fewer screens than the level has: not possible');
  const deep = { objects: [{ ...plain.objects[0], y: 0x40 }], sprites: [] };
  const d = levelSizeOptions(rom, deep, plainMode, 1);
  check(d[0].reason === 'Objects or sprites lie down to row 040' && d.some((o) => !o.reason && o.rows > 0x40), `objects lying below: the sizes above them not possible (${d[0].reason})`);
}

// a mode without heights resets the size, the screens clamped to the size
{
  const lv = fresh(0x105);
  lv.secondary.levelSize = 0x10; lv.header.screens = 3;
  const c = changeOf(lv, { header: { ...lv.header, mode: noHeightsMode } });
  check(applyHeaderChange(rom, lv, c) === '', 'mode without heights: applied');
  check(lv.secondary.levelSize === 0, 'mode without heights: back to the game\'s size');
  check(!!lv.layer2Objects && lv.layer2Objects.length === 0 && lv.layer2Header?.length === 5, 'switching to layer 2 objects: empty layer 2 object data');
}
{
  const lv = fresh(0x105);
  const small = levelSizeOptions(rom, lv, plainMode, 1).find((o) => o.screens < 32 && o.screens >= 1 && !o.reason)!;
  lv.header.screens = 32;
  const c = changeOf(lv, { secondary: { ...lv.secondary, levelSize: small.size } });
  c.header.screens = 32;
  check(applyHeaderChange(rom, lv, c) === '' && lv.header.screens === small.screens && lv.secondary.levelSize === small.size,
    `screens clamped to what size ${small.size.toString(16)} leaves room for (${lv.header.screens})`);
}

// refused while objects lie below the chosen size: the level unchanged
{
  const lv = fresh(0x105);
  lv.secondary.levelSize = 0x10; lv.objects.push({ ...lv.objects[0], uid: newUid(), y: 0x40 });
  const before = JSON.stringify({ h: lv.header, s: lv.secondary, l2: lv.layer2Objects });
  const c = changeOf(lv, { header: { ...lv.header, mode: noHeightsMode } });
  const why = applyHeaderChange(rom, lv, c);
  check(why.includes('no heights') && why.includes('row 040'), `mode without heights refused while objects lie below: ${why}`);
  check(JSON.stringify({ h: lv.header, s: lv.secondary, l2: lv.layer2Objects }) === before, 'refused: the level unchanged');
  const small = changeOf(lv, { secondary: { ...lv.secondary, levelSize: 0 } });
  check(headerRefusal(rom, lv, small).includes('row 040'), 'a size above the objects refused');
  check(headerRefusal(rom, lv, changeOf(lv)) === '', 'the level\'s own size kept: not refused');
}

// switching from layer 2 objects: dropped, the BG level 105's
{
  const lv = fresh(l2n);
  const c = changeOf(lv, { header: { ...lv.header, mode: plainMode } });
  check(applyHeaderChange(rom, lv, c) === '' && lv.layer2Objects === null, 'switching from layer 2 objects: dropped');
  check(lv.layer2Pointer === fallbackBgPointer(rom), 'and layer 2 takes level 105\'s BG');
  const same = fresh(l2n), objs = same.layer2Objects;
  applyHeaderChange(rom, same, changeOf(same));
  check(same.layer2Objects === objs, 'mode kept: layer 2 objects kept');
}

// the BG tilemap chosen, or the edited one kept
{
  const lv = fresh(0x105);
  lv.bg = new Uint16Array(4);
  applyHeaderChange(rom, lv, changeOf(lv));
  check(!!lv.bg, 'no BG chosen: the edited BG stays');
  applyHeaderChange(rom, lv, changeOf(lv, { bgPointer: 0x0cabcd }));
  check(lv.bg === null && lv.layer2Pointer === 0x0cabcd, 'a BG chosen: the level takes it');
}

// layer 2 scroll: paired or separate rates
{
  const lv = fresh(0x105);
  applyHeaderChange(rom, lv, changeOf(lv, { rates: { h: 0x12, v: 3 } }));
  check(lv.secondary.layer2Separate === 1 && lv.secondary.layer2Scroll === 2 && lv.secondary.layer2HAuto === 1 && lv.secondary.layer2V === 3, 'separate rates set');
  applyHeaderChange(rom, lv, changeOf(lv, { secondary: { ...lv.secondary, layer2Scroll: 5 } }));
  check(lv.secondary.layer2Separate === 0 && lv.secondary.layer2HAuto === 0 && lv.secondary.layer2V === 0 && lv.secondary.layer2Scroll === 5, 'paired setting: separate rates cleared');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
