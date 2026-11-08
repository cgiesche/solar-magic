// A path tile's shape shown (owpathshape.ts pathWays, pathWaysText, pathTileText, pathTileLines): the ways Mario takes
// over a tile – the lines the overlay and the layer 1 sheet draw, the words the popup and the status bar say – derived
// from the path shapes learned on the editor's test ROM. The expected ways are the ones the game takes on its own map
// (where Mario steps onto the tile and where it moves him, as owreach.ts follows him): a straight tile, a bend, a
// stair, a tile with two ways through it; an exit tile's axis, the way he comes out on, on the other submap.
// node tools/testowpathshape.ts
import { Rom } from '../src/core/rom.ts';
import { PATH_KIND_NAMES, PATH_TILES_END } from '../src/core/owpaths.ts';
import { readL1, OverworldEmulator, OverworldLoads, gameL1, l1XY, OW_EVENTS } from '../src/core/overworld.ts';
import { mapWays, usualWays, pathWays, tileWays, pathWaysText, pathTileText, pathTileLines, exitAxis, exitFirstStepMisses, climbedOnto, EXIT_FIRST_STEP_MISSES, CLIMBED_ONTO, SHAPES_LEARNING, SHAPED_KINDS, type PathWay } from '../src/core/owpathshape.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const ways = (t: number) => pathWays(t, kinds[t], shapes);
const show = (w: PathWay) => `(${w.from})→(${w.to})`;
// a tile's lines (a way and the way back are one), as a set to compare
const lines = (t: number) => [...new Set(ways(t).map((w) => [w.from.join(), w.to.join()].sort().join('–')))].sort().join(' ');

// a straight tile: across the tile's middle, both ways
check(pathWaysText(ways(0x04)) === 'from the right to the left, from the left to the right', `04 (straight): "${pathWaysText(ways(0x04))}"`);
check(lines(0x04) === '0,8–16,8', `04: one line through the middle, ${lines(0x04)}`);
check(pathWaysText(ways(0x10)) === 'from below up, from above down' && lines(0x10) === '8,0–8,16', `10 (straight, up and down): ${lines(0x10)}`);
// a bend: stepping on from below Mario leaves to the right (the game: onto 07 at its bottom's middle, moved to its
// right side 4 pixels up)
check(pathWaysText(ways(0x07)) === 'from below to the right, from the right down', `07 (bend): "${pathWaysText(ways(0x07))}"`);
check(lines(0x07) === '16,12–8,16', `07: from the bottom's middle to the right side, ${ways(0x07).map(show).join(' ')}`);
// a stair: left to right half a tile up
check(lines(0x01) === '0,12–16,4' && pathWaysText(ways(0x01)) === 'from the right to the left, from the left to the right', `01 (stair): ${lines(0x01)}`);
// a tile with two ways through it (two bends in opposite corners; the game's map takes one or the other)
const two = ways(0x19);
check(lines(0x19) === '0,12–4,16 12,0–16,4' && pathWaysText(two) === 'from below to the left, from the left down, from above to the right, from the right up',
  `19 (two ways through it: bends at its bottom left and top right corners): ${pathWaysText(two)}`);
// told apart: straight, bend, stair and the two-way tile draw different lines
check(new Set([0x04, 0x10, 0x07, 0x01, 0x19].map(lines)).size === 5, 'straight, bend, stair and two-way tiles: different lines');

// every way: from one side to another, its way back one too
const shaped = Array.from({ length: PATH_TILES_END - 1 }, (_, k) => k + 1).filter((t) => SHAPED_KINDS.includes(kinds[t]));
const edge = (p: [number, number]) => p[0] === 0 || p[0] === 16 || p[1] === 0 || p[1] === 16;
check(shaped.every((t) => ways(t).every((w) => edge(w.from) && edge(w.to) && ways(t).some((b) => b.dir === (w.out ^ 1) && b.out === (w.dir ^ 1) && b.from.join() === w.to.join()))),
  'every way leads from one side of its tile to another, its way back is one too');
// every path tile the game's map has shows a shape
const onMaps = new Set(readL1(rom));
const shapeless = shaped.filter((t) => onMaps.has(t) && !ways(t).length);
check(!shapeless.length, `every walk/climb/swim/exit tile on the game's maps has a way (none: ${shapeless.map(hx).join(' ') || '–'})`);
// page 1 acts as page 0
check(shaped.every((t) => lines(0x100 + t) === lines(t)), 'page 1: the ways of the tile of page 0 it acts like');
// a stop or level tile: no line, its kind's name; no tile while the shapes are learned
const stop = kinds.findIndex((k) => k === 'stop');
check(!ways(stop).length && pathTileText(stop, 'stop', shapes) === PATH_KIND_NAMES.stop, `a stop tile (${hx(stop)}): no line`);
check(!pathWays(0x07, 'walk', null).length && !pathWays(0x42, 'exit', null).length, 'no line while the shapes are learned');

// exit tiles (docs/research/overworld-submap-exit-tiles.md): their axis, the way Mario comes out on on the other submap – 42
// horizontal, the other nine vertical; 4D's first step off a stop misses the exit; 40 is climbed onto
const exits = kinds.map((k, t) => (k === 'exit' ? t : -1)).filter((t) => t >= 0);
check(exits.map(hx).join(' ') === '25 40 42 43 44 45 46 47 48 4D 125 140 142 143 144 145 146 147 148 14D', `the exit tiles: ${exits.map(hx).join(' ')}`);
const VERT = '8,0–8,16', HORIZ = '0,8–16,8';
check(exits.every((t) => lines(t) === ((t & 0xff) === 0x42 ? HORIZ : VERT)), `42 a horizontal line through the middle, the other nine a vertical one (${exits.map((t) => `${hx(t)}: ${lines(t)}`).join(', ')})`);
check(exits.every((t) => exitAxis(t, shapes) === ((t & 0xff) === 0x42 ? 'horizontal' : 'vertical')), 'exitAxis: 42 horizontal, the others vertical');
const lines42 = pathTileLines(0x42, 'exit', shapes);
check(lines42.join('|') === `${PATH_KIND_NAMES.exit} · from the left or right (Mario comes out going on that way)`, `42: "${lines42.join(' | ')}"`);
check(pathTileLines(0x25, 'exit', shapes).join('|') === `${PATH_KIND_NAMES.exit} · from above or below (Mario comes out going on that way)`, `25: "${pathTileLines(0x25, 'exit', shapes).join(' | ')}"`);
const lines4d = pathTileLines(0x4d, 'exit', shapes), lines40 = pathTileLines(0x40, 'exit', shapes);
check(lines4d.join('|') === `${PATH_KIND_NAMES.exit} · from above or below (Mario comes out going on that way)|${EXIT_FIRST_STEP_MISSES}`, `4D: its first step misses, "${lines4d.join(' | ')}"`);
check(lines40.join('|') === `${PATH_KIND_NAMES.exit} · from above or below (Mario comes out going on that way)|${CLIMBED_ONTO}`, `40: climbed onto, "${lines40.join(' | ')}"`);
check(exits.filter((t) => exitFirstStepMisses(t, shapes)).map(hx).join(' ') === '4D 14D' && exits.filter((t) => climbedOnto(t, shapes)).map(hx).join(' ') === '40 140',
  'only 4D (and 14D) miss with the first step, only 40 (and 140) are climbed onto');
check(pathTileText(0x4d, 'exit', shapes) === lines4d.join(' · '), `the status bar: one line, "${pathTileText(0x4d, 'exit', shapes)}"`);
check(pathTileText(0x42, 'exit', null) === `${PATH_KIND_NAMES.exit} · ${SHAPES_LEARNING}`, 'an exit tile while the shapes are learned');
// from the learned data, not the tile number: an exit tile given 42's vectors (as a hack's code may) shows 42's way
const swapped = { ...shapes, walk: shapes.walk.slice() };
for (let k = 0; k < 8; k++) swapped.walk[0x25 * 8 + k] = shapes.walk[0x42 * 8 + k];
check(pathWays(0x25, 'exit', swapped).every((w) => [w.from.join(), w.to.join()].sort().join('–') === HORIZ) && pathWays(0x25, 'exit', swapped).length === 2 && pathTileLines(0x25, 'exit', swapped)[0].includes('from the left or right'),
  'an exit tile with horizontal vectors shows the horizontal way, whatever its number');
// mixed vectors: no axis, the kind's name alone
const mixed = { ...shapes, walk: shapes.walk.slice() };
mixed.walk[0x25 * 8 + 4] = -16; mixed.walk[0x25 * 8 + 5] = 0;
check(!pathWays(0x25, 'exit', mixed).length && pathTileLines(0x25, 'exit', mixed)[0] === PATH_KIND_NAMES.exit, 'an exit tile whose vectors share no axis: no line, its kind\'s name');
// the popup's and the status bar's words
check(pathTileText(0x07, 'walk', shapes) === 'Path: walk · from below to the right, from the right down', `07: "${pathTileText(0x07, 'walk', shapes)}"`);
check(pathTileText(0x3f, kinds[0x3f], shapes) === 'Path: climb · from below up, from above down', `3F: "${pathTileText(0x3f, kinds[0x3f], shapes)}"`);
check(pathTileText(0x07, 'walk', null) === `Path: walk · ${SHAPES_LEARNING}`, 'shapes not known: the shape is being learned');

// on the map: where Mario walks over a tile, as the game moves him – a straight tile's line at the height the tile
// before leaves him (02, 04 and 06 move him alike; on the game's map he walks over 02 at its bottom, 04 through its
// middle, 06 at its top), the sheet's line the one the map's cells with the tile have most
const g = new OverworldLoads(new OverworldEmulator(rom), 4).get(0, OW_EVENTS), l1 = gameL1(g).slice();
const walked = mapWays(l1, kinds, shapes);
const lineSet = (ws: readonly PathWay[]) => [...new Set(ws.map((w) => [w.from.join(), w.to.join()].sort().join('–')))].sort().join(' ');
const cellsOf = (t: number) => [...walked.keys()].filter((c) => l1[c] === t);
const onMap = (t: number) => [...new Set(cellsOf(t).map((c) => lineSet(walked.get(c)!)))].join(' / ');
for (const [t, want] of [[0x02, '0,12–16,12'], [0x04, HORIZ], [0x06, '0,4–16,4']] as const) {
  check(cellsOf(t).length > 0 && onMap(t) === want, `${hx(t)} on the map: ${want} (${onMap(t)}, ${cellsOf(t).length} cells)`);
  check(lineSet(usualWays(t, kinds[t], shapes, l1, walked)) === want, `${hx(t)} in the sheet: ${lineSet(usualWays(t, kinds[t], shapes, l1, walked))}`);
}
// told apart by where they are walked, not by their vectors (the same)
check(new Set([0x02, 0x04, 0x06].map((t) => lineSet(usualWays(t, kinds[t], shapes, l1, walked)))).size === 3, '02, 04 and 06: three different lines');
// each line walked on the map is one of the tile's ways (tileWays: from a point along a side to another side, the
// way back leading back)
const notAWay = [...walked].filter(([c, ws]) => !ws.every((w) => tileWays(l1[c], kinds[l1[c]], shapes).some((v) => v.dir === w.dir && v.from.join() === w.from.join() && v.to.join() === w.to.join())));
check(!notAWay.length, `every line walked on the map is one of its tile's ways (not: ${notAWay.slice(0, 5).map(([c]) => `${hx(l1[c])} at ${l1XY(c).x},${l1XY(c).y}`).join(', ') || '–'})`);
// a tile no cell of the map has: its most centred lines (pathWays)
const unused = shaped.find((t) => SHAPED_KINDS.includes(kinds[t]) && kinds[t] !== 'exit' && !cellsOf(t).length && !cellsOf(t + 0x100).length);
check(unused !== undefined && lineSet(usualWays(unused, kinds[unused], shapes, l1, walked)) === lines(unused), `a tile not on the map (${hx(unused ?? 0)}): its centred lines`);

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
