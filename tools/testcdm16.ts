// Conditional Direct Map16 (Lunar Magic's, cdm16.ts): a Direct Map16 object or a structure's tile with a flag
// of the table at $7FC060-F is drawn only while the flag is on, with "always show" always, with its tiles +
// 0x100 while it is on – by the game's own level load with the flags set before it. Objects without a flag
// keep their bytes; level data, level files and Lunar Magic's level files keep the condition; the flags the
// level uses are counted; test play (loadInGame) sees the flags; code that sets the flags is no RAM conflict.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelRender } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, parseObjects, serializeObjects, newUid, isL1Vertical, levelTranslevel, type LevelObject } from '../src/core/level.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { writeStructure, readStructure, STRUCT_EXT, TRANSPARENT } from '../src/core/structs.ts';
import { flagBytes, usedFlags, structTiles } from '../src/core/cdm16.ts';
import { levelTilesAll, levelOverride } from '../src/core/levelusage.ts';
import { parseLmObjects } from '../src/core/mwl.ts';
import { saveLevel } from '../src/core/save.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { editorImage } from './fixture.ts';

const rom = new Rom(await editorImage());
let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };
const emu = new LevelEmulator(rom); emu.boot();

// the flag table
const fb = flagBytes([0, 9, 0x7f]);
check(fb.length === 16 && fb[0] === 1 && fb[1] === 2 && fb[15] === 0x80 && fb.reduce((a, b) => a + b) === 0x83, 'flag bytes: bits low to high');

function tileAt(r: LevelRender, mode: number, x: number, y: number): number {
  const a = isL1Vertical(rom, mode) ? 0xc800 + (y >> 4) * 0x200 + (x >> 4) * 0x100 + (y & 15) * 16 + (x & 15) : 0xc800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15);
  return r.wram[a] | (r.wram[a + 0x10000] << 8);
}
const dm16 = (x: number, y: number, tile: number, size: number, cond?: LevelObject['cond']): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size, tile, ...(cond ? { cond } : {}) });

// byte layout: without a condition as before (6 bytes), with one the tile's high byte bit 7 and the condition byte
{
  const plain = serializeObjects([dm16(3, 4, 0x2a5, 0x12)], [], false);
  check(plain.length === 7 && plain[3] === 0xa5 && plain[4] === 0x02 && plain[5] === 0x12, 'plain Direct Map16 bytes unchanged');
  const c = serializeObjects([dm16(3, 4, 0x2a5, 0x12, { flag: 0x45, always: true })], [], false);
  check(c.length === 8 && c[4] === 0x82 && c[5] === 0x12 && c[6] === 0xc5, 'conditional bytes: ' + [...c].map((b) => b.toString(16)).join(' '));
  const back = parseObjects(c, 0, false).objects[0];
  check(back.tile === 0x2a5 && back.size === 0x12 && back.cond?.flag === 0x45 && back.cond.always, 'conditional parsed back');
  check(parseObjects(plain, 0, false).objects[0].cond === undefined, 'plain parsed without a condition');
}

// a level with `objs` after its own objects, loaded with the flags on
function load(n: number, objs: LevelObject[], flags: number[]): { r: LevelRender; mode: number } {
  const lv = loadLevel(rom, n);
  lv.objects.push(...objs);
  const r = emu.load(n, { layer1: serializeLayer1(rom, lv), cdm16Flags: flagBytes(flags) });
  check(r.ok, `level ${n.toString(16)} loads ${r.error ?? ''}`);
  return { r, mode: lv.header.mode };
}
// every tile of an object's w×h rectangle at (x, y)
function rect(n: number, objs: LevelObject[], flags: number[], x: number, y: number, w: number, h: number, want: (base: number) => number, what: string): void {
  const base = load(n, [], flags), got = load(n, objs, flags);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const b = tileAt(base.r, base.mode, x + i, y + j), t = tileAt(got.r, got.mode, x + i, y + j);
    if (t !== want(b)) { check(false, `${what}: level ${n.toString(16)} tile ${(x + i).toString(16)},${(y + j).toString(16)} is ${t.toString(16)}, want ${want(b).toString(16)}`); return; }
  }
}
// horizontal level across a screen border, then a vertical level
const vl = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)].find((n) => isL1Vertical(rom, loadLevel(rom, n).header.mode))!;
for (const [n, x, y] of [[0x105, 0x1e, 9], [vl, 0x0e, 0x1e]]) {
  const o = (cond?: LevelObject['cond']) => [dm16(x, y, 0x130, 0x23, cond)];
  rect(n, o(), [], x, y, 4, 3, () => 0x130, 'plain');
  rect(n, o({ flag: 0x0b, always: false }), [], x, y, 4, 3, (b) => b, 'flag off: not drawn');
  rect(n, o({ flag: 0x0b, always: false }), [0x0a, 0x0c], x, y, 4, 3, (b) => b, 'other flags on: not drawn');
  rect(n, o({ flag: 0x0b, always: false }), [0x0b], x, y, 4, 3, () => 0x130, 'flag on: drawn');
  rect(n, o({ flag: 0x7f, always: true }), [], x, y, 4, 3, () => 0x130, 'always show, flag off: the tile');
  rect(n, o({ flag: 0x7f, always: true }), [0x7f], x, y, 4, 3, () => 0x230, 'always show, flag on: tile + 100');
}
// an object after a hidden one is placed as usual
rect(0x105, [dm16(0x40, 8, 0x130, 0x11, { flag: 3, always: false }), dm16(0x42, 8, 0x131, 0)], [], 0x42, 8, 1, 1, () => 0x131, 'object after a hidden one');

// structures: a conditional tile hides (keeps the tile below) or shows like an object
writeStructure(rom, 9, { w: 3, h: 1, tiles: [0x130, 0x131, TRANSPARENT], conds: [null, { flag: 0x21, always: false }, null], name: 'cond' });
writeStructure(rom, 10, { w: 2, h: 1, tiles: [0x140, 0x141], conds: [{ flag: 0x22, always: true }, null], name: 'always' });
const s9 = readStructure(rom, 9)!;
check(s9.tiles[1] === 0x131 && s9.conds?.[1]?.flag === 0x21 && !s9.conds[0] && !s9.conds[2], 'structure condition read back');
check(readStructure(rom, 10)!.conds?.[0]?.always === true, 'structure always show read back');
const so = (x: number, y: number, s: number): LevelObject => ({ uid: newUid(), num: 0, ext: STRUCT_EXT, x, y, size: 0, struct: s });
{
  const base = load(0x105, [], []);
  const off = load(0x105, [so(0x1f, 9, 9)], []), on = load(0x105, [so(0x1f, 9, 9)], [0x21]);
  const t = (r: typeof off, x: number) => tileAt(r.r, r.mode, x, 9);
  check(t(off, 0x1f) === 0x130 && t(off, 0x20) === t(base, 0x20) && t(off, 0x21) === t(base, 0x21), 'structure: conditional tile hidden while off');
  check(t(on, 0x1f) === 0x130 && t(on, 0x20) === 0x131 && t(on, 0x21) === t(base, 0x21), 'structure: conditional tile shown while on');
  const a0 = load(0x105, [so(0x30, 9, 10)], []), a1 = load(0x105, [so(0x30, 9, 10)], [0x22]);
  check(t(a0, 0x30) === 0x140 && t(a1, 0x30) === 0x240 && t(a1, 0x31) === 0x141, 'structure: always show adds 100 while on');
}

// the flags a level uses (objects of both layers, structures by their objects)
{
  const lv = loadLevel(rom, 0x105);
  lv.objects.push(dm16(1, 1, 0x130, 0, { flag: 5, always: false }), dm16(2, 1, 0x130, 0, { flag: 5, always: true }), dm16(3, 1, 0x130, 0, { flag: 7, always: false }), so(4, 1, 9), so(8, 1, 9));
  const u = usedFlags(rom, lv);
  check(u.size === 3 && u.get(5) === 2 && u.get(7) === 1 && u.get(0x21) === 2, 'used flags: ' + JSON.stringify([...u]));
}

// tile usage: a level's tiles in both states of its conditional objects (hidden tiles, always show + 100)
{
  const lv = loadLevel(rom, 0x105);
  lv.objects.push(dm16(0x40, 8, 0x3c1, 0, { flag: 1, always: false }), dm16(0x42, 8, 0x3c2, 0, { flag: 2, always: true }));
  const u = levelTilesAll(rom, lv, (ov) => emu.load(0x105, ov), levelOverride(rom, lv));
  const has = (t: number) => u.fg.some((x) => x.tile === t && x.source === 'direct');
  check(u.ok && has(0x3c1) && has(0x3c2) && has(0x4c2), 'usage: hidden and both always-show tiles counted');
  check(structTiles(readStructure(rom, 10)!).join() === [0x140, 0x240, 0x141].join(), 'structure tiles with always show');
}

// save, level file
{
  const lv = loadLevel(rom, 0x105);
  lv.objects.push(dm16(0x22, 8, 0x150, 0x01, { flag: 0x33, always: true }), so(0x50, 3, 9));
  saveLevel(rom, lv);
  const back = loadLevel(rom, 0x105).objects.find((o) => o.ext === DM16_EXT && o.num === 0 && o.x === 0x22);
  check(back?.cond?.flag === 0x33 && back.cond.always && back.tile === 0x150, 'save/load keeps the condition');
  const text = exportLevelFile(rom, loadLevel(rom, 0x105));
  const other = new Rom(await editorImage());
  const imp = importLevelFile(other, text, loadLevel(other, 0x106));
  const d = imp.level.objects.find((o) => o.ext === DM16_EXT && o.num === 0 && o.x === 0x22);
  const st = imp.level.objects.find((o) => o.ext === STRUCT_EXT && o.num === 0 && o.x === 0x50);
  check(d?.cond?.flag === 0x33 && readStructure(other, st!.struct!)?.conds?.[1]?.flag === 0x21, 'level file keeps the conditions');
}

// Lunar Magic's conditional form of object 27 (N10YYYYY 0111XXXX 1WWWWWWW 11BBBBBB bbbbbbbb hhhhwwww HHHHHHHH ACCCCCCC)
{
  const data = Uint8Array.from([0x45, 0x73, 0x81, 0xc1, 0x30, 0x00, 0x00, 0x85, 0x45, 0x74, 0x00, 0xc2, 0x00, 0x00, 0x00, 0xff]);
  const notes: string[] = [];
  const objs = parseLmObjects(data, 0, false, notes).objects;
  check(objs.length === 3 && objs.every((o) => o.ext === DM16_EXT && o.num === 0), 'mwl: conditional objects parsed: ' + objs.length);
  check(objs[0].tile === 0x130 && objs[1].tile === 0x130 && objs[0].x === 3 && objs[1].x === 4 && objs[0].y === 5, 'mwl: tiles and positions');
  check(objs[0].cond?.flag === 5 && objs[0].cond.always && objs[1].cond?.flag === 5, 'mwl: condition 85');
  check(objs[2].tile === 0x200 && objs[2].x === 4 && objs[2].y === 5 && objs[2].cond === undefined, 'mwl: unconditional multi-screen form after it (7 bytes)');
}

// test play: the game in progress loads the level with the flags
{
  const lv = loadLevel(rom, 0x105);
  lv.objects.push(dm16(0x40, 9, 0x130, 0, { flag: 0x10, always: false }));
  const ov = { layer1: serializeLayer1(rom, lv), cdm16Flags: flagBytes([0x10]) };
  const tl = levelTranslevel(rom, 0x105);
  emu.startGame(tl);
  const r = emu.loadInGame(0x105, tl, ov);
  check(r.ok && tileAt(r, lv.header.mode, 0x40, 9) === 0x130, 'test play: flag on, conditional tile shown');
}

// community code that sets the flags (as UberASM does, long addressing) is no RAM conflict
await loadAsar();
const res = applyPatch(rom, { name: 'SetFlags', main: 'main.asm', files: new Map([['main.asm', 'lorom\nfreecode\nSetFlags:\nLDA #$01\nSTA $7FC060\nRTL\n']]) });
check(res.ok && !res.warnings.some((w) => w.includes('7FC06')), 'setting the flags is no conflict: ' + [...res.errors, ...res.warnings].join(' / '));

console.log(fail ? `${fail} failures` : 'conditional Direct Map16 ok');
if (fail) process.exitCode = 1;
