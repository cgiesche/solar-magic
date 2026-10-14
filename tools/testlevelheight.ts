// Level heights (levelheight.ts, Lunar Magic 3.00's taller horizontal levels): the level data's format
// (as observed in a Lunar Magic-saved ROM: screen jumps with a subscreen, Lunar Magic's new sprite
// format), and the game's own level load building a level with a size – level 105's objects moved
// down by a subscreen come out as in the game, only further down.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, OV_L1 } from '../src/core/levelemu.ts';
import {
  type Level, loadLevel, cloneLevel, serializeLayer1, serializeLevelSprites, serializeSprites, spriteSizes, parseLevelData, encodeSecondaryHeader, decodeSecondaryHeader,
  levelRows, maxScreens, isTall, insertScreen, hasLevelSize, newUid, SPRITE_MEMORY, LEVEL_SIZE_TABLE, readSecondaryHeader,
} from '../src/core/level.ts';
import { renderLevel } from '../src/core/render.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { mwlSections } from '../src/core/mwl.ts';
import { uploadFiles } from '../src/core/patchpkg.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hex = (b: ArrayLike<number>) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const N = 0x105;
const base = loadLevel(rom, N);
const sized = (lv: Level, size: number): Level => { const c = cloneLevel(lv); c.secondary = { ...c.secondary, levelSize: size }; return c; };
const reparse = (lv: Level) => parseLevelData(rom, N, serializeLayer1(rom, lv), null, lv.layer2Pointer, serializeLevelSprites(rom, lv), lv.secondary);

// sizes: Lunar Magic's heights and the screens that fit in the level data
check(levelRows(base.secondary) === 27 && maxScreens(base.secondary) === 32 && !isTall(base.secondary), 'the game\'s size: 27 rows, 32 screens');
check(levelRows({ levelSize: 0x01 }) === 28 && maxScreens({ levelSize: 0x01 }) === 32, 'size 01: 28 rows, 32 screens');
check(levelRows({ levelSize: 0x0d }) === 56 && maxScreens({ levelSize: 0x0d }) === 16 && isTall({ levelSize: 0x0d }), 'size 0D: 56 rows, 16 screens');
check(levelRows({ levelSize: 0x1a }) === 298 && maxScreens({ levelSize: 0x1a }) === 3, 'size 1A: 298 rows, 3 screens');
check(hasLevelSize(rom, 0x00) && !hasLevelSize(rom, 0x01) && !hasLevelSize(rom, 0x07) && !hasLevelSize(rom, 0x09), 'sizes in horizontal modes without layer 2 objects only');
check(readSecondaryHeader(rom, N).levelSize === 0 && rom.r8(LEVEL_SIZE_TABLE + 0x1ff) === 0, 'the editor\'s ROM: every level has the game\'s size');

// objects: a screen jump with the subscreen (000HHHHH 0000VVVV 00000001), the new screen flag keeps it
{
  const lv = sized(base, 0x0e);
  lv.objects = [
    { uid: newUid(), num: 0, ext: DM16_EXT, x: 0x07, y: 0x21, size: 0, tile: 0x130 }, // screen 0, row 33: subscreen 1
    { uid: newUid(), num: 0, ext: DM16_EXT, x: 0x17, y: 0x22, size: 0, tile: 0x130 }, // screen 1, same subscreen: new screen flag
    { uid: newUid(), num: 0, ext: DM16_EXT, x: 0x18, y: 0x03, size: 0, tile: 0x130 }, // back to subscreen 0
  ];
  lv.exits = [];
  const l1 = serializeLayer1(rom, lv);
  check(hex(l1.subarray(5)) === '00 01 01 01 07 02 30 01 00 82 07 02 30 01 00 01 00 01 03 08 02 30 01 00 ff', `layer 1: ${hex(l1.subarray(5))}`);
  const back = reparse(lv).objects.map((o) => `${o.x},${o.y}`).join(' ');
  check(back === '7,33 23,34 24,3', `parsed back: ${back}`);
  // without a size the nibble means nothing (the game ignores it)
  const plain = parseLevelData(rom, N, l1, null, lv.layer2Pointer, serializeLevelSprites(rom, base), base.secondary).objects.map((o) => o.y).join(',');
  check(plain === '1,2,3', `the same data in a level of the game's size: rows ${plain}`);
}

// sprites: Lunar Magic's new format in a tall level ($FF V: subscreen, $FF $FE: end, $FF $FF: a sprite starting with $FF)
{
  const lv = sized(base, 0x0e);
  lv.spriteHeader = 0x05;
  lv.sprites = [
    { uid: newUid(), num: 0x0f, x: 0x02, y: 0x0a, extra: 0 },
    { uid: newUid(), num: 0x0f, x: 0x05, y: 0x28, extra: 0 }, // subscreen 1
    { uid: newUid(), num: 0x0f, x: 0x10f, y: 0x3f, extra: 3 }, // first byte $FF
  ];
  const spr = serializeLevelSprites(rom, lv);
  check(hex(spr) === '25 a0 20 0f ff 01 80 50 0f ff ff f0 0f ff fe', `sprite data: ${hex(spr)}`);
  const back = reparse(lv);
  check(back.spriteHeader === 0x25 && back.sprites.map((s) => `${s.x},${s.y},${s.extra}`).join(' ') === '2,10,0 5,40,0 271,63,3', `parsed back: ${back.sprites.map((s) => `${s.x},${s.y}`).join(' ')}`);
  const small = sized(lv, 0);
  small.sprites = small.sprites.filter((s) => s.y < 27);
  small.spriteHeader = back.spriteHeader;
  check(hex(serializeLevelSprites(rom, small)) === '05 a0 20 0f ff', 'the game\'s size: the game\'s format, header bit 5 cleared');
  check(hex(serializeLevelSprites(rom, sized(base, 0x03)).subarray(0, 1)) === hex([base.spriteHeader]), 'size 03 (32 rows): the game\'s format');
}

// screens: no more than fit
{
  const lv = sized(base, 0x1a);
  lv.header = { ...lv.header, screens: 3 };
  let threw = false;
  try { insertScreen(rom, lv, 0); } catch { threw = true; }
  check(threw && lv.header.screens === 3, 'size 1A: no fourth screen');
}

// the game's level load: level 105 one subscreen further down (size 0E, 59 rows) is level 105 as the game
// loads it, 32 rows lower; above it the level's empty tile
{
  const tile = (r: ReturnType<LevelEmulator['load']>, a: number) => r.wram[a] | (r.wram[a + 0x10000] << 8);
  const screens = Math.min(base.header.screens, maxScreens({ levelSize: 0x0e }));
  const game = loadLevel(rom, N);
  game.header = { ...game.header, screens };
  game.objects = game.objects.filter((o) => o.x >> 4 < screens);
  const tall = sized(game, 0x0e);
  tall.objects = game.objects.map((o) => ({ ...o, y: o.y + 32 }));
  const ov = (lv: Level) => {
    const owners: number[] = [], byteOwner = new Int32Array(0x10000).fill(-1);
    const layer1 = serializeLayer1(rom, lv, owners);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    return { layer1, byteOwner, sprites: serializeLevelSprites(rom, lv), secondaryHeader: encodeSecondaryHeader(lv.secondary) };
  };
  const ra = emu.load(N, ov(game)), rb = emu.load(N, ov(tall));
  const ga = renderLevel(rom, ra, game.header.mode, screens).geom1, gb = renderLevel(rom, rb, tall.header.mode, screens, levelRows(tall.secondary)).geom1;
  check(ra.ok && rb.ok && gb.height === 59 && gb.width === screens * 16, `loaded: ${gb.width}×${gb.height} tiles`);
  let diff = 0, cells = 0, above = 0;
  for (let x = 0; x < ga.width; x++) {
    for (let y = 0; y < 27; y++) { cells++; if (tile(ra, ga.addr(x, y)) !== tile(rb, gb.addr(x, y + 32))) diff++; }
    for (let y = 0; y < 32; y++) if (tile(rb, gb.addr(x, y)) !== 0x25) above++;
  }
  check(diff === 0, `${cells} tiles as in the game, ${diff} differ`);
  check(above === 0, `rows 0-31 empty (${above} tiles not)`);
  // which object made a tile: the editor's selection
  const owners = new Set<number>();
  for (let x = 0; x < gb.width; x++) for (let y = 32; y < 59; y++) { const o = rb.owner[gb.addr(x, y) - 0xc800]; if (o >= 0) owners.add(o); }
  check(owners.size > game.objects.length / 2, `tiles have their objects (${owners.size} of ${game.objects.length})`);
  // the sprite memory without bit 5 (Lunar Magic's new sprite format)
  const rc = emu.load(N, { ...ov(tall), sprites: new Uint8Array([0x25, 0xff, 0xfe]) });
  check((rc.wram[0x1692] & ~SPRITE_MEMORY) === 0 && rc.wram[0x1692] === 5, `sprite memory ${rc.wram[0x1692].toString(16)} (header $25)`);
  // after the load the game's size again: the same data loads as in the game without the setup
  check(rb.wram[0x13666] === 0 && rb.wram[0x13667] === 0, 'the size is cleared after the load');
}

// objects across a screen edge in a tall level (Direct Map16 and the game's objects step screens alike)
{
  const lv = sized(base, 0x0e);
  lv.objects = [{ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x0e, y: 0x2a, size: 0x13, tile: 0x130 }]; // 4 wide, 2 high from (E, 2A)
  lv.exits = [];
  const r = emu.load(N, { layer1: serializeLayer1(rom, lv), sprites: serializeLevelSprites(rom, lv), secondaryHeader: encodeSecondaryHeader(lv.secondary) });
  const g = renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary)).geom1;
  const at = (x: number, y: number) => r.wram[g.addr(x, y)] | (r.wram[g.addr(x, y) + 0x10000] << 8);
  const got = [0x0e, 0x0f, 0x10, 0x11].flatMap((x) => [0x2a, 0x2b].map((y) => at(x, y)));
  check(got.every((t) => t === 0x130) && at(0x12, 0x2a) === 0x25 && at(0x0e, 0x2c) === 0x25, `Direct Map16 over the screen edge: ${got.map((t) => t.toString(16)).join(' ')}`);
}

// probes load their own layer 1 data, in the game's layout, also under a level with a size
{
  const sizedRom = new Rom(rom.data.slice());
  sizedRom.w8(LEVEL_SIZE_TABLE + N, 0x0e);
  const e2 = new LevelEmulator(sizedRom);
  const l1 = serializeLayer1(rom, base);
  const map = (r: ReturnType<LevelEmulator['load']>) => hex(r.wram.subarray(0xc800, 0x10000));
  const want = map(emu.load(N, { layer1: l1 }));
  check(map(e2.load(N, { layer1: l1 })) === want, 'layer 1 without a secondary header: the game\'s size');
  check(map(e2.load(N, { layer1: l1, secondaryHeader: [0, 0, 0, 0] })) === want, 'a secondary header without the size byte: the game\'s size');
  check(map(e2.load(N)) !== want, 'the level itself: its size');
}

// the level's size goes along: level file, Lunar Magic level file (level information byte 16)
{
  const lv = sized(base, 0x0d);
  lv.objects = lv.objects.map((o) => ({ ...o, y: o.y + 20 }));
  lv.header = { ...lv.header, screens: Math.min(lv.header.screens, 16) };
  const back = importLevelFile(rom, exportLevelFile(rom, lv), lv).level;
  check(back.secondary.levelSize === 0x0d && back.objects.map((o) => o.y).join() === lv.objects.map((o) => o.y).join(), 'level file keeps the size and the rows');
  const files = uploadFiles('s.zip', new Uint8Array(readFileSync('test/fixtures/sonicmaniasszact1.zip')));
  const mwl = [...files].find(([n]) => n.endsWith('.mwl'))![1].slice();
  const info = mwl[0x40] | (mwl[0x41] << 8) | (mwl[0x42] << 16);
  check(decodeSecondaryHeader(mwlSections(mwl).secondary).levelSize === 0, '.mwl of a level of the game\'s size: size 0');
  mwl[info + 16] = 0x9a; // T set, size 1A
  const sec = decodeSecondaryHeader(mwlSections(mwl).secondary);
  check(sec.levelSize === 0x1a && sec.levelSizeFlags === 0x80, '.mwl: the size from level information byte 16, Lunar Magic\'s flags kept');
}

// levels of the game's size: sprite data in the game's format, layer 1 stable (how the game loads them:
// testlevels)
{
  let same = 0;
  const list = [0x105, 0x106, 0x01f, 0x0c7, 0x013, 0x0dc];
  for (const l of list) {
    const a = loadLevel(rom, l), l1 = serializeLayer1(rom, a);
    const again = parseLevelData(rom, l, l1, null, a.layer2Pointer, serializeLevelSprites(rom, a), a.secondary);
    const game = serializeSprites(a.sprites, a.spriteHeader, false, spriteSizes(rom));
    if (hex(serializeLevelSprites(rom, a)) === hex(game) && hex(serializeLayer1(rom, again)) === hex(l1)) same++;
  }
  check(same === list.length, `levels of the game's size: sprite data in the game's format, layer 1 stable (${same}/${list.length})`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
