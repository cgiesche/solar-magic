// A path tile's shape shown (owpathshape.ts pathWays, pathWaysText, pathTileText): the ways Mario takes over a tile – the
// lines the overlay and the layer 1 sheet draw, the words the popup and the status bar say – derived from the path
// shapes learned on the editor's test ROM. The expected ways are the ones the game takes on its own map (where Mario
// steps onto the tile and where it moves him, as owreach.ts follows him): a straight tile, a bend, a stair, a tile with
// two ways through it.
// node tools/testowpathshape.ts
import { Rom } from '../src/core/rom.ts';
import { readL1 } from '../src/core/overworld.ts';
import { PATH_KIND_NAMES, PATH_TILES_END } from '../src/core/owpaths.ts';
import { pathWays, pathWaysText, pathTileText, SHAPES_LEARNING, SHAPED_KINDS, type PathWay } from '../src/core/owpathshape.ts';
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
check(!shapeless.length, `every walk/climb/swim tile on the game's maps has a way (none: ${shapeless.map(hx).join(' ') || '–'})`);
// page 1 acts as page 0
check(shaped.every((t) => lines(0x100 + t) === lines(t)), 'page 1: the ways of the tile of page 0 it acts like');
// an exit, a stop or level tile: no line, its kind's name
const exit = kinds.findIndex((k) => k === 'exit'), stop = kinds.findIndex((k) => k === 'stop');
check(!ways(exit).length && !pathWays(0x07, 'walk', null).length && pathTileText(exit, 'exit', shapes) === PATH_KIND_NAMES.exit, `an exit tile (${hx(exit)}): no line (nor any tile while the shapes are learned), "${PATH_KIND_NAMES.exit}"`);
check(!ways(stop).length && pathTileText(stop, 'stop', shapes) === PATH_KIND_NAMES.stop, `a stop tile (${hx(stop)}): no line`);
// the popup's and the status bar's words
check(pathTileText(0x07, 'walk', shapes) === 'Path: walk · from below to the right, from the right down', `07: "${pathTileText(0x07, 'walk', shapes)}"`);
check(pathTileText(0x3f, kinds[0x3f], shapes) === 'Path: climb · from below up, from above down', `3F: "${pathTileText(0x3f, kinds[0x3f], shapes)}"`);
check(pathTileText(0x07, 'walk', null) === `Path: walk · ${SHAPES_LEARNING}`, 'shapes not known: the shape is being learned');

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
