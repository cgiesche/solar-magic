// Custom overworld sprites in Lunar Magic's table (owcustom.ts), on the model: the clean game has none; lists written
// are Lunar Magic's bytes (its help's `spr` macro, offsets per submap, `dw 0` ends), read back the same; the size
// table gives each sprite its entry's size (extra bytes cut or padded); a rewrite frees the old table; without sprites
// the pointer is 0; Lunar Magic's limits are kept.
import { Rom, snesToPc } from '../src/core/rom.ts';
import {
  readCustomSprites, writeCustomSprites, customTable, customTableBytes, customSizeTable, customSpritesProblem, customSpriteRanges,
  OW_CUSTOM_PTR, OW_CUSTOM_SIZES, OW_CUSTOM_MAX, type CustomOwSprite,
} from '../src/core/owcustom.ts';
import { overworldDataRanges } from '../src/core/overworld.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (b: ArrayLike<number>) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');
const rom = new Rom(await editorImage());
const none = (): CustomOwSprite[][] => Array.from({ length: 7 }, () => []);

check(customTable(rom) === null && readCustomSprites(rom).every((l) => !l.length), 'the clean game: no table, 7 empty lists');

// Lunar Magic's macro: db id|((x&1)<<7) : db (x>>1)|((y&7)<<5) : db (y>>3)|(z<<3) : db extra
const spr = (id: number, x: number, y: number, z: number, extra: number) => [id | ((x & 1) << 7), (x >> 1) | ((y & 7) << 5), (y >> 3) | (z << 3), extra];
{
  const lists = none();
  lists[1] = [{ id: 0x12, x: 0x0b, y: 0x2d, z: 3, extra: [0xa5] }];
  lists[4] = [{ id: 0x01, x: 0, y: 0, z: 0, extra: [0] }, { id: 0x7f, x: 0x3f, y: 0x3f, z: 0x1f, extra: [0xff] }];
  const b = customTableBytes(lists, null);
  const want = [0x0e, 0, 0x10, 0, 0x16, 0, 0x18, 0, 0x1a, 0, 0x24, 0, 0x26, 0, 0, 0, ...spr(0x12, 0x0b, 0x2d, 3, 0xa5), 0, 0, 0, 0, 0, 0, ...spr(1, 0, 0, 0, 0), ...spr(0x7f, 0x3f, 0x3f, 0x1f, 0xff), 0, 0, 0, 0, 0, 0];
  check(hx(b) === hx(want), `Lunar Magic's bytes: ${hx(b)}`);
  const r = new Rom(rom.data.slice());
  writeCustomSprites(r, lists);
  const t = customTable(r)!;
  check(t !== null && r.isRatsAt(snesToPc(t) - 8) >= b.length && hx(r.bytes(t, b.length)) === hx(b), `written in a RATS block at ${t.toString(16)}`);
  check(JSON.stringify(readCustomSprites(r)) === JSON.stringify(lists), 'read back the same');
  const ranges = customSpriteRanges(r), od = overworldDataRanges(r);
  check(ranges.length === 2 && ranges[1][1] - ranges[1][0] === b.length && ranges.every(([s, e]) => od.some(([a, z]) => a <= s && z >= e)), 'the pointer and the table are overworld data');
  // a rewrite frees the old table
  const before = r.scanRats().length;
  lists[4].pop();
  writeCustomSprites(r, lists);
  check(r.scanRats().length === before && readCustomSprites(r)[4].length === 1, 'rewritten: the old table freed, one RATS block still');
  writeCustomSprites(r, none());
  check(r.r24(OW_CUSTOM_PTR) === 0xffffff && r.scanRats().length === before - 1 && readCustomSprites(r).every((l) => !l.length), 'without sprites: pointer $FFFFFF (the clean game\'s), the table freed');
}

// the size table: sprite 1 first; entries of its sizes, extra bytes cut or padded
{
  const r = new Rom(rom.data.slice());
  const sizes = new Uint8Array(0x7f).fill(3);
  sizes[0x12 - 1] = 6;
  const lists = none();
  lists[0] = [{ id: 0x12, x: 1, y: 2, z: 0, extra: [1, 2] }, { id: 0x05, x: 3, y: 4, z: 0, extra: [9] }];
  const at = r.allocWrite(sizes);
  r.w24(OW_CUSTOM_SIZES, at);
  check(customSizeTable(r) === null, 'the size table without $42: not used');
  r.w8(OW_CUSTOM_SIZES + 3, 0x42);
  check(customSizeTable(r)?.[0x11] === 6, 'with $42: used, sprite 1 first');
  writeCustomSprites(r, lists);
  const back = readCustomSprites(r);
  check(JSON.stringify(back[0]) === JSON.stringify([{ ...lists[0][0], extra: [1, 2, 0] }, { ...lists[0][1], extra: [] }]), `entries of 6 and 3 bytes: ${JSON.stringify(back[0])}`);
}

// Lunar Magic's limits
{
  const lists = none();
  lists[2] = Array.from({ length: OW_CUSTOM_MAX + 1 }, () => ({ id: 1, x: 0, y: 0, z: 0, extra: [] }));
  check(!!customSpritesProblem(lists), `more than 0x18 a submap: ${customSpritesProblem(lists)}`);
  lists[2] = [{ id: 0, x: 0, y: 0, z: 0, extra: [] }];
  check(!!customSpritesProblem(lists), `sprite 00: ${customSpritesProblem(lists)}`);
  lists[2] = [{ id: 1, x: 0x40, y: 0, z: 0, extra: [] }];
  check(!!customSpritesProblem(lists), `X 40: ${customSpritesProblem(lists)}`);
  lists[2] = [{ id: 1, x: 0, y: 0, z: 0x20, extra: [] }];
  check(!!customSpritesProblem(lists), `height 20: ${customSpritesProblem(lists)}`);
  let threw = false;
  try { writeCustomSprites(new Rom(rom.data.slice()), lists); } catch { threw = true; }
  check(threw, 'writing them refused');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
