// Custom sprites (PIXI format): sprite entries with extra bytes (size table at $0EF30C) are parsed and
// written back, and level files carry the size table they were written with.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadLevel, parseSprites, serializeSprites, spriteSizes, SPR_SIZE_PTR, newUid, type LevelSprite } from '../src/core/level.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));

// ---- level format with extra bytes
check(spriteSizes(rom) === null, 'vanilla ROM: no size table');
const sizes = new Uint8Array(0x400).fill(3);
sizes[0x200 + 0x10] = 4; // custom 10, extra bit clear: 1 byte
sizes[0x300 + 0x10] = 6; // custom 10, extra bit set: 3 bytes
const sprites: LevelSprite[] = [
  { uid: newUid(), num: 0x0f, x: 3, y: 5, extra: 0 },
  { uid: newUid(), num: 0x10, x: 7, y: 9, extra: 2, bytes: [0xaa] },
  { uid: newUid(), num: 0x10, x: 20, y: 18, extra: 3, bytes: [1, 2] }, // one byte short: padded with 0
  { uid: newUid(), num: 0x10, x: 33, y: 4, extra: 0, bytes: [9] }, // vanilla entry: bytes dropped
];
const data = serializeSprites(sprites, 0x00, false, sizes);
check(data.length === 1 + 3 + 4 + 6 + 3 + 1, `entry sizes from the table (${data.length} bytes)`);
const back = parseSprites(data, 0, false, sizes);
check(back.size === data.length, 'parsed size = data length');
check(back.sprites.length === 4 && same(back.sprites[1].bytes ?? [], [0xaa]) && same(back.sprites[2].bytes ?? [], [1, 2, 0]) && !back.sprites[3].bytes,
  'extra bytes read back (padded, none for vanilla)');
check(same(serializeSprites(back.sprites, 0x00, false, sizes), data), 'roundtrip identical');
check(parseSprites(data, 0, false, null).sprites.length !== 4, 'without the table the data reads differently (sanity)');

// ---- size table in the ROM and level files
const tbl = rom.allocWrite(sizes);
rom.w24(SPR_SIZE_PTR, tbl); rom.w8(SPR_SIZE_PTR + 3, 0x42);
check(same(spriteSizes(rom) ?? [], sizes), 'size table found via $0EF30C/$42');
const lv = loadLevel(rom, 0x105);
lv.sprites.push(...sprites.slice(1, 3).map((s) => ({ ...s, uid: newUid() })));
const file = exportLevelFile(rom, lv);
check(JSON.parse(file).spriteSizes?.length === 0x800, 'level file carries the size table');
const plain = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const imp = importLevelFile(plain, file, loadLevel(plain, 0x105)).level;
const custom = imp.sprites.filter((s) => s.extra >= 2);
check(imp.sprites.length === lv.sprites.length && custom.length === 2 && same(custom[0].bytes ?? [], [0xaa]),
  'level file imported into a ROM without the table keeps sprites and bytes');

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
