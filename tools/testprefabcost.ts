// What a prefab costs and saves (prefabcost.ts): its one-time ROM cost, the cost per placement against the
// same tiles as Direct Map16 objects, and from which placement it pays off – measured against the real ROM
// write (writePrefab, the RATS free space) and level serialization (serializeObjects).
import { Rom } from '../src/core/rom.ts';
import { newUid, serializeObjects, type LevelObject } from '../src/core/level.ts';
import { installPrefabPatch, writePrefab, readPrefab, PREFAB_EXT, TRANSPARENT, type Prefab } from '../src/core/prefabs.ts';
import { prefabCost, prefabDm16Objects } from '../src/core/prefabcost.ts';
import { dm16Tiles } from '../src/core/cdm16.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const T = TRANSPARENT;
const block: Prefab = { w: 3, h: 3, tiles: [0x100, 0x101, 0x102, 0x103, 0x104, 0x105, 0x106, 0x107, 0x108], name: '' };
const platform: Prefab = { w: 8, h: 1, tiles: [0x145, ...Array(6).fill(0x146), 0x147], name: '' };
const long: Prefab = { w: 16, h: 1, tiles: Array(16).fill(0x130), name: '' };
const mixed: Prefab = {
  w: 20, h: 3, name: 'Mixed ä',
  tiles: Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? T : i < 40 ? 0x130 : 0x131 + (i % 3))),
  conds: Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 30 ? { flag: 5, always: i % 2 === 0 } : null)),
};

// the issue's examples
const cb = prefabCost(block), cp = prefabCost(platform), cl = prefabCost(long);
check(cb.breakEven === 1, `3×3 of 9 tiles pays off at the first placement (${cb.breakEven})`);
check(cp.breakEven === 3, `8-wide platform pays off from the third placement (${cp.breakEven})`);
check(cp.rects === 3 && cp.dm16 === 18, `platform: 3 Direct Map16 rectangles, 18 bytes (${cp.rects}, ${cp.dm16})`);
// a run of one tile is one Direct Map16 object, 6 bytes against 4: it pays off only after many placements
check(cl.rects === 1 && cl.once === 48 && cl.breakEven === 25, `a run of one tile pays off late (${cl.breakEven})`);
check(prefabCost({ w: 1, h: 1, tiles: [T], name: '' }).breakEven === null, 'nothing to place never pays off');
check(cb.perPlacement === 4, 'a placement is 4 bytes');
// break-even: the first placement count where the prefab (once + placements) is smaller than Direct Map16
for (const c of [cb, cp]) {
  const k = c.breakEven!;
  check(c.once + k * c.perPlacement < k * c.dm16 && c.once + (k - 1) * c.perPlacement >= (k - 1) * c.dm16, `break-even ${k} is the first that saves`);
}

// the Direct Map16 objects cover exactly the prefab's tiles (with their conditions), none overlapping
for (const s of [block, platform, long, mixed]) {
  const objs = prefabDm16Objects(s, 0x23, 7);
  const got = new Map<string, string>();
  let overlap = false;
  for (const o of objs) {
    check((o.size & 15) < 16 && o.size >> 4 < 16, 'rectangle within 16×16');
    for (const t of dm16Tiles(o)) {
      const k = `${(t & 0xffff) - 0x23},${(t >> 16) - 7}`;
      if (got.has(k)) overlap = true;
      got.set(k, `${o.tile} ${o.cond ? `${o.cond.flag}${o.cond.always}` : ''}`);
    }
  }
  const want = new Map<string, string>();
  s.tiles.forEach((t, i) => { const c = s.conds?.[i]; if (t !== T) want.set(`${i % s.w},${Math.floor(i / s.w)}`, `${t} ${c ? `${c.flag}${c.always}` : ''}`); });
  check(!overlap && got.size === want.size && [...want].every(([k, v]) => got.get(k) === v), `${s.w}×${s.h}: Direct Map16 objects place the prefab's tiles`);
}

// level serialization: the objects' bytes are the costs (without the end byte)
for (const s of [block, platform, long, mixed]) {
  const c = prefabCost(s);
  const dm = serializeObjects(prefabDm16Objects(s, 0x03, 7), [], false); // on screen 0: no screen jump before it
  check(dm.length - 1 === c.dm16, `${s.w}×${s.h}: Direct Map16 bytes ${c.dm16} = serialized ${dm.length - 1}`);
  const one: LevelObject = { uid: newUid(), num: 0, ext: PREFAB_EXT, x: 0x03, y: 7, size: 0, prefab: 9 };
  check(serializeObjects([one], [], false).length - 1 === c.perPlacement, 'placement bytes = serialized');
}

// the ROM write: the space writePrefab takes out of the free space is the one-time cost (the free run a large
// block would take starts that much later)
const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const BIG = 0x2000;
// the small gaps of free space filled first, so that every block goes where a large one would
while (rom.findFree(1) !== rom.findFree(BIG)) rom.allocWrite(new Uint8Array(1));
for (const s of [block, platform, long, mixed, { ...block, name: 'A name of some length' }]) {
  const c = prefabCost(s);
  const before = rom.findFree(BIG);
  writePrefab(rom, 3, s);
  check(rom.findFree(BIG) - before === c.once, `${s.w}×${s.h} "${s.name}": one-time ${c.once} = space taken ${rom.findFree(BIG) - before}`);
  check(JSON.stringify(readPrefab(rom, 3)?.tiles) === JSON.stringify(s.tiles), 'read back');
  writePrefab(rom, 3, null);
}

console.log(fail ? `${fail} failures` : 'prefab cost ok');
if (fail) process.exitCode = 1;
