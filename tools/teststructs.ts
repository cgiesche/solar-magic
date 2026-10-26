// Structures (structs.ts): patch install leaves every level unchanged, structures place their tiles
// (transparent cells keep the tile below, also across screen borders and in vertical levels),
// objects after a structure are unaffected, and level data / level files round-trip.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelRender } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, newUid, isL1Vertical, type LevelObject } from '../src/core/level.ts';
import { installStructPatch, writeStructure, readStructure, listStructures, STRUCT_EXT, STRUCT_SLOT, EXT_OBJ_TABLE, TRANSPARENT, structPatch } from '../src/core/structs.ts';
import { saveLevel } from '../src/core/save.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch, type PatchSource } from '../src/core/patchapply.ts';
import { editorImage, cleanImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

const orig = new Rom(cleanImage());
const rom = new Rom(EDITOR_IMAGE.slice());
let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

installStructPatch(rom);
check(!!structPatch(rom), 'patch detected');
// the number (#117, tools/extobjprobe.ts): its slot is empty in the clean game, and Lunar Magic's extended objects
// stay theirs: $02 (5 bytes) free, $03 its swapped screen jump (3 bytes, the level height patch's)
check(orig.r24(STRUCT_SLOT) === 0, 'the structures\' slot is empty in the clean game');
check(rom.r24(EXT_OBJ_TABLE + 0x02 * 3) === 0, 'extended object $02 left to Lunar Magic (Direct Map16 elsewhere)');
check(rom.r24(EXT_OBJ_TABLE + 0x03 * 3) !== rom.r24(STRUCT_SLOT), `extended object $03 left to Lunar Magic's swapped screen jump (structures: $${STRUCT_EXT.toString(16)})`);
const e0 = new LevelEmulator(orig); e0.boot();
const e1 = new LevelEmulator(rom); e1.boot();
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
let bad = 0;
for (const n of levels) {
  const a = e0.load(n), b = e1.load(n);
  let d = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + 0x10000] !== b.wram[i + 0x10000]) d++;
  if (d || !b.ok) { bad++; console.log('level', n.toString(16), 'map differs', d, b.error ?? ''); }
}
check(bad === 0, 'levels unchanged by the patch');

const T = TRANSPARENT;
writeStructure(rom, 5, { w: 3, h: 2, tiles: [0x130, T, 0x132, 0x025, 0x1ff, 0x0af], name: 'Test ä' });
writeStructure(rom, 7, { w: 2, h: 2, tiles: [0x145, 0x146, 0x147, 0x148], name: '' });
const s5 = readStructure(rom, 5);
check(s5?.name === 'Test ä' && s5.w === 3 && s5.tiles[1] === T && s5.tiles[4] === 0x1ff, 'read back');
check(listStructures(rom).size === 2, 'list');

function tileAt(r: LevelRender, rom: Rom, mode: number, x: number, y: number): number {
  const a = isL1Vertical(rom, mode) ? 0xc800 + (y >> 4) * 0x200 + (x >> 4) * 0x100 + (y & 15) * 16 + (x & 15) : 0xc800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15);
  return r.wram[a] | (r.wram[a + 0x10000] << 8);
}

// places `objs` first in the level; the structure's cells get its tiles, all else stays as without it
function place(n: number, objs: LevelObject[], expect: Map<string, number>): void {
  const lv = loadLevel(rom, n);
  const base = e1.load(n, { layer1: serializeLayer1(rom, lv) });
  const before = new Map<string, number>();
  for (const k of expect.keys()) { const [x, y] = k.split(',').map(Number); before.set(k, tileAt(base, rom, lv.header.mode, x, y)); }
  const baseMap = base.wram.slice();
  lv.objects.unshift(...objs);
  const r = e1.load(n, { layer1: serializeLayer1(rom, lv) });
  check(r.ok, `level ${n.toString(16)} loads`);
  // objects that come later may overwrite the structure: compare against a load with the structure last
  const last = loadLevel(rom, n);
  last.objects.push(...objs);
  const rl = e1.load(n, { layer1: serializeLayer1(rom, last) });
  for (const [k, t] of expect) {
    const [x, y] = k.split(',').map(Number);
    const got = tileAt(rl, rom, lv.header.mode, x, y);
    const want = t < 0 ? before.get(k)! : t;
    check(got === want, `level ${n.toString(16)} tile ${k}: ${got.toString(16)} want ${want.toString(16)}`);
  }
  // everything outside the structure unchanged when placed first
  const vert = isL1Vertical(rom, lv.header.mode);
  const cells = new Set<number>();
  for (const k of expect.keys()) {
    const [x, y] = k.split(',').map(Number);
    cells.add(vert ? 0xc800 + (y >> 4) * 0x200 + (x >> 4) * 0x100 + (y & 15) * 16 + (x & 15) : 0xc800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15));
  }
  let d = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (!cells.has(i) && (r.wram[i] !== baseMap[i] || r.wram[i + 0x10000] !== baseMap[i + 0x10000])) d++;
  check(d === 0, `level ${n.toString(16)}: ${d} tiles outside the structure changed`);
}
const obj = (x: number, y: number, struct: number): LevelObject => ({ uid: newUid(), num: 0, ext: STRUCT_EXT, x, y, size: 0, struct });
const exp = (x: number, y: number, s: { w: number; tiles: number[] }) => new Map(s.tiles.map((t, i) => [`${x + (i % s.w)},${y + Math.floor(i / s.w)}`, t]));

// horizontal level, across a screen border
place(0x105, [obj(0x1f, 10, 5)], exp(0x1f, 10, s5!));
// horizontal level, across the bottom of a subscreen row? (y 0x19..0x1a, last rows)
place(0x105, [obj(0x40, 0x19, 7)], exp(0x40, 0x19, readStructure(rom, 7)!));
// vertical level, across both borders
const vl = levels.find((n) => isL1Vertical(rom, loadLevel(rom, n).header.mode))!;
place(vl, [obj(0x0f, 0x1f, 5)], exp(0x0f, 0x1f, s5!));
// unknown structure number places nothing
place(0x105, [obj(0x30, 5, 99)], new Map());

// save/load round trip
const lv = loadLevel(rom, 0x105);
lv.objects.push(obj(0x22, 8, 5), obj(0x50, 3, 7));
saveLevel(rom, lv);
const back = loadLevel(rom, 0x105);
const ss = back.objects.filter((o) => o.ext === STRUCT_EXT && o.num === 0);
check(ss.length === 2 && ss[0].struct === 5 && ss[1].struct === 7 && ss[1].x === 0x50, 'save/load');
// in the level data: 00 object bytes, the number, the structure (y 3, x 0 on screen 5: 03 00 04 07)
const l1 = Array.from(serializeLayer1(rom, back), (b) => b.toString(16).padStart(2, '0')).join(' ');
check(l1.includes('03 00 04 07'), 'level data: extended object $04, then the structure number');

// level file into another ROM: structures come along
const text = exportLevelFile(rom, back);
const other = new Rom(EDITOR_IMAGE.slice());
writeStructure(other, 0, { w: 1, h: 1, tiles: [0x130], name: 'x' });
const into = loadLevel(other, 0x106);
const imp = importLevelFile(other, text, into);
const is = imp.level.objects.filter((o) => o.ext === STRUCT_EXT && o.num === 0);
const st = is.map((o) => readStructure(other, o.struct!));
check(is.length === 2 && st[0]?.name === 'Test ä' && st[1]?.tiles[3] === 0x148 && is[0].struct !== 0, 'level file import');

// removing a structure: the object stays, places nothing
writeStructure(rom, 7, null);
check(readStructure(rom, 7) === null, 'remove');

// other patches: the structures' slot is protected, and a patch that took it first blocks the install
await loadAsar();
const src = (name: string, main: string): PatchSource => ({ name, main: 'main.asm', files: new Map([['main.asm', main]]) });
const takeSlot = src('ExtObj04', `lorom\norg $${STRUCT_SLOT.toString(16)}\ndl $0DA57B\n`);
const hit = applyPatch(rom, takeSlot);
check(!hit.ok && hit.errors[0].includes('SMWS'), 'patch writing the slot rejected: ' + hit.errors[0]);
const clean = new Rom(cleanImage());
check(applyPatch(clean, takeSlot).ok, 'slot free for other patches without structures');
let msg = '';
try { installStructPatch(clean); } catch (e) { msg = (e as Error).message; }
check(msg.includes('ExtObj04') && !structPatch(clean), 'install refused when the slot is taken: ' + msg);

console.log(fail ? `${fail} failures` : 'structures ok');
if (fail) process.exitCode = 1;
