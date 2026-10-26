// Finding a prefab's arrangement in the levels and replacing it (prefabplaces.ts, #114): Direct Map16 objects
// with the same tiles at the same relative places with the same conditions, however they are split; a place
// with an extra or a different tile is not one. Replacing keeps how every level looks (the emulated level
// load before and after, with the conditional flags off and on) and is one undo step with the prefab.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, isL1Vertical, type LevelObject } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { usedLevels, levelOverride } from '../src/core/levelusage.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { flagBytes } from '../src/core/cdm16.ts';
import { EditSession } from '../src/core/editsession.ts';
import { installPrefabPatch, writePrefab, PREFAB_EXT, TRANSPARENT, type Prefab } from '../src/core/prefabs.ts';
import { prefabDm16Objects } from '../src/core/prefabcost.ts';
import { findPrefabPlaces, planPrefabPlaces, applyPrefabPlaces, replaceWithPrefab } from '../src/core/prefabplaces.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const T = TRANSPARENT;
const cond = { flag: 3, always: true };
const s: Prefab = { w: 3, h: 2, tiles: [0x130, 0x131, T, 0x132, 0x132, 0x133], conds: [null, null, null, null, null, cond], name: 'P' };
const N = 9; // the prefab's number

const dm = (x: number, y: number, tile: number, w = 1, h = 1, c?: { flag: number; always: boolean }): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: ((h - 1) << 4) | (w - 1), tile, ...(c ? { cond: { ...c } } : {}) });
// the prefab's tiles as 1×1 objects (last first)
const singles = (x: number, y: number, tiles = s.tiles, conds = s.conds!): LevelObject[] =>
  tiles.flatMap((t, i) => (t === T ? [] : [dm(x + (i % s.w), y + Math.floor(i / s.w), t, 1, 1, conds[i] ?? undefined)])).reverse();
const coin = (x: number, y: number): LevelObject => ({ uid: newUid(), num: 5, ext: 0, x, y, size: 0 });

const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const emu = new LevelEmulator(rom);
emu.boot();
const load = (n: number, ov = {}) => emu.load(n, ov);

const H1 = 0x105, H2 = 0x106;
const V = usedLevels(rom).find((n) => isL1Vertical(rom, loadLevel(rom, n).header.mode))!;
const L2 = usedLevels(rom).find((n) => loadLevel(rom, n).layer2Objects)!; // a level with layer 2 objects
{
  const lv = loadLevel(rom, H1);
  const pre = lv.objects.length;
  lv.objects.push(
    ...prefabDm16Objects(s, 0x22, 8), // A: as Break up places it
    ...singles(0x2e, 6), // B: across a screen border, other objects
    ...singles(0x40, 8), dm(0x42, 8, 0x134), // C: an extra tile in the transparent cell
    ...singles(0x50, 8, s.tiles.map((t) => (t === 0x131 ? 0x135 : t))), // D: a different tile
    ...singles(0x60, 8, s.tiles, s.conds!.map(() => null)), // E: without the condition
    dm(0x70, 8, 0x130), dm(0x71, 8, 0x131), dm(0x6f, 9, 0x132, 3), dm(0x72, 9, 0x133, 1, 1, cond), // F: a tile more (a run reaching out)
  );
  saveLevel(rom, lv);
  check(loadLevel(rom, H1).objects.length === pre + 4 + 5 + 6 + 5 + 5 + 4, 'level 105 set up');
}
{
  // G: split in two with a coin between that the second half draws over; I: the coin stays on top
  const lv = loadLevel(rom, H2);
  const [a, b, c, d, e] = singles(0x30, 7);
  const [f, g, i, j, k] = singles(0x40, 7);
  lv.objects.push(a, b, c, coin(0x30, 7), d, e, f, g, coin(0x41, 8), i, j, k);
  saveLevel(rom, lv);
}
{
  const lv = loadLevel(rom, V);
  lv.objects.push(...prefabDm16Objects(s, 0x0e, 0x1f, true)); // across both borders
  saveLevel(rom, lv);
}
{
  // layer 2: as Break up places it; split around a coin drawn over (a place) and one on top (none)
  const lv = loadLevel(rom, L2);
  const [a, b, c, d, e] = singles(0x30, 7);
  const [f, g, i, j, k] = singles(0x40, 7);
  lv.layer2Objects!.push(...prefabDm16Objects(s, 0x22, 8), a, b, c, coin(0x30, 7), d, e, f, g, coin(0x41, 8), i, j, k);
  saveLevel(rom, lv);
}
{
  // the coin of G is where the test means it: written by it, at a tile of the prefab
  const lv = loadLevel(rom, H2);
  const r = load(H2, levelOverride(rom, lv));
  const k = lv.objects.findIndex((o) => o.num === 5 && o.x === 0x30);
  check((r.touched.get(k)?.size ?? 0) > 0, 'the coin writes a tile');
}

// ---- finding ----
const plan = planPrefabPlaces(rom, s, { levels: usedLevels(rom), load });
const at = (n: number) => plan.find((p) => p.level === n)?.places ?? [];
const xs = (n: number) => at(n).map((p) => `${p.x.toString(16)},${p.y.toString(16)}`).sort();
check(JSON.stringify(xs(H1)) === JSON.stringify(['22,8', '2e,6']), `level 105: A and B, not C–F (${xs(H1)})`);
check(JSON.stringify(xs(H2)) === JSON.stringify(['30,7']), `level 106: G, not I (${xs(H2)})`);
check(JSON.stringify(xs(V)) === JSON.stringify(['e,1f']), `vertical level ${V.toString(16)} (${xs(V)})`);
check(JSON.stringify(xs(L2)) === JSON.stringify(['22,8', '30,7']) && at(L2).every((p) => p.layer === 2), `layer 2 of level ${L2.toString(16)} (${xs(L2)})`);
check(plan.every((p) => [H1, H2, V, L2].includes(p.level)), 'no other level');
// the bytes saved: the objects found (B: four of 6 bytes, one of 7 with its condition) against 4
const b = at(H1).find((p) => p.x === 0x2e)!;
check(b.objects.length === 5 && b.bytes === 4 * 6 + 7 - 4, `B saves ${b.bytes}`);
const a = at(H1).find((p) => p.x === 0x22)!;
check(a.bytes === prefabDm16Objects(s, 0, 0).reduce((n, o) => n + (o.cond ? 7 : 6), 0) - 4, `A saves ${a.bytes}`);

// skipped objects (the selection, replaced by itself) are no place
const lv1 = loadLevel(rom, H1);
const skip = new Set(a.objects);
check(findPrefabPlaces(rom, lv1, s, (ov) => load(H1, ov), (layer, i) => layer === 1 && skip.has(i)).length === 1, 'skipped objects: no place');

// places sharing objects: the first is taken
{
  const lv = loadLevel(rom, H1);
  const two: Prefab = { w: 2, h: 1, tiles: [0x140, 0x140], name: '' };
  lv.objects.push(dm(0x80, 4, 0x140), dm(0x81, 4, 0x140), dm(0x82, 4, 0x140));
  const p = findPrefabPlaces(rom, lv, two, (ov) => load(H1, ov));
  check(p.length === 1 && p[0].x === 0x80, 'overlapping places: one');
}

// ---- replacing: the levels look the same, one undo step with the prefab ----
const MAP = [0xc800, 0x10000];
const look = (n: number, flags: number[]) => {
  const r = load(n, { cdm16Flags: flagBytes(flags) });
  return [r.wram.slice(MAP[0], MAP[1]), r.wram.slice(MAP[0] + 0x10000, MAP[1] + 0x10000)];
};
const same = (x: Uint8Array[], y: Uint8Array[]) => x.every((b, i) => b.every((v, j) => v === y[i][j]));
const levels = [H1, H2, V, L2];
const before = levels.map((n) => [look(n, []), look(n, [3])]);
const image = rom.data.slice();
const session = new EditSession(rom);
session.open(H1);
session.romEdit('Prefab saved', () => { writePrefab(rom, N, s); applyPrefabPlaces(rom, N, plan); });
levels.forEach((n, k) => {
  check(same(before[k][0], look(n, [])) && same(before[k][1], look(n, [3])), `level ${n.toString(16)} looks the same`);
  const lv = loadLevel(rom, n), objs = [...lv.objects, ...(lv.layer2Objects ?? [])];
  check(objs.filter((o) => o.num === 0 && o.ext === PREFAB_EXT && o.prefab === N).length === at(n).length, `level ${n.toString(16)}: ${at(n).length} prefab objects`);
});
// the rest of level 105 stays: C–F
check(loadLevel(rom, H1).objects.filter((o) => o.num === 0 && o.ext === DM16_EXT).length === 6 + 5 + 5 + 4, 'level 105: C–F stay');
session.undo();
check(rom.data.length === image.length && rom.data.every((v, i) => v === image[i]), 'one undo step takes back the prefab and every replacement');

// drawing order: the prefab object takes the place of the last object found
{
  const lv = loadLevel(rom, H2);
  const g = at(H2)[0];
  const last = Math.max(...g.objects);
  const after = lv.objects[last + 1];
  replaceWithPrefab(lv, N, [g]);
  const i = lv.objects.findIndex((o) => o.ext === PREFAB_EXT && o.num === 0);
  check(lv.objects[i + 1] === after && i === last - g.objects.length + 1, 'the prefab object where its last object was');
}

console.log(fail ? `${fail} failures` : 'prefab places ok');
if (fail) process.exitCode = 1;
