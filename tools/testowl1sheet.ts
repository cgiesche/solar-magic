// The overworld editor's layer 1 paint sheet (owl1sheet.ts) on the editor's test ROM: which tiles are free (drawn as
// tile 000, on no map, doing what 000 does), the rows of each page shown and folded (page 1 folded whole while it has
// none of the ROM's own tiles), and the hover popup's lines (each tile's function, "acts like" on page 1).
// node tools/testowl1sheet.ts
import { Rom } from '../src/core/rom.ts';
import { owTileWords, setOwTileWords, readL1, writeL1, OW_L1_TILES } from '../src/core/overworld.ts';
import { emptyL1Tiles, freeL1Tiles, sheetPages, l1TileLines, KINDS_LEARNING } from '../src/core/owl1sheet.ts';
import { PATH_KIND_NAMES } from '../src/core/owpaths.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom);
const empty = emptyL1Tiles(rom), free = freeL1Tiles(empty, kinds);
check(empty.length === OW_L1_TILES && free.length === OW_L1_TILES, 'a flag per tile 000–1FF');
check(!empty[0] && !free[0], 'tile 000 is not free (on the map, the others are copies of it)');
// the editor's Map16 extension: C1–FF copies of 000, on no map, doing what 000 does (nothing)
check(range(0xc1, 0x100).every((t) => free[t]), 'C1–FF (the extension\'s new tiles) are free');
check(range(0x01, 0xc1).filter((t) => free[t]).length === 0, 'none of the game\'s own tiles 01–C0 is free');
// invisible tiles drawn as 000 but doing something: empty, not free
const zero = owTileWords(rom, 0).join();
const invisible = range(1, 0xc1).filter((t) => owTileWords(rom, t).join() === zero && empty[t] && kinds[t] !== kinds[0]);
check(invisible.length > 0 && invisible.every((t) => !free[t]), `tiles drawn as 000 that do something are not free (${invisible.map(hx).join(' ')})`);
// page 1: every tile empty (the extension's copies of 000, on no map); free those acting as 000
check(range(0x100, 0x200).every((t) => empty[t]), 'page 1 is all empty');
check(range(0x100, 0x200).every((t) => free[t] === (kinds[t] === kinds[0])), 'page 1: free where the tile does what 000 does');
// while the kinds are learned an empty tile counts as free
check(freeL1Tiles(empty, null).every((f) => !f), 'kinds not known: no tile free (nothing folded)');

// ---- the pages ----
const [p0, p1] = sheetPages(empty, free);
check(p0.rows === 0xd, `page 0 shows rows 00–C0 (${p0.rows} rows), D0–FF folded`);
check(p0.folded === 0x30 && p0.hidden === 0 && p0.firstFree === 0xc1, `page 0: ${p0.folded} free tiles folded (D0–FF, the count those of the folded rows), the first free ${hx(p0.firstFree)}`);
check(p1.rows === 0, 'page 1 folded whole (none of its tiles is the ROM\'s own)');
check(p1.folded === range(0x100, 0x200).filter((t) => free[t]).length && p1.hidden === 0x100 - p1.folded && p1.hidden > 0 && p1.firstFree === 0x100,
  `page 1: ${p1.folded} free tiles and ${p1.hidden} others (invisible path and level tiles) folded, the first free ${hx(p1.firstFree)}`);
{
  const [, o1] = sheetPages(empty, free, true), last = Math.max(...range(0x100, 0x200).filter((t) => !free[t]));
  check(o1.rows === ((last - 0x100) >> 4) + 1 && o1.hidden === 0, `page 1 opened: shown up to its last tile not free, ${hx(last)} (${o1.rows} rows), nothing else hidden`);
}
// a tile of the ROM's own on page 1: drawn (not as 000) – page 1 shown up to its row
{
  const r = new Rom(rom.data.slice());
  setOwTileWords(r, 0x123, owTileWords(r, range(1, 0xc1).find((t) => owTileWords(r, t).join() !== zero)!));
  const e = emptyL1Tiles(r), [, q1] = sheetPages(e, freeL1Tiles(e, kinds));
  // (shown up to its last tile not free: the invisible path tiles acting as those of page 0 are shown too)
  const last = Math.max(...range(0x100, 0x200).filter((t) => !free[t]), 0x123);
  check(q1.rows === ((last - 0x100) >> 4) + 1, `a drawn tile 123: page 1 shown up to its last tile not free, ${hx(last)} (${q1.rows} rows)`);
  check(!e[0x123], 'tile 123 is no longer empty');
}
// on a map: a copy of 000 painted on the main map is no longer empty, its page shown up to it
{
  const r = new Rom(rom.data.slice()), l1 = readL1(r);
  l1[5] = 0xf3;
  writeL1(r, l1);
  const e = emptyL1Tiles(r), [q0] = sheetPages(e, freeL1Tiles(e, kinds));
  check(!e[0xf3] && q0.rows === 0x10 && q0.folded === 0, `tile F3 on the main map: not free, page 0 shows all its rows (${hx(q0.rows)}), none folded`);
  l1[5] = 0x1f3;
  writeL1(r, l1);
  const e1 = emptyL1Tiles(r), [, q1] = sheetPages(e1, freeL1Tiles(e1, kinds));
  check(!e1[0x1f3] && q1.rows === 0x10, 'tile 1F3 on the main map: page 1 shown up to it');
}

// ---- the popup's lines ----
const kindOf = (k: string) => range(0, 0x100).find((t) => kinds[t] === k)!;
const walk = kindOf('walk'), level = kindOf('level'), none = kindOf('none'), exit = kindOf('exit');
check(l1TileLines(walk, kinds, false)[0] === 'Path: walk', `a walk tile (${hx(walk)}): "Path: walk"`);
check(l1TileLines(exit, kinds, false)[0] === PATH_KIND_NAMES.exit, `an exit tile (${hx(exit)}): its function`);
check(/^Level tile.*free translevel when painted/.test(l1TileLines(level, kinds, false)[0]), `a level tile (${hx(level)}): enters a level, gets a free translevel`);
check(/^No path/.test(l1TileLines(none, kinds, false)[0]), `a tile Mario doesn't go on (${hx(none)}): no path`);
check(range(0, OW_L1_TILES).every((t) => l1TileLines(t, kinds, free[t]).length >= 1 && l1TileLines(t, kinds, free[t])[0] !== KINDS_LEARNING), 'every tile has its function');
const p1walk = l1TileLines(0x100 + walk, kinds, free[0x100 + walk]);
check(p1walk[0] === 'Path: walk' && p1walk[1] === `Acts like tile ${hx(walk).padStart(2, '0')} where Mario walks`, `page 1: ${p1walk.join(' / ')}`);
check(range(0x100, 0x200).every((t) => l1TileLines(t, kinds, free[t]).some((l) => l.startsWith('Acts like'))), 'every page 1 tile says what it acts like');
check(range(0, 0x100).every((t) => !l1TileLines(t, kinds, free[t]).some((l) => l.startsWith('Acts like'))), 'no page 0 tile does');
check(l1TileLines(0xc1, kinds, true).some((l) => l.startsWith('Free')), 'a free tile says so');
check(l1TileLines(walk, null, false)[0] === KINDS_LEARNING, 'kinds not known: being learned');

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
