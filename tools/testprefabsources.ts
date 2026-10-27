// The objects a prefab was made from (prefabsources.ts): kept in the editor data (not the ROM image) under the
// prefab's tiles; a rename keeps them, other tiles or deleting drop them. Breaking up gives them back where they
// draw the level as the prefab did (a resizable object stays one object), else the tiles as Direct Map16 objects.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, levelRows, isL1Vertical, newUid, type Level, type LevelObject } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { layerGeom } from '../src/core/render.ts';
import { MAP_BASE, map16Tile } from '../src/core/ram.ts';
import { installPrefabPatch, writePrefab, PREFAB_EXT, PREFAB_MAX, TRANSPARENT, type Prefab } from '../src/core/prefabs.ts';
import { prefabSources, setPrefabSources, breakUpPrefab } from '../src/core/prefabsources.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const emu = new LevelEmulator(rom);
emu.boot();
const load = (lv: Level) => emu.load(lv.number, levelOverride(rom, lv));

// a standard object of level 105 drawing at least two different tiles (a resizable one), as a prefab of the
// cells it owns (as "Selection as prefab" takes them)
const H = 0x105, N = 3;
const lv = loadLevel(rom, H);
const r = load(lv);
const geom = layerGeom(rom, 0, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
let pick: { o: LevelObject; s: Prefab; x: number; y: number } | null = null;
for (const [i, o] of lv.objects.entries()) {
  if (o.num === 0 || o.size === 0) continue;
  const cells = new Map<string, number>();
  for (let y = 0; y < levelRows(lv.secondary); y++) for (let x = 0; x < lv.header.screens * 16; x++) {
    const a = geom.addr(x, y);
    if (a >= 0 && r.owner[a - MAP_BASE] === i) cells.set(`${x},${y}`, map16Tile(r.wram, a));
  }
  if (new Set(cells.values()).size < 2) continue;
  const xs = [...cells.keys()].map((k) => +k.split(',')[0]), ys = [...cells.keys()].map((k) => +k.split(',')[1]);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x + 1, h = Math.max(...ys) - y + 1;
  if (w > PREFAB_MAX || h > PREFAB_MAX) continue;
  const tiles = Array.from({ length: w * h }, (_, j) => cells.get(`${x + (j % w)},${y + Math.floor(j / w)}`) ?? TRANSPARENT);
  pick = { o, s: { w, h, tiles, name: 'Ledge' }, x, y };
  break;
}
check(!!pick, 'a resizable object in level 105');
const { o, s, x, y } = pick!;

// stored with the prefab, in the editor data only
writePrefab(rom, N, s);
const image = rom.output(false);
setPrefabSources(rom, N, s, [o], x, y);
check(rom.output(false).every((b, i) => b === image[i]), 'not in the ROM image');
const back = prefabSources(rom, N, s, x, y);
check(back?.length === 1 && back[0].num === o.num && back[0].size === o.size && back[0].x === o.x && back[0].y === o.y && back[0].uid !== o.uid, 'read back at its place');
check(Rom.fromFile(rom.outputProject(false)) && !!prefabSources(Rom.fromFile(rom.outputProject(false)), N, s, x, y), 'kept in the project file');

// breaking up where it was made: the object again, one object
const placed = (): Level => {
  const l = loadLevel(rom, H);
  const at = l.objects.findIndex((q) => q.x === o.x && q.y === o.y && q.num === o.num && q.size === o.size);
  l.objects[at] = { uid: newUid(), num: 0, ext: PREFAB_EXT, x, y, size: 0, prefab: N };
  return l;
};
const vertical = isL1Vertical(rom, lv.header.mode);
let l = placed();
let b = breakUpPrefab(rom, l, l.objects.find((q) => q.prefab === N)!, vertical, load);
check(!!b && b.sources && !b.differs && b.parts.length === 1 && b.parts[0].num === o.num && b.parts[0].size === o.size, 'broken up into the object it was made from');

// objects that would draw differently there (one tile wider): its tiles instead
setPrefabSources(rom, N, s, [{ ...o, size: o.size + 1 }], x, y);
l = placed();
b = breakUpPrefab(rom, l, l.objects.find((q) => q.prefab === N)!, vertical, load);
check(!!b && !b.sources && b.differs && b.parts.every((p) => p.num === 0 && p.ext !== PREFAB_EXT) && b.parts.length > 1, 'drawn differently: Direct Map16 objects');
setPrefabSources(rom, N, s, [o], x, y);

// a rename keeps them, other tiles or deleting the prefab drop them
writePrefab(rom, N, { ...s, name: 'Renamed' });
check(!!prefabSources(rom, N, s, x, y), 'kept on rename');
const other = { ...s, tiles: s.tiles.map((t) => (t === TRANSPARENT ? t : 0x130)) };
writePrefab(rom, N, other);
check(!prefabSources(rom, N, other, x, y) && !prefabSources(rom, N, s, x, y), 'dropped with other tiles');
writePrefab(rom, N, s);
setPrefabSources(rom, N, s, [o], x, y);
writePrefab(rom, N, null);
check(!prefabSources(rom, N, s, x, y) && rom.getBlob('prefab-sources') === null, 'dropped with the prefab');

// without sources: the tiles as Direct Map16 objects
writePrefab(rom, N, s);
l = placed();
b = breakUpPrefab(rom, l, l.objects.find((q) => q.prefab === N)!, vertical, load);
check(!!b && !b.sources && !b.differs && b.parts.every((p) => p.num === 0), 'no sources: Direct Map16 objects');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('prefab sources ok');
