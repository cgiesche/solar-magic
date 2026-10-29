// Resizing objects from any edge (objresize.ts): the tiles an object covers at each size are emulated alone,
// which part of the settings byte sizes which axis follows from them (a slope's one nibble both), and a
// drag aims at a tile: the size whose dragged edge lands nearest, the opposite edges staying where they are.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { ObjKindProbe } from '../src/core/objkinds.ts';
import { SizeProbe, sizeParts, partSizes, drivers, aimResize, keepEdges, type Grab } from '../src/core/objresize.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const lv = loadLevel(rom, 0x105), l2 = rom.r24(L2_PTRS + 0x105 * 3);
const { kinds } = new ObjKindProbe(emu, lv, l2).result();
const probe = new SizeProbe(emu, lv, l2);
const box = (num: number) => (size: number) => probe.box({ num, ext: 0, size });
const setup = (num: number, size: number) => {
  probe.probe(sizeParts(kinds.get(num)).flatMap((p) => partSizes(size, p).map((s) => ({ num, ext: 0, size: s }))));
  return drivers(kinds.get(num), size, box(num));
};
const aim = (num: number, o: { x: number; y: number; size: number }, grab: Grab, tx: number, ty: number) =>
  aimResize(o, setup(num, o.size), box(num), grab, tx, ty, 512, 27);

// coins (05): low nibble width, high nibble height, growing right and down from the origin
{
  const d = setup(0x05, 0x22);
  check(d.x === 'lo' && d.y === 'hi', `coins: width low, height high nibble (${d.x}/${d.y})`);
  const o = { x: 20, y: 10, size: 0x22 }; // 3×3 at 20..22, 10..12
  const r = aim(0x05, o, { hx: 1, hy: 0 }, 26, 0);
  check(r?.size === 0x26 && r.x === 20 && r.y === 10, `right edge to x 26: size 26 at 20 (${r?.size.toString(16)} at ${r?.x})`);
  const l = aim(0x05, o, { hx: -1, hy: 0 }, 17, 0);
  check(l?.size === 0x25 && l.x === 17 && l.box.x1 === 22, `left edge to x 17: size 25 at 17, the right edge stays at 22 (${l?.size.toString(16)} at ${l?.x}, ${l?.box.x1})`);
  const t = aim(0x05, o, { hx: -1, hy: -1 }, 21, 11);
  check(t?.size === 0x11 && t.x === 21 && t.y === 11 && t.box.x1 === 22 && t.box.y1 === 12, `top left corner to 21,11: size 11 at 21,11 (${t?.size.toString(16)} at ${t?.x},${t?.y})`);
  const same = aim(0x05, o, { hx: 1, hy: 1 }, 22, 12);
  check(same?.size === 0x22 && same.x === 20 && same.y === 10, 'the corner where it was: unchanged');
  const far = aim(0x05, o, { hx: -1, hy: 0 }, 2, 0);
  check(far?.size === 0x2f && far.x === 7, `left edge far out: stops at width 16 (${far?.size.toString(16)} at ${far?.x})`);
  const edge = aim(0x05, { x: 1, y: 10, size: 0x22 }, { hx: -1, hy: 0 }, -5, 0);
  check(edge?.x === 0 && edge.size === 0x23, `left edge at the level's edge: the origin stays inside (${edge?.size.toString(16)} at ${edge?.x})`);
  const k = keepEdges(o, 0x24, box(0x05), true, 512, 27);
  check(k?.x === 18 && k.y === 10, `a step from the right: the right and bottom edges stay (${k?.x},${k?.y})`);
}

// a slope (39 in tileset 0: one nibble makes it wider and taller, growing to the left): both axes from it
{
  const d = setup(0x39, 0x22);
  check(d.x === 'hi' && d.y === 'hi', `slope: one nibble for both axes (${d.x}/${d.y})`);
  const o = { x: 40, y: 5, size: 0x22 }, b0 = box(0x39)(0x22)!;
  const r = aim(0x39, o, { hx: 0, hy: 1 }, 0, o.y + b0.y1 + 2);
  const b = r && box(0x39)(r.size);
  check(r?.size === 0x42 && !!b && r.box.y1 === o.y + b0.y1 + 2 && r.box.y0 === o.y + b0.y0, `bottom edge 2 down: 2 steps, its top stays (${r?.size.toString(16)})`);
  const rx = aim(0x39, o, { hx: -1, hy: 0 }, o.x + b0.x0 - 3, 0);
  check(rx?.box.x1 === o.x + b0.x1 && rx.box.x0 === o.x + b0.x0 - 3, `left edge 3 out: its right edge stays (${rx?.size.toString(16)} at ${rx?.x})`);
}

// width-only and byte-wide objects: no handles for the height
{
  const d = setup(0x1c, 0x02);
  check(d.x === 'lo' && d.y === null, `1C: width only (${d.x}/${d.y})`);
  const w = setup(0x21, 0x02);
  check(w.x === 'byte' && w.y === null, `21: the whole byte is the width (${w.x}/${w.y})`);
  const wide = box(0x21)(0xc8);
  check(!!wide && wide.x1 - wide.x0 === 0xc8, `… wide ones probed in full (width ${wide && wide.x1 - wide.x0 + 1})`);
  const r = aim(0x21, { x: 10, y: 10, size: 0x02 }, { hx: 1, hy: 0 }, 110, 0);
  check(r?.size === 100, `… right edge 100 tiles out: size 100 (${r?.size})`);
}

console.log(bad ? `${bad} failed` : 'all ok');
if (bad) process.exitCode = 1;
