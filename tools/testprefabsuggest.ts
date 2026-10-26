// Prefab suggestions (prefabsuggest.ts, #116): connected groups of Direct Map16 objects that occur more than
// once across the levels (however split into rectangles), with their places, levels and the bytes a prefab
// would save (the level data of the places against one prefab object each, the prefab's ROM cost taken off);
// only positive savings, the largest first. Computed in steps (a generator), so it runs in the background;
// gone once the places are replaced by the prefab.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, type LevelObject } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { usedLevels } from '../src/core/levelusage.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { installPrefabPatch, writePrefab } from '../src/core/prefabs.ts';
import { prefabCost } from '../src/core/prefabcost.ts';
import { applyPrefabPlaces } from '../src/core/prefabplaces.ts';
import { dm16Groups, prefabSuggestions, suggestPrefabs } from '../src/core/prefabsuggest.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const dm = (x: number, y: number, tile: number, w = 1, h = 1): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: ((h - 1) << 4) | (w - 1), tile });
// a 3×3 block of 9 different tiles as 9 objects: pays off at once
const block = (x: number, y: number) => Array.from({ length: 9 }, (_, i) => dm(x + (i % 3), y + Math.floor(i / 3), 0x100 + i));
// the same block split otherwise: the top row's tiles first
const blockSplit = (x: number, y: number) => [...block(x, y).slice(3), ...block(x, y).slice(0, 3)];
// an 8-wide platform (end, 6× middle, end): 3 objects, pays off only from the third placement
const platform = (x: number, y: number) => [dm(x, y, 0x140), dm(x + 1, y, 0x141, 6), dm(x + 7, y, 0x142)];
// a diagonal staircase of two tiles touching at a corner: one group
const stairs = (x: number, y: number) => [dm(x, y + 1, 0x150), dm(x + 1, y, 0x151)];

// ---- groups: objects touching (also at a corner) or overlapping, per layer ----
{
  const lv = { objects: [...block(0x10, 5), dm(0x20, 5, 0x160), ...stairs(0x30, 5), dm(0x13, 5, 0x170), { uid: newUid(), num: 5, ext: 0, x: 0x14, y: 5, size: 0 }], layer2Objects: null };
  const gs = dm16Groups(lv as never);
  const sizes = gs.map((g) => g.objects.length).sort((a, b) => a - b);
  // the block with the tile at its right (10 objects), the single tile, the stairs; the coin is no part
  check(JSON.stringify(sizes) === JSON.stringify([1, 2, 10]), `groups ${JSON.stringify(sizes)}`);
  check(gs.every((g) => g.layer === 1), 'layer 1');
}

const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const emu = new LevelEmulator(rom);
emu.boot();
const load = (n: number, ov = {}) => emu.load(n, ov);

const H1 = 0x105, H2 = 0x106;
check(suggestPrefabs(rom, { levels: usedLevels(rom), load }).length === 0, 'the clean game: no suggestions');
{
  const lv = loadLevel(rom, H1);
  lv.objects.push(...block(0x20, 5), ...block(0x30, 8), ...platform(0x40, 10), ...stairs(0x50, 4), ...stairs(0x58, 4), dm(0x60, 4, 0x180, 2, 2));
  saveLevel(rom, lv);
}
{
  const lv = loadLevel(rom, H2);
  lv.objects.push(...blockSplit(0x24, 6), ...platform(0x40, 10));
  saveLevel(rom, lv);
}

const steps = prefabSuggestions(rom, { levels: usedLevels(rom), load });
let yields = 0, r = steps.next();
while (!r.done) { yields++; r = steps.next(); }
const list = r.value;
check(yields > 1, `computed in steps (${yields})`);
const blk = list.find((s) => s.prefab.w === 3 && s.prefab.h === 3);
check(!!blk && blk.count === 3, `the block: 3 places (${blk?.count})`);
check(!!blk && JSON.stringify(blk.levels) === JSON.stringify([H1, H2]), `the block: levels ${blk?.levels}`);
check(!!blk && blk.saved === 3 * (9 * 6 - 4) - prefabCost(blk.prefab).once, `the block saves ${blk?.saved}`);
// the platform twice does not pay off (only from the third placement); the stairs neither; a tile once is none
check(!list.some((s) => s.prefab.w === 8), 'the platform twice: not listed');
check(!list.some((s) => s.prefab.w === 2 && s.prefab.h === 2), 'stairs and a single object: not listed');
check(list.every((s) => s.saved > 0 && s.count > 1), 'only positive savings of repeated arrangements');
{
  // the platform a third time in another level: listed, after the block (sorted by the saving)
  const lv = loadLevel(rom, 0x107);
  lv.objects.push(...platform(0x20, 10));
  saveLevel(rom, lv);
  const l2 = suggestPrefabs(rom, { levels: usedLevels(rom), load });
  const pl = l2.find((s) => s.prefab.w === 8);
  check(!!pl && pl.count === 3 && pl.saved === 3 * (18 - 4) - prefabCost(pl.prefab).once, `the platform thrice: listed (${pl?.saved})`);
  check(l2.length === 2 && l2[0].prefab.w === 3 && l2[1] === pl, 'sorted by the saving');
}

// the open level as edited is taken instead of its saved data
{
  const open = loadLevel(rom, H2);
  open.objects = open.objects.filter((o) => o.ext !== DM16_EXT || o.tile! < 0x100 || o.tile! > 0x108);
  const l3 = suggestPrefabs(rom, { levels: usedLevels(rom), level: (n) => (n === H2 ? open : loadLevel(rom, n)), load });
  check(l3.find((s) => s.prefab.w === 3)?.count === 2, 'the open level as edited');
}

// replaced by the prefab: the suggestion is gone
{
  const before = suggestPrefabs(rom, { levels: usedLevels(rom), load });
  const b = before.find((s) => s.prefab.w === 3)!;
  writePrefab(rom, 7, { ...b.prefab, name: 'Block' });
  applyPrefabPlaces(rom, 7, b.places);
  const after = suggestPrefabs(rom, { levels: usedLevels(rom), load });
  check(!after.some((s) => s.key === b.key), 'saved as prefab: gone');
  check(after.some((s) => s.prefab.w === 8), 'the others stay');
}

console.log(fail ? `${fail} failures` : 'prefab suggestions ok');
if (fail) process.exitCode = 1;
