// Overworld changes are ROM edits: a paint stroke (owstroke.ts) is one undo step; layer 1 changes only the bytes of
// the painted tiles, layer 2 stays where it is when it fits (each stream in its own place, the other untouched) and
// moves to free space only otherwise; a layer 1 stroke leaves level tiles alone (paints none, paints over none – they
// are edited in the Levels mode – the translevels untouched); the game shows the painted map (emulated).
import { Rom, snesToPc, pcToSnes } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, OverworldLoads, readL1, readL2, l1Index, l1XY, l2Index, l2Pointers, OW_L1, readMaps, readTranslevels, writeTranslevels,
} from '../src/core/overworld.ts';
import { OverworldStroke, type StrokeLayer, type StrokeEnd } from '../src/core/owstroke.ts';
import { NO_TILE } from '../src/core/owl1sheet.ts';
import type { LevelTileTest } from '../src/core/owpaths.ts';
import { RomWatch } from '../src/core/romwatch.ts';
import { levelNameTiles, setLevelNameTiles, encodeName } from '../src/core/levelnames.ts';
import { RAM, getS16 } from '../src/core/ram.ts';
import { submapViews } from '../src/core/owevents.ts';
import { editorPatch } from '../src/core/patches.ts';
import { RomReads, PAGE_SHIFT } from '../src/core/romdeps.ts';
import { editorImage, levelTiles } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const image = await editorImage();
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
// the file offsets where two images differ
// the ROM's layer 2, its first 0x1000 entries noise (no runs: grows past its place)
const noisyL2 = (rom: Rom) => {
  const l2 = readL2(rom);
  let seed = 1;
  for (let k = 0; k < 0x1000; k++) { seed = (seed * 1103515245 + 12345) >>> 0; l2[k] = (seed >>> 8) & 0x3fff; }
  return l2;
};
const noLevel: LevelTileTest = () => false;
// a stroke begun on the maps as in the ROM: each [region, x, y, v] painted, ended; its ROM edit made in the
// session (or written without one); the maps painted and its end
type Cell = [number, number, number, number];
function stroke(rom: Rom, layer: StrokeLayer, cells: Cell[], s?: RomEditSession, isLevel = noLevel): { maps: ReturnType<typeof readMaps>; end: StrokeEnd } {
  const maps = readMaps(rom), st = new OverworldStroke(rom, layer, maps, isLevel);
  for (const [region, x, y, v] of cells) st.paint(region, x, y, v);
  const end = st.end();
  if (s) s.edit(end.label, end.write!, { key: null }); else end.write!();
  return { maps, end };
}
// layer 1 cell i (l1Index) painted with tile v
const l1Cell = (i: number, v: number): Cell => { const { x, y } = l1XY(i); return [i >= 0x400 ? 1 : 0, x, y, v]; };
// the cells of a region of layer 2 `l2` (all 0x2000 entries) to paint
const l2Cells = (l2: Uint16Array, region: number): Cell[] => Array.from({ length: 64 * 64 }, (_, k) => [region, k & 63, k >> 6, l2[l2Index(region, k & 63, k >> 6)]]);
const diff = (a: Uint8Array, b: Uint8Array) => { const out: number[] = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i); return out; };

// layer 1: one stroke of three tiles, one undo step that changes their bytes only
{
  const { rom, s } = fresh();
  const before = rom.data.slice();
  const l1 = readL1(rom);
  const cells = [[3, 4], [4, 4], [20, 30]].map(([x, y]) => l1Index(0, x, y));
  for (const i of cells) l1[i] = l1[i] === 0x10 ? 0x11 : 0x10;
  const { end } = stroke(rom, 'l1', cells.map((i) => l1Cell(i, l1[i])), s);
  check(s.history.undoStack.length === 1 && end.label === 'Paint layer 1', 'layer 1 stroke: one undo step');
  check(same(diff(before, rom.data), cells.map((i) => snesToPc(OW_L1) + i).sort((a, b) => a - b)), 'layer 1 stroke: only the painted tiles\' bytes changed');
  s.undo();
  check(same(rom.data, before), 'layer 1 stroke undone');
  s.redo();
  check(same(readL1(rom), l1), 'layer 1 stroke redone');
  const n = s.history.undoStack.length, gen = rom.gen;
  stroke(rom, 'l1', cells.map((i) => l1Cell(i, l1[i])), s);
  check(s.history.undoStack.length === n && rom.gen === gen, 'a stroke that changes nothing: no undo step, no new ROM generation');
}

// layer 2: a small change stays in place; only the stream that changed is written
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), p = l2Pointers(rom);
  const l2 = readL2(rom);
  const i = l2Index(0, 10, 12);
  l2[i] = (l2[i] & 0xff00) | ((l2[i] + 1) & 0xff); // the tile number only
  stroke(rom, 'l2', [[0, 10, 12, l2[i]]], s);
  const q = l2Pointers(rom);
  check(q.tiles === p.tiles && q.attrs === p.attrs, 'layer 2, small change: both streams where they were');
  check(same(readL2(rom), l2), 'layer 2, small change: read back as painted');
  const changed = diff(before, rom.data);
  check(changed.length > 0 && changed.every((o) => o >= snesToPc(p.tiles) && o < snesToPc(p.attrs)), 'layer 2, tile change: only the tile stream written');
  s.undo();
  check(same(rom.data, before), 'layer 2 stroke undone');
}

// layer 2: data that doesn't fit moves to free space; a later small change stays there; undo brings all back
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), p = l2Pointers(rom);
  const l2 = noisyL2(rom);
  stroke(rom, 'l2', l2Cells(l2, 0), s);
  const q = l2Pointers(rom);
  check(q.tiles !== p.tiles && snesToPc(q.tiles) >= 0x80000, 'layer 2, grown: moved to free space');
  check(same(readL2(rom), l2), 'layer 2, grown: read back as painted');
  l2[l2Index(1, 5, 5)] ^= 0x0001;
  stroke(rom, 'l2', [[1, 5, 5, l2[l2Index(1, 5, 5)]]], s);
  const r = l2Pointers(rom);
  check(r.tiles === q.tiles && r.attrs === q.attrs, 'layer 2, moved: a small change stays in its block');
  check(same(readL2(rom), l2), 'layer 2, moved: read back as painted');
  l2[l2Index(1, 6, 5)] = 0x2100; // the attributes, too
  stroke(rom, 'l2', [[1, 6, 5, 0x2100]], s);
  check(same(readL2(rom), l2), 'layer 2, moved: an attribute change read back as painted');
  s.undo(); s.undo(); s.undo();
  check(same(rom.data, before), 'layer 2: the move undone');
}

// a level name: one undo step
{
  const { rom, s } = fresh();
  const was = levelNameTiles(rom, 1), next = encodeName('MY LEVEL').tiles;
  s.edit('Level name 001', () => setLevelNameTiles(rom, 1, next));
  check(s.history.undoStack.length === 1 && levelNameTiles(rom, 1).join() === [...next, ...Array(19 - next.length).fill(0x1f)].join(), 'level name: a ROM edit');
  s.undo();
  check(levelNameTiles(rom, 1).join() === was.join(), 'level name undone');
}

// the game shows the painted map: layer 1 in its tilemap in WRAM, layer 2 in VRAM
{
  const { rom } = fresh();
  const emu = new OverworldEmulator(rom);
  const r0 = emu.load(0, 0);
  const l1 = readL1(rom), l2 = readL2(rom);
  const i1 = l1Index(0, 7, 9), i2 = l2Index(0, 21, 40);
  l1[i1] = l1[i1] === 0x56 ? 0x57 : 0x56;
  l2[i2] = l2[i2] === 0x0123 ? 0x0124 : 0x0123;
  stroke(rom, 'l1', [l1Cell(i1, l1[i1])]);
  stroke(rom, 'l2', [[0, 21, 40, l2[i2]]]);
  const r = emu.load(0, 0);
  check(r0.ok && r.ok, 'overworld loads');
  check(r.wram[RAM.owLayer1 + i1] === l1[i1], 'the game\'s layer 1 has the painted tile');
  const base = (r.ppuRegs[0x08] & 0xfc) << 9; // BG2SC: the layer 2 tilemap
  const word = (v: Uint8Array, k: number) => v[base + k * 2] | (v[base + k * 2 + 1] << 8);
  check(word(r0.vram, i2) !== l2[i2] && word(r.vram, i2) === l2[i2], 'the game\'s layer 2 has the painted entry');
  check(Array.from({ length: 0x1000 }, (_, k) => k).every((k) => word(r.vram, k) === l2[k]), 'the game\'s layer 2 is the painted map');
}

// a kept load stays while a ROM edit changes no byte it read (a level's graphics), painting the map loads it again
{
  const { rom, s } = fresh();
  const loads = new OverworldLoads(new OverworldEmulator(rom), 4);
  const r0 = loads.get(0, 0), r5 = loads.get(0, 5);
  const gfx = editorPatch(rom)!.levelGfx + 0x105 * 8;
  s.edit('Level 105 graphics', () => rom.w8(gfx, rom.r8(gfx) ^ 1));
  check(loads.get(0, 0) === r0 && loads.get(0, 5) === r5, 'a ROM edit no load read: the loads kept (no emulation)');
  const l1 = readL1(rom), i = l1Index(0, 7, 9);
  l1[i] = l1[i] === 0x56 ? 0x57 : 0x56;
  stroke(rom, 'l1', [l1Cell(i, l1[i])], s);
  const r = loads.get(0, 0);
  check(r !== r0 && r.wram[RAM.owLayer1 + i] === l1[i], 'painting layer 1: loaded again, with the painted tile');
  check(loads.get(0, 5) !== r5, 'painting layer 1: the other event progress loaded again');
  s.undo();
  check(loads.get(0, 0).wram[RAM.owLayer1 + i] === r0.wram[RAM.owLayer1 + i], 'undone: loaded again, the tile as before');
}

// the submaps' views from the kept loads: as each submap's load shows them, shown again without emulating while the
// ROM edits changed nothing they read
{
  const { rom, s } = fresh();
  const emu = new OverworldEmulator(rom), loads = new OverworldLoads(emu, 2);
  let loaded = 0;
  const loadRecorded = emu.loadRecorded.bind(emu);
  emu.loadRecorded = (map, progress) => { loaded++; return loadRecorded(map, progress); };
  // each submap's camera as its own load leaves it
  const direct = () => {
    const e = new OverworldEmulator(new Rom(rom.data.slice()));
    return [1, 2, 3, 4, 5, 6].map((k) => { const w = e.load(k, 0).wram; return `${Math.round(getS16(w, RAM.layer2X) / 8)},${Math.round(getS16(w, RAM.layer2Y) / 8)}`; }).join(' ');
  };
  const text = (v: ReturnType<typeof submapViews>) => v.slice(1).map((r) => `${r.x},${r.y}`).join(' ');
  const r0 = loads.get(0, 0), r1 = loads.get(1, 0);
  loaded = 0;
  const v = submapViews(loads), want = direct();
  check(loaded === 5 && text(v) === want, `the submaps' views: ${text(v)} (each submap's load: ${want}), ${loaded} loads (submap 1's kept)`);
  loaded = 0;
  check(submapViews(loads) === v && loaded === 0, 'asked again: the kept views, no load');
  const gfx = editorPatch(rom)!.levelGfx + 0x105 * 8;
  s.edit('Level 105 graphics', () => rom.w8(gfx, rom.r8(gfx) ^ 1));
  check(submapViews(loads) === v && loaded === 0, 'a ROM edit no load read: the kept views, no load');
  check(loads.get(0, 0) === r0 && loads.get(1, 0) === r1 && loaded === 0, 'the loads kept before stay kept: no load');
  const l1 = readL1(rom), i = l1Index(1, 7, 9);
  l1[i] = l1[i] === 0x56 ? 0x57 : 0x56;
  stroke(rom, 'l1', [l1Cell(i, l1[i])], s);
  loaded = 0;
  const v2 = submapViews(loads);
  // (the views leave out the tilemaps they read, #386)
  check(v2 === v && loaded === 0 && text(v2) === direct(), `painting layer 1: the kept views (${loaded} loads), as the loads give them`);
}

// layer 2 moved to free space: the loads record its new place by byte (no title screen reached again in between), an
// edit next to it they didn't read keeps them; an outer read recorder survives a load that reaches the title screen
{
  const { rom, s } = fresh();
  const emu = new OverworldEmulator(rom), outer = new RomReads(rom);
  emu.snes.romReads = outer;
  emu.load(0, 0);
  check(emu.snes.romReads === outer && outer.bytes.has(snesToPc(OW_L1)), 'reaching the title screen: the outer recorder put back, with the load\'s reads');
  emu.snes.romReads = null;
  const loads = new OverworldLoads(emu, 4);
  const l2 = noisyL2(rom);
  stroke(rom, 'l2', l2Cells(l2, 0), s);
  const r0 = loads.get(0, 0);
  const attrs = snesToPc(l2Pointers(rom).attrs), block = rom.scanRats().find((b) => b.start + 8 <= attrs && attrs < b.start + 8 + b.size)!;
  const end = block.start + 8 + block.size, next = end + 0x10; // free space after the block, in its last page
  check(next >> PAGE_SHIFT === (end - 1) >> PAGE_SHIFT, 'layer 2, moved: free space next to it in its page');
  s.edit('Free space next to layer 2', () => rom.w8(pcToSnes(next), rom.data[next] ^ 1));
  check(loads.get(0, 0) === r0, 'layer 2, moved: an edit next to it the load didn\'t read keeps it (no emulation)');
  l2[l2Index(0, 5, 5)] ^= 0x0001;
  stroke(rom, 'l2', [[0, 5, 5, l2[l2Index(0, 5, 5)]]], s);
  check(loads.get(0, 0) !== r0, 'layer 2, moved: painting it loads again');
}

// the overworld view syncs through a watch of the maps it reads (readMaps): a ROM edit that touches no overworld bytes
// (a level's graphics, free space next to its moved layer 2) does not resync; painting a layer, the translevels or
// undo does
{
  const { rom, s } = fresh();
  const watch = new RomWatch(rom);
  let syncs = 0;
  const w = watch.watch(() => { syncs++; w.run(() => readMaps(rom)); });
  w.run(() => readMaps(rom));
  const edit = (label: string, f: () => void) => { s.edit(label, f); watch.notify(); };
  const paint = (layer: StrokeLayer, cells: Cell[]) => { stroke(rom, layer, cells, s); watch.notify(); };
  const gfx = editorPatch(rom)!.levelGfx + 0x105 * 8;
  edit('Level 105 graphics', () => rom.w8(gfx, rom.r8(gfx) ^ 1));
  check(syncs === 0, 'overworld view: a ROM edit touching no overworld bytes does not resync');
  const l1 = readL1(rom), i = l1Index(0, 7, 9);
  l1[i] = l1[i] === 0x56 ? 0x57 : 0x56;
  paint('l1', [l1Cell(i, l1[i])]);
  check(syncs === 1, 'overworld view: painting layer 1 resyncs');
  paint('l2', l2Cells(noisyL2(rom), 0));
  check(syncs === 2, 'overworld view: painting layer 2 (moved to free space) resyncs');
  const attrs = snesToPc(l2Pointers(rom).attrs), block = rom.scanRats().find((b) => b.start + 8 <= attrs && attrs < b.start + 8 + b.size)!;
  const next = block.start + 8 + block.size + 0x10;
  edit('Free space next to layer 2', () => rom.w8(pcToSnes(next), rom.data[next] ^ 1));
  check(syncs === 2, 'overworld view: an edit next to the moved layer 2 does not resync');
  const tls = readTranslevels(rom);
  tls[l1Index(0, 3, 3)] ^= 1;
  edit('Translevels', () => writeTranslevels(rom, tls));
  check(syncs === 3, 'overworld view: a translevel change resyncs');
  s.undo(); watch.notify();
  check(syncs === 4, 'overworld view: undo resyncs');
}

// level tiles (ADR 0012: edited in the Levels mode only): a layer 1 stroke neither paints one nor paints over one,
// NO_TILE (where a pick left a level tile out of the brush) paints nothing; the translevels stay
{
  const { rom, s } = fresh();
  const isLevel = levelTiles(rom), was = readMaps(rom);
  const empty = Array.from({ length: 0x800 }, (_, i) => i).filter((i) => !isLevel(was.l1[i]) && !was.tls[i]);
  const placed = Array.from({ length: 0x800 }, (_, i) => i).filter((i) => isLevel(was.l1[i]) && was.tls[i]);
  const lt = was.l1[placed[0]], path = empty.slice(2).find((i) => was.l1[i] !== 0x10)!;
  check(empty.length > 0 && placed.length > 0, `the map: ${placed.length} level tiles with a translevel, ${empty.length} cells without`);
  const { maps } = stroke(rom, 'l1', [l1Cell(empty[0], lt), l1Cell(placed[0], 0x10), l1Cell(placed[1], NO_TILE), l1Cell(path, 0x10), l1Cell(empty[1], NO_TILE)], s, isLevel);
  check(maps.l1[empty[0]] === was.l1[empty[0]] && maps.l1[placed[0]] === lt && maps.l1[placed[1]] === was.l1[placed[1]] && maps.l1[empty[1]] === was.l1[empty[1]] && maps.l1[path] === 0x10,
    'a stroke over a level tile leaves it, a level tile painted elsewhere is not, NO_TILE paints nothing; the other cell painted');
  check(same(readL1(rom).filter((_, i) => i !== path), was.l1.filter((_, i) => i !== path)) && same(readTranslevels(rom), was.tls) && s.history.undoStack.length === 1,
    'written: only the path cell changed, the translevels as they were, one ROM edit');
  s.undo();
  check(same(rom.data, image), 'undone: the ROM as before');
}

// a stroke cancelled (Esc): the maps it painted are as when it began – layer 1 with its translevels, layer 2, and an
// event's maps – and nothing is written
{
  const rom = new Rom(image.slice()), before = rom.data.slice(), maps = readMaps(rom), was = { l1: maps.l1.slice(), l2: maps.l2.slice(), tls: maps.tls.slice() };
  const lv = (t: number) => t === 0x56;
  const st = new OverworldStroke(rom, 'l1', maps, lv);
  st.paint(0, 3, 3, maps.l1[l1Index(0, 3, 3)] === 0x11 ? 0x12 : 0x11);
  st.paint(0, 4, 3, 0x12);
  check(!same(maps.l1, was.l1), 'a layer 1 stroke paints into the maps');
  st.cancel();
  check(same(maps.l1, was.l1) && same(maps.tls, was.tls) && same(maps.l2, was.l2) && same(rom.data, before), 'cancelled: layer 1 as before, nothing written');
  const s2 = new OverworldStroke(rom, 'l2', maps, lv);
  s2.paint(1, 7, 7, 0x2100);
  s2.cancel();
  check(same(maps.l2, was.l2), 'a layer 2 stroke cancelled: layer 2 as before');
  const after = maps.l2.slice(), l1 = maps.l1.slice();
  const s3 = new OverworldStroke(rom, 'l1', maps, lv, { event: 5, after, l1, game: l1.slice(), without: l1.slice(), place: () => null });
  const s4 = new OverworldStroke(rom, 'l2', maps, lv, { event: 5, after, l1, game: l1.slice(), without: l1.slice(), place: () => null });
  s3.paint(0, 2, 2, l1[l1Index(0, 2, 2)] === 0x11 ? 0x12 : 0x11);
  s4.paint(0, 9, 9, 0x2100);
  s4.cancel();
  s3.cancel();
  check(same(after, maps.l2) && same(l1, maps.l1) && same(maps.tls, was.tls), 'an event\'s maps cancelled: as after the event before the stroke');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('overworld edits ok');
