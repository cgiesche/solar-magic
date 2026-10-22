// Moving Map16 tiles with their uses, and rewriting the uses alone (tilemove.ts): a move of tiles 200-FFF
// takes their graphics, acts-like and block along and rewrites the Direct Map16 objects of every level, the
// structures, the BG tilemaps and the block list, so the levels look the same before and after; moving
// onto a tile in use, a tile placed by code, half of a conditional "always show" pair or outside 200-FFF
// is refused, onto a defined tile asked first. Lunar Magic's Remap Direct Map16 / Background Tiles rewrite
// the uses only (current level or all), a game BG becoming the editor's. One ROM edit is one undo step.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelRender } from '../src/core/levelemu.ts';
import { loadLevel, newUid, levelRows, type Level, type LevelObject } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { DM16_EXT, bgBank } from '../src/core/patches.ts';
import { STRUCT_EXT, writeStructure, readStructure, TRANSPARENT } from '../src/core/structs.ts';
import { setActsLike, setExtTileWords, extTileWords, actsLike, blockOf, DEFAULT_ACTS } from '../src/core/map16ext.ts';
import { setBgExtTileWords, bgTileWords } from '../src/core/bgmap16.ts';
import { bgFromWram, bgIndex } from '../src/core/bg.ts';
import { map16Source, layerGeom } from '../src/core/render.ts';
import { map16Tile } from '../src/core/ram.ts';
import { flagBytes } from '../src/core/cdm16.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { loadAsar } from '../src/core/asar.ts';
import { saveBlockProject, loadBlockProject } from '../src/core/blocks.ts';
import type { LevelTiles } from '../src/core/levelusage.ts';
import { planMove, applyMove, planRemap, applyRemap, rectMap, storedBg } from '../src/core/tilemove.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };
const hx = (n: number) => n.toString(16).toUpperCase();

await loadAsar();
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const blank = map16Source(rom, emu.load(0x105)).fg(0x025);
const dm16 = (x: number, y: number, tile: number, size = 0, cond?: LevelObject['cond']): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size, tile, ...(cond ? { cond } : {}) });

// level 105: Direct Map16 objects (a 2×1 one of 345, a conditional "always show" one of 350), a structure with
// 346, an edited BG with BG tile 2A0; level 106: a Direct Map16 object of 345 too; a block on 347
const FLAG = 5;
{
  const lv = loadLevel(rom, 0x105);
  check(!lv.layer2Objects, 'level 105 has a BG tilemap');
  writeStructure(rom, 7, { w: 2, h: 1, tiles: [0x346, TRANSPARENT], name: 'test' });
  lv.objects.push(dm16(0x20, 0x10, 0x345, 0x01), dm16(0x24, 0x10, 0x350, 0, { flag: FLAG, always: true }));
  lv.objects.push({ uid: newUid(), num: 0, ext: STRUCT_EXT, x: 0x30, y: 0x12, size: 0, struct: 7 });
  lv.bg = bgFromWram(emu.load(0x105).wram);
  lv.bg[bgIndex(3, 20)] = 0x2a0;
  saveLevel(rom, lv);
  const l6 = loadLevel(rom, 0x106);
  l6.objects.push(dm16(0x12, 0x10, 0x345));
  saveLevel(rom, l6);
}
for (const [t, w] of [[0x345, [1, 2, 3, 4]], [0x346, [1, 2, 3, 5]], [0x347, [1, 2, 3, 7]], [0x350, [1, 2, 3, 8]], [0x450, [1, 2, 3, 9]], [0x5a0, [9, 9, 9, 9]]] as const) setExtTileWords(rom, t, [...w]);
setActsLike(rom, 0x345, 0x130);
setBgExtTileWords(rom, 0x2a0, [5, 6, 7, 8]);
{
  const r = saveBlockProject(rom, { files: new Map([['blocks/solid.asm', new TextEncoder().encode('db $42\nJMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A\nA:\nRTL\n')]]), list: [{ tile: 0x347, file: 'blocks/solid.asm' }] });
  check(r.ok, `a block on 347 ${r.errors.join(' ')}`);
}
const levels = [0x105, 0x106, 0x107];

// what a level looks like: the words of every layer 1 tile and of its BG tilemap, with the flag off and on
function look(n: number): string {
  const lv = loadLevel(rom, n);
  const one = (r: LevelRender) => {
    const src = map16Source(rom, r), g = layerGeom(rom, 0, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
    const out: string[] = [];
    for (let x = 0; x < g.width; x++) for (let y = 0; y < g.height; y++) { const a = g.addr(x, y); if (a >= 0) out.push(src.fg(map16Tile(r.wram, a)).join()); }
    for (const t of bgFromWram(r.wram)) out.push(src.bg(t).join());
    return out.join(';');
  };
  return one(emu.load(n, { cdm16Flags: flagBytes([]) })) + '|' + one(emu.load(n, { cdm16Flags: flagBytes([FLAG]) }));
}
const before = new Map(levels.map((n) => [n, look(n)]));

// ---- the plan ----
{
  check(rectMap(0x345, 2, 1, 0x545).size === 2 && rectMap(0x34f, 1, 2, 0x500).get(0x35f) === 0x510, 'rectMap: a rectangle of tiles, 16 a row');
  const p = planMove(rom, 'fg', rectMap(0x345, 3, 1, 0x545), { levels, blank });
  check(!p.problems.length, `a move to free tiles: no problems ${p.problems.join(' | ')}`);
  check(p.levels.map((l) => `${hx(l.level)}:${l.objects}`).join() === '105:1,106:1', `the levels whose objects change: ${p.levels.map((l) => `${hx(l.level)}:${l.objects}`).join()}`);
  check(p.structures.join() === '7' && p.blocks.join() === String(0x347) && !p.overwrite.length, 'the structure, the block, nothing overwritten');
  const onUsed = planMove(rom, 'fg', new Map([[0x345, 0x346]]), { levels, blank });
  check(onUsed.problems.some((q) => q.includes('346') && q.includes('structure')), `onto a tile in use: refused (${onUsed.problems.join(' | ')})`);
  const onDefined = planMove(rom, 'fg', new Map([[0x345, 0x5a0]]), { levels, blank });
  check(!onDefined.problems.length && onDefined.overwrite.join() === String(0x5a0), 'onto a defined tile: asked first');
  check(planMove(rom, 'fg', new Map([[0x130, 0x530]]), { levels, blank }).problems.length === 1, 'tiles 000-1FF are not moved');
  check(planMove(rom, 'fg', new Map([[0x345, 0x500], [0x346, 0x500]]), { levels, blank }).problems.length > 0, 'two tiles onto one: refused');
  const half = planMove(rom, 'fg', new Map([[0x350, 0x650]]), { levels, blank });
  check(half.problems.some((q) => q.includes('450')), `a conditional "always show" tile without its tile + 100: refused (${half.problems.join(' | ')})`);
  const code: LevelTiles = { level: 0x110, tileset: 0, ok: true, fg: [{ tile: 0x345, layer: 1, source: 'object', count: 1, x: 0, y: 0 }], bg: [] };
  const byCode = planMove(rom, 'fg', new Map([[0x345, 0x545]]), { levels, blank, index: [code] });
  check(byCode.problems.some((q) => q.includes('110')), `a tile placed by an object's code: refused (${byCode.problems.join(' | ')})`);
  const bgp = planMove(rom, 'bg', new Map([[0x2a0, 0x3a0]]), { levels, blank });
  check(!bgp.problems.length && bgp.levels.map((l) => `${hx(l.level)}:${l.bg}`).join() === '105:1', 'BG: the levels whose BG tilemap changes');
}

// ---- the move: one undo step, every use along, the levels as before ----
const s = new RomEditSession(rom);
const image = rom.data.slice();
const map = new Map([...rectMap(0x345, 3, 1, 0x545), [0x350, 0x650], [0x450, 0x750]]);
s.edit('move', () => applyMove(rom, 'fg', planMove(rom, 'fg', map, { levels, blank }), { levels, blank }));
s.edit('move BG', () => applyMove(rom, 'bg', planMove(rom, 'bg', new Map([[0x2a0, 0x3a0]]), { levels, blank }), { levels, blank }));
check(s.history.undoStack.length === 2, 'each move one undo step');
check(extTileWords(rom, 0x545)!.join() === '1,2,3,4' && actsLike(rom, 0x545) === 0x130 && extTileWords(rom, 0x345)!.join() === blank.join() && actsLike(rom, 0x345) === DEFAULT_ACTS, 'graphics and acts-like moved, the old tile blank');
check(!!blockOf(rom, 0x547) && !blockOf(rom, 0x347) && loadBlockProject(rom)!.list.map((b) => b.tile).join() === String(0x547), 'the block moved, list.txt along');
check(readStructure(rom, 7)!.tiles.join() === [0x546, TRANSPARENT].join(), 'the structure\'s tile');
check(loadLevel(rom, 0x106).objects.some((o) => o.tile === 0x545), 'level 106\'s Direct Map16 object');
check(bgTileWords(rom, 0x3a0).join() === '5,6,7,8' && storedBg(rom, loadLevel(rom, 0x105))![bgIndex(3, 20)] === 0x3a0, 'the BG tile and the BG tilemap');
for (const n of levels) check(look(n) === before.get(n), `level ${hx(n)} looks the same after the moves`);
s.undo(); s.undo();
check(rom.data.every((b, i) => b === image[i]), 'undone: the ROM as before');
// (the comparison sees a level whose uses were not rewritten)
s.edit('tiles only', () => applyMove(rom, 'fg', planMove(rom, 'fg', map, { levels: [], blank }), { levels: [], blank }));
check(look(0x106) !== before.get(0x106), 'tiles moved without rewriting the level: it looks different');
s.undo();
// onto a tile with a block of its own (asked first): that block is gone, from list.txt too
{
  const p = planMove(rom, 'fg', new Map([[0x345, 0x347]]), { levels: [], blank });
  check(p.overwrite.join() === String(0x347) && p.blocks.join() === String(0x347), 'a destination\'s own block: overwritten, the block list rewritten');
  s.edit('onto a block', () => applyMove(rom, 'fg', p, { levels: [], blank }));
  check(!blockOf(rom, 0x347) && !loadBlockProject(rom)?.list.length, 'the overwritten block left list.txt');
  s.undo();
}
// overlapping: 345-347 one tile on, 346 and 347 are moved away from themselves
s.edit('overlap', () => applyMove(rom, 'fg', planMove(rom, 'fg', rectMap(0x345, 3, 1, 0x346), { levels, blank }), { levels, blank }));
check(look(0x105) === before.get(0x105) && extTileWords(rom, 0x346)!.join() === '1,2,3,4' && extTileWords(rom, 0x345)!.join() === blank.join(), 'an overlapping move');
s.undo();

// ---- Remap Direct Map16 / Background Tiles: the uses only ----
{
  const p = planRemap(rom, 'fg', new Map([[0x345, 0x5a0]]), { levels: [0x105] });
  check(p.levels.map((l) => `${hx(l.level)}:${l.objects}`).join() === '105:1', 'Remap Direct Map16 in the current level: its objects');
  applyRemap(rom, 'fg', new Map([[0x345, 0x5a0]]), { levels: [0x105] });
  check(loadLevel(rom, 0x105).objects.some((o) => o.tile === 0x5a0 && o.size === 0x01) && loadLevel(rom, 0x106).objects.some((o) => o.tile === 0x345), 'the whole object moved, the other level kept');
  check(extTileWords(rom, 0x345)!.join() === '1,2,3,4', 'the tiles themselves stay');

  // a game BG (level 107): only seen with its load, then the editor's
  const gameBg = (n: number) => bgFromWram(emu.load(n).wram);
  const t0 = gameBg(0x107)[0];
  check(!bgBank(rom, 0x107), 'level 107 has the game\'s BG');
  check(!planRemap(rom, 'bg', new Map([[t0, 0x2a0]]), { levels: [0x107] }).levels.length, 'a game BG is not seen without its load');
  const p2 = planRemap(rom, 'bg', new Map([[t0, 0x2a0]]), { levels: [0x107], gameBg });
  check(p2.levels.length === 1 && p2.levels[0].bg > 0, `Remap Background Tiles: ${p2.levels[0]?.bg} tiles`);
  applyRemap(rom, 'bg', new Map([[t0, 0x2a0]]), { levels: [0x107], gameBg });
  const bg = storedBg(rom, loadLevel(rom, 0x107));
  check(!!bgBank(rom, 0x107) && bg?.[0] === 0x2a0 && bg.every((t, o) => t !== t0 || o < 0), 'the BG stored by the editor, the tiles rewritten');
  check(bgFromWram(emu.load(0x107).wram)[0] === 0x2a0, 'and the game loads it');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all passed');
